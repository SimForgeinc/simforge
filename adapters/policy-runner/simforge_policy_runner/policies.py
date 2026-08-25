"""Reference policies for the policy_step runner.

Both are deterministic given their construction arguments: the scripted
policy is a pure function of the step index; the torch policy derives its
weights from ``torch.manual_seed`` and runs inference in no-grad eval mode,
so identical seeds yield bit-identical actions on one machine.
"""

from __future__ import annotations

import math
from typing import Any, Protocol

import numpy as np

from .protocol import control


class Policy(Protocol):
    name: str

    def act(self, step: int, state_vector: np.ndarray | None) -> dict[str, Any]:
        """Return one compact wire action for this decision."""


class ScriptedPolicy:
    """Smooth open-loop throttle/steer schedule; ignores observations."""

    name = "scripted"

    def act(self, step: int, state_vector: np.ndarray | None) -> dict[str, Any]:
        throttle = 0.35 + 0.15 * math.sin(step / 5.0)
        steer = 0.02 * math.sin(step / 7.0)
        return control(throttle, 0.0, steer)


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

    def act(self, step: int, state_vector: np.ndarray | None) -> dict[str, Any]:
        torch = self._torch
        observation = np.zeros(10, dtype=np.float32) if state_vector is None else state_vector.astype(np.float32)
        with torch.no_grad():
            out = self.net(torch.from_numpy(observation))
        throttle = float(torch.sigmoid(out[0])) * 0.8
        steer = float(torch.tanh(out[2])) * 0.3
        return control(throttle, 0.0, steer)


def make_policy(name: str, seed: int = 0) -> Policy:
    if name == "scripted":
        return ScriptedPolicy()
    if name == "torch":
        return TorchMlpPolicy(seed)
    raise ValueError(f"unknown policy {name!r} (expected 'scripted' or 'torch')")
