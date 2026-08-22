"""Wire protocol for the UniScenarios env-server.

Framing: every message is a 4-byte little-endian unsigned length prefix
followed by one msgpack document. Observation payloads ride as packed
little-endian typed arrays (msgpack `bin` fields), never per-step JSON.

The request/response and step-frame shapes are documented in
``packages/rl-env/src/env-server.ts``; this module is the Python mirror of
that contract (protocol version 1).
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence

import msgpack
import numpy as np

ENV_SERVER_PROTOCOL_VERSION = 1

_HEADER = struct.Struct("<I")

STATE_VECTOR_SIZE = 10

#: Compact wire keys for one action's fields.
_ACTION_KEYS = {
    "target_speed_mps": "ts",
    "target_acceleration_mps2": "ta",
    "motion_direction": "dir",
}


class ProtocolError(RuntimeError):
    """The server answered outside the documented protocol."""


class ServerError(RuntimeError):
    """The server rejected a request (`ok: 0`)."""


def encode_frame(document: Mapping[str, Any]) -> bytes:
    """One length-prefixed msgpack frame."""
    payload = msgpack.packb(dict(document), use_bin_type=True)
    return _HEADER.pack(len(payload)) + payload


class FrameReader:
    """Incremental frame splitter over a byte stream."""

    def __init__(self) -> None:
        self._buffer = b""

    def push(self, chunk: bytes) -> list[Any]:
        self._buffer += chunk
        frames: list[Any] = []
        while len(self._buffer) >= 4:
            (length,) = _HEADER.unpack_from(self._buffer)
            if len(self._buffer) < 4 + length:
                break
            payload = self._buffer[4 : 4 + length]
            self._buffer = self._buffer[4 + length :]
            frames.append(msgpack.unpackb(payload, raw=False, strict_map_key=False))
        return frames


def encode_action(action: Mapping[str, Any] | None) -> dict[str, Any]:
    """Encode a client-side action dict into the compact wire form.

    Accepted keys: ``target_speed_mps``, ``target_acceleration_mps2``,
    ``motion_direction`` (-1 or 1), ``control`` (throttle, brake, steer).
    ``None`` means "keep the authored choreography" (empty action).
    """
    if action is None:
        return {}
    wire: dict[str, Any] = {}
    for python_key, wire_key in _ACTION_KEYS.items():
        if python_key in action and action[python_key] is not None:
            wire[wire_key] = float(action[python_key]) if wire_key != "dir" else int(action[python_key])
    control = action.get("control")
    if control is not None:
        throttle, brake, steer = control
        wire["ctrl"] = [float(throttle), float(brake), float(steer)]
    return wire


@dataclass(frozen=True)
class StepFrame:
    """One decoded decision: observation, reward, flags, causal channel."""

    t_s: float
    reward: float
    terminated: bool
    truncated: bool
    state_vector: np.ndarray | None
    objects: list[dict[str, Any]]
    bev: np.ndarray | None
    bev_resolution_m: float | None
    causal: dict[str, Any] = field(default_factory=dict)
    reward_terms: tuple[float, float, float] = (0.0, 0.0, 0.0)


def decode_step_frame(frame: Mapping[str, Any]) -> StepFrame:
    """Decode one step frame; packed arrays become numpy views/copies."""
    sv_raw = frame.get("sv")
    state_vector = None if sv_raw is None else np.frombuffer(sv_raw, dtype="<f8", count=STATE_VECTOR_SIZE).copy()

    objects = [
        {
            "id": entry[0],
            "range_m": entry[1],
            "bearing_rad": entry[2],
            "range_rate_mps": entry[3],
            "line_of_sight": bool(entry[4]),
        }
        for entry in frame.get("objs", ())
    ]

    bev_raw = frame.get("bev")
    if bev_raw is None:
        bev, resolution = None, None
    else:
        channels, height, width = int(bev_raw["c"]), int(bev_raw["h"]), int(bev_raw["w"])
        bev = np.frombuffer(bev_raw["d"], dtype="<f4").reshape(height, width, channels).copy()
        resolution = float(bev_raw["res"])

    causal_wire = frame.get("cw", {})
    terms = frame.get("terms", (0.0, 0.0, 0.0))
    return StepFrame(
        t_s=float(frame["t"]),
        reward=float(frame["rw"]),
        terminated=bool(frame.get("term")),
        truncated=bool(frame.get("trunc")),
        state_vector=state_vector,
        objects=objects,
        bev=bev,
        bev_resolution_m=resolution,
        causal={
            "t_s": causal_wire.get("t"),
            "los_transitions": [
                {"observer_id": e[0], "target_id": e[1], "became_visible": bool(e[2])} for e in causal_wire.get("los", ())
            ],
            "triggers": [
                {"t_s": e[0], "kind": e[1], "interaction_id": e[2], "actor_id": e[3]}
                for e in causal_wire.get("trg", ())
            ],
            "conflict_genesis": [
                {"a": e[0], "b": e[1], "metric": e[2], "threshold": e[3], "value": e[4]}
                for e in causal_wire.get("cg", ())
            ],
        },
        reward_terms=(float(terms[0]), float(terms[1]), float(terms[2])),
    )


def check_response(response: Mapping[str, Any], request_id: int) -> Any:
    """Validate one response envelope and unwrap its payload."""
    if response.get("i") != request_id:
        raise ProtocolError(f"reply id {response.get('i')!r} does not match request {request_id}")
    if response.get("ok") == 1:
        return response.get("r")
    raise ServerError(str(response.get("e", "unknown server error")))


def batch_request(request_id: int, actions: Sequence[tuple[int, Mapping[str, Any] | None]]) -> dict[str, Any]:
    """Build a `batch_step` request carrying K (session, action) pairs."""
    return {"i": request_id, "op": "batch_step", "as": [[session, encode_action(action)] for session, action in actions]}


def step_requests(request_id: int, session: int, action: Mapping[str, Any] | None) -> dict[str, Any]:
    """Build a single-step request."""
    return {"i": request_id, "op": "step", "s": session, "a": encode_action(action)}


def reset_request(request_id: int, session: int, seed: str | int | None = None) -> dict[str, Any]:
    request: dict[str, Any] = {"i": request_id, "op": "reset", "s": session}
    if seed is not None:
        request["seed"] = seed
    return request


def batch_results(payload: Mapping[str, Any]) -> list[StepFrame]:
    results: Iterable[Mapping[str, Any]] = payload["rs"]
    return [decode_step_frame(frame) for frame in results]
