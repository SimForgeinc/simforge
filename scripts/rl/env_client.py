"""Framed msgpack client for the reactive-env-server (Phase 3).

Mirrors `adapters/uniscenarios-gym` protocol v1 but adds:
- BEV decode (`np.float32` `[h, w, c]`, row 0 farthest forward),
- explicit `col` / `goal` flags from the training shim,
- batch ops over unix socket with pipelined requests.
"""
from __future__ import annotations

import socket
import struct
from pathlib import Path
from typing import Any, Sequence

import msgpack
import numpy as np

STATE_VECTOR_SIZE = 10
_HEADER = struct.Struct("<I")


class EnvClient:
    def __init__(self, socket_path: str | Path) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(str(socket_path))
        self._buf = b""
        self._next_id = 1
        self.bev_shape: tuple[int, int, int] | None = None

    # ------------------------------------------------------------- framing
    def _send(self, doc: dict[str, Any]) -> None:
        payload = msgpack.packb(doc, use_bin_type=True)
        self.sock.sendall(_HEADER.pack(len(payload)) + payload)

    def _recv(self) -> Any:
        while True:
            if len(self._buf) >= 4:
                (length,) = _HEADER.unpack_from(self._buf)
                if len(self._buf) >= 4 + length:
                    payload = self._buf[4 : 4 + length]
                    self._buf = self._buf[4 + length :]
                    return msgpack.unpackb(payload, raw=False, strict_map_key=False)
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise ConnectionError("server closed the stream")
            self._buf += chunk

    def request(self, doc: dict[str, Any]) -> Any:
        req_id = self._next_id
        self._next_id += 1
        doc["i"] = req_id
        self._send(doc)
        response = self._recv()
        if response.get("i") != req_id:
            raise ProtocolError(f"reply id {response.get('i')!r} != {req_id}")
        if response.get("ok") != 1:
            raise ServerError(str(response.get("e")))
        return response.get("r")

    # ---------------------------------------------------------------- api
    def hello(self) -> dict[str, Any]:
        info = self.request({"op": "hello"})
        bev = info.get("bevConfig")
        sessions = info["sessions"]
        if bev:
            rows = int(round((bev["forwardM"] + bev["backwardM"]) / bev["resolutionM"]))
            cols = int(round((2 * bev["halfWidthM"]) / bev["resolutionM"]))
            self.bev_shape = (rows, cols, 3)
        assert sessions > 0
        return info

    def reset_all(self, seeds: Sequence[str | int | None] | None = None) -> list[dict[str, Any]]:
        doc: dict[str, Any] = {"op": "reset_all"}
        if seeds is not None:
            doc["seeds"] = list(seeds)
        return [self._decode_frame(f) for f in self.request(doc)["rs"]]

    def reset(self, session: int, seed: str | int | None = None) -> dict[str, Any]:
        return self._decode_frame(self.request({"op": "reset", "s": session, "seed": seed}))

    def batch_step(
        self, pairs: Sequence[tuple[int, dict[str, float] | None]]
    ) -> list[dict[str, Any]]:
        wire_pairs = [[s, _encode_action(a)] for s, a in pairs]
        rs = self.request({"op": "batch_step", "as": wire_pairs})["rs"]
        return [self._decode_frame(f) for f in rs]

    def close(self) -> None:
        try:
            self.request({"op": "close"})
        except (ServerError, ProtocolError, OSError):
            pass
        self.sock.close()

    # -------------------------------------------------------------- decode
    def _decode_frame(self, f: dict[str, Any]) -> dict[str, Any]:
        sv = np.frombuffer(f["sv"], dtype="<f8", count=STATE_VECTOR_SIZE).copy() if f.get("sv") else None
        bev_raw = f.get("bev")
        bev = None
        if bev_raw is not None:
            h, w, c = int(bev_raw["h"]), int(bev_raw["w"]), int(bev_raw["c"])
            bev = np.frombuffer(bev_raw["d"], dtype="<f4").reshape(h, w, c).copy()
        return {
            "t": f["t"],
            "reward": f["rw"],
            "terminated": bool(f["term"]),
            "truncated": bool(f["trunc"]),
            "collision": bool(f.get("col", 0)),
            "goal": bool(f.get("goal", 0)),
            "sv": sv,
            "bev": bev,
            "objects": [
                {
                    "id": e[0],
                    "range_m": e[1],
                    "bearing_rad": e[2],
                    "range_rate_mps": e[3],
                    "los": bool(e[4]),
                }
                for e in f.get("objs", ())
            ],
            "terms": tuple(f.get("terms", (0.0, 0.0, 0.0))),
        }


class ProtocolError(RuntimeError):
    pass


class ServerError(RuntimeError):
    pass


def _encode_action(action: dict[str, float] | None) -> dict[str, Any]:
    """{target_speed_mps, target_acceleration_mps2} → compact wire keys."""
    if action is None:
        return {}
    wire: dict[str, Any] = {}
    if action.get("target_speed_mps") is not None:
        wire["ts"] = float(action["target_speed_mps"])
    if action.get("target_acceleration_mps2") is not None:
        wire["ta"] = float(action["target_acceleration_mps2"])
    return wire
