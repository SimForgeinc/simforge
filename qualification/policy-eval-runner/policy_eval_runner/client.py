"""Framed msgpack client for the policy-eval-server.

Protocol v1, identical framing to the rl env servers (4-byte little-endian
length prefix + msgpack document). Adds decoding of the policy-eval server's
additive `col` / `goal` / `min` step fields.
"""

from __future__ import annotations

import socket
import struct
from pathlib import Path
from typing import Any

import msgpack
import numpy as np

STATE_VECTOR_SIZE = 10
_HEADER = struct.Struct("<I")


class EvalEnvClient:
    """One connection to one policy-eval-server unix socket."""

    def __init__(self, socket_path: str | Path) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(str(socket_path))
        self._buf = b""
        self._next_id = 1

    # ------------------------------------------------------------- framing
    def request(self, doc: dict[str, Any]) -> Any:
        request_id = self._next_id
        self._next_id += 1
        payload = msgpack.packb({"i": request_id, **doc}, use_bin_type=True)
        self.sock.sendall(_HEADER.pack(len(payload)) + payload)
        while True:
            response = self._recv_response()
            if response["i"] != request_id:
                continue
            if response.get("ok") != 1:
                raise ServerError(str(response.get("e", "unknown server error")))
            return response["r"]

    def _recv_response(self) -> dict[str, Any]:
        while True:
            while len(self._buf) >= _HEADER.size:
                (n,) = _HEADER.unpack(self._buf[:_HEADER.size])
                if len(self._buf) >= _HEADER.size + n:
                    frame = self._buf[_HEADER.size:_HEADER.size + n]
                    self._buf = self._buf[_HEADER.size + n:]
                    return msgpack.unpackb(frame, raw=False)
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise ProtocolError("server closed the connection mid-response")
            self._buf += chunk

    # ---------------------------------------------------------------- api
    def hello(self) -> dict[str, Any]:
        return self.request({"op": "hello"})

    def reset(self, session: int, seed: str | int | None = None) -> dict[str, Any]:
        doc: dict[str, Any] = {"op": "reset", "s": session}
        if seed is not None:
            doc["seed"] = seed
        return decode_step_frame(self.request(doc))

    def step(self, session: int, action: dict[str, float] | None) -> dict[str, Any]:
        wire: dict[str, Any] | None = None if action is None else {
            "ts": action["target_speed_mps"],
            "ta": action["target_acceleration_mps2"],
        }
        return decode_step_frame(self.request({"op": "step", "s": session, "a": wire}))

    def close(self) -> None:
        try:
            self.request({"op": "close"})
        except (OSError, ProtocolError, ServerError):
            pass
        finally:
            self.sock.close()


class ProtocolError(RuntimeError):
    pass


class ServerError(RuntimeError):
    pass


def decode_step_frame(f: dict[str, Any]) -> dict[str, Any]:
    sv = np.frombuffer(f["sv"], dtype="<f8", count=STATE_VECTOR_SIZE).copy() if f.get("sv") else None
    bev_doc = f.get("bev")
    if bev_doc:
        h, w, c = int(bev_doc["h"]), int(bev_doc["w"]), int(bev_doc["c"])
        bev = np.frombuffer(bev_doc["d"], dtype="<f4", count=h * w * c).reshape(h, w, c).copy()
    else:
        bev = None
    return {
        "t": f["t"],
        "reward": f["rw"],
        "terminated": bool(f["term"]),
        "truncated": bool(f["trunc"]),
        "state_vector": sv,
        "objects": f.get("objs", []),
        "bev": bev,
        "reward_terms": tuple(f.get("terms", (0.0, 0.0, 0.0))),
        "collision": bool(f.get("col", 0)),
        "goal": bool(f.get("goal", 0)),
        # ego pair minima rows [a, b, minDistanceM, minTtcS, minPathTtcS, minPetS]
        "minima": f.get("min", []),
    }
