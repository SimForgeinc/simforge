"""policy_step wire client (protocol v1).

Speaks the env-server framing — 4-byte LE u32 length + one msgpack document
— and the ``policy.*`` session ops documented in ``docs/policy-step.md``.
Standalone by design: no dependency on the gym adapter.
"""

from __future__ import annotations

import struct
import subprocess  # noqa: S404 - managed subprocess of the known env-server binary
from pathlib import Path
from typing import Any, Mapping, Sequence

import msgpack

POLICY_STEP_PROTOCOL_VERSION = 1

_HEADER = struct.Struct("<I")

#: This file lives at <repo>/adapters/policy-runner/simforge_policy_runner/.
REPO_DIR = Path(__file__).resolve().parents[3]
SERVER_DIST = REPO_DIR / "packages" / "training-env" / "dist" / "env-server.js"


class ProtocolError(RuntimeError):
    """The server answered outside the documented protocol."""


class ServerError(RuntimeError):
    """The server rejected a request (``ok: 0``)."""


def control(throttle: float, brake: float, steer: float) -> dict[str, Any]:
    """Compact wire form of a control action."""
    return {"k": "c", "c": [float(throttle), float(brake), float(steer)]}


def trajectory(points: Sequence[tuple[float, float, float, float, float]]) -> dict[str, Any]:
    """Compact wire form of a trajectory action; points are (x, y, heading, speed, t)."""
    return {"k": "t", "p": [[float(v) for v in point] for point in points]}


def _read_exact(stream: Any, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            raise ProtocolError("server closed the stream mid-frame")
        data += chunk
    return data


class PolicyServer:
    """One env-server subprocess spoken to over framed stdio."""

    def __init__(self, command: Sequence[str]) -> None:
        self.process = subprocess.Popen(  # noqa: S603 - fixed, caller-supplied server command
            list(command),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        self._next_id = 1

    @staticmethod
    def default_command(spec_path: str | Path, decision_hz: int | None = None) -> tuple[str, ...]:
        if not SERVER_DIST.exists():
            raise RuntimeError(f"missing {SERVER_DIST}; build @simforge/training-env first")
        command = ("node", str(SERVER_DIST), "--episodes", str(spec_path))
        if decision_hz is not None:
            command += ("--decision-hz", str(decision_hz))
        return command

    def request(self, op: str, **fields: Any) -> Any:
        """One request/reply exchange; returns the unwrapped ``r`` payload."""
        request_id = self._next_id
        self._next_id += 1
        payload = msgpack.packb({"i": request_id, "op": op, **fields}, use_bin_type=True)
        stdin = self.process.stdin
        assert stdin is not None
        stdin.write(_HEADER.pack(len(payload)) + payload)
        stdin.flush()

        stdout = self.process.stdout
        assert stdout is not None
        (length,) = _HEADER.unpack(_read_exact(stdout, 4))
        response: Mapping[str, Any] = msgpack.unpackb(_read_exact(stdout, length), raw=False)
        if response.get("i") != request_id:
            raise ProtocolError(f"response id {response.get('i')} for request {request_id}")
        if response.get("ok") == 1:
            return response.get("r")
        raise ServerError(str(response.get("e", "unknown server error")))

    def close(self) -> None:
        try:
            self.request("close")
        except (ProtocolError, ServerError, BrokenPipeError, ValueError):
            pass
        finally:
            if self.process.stdin is not None:
                self.process.stdin.close()
            self.process.wait(timeout=10)

    def __enter__(self) -> "PolicyServer":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
