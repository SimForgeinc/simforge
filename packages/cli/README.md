# `@simforge-oss/cli` — `simforge`

`simforge` is the canonical command. The shorter `scen` executable remains
available as a compatibility alias for existing automation.

Layer 4 of `docs/agent-authoring-architecture.md`: the surface an LLM agent
drives the whole stack through. Query a map's semantics, author a template
against the published JSON Schemas, match it onto concrete sites, sample it into
thousands of instances, simulate, filter, triage.

```bash
node packages/cli/bin/simforge.js sites match examples/ltap-opposing.template.json --all-maps --pretty
node packages/cli/bin/simforge.js batch examples/ltap-opposing.template.json --all-maps --draws 5 --out out/
```

## The contract

| | |
|---|---|
| **stdout** | the result, as JSON. `--pretty` renders the *same object* for humans. |
| **stderr** | `{code, path?, reason, detail?}` — one JSON line, always. |
| **exit 0** | ok |
| **exit 1** | the command could not run (bad flag, missing map, unreadable file) |
| **exit 2** | it ran and found something wrong with the *input*: schema issues, no matching site, an infeasible cell, a rejected trace |

That 1-vs-2 split is the whole reason an unattended repair loop works: `1` means
"you called me wrong", `2` means "your document is wrong, here is where".

## Commands

```
simforge maps list
simforge maps pull        <name[@version]> [--registry URL --cache-root DIR]
simforge maps build       <source-dir> --name ID --work-dir DIR
                       [--glb FILE --xodr FILE --source-manifest FILE --reuse-master DIR]
simforge maps ingest      <source-dir> --name ID --registry URL --work-dir DIR
                       [--glb FILE --xodr FILE --source-manifest FILE --target private|public]
                       [--master-dir DIR --web-dir DIR]
simforge maps promote     <name@version> --from URL --destination-registry URL --to public
simforge locations find    --map <id> [--type --subtype --tags --affordances
                                   --facts k=v,k2>=v2 --near <handle>
                                   --within-m N --limit N --diversity-m N]
simforge locations get     <handleOrId> --map <id> [--describe]
simforge locations resolve --map <id> "<free text>"
simforge template validate <file> [--map <id> [--site <siteId>]]
simforge sites match       <template.json> --map <id> | --maps a,b | --all-maps
                       [--min-score --max-sites --rejected]
simforge instantiate       <template.json> --map <id> --site <siteId>
                       [--seed <hex> | --draw K] [--out file]
simforge simulate          <instance.json> [--trace out.trace.json.gz]
simforge debug             <template|instance.json>
                       [--map ID --site ID --draw K --seed S]
                       [--provider native|sumo --ambient-count N]
                       [--duration S --sample S --out DIR]
                       [--compare prior-report.json]
                       [--fail-on-collision --fail-on-road-departure
                        --fail-on-fallback --fail-on-never-fired]
simforge validate          <instance|template> [--tier 1|2 --map --site --draw]
simforge evaluate          <trace> [--filter critical|negative-control|all]
                       [--trivial-ttc S --reject-collisions]
simforge evidence verify   <instance.json> <trace.json.gz>
simforge export            <instance.json> --format xosc-1.4|xosc-1.3-esmini|osc-2.2 --out <file>
                       [--road-file map.xodr --route-sample-m 20]
simforge catalog create    --out <catalog.json> [--namespace ID --evidence-root DIR]
simforge catalog verify    <catalog.json> [--evidence-root DIR --require-evidence]
simforge catalog batch     <catalog.json> [--ledger FILE --slots a,b --map ID]
                               [--allow-collisions]
                       [--mechanisms a,b --attempts N --concurrency N --force]
simforge batch             <template.json> --maps a,b,c --draws N --out dir/
                       [--concurrency N --min-score --max-sites --force --no-trace]
simforge schemas           [--name template|anchor|interactions] [--content]
```

Only `richmond-field-station` may be promoted publicly. The default read
registry is the public CloudFront registry; licensed maps need an explicitly
authorized private registry. Publishing to `s3://simforge-maps-public` enforces
the same restriction even when `--target private` is supplied.

Builds require Linux `flock`, KTX-Software, an HDR sky and persistent disk.
`map-source.json` uses schema `simforge.map-source.v1` and selects `name`, `glb`,
optional `xodr`, `sky`, and `donorMasters`; manifest paths are relative to the
manifest. Command-line source selections override their manifest counterparts.
Directories with multiple possible scene or XODR inputs are rejected.
Publication accepts only a complete native master plus browser tier and writes
the immutable release descriptor before making the version visible. A retry
resumes the same release instead of minting another version.

## Headless scenario debugging

`debug` is the single command intended for an agent investigating an editor
scenario. It accepts either a concrete instance or a v2 template. Map-bound
Studio templates infer their pinned map and compile through
`materializeMapBound`; portable templates use `--map` and optional `--site`
(otherwise the highest-ranked executable site). Both paths then run the exact
shared `@simforge-oss/engine` used by Studio playback.

```bash
# Full JSON report on stdout (every native tick by default).
node packages/cli/bin/simforge.js debug \
  examples/edge-cases/05-ambulance-gridlocked-intersection/instance.baseline.json

# Agent-friendly artifact directory, sampled at 10 Hz, with strict gates.
node packages/cli/bin/simforge.js debug scenario.json \
  --sample 0.1 --out /tmp/scenario-debug \
  --fail-on-road-departure --fail-on-fallback --fail-on-never-fired

# Run packaged SUMO-Wasm ambient traffic alongside the canonical authored run.
SCEN_DEV_ASSETS=/absolute/path/to/dev-assets \
node packages/cli/bin/simforge.js debug scenario.json \
  --provider sumo --ambient-count 32 --sample 0.05 --out /tmp/sumo-debug

# Deterministic regression comparison. Exit 2 if path deltas exceed tolerance.
node packages/cli/bin/simforge.js debug scenario.json \
  --sample 0.1 --compare /tmp/scenario-debug/report.json \
  --position-tolerance-m 0.001 --speed-tolerance-mps 0.001
```

Without `--out`, stdout is the complete stored scenario-debug/v1 wire report.
With `--out`, stdout is a concise JSON summary and the directory
contains:

- `report.json` — complete paths, actions, diagnostics, metrics and acceptance;
- `summary.json` — compact repair-loop input;
- `paths.json` — scene-frame native and SUMO time series plus signal phases;
- `input.json` — the exact concrete input that ran (including CLI duration override);
- `compiled-instance.json` — the materializer's provenance-bearing instance before runtime overrides;
- `trace.json.gz` — the canonical engine trace.

Native actor samples include position, heading, speed, derived acceleration,
lane/road identity, route distance, presence and dynamic telemetry. Diagnostics
include engine issues, route coverage, backend provenance/fallbacks, collisions,
crashes, road departures, rejected lane changes, never-fired triggers and
preemptions. Actions carry their firing/release events. Required template
invariants and selected strict gates determine exit status.

SUMO is intentionally fail-closed. `--provider sumo` requires the pinned
`dev-assets/sumo-runtime/{sumo.mjs,sumo.wasm,runtime-manifest.json}` and the
selected map's `derived/sumo/sumo-network-manifest.json`; missing assets produce
an actionable `sumo_unavailable` error rather than silently changing providers.
The current lean bridge reports SUMO positions, heading, speed, acceleration,
lane position and indicators. It does not yet expose the SUMO lane/road ID or
its internal traffic-light phase; those limitations are explicit in the report.

## ASAM interchange

`simforge export` targets the current official releases: ASAM OpenSCENARIO XML
1.4.0 (`.xosc`) and ASAM OpenSCENARIO DSL 2.2.0 (`.osc`). It exports the
**concrete instance**, after matching, parameter sampling and arrival solving.
Every lane/follow/polyline route is resolved through the instance map graph and
sampled into world-coordinate waypoints, so an exported file never mistakes
SimForge' lane-local `rsl:s` for OpenDRIVE road `s`.

`xosc-1.3-esmini` is a separate compatibility target for a pinned external
esmini runner. It is authored as OpenSCENARIO XML 1.3.1 and never relabels the
native 1.4 artifact. The runnable-bundle API validates it with the pinned
official 1.3.1 XSD, resolves the complete immutable OpenDRIVE file server-side
from `mapId + sha256`, and packages the canonical trace and explicit capability
and provenance reports. Its deterministic-trajectory profile claims motion
parity only; lowered presentation cues remain visible in the capability report.

Both profiles export vehicle/pedestrian dimensions, initial world pose and
speed, resolved paths, static occluder geometry, clip duration and absolute
speed changes. The CLI's XML 1.4 path uses deterministic trajectory replay: it
runs the concrete instance, emits absolute-time `FollowTrajectoryAction`
vertices (including signed reverse speed), replays standard lights and vehicle
component animations at their observed firing times, and schedules physical
signal-head states from the trace. Motion-rule, route, speed and lane-change
interactions are embodied in that trace instead of being delegated to
simulator-specific controllers. Simulation/arrival errors, incomplete signal
tracks, unsupported entity spawning, and state without an exact XML carrier
reject the export.

The library also exposes an action-oriented XML profile for consumers that need
editable controller actions. It supports relative speed targets, relative
left/right lane changes, dynamic route replacement, add/delete entity actions,
`at`/`after` triggers, a documented subset of `when` conditions, and looping
traffic-signal controllers. In that profile, a signal program is exported only when its
`mapBinding.controllerHeadGroups` closes the ordered physical OpenDRIVE
controller-stage membership to the bound head ids. One logical scenario
program may emit several `TrafficSignalController` elements, each named with
its physical OpenDRIVE controller-group ID and containing only that group's
head ids as `TrafficSignalState` entries. No self-reference is synthesized;
phase conditions reference the first ordered physical controller in the bound
program. The complete controller/head closure is retained in header
properties. Controller offsets are represented by rotating (and, when
necessary, splitting) the phase cycle. A
persistent SimForge signal override is rejected in the action profile
because an XML phase action does not have the same semantics. DSL 2.2 supports statically resolvable `at`/`after`
schedules, linear speed transitions, time-constrained lane changes, gaps and
metre lane offsets.

The ASAM timeline starts at the beginning of the instance warm-up. Therefore an
engine trigger at `t` is exported at `t + warmupSeconds`, and the ASAM stop time
is `warmupSeconds + clipSeconds`. The recorded SimForge `t=0` remains the
same physical instant instead of silently dropping pre-roll behavior.

When the input is a materialized instance file, replay-key fields and its input
hash are carried into XML `FileHeader/Properties` or DSL header comments. A bare
`SimScenarioInput` has no manifest, so an exporter cannot reconstruct template,
site, matcher, solver, draw or seed provenance from that file alone.

The command never silently substitutes a different behavior. Unsupported
controller rules, dynamics, conditions, deadlines, entity lifecycle, signal
bindings, fixed props, static road controls, or action forms produce exit 2 with
`{code:"asam_export_unsupported", detail:{issues:[{code,path,reason}]}}`.
SimForge-only metric subjects and occlusion-evaluation pairs are reported as
warnings; their physical actors and occluders are still exported.

The default referenced road file is `<mapId>.xodr`. Use `--road-file` to write
the path used by the target simulator. XML tests fetch [ASAM's official 1.4.0
schema archive](https://publications.pages.asam.net/standards/ASAM_OpenSCENARIO/ASAM_OpenSCENARIO_XML/v1.4.0/_attachments/generated/ASAM_OpenSCENARIO_v1.4.0_Schema.zip)
and require SHA-256
`efbb2da3432ef8bb9f87daa9d710fb20a2ad65276bc386d28885a5fe9511a39c`;
the extracted `OpenSCENARIO.xsd` must hash to
`949fe2bcebd1f3fdb941a2cc56641482737ab48e3c5b0eed0ee5294b2355c0e9`.
`ASAM_OPENSCENARIO_14_XSD` may point to a local copy, but it must have that same
XSD digest. To update the pin, obtain a newly versioned official ASAM
deliverable, review its model/schema changes and exporter mappings, update both
digests and fixtures, and rerun all semantic rejection and XSD tests.

DSL 2.2 output is gated by a deterministic parser for the exact concrete
grammar profile emitted by this package. The test pins ASAM's official 2.2.0
`grammar.ebnf` at SHA-256
`77acf08e7a8a9f424358452d4f955e4dcd15636468aba7b18ba644ce9edc619b`
and verifies that the implemented subset is drawn from its import, scenario,
constraint, composition, invocation, modifier and wait productions. A second
pin checks the official 2.2 domain-model library archive at SHA-256
`b18ee980a48b9e71db8612b846f04be10dfba4cbb82944a48806078721879fa3`
and audits every actor category and action/modifier symbol emitted. This is a
syntax/profile guarantee, not a claim that the repository implements the full
DSL type system or a general-purpose compiler. XML 1.4 remains the interchange
path with full official XSD validation.

`locations` is the model's spatial awareness: it never sees a road id, it
queries by semantics and receives **handles**, road anchors and
`matchedReasons`. Everything below the handle is carried through for the layers
that need it.

## The materializer

`simforge instantiate` is the only genuinely new code in this package — everything
else composes the four packages below it. The four layers are each deliberately
incomplete: the matcher does the *structural* pass and stops, the engine takes a
*fully resolved* document and refuses anything less. `src/materialize.ts` is the
join.

```
1. PARAMS    paramSeed = sha256(templateId|paramsVersion|siteId|drawIndex)
             → xoshiro128**, one forked stream per declaration, so inserting a
               parameter does not resample the ones declared after it
2. FRAME     the site's AnchorFrame reference path is rebuilt as a sim-engine
             Route — that is what turns a frame `s` into a world point
3. ROLES     each FeatureBinding becomes a concrete actor. Its route comes from
             the binding's lane chain; its spawn comes from *projecting the
             frame point onto that route*, never from re-adding lane lengths
4. TIMELINE  v2 interactions → engine interactions, verb by verb. `set rules.*`
             and `route(polyline)` at `t ≤ 0` fold into the actor's initial
             state, because a thing that happens at spawn *is* spawn state
5. ARRIVAL   every `conflicting_gate` role with `arriveAtConflict`, and every
             timeline `arrival` trigger, is back-solved by `sim-engine`'s
             bisection and baked into the instance
6. GUARDS    `checkFeasibility` — runway, decel budget, spawn overlap, route
             connectivity — reported as structured findings
```

### Why projection, not arithmetic

A role's pose is `(k, s)` in the anchor frame. Adding up lane lengths until `s`
is consumed is wrong for every role that is not on the reference lane: `k = +1`
and opposing lanes have their own arc-length origins, and two packages measuring
the same polyline disagree in the sixth decimal. So the frame `s` becomes a
**world point** on the reference route, and that point is projected onto the
actor's own route. The packages only have to agree about geometry, never about
bookkeeping.

### Two places the materializer checks the matcher's work

- **Upstream coverage.** The matcher builds a role's lane chain from the
  *statically* evaluated `dsM`, which is `0` whenever the spawn is a
  site-dependent expression like `-(0.8 * lane.speedLimitKph / 3.6) * 8`. Using
  that chain would spawn the ego *past* the junction it was supposed to
  approach. So the chain is extended upstream until the target point projects
  into the route's interior rather than onto an endpoint.
- **Downstream runway.** The matcher stops walking at its own 150 m run-up
  constant. A 16-second clip at 51 kph covers 227 m. The chain is extended
  forward until it covers the clip, because the materializer is the only layer
  that knows both the clip length and the actor's speed.

### Traffic-light materialization

On signalized sites with OpenDRIVE controller data, SimForge binds the
physical map head ids, junction controller sequences and concrete gate
movements into engine `signalPrograms`. Stop lines retain their junction
connecting-lane filter, so a protected turn head cannot govern an unrelated
movement on the same approach. Authored signal conditions resolve either a
physical head handle or a junction feature plus `ego|opposing|left|right`
approach.

The checked-in maps do not contain authoritative phase-duration timing files.
Generated cycles are therefore marked `mapBinding.timingSource =
"synthetic-default"`; the ids and movement bindings are real, the durations are
not presented as field truth. Maps with no dynamic heads/controllers emit an
empty `signalPrograms` list, with no invented fallback signals.

## Replay keys

Every instance carries the key that reproduces it:

```json
{ "templateId": "ltap-opposing", "templateVersion": 2, "templateDigest": "…",
  "mapId": "yale-street", "topologyDigest": "…", "siteId": "…",
  "matcherVersion": "…", "solverVersion": "…", "paramSeed": "…", "drawIndex": 0 }
```

`simforge batch` resumes on all of it, not just the seed: a cached verdict from an
older matcher or an older engine is exactly the stale answer a resumable batch
exists to prevent.

## Deterministic five-map catalog

`simforge catalog create` reserves exactly **100 identities on each of the five
supported maps** (500 total) before expensive generation begins. Every slot
carries the map catalog revision and topology digest, template source/digest and
archetype category, a coordinate-derived SHA-256 seed, status, and reserved
instance/trace/result/frame/video/inspection paths. The output has no clock
field: identical templates and map provenance produce byte-identical JSON.

`simforge catalog verify` rejects changed seeds or identities, duplicate identities
or seeds, missing/duplicate ordinals, anything other than the canonical 5 × 100
shape, provenance drift, unsafe evidence paths, and a stale catalog digest.
`reserved` slots do not pretend evidence exists. Advancing status makes evidence
mandatory (`generated` requires an instance, `simulated` also trace/result,
`rendered` also frame/video/render manifest, and `visually-proven` also a written
inspection). `--require-evidence` checks every reserved evidence path.

## Batch

Sites × draws, per-cell seeds, a worker-thread pool (the engine is synchronous
CPU work, so an async pool in one thread would run it strictly serially), and a
sorted summary that does not depend on which worker finished first.

```
out/
  batch-summary.json
  <mapId>/<siteId>/draw-000.instance.json
                   draw-000.trace.json.gz
                   draw-000.result.json
```

`catalog batch` is the lifecycle-aware companion for the 500-slot catalog. It
writes a checkpointed execution ledger, uses each reservation seed for attempt
zero, records deterministic bounded draws, and advances a slot only after its
reserved artifacts exist. Unsupported authored mechanisms, template-backed
slots without an exact persisted catalog-location/matcher-site join, and
operational variants not actually applied by the materializer/engine, and
template/map combinations with no executable site are structured findings
(exit 2), never simulated counts. `SIGINT`/`SIGTERM` stop new dispatch; rerunning
the same command validates accepted artifact hashes and resumes the ledger.
Collision-free execution is a hard eligibility rule by default and is recorded
in every result; `--allow-collisions` is the explicit opt-out for mechanisms
whose authored outcome intentionally includes contact.

For a cancellable campaign, invoke the CLI process directly so `SIGINT` and
`SIGTERM` reach its checkpoint handler instead of stopping a package-manager
wrapper first:

```bash
node packages/cli/bin/simforge.js catalog batch \
  catalog/simforge-oss-five-map-v2.catalog.json \
  --ledger catalog/catalog-execution-ledger.json \
  --attempts 3 --concurrency 4 --filter all --pretty
```

The handler stops new dispatch, removes any uncommitted interrupted work, moves
in-flight slots back to `pending`, writes ledger status `cancelled`, and exits
with validation-findings status. Re-running the identical direct command
reconciles a ledger left by a hard process loss: stale `running` records become
`pending`, completed evidence is hash-checked, and the interrupted attempt
number and deterministic seed are retried rather than consumed.

## Map masters and render-worker map inputs

A published map version is one **master** closure plus one **web** closure.
The master is `master.gltf` + `geometry.bin` (every accessor byte of the
RoadRunner/Unreal export, verbatim) + `images/<sha256>.png` (the authored
rasters) + `images/<sha256>.ktx2` (their UASTC encodes, referenced through
`KHR_texture_basisu`) + the road sidecars (`map.xodr`, `topology-index.json.gz`,
`lane-polygons.geojson.gz`, `signals.geojson.gz`, `derived/*`) + `env/sky.hdr`
+ `master-report.json`. The web closure is `3d/manifest.json`, `3d/tiles/*.glb`
(100 m meshopt cells with `EXT_mesh_gpu_instancing`) and the KTX2 images the
cells reference.

`simforge maps build <export-dir> --name <slug> --work-dir <dir>` builds both
stages (content-addressed and cached under `<dir>/master/<key>/content` and
`<dir>/web/<key>/content`); `simforge maps ingest` runs the same stages and
publishes them. `simforge maps pull <name>@<version>` materializes, through a
local blob cache (`--blob-cache-root`, hardlinked into every layout):

- `.corpus/<name>` (`--native-corpus-root`): the master without its PNGs -
  what the Bevy renderer loads; `nativeWorkerInputs` is exactly one entry,
  `map.tile.000000` = `master.gltf`, with its verified `sha256`/`sizeBytes`;
- `map-bundles/<name>` (`--browser-root`): the web closure;
- `dev-assets/<name>` (`--dev-assets-root`): the sidecars alone, or the whole
  master including PNGs with `--archive`.

Versions published before the master format (tiled canonical closures) are
refused by `pull`; re-ingest them.

## Current execution boundaries

Stated plainly, because they bound what a number from `simforge` means:

- **Physical signal timing is explicit about provenance.** OpenDRIVE controller,
  stage, and head membership are map-bound. Where the map has no authoritative
  phase durations or initial state, the materializer records the deterministic
  cycle as `synthetic-default`; it never presents that timing as map-authored.
  XML 1.4 action export supports these programs, while DSL 2.2 export rejects
  signal-program inputs instead of silently losing them.
- **Catalog variants are executable.** The reserved operational variant is
  applied during materialization and closed against the slot identity. A batch
  refuses a template-backed slot whose materialized variant differs.
- **Props carry executable semantics.** Catalog behavior determines visibility
  occlusion and collision geometry, with per-prop overrides where authored.
  `targetRevealToConflictS` remains an asserted/reportable target rather than a
  free placement solver.
- **Prop footprints are mirrored, not imported.** `prop-catalog` depends on
  three.js; `src/prop-dims.ts` copies the dimensions of the props that can
  occlude, and a test reads the catalog as text to catch drift.
- **`route(turn|toFeature|acquire)` is dropped with a note.** Topology is fixed
  by the role binding's lane chain at instantiation time, so the timeline entry
  would be a no-op restatement.

## Tests

```bash
pnpm --filter @simforge-oss/cli test
```

The pure tests (adapter, seeding, prop-dims) always run. The materializer and
CLI smoke tests read `dev-assets/`, which is gitignored, and `skipIf` themselves
on a clean checkout.
