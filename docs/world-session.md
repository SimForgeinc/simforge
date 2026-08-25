# World-Session Server v1

Multi-client world sessions over the fixed-step engine: arbitrary runtime
spawn/despawn, atomic batches, single tick ownership, and log-replay
determinism. Lives in `packages/training-env` (`world-session.ts`,
`session-registry.ts`); reachable over the env-server wire as the `world.*`
op family through the extension seam (`EnvServer.registerOp`).

## Model: world state is a pure function of the command log

The engine has no runtime-mutation surface — actors are authored in
`SimScenarioInput`, and mid-clip presence is expressed with
`presentAtStart: false` plus `exist` interactions. A `WorldSession` therefore
treats the canonical input as its only mutable state:

1. A structural command (spawn/despawn/batch) produces a **candidate input**:
   new actor specs plus `exist` interactions anchored `at` the current tick
   boundary time.
2. The candidate is validated through engine entry points only (see below).
3. On acceptance the session swaps the canonical input and **rebuilds** the
   simulation from `t = -warmup`, re-advancing to the current tick. The engine
   is deterministic, so every pre-existing actor reproduces its exact state —
   guarded by the bit-identity test in `world-session.test.ts`.

Nothing in the engine is forked. The entry points used:

| Concern | Engine surface |
|---|---|
| Actor kind catalog + dims | `ACTOR_KINDS`, `DEFAULT_ACTOR_DIMS`, `parseSimScenarioInput` |
| Ground snap | `LaneGraph.nearestLane` → `nominalReversed` → `sampleDirected` (lane tangent heading) |
| Pose validation | `checkFeasibility` (routes, lanes, t=0 guards) + `obbOverlap` against the **current** snapshot (feasibility only covers t = 0 placement) |
| Presence | `exist` interactions; spawn/despawn events land in the trace/event stream as usual |
| Actions | `ActionHook` (zero-order-hold timeline per actor) |

## Roles

| Role | Rights |
|---|---|
| `tick-owner` | everything below, **plus** `advance` — exactly one per world |
| `actor-controller` | queue commands: `spawn`, `despawn`, `batch`, `act` |
| `observer` | read-only: `snapshot`, `log` |

Tick ownership: the world's creator takes it by default; a second `join` as
`tick-owner` is refused; the owner leaving vacates ownership (time halts) and
any remaining member may `claim` it.

## Ordering

No command mutates the world at submission time — **every** command queues,
including the tick-owner's own. The owner's `advance` defines the tick
boundary: the queue is drained and applied in **client id ascending, then
per-client seq ascending** order (client ids are registry-allocated and
zero-padded, so lexicographic = allocation order). Then the engine advances
the requested ticks. Per-command outcomes come back on the advance result in
applied order; rejected commands are recorded too.

## Spawn / despawn / batch

`SpawnRequest` needs only `kind` and a scene-frame `pose`; defaults are
engine-derived: dims from `DEFAULT_ACTOR_DIMS`, lane snap for road kinds
(nearest drivable lane within 25 m — no lane is a rejection), heading from the
snapped lane tangent, a `follow` route from the snapped lane (non-road kinds
hold position on a zero-length `polyline`). Allocated actor ids are `ws:NNNN`,
monotonic per world, committed only when the command commits — so ids are
stable under replay and a rejected batch consumes nothing.

A `batch` is atomic: every op is resolved and validated against the same
candidate (spawns see earlier in-batch spawns for overlap and despawns for
liveness); the first invalid op rejects the whole batch and the world stays
byte-identical (digest included). Rejection reasons: unknown kind, id in use,
no lane in snap reach, OBB overlap with a present actor at the current tick,
despawn of a non-present actor, schema parse failure, or an error-severity
`checkFeasibility` issue attributable to the batch's actors.

Despawn adds an `exist(absent)` interaction at the boundary: the engine flips
`present`, emits a `despawn` event (reason `interaction`), and every frame of
the trace/digest carries the presence truth.

## Determinism, digest, replay

Every live engine tick at `tS >= 0` is hashed: chained SHA-256 (engine
`sha256`/`canonicalJson`) over `[tickIndex, tS, rows]` with actor rows sorted
by id, seeded with the base-input content hash. Catch-up ticks replayed
during a rebuild are **not** re-hashed — the digest covers frames as first
observed, and a replay rebuilds at the same boundaries, so the hashed frame
sequence is identical by construction.

The session log is the artifact (`WorldSessionLog`, version 1):
`baseInputHash` (content hash of the normalized base input), `horizonSeconds`,
the ordered entries (commands with client id, seq and recorded outcome —
including rejections — interleaved with `advance` entries), and the digest.
`replayWorldSessionLog(log, {input, graph})` re-executes the log against the
same base input and returns the digest plus outcome-match verdict; the
determinism contract is `replayed.digest === log.digest`.

## Wire ops (`world.*`)

Registered via `registerWorldOps(server, episodes)` on the env-server
extension seam. Compact keys per wire convention (`w` world, `c` client,
`n` ticks):

| Op | Request | Reply |
|---|---|---|
| `world.create` | `e?` episode, `horizonS?`, `role?` | `{worldId, clientId, role}` |
| `world.join` | `w`, `role?` (default observer) | `{clientId, role}` |
| `world.leave` | `w`, `c` | `{left: true}` |
| `world.claim` | `w`, `c` | `{tickOwner: true}` |
| `world.cmd` | `w`, `c`, `cmd` (WorldCommand) | `{seq}` |
| `world.advance` | `w`, `c`, `n?` (default 1) | `{tS, tick, done, events, actors, results}` |
| `world.snapshot` | `w`, `c` | `WorldSnapshot` |
| `world.log` | `w`, `c` | `WorldSessionLog` |

Handler throws surface as the standard `{ok: 0, e}` reply; payloads are
zod-validated at the boundary.

## Known v1 limits

- Structural commands rebuild + replay the engine (O(elapsed ticks) each).
  Fine for training-scale sessions; a checkpoint/restore engine seam would
  remove the replay cost if it ever dominates.
- A spawned-then-not-yet-advanced actor is not yet `present`, so it cannot be
  despawned at the same boundary by a *later separate command* (in-batch
  spawn+despawn works).
- The world horizon (`horizonSeconds`, default 120 s) fixes the engine clip
  at construction; `done` worlds accept commands but time no longer advances.
