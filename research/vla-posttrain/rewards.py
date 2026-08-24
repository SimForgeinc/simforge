"""Poutine-shape rewards (arXiv 2506.11234 eq. 5-6).

r = r_drive + r_format, with
  r_drive  in [0, 1]  : exp(-ADE / scale) against the engine reference trajectory
  r_format in {0, 1}  : 1 iff the completion parses as exactly T waypoints

No chain-of-thought at RL time: the completion IS the trajectory text.

WS2 staging hook: `make_reward_fn(grader=None, weight=...)`. When the WS2
faithfulness critic passes its gate, pass a callable mapping each completion
to a scalar in [0, 1]; it is added as `weight * faithfulness`, ramped behind
the programmatic core (plan doc WS7.3 / AD-R1 caution).
"""
from __future__ import annotations

import math
import re
from typing import Callable, Sequence

WAYPOINT_RE = re.compile(r"<\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*>")

DRIVE_SCALE_M = 2.0  # ADE (m) at which r_drive decays to 1/e


def parse_trajectory(text: str, n_points: int) -> list[tuple[float, float]] | None:
    """Return exactly n_points (x, y) waypoints, or None if malformed."""
    pts = [(float(a), float(b)) for a, b in WAYPOINT_RE.findall(text)]
    if len(pts) != n_points:
        return None
    return pts


def ade(pred: Sequence[tuple[float, float]], ref: Sequence[tuple[float, float]]) -> float:
    """Average displacement error in meters."""
    return math.sqrt(
        sum((px - rx) ** 2 + (py - ry) ** 2 for (px, py), (rx, ry) in zip(pred, ref))
    ) / len(ref)


def drive_reward(pred: Sequence[tuple[float, float]] | None, ref: Sequence[tuple[float, float]]) -> float:
    """r_drive in [0, 1]; 0 when unparseable."""
    if pred is None:
        return 0.0
    return math.exp(-ade(pred, ref) / DRIVE_SCALE_M)


def make_reward_fn(
    n_points: int = 6,
    grader: Callable[[list[str]], list[float]] | None = None,
    grader_weight: float = 0.0,
):
    """Build a TRL-compatible reward fn.

    TRL passes extra dataset columns as kwargs, so `ref_traj` arrives here.
    Returns (rewards, parts) so the caller can log the decomposition.
    """

    def reward_fn(prompts, completions, ref_traj=None, **kwargs):
        refs = ref_traj if ref_traj is not None else [None] * len(completions)
        comps = [c[0]["content"] if isinstance(c, list) else c for c in completions]
        faith = grader(comps) if (grader is not None and grader_weight > 0) else [0.0] * len(comps)
        rewards, parts = [], []
        for comp, ref, f in zip(comps, refs, faith):
            pred = parse_trajectory(comp, n_points)
            rd = drive_reward(pred, ref) if ref is not None else 0.0
            rf = 1.0 if pred is not None else 0.0
            rewards.append(rd + rf + grader_weight * f)
            parts.append({"drive": round(rd, 4), "format": rf, "faithfulness": round(f, 4)})
        reward_fn.last_parts = parts  # type: ignore[attr-defined]
        return rewards

    return reward_fn
