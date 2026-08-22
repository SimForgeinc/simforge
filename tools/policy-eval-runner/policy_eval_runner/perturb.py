"""Deployment perturbation wrappers (Bench2Drive-Robust, arXiv 2605.18059).

Both wrappers live entirely at the client layer: the environment, the engine
and the wire protocol are untouched. They wrap any EvalPolicy.

- LatencyPolicy   — inference-latency injection: the action chosen at decision
                    t is applied at decision t+k; earlier decisions send the
                    no-op action while the pipeline fills.
- EgoStateNoise   — seeded Gaussian noise on the observation state vector fed
                    TO THE POLICY. Stored metrics always use the true state,
                    so noise degrades only the policy's belief.
"""

from __future__ import annotations

import hashlib
from typing import Any


def episode_noise_seed(suite_hash: str, arm: str, entry_id: str, salt: str) -> int:
    """Deterministic 64-bit RNG seed derived from the replay key."""
    digest = hashlib.sha256(f"{suite_hash}|{arm}|{entry_id}|{salt}".encode()).digest()
    return int.from_bytes(digest[:8], "big")


class _CloseProxy:
    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def close(self) -> None:
        inner_close = getattr(self._inner, "close", None)
        if callable(inner_close):
            inner_close()


class LatencyPolicy(_CloseProxy):
    """Delay every action by `ticks` decisions (zero-order hold upstream)."""

    def __init__(self, inner: Any, ticks: int) -> None:
        super().__init__(inner)
        if ticks < 0:
            raise ValueError(f"latency ticks must be >= 0, got {ticks}")
        self.ticks = ticks
        self._pipeline: list[dict[str, float] | None] = []

    @property
    def name(self) -> str:
        return f"{self._inner.name}+lat{self.ticks}"

    def reset_episode(self, entry_id: str) -> None:
        self._pipeline = []
        inner_reset = getattr(self._inner, "reset_episode", None)
        if callable(inner_reset):
            inner_reset(entry_id)

    def act(self, frame: dict[str, Any]) -> dict[str, float] | None:
        fresh = self._inner.act(frame)
        self._pipeline.append(fresh)
        if len(self._pipeline) <= self.ticks:
            return None
        return self._pipeline.pop(0)


class EgoStateNoisePolicy(_CloseProxy):
    """Add N(0, std) to the policy's view of the ego state vector."""

    def __init__(self, inner: Any, std: float, seed: int) -> None:
        super().__init__(inner)
        import numpy as np

        if std < 0:
            raise ValueError(f"ego noise std must be >= 0, got {std}")
        self.std = std
        self._np = np
        self._rng = np.random.default_rng(seed)

    @property
    def name(self) -> str:
        return f"{self._inner.name}+ns{self.std:g}"

    def act(self, frame: dict[str, Any]) -> dict[str, float] | None:
        if self.std == 0.0 or frame.get("state_vector") is None:
            return self._inner.act(frame)
        noisy = dict(frame)
        noisy["state_vector"] = frame["state_vector"] + self._rng.normal(
            0.0, self.std, size=len(frame["state_vector"])
        )
        return self._inner.act(noisy)
