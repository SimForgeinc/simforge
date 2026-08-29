# Conflict timing against an unreactive ego

Conflict timing and ego avoidance are independent authoring problems. A conflict
actor's schedule is solved against an ego that does not react; the ego's avoidance
is authored afterward through the driver-policy boundary. An executor must run the
authored schedule without a kerb hold, release condition, or runtime clock rewrite.

## Why the solve excludes reaction

Solving against a reactive ego is circular. The conflict actor's release time
changes when the ego first perceives it; perception changes when and how strongly
the ego brakes; braking changes the ego arrival time that the release solver was
trying to match.

Against an unreactive ego, route, speed profile, conflict point, and arrival time
are fixed at emit time. The compiler can therefore stage the encounter in closed
form. The policy can later brake or swerve without moving the staged actor's clock.
Swapping the policy changes the avoidance outcome, not the world schedule.

The authoring sequence is:

1. Find a genuine path intersection and solve the conflict actor's timed path so
   it would contact the unreactive ego.
2. Author ego braking or positively gated swerving, triggered by geometric
   visibility or sensor detection of that actor.
3. Mark the conflict schedule as authored at the executor boundary.
4. Execute both timed-path copies consistently and leave their clock untouched.

A product executor with multiple legacy hold paths must use one explicit authored-
timing fact in every path. Half-disabling one maintainer is incorrect. Rewriting a
proximity trigger into a time trigger is also incorrect: it changes export
semantics and can leave a second maintainer armed.

## Tuning controls at executor boundaries

These compatibility knobs exist in the platform executor and are documented here
so their semantics have one owner:

| variable | behavior |
| --- | --- |
| `SIMFORGE_UNREACTIVE_CONFLICT_TIMING=0` | A/B escape hatch that restores legacy reactive release timing. New execution should leave unreactive authored timing enabled. |
| `SIMFORGE_UE5_WALKER_STEPOFF_DELAY_S` | Legacy fixed walker step-off delay; platform default is `1.0` s. It must not apply to an authored conflict schedule. |
| `SIMFORGE_UE5_WALKER_ACCEL_MPS2` | Walker acceleration used when interpreting step-off latency; platform default is `1.5` m/s². It affects the distance lost during acceleration but must not become a second schedule clock. |

The fixed step-off delay and an acceleration ramp can add roughly 1.36 s of bias,
which is wider than a typical conflict window. An authored-timing marker must
therefore bypass both the closed-loop hold and the legacy fixed delay. If a target
runtime has genuine actuator latency, calibrate it as motion behavior or probe it;
do not silently shift the authored clock.

When iterative correction is required, use a lever the executor actually honors.
For timed-path ego motion, shifting schedule timestamps may leave physical arrival
unchanged. A bounded speed scale is monotonic and observable; stop when the achieved
arrival change is less than one third of the requested change. Keep the scale above
`0.7` of authored ego speed, because a larger change alters the scenario rather than
retiming it. A hold has more authority but introduces stop-and-reaccelerate behavior
and is not equivalent to a delay.

## Validation: both claims are required

A conflict-avoidance scene makes two separate claims.

### Staging claim

Remove only the ego reaction and rerun. The unreactive ego must contact the named
staged actor. A miss means no collision course was authored. Contact evidence must
name the subject and staged actor; ambient-to-ambient contact is irrelevant.

For collision cells, judge pre-impact quantities: named contact, contact time, and
conflict lead. Whole-run minimum distance is contaminated by post-impact motion.

### Avoidance claim

Restore the reaction. At brake onset the staged actor must be ahead, closing, and
the nearest genuine hazard, and the encounter must have a meaningful margin. A
stationary kerbside occluder is not a rival in-path hazard unless it is actually in
the ego lane. Anchor causality to when the staged actor first enters the path, then
select the braking episode that begins before that encounter; choosing the last
braking episode can attribute a later stop to the wrong cause.

`conflictLeadS` is not an avoidance score. Successful yielding intentionally makes
the conflict actor arrive early, producing a large negative lead. Use causal
attribution and clearance margin for avoidance cells. A safe stop six or seven
metres away can still be too weak as an authored near-miss; target a chosen minimum
gap when scene criticality requires it.

## OSS implementation state

The OSS compiler and engine preserve authored actor schedules and already warn in
materialization/ambient settling code that advancing the ego or challenger during
warm-up destroys conflict timing. The OSS engine has no duplicate walker kerb-hold
maintainers and does not read the three executor environment variables above.
Visibility- and detection-triggered interactions can author the reaction separately
from the conflict actor's schedule.

There is no OSS `authored_conflict_timing` execution flag or unreactive conflict
solver API today. The platform scenario generator and CARLA executor still own the
specialized marker, probe loop, and compatibility knobs.

## TODO: portable conflict staging

Extract a typed compiler operation that solves and marks an authored conflict
against an unreactive ego, plus an executor capability that promises not to rewrite
that schedule. Its acceptance gate must run the paired staging and avoidance checks
above. Do not port legacy hold maintainers into OSS merely to support the marker;
the OSS runtime's current authored-schedule behavior is the desired end state.
