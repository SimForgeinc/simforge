"""Reference policies for the policy_step runner.

All are deterministic given their construction arguments: the scripted
policies are pure functions of the step index; the torch policy derives its
weights from ``torch.manual_seed`` and runs inference in no-grad eval mode,
so identical seeds yield bit-identical actions on one machine.

Policies return a :class:`Decision`: the compact wire action plus optional
reasoning text (the chain-of-causation for model policies; scripted
policies label their plan). The runner stores both in the digested trace.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from typing import Protocol

import numpy as np

from .protocol import control, trajectory


@dataclass(frozen=True)
class Decision:
    """One per-act policy output: wire action + optional reasoning text."""

    action: dict
    reasoning: str | None = None


class Policy(Protocol):
    name: str
    checkpoint_digest: str

    def act(self, step: int, state_vector: np.ndarray | None) -> Decision:
        """Return the decision for this step."""


class ScriptedPolicy:
    """Smooth open-loop throttle/steer schedule; ignores observations."""

    name = "scripted"
    #: Content digest of the (frozen) schedule below — the scripted policy's "weights".
    checkpoint_digest = hashlib.sha256(
        b"scripted-v1:throttle=0.35+0.15*sin(step/5.0);brake=0;steer=0.02*sin(step/7.0)"
    ).hexdigest()

    def act(self, step: int, state_vector: np.ndarray | None) -> Decision:
        throttle = 0.35 + 0.15 * math.sin(step / 5.0)
        steer = 0.02 * math.sin(step / 7.0)
        return Decision(control(throttle, 0.0, steer))


class ScriptedTrajectoryPolicy:
    """Ego-frame S-curve plans, replanned at the Alpamayo cadence.

    Emits a 4 s trajectory every ``replan_every`` decisions (default 20 =
    0.5 Hz at 10 Hz decisions) and *resends the identical points* in
    between — the server's zero-order hold keeps the original anchor, so
    the ego tracks one plan per replan window. Reasoning text is produced
    on replan acts only (held acts carry ``None``), mirroring a model that
    reasons once per plan.

    The global path is a crest-anchored cosine, ``y(t) = A(cos(wt) - 1)``:
    its tangent at t = 0 is zero, matching the ego's lane-aligned starting
    yaw — the policy is open-loop (dead-reckoned), so each replan assumes
    the ego sits on the path aligned with its tangent. Tracking error makes
    the *world* path drift slightly across replans; the plan-relative
    cross-track error in the executor telemetry is the tracking truth.
    """

    name = "scripted-trajectory"

    def __init__(
        self,
        *,
        speed_mps: float = 8.0,
        amplitude_m: float = 1.5,
        period_s: float = 10.0,
        horizon_s: float = 4.0,
        sample_s: float = 0.4,
        replan_every: int = 20,
        decision_hz: float = 10.0,
    ) -> None:
        self.speed = speed_mps
        self.amplitude = amplitude_m
        self.period = period_s
        self.horizon = horizon_s
        self.sample = sample_s
        self.replan_every = replan_every
        self.decision_hz = decision_hz
        self._held: dict | None = None

    def act(self, step: int, state_vector: np.ndarray | None) -> Decision:
        if step % self.replan_every != 0 and self._held is not None:
            return Decision(self._held)
        # Plan k continues the global path from time k*replan_every/decision_hz,
        # expressed in the path's tangent frame there (assumed == ego frame).
        t0 = step / self.decision_hz
        w = 2.0 * math.pi / self.period
        y0 = self.amplitude * (math.cos(w * t0) - 1.0)
        h0 = math.atan2(-self.amplitude * w * math.sin(w * t0), self.speed)
        points = []
        for j in range(1, round(self.horizon / self.sample) + 1):
            t = j * self.sample
            vy = -self.amplitude * w * math.sin(w * (t0 + t))
            # Global path relative to the pose the plan is issued from
            # (position y0, tangent heading h0): rotate into that frame.
            gx = self.speed * t
            gy = self.amplitude * (math.cos(w * (t0 + t)) - 1.0) - y0
            cos_h, sin_h = math.cos(h0), math.sin(h0)
            points.append(
                (
                    gx * cos_h + gy * sin_h,
                    -gx * sin_h + gy * cos_h,
                    math.atan2(vy, self.speed) - h0,
                    math.hypot(self.speed, vy),
                    t,
                )
            )
        self._held = trajectory(points)
        bearing = "right" if math.sin(w * (t0 + self.horizon / 2)) >= 0 else "left"
        reasoning = (
            f"scripted S-curve replan {step // self.replan_every}: bearing {bearing}, "
            f"amplitude {self.amplitude} m, period {self.period} s, {self.speed} m/s, "
            f"{len(points)} pts over {self.horizon} s"
        )
        return Decision(self._held, reasoning)


class TorchMlpPolicy:
    """Tiny random MLP over the 10-dim state vector; seeded, eval-mode, no-grad."""

    name = "torch-mlp"

    def __init__(self, seed: int = 0) -> None:
        import torch  # deferred: keeps the scripted path torch-free

        self._torch = torch
        torch.manual_seed(seed)
        self.net = torch.nn.Sequential(
            torch.nn.Linear(10, 32),
            torch.nn.Tanh(),
            torch.nn.Linear(32, 32),
            torch.nn.Tanh(),
            torch.nn.Linear(32, 3),
        )
        self.net.eval()
        digest = hashlib.sha256()
        for key, tensor in sorted(self.net.state_dict().items()):
            digest.update(key.encode())
            digest.update(tensor.detach().cpu().contiguous().numpy().tobytes())
        #: Content digest over the seeded weights, state_dict order — the real checkpoint identity.
        self.checkpoint_digest = digest.hexdigest()

    def act(self, step: int, state_vector: np.ndarray | None) -> Decision:
        torch = self._torch
        observation = np.zeros(10, dtype=np.float32) if state_vector is None else state_vector.astype(np.float32)
        with torch.no_grad():
            out = self.net(torch.from_numpy(observation))
        throttle = float(torch.sigmoid(out[0])) * 0.8
        steer = float(torch.tanh(out[2])) * 0.3
        return Decision(control(throttle, 0.0, steer))


def make_policy(name: str, seed: int = 0) -> Policy:
    if name == "scripted":
        return ScriptedPolicy()
    if name == "trajectory":
        return ScriptedTrajectoryPolicy()
    if name == "torch":
        return TorchMlpPolicy(seed)
    raise ValueError(f"unknown policy {name!r} (expected 'scripted', 'trajectory' or 'torch')")
