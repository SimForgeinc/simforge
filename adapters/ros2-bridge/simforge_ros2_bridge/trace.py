"""Deterministic episode trace digest.

One SHA-256 over the ordered per-decision records ``(t, reward, flags, state
vector bytes)`` starting with the reset frame.  The bridge computes it while
driving the live episode; the replay script recomputes it from the recorded
action channel — equal hex digests mean the sim reproduced the exact same
trajectory byte for byte.
"""

from __future__ import annotations

import hashlib
import json
import struct
from typing import Any, Mapping

from .env_client import StepFrame

_FRAME_HEAD = struct.Struct("<ddB")


class TraceDigest:
    def __init__(self) -> None:
        self._hash = hashlib.sha256()
        self.frames = 0

    def update(self, frame: StepFrame) -> None:
        flags = (1 if frame.terminated else 0) | (2 if frame.truncated else 0)
        self._hash.update(_FRAME_HEAD.pack(frame.t, frame.reward, flags))
        self._hash.update(frame.sv_raw)
        self.frames += 1

    def hexdigest(self) -> str:
        return self._hash.hexdigest()


def canonical_action_json(action: Mapping[str, Any] | None) -> str:
    """Canonical JSON for one wire action — the replayable action record."""
    return json.dumps(dict(action) if action else {}, sort_keys=True, separators=(",", ":"))
