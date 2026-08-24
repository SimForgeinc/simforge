"""Minimal client for the simforge-env-server wire protocol.

Length-prefixed (u32 LE) MessagePack frames over the server's stdio, exactly
the protocol documented in ``packages/training-env/src/env-server.ts`` and
mirrored by ``adapters/gym/simforge_gym/protocol.py``.  Re-implemented here
(~150 lines) instead of importing ``simforge_gym`` so the ROS runtime does not
inherit that package's gymnasium/numpy dependencies; the compact wire keys are
byte-identical to the gym client's.

No wall clock, no retries, no buffering surprises: one request frame out, one
response frame in, strictly ordered — which is what makes the bridge's
lockstep loop deterministic.
"""

from __future__ import annotations

import os
import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import msgpack

ENV_SERVER_PROTOCOL_VERSION = 1
STATE_VECTOR_SIZE = 10

_HEADER = struct.Struct("<I")
_SV = struct.Struct("<%dd" % STATE_VECTOR_SIZE)


class ProtocolError(RuntimeError):
    """The server answered outside the documented protocol."""


class ServerError(RuntimeError):
    """The server rejected a request (``ok: 0``)."""


@dataclass(frozen=True)
class StepFrame:
    """One decoded decision (or the reset frame)."""

    t: float
    reward: float
    terminated: bool
    truncated: bool
    #: Raw little-endian float64 bytes of the 10-element state vector.
    sv_raw: bytes
    #: Decoded state vector: x, y, cos(h), sin(h), speed, accel,
    #: lat offset, lat rate, route s, nearest-actor range.
    sv: tuple[float, ...]


def decode_step_frame(payload: Mapping[str, Any]) -> StepFrame:
    sv_raw = payload.get("sv")
    if not isinstance(sv_raw, (bytes, bytearray)) or len(sv_raw) != _SV.size:
        raise ProtocolError(
            f"step frame carries no {STATE_VECTOR_SIZE}-float state vector "
            f"(got {type(sv_raw).__name__}); run the server with --obs state-vector"
        )
    sv_raw = bytes(sv_raw)
    return StepFrame(
        t=float(payload["t"]),
        reward=float(payload.get("rw", 0.0)),
        terminated=bool(payload.get("term", 0)),
        truncated=bool(payload.get("trunc", 0)),
        sv_raw=sv_raw,
        sv=_SV.unpack(sv_raw),
    )


def _read_exact(read: Any, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = read(count - len(data))
        if not chunk:
            raise ProtocolError(f"server stream ended mid-frame (wanted {count} bytes)")
        data += chunk
    return data


class EnvServerClient:
    """Spawn one env-server subprocess and speak frames over its stdio."""

    def __init__(self, server_command: Sequence[str], *, env_extra: Mapping[str, str] | None = None) -> None:
        env = {**os.environ, **(env_extra or {})}
        self._proc = subprocess.Popen(  # noqa: S603 - fixed argv from the operator
            list(server_command),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            env=env,
        )
        assert self._proc.stdin is not None and self._proc.stdout is not None
        self._next_id = 1

    # ------------------------------------------------------------- transport

    def _request(self, document: dict[str, Any]) -> Any:
        request_id = self._next_id
        self._next_id += 1
        document = {"i": request_id, **document}
        payload = msgpack.packb(document, use_bin_type=True)
        stdin = self._proc.stdin
        assert stdin is not None
        stdin.write(_HEADER.pack(len(payload)) + payload)
        stdin.flush()

        stdout = self._proc.stdout
        assert stdout is not None
        header = _read_exact(stdout.read, 4)
        frame = _read_exact(stdout.read, _HEADER.unpack(header)[0])
        response = msgpack.unpackb(frame, raw=False)
        if response.get("i") != request_id:
            raise ProtocolError(f"reply id {response.get('i')!r} does not match request {request_id}")
        if response.get("ok") == 1:
            return response.get("r")
        raise ServerError(str(response.get("e", "unknown server error")))

    # ------------------------------------------------------------------- ops

    def hello(self) -> dict[str, Any]:
        info = self._request({"op": "hello"})
        if info.get("proto") != ENV_SERVER_PROTOCOL_VERSION:
            raise ProtocolError(f"server protocol {info.get('proto')!r}, client speaks {ENV_SERVER_PROTOCOL_VERSION}")
        return info

    def reset(self, seed: str | int | None = None, *, session: int = 0) -> StepFrame:
        request: dict[str, Any] = {"op": "reset", "s": session}
        if seed is not None:
            request["seed"] = seed
        return decode_step_frame(self._request(request))

    def step(self, action: Mapping[str, Any] | None, *, session: int = 0) -> StepFrame:
        return decode_step_frame(self._request({"op": "step", "s": session, "a": dict(action) if action else None}))

    def close(self) -> None:
        if self._proc.poll() is None:
            try:
                self._request({"op": "close"})
            except (ServerError, ProtocolError, BrokenPipeError, OSError):
                pass
            try:
                self._proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._proc.kill()
                self._proc.wait(timeout=5)

    def __enter__(self) -> "EnvServerClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def default_server_command(episodes_spec: str | Path) -> list[str]:
    """The workspace env-server build, run on the episode spec (stdio transport)."""
    repo_root = Path(__file__).resolve().parents[3]
    dist = repo_root / "packages" / "training-env" / "dist" / "env-server.js"
    if not dist.exists():
        raise RuntimeError(
            f"env-server build missing at {dist}; run: pnpm --filter @simforge/training-env... build"
        )
    return ["node", str(dist), "--episodes", str(episodes_spec)]
