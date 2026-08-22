# uniscenarios-gym

Gymnasium client for the UniScenarios deterministic env-server
(`uniscenarios-env-server` from `@uniscenarios/rl-env`).

- **`UniScenariosEnv`** — one `gymnasium.Env` over one server session.
  Observations: `state_vector` (float64 `(10,)`, fixed engine layout),
  `objects` (float32 `(64, 5)`, zero-padded perception features), optional
  `bev`. Actions: subsets of `{target_speed_mps, target_acceleration_mps2,
  motion_direction, control(throttle, brake, steer)}`; `None` keeps the
  authored choreography. `info` carries reward terms and the versioned causal
  ground-truth frame every step.
- **`UniScenariosVector`** — synchronous vector of N sessions on ONE server
  process; each `step()` is a single batched round trip (K actions in, K
  results back).

## Transport

Length-prefixed msgpack frames (4-byte LE u32 + one msgpack document) over
stdio or a unix socket. Heavy payloads ride as packed little-endian typed
arrays. The protocol is documented in
`packages/rl-env/src/env-server.ts`; `backend="ts"` names the TypeScript
sim-engine server (the only backend today).

## Usage

```python
from uniscenarios_gym import UniScenariosEnv, UniScenariosVector

env = UniScenariosEnv("episodes.json", seed="seed-a")
obs, info = env.reset()

vec = UniScenariosVector("episodes.json", num_envs=8)
obs, infos = vec.reset(seeds=[f"seed-{i}" for i in range(8)])
obs, rewards, terminated, truncated, infos = vec.step([{"target_speed_mps": 9.0}] * 8)
```

The client spawns the server automatically (`uniscenarios-env-server` on
PATH, or the repo workspace build); pass `server_command=[...]` to override,
or `socket_path=` to attach to a running server started with `--socket`.

## Development

```sh
uv build --wheel
uv run --with pytest pytest tests
```
