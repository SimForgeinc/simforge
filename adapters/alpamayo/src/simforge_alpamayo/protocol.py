"""Length-prefixed MessagePack framing over a stream socket.

Wire format (matches the simforge env-server convention):
    [uint32 big-endian payload length][msgpack payload]
"""

from __future__ import annotations

import socket
import struct

import msgpack

_LEN = struct.Struct(">I")
MAX_FRAME = 512 * 1024 * 1024  # 512 MiB — multi-camera raw frames are large


def send_msg(sock: socket.socket, obj: object) -> None:
    payload = msgpack.packb(obj, use_bin_type=True)
    sock.sendall(_LEN.pack(len(payload)) + payload)


def _recv_exact(sock: socket.socket, n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(min(n - len(buf), 1 << 20))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def recv_msg(sock: socket.socket) -> object | None:
    """Receive one frame; returns None on clean EOF."""
    header = _recv_exact(sock, _LEN.size)
    if header is None:
        return None
    (length,) = _LEN.unpack(header)
    if length > MAX_FRAME:
        raise ValueError(f"frame too large: {length} > {MAX_FRAME}")
    payload = _recv_exact(sock, length)
    if payload is None:
        return None
    return msgpack.unpackb(payload, raw=False)
