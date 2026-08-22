"""UniScenariosEnv: spaces, reward types, gymnasium check_env-style smoke."""

from __future__ import annotations

import numpy as np
import pytest

from uniscenarios_gym import UniScenariosEnv

from conftest import server_cmd  # noqa: F401 - re-exported fixture


@pytest.fixture()
def env(spec: str, server_cmd: tuple[str, ...]) -> UniScenariosEnv:
    environment = UniScenariosEnv(spec, seed="seed-a", server_command=server_cmd)
    yield environment
    environment.close()


def test_observation_and_action_space_types(env: UniScenariosEnv) -> None:
    assert isinstance(env.observation_space, __import__("gymnasium").spaces.Dict)
    assert env.observation_space["state_vector"].shape == (10,)
    assert env.observation_space["objects"].shape == (64, 5)
    assert env.action_space.shape == (3,)
    assert env.ego == "ego"


def test_reset_returns_t0_observation(env: UniScenariosEnv) -> None:
    obs, info = env.reset(options={"seed": "seed-a"})
    assert info["t_s"] == 0.0
    assert obs["state_vector"].dtype == np.float64
    assert obs["state_vector"].shape == (10,)
    assert obs["objects"].dtype == np.float32
    assert obs["objects"][:, 4].sum() >= 1  # at least one perceived object marked valid


def test_step_reward_and_info_contract(env: UniScenariosEnv) -> None:
    env.reset(options={"seed": "seed-a"})
    obs, reward, terminated, truncated, info = env.step({"target_speed_mps": 9.0})
    assert isinstance(reward, float)
    assert terminated in (True, False) and truncated in (True, False)
    assert info["t_s"] == pytest.approx(0.1)
    assert set(info["reward_terms"]) == {"progress", "proximity", "comfort"}
    assert "causal" in info and info["ego"] == "ego"
    assert obs["state_vector"][0] > 0


def test_episode_runs_to_truncation(env: UniScenariosEnv) -> None:
    """Clip is 4 s at 10 Hz: the episode must truncate exactly at t = 3.9→4.0 s."""
    env.reset(options={"seed": "seed-b"})
    last_t, truncated = -1.0, False
    for _ in range(60):
        _, _, terminated, truncated, info = env.step(None)
        last_t = info["t_s"]
        if terminated or truncated:
            break
    assert truncated, f"episode neither truncated nor terminated (last t={last_t})"
    assert last_t == pytest.approx(4.0)


def test_gymnasium_api_smoke(env: UniScenariosEnv) -> None:
    """check_env-style smoke: sample actions/observations, one full step cycle."""
    action = env.action_space.sample() * 0.0 + np.array([9.0, 0.0, 0.0], dtype=np.float32)
    obs, _ = env.reset(seed=7)
    env.observation_space.contains(obs)
    obs2, reward, terminated, truncated, _ = env.step({"target_speed_mps": float(action[0])})
    assert obs2["state_vector"].shape == obs["state_vector"].shape
    assert np.isfinite(reward)


def test_backend_enum_reserved(spec: str) -> None:
    with pytest.raises(ValueError, match="backend"):
        UniScenariosEnv(spec, backend="py")  # type: ignore[arg-type]
