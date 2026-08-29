# Ego driver policy boundary

The ego driver is an executor policy, not scenario content. A scripted driver,
a differently tuned profile, and an external AV stack must be interchangeable
behind one narrow boundary:

```text
Percept -> DriverPolicy.decide(percept) -> DriverCommand
```

This boundary is also the system-under-test boundary. The execution package
describes the world; it must not embed a reactive driver.

## Contract

`Percept` is the only input a policy may inspect. It contains only facts available
to the ego on the current tick:

- line-of-sight-filtered `visibleActors`, including first-visible time;
- own-lane, adjacent-lane, and shoulder context, with positive occupancy and
  clearance facts rather than absence-of-evidence guesses;
- lead-vehicle range, closing speed, speed, and measured deceleration; and
- the ego state needed to produce a command.

A policy that reaches around the percept into the simulator actor list, scenario
document, or runtime API violates the boundary.

`DriverCommand` carries target speed, requested deceleration, lateral offset, and
a machine-checkable `reason`. The reason is authored at decision time; narration
and evaluation must not infer a cause after the fact.

`EgoProfile` is data separate from policy code:

| field | meaning |
| --- | --- |
| `comfortDecelMps2` | ordinary braking authority |
| `hardDecelMps2` | emergency braking authority |
| `reactionTimeS` | recognition-to-action delay |
| `stopGapM` | bumper-relative stopped gap |
| `allowSwerve` | whether lateral avoidance is available |
| `swerveRequiresClearLane` | require affirmative adjacent-lane or shoulder clearance |
| `followHeadwayS` | normal following headway |

`DriverPolicy` has one operation, `decide(percept) -> DriverCommand`. The built-in
scripted policy consumes an `EgoProfile`; an external AV adapter implements the
same operation without acquiring a second input channel.

## Required behavior

- A gradually slowing lead, or a lead stopped with ample distance, causes early
  comfortable braking. Lead deceleration and closing speed participate in the
  decision; actor kind alone is insufficient.
- A suddenly stopping lead invokes the non-collision priority: hard braking and,
  only when a positively clear adjacent lane or shoulder is known, a swerve.
  Uncertain clearance always falls back to braking.
- A pedestrian visible well before entering the path receives a human reaction
  delay and gradual braking where distance permits.
- A pedestrian newly acquired at short range after geometric occlusion receives
  hard braking or a positively gated swerve.

Occlusion is not a scene-name flag or policy special case. “Emerged from
occlusion” means that the actor entered `visibleActors` less than one
`reactionTimeS` ago. Plan-view oriented bounds are the baseline visibility
geometry; a short reacquisition grace window should prevent a one-tick visibility
flicker from resetting first-visible time.

`stopGapM` is always bumper-relative. Any migration from center-to-center legacy
values must convert using actor dimensions rather than silently reusing the
number.

## OSS implementation state

The OSS engine already owns several pieces of the eventual percept:

- `src/sim/visibility.ts` performs geometric line-of-sight checks against
  oriented occluders.
- `visible` trigger conditions use that geometry and the operational visibility
  range.
- The perception runtime exposes sensor-aware `detected` conditions; atmosphere,
  optics, and occlusion can therefore delay an authored brake interaction.
- Actor driver data and controller limits contain headway, reaction time,
  comfortable deceleration, and hard-brake authority.

The engine does **not** currently expose `Percept`, `DriverCommand`,
`EgoProfile`, or `DriverPolicy`. Ego avoidance remains authored as scenario
interactions and controller targets. The ambient-driver configuration is not the
swappable ego boundary described here, and must not be presented as one.

## TODO: policy implementation

This mechanism still lives in executor/product code. Land it in OSS in four
separable steps:

1. Assemble a read-only percept with no behavior change.
2. Route the existing scripted behavior through `DriverPolicy`, preserving output
   byte-for-byte and converting legacy stop-gap units.
3. Change only the built-in policy to satisfy the braking and visibility rules
   above, with a validation campaign for the behavioral change.
4. Add alternate profiles and external AV adapters.

Steps 1 and 2 are boundary refactors and require exact trace/golden equality.
Do not combine them with the behavior change: a diff during extraction is the
signal that behavior still leaks around the percept.
