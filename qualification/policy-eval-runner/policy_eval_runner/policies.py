"""Policy interface for the eval runner.

An `EvalPolicy` maps one decoded step frame to an action dict (or None for
the authored-choreography baseline). Two implementations:

- AuthoredChoreographyPolicy: no policy — the authored ego choreography
  runs untouched. This is the r0 baseline every later number compares to.
- PpoPolicy: any checkpoint produced by scripts/rl/train_ppo.py, loaded by
  importing that module from the rl checkout (read-only) so the network,
  observation scaling and action squashing stay byte-compatible with
  training.
"""

from __future__ import annotations

import importlib.util
import pathlib
from typing import Any, Protocol

import numpy as np


class EvalPolicy(Protocol):
    name: str

    def act(self, frame: dict[str, Any]) -> dict[str, float] | None: ...

    def close(self) -> None: ...


class _NoopClose:
    def close(self) -> None:
        return None


class AuthoredChoreographyPolicy(_NoopClose):
    """Empty action every decision: the engine drives the authored ego."""

    name = "authored"

    def act(self, frame: dict[str, Any]) -> dict[str, float] | None:
        return None


def load_train_ppo_module(rl_scripts_dir: str | pathlib.Path) -> Any:
    """Import scripts/rl/train_ppo.py from the rl checkout, read-only."""
    module_path = pathlib.Path(rl_scripts_dir) / "train_ppo.py"
    if not module_path.exists():
        raise FileNotFoundError(f"train_ppo.py not found under {rl_scripts_dir}")
    spec = importlib.util.spec_from_file_location("ws5_train_ppo", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot import {module_path}")
    module = importlib.util.module_from_spec(spec)
    import sys

    sys.modules.setdefault("ws5_train_ppo", module)
    # train_ppo imports env_client from its own directory.
    sys.path.insert(0, str(module_path.resolve().parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(module_path.resolve().parent))
    return module


class PpoPolicy(_NoopClose):
    """Deterministic mean-action PPO policy over sv+BEV observations."""

    def __init__(self, checkpoint: str | pathlib.Path, rl_scripts_dir: str | pathlib.Path, device: str | None = None) -> None:
        try:
            import torch
        except ImportError as error:  # pragma: no cover - environment guard
            raise RuntimeError(
                "torch is required for --checkpoint; install with 'pip install "
                "policy-eval-runner[policy]' or run the authored baseline only"
            ) from error
        self.torch = torch
        train_ppo = load_train_ppo_module(rl_scripts_dir)
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.network = train_ppo.Policy().to(self.device)
        self.network.load_state_dict(torch.load(checkpoint, map_location=self.device, weights_only=True))
        self.network.eval()
        self._mid = train_ppo.ACT_MID_T.to(self.device)
        self._half = train_ppo.ACT_HALF_T.to(self.device)
        self.name = f"ppo:{pathlib.Path(checkpoint).name}"

    def act(self, frame: dict[str, Any]) -> dict[str, float]:
        torch = self.torch
        assert frame["state_vector"] is not None and frame["bev"] is not None
        sv = np.asarray(frame["state_vector"], dtype=np.float32) / np.array(
            [100, 100, 1, 1, 15, 4, 3, 2, 100, 60], dtype=np.float32
        )
        bev = np.asarray(frame["bev"], dtype=np.float32).transpose(2, 0, 1)
        sv_t = torch.tensor(sv, device=self.device).unsqueeze(0)
        bev_t = torch.tensor(bev, device=self.device).unsqueeze(0)
        with torch.no_grad():
            raw = self.network.raw_dist(sv_t, bev_t).mean
            setpoints = (self._mid + self._half * torch.tanh(raw))[0].cpu().numpy()
        return {
            "target_speed_mps": float(setpoints[0]),
            "target_acceleration_mps2": float(setpoints[1]),
        }
