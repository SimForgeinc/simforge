"""Python client for the native render service (WSB5).

Zero-copy consumption shaped like the gym adapter: `step()` returns
per-sensor observation views directly into the service's /dev/shm ring
buffer — no copy between the renderer's readback buffer and numpy.

Pure-stdlib framing plus a minimal msgpack codec subset (dicts with str
keys, ints, floats, strs, bins, arrays, nil/bool) so no third-party
dependencies are required.
"""
from __future__ import annotations

import mmap
import os
import socket
import struct



# ------------------------------------------------------------- msgpack subset
def _pack(v) -> bytes:
    if v is None:
        return b"\xc0"
    if v is True:
        return b"\xc3"
    if v is False:
        return b"\xc2"
    if isinstance(v, int):
        if 0 <= v < 128:
            return struct.pack("B", v)
        if -32 <= v < 0:
            return struct.pack("b", v)
        if 0 <= v <= 0xFF:
            return b"\xcc" + struct.pack("B", v)
        if 0 <= v <= 0xFFFF:
            return b"\xcd" + struct.pack(">H", v)
        if 0 <= v <= 0xFFFFFFFF:
            return b"\xce" + struct.pack(">I", v)
        return b"\xcf" + struct.pack(">Q", v)
    if isinstance(v, float):
        return b"\xcb" + struct.pack(">d", v)
    if isinstance(v, str):
        b = v.encode()
        n = len(b)
        if n < 32:
            return struct.pack("B", 0xA0 | n) + b
        return b"\xd9" + struct.pack("B", n) + b
    if isinstance(v, (bytes, bytearray)):
        n = len(v)
        if n < 256:
            return b"\xc4" + struct.pack("B", n) + bytes(v)
        return b"\xc5" + struct.pack(">H", n) + bytes(v)
    if isinstance(v, (list, tuple)):
        n = len(v)
        head = struct.pack("B", 0x90 | n) if n < 16 else b"\xdc" + struct.pack(">H", n)
        return head + b"".join(_pack(item) for item in v)
    if isinstance(v, dict):
        n = len(v)
        head = struct.pack("B", 0x80 | n) if n < 16 else b"\xde" + struct.pack(">H", n)
        return head + b"".join(_pack(k) + _pack(val) for k, val in v.items())
    raise TypeError(f"cannot pack {type(v)}")


def _unpack(buf, off):
    b = buf[off]
    off += 1
    if b <= 0x7F:
        return b, off
    if b >= 0xE0:
        return b - 256, off
    if 0x80 <= b <= 0x8F:
        return _map(buf, off, b & 0x0F)
    if 0x90 <= b <= 0x9F:
        return _arr(buf, off, b & 0x0F)
    if 0xA0 <= b <= 0xBF:
        return _str(buf, off, b & 0x1F)
    if b == 0xC0:
        return None, off
    if b == 0xC2:
        return False, off
    if b == 0xC3:
        return True, off
    if b == 0xC4:
        n = buf[off]; off += 1
        return bytes(buf[off:off + n]), off + n
    if b == 0xC5:
        n = struct.unpack_from(">H", buf, off)[0]; off += 2
        return bytes(buf[off:off + n]), off + n
    if b == 0xCA:
        return struct.unpack_from(">f", buf, off)[0], off + 4
    if b == 0xCB:
        return struct.unpack_from(">d", buf, off)[0], off + 8
    if b == 0xCC:
        return buf[off], off + 1
    if b == 0xCD:
        return struct.unpack_from(">H", buf, off)[0], off + 2
    if b == 0xCE:
        return struct.unpack_from(">I", buf, off)[0], off + 4
    if b == 0xCF:
        return struct.unpack_from(">Q", buf, off)[0], off + 8
    if b == 0xD9:
        n = buf[off]; off += 1
        return _str(buf, off, n)
    if b == 0xDC:
        n = struct.unpack_from(">H", buf, off)[0]; off += 2
        return _arr(buf, off, n)
    if b == 0xDE:
        n = struct.unpack_from(">H", buf, off)[0]; off += 2
        return _map(buf, off, n)
    raise ValueError(f"unsupported msgpack byte {b:#x}")


def _str(buf, off, n):
    return bytes(buf[off:off + n]).decode(), off + n


def _arr(buf, off, n):
    out = []
    for _ in range(n):
        v, off = _unpack(buf, off)
        out.append(v)
    return out, off


def _map(buf, off, n):
    out = {}
    for _ in range(n):
        k, off = _unpack(buf, off)
        v, off = _unpack(buf, off)
        out[k] = v
    return out, off


# ------------------------------------------------------------------- client
class NativeRenderClient:
    """Unix-socket client with zero-copy numpy views over the shm ring."""

    def __init__(self, socket_path: str):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(socket_path)
        self.seq = 0
        self.shm = None
        hello = self._rpc({"i": self._next(), "op": "hello"})
        assert hello["ok"], hello
        self.hello = hello
        info = hello["shm"]
        if info.get("path") and os.path.exists(info["path"]):
            f = open(info["path"], "rb")
            self.shm = mmap.mmap(f.fileno(), 0, prot=mmap.PROT_READ)

    def _next(self) -> int:
        self.seq += 1
        return self.seq

    def _rpc(self, request: dict) -> dict:
        payload = _pack(request)
        self.sock.sendall(struct.pack("<I", len(payload)) + payload)
        header = self._recv_exact(4)
        (length,) = struct.unpack("<I", header)
        body = self._recv_exact(length)
        response, _ = _unpack(body, 0)
        return response

    def _recv_exact(self, n: int) -> bytes:
        chunks = []
        while n > 0:
            chunk = self.sock.recv(min(n, 65536))
            if not chunk:
                raise ConnectionError("service closed")
            chunks.append(chunk)
            n -= len(chunk)
        return b"".join(chunks)

    # -- ops ---------------------------------------------------------------
    def render(self, tick_id: int, cameras: list[dict], export_dir: str | None = None,
               tick_index: int | None = None) -> dict:
        req = {"i": self._next(), "op": "render", "tick_id": tick_id, "cameras": cameras}
        if export_dir is not None:
            req["export_dir"] = export_dir
        if tick_index is not None:
            req["tick_index"] = tick_index
        return self._rpc(req)

    # -- V2 ops (V4 SensorRig) ---------------------------------------------
    def load_scene_state(self, states: list[dict]) -> dict:
        return self._rpc({"i": self._next(), "op": "load_scene_state", "states": states})

    def reset_cameras(self) -> dict:
        return self._rpc({"i": self._next(), "op": "reset_cameras"})

    def encode_jpeg(self, items: list[dict]) -> dict:
        """JPEG-encode cached pass payloads from the last rendered tick.
        items: [{"sensorId": ..., "pass": "rgb", "quality": 70}]"""
        return self._rpc({"i": self._next(), "op": "encode_jpeg", "items": items})

    def render_bundle(self, sim_tick: int, cameras: list[dict] | None = None,
                      tick_index: int | None = None, passes: list[str] | None = None,
                      lidars: list[dict] | None = None,
                      radars: list[dict] | None = None) -> dict:
        """Render the retained camera/lidar/radar rig as one atomic bundle.

        Send declarations once, then omit them on the persistent hot loop.
        Lidar and radar records use passes ``lidar`` and ``radar`` and expose
        their deterministic PLY/CSV bytes through the same shm offsets.
        """
        req = {"i": self._next(), "op": "render_bundle", "sim_tick": sim_tick}
        if cameras is not None:
            req["cameras"] = cameras
        if lidars is not None:
            req["lidars"] = lidars
        if radars is not None:
            req["radars"] = radars
        if tick_index is not None:
            req["tick_index"] = tick_index
        if passes is not None:
            req["passes"] = passes
        return self._rpc(req)

    def read_record(self, frame: dict) -> memoryview:
        """Raw payload bytes (row-padded) of one returned FrameRecord."""
        offset = frame["offset"] + 128
        return memoryview(self.shm)[offset:offset + frame["len"]]

    def close(self) -> None:
        try:
            self._rpc({"i": self._next(), "op": "close"})
        finally:
            self.sock.close()

    # -- gym-shaped zero-copy observations ---------------------------------
    @staticmethod
    def _stride(width: int, pixel_bytes: int) -> int:
        """wgpu COPY_BYTES_PER_ROW_ALIGNMENT (256) padded row stride."""
        row = width * pixel_bytes
        return -(-row // 256) * 256

    def step(self, tick_id: int, cameras: list[dict], tick_index: int | None = None) -> tuple[dict, float]:
        """One env step: send tick -> receive frame records -> numpy views.

        Returns (observations, server_ms). Each observation value is a numpy
        array VIEW into the shared-memory ring with the 256-byte GPU row
        padding handled via a strided view (V4 fix: the previous client
        reshaped padded rows as tight and corrupted every image whose
        W*4 was not 256-aligned — including the 736-wide product stream).
        rgb/id/semantic are (H, W, 4) uint8; depth32f is (H, W) float32;
        carla-depth-bgra and jpeg payloads stay raw byte arrays.
        """
        import numpy as np
        response = self.render(tick_id, cameras, tick_index=tick_index)
        assert response["ok"], response
        obs: dict = {}
        for frame in response["frames"]:
            offset = frame["offset"]
            w, h = frame["width"], frame["height"]
            fmt = frame["format"]
            if fmt == "depth32f":
                stride = self._stride(w, 4)
                arr = np.frombuffer(self.shm, dtype="<f4", count=stride * h // 4, offset=offset + 128)
                view = arr.reshape(h, stride // 4)[:, :w]
            elif fmt in ("rgba8", "carla-depth-bgra"):
                stride = self._stride(w, 4)
                arr = np.frombuffer(self.shm, dtype=np.uint8, count=stride * h, offset=offset + 128)
                view = arr.reshape(h, stride)[:, : w * 4].reshape(h, w, 4)
            else:  # jpeg / opaque byte payload
                view = np.frombuffer(self.shm, dtype=np.uint8, count=frame["len"], offset=offset + 128)
            obs.setdefault(frame["sensorId"], {})[frame["pass"]] = view
        return obs, response["server_ms"]

    def step_bundle(self, sim_tick: int, cameras: list[dict] | None = None,
                    tick_index: int | None = None, passes: list[str] | None = None) -> tuple[dict, dict]:
        """render_bundle + zero-copy views: returns (observations, response).

        Push-mode twin of `bundles.BundleRingReader` (which pulls the same
        bundles from the ring without the RPC socket). Observation views use
        the same strided zero-copy mapping as `step()`.
        """
        import numpy as np
        response = self.render_bundle(sim_tick, cameras, tick_index=tick_index, passes=passes)
        assert response["ok"], response
        obs: dict = {}
        for frame in response["frames"]:
            offset = frame["offset"]
            w, h = frame["width"], frame["height"]
            fmt = frame["format"]
            if fmt == "depth32f":
                stride = self._stride(w, 4)
                arr = np.frombuffer(self.shm, dtype="<f4", count=stride * h // 4, offset=offset + 128)
                view = arr.reshape(h, stride // 4)[:, :w]
            elif fmt in ("rgba8", "carla-depth-bgra"):
                stride = self._stride(w, 4)
                arr = np.frombuffer(self.shm, dtype=np.uint8, count=stride * h, offset=offset + 128)
                view = arr.reshape(h, stride)[:, : w * 4].reshape(h, w, 4)
            else:
                view = np.frombuffer(self.shm, dtype=np.uint8, count=frame["len"], offset=offset + 128)
            obs.setdefault(frame["sensorId"], {})[frame["pass"]] = view
        return obs, response
