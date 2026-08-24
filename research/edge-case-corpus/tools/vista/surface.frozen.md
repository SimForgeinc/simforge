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

**Exact catalog ids only** (an unknown id used to materialise silently as a sedan):
vehicle.sedan, vehicle.suv, vehicle.hatchback, vehicle.pickup, vehicle.van, vehicle.box_truck,
vehicle.semi_truck, vehicle.bus, vehicle.ambulance, vehicle.motorcycle, vehicle.bicycle,
vehicle.mobility_scooter, vehicle.tram,
pedestrian.adult_walking, pedestrian.adult_standing, pedestrian.child_walking,
pedestrian.child_standing, pedestrian.traffic_marshal

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

## Contact is a failure, not a success
`minDistance` reaching 0 means the ego hit the actor. A near miss must stay strictly positive; aim for
**0.5-4 m** of true clearance at the closest point. If you are getting collisions, the challenger is
being placed into the ego's path with no room, or `rules.collisionAvoidance:false` has been set on an
actor that needed it.
