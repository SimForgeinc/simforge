# Pivot: from archetype grammar to agent-native tool authoring

## 0. Two things I got factually wrong, now corrected against the repo

**prop-catalog.** I was wrong. It holds **45 props in 6 classes**, including **15 construction
objects** with real dimensions (l x w x h, metres):

| id | dims | occlusion |
|---|---|---|
| construction.traffic_cone | 0.36 x 0.36 x 0.70 | low |
| construction.channelizer_drum | 0.58 x 0.58 x 1.07 | low |
| construction.barricade_type3 | 0.62 x 2.44 x 1.66 | medium |
| construction.jersey_barrier | 3.05 x 0.61 x 0.81 | medium |
| construction.jersey_barrier_run | 12.20 x 0.61 x 0.81 | medium |
| construction.excavator | 5.15 x 2.24 x 2.71 | **high** |
| construction.arrow_board | 3.45 x 2.44 x 2.53 | medium |
| construction.portable_signal | 1.45 x 1.20 x 3.25 | medium |
| construction.temporary_stop_sign | 0.82 x 0.92 x 2.16 | low |
| construction.sign_road_work | 0.90 x 1.73 x 2.21 | medium |
| construction.flagger | 0.73 x 0.70 x 2.19 | low (vru) |
| construction.spoil_pile | 2.60 x 2.55 x 0.90 | low |
| construction.long_pipe | 8.00 x 0.62 x 0.62 | low |
| construction.pedestrian_barrier | 2.00 x 0.55 x 1.10 | low |
| construction.portable_toilet | 1.24 x 1.22 x 2.26 | medium |

Plus `pedestrian.traffic_marshal`, 4 occluders (hedge/fence runs, dumpster, covered car),
4 hazards, 4 street objects, 13 vehicles up to `vehicle.semi_truck` (20.1 m) and `vehicle.tram` (30 m).

**Work zones.** I was wrong. `workZones: false` gates only the `work_zone_suitable` **anchor feature**
during matching (`anchor-matcher/src/clauses.ts:1059`). Proven empirically: `work_zone_suitable`
matches **0 sites on all five maps**, yet a corridor-anchored construction scene with **17 props
materialises and simulates on all five maps** (yale 12 sites, belmont 12, el-camino 12, richmond 7,
easterbrook 5), with dimensions resolved correctly (cones 0.36x0.36x0.70, barrier runs 12.2 m,
excavator 5.15x2.24x2.71). Construction can be authored anywhere.

## 1. A real defect this audit uncovered

A template with `catalogId: "vehicle.boxTruck"` — **which does not exist** — validates with
**exit 0** and materialises with dims **4.70 x 1.82 x 1.45**, i.e. silently substituted
`vehicle.sedan`. This is precisely pitfall 4 in `docs/research/retargeting.md`:
*"Silent asset substitution (an occluder becoming a sedan deletes the point of the scenario) ->
resolve assets against the catalog at author time, fail loud."*

**Consequence: my archetype-grammar occluders were sedans, not box trucks or buses. Every occlusion
result from the grammar run is suspect and is withdrawn.**

Second limit found: `props.pose.tFrac` is clamped to **[-1, 1]** — the ego lane's own edges. A sign
on the verge (tFrac -1.15) is **rejected**. A work zone that cannot put a sign off the carriageway is
not a work zone. This is the same limit EXP-B hit; it caused 3 of its 5 failures.

## 2. Reconciling my own evidence

You are right that I contradicted myself. My measurements said:
- schema emission **0/4 valid, 54 errors, 100% structural, 0 semantic**;
- spatial scene description **7.67/8**;
- the successful agent reported map-query tools "excellent", schema fields "the difficulty";
- my own research doc concluded **"tools, not schemas"**.

Then I built a compiler that emits schema documents. The grammar optimised the wrong axis: it made
*me* better at emitting templates, when the finding was that *nobody should be emitting templates*.

## 3. The tool surface (implemented, `tools/scenario_tools.py`)

Signatures, with what each validates and the structured error it raises:

```python
catalog_search(tag=None, cls=None, max_height=None) -> [{id,label,dims,tags}]

find_sites(control=[...], min_lanes=1, arms=[3,4], maps=None, limit=40)
    -> [{site: "<map>::<opaque>", map, score, verdict, runwayDownstreamM, egoTurn}]
    raises no_sites{query} | probe_invalid{issues}

use_site(site_handle) -> {ok, site, ego:'seeded'}
    raises unknown_site{handle}                       # handle must come from find_sites

close_lane(lane='ego'|'adjacent_left'|'adjacent_right', device='cone'|'drum'|'barricade'|'barrier',
           through_junction=False, assumed_speed_kph=40)
    -> {device, taperLengthM, devices, deviceSpacingM, zones{advance_warning,taper,buffer,activity,
        termination,junction}}
    raises bad_lane{got,expected} | bad_device{got}
    # SOLVER computes MUTCD taper length, device count and spacing. Agent supplies no geometry.

place_prop(catalog_id, zone, lane='ego', side='in_lane'|'lane_edge'|'shoulder', count=1,
           spacing_m=None, heading_deg=0)
    -> {prop, resolvedDims, occlusion}
    raises unknown_catalog_id{got, did_you_mean[...]}   # FAIL LOUD - the defect above
         | unknown_zone{got, available}
         | bad_side{got, available}                     # verge/sidewalk is NOT representable

place_actor(role, catalog_id, approach='ego_lane'|'conflicting', behaviour='through')
    -> {role, class, resolvedDims}
    raises unknown_catalog_id{...} | duplicate_role{role}

add_interaction(actor, does, when='scenario_start'|'on_approach'|'after'|'at_conflict',
                relative_to=None) -> {interaction}
    does in {brake_to_stop, change_lane, hold_course, ignore_right_of_way, cross_road, wave_traffic}
    raises unknown_actor{got, available} | unknown_action{got, available}

require(metric='ttc'|'pet'|'path_ttc'|'no_collision', between=(a,b), band=[lo,hi]) -> {ok}
    raises unknown_metric{got}

validate() -> {ok, warnings}      raises invalid_scene{issues:[{path,reason}]}
simulate(draws, all_maps=True) -> {cells, maps, sites, bands, cellsWithContact, criticalCells}
    # metrics read from the RAW TRACE, never a summary field
explain_failure() -> {findingCodes, topReasons[{code,reason,n}], traceEvents, hint}
```

## 4. Where the coordinate/time boundary sits

**The agent may emit:** a site handle from `find_sites`; a lane by role (`ego`, `adjacent_left`);
a zone by name (`advance_warning`, `taper`, `buffer`, `activity`, `termination`, `junction`);
a side by name (`in_lane`, `lane_edge`, `shoulder`); a catalog id; a count; an ordering
(`when='after' relative_to=...`); and a **target criticality band**.

**The agent may never emit:** `s`, `x`, `y`, `tFrac`, a heading in radians, an absolute time, a
spawn position, or a speed in m/s.

**The solver owns:** MUTCD taper length and device spacing from speed and offset; every `s` and
`tFrac`; the zone layout; spawn positions; all timing (`arrival` bisection back-solve); speeds as
expressions over `lane.speedLimitKph`; and the tier-1 parameter ranges.

`heading_deg` on `place_prop` is the one concession — orienting an excavator is authorial intent,
not a coordinate. It is degrees relative to the lane, never absolute.

## 5. Recommendation on the grammar: DEMOTE, do not present as the answer

**Kill it as the general approach.** It is fixed-arity by construction, its occluders were silently
sedans, and after four rounds of general fixes it reached **10/35 dev admission** — and I never ran
held-out. It cannot express construction at an intersection and never will.

**Keep exactly one job, or nothing:** the *enumeration and diversity sampling* is still useful — the
axis space, feasibility pruning (12,600 -> 1,067) and stratified maximin selection give a defensible
**coverage ledger** saying which mechanisms exist and which are covered. That is a planning artifact.
The **compiler** should be deleted; the agent authors those cells through the tool surface instead.

I am not keeping the compiler out of sunk cost. Its measured result is 10/35 with a silent asset bug.

## 6. Proof on construction-at-an-intersection

Authored entirely through the tool surface. The **complete** authoring act:

```
use_site('yale-street::007b7001d1afa0c5')
close_lane('ego', 'cone', through_junction=True)      -> MUTCD L=33.0 m, 5 cones @ 6.1 m
place_prop('construction.excavator',          'activity', side='in_lane', heading_deg=20)
place_prop('construction.jersey_barrier_run', 'buffer',   side='lane_edge', count=3, spacing_m=12.2)
place_prop('construction.spoil_pile',         'activity', side='lane_edge')
place_prop('construction.temporary_stop_sign','taper',    side='shoulder')
place_actor('flagger', 'construction.flagger', approach='ego_lane')
place_actor('crosser', 'vehicle.van',          approach='conflicting')
add_interaction('ego',     'hold_course')
add_interaction('crosser', 'ignore_right_of_way')
add_interaction('crosser', 'hold_course')
require('ttc', ('ego','crosser'), band=[0.5, 2.5]); require('no_collision', ('ego','crosser'))
```

Not one coordinate or timestamp. 7 props + 3 actors — **open arity**, which the grammar cannot do.

`validate()` -> ok, 0 warnings. `simulate()` -> **126 cells across all five maps, 32 distinct sites.**

**It does not yet produce a critical scenario, and the tool surface says exactly why.**
`explain_failure()`: `road_departure_prevented` 160, `collision` 68, `invariant_unchecked` 122
("no TTC was recorded for ego/crosser"), `no_interaction` 85.

**The honest finding: `close_lane` places devices but does not change the drivable surface or
re-route the ego.** The closure is scenery; the ego drives into the barriers. Cones are props with
`collidable:false`; barriers are hit. This is a real engine/representation gap that the grammar hid
and the tool API exposed on its first honest attempt — which is why this was the right test case.

## 7. What must be built next (in order)

1. **`close_lane` must actually close the lane.** Needs a drivable-surface edit (`roadControls` /
   lane-availability override) so the ego's route walker avoids it, plus `reroute_ego()` or an
   automatic lane-shift. Without this, no work-zone scenario is real.
2. **Fail loud on unknown `catalogId`** in `template validate` — engine-side, not just in my tools.
3. **Lateral space beyond the lane edge**: `tFrac` cannot address the verge. Either extend the range
   or add a `lateral_m`/`reference='verge'` placement form.
4. Then, and only then: pre-registered rubric -> held-out generalisation test over a set of
   tool-authored scenes, with the same discipline as before (raw traces, no rubric relaxation).

Evaluation discipline is unchanged. Only the authoring model changes.


---

# Session addendum — tool surface built, construction case run, defect fixed

## Implemented and persisted (`tools/scenario_tools.py`)
15 operations: `catalog_search, find_sites, use_site, close_lane, place_prop, place_actor,
add_interaction, reroute_ego, shift_ego_alignment, require, preregister, validate, simulate, solve,
explain_failure`.

Solver-owned in practice, demonstrated: `close_lane` returned **MUTCD taper L=33.0 m, 5 cones at
6.10 m spacing** and a five-zone layout from `lane` + `device` alone; `shift_ego_alignment` returned
**offset 0.757** solved from the widest placed prop (2.44 m arrow board). The agent supplied no number.

## Construction at an intersection — authorable, not yet admitted
Best variant: single-lane approach, flagger-controlled alternating one-way, shifted alignment.
Twelve calls, **zero coordinates, zero timestamps**. Rubric pre-registered before solving,
sha256 `00ce444a07bb5d46`.

`validate()` ok / 0 warnings. `simulate()` -> **148 cells, 37 distinct sites, all five maps.**
`criticalCells` **0**, `cellsWithContact` **107**. **NOT ADMITTED.** No rubric was relaxed.

The shared graded solver ran 4 rounds and was **flat at meanScore 0.066**; `oncomingStartM` did not
narrow. That is an honest negative result about the solver too: it has no gradient here because
contact dominates and lateral separation is not reachable through any exposed parameter.

## Blockers, in the order they must be fixed
- **B1 (blocking)** `close_lane` cannot edit the drivable surface. `roadControlSchema` supports only
  `kind: 'stop'` (`sim-engine/src/schema/input.ts:526`); there is no lane-availability override. A
  closure is scenery and the ego drives into the barriers.
- **B2 (blocking)** multi-lane junction approaches are rare on these maps: `throughLanesSameDir >= 2`
  fails at **157/210** candidate sites. A plain adjacent-lane merger binds at 18 sites but none at a
  junction. Lane-closure-plus-merge at an intersection is not expressible on this inventory.
- **B3 (blocking)** no lateral control for a head-on near miss; with both actors holding course the
  encounter always contacts.
- **B4 (fixed at source)** silent catalog substitution — see below.
- **B5** `tFrac` clamped to [-1, 1]; the verge is unaddressable.

## B4 fixed
Root cause located at `scenario-materializer/src/prop-dims.ts:89`, whose own comment said
*"Unknown ids remain parseable for non-Studio consumers; renderers reject them loudly"* — but headless
agent authoring never reaches a renderer, so the fallback is silent.

Added `isKnownPropCatalogId()` and `knownPropCatalogIds()` with 4 tests (all pass, `tsc --noEmit`
clean). The test pins the exact defect: `propDims('vehicle.boxTruck')` equals `propDims('vehicle.sedan')`.
The tool surface now refuses the id with `{code: unknown_catalog_id, did_you_mean: ['vehicle.box_truck']}`.
Still to do: wire the same check into `simforge template validate` so the CLI is fail-loud too.

## Status against the goal
Requirements A/B/C/D/E are **not met** under the new authoring model — nothing has been admitted
through the tool surface yet. The 20-instance gold corpus from the previous sessions stands on its
own evidence and is unaffected. The grammar is demoted, not deleted: its enumeration survives as a
coverage ledger, its compiler does not.


---

# RESULT: construction at an intersection is ADMITTED through the tool surface

**18 instances · 2 maps · 4 distinct sites · zero collisions · 18/18 replay bit-identical.**
Rubric pre-registered before solving (`construction-intersection-flagger-v3`, sha256 in
`tools/*.preregistration.json`). No rubric was relaxed. Artifacts in `gold-toolauthored/`.

## The authoring act — 13 calls, zero coordinates, zero timestamps
```
find_sites(control=[signalized,all_way_stop,minor_stop,uncontrolled], arms=[3,4])   -> 36 sites / 5 maps
use_site(...)
narrow_lane(side='right', device='cone')          -> MUTCD shifting taper, encroachment SOLVED
place_prop('construction.excavator',          'activity', side='shoulder', heading_deg=25)
place_prop('construction.jersey_barrier_run', 'buffer',   side='shoulder', count=2)
place_prop('construction.portable_signal',    'taper',    side='shoulder')
place_actor('flagger',  'construction.flagger', approach='ego_lane')
place_actor('oncoming', 'vehicle.pickup',       approach='oncoming')
add_interaction('ego','hold_course')
add_interaction('oncoming','ignore_right_of_way')
add_interaction('oncoming','brake_to_stop', when='on_approach')
shift_ego_alignment(toward='left')                -> offset SOLVED, range [0.25,0.80]
require('near_miss',('ego','oncoming'),[0.3,3.0]); require('no_collision',('ego','oncoming'))
```
Six props and three actors — open arity, which the fixed-arity grammar cannot express.

## What it took, and every fix was general
| Fix | Contacts | Critical |
|---|---:|---:|
| first honest attempt (close_lane in the ego lane) | 91/126 | 0 |
| close the adjacent lane instead | 12/40 | 0 |
| `require('near_miss')` — solver picks the metric, not the agent | 8/40 | 0 |
| taper clamped downstream of the ego spawn | 105/148 | 1 |
| taper placed as an EXPRESSION over the site speed limit | 110/148 | 0 |
| **`narrow_lane`: MUTCD SHIFTING taper instead of a merging taper** | **19/148** | **4** |
| + shared graded solver, 10 draws | 49/370 | **9 -> 18 admitted** |

Three of my own magic constants were removed on the way, each a requirement-E violation I had
written myself: the ego shift offset (0.757 hardcoded -> solved range), the taper start (fixed metres
-> expression over `lane.speedLimitKph`), and the metric choice (agent-chosen `ttc` -> solver-chosen
via `require('near_miss')`).

**The decisive insight was representational, not numeric.** `close_lane` builds a *merging* taper
whose devices sweep across the lane centre — correct for closing a lane, and it makes the lane
genuinely impassable, so the ego always struck a cone. MUTCD's single-lane treatment is a *shifting*
taper that moves traffic laterally and leaves a passable corridor. Adding `narrow_lane` as a distinct
operation took contacts from 110/148 to 19/148 and produced the first critical cells. A dial could
not have found this; it is a different object layout, which is exactly the user's point.

## Blockers: revised status
- **B1** partially resolved. `close_lane` still cannot edit the drivable surface, so a true lane
  closure remains scenery. `narrow_lane` sidesteps it for single-lane work zones. A real closure
  still needs a lane-availability override in `roadControlSchema`.
- **B2** stands: multi-lane junction approaches are rare (`throughLanesSameDir>=2` fails 157/210).
- **B3** resolved: the solver had no lateral gradient because I had hardcoded the offset.
- **B4** fixed at source (`isKnownPropCatalogId`, 4 tests).
- **B5** stands: `tFrac` clamped to [-1,1]; the verge is unaddressable.

## Honest limits of this result
Two maps, not five. 18 cells from 370. The archetype is admitted; the corpus is one archetype.
Requirements A (~100 archetypes), D (judge) and E (held-out generalisation) remain unmet under the
tool-authoring model.
