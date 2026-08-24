# Motion and physics truth contract

SimForge identifies executed motion semantics explicitly. New and
regenerated simulations with no `physics` field run `dynamic-v1`; omission
still preserves older input JSON and its content hash. Authors may explicitly
pin `kinematic-v1`, and an explicit selection is honored exactly:
`resolvePhysicsConfig` never rewrites a declared mode, so an input pinned to
`kinematic-v1` executes the route choreography and records `kinematic-v1`
provenance — no silent migration in either direction. Trace format v3 records the selected mode,
actual substep, engine build, and the digest of any per-actor vehicle-profile
overrides, plus per-tick collision impulse/count telemetry. OpenSCENARIO
exports retain the same provenance in SimForge properties/comments.

## Claims

`kinematic-v1` is deterministic route choreography. It supports scenario
timing, interactions, traffic controls, lane motion, criticality metrics, and
collision detection. It is not a force-based driving model and must not be
described as CARLA-like vehicle physics.

`dynamic-v1` denotes the default planar force-based backend. The mode name alone
does not establish CARLA parity. Claims are limited to the maneuvers that pass
the versioned golden suite in `fixtures/physics/golden-maneuvers.v1.json`.
Suspension, grade/camber, deformable damage, externally validated crash loads,
powertrain detail, and CARLA engine-level parity remain out of scope until each
has a reference-backed validation gate.

## Acceptance gates

- Determinism: byte-identical output over 10 independent runs and actor-order
  permutation.
- Non-contact convergence: 5 ms versus 2.5 ms final error no greater than 2 cm
  position, 0.05 m/s speed, and 0.1 degree yaw.
- Longitudinal: acceleration, coast, and 100–0 km/h braking within 10% of a
  declared, versioned reference.
- Lateral: steady skidpad response within 5%, step-steer yaw gain within 10%,
  and bounded sideslip according to the selected vehicle profile.
- Tire/surface: resultant tire force no greater than `mu * Fz + 2%`; stopping
  distance worsens monotonically as friction decreases; split-mu is evaluated
  per tire or axle.
- Collision response: swept OBB contact prevents high-speed tunneling; a
  deterministic planar sequential-impulse solver applies restitution, Coulomb
  friction, angular response, persistent-contact stabilization, and
  depenetration. Resting penetration is at most 2 cm in the acceptance fixture,
  and isolated impacts must not create momentum or energy. Impulse magnitude
  is telemetry, not a certified crash-load or damage prediction.
- Knockdown: a contact whose normal impulse implies a velocity change above
  `BALANCE_RECOVERY_DELTA_V_MPS` (0.6 m/s) takes a pedestrian, animal, or
  sidewalk robot off its feet. The threshold is a balance-recovery limit, not an
  injury or crash-load claim: below it a walker absorbs the shove and keeps its
  route, above it the agent stops steering, keeps the impulse the solver gave it,
  and slides to rest under a 0.55 sliding-friction coefficient. Drones are
  excluded. The state is monotonic within a clip — nothing stands a body back up
  — and is recorded as `downSinceS` on the actor track plus a `knocked_down`
  event carrying the impulse. Posture is not simulated: the engine stays planar
  and holds the yaw the body was struck with, so lying down is presentation
  derived from `downSinceS` in the browser renderer. The CARLA adapter drives
  walkers kinematically and does not present the posture yet, so a managed
  render shows the body sliding to rest upright while the trace, the metrics and
  the browser preview agree it is down. OpenSCENARIO carries the translation in the replay
  polyline and declares the time in a
  `uniscenarios.trajectoryReplay.knockedDownAtS.*` header property, because the
  standard has no element for a body on the ground.
- Performance: 10 dynamic actors for 20 simulated seconds in at most 1 second
  offline (at least 20x real time) on the declared benchmark machine.
- Existing baked OpenSCENARIO replay: position RMSE at most 0.1 m, position p95
  at most 0.2 m, and heading p95 at most 1 degree.

The validation library reports failed and not-run gates; absence of a result is
never interpreted as a pass. Reference values must come from declared external
measurements or pinned profiles, not from the implementation under test.

## Versioning and evidence

Adding `physics` to an older scenario is a material input change and therefore
changes its input hash. Merely parsing an older scenario does not add the field,
so its input hash stays stable. Regenerating it under engine 0.3.0 or newer uses
the current `dynamic-v1` default and records that fact. Immutable traces from
before 0.3.0 remain `kinematic-v1` on replay; validators accept that historical
pair only when the input omitted physics and the recorded solver predates the
migration. They report it as `legacy-kinematic`, never as dynamic. A new trace,
or any trace for an explicitly selected mode, must match exactly. This prevents
default changes from silently relabeling old evidence.

Engine 0.4.0 / trace format v3 is the collision-response provenance boundary.
Kinematic fallback actors are infinite-mass contact bodies: their authored
surface velocity affects dynamic actors, but contacts never displace them.
Static actors, props, and `map:*` collision proxies use the same policy with
zero surface velocity.
