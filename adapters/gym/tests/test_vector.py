"""SimForgeVector: batch API semantics and cross-run determinism."""

from __future__ import annotations

import numpy as np
import pytest

from simforge_oss_gym import SimForgeVector

from conftest import server_cmd  # noqa: F401 - re-exported fixture

N_ENVS = 4


@pytest.fixture()
def vec(spec: str, server_cmd: tuple[str, ...]) -> SimForgeVector:
    vector = SimForgeVector(spec, N_ENVS, server_command=server_cmd)
    yield vector
    vector.close()


def _rollout(vector: SimForgeVector) -> tuple[np.ndarray, np.ndarray]:
    """One deterministic scripted rollout; returns (rewards, final states)."""
    obs, infos = vector.reset(seeds=[f"seed-{i}" for i in range(N_ENVS)])
    assert [info["t_s"] for info in infos] == [0.0] * N_ENVS
    rewards = np.zeros(0)
    states = obs["state_vector"]
    for k in range(6):
        actions = [{"target_speed_mps": 9.0} if (i + k) % 2 == 0 else {"target_acceleration_mps2": -1.0} for i in range(N_ENVS)]
        obs, rewards, terminated, truncated, infos = vector.step(actions)
        states = obs["state_vector"]
        assert [round(info["t_s"], 6) for info in infos] == [round((k + 1) / 10, 6)] * N_ENVS
        if terminated.any() or truncated.any():
            break
    return rewards, states


def test_vector_shapes_and_batch_round_trip(vec: SimForgeVector) -> None:
    obs, _ = vec.reset(seeds=["a", "b", "c", "d"])
    assert obs["state_vector"].shape == (N_ENVS, 10)
    assert obs["objects"].shape == (N_ENVS, 64, 5)
    actions = [{"target_speed_mps": 9.0}] * N_ENVS
    obs, rewards, terminated, truncated, infos = vec.step(actions)
    assert rewards.shape == (N_ENVS,)
    assert terminated.shape == truncated.shape == (N_ENVS,)
    assert terminated.dtype == np.bool_ and truncated.dtype == np.bool_
    assert len(infos) == N_ENVS and infos[0]["ego"] == "ego"


def test_batched_steps_are_deterministic_across_runs(spec: str, server_cmd: tuple[str, ...]) -> None:
    """Same seeds + action stream on two fresh servers → identical episodes."""
    with SimForgeVector(spec, N_ENVS, server_command=server_cmd) as first:
        rewards_a, states_a = _rollout(first)
    with SimForgeVector(spec, N_ENVS, server_command=server_cmd) as second:
        rewards_b, states_b = _rollout(second)
    np.testing.assert_array_equal(rewards_a, rewards_b)
    np.testing.assert_array_equal(states_a, states_b)


def test_rejects_wrong_action_count(vec: SimForgeVector) -> None:
    with pytest.raises(ValueError):
        vec.step([{"target_speed_mps": 9.0}] * (N_ENVS - 1))
