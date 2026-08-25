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
 obs: {sv, bev, frameBundle},
 trajExec: 'pure-pursuit' | 'speed-setpoint'}
```

`trajExec` reports how this server executes trajectory actions (see
"Trajectory execution" below); it is a server construction option
(`registerPolicySession(server, {trajectoryExecution})`), default
`'pure-pursuit'`.

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

- **trajectory** (`{k: 't', p: [[x, y, heading, speed, t]…]}`) — samples in
  the **ego frame at plan issuance**: x forward along the ego heading, y
  left (90° CCW), heading relative to the ego yaw (radians), signed speed
  (m/s, negative = reverse), `t` seconds from issuance. Samples are
  strictly future (`t > 0`): the first point is *not* the current pose.
  This matches the Alpamayo adapter's "ego frame at t0" waypoint
  convention (FLU, z dropped; headings/speeds derived by the bridge from
  consecutive 10 Hz waypoints). Execution depends on the server's
  `trajExec` mode — see "Trajectory execution" below.
- **control** (`{k: 'c', c: [throttle, brake, steer]}`) — low-level
  passthrough into the force-based vehicle backend (`dynamic-v1` physics;
  inert under `kinematic-v1`).

## Trajectory execution

Under `trajExec: 'pure-pursuit'` (default) the server really tracks the
polyline; `'speed-setpoint'` keeps the v1 reduction for regression
comparability (target speed from the earliest `t > 0` sample, steering
stays with the authored route logic; step frames carry no `ex`).

Executor pipeline (`@simforge/engine` `sim/trajectory-follower.ts`, wired
in `policy-session.ts`):

1. **Anchoring.** A trajectory action whose points differ from the held
   plan is anchored to the world frame at the ego pose of the observation
   the act responds to (`anchorPlanToWorld`), and its issuance time is
   pinned there — the samples' `t` count from that instant.
2. **Zero-order hold.** Acts whose points are byte-identical to the held
   plan keep the original anchor. A 0.5 Hz replanner over 10 Hz decisions
   therefore resends the same points between replans; only a *different*
   plan re-anchors. `policy.reset` clears the held plan.
3. **Per-decision tracking.** Each act produces one engine action from the
   live pose: a pure-pursuit preview point + heading on the plan polyline
   (lookahead `clamp(2.5 m + 0.55 s · |v|, 2.5 m, 12 m)`), the
   time-indexed speed setpoint (piecewise-linear in plan `t`, clamped at
   the ends) and its slope as feedforward acceleration. Steering itself is
   the dynamic backend's calibrated bicycle controller — the preview
   override goes through the same steer clamp/rate/lag envelope as
   authored driving. Negative plan speeds flip the motion direction with
   the magnitude preserved.
4. **Projection.** Cross-track error is the signed lateral offset to the
   plan polyline (+left of the plan direction); the first and last
   segments project as open-ended rays so a pose behind the
   strictly-future first sample reads as along-track (negative), not
   lateral, error.

Every trajectory-executed step frame carries `ex`:

```
{x, y, h, v,            ego pose + travel speed the command was computed from
 ct, at, age,           signed cross-track (m, +left), along-track (m), plan age (s)
 sp, ax, dir,           applied speed setpoint, feedforward accel, direction
 px, py, ph}            pure-pursuit preview point + heading (world frame)
```

Determinism is inherited: the executor is a pure function of the plan and
pose stream, so the same seed and action sequence yields byte-identical
responses (`trajectory-executor.test.ts` digests two episodes).

### Tracking bounds

Measured on the fixed-step dynamic-v1 sim (50 Hz engine, 10 Hz decisions,
0.5 Hz scripted replans, S-curve amplitude 1.5 m / period 10 s at 8 m/s;
`packages/training-env/src/__tests__/trajectory-executor.test.ts`):

| metric                                   | measured        | documented bound |
|------------------------------------------|-----------------|------------------|
| abs cross-track error (after 1 s settle) | p50 0.14 m, p95 0.24 m, max 0.29 m | ≤ 0.35 m |
| speed-setpoint jump at plan swap         | ≤ 0.02 m/s      | ≤ 0.5 m/s |
| preview-heading jump at plan swap        | ≤ 0.01 rad      | ≤ 0.15 rad |

Bounds are for plans within the calibrated envelope (lateral accel well
under the profile's limit; the fixture curve peaks at ~0.6 m/s²). Sharper
plans track with proportionally larger corner-cutting error — pure pursuit
cuts inside a curve by roughly `Ld²/2R`.


## Step frames

`policy.reset`'s `ob` and every `policy.act` result are the env-server's
existing compact step frame

```
{t, rw, term, trunc, sv, objs, bev, cw, terms}
```

extended with:

- `dl` (`policy.act` only): `{lim: deadlineMs|null, el: elapsedMs|null,
  miss: 0|1, ap: 'policy'|'repeat-last'|'zero-control'|'scripted'}`.
- `ex` (`policy.act` only, `trajExec: 'pure-pursuit'` trajectory steps
  only): executor telemetry — pose, cross-track/along-track, applied
  setpoints and preview point (see "Trajectory execution").
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
scripted control and scripted-trajectory policies and a small PyTorch MLP,
records per-step inference timing and deadline misses, and writes an
episode trace as JSONL. Each record carries the deterministic step fields
— including the wire action, the policy's per-act `reasoning` text and the
`ex` executor telemetry — plus a `digest`: a SHA-256 chained over the
canonical JSON of every deterministic record so far (wall-clock timing is
excluded). The final line holds the chained episode digest — two runs with
the same seed and policy must match digests exactly.
