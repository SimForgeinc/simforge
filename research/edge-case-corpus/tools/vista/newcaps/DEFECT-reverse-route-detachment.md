# DEFECT: a reversing actor detaches from its route under the default physics backend

**Package:** `packages/engine` (`sim/dynamic-v1.ts`, `sim/engine.ts`)
**Severity:** silent — produces confidently wrong trajectories, no error, no warning
**Status:** fixed on branch `vista-lane` by `caps-reverse`; recorded here because the root cause is a
general physics error independent of the reverse *authoring* feature.

## Symptom

Every reverse manoeuvre the corpus could express was unusable. Measured across 1642 gate-passing
cells, exactly ONE body ever moved more than 0.8 m backwards.

Running the repo's own worked example — `examples/mechanisms/parking-transit/backing-out-vehicle.template.json`,
5 maps x 3 sites x 2 draws = 30 cells — every single cell showed:

| observation | value |
|---|---|
| `ticks.actors['backing-vehicle'].s` | pinned at `0.0001` for all 601 ticks |
| `ticks.actors['backing-vehicle'].laneRsl` | `null` for all 601 ticks |
| straight-line rear-ward translation | 8.9 – 17.8 m, off the end of a **6 m** authored polyline |
| batch verdict | 30/30 `reject`, `band: invariant` |
| findings | `no_interaction`, `invariant_unchecked: no TTC was recorded for ego/backing-vehicle` |

The body was not following its route at all. It backed away in a straight line, ignored the path the
author drew, never bound to a lane, and therefore never produced a TTC with the ego — so no gate could
ever pass a reversing scenario.

## Two independent root causes

### 1. The tyre model ignores direction of travel (the real one)

`sim/dynamic-v1.ts`, front-tyre slip angle:

```ts
const speedForSlip = Math.max(Math.abs(s.longitudinalVelocityMps), 0.75);
const frontSlip = Math.atan2(s.lateralVelocityMps + lf * s.yawRateRadps, speedForSlip)
  - s.steerRad;                                    // <-- unsigned
```

A tyre is symmetric. The lateral slip velocity a steer angle `d` produces at the contact patch is
`-u * sin(d)`, which **changes sign with `u`**. Dropping that sign makes a reversing vehicle yaw the
*opposite* way to the steering command.

Consequence: the pure-pursuit controller's correction becomes positive feedback. Measured on a
straight 8.5 m escape path, a car backing out with a 0.24 m initial cross-track error:

```
 t     s      heading   lateral   steer
0.50   0.19    2.347    -0.225   -0.087
1.50   2.03    2.257    -0.175   -0.201
2.50   4.06    1.985    -0.184   -0.552
3.50   6.08    1.505    -0.705   -0.580   <- steer saturated
4.00   6.86    1.287    -1.239   -0.580   <- road_departure_prevented, actor retired
```

The steer runs monotonically to the stop and the body peels off the path, yawing 61 degrees. With the
sign restored (`- direction * s.steerRad`) the same manoeuvre converges: cross-track goes
-0.237 -> +0.022 m, heading returns to its starting value, and the car runs the full path.

Forward motion is bit-identical — `direction` is `+1` — and the whole 43-file sim-engine suite passes
unchanged.

### 2. The two backends disagree about what a route MEANS for a reversing actor

- `kinematic-v1` recomputes heading as `routeTangent + PI` every tick, so the body traverses the route
  forward and faces backwards. Correct.
- `dynamic-v1` integrates its own yaw from the **authored spawn pose**, which for these roles equals
  the route tangent, *not* tangent + PI. `controlFor` then computes `trackingYaw = yaw + PI` — so
  tracking starts 180 degrees out, steering saturates immediately, and the actor never recovers.

This is worth stating plainly on its own: **two motion backends silently disagreeing about the meaning
of an input is exactly the class of thing that produces confidently wrong training data.** The
kinematic path had a passing test. The default path had none, and was broken.

The fix makes the invariant explicit and shared: *the route is the path the body travels*; a reversing
body traverses it rear-first, so `heading == routeTangent + PI` and `routeS` still advances. A spawn
heading that contradicts the declared gear is corrected and reported as
`reverse_spawn_heading_adjusted` rather than silently obeyed.

## Why nobody found it

The capability existed. `motion:reverse` was implemented, wired through the materializer, exported by
the ASAM writers, and covered by a passing engine test — against `kinematic-v1`, which is not the
default. The only authoring surface was an untyped `role.extensions.motionSemantics` string that
appears in none of the three published JSON Schemas, so almost nobody wrote one; and the few who did
got 30/30 rejected cells with a finding (`no_interaction`) that pointed at the scenario rather than at
the engine.
