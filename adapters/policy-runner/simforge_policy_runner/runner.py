"""Episode runner: seeded policy_step episodes with a JSONL trace and digests.

Each trace line carries the deterministic step record plus a ``digest`` —
a SHA-256 chained over the canonical JSON of every deterministic record so
far. Wall-clock timing (``timing``) and the reported ``elapsedMs`` are
*excluded* from the digest: two runs with the same seed, policy, and forced
misses produce identical digests even though inference latency varies.

Deadline misses are exercised deterministically: ``force_miss_at`` steps
report a fixed elapsedMs of 4x the deadline instead of the measured time,
so the fallback path is part of the digested dynamics. Spurious misses
cannot occur as long as real inference stays under the deadline (sub-ms
MLPs against the default 50 ms budget).
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import numpy as np

from .policies import Policy
from .protocol import POLICY_STEP_PROTOCOL_VERSION, PolicyServer


def _canonical(record: Mapping[str, Any]) -> bytes:
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode()


def _state_vector(frame: Mapping[str, Any]) -> np.ndarray | None:
    packed = frame.get("sv")
    if packed is None:
        return None
    return np.frombuffer(packed, dtype="<f8")


def _sv_values(frame: Mapping[str, Any]) -> list[float] | None:
    """Decoded state vector as plain floats (JSON round-trips exactly)."""
    vector = _state_vector(frame)
    if vector is None:
        return None
    return [float(v) for v in vector]


def _reward_terms(frame: Mapping[str, Any]) -> list[float] | None:
    terms = frame.get("terms")
    if terms is None:
        return None
    return [float(v) for v in terms]


def _percentiles(samples: list[float]) -> dict[str, float]:
    if not samples:
        return {"p50": 0.0, "p95": 0.0, "max": 0.0}
    data = np.asarray(samples)
    return {
        "p50": round(float(np.percentile(data, 50)), 4),
        "p95": round(float(np.percentile(data, 95)), 4),
        "max": round(float(data.max()), 4),
    }


@dataclass
class EpisodeSummary:
    policy: str
    policy_checkpoint: str
    seed: int | str
    session: int
    steps: int
    deadline_misses: int
    episode_digest: str
    terminated: bool
    truncated: bool
    infer_ms: dict[str, float] = field(default_factory=dict)
    roundtrip_ms: dict[str, float] = field(default_factory=dict)


def run_episode(
    server: PolicyServer,
    policy: Policy,
    *,
    session: int = 0,
    seed: int | str,
    deadline_ms: float = 50.0,
    fallback: str = "repeat-last",
    max_steps: int = 30,
    force_miss_at: tuple[int, ...] = (),
    trace_path: str | Path | None = None,
) -> EpisodeSummary:
    hello = server.request("policy.hello", v=POLICY_STEP_PROTOCOL_VERSION)
    assert hello["proto"] == POLICY_STEP_PROTOCOL_VERSION

    reset = server.request("policy.reset", s=session, seed=seed, deadlineMs=deadline_ms, fallback=fallback)
    frame: Mapping[str, Any] = reset["ob"]

    chain = hashlib.sha256()
    reset_record = {
        "reset": {
            "seed": seed,
            "session": session,
            "t": frame["t"],
            "sv_sha256": hashlib.sha256(frame["sv"]).hexdigest() if frame.get("sv") else None,
            "sv": _sv_values(frame),
            "objs": frame["objs"],
            "deadline_ms": deadline_ms,
            "fallback": fallback,
            "policy": policy.name,
        }
    }
    chain.update(_canonical(reset_record))

    lines: list[str] = [json.dumps({**reset_record, "digest": chain.hexdigest()}, sort_keys=True)]
    infer_samples: list[float] = []
    roundtrip_samples: list[float] = []
    misses = 0
    terminated = truncated = False
    steps_done = 0

    for step in range(max_steps):
        state_vector = _state_vector(frame)

        t0 = time.perf_counter()
        action = policy.act(step, state_vector)
        infer_ms = (time.perf_counter() - t0) * 1000.0

        # Forced misses report a fixed, deterministic elapsed time; honest
        # steps report the measured one (digest-excluded either way).
        reported_ms = deadline_ms * 4.0 if step in force_miss_at else infer_ms

        t1 = time.perf_counter()
        response = server.request("policy.act", s=session, steps=[{"a": action, "elapsedMs": reported_ms}])
        roundtrip_ms = (time.perf_counter() - t1) * 1000.0

        frame = response["rs"][0]
        deadline = frame["dl"]
        miss = bool(deadline["miss"])
        misses += miss
        terminated = bool(frame["term"])
        truncated = bool(frame["trunc"])
        steps_done = step + 1
        infer_samples.append(infer_ms)
        roundtrip_samples.append(roundtrip_ms)

        deterministic = {
            "step": step,
            "t": frame["t"],
            "a": action,
            "miss": int(miss),
            "applied": deadline["ap"],
            "rw": frame["rw"],
            "term": frame["term"],
            "trunc": frame["trunc"],
            "sv_sha256": hashlib.sha256(frame["sv"]).hexdigest() if frame.get("sv") else None,
            "sv": _sv_values(frame),
            "terms": _reward_terms(frame),
            "objs": frame["objs"],
        }
        chain.update(_canonical(deterministic))
        lines.append(
            json.dumps(
                {
                    **deterministic,
                    "digest": chain.hexdigest(),
                    "timing": {"infer_ms": round(infer_ms, 4), "roundtrip_ms": round(roundtrip_ms, 4)},
                },
                sort_keys=True,
            )
        )
        if terminated or truncated:
            break

    summary = EpisodeSummary(
        policy=policy.name,
        policy_checkpoint=policy.checkpoint_digest,
        seed=seed,
        session=session,
        steps=steps_done,
        deadline_misses=misses,
        episode_digest=chain.hexdigest(),
        terminated=terminated,
        truncated=truncated,
        infer_ms=_percentiles(infer_samples),
        roundtrip_ms=_percentiles(roundtrip_samples),
    )
    lines.append(json.dumps({"summary": summary.__dict__}, sort_keys=True))

    if trace_path is not None:
        Path(trace_path).write_text("\n".join(lines) + "\n")
    return summary
