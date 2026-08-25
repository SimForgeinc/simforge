# policy_step Protocol (F3)

Session-oriented policy ops — `policy.hello` / `policy.reset` / `policy.act`
/ `policy.close` — layered on the existing env-server wire. Source of truth
for types and codecs: `packages/training-env/src/policy-step.ts`; server
glue: `packages/training-env/src/policy-session.ts`; reference client:
`adapters/policy-runner`.

Protocol version: **1** (`POLICY_STEP_PROTOCOL_VERSION`). Any breaking
change to the shapes below bumps it; `policy.hello` rejects mismatches.

## Transport and envelope

Identical to the env-server: length-prefixed msgpack frames (4-byte LE u32
payload length, then one msgpack document) over a unix socket or stdio.

```
request   {i: u64 id, op: string, ...op fields}
response  {i, ok: 1, r: payload} | {i, ok: 0, e: message}
```

Three op families share one connection and one envelope:

| family     | owner          | examples                          |
|------------|----------------|-----------------------------------|
| unprefixed | env-server core| `hello`, `reset`, `step`, `batch_step`, `subscribe`, `close` |
| `policy.*` | this protocol  | `policy.hello`, `policy.reset`, `policy.act`, `policy.close` |
| `world.*`  | world server   | `world.session.create`, `world.spawn`, `world.tick.advance` |

Extension families register through `EnvServer.registerOp(op, handler)` —
an additive seam consulted after the core dispatch switch. Core ops cannot
be shadowed.

## Determinism and deadlines

The server inherits the env-server invariant: **no wall-clock data anywhere
in the protocol**. Responses are a pure function of the request stream —
same seed, same requests, byte-identical responses.

Deadline enforcement is therefore *declarative*: the client (or a real-time
gateway fronting the server) measures its own inference latency and reports
it per action as `elapsedMs`. A decision **misses** when
`elapsedMs > deadlineMs` (both present; the boundary `elapsedMs ==
deadlineMs` is on time; either side absent means no enforcement). On a miss
the supplied action is discarded and the session's fallback applies:

| fallback       | applied action                                                          |
|----------------|-------------------------------------------------------------------------|
| `repeat-last`  | the last *applied* action of this episode (policy or fallback); before any applied action it degrades to `scripted` |
| `zero-control` | control passthrough `{throttle: 0, brake: 0, steer: 0}` (coast, wheel centred) |
| `scripted`     | no override this decision — the authored choreography drives the ego     |

The fallback policy is fixed at `policy.reset`; `deadlineMs` defaults there
and may be overridden per `policy.act` request. Every step frame reports
the verdict in `dl` (below), so traces always show what actually drove the
ego.

## Ops

### `policy.hello {v}`

`v` must equal the client's `POLICY_STEP_PROTOCOL_VERSION`. Response:

```
{proto, envProto, sessions, decisionHz, engineHz, egos: [id…],
 actions: ['trajectory', 'control'],
 fallbacks: ['repeat-last', 'zero-control', 'scripted'],
 obs: {sv, bev, frameBundle}}
```

### `policy.reset {s?, seed?, deadlineMs?, fallback?}`

Binds (or rebinds) policy state to env session index `s` (default 0) and
rebuilds its episode. `seed` (number | string) replaces the input's
authored seed deterministically; omitted keeps it. Clears the recurrent
state token and the repeat-last memory. Response:

```
{seed: <echo | null>, st: bin (empty), ob: <step frame>}
```

### `policy.act {s?, steps: [{a, elapsedMs?}…], st?: bin, deadlineMs?}`

Applies 1..K actions **sequentially** to session `s`. A terminal step
mid-batch makes the next entry fail the whole request (post-episode
stepping is undefined) — clients stop batching at `term`/`trunc`. `st`
replaces the stored recurrent state token. Response:

```
{st: bin (current token), rs: [<step frame + dl>…]}
```

### `policy.close {s?}`

Drops the policy state binding for session `s`. Does **not** shut the
server down (the core `close` op does) and does not disturb the underlying
env session.

## Actions

Tagged unions; compact wire forms in parentheses:

- **trajectory** (`{k: 't', p: [[x, y, heading, speed, t]…]}`) — ego-frame
  samples: metres, radians, m/s, seconds from now. **v1 reduction**: the
  server reduces a trajectory to a speed setpoint taken from the earliest
  point with `t > 0` (falling back to the first point); negative speed
  flips the motion direction. Lateral tracking of the polyline is a v2
  concern — steering stays with the authored route logic.
- **control** (`{k: 'c', c: [throttle, brake, steer]}`) — low-level
  passthrough into the force-based vehicle backend (`dynamic-v1` physics;
  inert under `kinematic-v1`).

## Step frames

`policy.reset`'s `ob` and every `policy.act` result are the env-server's
existing compact step frame

```
{t, rw, term, trunc, sv, objs, bev, cw, terms}
```

extended with:

- `dl` (`policy.act` only): `{lim: deadlineMs|null, el: elapsedMs|null,
  miss: 0|1, ap: 'policy'|'repeat-last'|'zero-control'|'scripted'}`.
- `fb`: `null`, or a shared-memory frame-bundle reference (ShmBridge
  contract): `{shm, tick, cams: [[id, digest, off, len, w, h, fmt]…]}`
  where `digest` is CRC32 (IEEE) of the payload bytes as 8-char lowercase
  hex, `off` is the physical payload offset in the shm file (128-byte
  record header at `off - 128`), `len` is the row-padded payload length
  (`rowStride = len / height`, wgpu 256-byte row alignment), and `fmt` is
  `'rgba8' | 'depth32f' | 'carla-depth-bgra'`. Pixels never ride the wire.
  Production is wired through the `frameBundleProvider` seam of
  `registerPolicySession`.

## Recurrent state token

Opaque bytes owned entirely by the policy (e.g. packed RNN hidden state).
The server stores the most recent token per session and echoes it in every
`policy.act` response, so stateless rollout workers can hand an episode
across processes without a side channel. `policy.reset` clears it to zero
bytes. The server never inspects it and it never affects stepping.

## Reference runner

`adapters/policy-runner` (`simforge_policy_runner`) is the canonical
client: it spawns/attaches to an env-server, runs seeded episodes against
a scripted policy and a small PyTorch MLP, records per-step inference
timing and deadline misses, and writes an episode trace as JSONL. Each
record carries a `digest` of its deterministic fields (wall-clock timing is
excluded); the final line holds the chained episode digest — two runs with
the same seed and policy must match digests exactly.
