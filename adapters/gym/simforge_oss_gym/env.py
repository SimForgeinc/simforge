"""Gymnasium ``Env`` over one env-server session.

The default transport spawns ``simforge-env-server`` as a subprocess and
speaks the framed msgpack protocol over stdio; pass ``socket_path`` to attach
to an already-running server instead. ``backend="ts"`` names the TypeScript
sim-engine server and is currently the only backend (the enum value is
reserved for future alternative engines).
"""

from __future__ import annotations

from typing import Any, Literal, Mapping, Sequence

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .protocol import (
    ENV_SERVER_PROTOCOL_VERSION,
    STATE_VECTOR_SIZE,
    StepFrame,
    decode_step_frame,
    reset_request,
    step_requests,
)
from .server import EnvConnection, SocketTransport, StdioTransport, resolve_server_command

#: Upper bound on perception objects materialized into the padded array.
MAX_OBJECTS = 64

#: Perceived-object feature layout: [range_m, bearing_rad, range_rate_mps, los, valid].
OBJECT_FEATURES = 5


class SimForgeEnv(gym.Env):
    """One SimForge episode stream served by ``simforge-env-server``.

    Observations are a dict:

    - ``state_vector``: float64 ``(10,)`` ego state (fixed engine layout);
    - ``objects``: float32 ``(64, 5)`` zero-padded perception features;
    - ``bev`` (only when the server was started with BEV enabled): the raster.

    Raw object entries, reward terms and the causal ground-truth frame ride in
    ``info`` every step.
    """

    metadata: dict[str, Any] = {"render_modes": []}

    def __init__(
        self,
        episodes_spec: str | None = None,
        *,
        session: int = 0,
        decision_hz: int | None = None,
        obs: Sequence[str] | None = None,
        seed: str | int | None = None,
        socket_path: str | None = None,
        server_command: Sequence[str] | None = None,
        backend: Literal["ts"] = "ts",
    ) -> None:
        super().__init__()
        if backend != "ts":
            raise ValueError(f"unknown backend {backend!r}; only 'ts' is implemented")
        self.backend = backend
        self.session_index = session
        self._default_seed = seed
        self.connection = self._connect(episodes_spec, decision_hz, obs, socket_path, server_command)

        self.hello = self.connection.request({"i": self.connection.next_id(), "op": "hello"})
        if self.hello["proto"] != ENV_SERVER_PROTOCOL_VERSION:
            raise RuntimeError(f"server protocol {self.hello['proto']} != client {ENV_SERVER_PROTOCOL_VERSION}")
        if session >= self.hello["sessions"]:
            raise RuntimeError(f"session {session} requested but server hosts {self.hello['sessions']}")
        self._define_spaces(self.hello)
        self.ego = self.hello["egos"][session]

    def _connect(
        self,
        episodes_spec: str | None,
        decision_hz: int | None,
        obs: Sequence[str] | None,
        socket_path: str | None,
        server_command: Sequence[str] | None,
    ) -> EnvConnection:
        """Attach to a running server, or spawn one owning this env's spec."""
        if socket_path is not None:
            # An attached server must already run with the desired
            # --episodes/--obs configuration; only the session index is ours.
            return SocketTransport(socket_path)
        if episodes_spec is None:
            raise ValueError("episodes_spec is required when spawning a server (or pass socket_path)")
        flags = ["--episodes", episodes_spec]
        if decision_hz is not None:
            flags += ["--decision-hz", str(decision_hz)]
        if obs is not None:
            flags += ["--obs", ",".join(obs)]
        return StdioTransport(resolve_server_command(server_command) + tuple(flags))

    def _define_spaces(self, hello: Mapping[str, Any]) -> None:
        members: dict[str, spaces.Space] = {
            "state_vector": spaces.Box(-np.inf, np.inf, (STATE_VECTOR_SIZE,), np.float64),
            "objects": spaces.Box(-np.inf, np.inf, (MAX_OBJECTS, OBJECT_FEATURES), np.float32),
        }
        if hello.get("obs", {}).get("bev"):
            raise NotImplementedError("bev observation spaces arrive with Phase 7 pixel channels")
        self.observation_space = spaces.Dict(members)
        # Action: subset of {target_speed_mps, target_acceleration_mps2,
        # motion_direction(-1|1), control(throttle, brake, steer)}; empty
        # action keeps the authored choreography. The Box covers the three
        # continuous knobs; direction rides in the dict form.
        self.action_space = spaces.Box(-np.inf, np.inf, (3,), np.float32)

    # ------------------------------------------------------------------ api

    def reset(
        self, *, seed: int | None = None, options: Mapping[str, Any] | None = None
    ) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        super().reset(seed=seed)
        effective_seed = seed if seed is not None else (options or {}).get("seed", self._default_seed)
        payload = self.connection.request(
            reset_request(self.connection.next_id(), self.session_index, effective_seed)
        )
        frame = decode_step_frame(payload)
        return self._package(frame), self._info(frame)

    def step(
        self, action: Mapping[str, Any] | None
    ) -> tuple[dict[str, np.ndarray], float, bool, bool, dict[str, Any]]:
        frame = decode_step_frame(
            self.connection.request(step_requests(self.connection.next_id(), self.session_index, action))
        )
        return self._package(frame), frame.reward, frame.terminated, frame.truncated, self._info(frame)

    def close(self) -> None:
        self.connection.close()

    # -------------------------------------------------------------- helpers

    def _package(self, frame: StepFrame) -> dict[str, np.ndarray]:
        assert frame.state_vector is not None  # the state-vector channel is always on for gym clients
        objects = np.zeros((MAX_OBJECTS, OBJECT_FEATURES), dtype=np.float32)
        for i, entry in enumerate(frame.objects[:MAX_OBJECTS]):
            objects[i] = (
                entry["range_m"],
                entry["bearing_rad"],
                entry["range_rate_mps"],
                1.0 if entry["line_of_sight"] else 0.0,
                1.0,
            )
        obs = {"state_vector": frame.state_vector, "objects": objects}
        if frame.bev is not None:
            obs["bev"] = frame.bev
        return obs

    def _info(self, frame: StepFrame) -> dict[str, Any]:
        progress, proximity, comfort = frame.reward_terms
        return {
            "t_s": frame.t_s,
            "ego": self.ego,
            "objects": frame.objects,
            "reward_terms": {"progress": progress, "proximity": proximity, "comfort": comfort},
            "causal": frame.causal,
        }
