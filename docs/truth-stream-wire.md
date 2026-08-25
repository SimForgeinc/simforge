# World-session truth stream wire

Status: **frozen**. Downstream V2X consumers may depend on the field names, coordinate frames, framing, and ordering below. This is the SimForge world-session truth side-channel; it is not the V2X product WebSocket protocol.

## Transport framing

Each committed engine tick is one frame:

```text
+----------------------+----------------------------------+
| payloadBytes: u32 LE | msgpack(TruthFrame)              |
+----------------------+----------------------------------+
        4 bytes                    payloadBytes
```

`payloadBytes` counts only the MessagePack payload. A transport may split or coalesce these bytes arbitrarily. `TruthStreamClient.push(chunk)` incrementally reconstructs frames. A payload larger than 64 MiB is rejected by the client helper. There is no JSON envelope, operation discriminator, sequence wrapper, or server-side pixel payload.

## Frozen `TruthFrame` schema

```ts
interface TruthFrame {
  tick: number;
  timeSec: number;
  scene: SceneFrame; // frozen scene-state.v1 frame
  signals: SignalSnapshot[];
  actors: Array<{
    id: string;
    class: 'car' | 'truck' | 'bus' | 'motorcycle' | 'bicycle' | 'pedestrian' | 'prop';
    dims: { l: number; w: number; h: number };
    accel: { ax: number; ay: number };
  }>;
}
```

No field is optional.

### Top-level fields

| Field | Meaning |
| --- | --- |
| `tick` | Authoritative engine tick index. It includes engine warm-up in the same way as `EngineTickObservation.tickIndex`; a subscription does not renumber it. |
| `timeSec` | Authoritative simulation time in seconds for `tick`, quantized to six decimal places. No wall-clock value is emitted. |
| `scene` | One unmodified `scene-state.v1` `SceneFrame`: `{tick, t, actors}`. `scene.tick === tick` and `scene.t === timeSec`. |
| `signals` | Full `signalSnapshotAt(t)` projection for every signal program, ordered by `signalId`. It includes physical head/controller/junction identity, phase, timing source, phase boundaries, remaining ticks, next phase, cycle length, and any failure state. |
| `actors` | Per-record static identity/dimensions plus acceleration. Entries have the same actor-id order and membership as `scene.actors`. |

### Scene frame

`scene` uses the frozen scene-state.v1 y-up frame:

```ts
interface SceneFrame {
  tick: number;
  t: number;
  actors: Array<{
    id: string;
    kind: 'spawn' | 'update' | 'despawn';
    position: [x, groundY, z];
    rotation: [x, y, z, w];
    yawRad: number;
    velocity: [vx, vy, vz];
    acceleration: [ax, ay, az];
  }>;
}
```

Positions and vectors convert the engine's XODR-local ground plane as scene `x = local x`, scene `z = -local y`, with `groundY = 0`. Every present actor appears on every tick. The first present observation is `spawn`, continued presence is `update`, and the present-to-absent transition is `despawn` with its terminal transform. Actors absent both before and after the tick do not appear. Actor records are ordered by stable actor id.

`actors[].class` is the scene-state render class derived from the authored actor kind. `actors[].dims` is the actor's static `{l,w,h}` catalog/spawn dimension record in metres; it is not inferred from a mesh.

Acceleration is a backward velocity difference, not a wall-clock estimate and not a renderer estimate. For actor $i$ on tick $n$ in the XODR-local ground plane,

$$
(a_x,a_y)_{i,n} = \frac{(v_x,v_y)_{i,n} - (v_x,v_y)_{i,n-1}}{\Delta t}.
$$

A spawn has zero acceleration because it has no continuous prior sample. History is discarded on despawn. `actors[].accel` carries the XODR-local `(ax, ay)` pair. `scene.actors[].acceleration` carries the same value converted to scene y-up coordinates as `[ax, 0, -ay]`. Numeric scene and acceleration values are quantized to six decimal places before encoding.

## Ordering and atomicity

A world command batch commits at a tick boundary before advancement. For every subsequent engine tick, the world session obtains one immutable engine observation, composes scene actors, signal snapshots, actor metadata, and acceleration from that same observation/time, encodes the complete `TruthFrame` once, and only then enqueues the same framed bytes to all subscribers. A consumer can therefore never observe tick-$n$ actor state with tick-$n\pm1$ signals. Truth publication is observational and does not change engine order, session logs, or digests.

Frames within a subscription are in increasing committed-tick order except for explicitly accounted drops. Two subscribers active for the same ticks receive byte-identical frames. Identical scenario input and command/advance history produce byte-identical framed streams.

A subscription starts with the next committed tick; it does not replay history. That tick contains every currently present actor and therefore a complete authoritative pose/velocity set. Unsubscribing discards that subscriber's pending queue and has no world-side effect.

## Backpressure

`WorldSession.subscribeTruth({capacity})` and `WorldRegistry.subscribeTruth(worldId, clientId, {capacity})` return a pull-based `TruthSubscription`. The default capacity is 256 complete frames. Capacity is a positive integer and is fixed for the subscription.

The engine tick path never calls consumer code and never waits for transport I/O. It only enqueues the already encoded immutable byte array. When a queue is full, enqueue discards the **oldest** pending frame and increments that subscription's cumulative drop counter. `subscription.stats()` returns exactly:

```ts
{ queued: number, dropped: number }
```

`dropped` never decreases during the subscription. `read()` removes one oldest complete framed message or returns `null`; `drain()` removes all queued messages in tick order. The drop counter is subscription-local and deliberately is not added to `TruthFrame`, preserving byte identity across concurrent subscribers. A transport adapter must expose or monitor this counter as its explicit loss accounting; it must not stall world advancement to recover a dropped frame.
