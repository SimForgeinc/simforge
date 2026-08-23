# DIAG-signals — why 284/293 delivered scenarios have an empty `ticks.signals`

## BOTTOM LINE

`ticks.signals` is populated if and only if the materialized `SimScenarioInput.signalPrograms`
array is non-empty (`engine.ts:363,368,2493,2590`), and for a map-bound site that array is non-empty
only when the site's origin junction is literally declared with `<controller>` children inside its
`<junction>` element in the OpenDRIVE file (`map-signals.ts:230-240,355-367`). Across the five dev
maps only **6 of 246 junctions** satisfy that (yale 134/303/345/447, richmond 238, el-camino 590),
while map-intel labels **23** junctions `signalized` — because `deriveControl` in
`packages/maps/src/build/junctions.ts:277-303` sets `signalized` from nothing more than
"≥1 `traffic_light` point from `signals.geojson` falls within `sizeM/2 + 22 m` of the junction
centre"; it never checks that the head sits on one of the junction's own roads, that it is dynamic,
or that any `<controller>` references it. So yes — **`junction.control = signalized` is derived from
something strictly weaker than the presence of a signal program**, and 17 of the 23 "signalized"
junctions have literally zero `<signal>` records on their own roads (they inherited a neighbour's
lights through the 22 m pad; yale junction 387 — the fixture map-intel's own tests call "a
signalized four-way" — is 51 m from the real signalized junction 345 and has 0 signal elements and
0 controllers). Separately, **the premise that the 67 `c15g-red-light-runner` scenarios bound to
signalized junctions is false**: that archetype's anchor clause is
`control: {value: ["signalized","uncontrolled","minor_stop","all_way_stop"], essentiality: "preferred"}`,
which every junction satisfies, so all 8 bound sites are `uncontrolled` or `minor_stop` junctions and
their own manifests say `"uncontrolled junction as requested"` — a red-light-runner scenario with no
junction control at all, and the templates' `set(rules.obeySignals,…)` interactions are inert because
`distanceToStopLine` returns `null` the moment `SignalBook.isEmpty` (`controllers.ts:461`). A template
**can** author a working phase plan today, via the portable `trafficControls` block (proved below: a
three-phase authored head on the *uncontrolled* belmont junction 164 yields
`ticks.signals = {"control:ego-head": [...]}` and stops the ego dead at the line), so the fix is a
template/anchor change plus (optionally) a hardening of `deriveControl`, not new engine capability.

---

## Environment / reproduction

```
repo   /Users/michaelvu-simforge/Documents/Programming/UniScenarios-vista   (branch vista-lane)
cli    node packages/cli/bin/uniscenarios.js
maps   dev-assets/ -> /Users/maikyon/.../scenario-studio/dev-assets   (READ ONLY — never written)
data   /tmp/vista-dataset-all/{train,test}.jsonl   (293 records)
work   /tmp/diag-signals/                          (all artefacts of this diagnosis)
```

Measured census over all 293 delivered records (junction control from
`dev-assets/<map>/derived/topology-derived.json.gz`, controller presence from `dev-assets/<map>/map.xodr`,
programs from the delivered `*.instance.json`):

| n | junction control | `<junction>` has `<controller>` | `signalPrograms` non-empty | `roadControls` non-empty |
|---|---|---|---|---|
| 135 | uncontrolled | no | no | no |
| 112 | *origin is not a junction* | – | no | no |
| 24 | minor_stop | no | no | **yes** |
| 8 | minor_stop | no | no | no |
| **5** | **signalized** | **yes** | **yes** | yes |
| 5 | signalized | **no** | **no** | no |
| **4** | **signalized** | **yes** | **yes** | no |

The 9 non-empty traces are exactly the 5+4 rows with `hasController = yes`. There is no other
correlation. Note also that `ticks.signals == {}` does **not** mean "no control": 24 records carry
real stop-sign `roadControls`, which the engine honours but never publishes to a trace channel.

---

## 1. What distinguishes the 3 sites that do have signals?

| site | origin | map-intel `control` | `<controller>` in `<junction>` | programs emitted |
|---|---|---|---|---|
| `richmond-field-station/51cef2c75cc0edbc` | `junction:238` | signalized | `379,380,381,382` | `signal:367/368/369/371` |
| `yale-street/b6ae511740c0b9e9` | `junction:447` | signalized | `1573,1574,1575,1576` | `signal:1512/1514/1531` |
| `yale-street/90fd1b20995479a2` | `junction:345` | signalized | `1569,1570,1571,1572` | `signal:1426/1427/1477` |

Those are three of only **six** junctions in the whole asset set whose `<junction>` element carries
`<controller>` children. Full census of the 23 map-intel-`signalized` junctions:

```
map                             jid  #<controller> #<signal> on the junction's own roads  #of those that are dynamic traffic_light
yale-street                    134       4            88                                    73
yale-street                    303       1            70                                    64
yale-street                    345       4            66                                    62
yale-street                    447       4            52                                    27
richmond-field-station         238       4            25                                    16
el-camino-road                 590       4           107                                    91
yale-street  115/387/788/883/1111/1369/1382     0     0                                      0
yale-street  247/817/1280                       0     1                                      0
yale-street  548/762                            0     3                                      0
el-camino-road 581/2013/2089/2203               0     0                                      0
el-camino-road 245                              0     2                                      0
```

**17 of 23 "signalized" junctions have no dynamic traffic-light signal record on any of their own
roads at all.** They are labelled signalized purely by proximity.

### Is `junction.control` weaker than a real signal program? Yes.

`packages/maps/src/build/junctions.ts:277-303`:

```ts
const radius = sizeM / 2 + SIGNAL_RADIUS_PAD_M;      // :281   (SIGNAL_RADIUS_PAD_M = 22, :75)
for (const sig of signals) {
  if (Math.hypot(sig.point.x - center.x, sig.point.y - center.y) > radius) continue;   // :285
  if (sig.category === 'traffic_light') lights += 1;                                    // :286
  ...
}
...
if (lights > 0) control = 'signalized';               // :297
```

Three independent weaknesses:
1. **Proximity, not membership.** The head does not have to be on any road of this junction.
2. **No `dynamic` test.** `deriveControl` counts every `signal_category === 'traffic_light'` point;
   the materializer additionally requires `dynamic === 'yes'` (`map-signals.ts:132`).
3. **No controller/program test.** Nothing checks that a `<controller>` references the head, which is
   the *only* thing that lets `buildSignalPlanForJunction` produce a program.

Worked example — **yale junction 387**, whose descriptor is:

```
control=signalized  controlEvidence=['radius_m=38.9','traffic_light=8','stop_sign=0','yield_sign=0',
                                     'search_index_control_type=uncontrolled']
```

but in `dev-assets/yale-street/map.xodr` the `<junction id="387">` element contains **zero
`<controller>` elements**, and **zero `<signal>`/`<signalReference>` elements exist on any of its
incoming or connecting roads**. Its centre is 51.6 m from junction **345** (`sizeM` 64.56), the real
signalized intersection with controllers 1569–1572. With `radius = 33.74/2 + 22 = 38.9 m`, junction
387 vacuums up 8 of junction 345's physical heads and calls itself signalized. This is the junction
`packages/maps/src/__tests__/helpers.ts:5,68` describes as "387 (a signalized four-way)". The
5 delivered `c4g-circulating-sudden-stop` scenarios on `yale-street/13d91f73d99d7917` bind exactly
this junction and get zero signal programs.

(Note `deriveControl` also *records* `search_index_control_type=uncontrolled` as evidence for 387 and
then deliberately ignores it — see the comment at `junctions.ts:266-270`. For 387 the search index
was right.)

---

## 2. Where are signals loaded and ticked, and what predicate is false?

**Load.** `packages/engine/src/sim/engine.ts:363`

```ts
this.signals = new SignalBook(input.signalPrograms, input.warmupSeconds, input.roadControls);
for (const id of this.signals.ids()) this.signalTracks.set(id, { phase: [] });   // :368
```

`SignalBook.ids()` (`sim/signals.ts:133-135`) returns `this.programs.map(p => p.id)` — **programs
only**. `roadControls` contribute `StopLineBinding`s but *no* ids, so a stop-sign junction is
controlled at runtime yet invisible in `ticks.signals`.

**Tick.** `engine.ts:2491-2497`

```ts
private record(t, ...) {
  this.tArray.push(t);
  for (const id of this.signals.ids()) {
    const phase = this.signals.phaseAt(id, t);
    if (phase) this.signalTracks.get(id)!.phase.push(phase);
  }
```

**Emit.** `engine.ts:2589-2590,2637`

```ts
const signals: Record<string, SignalTrack> = {};
for (const id of this.signals.ids()) signals[id] = this.signalTracks.get(id)!;
...
ticks: { t: this.tArray, actors, signals, ... }
```

So the exact predicate is:

> `ticks.signals` is non-empty **iff** `input.signalPrograms.length > 0`.

`phaseAt` cannot return null for an id that came from `ids()` (`signals.ts:138-141` looks the id up in
the same map), so the `if (phase)` guard never suppresses anything. There is no other gate — not
`obeySignals`, not `warmupSeconds`, not the map, not the site score.

**Where `signalPrograms` comes from.** `packages/compiler/src/materialize.ts:3535`

```ts
signalPrograms: [...(this.compiledMapSignalPrograms ?? this.signalPlan.programs), ...this.authoredControlPrograms],
```

Three contributors, all empty for the 284 scenarios:

* `this.signalPlan.programs` — `buildSiteSignalPlan` (`materialize.ts:3473` → `map-signals.ts:446-451`
  → `buildSignalPlanForJunction`, `map-signals.ts:346-443`). It returns the empty `none()` at four
  early exits:

  ```ts
  if (!junctionId) return none();                                            // :355  site origin is not `junction:*`
  const junction = bundle.signalCatalog.junctions.find(c => c.junctionId === junctionId);
  if (!junction) return none();                                              // :357  <-- THE ONE THAT FIRES
  ...
  if (controllers.length === 0) return none();                               // :363
  ...
  if (heads.length === 0) return none();                                     // :367
  ```

  `signalCatalog.junctions` is built in `parseMapSignalCatalog` (`map-signals.ts:230-240`) and a
  junction is added **only if** its `<junction>` XML element contains at least one `<controller>`
  child:

  ```ts
  const controllerIds = [...match[2]!.matchAll(/<controller\b([^>]*)\/?\s*>/g)]
    .map(entry => attrs(entry[1]!)['id']).filter(Boolean);
  if (controllerIds.length > 0) {                                            // :237  <-- the real gate
    junctions.push({ junctionId: a['id'], controllerIds: [...new Set(controllerIds)] });
  }
  ```

  For 240 of 246 junctions this list is empty, so `map-signals.ts:357` fires and the site gets no
  programs. For the 112 delivered records whose origin is a corridor/segment rather than a junction,
  `map-signals.ts:355` fires first.

* `this.compiledMapSignalPrograms` — only set by `compileAuthoredMapSignals` (`materialize.ts:2415`),
  which returns immediately when `template.mapSignalPlans.length === 0` (`materialize.ts:2416`). No
  delivered template authors one.

* `this.authoredControlPrograms` — pushed by `buildTrafficControls` (`materialize.ts:2354-2391`), one
  per `template.trafficControls[]` entry. No delivered template authors one either.

Nothing in the pipeline reads `junctionDescriptor.control === 'signalized'` when deciding whether to
synthesise a program. `assertMaterializableMapControls` (`materialize.ts:497-535`) *would* throw
`map_control_missing` for a signalized junction with no complete binding — but only when the anchor's
`control` clause is `essentiality: "required"` (`materialize.ts:501`), and every delivered template
marks it `preferred`. That guard is therefore never armed, which is why the mismatch is silent.

---

## 3. Can a TEMPLATE author a phase plan the engine honours? YES.

Two mechanisms exist; one is portable and works anywhere.

### 3a. `trafficControls` — portable, works on any site (recommended)

Schema: `packages/scenario/src/schema/v2/traffic-controls.ts:54-95`
(`kind`, frame-relative `stopLines`, `phases[{indication,durationS}]`, `offsetS`, `loop`,
`darkFallback`, `darkDwellS`), wired at `schema/v2/template.ts:89`, lowered at
`materialize.ts:2354-2391` into a `SignalProgram` with id `control:<id>` whose stop lines are
projected onto the concrete lateral lane (`materialize.ts:2364-2379`). It can be phase-forced at
runtime with `set(control:<id>.indication, …)` (`engine.ts:1416-1425`).

**Minimal working fragment** (top-level key of the v2 template, alongside `roles`/`choreography`):

```json
"trafficControls": [
  {
    "id": "ego-head",
    "kind": "normal_signal",
    "feature": "conflict-junction",
    "pose":  { "laneOffset": 0, "s": -6, "tFrac": 0, "headingOffsetRad": 0 },
    "stopLines": [
      { "feature": "conflict-junction",
        "pose": { "laneOffset": 0, "s": -6, "tFrac": 0, "headingOffsetRad": 0 } }
    ],
    "phases": [
      { "indication": "green",  "durationS": 1 },
      { "indication": "yellow", "durationS": 1 },
      { "indication": "red",    "durationS": 40 }
    ],
    "offsetS": 0,
    "loop": false,
    "label": "authored ego approach head"
  }
]
```

**Proof.** Base template `/tmp/vista-gen3-blind/c15g-red-light-runner-blind/template.json`
(unchanged apart from the block above) on the *uncontrolled* junction site that currently produces
an empty `ticks.signals`:

```bash
cd /Users/michaelvu-simforge/Documents/Programming/UniScenarios-vista
# control (unmodified template) — the delivered behaviour
node packages/cli/bin/uniscenarios.js instantiate \
  /tmp/vista-gen3-blind/c15g-red-light-runner-blind/template.json \
  --map belmont-research-center --site 0580a0170fe67e90 --draw 0 --out /tmp/diag-signals/base.json
node packages/cli/bin/uniscenarios.js simulate /tmp/diag-signals/base.json \
  --trace /tmp/diag-signals/base-trace.json
# -> ticks.signals == {}

# treatment (same template + trafficControls)
node packages/cli/bin/uniscenarios.js template validate /tmp/diag-signals/c15g-red-head.json \
  --map belmont-research-center                       # 0 errors
node packages/cli/bin/uniscenarios.js instantiate /tmp/diag-signals/c15g-red-head.json \
  --map belmont-research-center --site 0580a0170fe67e90 --draw 0 --out /tmp/diag-signals/red.json
node packages/cli/bin/uniscenarios.js simulate /tmp/diag-signals/red.json \
  --trace /tmp/diag-signals/red-trace.json
```

The instance now carries a real program:

```json
"signalPrograms": [{"id":"control:ego-head",
  "phases":[{"phase":"green","durationS":1},{"phase":"yellow","durationS":1},{"phase":"red","durationS":40}],
  "offsetS":0,"loop":false,
  "stopLines":[{"rsl":"80:0:-3","s":25.852528575979516,"connectingLaneRsls":[]}]}]
```

and the trace has a non-empty `ticks.signals` **and the ego obeys it**:

```
ticks.signals ids: ['control:ego-head']   (651 samples, = len(ticks.t))

  t     phase    ego v (treatment)   ego s      | ego v (control)   ego s
  0.00  green        16.42            25.37     |     16.42          25.37
  2.00  red          13.98            57.02     |     14.19          57.04
  5.00  red           9.56            92.32     |     12.44         101.05
  8.00  red           5.20           114.43     |      6.48         129.98
 11.00  red           0.31           123.53     |     12.89         155.72
 13.00  red           0.00           123.54     |     16.23         186.06
```

Ego min speed 0.00 m/s (stopped at the line, `requiredDecelMax.ego = 8`) versus 5.73 m/s in the
control run, which never stops. A three-phase green→yellow→red variant (`loop: true`,
`durationS` 6/3/20) likewise produces the full `green…yellow…red` phase array. Artefacts:
`/tmp/diag-signals/{c15g-with-trafficcontrol.json,c15g-red-head.json,base.json,red.json,base-trace.json,red-trace.json,trace.json}`.

Caveats found while proving it:
* `stopLines[].connectingLaneRsls` is hard-coded to `[]` in `materialize.ts:2379`, so an authored
  control stops **every** movement over that line; a protected-turn-only head is not expressible.
* `buildTrafficControls` (`materialize.ts:2380-2390`) drops the template's `darkFallback` and
  `darkDwellS` — they are parsed (`traffic-controls.ts:64,66`) but never copied onto the
  `SignalProgram`, so `SignalBook.authorityAt` (`signals.ts:183-186`) always applies the
  `all_way_stop` / 1 s defaults for an `off` phase. Secondary defect, separate from this one.
* The stop line lands on `site.frame.lateralLanes[laneOffset]`; on a mirrored site that is the
  frame lane, and the ego's route may enter it several legs downstream — put the line at a negative
  frame `s` upstream of the junction and check `ticks.actors.<id>.laneRsl` if the ego appears to
  ignore it.

### 3b. `mapSignalPlans` — map-bound, restricted to the 6 real junctions

Schema `packages/scenario/src/schema/v2/map-signal-plans.ts:34-66`: non-overlapping half-open
`clips[{startS,endS,reference:{controllerId,headId},indication}]` over a binding
`{mapId, junctionId, controlDigest}`. Compiled by `compileMapSignalPlans`
(`map-signal-plan-compiler.ts`, invoked at `materialize.ts:2415-2440`). It rejects a plan whose
`binding.controlDigest !== contentHash(buildMapControlPlan(bundle))`
(`map-signal-plan-compiler.ts:163-168`) and whose junction has no executable programs
(`:170-176` `map_signal_plan_junction_unbound`). Because `buildMapControlPlan` reuses
`buildSignalPlanForJunction`, this path is available **only** at yale 134/303/345/447,
richmond 238 and el-camino 590 — i.e. it cannot rescue the 17 phantom-signalized junctions.

### Smallest change that would widen 3b

`parseMapSignalCatalog` currently derives junction→controller membership *only* from
`<controller>` children of `<junction>` (`map-signals.ts:230-240`). Every one of those 17 junctions
still has real dynamic `traffic_light` heads in `signals.geojson` with a `road_id`. The smallest
change is to add a second, explicitly-labelled derivation in `parseMapSignalCatalog`/
`buildSignalPlanForJunction`: when a junction has no `<controller>`, group the dynamic
`traffic_light` heads whose `road_id` is one of the junction's incoming/connecting roads by approach
and emit a `timingSource: 'synthetic-default'` program per approach group (the existing
`defaultPhasesForHead` already handles the `controllers.length <= 1` case at `map-signals.ts:283-291`).
That is contained to `map-signals.ts` and does not touch the engine. It does **not** help yale 387,
which has no heads of its own — that one needs `deriveControl` fixed instead.

---

## 4. Does `rules.obeySignals` do anything when `ticks.signals` is empty?

**Not when the whole `SignalBook` is empty, no.** It is read in exactly one place in the engine:

`packages/engine/src/sim/controllers.ts:453-461`

```ts
export function distanceToStopLine(a, signals, t, lookaheadM, leader = null, canReleaseStop = null): number | null {
  if (!a.rules.obeySignals || signals.isEmpty || a.route.isFreeform) return null;
```

called once from `engine.ts:2091`. `SignalBook.isEmpty` is
`this.stopLines.length === 0 && this.programs.length === 0` (`signals.ts:129-131`). So with no
programs *and* no `roadControls`, the entire stop-line branch short-circuits and both
`set(rules.obeySignals,true)` on the ego and `set(rules.obeySignals,false)` on the violator are
**pure no-ops**: `applyStateKey` flips the flag (`engine.ts:1459-1461`) and emits a `state_set`
event, and nothing ever consults it. That is exactly the case for all 67
`c15g-red-light-runner` scenarios (`signalPrograms: []`, `roadControls: []` in every one of their
instances) — the "red-light runner" runs no red light; the conflict is produced solely by
`set(rules.yieldToVehicles,false)` plus the arrival solve.

**Important qualification:** empty `ticks.signals` does *not* by itself make `obeySignals` inert.
`isEmpty` is false whenever `roadControls` is non-empty, and stop-sign bindings produce
`kind: 'stop'` authorities (`signals.ts:177-180`, `controllers.ts:482-513`) that `obeySignals`
does gate. In the delivered corpus 24 records are in that state: real stop-and-dwell behaviour,
empty `ticks.signals`. Only the 260 records with **both** arrays empty have a genuinely dead
`obeySignals`.

Two downstream consequences of an empty `ticks.signals`:
* `evaluateCriterion` for a `control_indication`/signal criterion returns
  **`unchecked`**, not `fail` (`packages/engine/src/trace/intent-rubric.ts:272`:
  `if (!signal) return result(c, 'unchecked', 'signal … has no trace channel', …)`), and
  `evaluateIntentRubric` only rejects on `c.required && status !== 'pass'` — so a non-required
  signal criterion silently disappears from the verdict.
* A `{kind:'signal', signalId, phase}` trigger condition (`sim/triggers.ts:129`) evaluates
  `ctx.signals.phaseAt(id,t) === phase`, which is `null === phase` → never fires.
* `set(signal:<id>.phase, …)` is silently discarded: `SignalBook.setOverride` returns `false` for an
  unknown id (`signals.ts:206-211`) and `engine.ts:1425` ignores the return value.

---

## Appendix — commands used for the census

```python
# junction control + controller presence
import re, gzip, json, os
base = 'dev-assets'
for m in ['yale-street','richmond-field-station','el-camino-road',
          'belmont-research-center','easterbrook-discovery-school']:
    x = open(f'{base}/{m}/map.xodr').read()
    has = {a: bool(re.findall(r'<controller[^>]*id="([^"]+)"', b))
           for a, b in ((re.findall(r'id="([^"]+)"', j.group(1))[0], j.group(2))
                        for j in re.finditer(r'<junction\b([^>]*)>([\s\S]*?)</junction>', x))}
    d = json.load(gzip.open(f'{base}/{m}/derived/topology-derived.json.gz'))
    sig = [j for j in d['junctions'] if j['control'] == 'signalized']
    print(m, len(d['junctions']), 'signalized', len(sig),
          'with controllers', sum(has.get(str(j['junctionId']), False) for j in sig))
```

```
yale-street                     56 signalized 16 with controllers 4
richmond-field-station          31 signalized  1 with controllers 1
el-camino-road                  68 signalized  6 with controllers 1
belmont-research-center         74 signalized  0 with controllers 0
easterbrook-discovery-school    17 signalized  0 with controllers 0
--------------------------------------------------------------------
total                          246 signalized 23 with controllers 6
```

Anchor-clause check that disproves the "requires signalized" premise:

```bash
python3 - <<'PY'
import json
t = json.load(open('/tmp/vista-gen3-blind/c15g-red-light-runner-blind/template.json'))
print(t['anchor']['features'][0]['control'])
PY
# {'value': ['signalized', 'uncontrolled', 'minor_stop', 'all_way_stop'],
#  'essentiality': 'preferred', 'weight': 1}
```

and every `c15g` instance manifest agrees:

```
16x belmont-research-center 0580a0170fe67e90 junction:164  -> "uncontrolled junction as requested"
 8x belmont-research-center 53ed87a5d032609d junction:499  -> "uncontrolled junction as requested"
 6x belmont-research-center 44ca495eacbec3cf junction:1045 -> "minor_stop junction as requested"
 5x belmont-research-center 0b55e1396beccb30 junction:960  -> "uncontrolled junction as requested"
 5x belmont-research-center 2423a1151dce9235 junction:534  -> "minor_stop junction as requested"
13x richmond-field-station  3ca9b6083bd0fae3 junction:269  -> "uncontrolled junction as requested"
 6x richmond-field-station  70c945af325b2e3a junction:112  -> "minor_stop junction as requested"
 8x el-camino-road          4d1e283dcbbafdc6 junction:1090 -> "uncontrolled junction as requested"
```

No fixes were applied. Diagnosis only.
