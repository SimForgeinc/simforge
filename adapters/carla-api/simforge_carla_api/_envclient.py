"""Framed msgpack client for the SimForge env-server.

Mirrors the wire protocol of ``adapters/gym``: 4-byte
little-endian length prefix + msgpack document. The facade spawns the server
as a stdio subprocess by default (same resolution order as the gym adapter).
"""

from __future__ import annotations

import os
import shutil
import struct
import subprocess
import threading
from pathlib import Path
from typing import Any, Mapping

import msgpack
from ._compat_env import simforge_env

ENV_SERVER_PROTOCOL_VERSION = 1

_HEADER = struct.Struct("<I")

#: Repo-local server dist relative to a checkout of this adapter.
_REPO_SERVER_DIST = Path(__file__).resolve().parents[3] / "packages" / "rl-env" / "dist" / "env-server.js"

#: A sibling pristine checkout (this worktree may not have a build).
_MAIN_SERVER_DIST = Path("/home/path/SimForge/packages/training-env/dist/env-server.js")


class ProtocolError(RuntimeError):
    """The server answered outside the documented protocol."""


class ServerError(RuntimeError):
    """The server rejected a request (``ok: 0``)."""


def resolve_server_command(server_command=None) -> tuple[str, ...]:
    if server_command is not None:
        return tuple(server_command)
    override = simforge_env("ENV_SERVER")
    if override:
        return tuple(override.split(" "))
    installed = shutil.which("simforge-env-server")
    if installed:
        return (installed,)
    if _REPO_SERVER_DIST.exists():
        return ("node", str(_REPO_SERVER_DIST))
    if _MAIN_SERVER_DIST.exists():
        return ("node", str(_MAIN_SERVER_DIST))
    raise RuntimeError(
        "no simforge-env-server found: install @simforge/training-env "
        "(pnpm --filter @simforge/training-env build), set SIMFORGE_ENV_SERVER, "
        "or pass server_command"
    )


class _FrameReader:
    """Incremental length-prefixed frame splitter."""

    def __init__(self) -> None:
        self._buf = b""

    def push(self, chunk: bytes) -> list[dict]:
        self._buf += chunk
        frames: list[dict] = []
        while len(self._buf) >= 4:
            (length,) = _HEADER.unpack_from(self._buf, 0)
            if len(self._buf) < 4 + length:
                break
            payload = self._buf[4 : 4 + length]
            self._buf = self._buf[4 + length :]
            frames.append(msgpack.unpackb(payload, raw=False))
        return frames


class EnvServerClient:
    """One connection to one env-server; request/reply over framed msgpack."""

    def __init__(self, episodes_spec: str | None = None, *, decision_hz: int | None = None,
                 clip_seconds: float | None = None, max_decisions: int | None = None,
                 server_command=None) -> None:
        spec = episodes_spec or simforge_env("EPISODES")
        if not spec:
            raise RuntimeError(
                "no episode spec: set SIMFORGE_EPISODES or pass episodes_spec="
            )
        flags = ["--episodes", str(Path(spec).resolve())]
        if decision_hz is not None:
            flags += ["--decision-hz", str(decision_hz)]
        if clip_seconds is not None:
            flags += ["--clip-seconds", str(clip_seconds)]
        if max_decisions is not None:
            flags += ["--max-decisions", str(max_decisions)]
        self._proc = subprocess.Popen(  # noqa: S603 - fixed argv of a repo binary
            list(resolve_server_command(server_command)) + flags,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        self._reader = _FrameReader()
        self._lock = threading.Lock()
        self._next_id = 0

    # ------------------------------------------------------------------ api

    def request(self, document: Mapping[str, Any]) -> Any:
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            doc = {"i": request_id, **dict(document)}
            payload = msgpack.packb(doc, use_bin_type=True)
            assert self._proc.stdin is not None and self._proc.stdout is not None
            self._proc.stdin.write(_HEADER.pack(len(payload)) + payload)
            self._proc.stdin.flush()
            while True:
                chunk = self._proc.stdout.read1(1 << 20)
                if not chunk:
                    raise ProtocolError(
                        f"env-server exited before replying (exit={self._proc.poll()}); "
                        "check the episode spec / topology paths")
                for response in self._reader.push(chunk):
                    if response.get("i") != request_id:
                        continue
                    if response.get("ok") == 1:
                        return response.get("r")
                    raise ServerError(str(response.get("e", "unknown server error")))

    @property
    def alive(self) -> bool:
        return self._proc.poll() is None

    def close(self) -> None:
        if not self.alive:
            return
        try:
            with self._lock:
                payload = msgpack.packb({"i": self._next_id + 1, "op": "close"}, use_bin_type=True)
                assert self._proc.stdin is not None
                self._proc.stdin.write(_HEADER.pack(len(payload)) + payload)
                self._proc.stdin.flush()
        except Exception:  # pragma: no cover - best-effort goodbye
            pass
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover - stubborn server
            self._proc.kill()

    def __enter__(self) -> "EnvServerClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


# Compact action wire form (mirrors rl-env decodeAction).
_ACTION_KEYS = {"target_speed_mps": "ts", "target_acceleration_mps2": "ta", "motion_direction": "dir"}


def encode_action(action: Mapping[str, Any] | None) -> dict[str, Any]:
    if not action:
        return {}
    wire: dict[str, Any] = {}
    for key, compact in _ACTION_KEYS.items():
        if key in action and action[key] is not None:
            wire[compact] = action[key]
    ctrl = action.get("control")
    if ctrl is not None:
        throttle = float(ctrl.throttle) if hasattr(ctrl, "throttle") else float(ctrl["throttle"])
        brake = float(ctrl.brake) if hasattr(ctrl, "brake") else float(ctrl["brake"])
        steer = float(ctrl.steer) if hasattr(ctrl, "steer") else float(ctrl["steer"])
        wire["ctrl"] = [throttle, brake, steer]
    return wire
