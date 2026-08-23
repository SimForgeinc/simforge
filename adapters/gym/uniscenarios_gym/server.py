"""Server lifecycle and framed transports for the UniScenarios env-server.

Two transports, matching the server's own:

- ``SocketTransport`` — connect to a unix socket started with ``--socket``.
- ``StdioTransport`` — spawn the server as a subprocess and speak the same
  framed protocol over its stdin/stdout (the default for
  :class:`~uniscenarios_gym.env.UniScenariosEnv`).
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess  # noqa: S404 - deliberate managed subprocess of a known server binary
import time
from pathlib import Path
from typing import Any, Mapping, Sequence

from .protocol import FrameReader, ProtocolError, ServerError, encode_frame

#: Where the repo-local server lives relative to this wheel's checkout.
_REPO_SERVER_DIST = Path(__file__).resolve().parents[3] / "packages" / "rl-env" / "dist" / "env-server.js"


def resolve_server_command(server_command: Sequence[str] | None = None) -> tuple[str, ...]:
    """Resolve the server launch command.

    Preference order: an explicit command; the installed
    ``uniscenarios-env-server`` bin; the repo workspace build output.
    """
    if server_command is not None:
        return tuple(server_command)
    installed = shutil.which("uniscenarios-env-server")
    if installed:
        return (installed,)
    if _REPO_SERVER_DIST.exists():
        return ("node", str(_REPO_SERVER_DIST))
    raise RuntimeError(
        "no uniscenarios-env-server found: install @simforge/training-env "
        "(pnpm --filter @simforge/training-env build) or pass server_command"
    )


class EnvConnection:
    """One client connection to one env-server: request/reply over frames."""

    def __init__(self) -> None:
        self._next_id = 1

    def _send(self, frame: bytes) -> None:  # pragma: no cover - transport detail
        raise NotImplementedError

    def _recv(self) -> bytes:  # pragma: no cover - transport detail
        raise NotImplementedError

    def next_id(self) -> int:
        value = self._next_id
        self._next_id += 1
        return value

    def request(self, document: Mapping[str, Any]) -> Any:
        request_id = document.get("i")
        self._send(encode_frame(document))
        response = FrameReader().push(self._recv())[0]
        if response.get("i") != request_id:
            raise ProtocolError(f"reply id {response.get('i')!r} does not match request {request_id}")
        if response.get("ok") == 1:
            return response.get("r")
        raise ServerError(str(response.get("e", "unknown server error")))

    def close(self) -> None:  # pragma: no cover - transport detail
        raise NotImplementedError

    def __enter__(self) -> "EnvConnection":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _read_exact(read: Any, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = read(count - len(data))
        if not chunk:
            raise ProtocolError(f"server stream ended mid-frame (wanted {count} bytes)")
        data += chunk
    return data


def _read_frame(read: Any) -> bytes:
    header = _read_exact(read, 4)
    return header + _read_exact(read, int.from_bytes(header, "little"))


class StdioTransport(EnvConnection):
    """Spawn the server as a subprocess; frames ride stdin/stdout."""

    def __init__(self, server_command: Sequence[str], *, env_extra: dict[str, str] | None = None) -> None:
        super().__init__()
        env = {**os.environ, **(env_extra or {})}
        self.process = subprocess.Popen(  # noqa: S603 - fixed argv from the operator
            list(server_command),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            env=env,
        )
        assert self.process.stdin is not None and self.process.stdout is not None

    def _send(self, frame: bytes) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(frame)
        self.process.stdin.flush()

    def _recv(self) -> bytes:
        assert self.process.stdout is not None
        return _read_frame(self.process.stdout.read)

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                self.request({"i": self.next_id(), "op": "close"})
            except (ServerError, ProtocolError, BrokenPipeError, OSError):
                pass
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)


class SocketTransport(EnvConnection):
    """Connect to a server already listening on a unix socket."""

    def __init__(self, socket_path: str | Path, *, connect_timeout_s: float = 30.0) -> None:
        super().__init__()
        self.socket_path = Path(socket_path)
        deadline = time.monotonic() + connect_timeout_s
        last_error: OSError | None = None
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        while True:
            try:
                sock.connect(str(self.socket_path))
                break
            except (FileNotFoundError, ConnectionRefusedError) as error:
                last_error = error
                if time.monotonic() > deadline:
                    sock.close()
                    raise ProtocolError(f"env-server socket {self.socket_path} never became ready") from last_error
                time.sleep(0.05)
        self._sock = sock
        self._file = sock.makefile("rb")

    def _send(self, frame: bytes) -> None:
        self._sock.sendall(frame)

    def _recv(self) -> bytes:
        return _read_frame(self._file.read)

    def close(self) -> None:
        try:
            self._sock.sendall(encode_frame({"i": self.next_id(), "op": "close"}))
        except OSError:
            pass
        self._file.close()
        self._sock.close()
