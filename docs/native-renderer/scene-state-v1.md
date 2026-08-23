# scene-state.v1 — scene description contract

Status: v1 frozen 2026-08-22 (WSB2). One schema for both ingestion modes:
**trace playback** (`trace.json.gz` → per-tick transforms, dataset
generation) and **live** (msgpack scene-diff stream from the env-server,
closed loop). Wire formats: JSON (files, hashing) and msgpack (streams); the
field names are identical in both.

- Schema (zod, executable): `packages/scene-state/src/schema.ts`
- Emitter trace → document: `packages/scene-state/src/emit.ts`
  (`tsx packages/scene-state/src/cli.ts <trace.json.gz> <out.json>`)
- Rust consumer types: `native/render-core/src/scene_state.rs`

## Document

| field | type | notes |
|---|---|---|
| `version` | `"scene-state.v1"` | literal |
| `mapId` | string | e.g. `yale-street` |
| `frame` | `"scene-yup"` | y-up scene frame |
| `dt` / `tickHz` / `tickCount` | number | playback cadence |
| `weather` | `{preset: clear\|fog\|rain\|night, fogDensity, rainIntensity, wetness}` | drives the WSB4 weather ladder |
| `timeOfDay` | number | hours [0, 24) |
| `profile` | `sensor \| cinematic` | render profile intent (default `sensor`) |
| `groundY` | number \| null | road-surface elevation hint when known |
| `actors` | `ActorDesc[]` | static identity/geometry bindings |
| `frames` | `Frame[]` | per-tick records |

## ActorDesc

`{id, catalogId, actorClass, dims?, color?}` — `catalogId` is a prop-catalog
entry (`vehicle.sedan`, `pedestrian.adult`, …). Traces tag actors with
`catalog:<id>`; untagged actors fall back to deterministic class defaults so
browser and native bind identical geometry.

## Frame / actor tick record

```
{tick: u32, t: f64, actors: [{
  id, kind: spawn|update|despawn,
  position: [x, groundY?, z],        // f32 metres
  rotation: [qx, qy, qz, qw],        // yaw about +Y expanded to quaternion
  yawRad,                            // redundant exact heading
  velocity: [vx, vy, vz],            // m/s world frame = speed × heading
}]}
```

Frame conventions (from `packages/sim-engine/src/frames.ts`):
`scene = (x_local, height, −y_local)`; headings are numerically identical.
Velocity is the engine's integrated forward-speed × heading vector, **not** a
finite difference, so motion-vector ground truth matches solver state.

### Spawn/despawn semantics

Derived from the trace `present` channel transitions (0/1 or bool):

- first tick present after absent/never-present → `spawn`
- last tick present before absent → `despawn` (carries the final pose;
  consumers remove the instance after applying it)
- otherwise → `update`

An actor that never despawns emits exactly one leading `spawn`.

## Determinism notes

Emitted floats are quantised to 6 decimals; actor ids are sorted; the same
trace bytes always produce the same document bytes (JSON key order follows the
schema declaration order).
