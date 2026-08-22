"""Synchronous vectorized client driving one server's batch API.

``UniScenariosVector`` owns one env-server process with N sessions and maps
every ``step()`` onto a single ``batch_step`` round trip — K actions in, K
results back, one transport cost per batch.
"""

from __future__ import annotations

from typing import Any, Literal, Mapping, Sequence

import numpy as np

from .env import MAX_OBJECTS, OBJECT_FEATURES
from .protocol import (
    STATE_VECTOR_SIZE,
    StepFrame,
    batch_request,
    batch_results,
    decode_step_frame,
)
from .server import EnvConnection, StdioTransport, resolve_server_command

Action = Mapping[str, Any] | None


class UniScenariosVector:
    """Synchronous vector of N UniScenarios episodes on one server process."""

    def __init__(
        self,
        episodes_spec: str,
        num_envs: int,
        *,
        decision_hz: int | None = None,
        obs: Sequence[str] | None = None,
        server_command: Sequence[str] | None = None,
        backend: Literal["ts"] = "ts",
    ) -> None:
        if backend != "ts":
            raise ValueError(f"unknown backend {backend!r}; only 'ts' is implemented")
        self.backend = backend
        self.num_envs = num_envs
        flags = ["--episodes", episodes_spec]
        if decision_hz is not None:
            flags += ["--decision-hz", str(decision_hz)]
        if obs is not None:
            flags += ["--obs", ",".join(obs)]
        self.connection: EnvConnection = StdioTransport(resolve_server_command(server_command) + tuple(flags))

        self.hello = self.connection.request({"i": self.connection.next_id(), "op": "hello"})
        if self.hello["proto"] != 1 or self.hello["sessions"] < num_envs:
            raise RuntimeError(
                f"server hosts {self.hello['sessions']} sessions (protocol {self.hello['proto']}); need {num_envs}"
            )
        self.egos: tuple[str, ...] = tuple(self.hello["egos"][:num_envs])
        self.single_observation_space = {
            "state_vector": (STATE_VECTOR_SIZE,),
            "objects": (MAX_OBJECTS, OBJECT_FEATURES),
        }

    def reset(self, *, seeds: Sequence[str | int] | None = None) -> tuple[dict[str, np.ndarray], list[dict[str, Any]]]:
        """Reset all N sessions in one round trip; session order everywhere."""
        request: dict[str, Any] = {"i": self.connection.next_id(), "op": "reset_all"}
        if seeds is not None:
            if len(seeds) != self.num_envs:
                raise ValueError(f"need {self.num_envs} seeds, got {len(seeds)}")
            request["seeds"] = list(seeds)
        frames = [decode_step_frame(frame) for frame in self.connection.request(request)["rs"]]
        return self._stack(frames), [self._info(i, frame) for i, frame in enumerate(frames)]

    def step(
        self, actions: Sequence[Action]
    ) -> tuple[dict[str, np.ndarray], np.ndarray, np.ndarray, np.ndarray, list[dict[str, Any]]]:
        if len(actions) != self.num_envs:
            raise ValueError(f"need {self.num_envs} actions, got {len(actions)}")
        request = batch_request(self.connection.next_id(), list(enumerate(actions)))
        frames = batch_results(self.connection.request(request))
        rewards = np.array([frame.reward for frame in frames], dtype=np.float64)
        terminated = np.array([frame.terminated for frame in frames], dtype=np.bool_)
        truncated = np.array([frame.truncated for frame in frames], dtype=np.bool_)
        return self._stack(frames), rewards, terminated, truncated, [self._info(i, frame) for i, frame in enumerate(frames)]

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "UniScenariosVector":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -------------------------------------------------------------- helpers

    def _stack(self, frames: Sequence[StepFrame]) -> dict[str, np.ndarray]:
        state = np.stack([frame.state_vector for frame in frames])  # type: ignore[arg-type]
        objects = np.zeros((self.num_envs, MAX_OBJECTS, OBJECT_FEATURES), dtype=np.float32)
        for i, frame in enumerate(frames):
            for j, entry in enumerate(frame.objects[:MAX_OBJECTS]):
                objects[i, j] = (
                    entry["range_m"],
                    entry["bearing_rad"],
                    entry["range_rate_mps"],
                    1.0 if entry["line_of_sight"] else 0.0,
                    1.0,
                )
        return {"state_vector": state, "objects": objects}

    def _info(self, session: int, frame: StepFrame) -> dict[str, Any]:
        progress, proximity, comfort = frame.reward_terms
        return {
            "t_s": frame.t_s,
            "ego": self.egos[session],
            "objects": frame.objects,
            "reward_terms": {"progress": progress, "proximity": proximity, "comfort": comfort},
            "causal": frame.causal,
        }
