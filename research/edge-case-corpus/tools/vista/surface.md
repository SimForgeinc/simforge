# The authoring surface (frozen)

You author a **portable ScenarioTemplate v2**: a predicate over road structure plus a cast and a
timeline. It contains **no coordinates, no road ids, no map names**. It is matched onto many real
sites on five maps you have never seen. If it only works at one place, it is worthless.

## Emission contract
Reply with **ONE JSON object only** — the complete template. No prose, no markdown fence, no commentary.

## Top level
`scenarioVersion` (=2), `meta`, `params`, `environment`, `anchor`, `roles`, `props`, `choreography`,
`invariants`, `variants` (=[]), `metricSubject` (="ego").

`meta`: {name, description, createdAt, modifiedAt (ISO, modifiedAt >= createdAt), appVersion:"simforge/0.0.1",
archetype, tags[], author, negativeControl:false}

## anchor — the predicate over road structure
`{id, corridor{}, features[], policy{}}`. Every clause is `{value, essentiality, weight?}` with
essentiality `required` (pass/fail) | `preferred` | `cosmetic` (scored, droppable). Ranges are `[min,max]`,
`null` = open end.

`corridor` keys (all optional):
  throughLanesSameDir, throughLanesOpposing ([0,0] asserts one-way), laneWidthM, speedLimitKph,
  runwayUpstreamM, runwayDownstreamM, curvatureDegPer10m, gradePct,
  requiresAdjacent / forbidsAdjacent (list of: parking|bike|sidewalk|shoulder|median|bus|rail|none),
  laneChangeLegal {side, sRange}

`features[]` — ordered along the corridor by `atM` (metres from frame origin, negative = upstream).
Common fields: {id, kind, atM, lateralDistanceM, sameRoad, side, essentiality, weight, label}.
  kind `junction`: arms, control ([signalized|all_way_stop|minor_stop|yield|uncontrolled|roundabout]),
      egoTurn ([left|right|straight|uturn]), sizeM, hasCrossingOnLeg,
      **conflictingApproach {from: opposing|from_left|from_right|same|merge, turn, crossingAngleDeg}**
      — the highest-value clause in the schema; it is what keeps a left-turn-across-path scenario a
      left-turn-across-path scenario on a junction that has never heard of it.
  kind `crossing`: marked, controlled, lengthM, placement (junction_leg|midblock|either)
  kind `parking_zone`: orientation (parallel|angled|perpendicular), capacity, occupancy, lengthM
  kinds with position only: merge, diverge, lane_drop, driveway, bus_stop, school_zone,
      work_zone_suitable, occlusion_zone, crest, curve, rail_crossing

`policy`: {allowMirror, maxSitesPerMap, diversity: strict|moderate|off, minScore}

## roles[] — the cast, bound to structure not to coordinates
Every pose is a FramePose `{laneOffset, s, tFrac, headingOffsetRad}` in the matched frame:
  `laneOffset` signed same-direction lane index; 0 = reference lane, +1 one lane LEFT, -1 one lane RIGHT.
  `s` arc length along the reference path from the frame origin, metres. **May be an expression.**
  `tFrac` lateral offset **as a fraction of local lane width** (-1 = right edge, 0 = centre, +1 = left edge).
  `headingOffsetRad` yaw relative to the lane tangent (use `3.14159` for facing backwards/oncoming).

Role `kind` (choose per role): `on_reference`, `lane_offset`, `opposing`, `at_lane_drop`,
`conflicting_gate` (names a junction MOVEMENT {from, turn} rather than a position — the solver places the
actor by backing up from the precomputed conflict point, which is how arrival criticality survives
retargeting), `on_crossing`, `in_parking_zone`, `relative_to` (`{ref, dsM, dLane, tFrac, headingOffsetRad}`).

Each role: {id, kind, label, actor{class, catalogId, static?}, essentiality, pose|binding fields,
initialSpeedKph (number or expression)}.
`actor.class`: car|truck|bus|van|motorcycle|bicycle|pedestrian|scooter|animal|static_object
`actor.static:true` = parked/stopped context actor: collides and occludes but is NOT a metric participant.
The ego role MUST have id `ego`.

## props[] — scenery that occludes or obstructs
{id, catalogId, label, essentiality, pose{laneOffset,s,tFrac,headingOffsetRad}, headingOffsetRad, scale,
 repeat{count,spacingM,tFracStep}, occludes{observer,target}, targetRevealToConflictS}

**Exact catalog ids only.** An unknown id used to materialise silently as a sedan, and an id
belonging to another class used to materialise silently as the wrong thing -- a brief asking for an
animal produced an actor tagged `class:animal` filled with `pedestrian.adult_walking`, a walking
human, which passed the gate, the quality layer AND the intent critic because every one of those
reads trajectories. Both are now hard errors. The full inventory:

  vehicle:      vehicle.ambulance, vehicle.bicycle, vehicle.box_truck, vehicle.bus, vehicle.hatchback, vehicle.mobility_scooter, vehicle.motorcycle, vehicle.pickup, vehicle.sedan, vehicle.semi_truck, vehicle.suv, vehicle.tram, vehicle.van
  pedestrian:   pedestrian.adult_standing, pedestrian.adult_walking, pedestrian.child_standing, pedestrian.child_walking, pedestrian.traffic_marshal
  animal:       animal.buck, animal.cat, animal.deer, animal.doe, animal.dog, animal.stray_dog
  hazard:       hazard.cardboard_box, hazard.debris, hazard.downed_branch, hazard.ladder, hazard.mattress, hazard.tire_debris, hazard.trash_bags
  construction: construction.arrow_board, construction.barricade_type3, construction.channelizer_drum, construction.excavator, construction.flagger, construction.jersey_barrier, construction.jersey_barrier_run, construction.long_pipe, construction.pedestrian_barrier, construction.portable_signal, construction.portable_toilet, construction.sign_road_work, construction.spoil_pile, construction.temporary_stop_sign, construction.traffic_cone
  street:       street.bus_shelter, street.food_cart, street.mailbox_cluster, street.shopping_cart
  occluder:     occluder.covered_car, occluder.dumpster, occluder.fence_run, occluder.hedge_run

Author-facing aliases resolve to the canonical model with its real footprint, so prefer the
obvious name: object.tyre, object.cone, object.barrel, object.barrier, object.sign_board,
object.ladder, object.mattress, object.debris, object.box, object.shopping_cart, object.branch.
**`actor.class` and `actor.catalogId` must agree** -- a `pedestrian` role cannot be filled by
`vehicle.box_truck`, and an `animal` role must use an `animal.*` model.

## choreography — the timeline
{clipSeconds, warmupSeconds, interactions[]}
Each interaction: {id, label, actor, verb, trigger, target, dynamics?, until?}

**7 verbs over 5 axes.** One axis has ONE owner; two interactions on the same actor+axis may not start at
the same time (later preempts earlier).
  longitudinal: `speed` {mode:absolute|relative|delta, valueKph|factor}, `gap` (headway to a lead)
  lateral:      `changeLane` {…}, `laneOffset` {…}
  topology:     `route` — target `{mode:"polyline", points:[FramePose,…]}` or
                **`{mode:"nearMiss", …}`** (a re-solved, contact-free crossing intent that stays valid
                when the target route, speed or site changes — prefer it over a hand-rolled polyline)
  existence:    `exist`
  state:        `set` {key, value} over the typed registry:
                rules.collisionAvoidance, rules.yield, rules.yieldToVehicles, rules.yieldToPedestrians,
                rules.obeySignals, rules.obeySpeedLimit, rules.laneKeeping, rules.aggression,
                rules.reactionTimeS, lights.brake, lights.indicator, lights.hazard, lights.headlights,
                lights.emergency, lights.reverse, pose.gesture, pose.stopArm, pose.paddle,
                pose.headingLookDeg, env.weather, env.frictionScale, env.rainIntensity, env.fogDensity,
                signal:<id>
                `env.*` and `signal:*` must be performed by the reserved actor `"@world"`.
`dynamics` is REQUIRED on the continuous verbs (speed, gap, changeLane, laneOffset):
  {shape: step|linear|cubic|sinusoidal, constraint: time|rate|distance, value}

**4 triggers.**
  `{kind:"at", t}`
  `{kind:"after", of|ref, delay}`
  `{kind:"when", condition, byLatest, ifNever}`  — `byLatest` is MANDATORY, and so is `ifNever`
  `{kind:"arrival", of, at{pose}, syncWith, ttc|deltaT}` — **back-solves a start time so the actor
    reaches the conflict point at a declared criticality. This is what makes a scenario non-trivial
    rather than a coincidence. Use it whenever two actors must nearly meet.**

## invariants[] — what must be true for the clip to count
Every invariant has {id, kind, essentiality, label?, window?:[t0,t1]} PLUS the kind-specific fields below.
These objects are STRICT: an unrecognised key is an error, and a missing key is an error. Copy the field
names exactly — they differ between kinds on purpose.

  headway         {of, to, range:[lo,hi]}                 seconds of time headway
  gap             {of, to, unit:"time"|"distance", range}  bumper-to-bumper gap
  ttc             {of, to, range, mode:"min"|"always"}
  path_ttc        {of, to, range}                          route-aware TTC at the conflict zone
  pet             {of, to, range}                          post-encroachment time
  near_miss       {pedestrian, target, clearanceRangeM:[lo,hi]}   NOTE: `pedestrian` and `target`,
                                                           NOT `of`/`to`. Exact footprint clearance in
                                                           metres; 0 is contact. Works for any actor.
  arrival         {of, at:{pose:{...}}, syncWith, deltaTRange:[lo,hi]}   `of` arrives this long AFTER
                                                           `syncWith` (so a negative range means before)
  closing_speed   {of, to, rangeKph:[lo,hi]}               NOTE: `rangeKph`, not `range`
  speed_rel_limit {of, rangeFrac:[lo,hi]}                  fraction of the posted limit: ~[0.85,1.05] is
                                                           flowing traffic, ~[1.3,1.6] is a speeder
  event_order     {events:[interactionId, ...] (2..16), strict?, minSeparationS?}   at least TWO events
  decel_budget    {of, maxMps2}                            5.5 is the comfort limit, 8.0 the hard limit

A `required` invariant that cannot hold makes the site INFEASIBLE and you lose the cell, so mark an
invariant `required` only when it is the point of the scenario. Use `preferred` for the rest.

## params — the sampled dials
`{declarations:[{id,type:continuous|discrete|categorical,description,unit,tier,range,default,distribution}],
  constraints:[]}`
Reference a param anywhere a number is allowed as the expression `"param.<id>"`. Expressions may also use
`lane.speedLimitKph`, arithmetic, and `clamp(x, lo, hi)`.

---
# ENGINE MECHANICS YOU MUST ACCOUNT FOR
These are general facts about the simulator, established by measurement. They apply to every scenario.

1. **The warm-up eats your gap.** The engine simulates `warmupSeconds` BEFORE the recorded clip starts.
   A gap of G metres authored between two actors is, at recorded t=0, only
   `G - warmupSeconds * (v_ego - v_other_along_ego_heading)`.
   Measured: 82.0 m authored -> 73.1 m at t=0 with warmupSeconds=1 and ego at 11.1 m/s (agrees to 0.02 m).
   So either keep `warmupSeconds` small, or add the closing distance back into the authored gap.
   Getting this wrong is the single largest cause of scenarios failing: the actors are already at their
   closest when recording starts, and then simply separate.

2. **The closest approach must happen DURING the clip, later than `warmupSeconds + 0.5` s.**
   If the two actors start close and diverge, the scenario is rejected no matter how good it looks.
   Start them far apart and let the timeline bring them together.

3. **`runwayDownstreamM` must cover the whole clip at the intended speed**, not just the event window:
   `clipSeconds * topSpeed_mps` plus margin. This is the most common cause of actors driving off the map.

4. **Arc length `s` restarts on each lane of a chain.** Never reason about "ahead/behind" by comparing `s`
   between two actors. Use `relative_to` with `dsM`, or a `conflicting_gate` role, or an `arrival` trigger.

5. **Multi-lane junction approaches are rare on these maps** (`throughLanesSameDir >= 2` fails at most
   candidate sites). Do not build a mechanism that requires more than one through lane unless the
   scenario genuinely cannot exist otherwise.

6. **`props.pose.tFrac` is clamped to [-1, 1]** (the ego lane edges), so the verge/sidewalk is not
   addressable for props. Put roadside things in the outermost addressable position, or use a role.

7. **A trigger that never fires voids the clip.** Every `when` needs a reachable condition, a `byLatest`
   and an `ifNever`. Prefer `arrival` and `at` over `when` where you can.

8. **A signal phase change is not by itself an encounter.** Control-type scenarios need a second actor
   whose movement the phase provokes, or nothing happens.

9. **`arrival` moves the actor named by `of`.** It back-solves where and when `of` starts so that `of`
   reaches `at` at the declared offset relative to `syncWith`. Consequences you must respect:
   - put `of` on the **challenger** and `syncWith:"ego"`, not the other way round;
   - `syncWith` must be an actor that actually travels to the conflict point. Syncing with a stopped,
     parked or static actor cannot converge, and every site is thrown away with `arrival_unconverged`;
   - do **not** use `arrival` to trigger the ego's own braking. The ego's response must emerge from the
     situation it is placed in. If you want the ego to react, make the hazard real and let it react,
     or trigger with `when` on a distance/visibility condition.
   If a scenario has no moving challenger to synchronise (for example a lead vehicle that is simply
   already stopped), do not use `arrival` at all: just place the obstacle far enough ahead that the ego
   closes on it during the clip.

11. **The ego brakes early if it can see the hazard, and the clip is then rejected as
    `trivially-safe`.** The ego runs with collision avoidance on. Simply putting an obstacle in its lane
    produces a comfortable, uninteresting stop. Criticality has to come from one of:
      - the hazard is genuinely HIDDEN until late (a prop with `occludes{observer:"ego", target:<role>}`
        that really blocks the sight line -- if it does not, you get `occlusion_unproven` and the point
        of the scenario is gone);
      - the hazard MOVES INTO the conflict late, timed with an `arrival` trigger synced to the ego;
      - the challenger behaves badly at close range (`rules.yield:false`,
        `rules.collisionAvoidance:false`, `rules.obeySignals:false`, high `rules.aggression`,
        a long `rules.reactionTimeS` on the ego);
      - the geometry itself is unforgiving (a blind bend, a crest, a narrow gap).
    Raising the closing speed or moving the obstacle nearer to the spawn point is NOT a fix: it breaks
    C2 instead, because the two actors then start at their closest.

12. **`required` invariants are expensive.** If a required invariant cannot hold at a site, the site is
    reported INFEASIBLE and you lose the cell entirely. Prefer `preferred` for everything except the one
    or two conditions that ARE the scenario.

---
# WHAT THESE FIVE MAPS ACTUALLY CONTAIN
Measured from the map data itself. Your anchor is matched against THESE roads, so a clause that asks for
something the maps do not have costs you every site. Your scenario must work at **>= 3 sites across >= 2
different maps**, so anything that exists on only one map can never be admitted.

| map                          | lanes | driving | sidewalk | bike | parkLane | junctions | occlZone | crosswalk | parkingLoc | busStop | school | workZone |
|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| yale-street                  |  1141 |     622 |      181 |   98 |       18 |        56 |       61 |        12 |         70 |       6 |      0 |        0 |
| belmont-research-center      |   970 |     662 |       70 |   75 |        1 |        74 |       87 |        10 |         30 |       2 |      0 |        0 |
| el-camino-road               |  1001 |     695 |      139 |   36 |        0 |        68 |       96 |         5 |         21 |       5 |      0 |        2 |
| easterbrook-discovery-school |   563 |     283 |       85 |   24 |        0 |        17 |        7 |        13 |          2 |       0 |      2 |        0 |
| richmond-field-station       |   370 |     264 |        4 |    0 |        3 |        31 |       24 |         5 |         32 |       1 |      0 |        0 |

junction control classes actually present:
  yale-street                   signalized 16, uncontrolled 28, minor_stop 10, all_way_stop 2
  belmont-research-center       uncontrolled 59, minor_stop 14, all_way_stop 1   (NO signalized)
  el-camino-road                uncontrolled 62, signalized 6
  easterbrook-discovery-school  minor_stop 15, uncontrolled 2                    (NO signalized)
  richmond-field-station        uncontrolled 28, minor_stop 2, signalized 1

## The consequences you must design around
- **Speed limits are 64 kph almost everywhere.** 960 of 1141 lanes on yale, 964 of 970 on belmont,
  563 of 563 on easterbrook. Asking for a 25-50 kph residential street matches nothing or is heavily
  degraded. Write `speedLimitKph` as `preferred`, or give it a wide range that includes 64.
- **`uncontrolled` is the common junction class.** Requiring `signalized` restricts you to three maps
  and few junctions; requiring `all_way_stop` (3 in total, on two maps) is close to fatal.
- **Adjacent `parking` lanes barely exist** (18/1/0/0/3 lanes). `requiresAdjacent:["parking"]` as a
  `required` clause will cost you nearly every site. Parked cars are better done as **props** than as
  an adjacency requirement.
- **`occlusion_zone` features are abundant** (61/87/96/7/24). Hidden-hazard scenarios are the best
  supported kind on these maps. Use them.
- **Crosswalks are scarce** (12/10/5/13/5) and **bus stops are very scarce** (6/2/5/0/1).
  Prefer `placement:"either"` and `preferred` essentiality over requiring a marked crossing.
- **There are no `rail_crossing` features on any map. `school_zone` exists only on easterbrook (2) and
  `work_zone_suitable` only on el-camino (2).** A scenario that REQUIRES one of these cannot reach two
  maps and therefore cannot be admitted. Express the situation with ordinary road structure instead:
  put the actors and props where such a place would be, rather than demanding the map label it.
- Roughly half of all lanes belong to junctions, and `junction_movement` locations are plentiful
  (537/548/480/279/175), so `conflicting_gate` roles and junction conflicts retarget well.


---
# THE FOUR RULES THAT DECIDE ACCEPTANCE
Measured over 552 simulated cells. These are not style advice; they are how the evaluator behaves.

**1. ANY finding at all rejects the cell.** All 20 accepted cells had an empty findings list. There is no
partial credit. The findings that appear in practice are `trivially_safe`, `occlusion_unproven`,
`invariant_violated`, `out_of_window`, `materialization_infeasible`, `never_fired`.

**2. Mark invariants `preferred`, not `required`, unless the invariant IS the scenario.**
A violated `required` invariant emits `invariant_violated` and the cell is rejected. A violated
`preferred` invariant emits nothing by itself: 66 cells were ACCEPTED while carrying violated
`preferred` invariants. Note the limit of this: demoting an invariant to `preferred` silences the
INVARIANT, not the underlying physics. If the ego actually needs more grip than the road has, the
evaluator emits `physically_unavoidable` on its own account and the cell is rejected anyway. Demotion
buys you room for an imprecise declared range; it does not buy you an impossible scenario.
Declaring five tightly-ranged `required` invariants is five ways to lose and no way to win. Declare one
or two, `preferred`, with generous ranges. The gate does not read your invariants; it reads the physics.

**3. minTTC must come out at or below 3.0 s, or the clip is `trivially_safe`.**
The single most common near miss is landing at 3.2-4.1 s: just outside. Aim for **1.2-2.5 s** so that
normal site-to-site variation still lands inside. If your design only just reaches 3 s at the best site,
it will fail at the other four.

**4. Declaring `occludes{observer,target}` creates a check you can fail.**
If the engine cannot observe a blocked-then-revealed sight line it emits `occlusion_unproven` and the cell
is rejected -- and NONE of the 20 accepted cells carried that finding. A prop physically blocks the view
whether or not you declare the relation. It cost 157 of 549 otherwise-perfect cells.
So: **do not write `occludes` unless hiding the hazard IS the scenario.** A prop blocks the view
physically whether or not you declare the relation, so you get the visual effect for free and without the
check. When the reveal genuinely is the point, put the occluder squarely between the ego's approach and
the target's conflict point, close to the target, and large enough to hide it (`vehicle.box_truck`,
`vehicle.bus`, `vehicle.semi_truck`) -- and expect to have to verify it.


---
# THE SURVIVABLE BAND: the mistake that costs the most cells
Measured over 549 cells whose physics was otherwise perfect. They were thrown away like this:

  110  `physically_unavoidable`  -- the ego needed more grip than the road has (ceiling **7.85 m/s^2**)
   46  a real COLLISION          -- the ego hit something
  157  `occlusion_unproven`      -- a declared occlusion that never happened
  116  `materialization_infeasible`

So the most common way to fail is **not** being too gentle. It is **overshooting into the impossible**.
An edge case must be *survivable*. A guaranteed crash is rejected exactly as firmly as a boring clip.

## Give the ego room to react, and compute how much
For an ego at speed `v` (m/s), avoiding a hazard `d` metres ahead needs about `a = v^2 / (2d)`.
Turn that around to get the room you must leave:

    comfortable (5.5 m/s^2):   d = v^2 / 11
    hard but possible (7 m/s^2): d = v^2 / 14
    tyres give out (7.85 m/s^2): d = v^2 / 16   <-- past this the clip is REJECTED as unavoidable

At the 64 kph that dominates these maps (17.8 m/s):
    comfortable ~29 m,  hard ~23 m,  impossible below ~20 m.
At 40 kph (11.1 m/s): comfortable ~11 m, impossible below ~8 m.

**Target: the hazard should become relevant to the ego roughly 25-45 m ahead at 64 kph**, i.e. about
1.5-2.5 s of travel. That lands minTTC in the 1.2-2.5 s band, forces a firm 3-6 m/s^2 response, and
leaves a few metres of clearance. Closer than that and you get `physically_unavoidable` or a collision;
further and you get `trivially_safe`.

If you find yourself reacting to a `trivially_safe` result by moving the hazard much closer or raising
the speed a lot, stop: that is the move that produces an unavoidable crash on the next iteration. Make
the hazard appear *later in time* rather than *nearer in space*.

## Keep props out of the ego's driving line
Props are `collidable:false` and do not appear in the simulated actor list, so **nothing in the engine
or the gate objects if the ego drives straight through one.** A parked SUV the ego passes through is a
broken clip that scores as a clean one. Measured: once occlusion declarations were discouraged, the
share of admitted cells with the ego's footprint overlapping a prop rose from 0.067 to 0.333.
So place every prop clearly off the ego's path: `tFrac` at or beyond +/-0.8 for a kerbside object, or in
an adjacent lane, never near `tFrac` 0 on the lane the ego drives. If a prop must sit in the ego's lane
(a broken-down vehicle, a fallen load), that is an OBSTACLE the ego has to avoid - give it enough room
under the survivable-band rule above, and expect the ego to steer or stop.

## Contact is a failure, not a success
`minDistance` reaching 0 means the ego hit the actor. A near miss must stay strictly positive; aim for
**0.5-4 m** of true clearance at the closest point. If you are getting collisions, the challenger is
being placed into the ego's path with no room, or `rules.collisionAvoidance:false` has been set on an
actor that needed it.


13. **A scenario that only touches at the very end is not the scenario you described.**
    Measured failure: a brief asking for a van *travelling alongside the ego and repeatedly wandering
    over the lane line* produced a clip where the van sat far ahead in another lane for 9 of 13 seconds
    and only came near the ego in the final frame. It passed the physical gate and an independent
    reviewer rejected it, correctly.
    Whenever the brief says **alongside, following, being followed, repeatedly, weaving, hesitating,
    tailgating, filtering, or over and over**, the two actors must be CO-TRAVELLING for most of the
    clip, not converging once at the end:
      - bind the challenger `relative_to` the ego with a SMALL `dsM` (roughly -15..+15 m) and
        `dLane` of -1 or +1 for an adjacent-lane companion, or `dLane` 0 for a lead/follower;
      - give it an `initialSpeedKph` close to the ego's, so the pair stays together instead of one
        running away from the other. A 10 kph difference separates them by 28 m over a 10 s clip;
      - remember the warm-up closes the gap by `warmupSeconds * (v_ego - v_other)` before recording
        even starts;
      - then make the BEHAVIOUR the event: repeated `laneOffset` excursions, a `changeLane` and back,
        a `speed` drop and recovery. Repetition needs at least two triggered excursions, not one.
    A single late convergence reads as "a vehicle appeared near the ego", which is not an edge case and
    will be rejected as not realising the brief.

14. **The event must be visible for long enough to be seen.** If the whole interaction occupies the
    last half-second of the clip, nothing can verify it. Aim for the conflict to develop over 2-5 s,
    somewhere in the middle of the clip, with the ego still driving afterwards.

15. **Getting another road user to actually enter the ego's lane is the hardest thing to author, and
    it is the single most common way a scenario fails to be what it claims.** Measured across a run:
    `challenger_enters_ego_path` was the missing requirement 18-30 times, more than every other cause
    combined. Two specific errors account for much of it:
      - **`laneOffset` in a pose is a LANE INDEX, not a lateral nudge.** `laneOffset: -1` puts the
        actor in the lane to the RIGHT of the reference lane; it does NOT move it toward the ego.
        To bring an actor into the ego's lane, the final route point must be `laneOffset: 0` with
        `tFrac` at or near 0 - the centre of the ego's own lane.
      - **`tFrac` is a fraction of lane width, so `tFrac: 0.8` is still inside the neighbouring lane.**
        Measured, the challengers that failed came to 2.0-2.6 m of the ego's path and stopped there,
        which is one lane over. Ending an incursion at `tFrac` 0.65-0.85 does not cross the line.
    So: make the incursion end at `laneOffset: 0, tFrac: 0`, start it early enough to complete during
    the clip, and give the movement a `dynamics` duration short enough to finish before the conflict.
    An incursion that is still in progress when the clip ends did not happen.

16. **Use `changeLane` for a lane incursion. It is the primitive built for exactly this, and it is
    almost never used.** Measured across every generated-brief template: 1,176 interactions, of which
    `set` 658, `speed` 250, `route` 217, `laneOffset` 26 and **`changeLane` only 12 (1%)**. Authors
    hand-roll a `route` polyline instead, and that is why the single most common reason a scenario
    fails to be what it claims is that the challenger never actually entered the ego's lane.

    `changeLane` target has three modes, and the third is the one you want:
      `{mode:"relative", dk:-1|+1}`   one lane to the right / left of where the actor is now
      `{mode:"absolute", k:<index>}`  a specific same-direction lane index
      **`{mode:"toRole", role:"ego"}`  change into the lane THAT ACTOR is in** — site-independent,
        and it cannot miss by a lane the way a hand-computed `tFrac` can

    `dynamics` is REQUIRED on it. `{shape:"linear", constraint:"rate", value:<m/s>}` is the standard
    lateral-velocity parameterisation for a cut-in: **0.3 m/s is a lazy drift, 1.5 m/s is an abrupt
    chop**. You may also set `maneuverDurationS` to fix how long the move takes in physical time.

    So a cut-in is:
      `{verb:"changeLane", actor:"challenger", trigger:{kind:"arrival", ...},
        target:{mode:"toRole", role:"ego"},
        dynamics:{shape:"linear", constraint:"rate", value:1.2}}`
    and a drift/encroachment that does NOT complete a lane change is `laneOffset` with a `tFrac`
    beyond the lane edge — remembering that `tFrac` is a fraction of lane width, so 0.8 is still
    inside the actor's own lane and only |tFrac| > 1 crosses the line.

17. **A challenger that moves INTO the ego's lane must not START in it — and the binding you choose
    decides whether that works at all.** This is the single largest defect measured over 478
    gate-passing cells: 30.6% of challengers spawned already in the ego's lane and never moved, versus
    35.8% that performed a real incursion.

    **Adjacent same-direction lanes DO exist and multi-lane conflicts ARE buildable.** 30.1% of driving
    lanes sit in a corridor two or more lanes wide, and 22.9% of matchable corridors have
    `throughLanesSameDir >= 2`, on all five maps. A template requiring `[2, 8]` matches 23 sites across
    4 maps at verdict `exact`. So cut-ins, zipper merges and lane splitting are all expressible.

    **But only one role binding actually carries a lane offset.** Use `kind:"lane_offset"` with `k` of
    -1 or +1. Writing `kind:"on_reference"` with `pose.laneOffset:-1` — the obvious thing to reach for —
    has its `laneOffset` SILENTLY DISCARDED during adaptation, so the actor is placed in the ego's own
    lane, `template validate` still reports ok, and it then sits there motionless. `relative_to` with
    `dLane` clamps the same way when the lane does not exist. That silent drop, not any shortage of
    lanes, is what tripled the spawned-already-in-lane defect when this document previously told
    authors to "start in the adjacent lane".

    So, whenever the brief has someone move in, drift in, cut in, swerve in, cross the line or emerge
    into the ego's path:
      - bind with **`kind:"lane_offset"`, `k: -1` or `+1`**, and require
        `corridor.throughLanesSameDir: [2, 8]` in the anchor so you match a site that has the lane;
      - or bring them from somewhere that needs no second lane at all: the **opposing direction**
        (`opposing`), a **side road or junction arm** (`conflicting_gate`, the most portable of all),
        a **driveway**, or the **verge/sidewalk/bike lane** for VRUs;
      - then move them with `changeLane` `{mode:"toRole", role:"ego"}`.
    A genuine LEAD or FOLLOWING vehicle, or a stationary obstacle the brief says is already there,
    SHOULD start in the ego's lane. Everything else should not.

    Prefer `changeLane` over `laneOffset` for the movement itself. Measured true-incursion rate by
    primitive: `changeLane` 0.455, hand-rolled `route` polyline 0.454, **`laneOffset` only 0.098** — an
    actor nudged within its own lane usually never reaches the ego at all.

18. **An `arrival` trigger cannot converge if EITHER actor stops — including the ego.** The existing
    warning covers syncing to a parked challenger, but the case that actually bites is a
    stop-controlled junction: at a four-way stop the EGO stops, so `syncWith:"ego"` has no finite
    arrival time and every site is thrown away with `arrival_unconverged`. Measured on a four-way-stop
    brief: 5 of 5 cells lost this way, with 24 sites matched across all 5 maps — the anchor was fine,
    the mechanism was impossible.

    So for any scenario where the ego stops or crawls — all-way stops, minor-stop junctions, queues,
    give-way, a signal the ego waits at — do NOT drive the conflict with `arrival … syncWith:"ego"`.
    Use instead:
      - `{kind:"when", condition:{...}, byLatest:<t>, ifNever:"..."}` on a distance or `reaches`
        condition, so the challenger moves when the ego gets somewhere rather than at a solved time;
      - or `{kind:"after", of:<interactionId>, delay:<s>}` chained off the ego's own stop;
      - or let the conflict come from a RULE violation with an `at` trigger: the challenger simply
        does not yield (`rules.yield:false`, `rules.obeySignals:false`) and the geometry does the rest.
    `arrival` remains the right tool when both actors are genuinely in motion toward a shared conflict
    point — a crossing VRU, an oncoming turn across the ego, a merging vehicle. It is the wrong tool
    the moment either party is expected to come to a halt.

19. **A hazard that must create criticality has to be a ROLE with `static: true`, never a prop.**
    Props are fixed geometry: the engine turns each collidable prop into a static OBB under the id
    `prop:<id>` and drops it into the collision grid, but it has no actor track — its state lives in
    `header.propMetadata`, not in `ticks.actors`. The criticality metrics iterate ACTORS only, so a
    prop-authored obstacle has **no TTC and no PET by construction**; the most it can ever produce is a
    collision event in the `prop:` namespace. A debris field authored as props is therefore invisible
    to the gate no matter how dangerous it looks.

    The engine's actual rule for static actors is narrower and better than "not a metric participant":
    a static actor is scored **iff the moving actor is genuinely on a path conflict with it**, which is
    what stops a parked car beside the lane from stealing the incident. So:
      - the tyre, the fallen ladder, the shed load, the stalled car IN the ego's path -> a **role**
        with `actor.static: true`;
      - the parked row, the cones, the barriers, the skip, the hedge -> **props**, whose job is to
        occlude, to narrow, and to be collidable scenery.
    Authored that way a static hazard produces exactly the evidence the gate wants: a real
    `minTTC` pair of `[hazard, ego]`.

20. **Put the hazard where the ego actually drives.** Measured on a debris template: 16 of 30 cells
    were accepted by `evaluate` while the ego passed the obstacle at **4.96 m** — inside the gate's
    5.0 m proximity bound by four centimetres, and most of a lane away in reality. That is the
    "physically valid but boring" failure in a new costume. A carriageway hazard belongs at
    `tFrac` near 0 in the ego's own lane, not on the shoulder beside it.

21. **The ego will not drive past a static obstacle in its own lane — it stops short.** With
    `rules.collisionAvoidance` on (the default), an ego facing a hazard in its lane comes to a halt
    rather than squeezing by: measured stopping at s = 44.7 against a hazard at s = 50, even after a
    1.57 m lateral shift that would have cleared a 0.56 m tyre by about 2 m. So "the ego passes the
    debris closely" is close to unauthorable by default, and that — not poor placement — is the main
    reason static-hazard scenarios read as physically valid but boring.
    To get a genuine close pass you must either turn the ego's avoidance off deliberately, or accept
    that the interesting event is the EMERGENCY STOP rather than the pass, and author for that: a late
    reveal, a short sight line, and a decel demand near but under the friction ceiling.

22. **Never author the avoidance as a t = 0 route polyline.** A static/moving pair is scored only while
    the moving actor is genuinely on a collision course with it. If the ego's route steers around the
    hazard from the first frame, it was never on that course, the pair is never scored, and the clip
    comes back with `minDistance: null` and `minTTC: null` — 30 of 30 cells in a measured case, a
    correctly placed hazard, and no criticality at all.
    Author the swerve as a TRIGGERED `laneOffset` (or `changeLane`) instead. Same geometry, but the
    collision course exists until the trigger fires, so the encounter is measured: minTTC recorded on
    26 of 30 cells.
    The general form of this rule: **an evasive action authored as an initial condition deletes the
    conflict it was meant to evade.** Conflicts must exist first and be resolved during the clip.

23. **Treat the engine's own criticality metrics as unreliable once an actor leaves a collision
    course.** `metrics.minTTC` / `minDistance` / `minPET` stop updating for a pair the moment it is no
    longer on a collision course, so for any hazard the ego successfully avoids, the retained value is
    a sample from BEFORE the avoidance — one measured case reported `minDistance 15.83 m at t=0.14`
    when the true closest approach was 2.03 m at t=1.66. Since `evaluate` reads those metrics, a real
    near miss can be graded `trivially-safe`. Compute clearance yourself from `ticks.actors` x/y/
    headingRad, which keeps recording regardless of scoring.

24. **Never write a negative CONSTANT `s` on an `on_reference` role. It silently makes every site
    infeasible.** Measured sweep: `s` of "-50", "-40", "-35", "-30", "-25", "-20", "-5", "-1" and the
    JSON number `-35` all match **0 sites on every map**, with no clause attributed in
    `selectivityOrder` and no validator finding. The same values written as an unfoldable expression —
    `"-lane.speedLimitKph"`, which evaluates to -40 — match **3 sites per map**. `"0"` and `"5"` match
    3 per map.
    So the constant-folding path rejects negative stations while the expression path accepts them, and
    nothing anywhere names the field. This cost me an entire bisect: I stripped the anchor to empty,
    swapped the role binding, and dropped every feature, all still returning 0 sites, because the cause
    was a number in `roles[0].pose.s`.
    If you need a role upstream of the frame origin, express it relative to something —
    `"origin - 35"`, `"-lane.speedLimitKph"`, or a `relative_to` binding with a negative `dsM`, which
    works normally. Recorded in `newcaps/DEFECT-negative-role-s-infeasible.md`.


25. **If the brief mentions a traffic light, you MUST author a `trafficControls` block. The map will
    not give you one.** A signal exists in the simulation if and only if the materialized scenario
    carries at least one signal program, and a map-bound program exists only for a junction whose
    OpenDRIVE `<junction>` element literally declares `<controller>` children — **6 of 247 junctions
    across all five maps** (yale 134/303/345/447, richmond 238, el-camino 590). Two whole maps,
    belmont-research-center and easterbrook-discovery-school, contain **zero** dynamic traffic-signal
    heads, so no junction on either can ever be signal-controlled from the map.
    Do **not** try to fix this with the anchor. `control: {value: ["signalized"], essentiality:
    "required"}` buys a LABEL, not a light: the label is set by "some traffic-light point lies within
    junction size/2 + 22 m of the centre", and **17 of the 23 junctions carrying it have no signal
    record on any of their own roads** — they inherited a neighbour's heads through the pad. Requiring
    it starves the archetype to a handful of sites AND still yields no signal state. Ask the anchor for
    the GEOMETRY the brief needs (arms, the conflicting approach, crossing angle, approach speed) and
    author the light yourself.
    Minimal block, a top-level key of the template alongside `roles`/`choreography`:

    ```json
    "trafficControls": [
      {
        "id": "ego-approach-head",
        "kind": "normal_signal",
        "feature": "conflict-junction",
        "pose":  { "laneOffset": 0, "s": -6, "tFrac": 0, "headingOffsetRad": 0 },
        "stopLines": [
          { "feature": "conflict-junction",
            "pose": { "laneOffset": 0, "s": -6, "tFrac": 0, "headingOffsetRad": 0 } }
        ],
        "phases": [
          { "indication": "green",  "durationS": 11 },
          { "indication": "yellow", "durationS": 3 },
          { "indication": "red",    "durationS": 30 }
        ],
        "offsetS": 0,
        "loop": false,
        "label": "authored head governing the ego approach"
      }
    ]
    ```

    The program appears in the trace as `control:<id>` and is what makes `set(rules.obeySignals, …)`
    mean anything at all (see rule 26). Measured, `c15g-red-light-runner` at the full harvest setting
    (`batch --all-maps --draws 20 --max-sites 8`, 800 cells, 671 simulated): the unmodified template
    produced signal state in **100 of 671** cells (14.9%, and only on the two maps that have a real
    signalized junction); with the block above, **671 of 671 (100.0%)** on all five maps, with a phase
    sample on every recorded tick (median 651 of 651). The physics did not move — the 95 cells that
    passed C1–C5 in the base are cell for cell the **same 95** that pass the whole gate with the head,
    and 591 of 671 cells have ego travel identical to within 5 cm — but C6 losses went 571 → 0 and gate
    admission went **0 → 95 cells (95 HQ, 3 maps x 8 sites)**. Adding the head costs nothing and is the
    difference between an admitted scenario and a rejected one. `c12g-red-pedestrian-phase`, same
    recipe: 60/598 → **598/598** with ego travel bit-identical on every cell.

26. **Without a signal or a stop line in the scenario, `set(rules.obeySignals, …)` is a pure no-op.**
    The engine consults `obeySignals` in exactly one place, and that code returns immediately when the
    scenario's signal book is empty (no programs AND no map stop-sign controls). So on an uncontrolled
    junction, `set(rules.obeySignals, false)` on your violator and `set(rules.obeySignals, true)` on
    the ego both flip a flag nobody reads: a `state_set` event is emitted and the vehicles behave
    identically. That is how 67 delivered "red-light runner" scenarios came to contain no red light —
    the conflict was produced entirely by `set(rules.yieldToVehicles, false)` plus the arrival solve,
    and the signal language was decoration.
    Three further things go quiet in the same state, all of them failing OPEN rather than loud:
      - a `{kind:"signal", signalId, phase}` trigger condition compares `null === phase` and **never
        fires**, so anything chained off "when the light turns red" waits forever;
      - a signal/`control_indication` intent criterion grades **`unchecked`**, not `fail`, and a
        non-required criterion then drops silently out of the verdict;
      - `set(signal:<id>.phase, …)` against an id that does not exist is **discarded without error**.
    Corollary: if your scenario's story depends on a phase, author the phase (rule 25) before you
    author anything that reads it. And do not read "empty signal channel" as "no control" — a
    stop-sign junction has real stop-line authority that the engine honours and never publishes to
    the trace.

27. **Author the phase the brief actually claims, and put the head where the ego meets it.**
    Practical rules, all measured:
      - **Give the ego the indication the brief gives it.** "The ego proceeds on green while a van runs
        its red" means the ego's head is GREEN across the ego's approach; the violator's red is
        expressed by `set(rules.obeySignals, false)` on the violator, not by a second head. Make the
        green comfortably longer than the ego needs to reach the line (clip 13 s, ego at 45-64 kph
        starting ~7 s upstream -> green 11 s is ample) and let yellow/red follow, so the trace shows a
        real transition rather than a constant.
      - **A red really does stop the ego, so use it deliberately.** Same template, same sites, only the
        phase plan changed: green-through gave a median ego travel of **117.3 m** with the ego halted
        in 36/136 cells (those halts caused by the van), while holding the head red across the approach
        gave **67.4 m** and halted the ego in **83/136** cells and dropped gate admission to 0. The
        phase is genuinely driving the vehicle; a red placed over your conflict window will delete the
        conflict.
      - **One head, one stop line, on the ego's own approach.** `stopLines[].connectingLaneRsls` is
        emitted empty, so an authored head stops **every** movement across its line — a
        protected-turn-only or single-movement head is not expressible. Never place an authored line
        where a second actor must cross it unless you intend to stop that actor too.
      - **You cannot give the VIOLATOR a light.** Every authored stop line is projected onto
        `site.frame.lateralLanes[pose.laneOffset]` — the ego corridor's own lanes — so a head cannot be
        placed on a conflicting junction arm at all. Measured: with the head held red and the van's
        `rules.obeySignals` forced to `true`, the van travelled 96.0 m, identical to the metre with
        `false`, because its route contains none of the frame's RSLs and no stop-line authority is ever
        evaluated against it. So author the EGO's indication and express the other party's violation
        with `set(rules.obeySignals, false)` + `set(rules.yieldToVehicles, false)`; do not add a second
        head expecting it to bind to the side road. If your brief needs a `preferred` feature's station
        and that feature may not match, omit `feature` from the stop line entirely — the offset then
        falls back to the frame origin, which every site has, instead of throwing `control_feature_unbound`.
      - **Size the phases to the clip, and expect a tradeoff.** Measured on `c15g` over 671 cells:
        `green 11 / yellow 3` (13 s clip) shows only `green → yellow` but keeps **95** gate passes across
        8 sites and leaves 591/671 cells physically identical to the no-head run; pulling it to
        `green 9 / yellow 3 / red 30` buys a full `green → yellow → red` cycle on every cell and costs
        **12 passes and a site** (83, 7 sites), because the earlier yellow catches slower egos at the
        line. C6 wants signal *state*, not a complete cycle — favour the ego's green. A shorter clip may
        fit a whole cycle for free: `c12g` at 8 s with `green 6 / yellow 2 / red 30` records all three
        colours with **598/598 cells bit-identical** to the base.
      - **Place the line upstream of the junction in the frame** (`s` negative, e.g. -6) on
        `laneOffset` 0. It is projected onto the frame's lateral lane, and on a mirrored site that is
        the frame lane rather than the ego's — if the ego seems to ignore the light, check
        `ticks.actors.<id>.laneRsl` against the program's stop-line `rsl` before blaming the phase.
      - **`darkFallback` and `darkDwellS` are parsed and then dropped**, so an `off`/dark phase always
        falls back to the all-way-stop default with a 1 s dwell. Do not build a blackout scenario on
        them yet.
