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

import numpy as np


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
    def render(self, tick_id: int, cameras: list[dict], export_dir: str | None = None) -> dict:
        # NOTE: RequestBody enum fields are still wire-snake_case server-side.
        req = {"i": self._next(), "op": "render", "tick_id": tick_id, "cameras": cameras}
        if export_dir is not None:
            req["export_dir"] = export_dir
        return self._rpc(req)

    def close(self) -> None:
        try:
            self._rpc({"i": self._next(), "op": "close"})
        finally:
            self.sock.close()

    # -- gym-shaped zero-copy observations ---------------------------------
    def step(self, tick_id: int, cameras: list[dict]) -> tuple[dict, float]:
        """One env step: send tick -> receive frame records -> numpy views.

        Returns (observations, server_ms). Each observation value is a numpy
        array VIEW into the shared-memory ring: rgb/id are (H, W, 4) uint8,
        depth is (H, W) float32. np.shares_memory(obs, self.shm) is True —
        nothing is copied out of the ring.
        """
        response = self.render(tick_id, cameras)
        assert response["ok"], response
        obs: dict = {}
        for frame in response["frames"]:
            offset = frame["offset"]
            length = frame["len"]
            w, h = frame["width"], frame["height"]
            if frame["format"] == "depth32f":
                arr = np.frombuffer(self.shm, dtype="<f4", count=w * h, offset=offset + 128)
                view = arr.reshape(h, w)
            else:
                arr = np.frombuffer(self.shm, dtype=np.uint8, count=w * h * 4, offset=offset + 128)
                view = arr.reshape(h, w, 4)
            obs.setdefault(frame["sensorId"], {})[frame["pass"]] = view
        return obs, response["server_ms"]
