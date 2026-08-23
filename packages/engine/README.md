# @simforge/engine

The default for new and regenerated simulation is the force-based `dynamic-v1`
backend. The deterministic `kinematic-v1` choreography model remains available
explicitly and remains the recorded mode for immutable legacy trace replay.
Both carry explicit trace provenance. Validation scope,
performance gates, and current non-claims are documented in
[`../../docs/physics-validation.md`](../../docs/physics-validation.md).

Layer 3 of `docs/agent-authoring-architecture.md`: the deterministic scenario
simulation engine. Pure TypeScript, `zod` for the input contract, **no rendering
dependency** — the editor preview and the headless CLI run this code byte for
byte, so there is no parity lane to maintain.

```ts
import {
  buildLaneGraph,
  parseSimScenarioInput,
  runSimulation,
  evaluateTrace,
} from '@simforge/engine';

const graph = buildLaneGraph(topologyIndexJson); // dev-assets/<map>/topology-index.json.gz
const input = parseSimScenarioInput(doc);
const { trace, issues, arrival } = runSimulation(input, { graph });
const verdict = evaluateTrace(trace); // 'accept' | 'reject' + findings
```

## The seam: `SimScenarioInput`

`SimScenarioInput` is a **fully resolved concrete scenario**. No logical
anchors, no parameter references, no expressions, no map queries — every actor
already has a pose, a route and numeric rules; every trigger already has numeric
thresholds. Producing one from a `ScenarioTemplate` v2 (site match + parameter
draw + expression evaluation) is the *adapter's* job, in another package. This
type is the stable target that adapter builds against.

```
SimScenarioInput
  schemaVersion, mapId, clipSeconds=20, warmupSeconds=5, dt=0.02, seed
  metricSubject?                       ← which actor the metrics are about
  actors[]      { id, kind: vehicle|pedestrian, dims{l,w,h},
                  initial { laneRef?{rsl,s,tFrac}, pose{x,z,headingRad}, speedMps },
                  behavior { rules{obeySignals,yield,collisionAvoidance,
                                   aggression,speedFactor},
                             route: RouteSpec, cruiseSpeedMps? },
                  presentAtStart, tags[] }
  interactions[]{ id, actorId, trigger, <verb>, dynamics?, until? }
  signalPrograms[]{ id, phases[{phase,durationS}], offsetS, loop,
                    stopLines[{rsl,s,connectingLaneRsls[]}],
                    mapBinding?{junctionId,controllerIds[],headIds[],timingSource} }
  occluders[]   { id, obb{center,lengthM,widthM,headingRad,heightM} }
```

**Seven verbs over five axes** (exactly the research doc's vocabulary):

| verb | axis | shape |
|---|---|---|
| `speed` | longitudinal | `target: absolute \| delta \| factor \| match \| stop` |
| `gap` | longitudinal | `target{actorId}, value, mode: time \| distance` |
| `changeLane` | lateral | `target: left \| right \| lane \| actorLane` |
| `laneOffset` | lateral | `target{mode: meters \| fraction, value}` |
| `route` | topology | `target: RouteSpec` |
| `exist` | existence | `target{state: present \| absent}` |
| `set` | discrete state | `target{key, value}` over the typed key registry |

`dynamics = {shape: step|linear|sinusoidal|cubic, constraint: rate|time|distance,
value}` is **mandatory** on every shaped verb — never defaulted.

**Triggers**: `at(t)` · `after(id, delayS)` · `when(condition, byLatest,
ifNever: skip|fire)` · `arrival({of, at, syncWith, ttc|deltaT})`. `byLatest` is
mandatory on `when`, because a condition that never fires is a silent bug.
Conditions: `distance` (alongLane|euclidean), `ttc`, `headway`, `reaches`
(circle | polygon | lane s-window), `speed`, `standstill`, `signal`, `collision`,
`visible(a, to: b)`, and shallow `and`/`or`/`not`.

**One axis, one owner; later preempts earlier.** A newly fired interaction
replaces whatever held its axis and emits a `preemption` event. No priorities,
no nesting. `set` owns one axis *per key*, so unrelated state writes coexist.

## Coordinate frames

The engine computes entirely in the **xodr-local** frame — `x` east, `y` north,
metres, headings CCW from `+x` — because that is the frame the topology index's
lane polylines already use, so route arc length and OBB overlap need no per-tick
transform.

| surface | frame |
|---|---|
| `SimScenarioInput` poses, points, occluder OBBs | **scene** `{x, z}` (y-up) |
| everything inside the engine | **xodr-local** `{x, y}` |
| `SimTrace.ticks` (`header.frame === 'xodr-local'`) | **xodr-local** `{x, y}` |

`scene = (x, 0, −y)`, and `headingRad` is numerically identical in both. Use
`localFromScene` / `toSceneXZ`, or `traceToSceneFrame(trace)` for a wholesale
conversion. See `src/frames.ts`.

## Lane graph: why orientation is derived

`topology-index.json.gz` stores lane polylines in geometric `s` order and its
`predecessors`/`successors` lists are effectively **undirected** — on
yale-street, 658 of 1534 links fail a naive "my last point is your first point"
test, and many lanes list the same neighbour in both arrays. So `LaneGraph`
works with directed lanes (`{rsl, reversed}`) and derives successors
*geometrically*: a neighbour qualifies when one of its admissible orientations
starts within `ENDPOINT_TOL_M` (0.5 m) of our exit point. Non-junction lanes are
pinned to their sign-implied OpenDRIVE direction so the walker cannot drive the
wrong way; junction connecting lanes are free, resolved by the approach they
were entered from. 93 % of yale-street's driving lanes get a directed successor;
the rest are genuine map-boundary dead ends.

## Trace

Gzipped canonical JSON, columnar per actor:

```
header  { engineVersion, inputHash, seed, mapId, topologyDigest, dt,
          clipSeconds, warmupSeconds, frame: 'xodr-local', actorIds[], metricSubject }
ticks   { t[], actors{ id → { x[], y[], headingRad[], speedMps[], laneRsl[], s[], present[] } } }
events  trigger_fired | trigger_skipped | preemption | released | lane_change |
        lane_change_rejected | collision | spawn | despawn | state_set
metrics { minTTC{value,t,pair}, minDistance[], requiredDecelMax{},
          revealToConflict?, collisions[], triggerNeverFired[],
          clippedCriticality, ticksSimulated }
```

Only `t ∈ [0, clipSeconds]` is recorded; the warm-up prologue is excluded by
construction, and the sample at `t = 0` *is* the prologue's final state.

## Determinism

Bit-identical traces for identical inputs, and identical traces for inputs that
differ only in declaration order. Enforced by: sorted iteration at every fan-out,
a plan/apply split so no actor reads a neighbour that has already stepped,
integer-indexed time (`t = (i − warmupTicks) · dt`, never accumulated), a seeded
xoshiro128\*\* instead of `Math.random`, and channel quantisation before
serialisation. `determinism.test.ts` proves all of it, including a source scan
that fails the build if `Math.random` or a wall-clock read appears anywhere in
`src/`.

## Performance

10 actors × 20 s at `dt = 20 ms` on yale-street geometry: **~75 ms per run**
(~13 300 recorded ticks/s, ~266× real time) on an M-series laptop. Build the
`LaneGraph` once and share it across runs.

## Default dynamic-v1 motion

`physics: { mode: 'dynamic-v1' }` explicitly pins the force-based motion
backend for forward `car` and generic `vehicle` actors. It uses deterministic
5 ms substeps by default and records body velocity, yaw rate, steering, wheel
speed, axle loads and tyre utilization alongside solver provenance. The
scenario layer still owns targets and safety decisions; a speed controller and
preview path tracker turn those targets into throttle, brake and steering.

This is one calibrated generic passenger-car model, not vehicle-specific
parameter identification and not a CARLA-equivalence claim. It has planar body
dynamics, actuator lag, aerodynamic/rolling resistance, quasi-static
longitudinal axle load transfer and combined-slip axle friction circles. It
does not yet model suspension, pitch/roll/heave, individual wheels, powertrain
gears, ABS/ESC, road grade or collision impulses. Collision detection and event
timing remain active, but contact does not alter velocity in this slice.

Omitting `physics` resolves to `dynamic-v1` from engine 0.3.0 onward. New and
regenerated editable products write that selection explicitly. Existing
verified evidence is replayed from its recorded provenance; `physics: {
mode: 'kinematic-v1' }` remains the explicit legacy pin, and its established
motion tracks do not pass through the dynamic backend.

## Deliberate simplifications

Stated plainly, because they bound what a metric from this engine means:

- **Kinematic-v1 has no tyre physics.** Vehicles are path followers with a bicycle-ish body slip
  (`heading = pathHeading + atan2(lateralRate, v)`) and per-class acceleration
  clamps. No yaw inertia, no load transfer, no friction circle.
- **TTC is the closing-speed form** (`gap / closing speed along the line of
  centres`) using circumscribed radii, not OBBs. Exact for rear-end and head-on
  geometries; conservative and slightly under-reporting for crossing ones. A
  true path-intersection TTC needs `map-intel`'s junction `conflictPairs`, which
  this package deliberately does not depend on.
- **`rules.yield` uses a coarse crossing-path scan** (14 samples at 5 m, 2.5 m
  proximity, 2.5 s arrival window, ignored below a 0.4 rad heading difference so
  car-following is not double-counted) rather than a precomputed conflict-point
  table. Enough to make junction behaviour sensible; not a substitute for the
  real table when that lands.
- **Line of sight is a 2-D ground-plane test.** Occluder heights are carried but
  unused — reveal-to-conflict is dominated by plan-view geometry, and a 3-D test
  would need render meshes.
- **The gap controller is a PD loop, not IDM.** Its equilibrium gap equals the
  commanded gap *exactly*, unlike IDM's `1/√(1−(v/v₀)⁴)` offset, which matters
  when a scenario declares "2.0 s headway" and a filter later checks it.
- **`lights.*`, `doors.*`, `pose.*`, `env.*` are recorded state only.** They
  land in `stateKeys` and the event log for the renderer and exporter; no
  controller consumes them yet.
- **`metrics.invariantResiduals` is typed but not populated** — invariants live
  in the template layer, so residual checking belongs to the adapter that knows
  what was declared.
- **The whole-clip runway guard applies to vehicles on lane routes only.**
  Pedestrians and freeform paths are *supposed* to finish mid-clip, and an actor
  the scenario explicitly despawns is exempt.
