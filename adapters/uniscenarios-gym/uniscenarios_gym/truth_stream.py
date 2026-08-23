"""TruthStream live subscription client for the UniScenarios env-server.

Consumes the per-engine-tick ground-truth side channel (`subscribe` op): one
framed-msgpack document per tick carrying a scene-state.v1 actor record set
(with world-frame acceleration), the full `signalSnapshotAt(t)` array, and the
`{mapId, xodrSha256}` map identity pair. Backpressure is server-side
drop-oldest with a cumulative `dropped` gap counter on every document.

This module is additive: it neither changes nor depends on the RL
request/reply semantics in ``env.py``/``protocol.py`` — an env-server that is
never asked to ``subscribe`` never pushes a frame.
"""

from __future__ import annotations

import os
import shutil
import socket
import struct
import subprocess  # noqa: S404 - deliberate managed subprocess of a known server binary
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Iterator, Mapping, Sequence

import msgpack

#: Wire protocol version this client speaks.
ENV_SERVER_PROTOCOL_VERSION = 1
_HEADER = struct.Struct("<I")
_REPO_SERVER_DIST = (
    Path(__file__).resolve().parents[3] / "packages" / "rl-env" / "dist" / "env-server.js"
)


class ProtocolError(RuntimeError):
    """The server answered outside the documented protocol."""


def resolve_server_command(server_command: Sequence[str] | None = None) -> tuple[str, ...]:
    """Explicit command > installed bin > repo workspace build output."""
    if server_command is not None:
        return tuple(server_command)
    installed = shutil.which("uniscenarios-env-server")
    if installed:
        return (installed,)
    if _REPO_SERVER_DIST.exists():
        return ("node", str(_REPO_SERVER_DIST))
    raise RuntimeError(
        "no uniscenarios-env-server found: build @uniscenarios/rl-env "
        "(pnpm --filter @uniscenarios/rl-env build) or pass server_command"
    )


def _encode_frame(document: Mapping[str, Any]) -> bytes:
    payload = msgpack.packb(dict(document), use_bin_type=True)
    return _HEADER.pack(len(payload)) + payload


def _read_exact(read: Any, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = read(count - len(data))
        if not chunk:
            raise ProtocolError("server stream ended mid-frame")
        data += chunk
    return data


def _read_frame(read: Any) -> dict[str, Any]:
    header = _read_exact(read, 4)
    payload = _read_exact(read, int.from_bytes(header, "little"))
    return msgpack.unpackb(payload, raw=False, strict_map_key=False)


class TruthStreamClient:
    """One env-server connection with request/reply AND tick-stream reading.

    A background reader thread demultiplexes the wire: documents with
    ``op == 'tick'`` land in the tick queue, response envelopes complete their
    pending :meth:`request` call.
    """

    def __init__(
        self,
        episodes_spec: str,
        *,
        session: int = 0,
        socket_path: str | Path | None = None,
        server_command: Sequence[str] | None = None,
        decision_hz: int | None = None,
    ) -> None:
        self.session_index = session
        self._next_id = 1
        self._pending: dict[int, dict[str, Any]] = {}
        self._ticks: deque[dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._done = False

        if socket_path is not None:
            self._sock = self._connect_socket(Path(socket_path))
            self._file = self._sock.makefile("rb")
            self._process = None
        else:
            flags = ["--episodes", episodes_spec, "--socket", self._socket_path_for(episodes_spec)]
            if decision_hz is not None:
                flags += ["--decision-hz", str(decision_hz)]
            command = (*resolve_server_command(server_command), *flags)
            sock_path = Path(flags[flags.index("--socket") + 1])
            sock_path.unlink(missing_ok=True)
            self._process = subprocess.Popen(  # noqa: S603 - fixed argv from the operator
                list(command), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=None
            )
            assert self._process.stdout is not None
            ready_line = self._process.stdout.readline().decode()
            if "listening" not in ready_line:
                raise ProtocolError(f"env-server did not become ready: {ready_line!r}")
            self._sock = self._connect_socket(sock_path)
            self._file = self._sock.makefile("rb")

        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

        hello = self.request({"op": "hello"})
        if hello.get("proto") != ENV_SERVER_PROTOCOL_VERSION:
            raise ProtocolError(f"server protocol {hello.get('proto')!r} != {ENV_SERVER_PROTOCOL_VERSION}")
        if not hello.get("truthStream"):
            raise ProtocolError("server does not advertise the truthStream channel")
        self.hello = hello

    _socket_counter = 0

    @classmethod
    def _socket_path_for(cls, episodes_spec: str) -> str:
        cls._socket_counter += 1
        digest = abs(hash(episodes_spec)) % 99991
        return f"/tmp/uniscenarios-truth-{digest}-{os.getpid()}-{cls._socket_counter}.sock"

    @staticmethod
    def _connect_socket(path: Path, timeout_s: float = 30.0) -> socket.socket:
        deadline = time.monotonic() + timeout_s
        last_error: OSError | None = None
        while True:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                sock.connect(str(path))
                return sock
            except (FileNotFoundError, ConnectionRefusedError) as error:
                last_error = error
                sock.close()
                if time.monotonic() > deadline:
                    raise ProtocolError(f"env-server socket {path} never became ready") from last_error
                time.sleep(0.05)

    # ------------------------------------------------------------- wire io

    def _read_loop(self) -> None:
        try:
            while not self._done:
                doc = _read_frame(self._file.read)
                if doc.get("op") == "tick":
                    with self._lock:
                        self._ticks.append(doc)
                else:
                    request_id = doc.get("i")
                    with self._lock:
                        waiter = self._pending.pop(request_id, None)
                    if waiter is not None:
                        waiter.update(doc)
                    elif request_id is not None and doc.get("ok") != 1:
                        raise ProtocolError(f"unsolicited error reply for id {request_id!r}")
        except Exception:  # noqa: BLE001 - reader failure surfaces via pending waits
            self._failed = True

    def request(self, document: Mapping[str, Any]) -> Any:
        request_id = self._next_id
        self._next_id += 1
        frame = dict(document)
        frame["i"] = request_id
        waiter: dict[str, Any] = {}
        with self._lock:
            self._pending[request_id] = waiter
        self._sock.sendall(_encode_frame(frame))
        deadline = time.monotonic() + 120.0
        while True:
            with self._lock:
                done = "ok" in waiter
            if done:
                break
            if time.monotonic() > deadline:
                raise ProtocolError(f"timed out waiting for reply to id {request_id}")
            time.sleep(0.001)
        reply = dict(waiter)
        if reply["ok"] != 1:
            raise RuntimeError(f"env-server error: {reply.get('e')}")
        return reply.get("r")

    # --------------------------------------------------------- stream api

    def subscribe(self) -> Mapping[str, Any]:
        """Start receiving one frame per engine tick for this session."""
        return self.request({"op": "subscribe", "s": self.session_index})

    def unsubscribe(self) -> Mapping[str, Any]:
        return self.request({"op": "unsubscribe", "s": self.session_index})

    def ticks(self, timeout_s: float = 30.0) -> Iterator[dict[str, Any]]:
        """Yield tick documents as they arrive (engine tick rate).

        Never holds the internal lock across ``yield`` — consumers interleave
        :meth:`request` calls with iteration, and the reader thread needs the
        lock to complete them.
        """
        idle_deadline = time.monotonic() + timeout_s
        while True:
            with self._lock:
                frame = self._ticks.popleft() if self._ticks else None
            if frame is not None:
                yield frame
                idle_deadline = time.monotonic() + timeout_s
                continue
            if self._process is not None and self._process.poll() is not None:
                return
            if getattr(self, "_failed", False):
                return
            if time.monotonic() > idle_deadline:
                return
            time.sleep(0.002)

    def __enter__(self) -> "TruthStreamClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._done = True
        try:
            self._sock.sendall(_encode_frame({"op": "close"}))
        except OSError:
            pass
        try:
            self._sock.close()
        finally:
            if self._process is not None and self._process.poll() is None:
                try:
                    self._process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self._process.kill()
