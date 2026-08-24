# UniScenarios execution baseline

> **Historical audit, superseded.** This file records the repository state on
> 2026-08-01 and is retained as evidence; its missing-capability statements are
> not the current architecture or release status. See
> [`simcloud-convergence.md`](./simcloud-convergence.md) for the current
> UniScenarios/SimCloud ownership and acceptance contract.

Date: 2026-08-01
Scope: current dirty local checkout; no commit was made.

## Claim discipline

This document uses four independent columns:

- **Implemented** — code/data exists in this checkout.
- **Tested** — a written automated check exists and/or the stated command was run.
- **Visually proven** — a human/agent actually opened the cited image or decoded video frame. A manifest alone is not visual proof.
- **Missing** — work required before the requirement is complete.

A deterministic identity is not an incident. The new catalog contains **500
reserved slots (100 per map), not 500 generated, simulated, accepted, rendered,
or visually validated incidents**. Its normal verification correctly does not
require files for `reserved` status; status advancement and
`--require-evidence` do require evidence.

Seven replacement same-task, read-only Pi AgentRuns audited map assets,
generation scale, simulation/realism, renderer evidence, traffic lights, ASAM
OpenSCENARIO XML 1.4.0, and ASAM OpenSCENARIO DSL 2.2.0. All used
`openai-codex/gpt-5.6-sol` with High reasoning and returned terminal results.
The parent independently inspected the worktree, manifests, and representative
images cited below.

## Requirement matrix

| Requirement | Implemented | Tested | Visually proven | Missing / exact boundary |
|---|---|---|---|---|
| Canonical five-map registry | Yes: `KNOWN_MAPS` and Studio `MAPS` enumerate the same five IDs | `uniscenarios maps list`; CLI suite | Map selector visible in five editor screenshots | Registry is local-dev data, not a distributable asset package |
| Map topology, semantic locations, search and derived indexes | Yes on all five local maps | `uniscenarios maps list` reports all four CLI artifacts present for every map; map-intel tests exist | Not a visual claim | Grade capability is false on all maps; semantic coverage differs by map |
| Streamed 3D scene and lane/signal overlays | Yes on all five; 3D manifests and overlay payloads are present | Five-map renderer/editor evidence manifests and tests | Yes: one editor screenshot for each map was opened | Asset fidelity is uneven; Easterbrook/Richmond use v1.1 manifests and lack shadow lightmaps |
| Manual editor placement/persistence | Yes | `artifacts/qa/milestone-20260801T120835Z/editor-five-map/report.json` records placement on all maps and persistence checks | Yes: five editor screenshots opened | Editor authors actor-placement documents, not full v2 anchor/parameter/choreography campaigns |
| V2 portable template/schema | Yes: anchors, params, roles, props, choreography, invariants, variants | Scenario-model and CLI suites | N/A | Variants are parsed but not applied; several authored actions are dropped or rewritten during materialization |
| Site matching and concrete materialization | Yes | Real-map materializer tests and CLI end-to-end smoke tests | N/A | Template/map feasibility is nonuniform; unsupported semantics remain |
| Deterministic per-cell batch/replay | Yes: coordinate-derived seeds, sorted planning, worker pool and resume keys | CLI resumable batch test; prior campaign contains a 3-cell byte-repeat check | N/A | Catalog reservations are not yet wired to batch attempts, replacement policy, or atomic status updates |
| Existing machine-generated campaign | Yes: prior occluded-pedestrian campaign records 840 simulated cells, 777 accepted, 753 promoted | Campaign summaries and traces exist | No campaign-scale visual evidence | Campaign predates current static-actor/occlusion changes; Richmond has only 64 promoted; it is not the new 500-slot catalog |
| Exactly 100 deterministic identities per map | Yes: 500 catalog slots, exactly 100/map | Six focused catalog tests; real CLI create/verify; byte-repeat comparison | N/A | These are all `reserved`, not incidents |
| Duplicate/shape/provenance rejection | Yes: duplicate identity/seed, wrong 5 × 100 shape, ordinal, seed, identity, provenance, path and digest checks | Focused mutation tests | N/A | No atomic multi-process catalog updater yet |
| Missing-evidence rejection | Yes: evidence required by status; `--require-evidence` requires all seven paths | Focused tests prove `simulated` rejects missing instance/trace/result and complete mode rejects absent bundles | N/A | Verification currently checks path existence, not instance↔trace↔render semantic/hash closure |
| Fixed-step simulation and trace metrics | Yes: routing, triggers/actions, arrival solving, OBB collisions, TTC/deceleration/occlusion metrics | Functional determinism, static-actor, occlusion, guard/evaluator tests exist | N/A | Simplified path following, 2-D LOS and closing-speed TTC are not a physical-realism model; continuous collision and road/environment collision validation are absent |
| Realism/acceptance validator | Partial feasibility and criticality gates only | Unit tests cover those gates | No | No reference-data realism gate, no perceptual threshold, ineffective occlusion can still pass, collision rejection is optional, unchecked invariants/never-fired triggers can avoid failing validation |
| Corrected Yale bus-stop simulation | Yes: input/trace report no collisions and hash-linked actor IDs | Manifest/hash/composition checks | Yes: corrected Studio frame and multiple live playback scrub screenshots were opened | No written human realism acceptance; only one incident on one map |
| Actual Studio playback | Yes for the corrected Yale bus-stop case; import, play/pause and scrub evidence exists | Playback model tests and live manifest acceptance checks | Yes: t=0, 6.9 and 7.4 screenshots opened | Five-map incident playback has not been produced; accepted live MP4 contains substantial startup/loading time |
| Deterministic frame/video export | Yes for the Yale corrected case; key frames, 54-frame MP4 and source snapshots | Export tests and hash recomputation evidence | Yes: representative golden frame opened | Cross-run WebGL pixel determinism, stream-completeness failure gating and external trust anchoring are absent |
| Visual realism acceptance | No | No reference/perceptual acceptance test | Inspected images show prototype geometry, but that is not realism acceptance | Simplified/flat assets, sparse scenes and visible rendering seams remain; 0/500 catalog slots are visually proven |
| Static traffic-signal furniture | Yes on all five | xodr-tools/renderer tests and evidence counts | Yes in five-map editor stills | Simultaneously coloured lamps prove geometry only, not state |
| Dynamic traffic-light semantics | Synthetic engine programs exist | Synthetic signal/trigger tests | No phase transition was visually inspected | Production map context supplies no programs, materializer emits `signalPrograms: []` and drops signal predicates, renderer has no live-state API, authored and engine vocabularies differ |
| ASAM OpenSCENARIO XML 1.4.0 | No exporter/importer/conformance layer | No OSC-focused tests or fixtures | No | Add a concrete interchange IR, official 1.4 XSD set, secure XML I/O, catalogs, OpenDRIVE packaging/lane conversion, signal bindings, golden/negative/round-trip and interoperability tests |
| ASAM OpenSCENARIO DSL 2.2.0 | No parser/AST/exporter/importer/conformance layer | No OSC-focused tests or fixtures | No | Pin grammar/toolchain, define logical-template vs concrete-instance profiles, resolve materializer semantic loss and signals, then add official-compatible validation and round trips |

## Five-map asset and readiness inventory

`node packages/cli/bin/uniscenarios.js maps list` was run against the local
`dev-assets/`. All five report topology index, derived topology, locations and
search index present. Raw overlay counts come from the committed-format local
GeoJSON sidecars; rendered counts may be smaller when corrupt features are
skipped.

| Map | Local files / bytes | Locations | Engine lanes | Segments | Derived junctions / conflicts | Signalized junctions | Raw lane polygons / signal features | 3D tiles / vegetation tiles | Manifest / shadow | Visual evidence opened | Exact readiness gap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| `yale-street` | 492 / 2,959,406,559 | 2,325 | 1,141 | 127 | 56 / 585 | 16 | 1,144 / 164 | 33 / 40 | v1.2 / yes | editor still; corrected playback frames | Saved capture had 51 queued and 3 loading streams; 14 unreferenced files (25,323,065 bytes); four malformed signal features are skipped |
| `belmont-research-center` | 453 / 1,279,030,092 | 2,153 | 970 | 122 | 74 / 570 | 0 | 970 / 58 | 29 / 60 | v1.2 / yes | editor still | Saved scene containment false and 28 streams queued; 24 unreferenced files (71,061,596 bytes); topology has 75 junctions while derived has 74; no dynamic controllers |
| `el-camino-road` | 391 / 995,274,474 | 2,723 | 1,001 | 139 | 68 / 607 | 6 | 1,009 / 74 | 14 / 49 | v1.2 / yes | editor still | Saved scene containment false and 37 streams queued; 20 unreferenced/evaluation files (31,527,921 bytes); no inspected incident playback |
| `easterbrook-discovery-school` | 44 / 81,236,220 | 724 | 563 | 63 | 17 / 615 | 0 | 566 / 62 | 3 / 4 | v1.1 / no | editor still | Saved scene containment false; smallest 3D/semantic inventory; no dynamic controllers, shadow asset or inspected incident playback |
| `richmond-field-station` | 70 / 565,312,101 | 682 | 370 | 55 | 31 / 182 | 1 | 371 / 50 | 7 / 4 | v1.1 / no | editor still | Saved scene containment false and visibly sparse; 10 unreferenced files (5,506,941 bytes); no shadow; prior campaign only 64 promoted |

Local total: **1,450 files, 5,880,259,446 bytes (5.476 GiB)**. Every
3D-manifest reference exists and its declared size matches. The five-map audit
also found registry duplication across Studio, map builder/tests and export
script with no parity test, and live real-manifest renderer coverage remains
Yale-centric.

The five inspected map screenshots prove that each local city scene, road/lane
overlay, signal furniture, catalog actor placement and editor UI rendered. They
do **not** prove scenario correctness, traffic-light phase behavior, dynamics,
or realism.

### Traffic-light inventory boundary

Direct OpenDRIVE/sidecar audit found:

| Map | OpenDRIVE signals | Dynamic signals | Controllers | Sidecar features | Sidecar traffic lights |
|---|---:|---:|---:|---:|---:|
| Belmont | 50 | 0 | 0 | 58 | 0 |
| Easterbrook | 54 | 0 | 0 | 62 | 0 |
| El Camino | 73 | 30 | 8 | 74 | 29 |
| Richmond | 39 | 12 | 8 | 50 | 8 |
| Yale | 143 | 69 | 26 | 164 | 59 |

Controllers group signal IDs but no checked-in phase-timing `*_rrdata.xml` assets
exist. The production seam remains intentionally empty in
`packages/cli/src/map-context.ts` and `packages/cli/src/materialize.ts`.

## Existing generation/simulation evidence

The prior `campaigns/occluded-pedestrian/manifest.json` is real machine
simulation evidence, but it must not be confused with the new catalog:

| Map | Prior promoted cells |
|---|---:|
| Yale | 209 |
| Belmont | 152 |
| El Camino | 156 |
| Easterbrook | 172 |
| Richmond | 64 |

Total: 840 cells, 777 accepted, 753 promoted. No single archetype/map cell has
100 outputs, several combinations are zero, and the campaign predates current
dirty-worktree fixes. The campaign contains no visual frames/videos. It cannot
establish a current, balanced, visually accepted 100-per-map corpus.

The most important trust gaps are:

1. no deterministic catalog-slot executor or bounded replacement attempt order;
2. catalog seeds/identities are not yet passed through materialization and batch output IDs;
3. no atomic lifecycle command advances reservation → generated → simulated → rendered → visually-proven;
4. no semantic evidence closure from slot to instance replay key, trace input hash, result verdict, render manifest hashes and visual-inspection verdict;
5. no feasibility-aware redistribution when a template has zero sites on a map;
6. no 500-output concurrency/resume/interruption/drift/tamper test;
7. no regenerated campaign under the current static-actor and occlusion semantics;
8. no campaign-scale visual or realism acceptance.

## Implemented foundation: deterministic catalog

Files:

- `packages/cli/src/catalog.ts`
- `packages/cli/src/commands/catalog.ts`
- `packages/cli/src/__tests__/catalog.test.ts`
- CLI wiring in `packages/cli/src/main.ts` and exports in `packages/cli/src/index.ts`

CLI:

```bash
node packages/cli/bin/uniscenarios.js catalog create \
  --out artifacts/qa/uniscenarios-catalog-sample-20260801/catalog.json
node packages/cli/bin/uniscenarios.js catalog verify \
  artifacts/qa/uniscenarios-catalog-sample-20260801/catalog.json
```

The catalog binds every reservation to:

- stable identity and full SHA-256 seed;
- map ID, map asset ID, map catalog revision and topology digest;
- template ID/source/digest and archetype category;
- status;
- reserved instance, trace, result, render-manifest, frame, video and visual-inspection paths.

It rejects duplicate identities/seeds; map/ordinal/cardinality drift; changed
seed/identity/provenance; unsafe paths; digest mismatch; and evidence missing for
the current status. `reserved` means no evidence exists and makes no stronger
claim.

Sample artifact:

- Manifest: `artifacts/qa/uniscenarios-catalog-sample-20260801/catalog.json`
- Verification: `artifacts/qa/uniscenarios-catalog-sample-20260801/verification.json`
- Catalog digest: `36e033a2e581dc8957d359816abfd52dd23e171a67e64778ce66ad233cfff2c5`
- Manifest file SHA-256: `c39199e9be27e0112faa56c288d613387a0a72846013b60e26e1d80d8c418d64`
- Shape/status: 500 total, 100 on each map, all 500 `reserved`, `evidenceChecked=false`, zero verification issues.
- A second create was byte-identical (`cmp` passed with the same file hash).

## Visual evidence personally inspected for this baseline

The parent opened:

- all five `artifacts/qa/milestone-20260801T120835Z/editor-five-map/03-map-*.png` screenshots;
- `artifacts/qa/golden-yale-bus-stop-20260801-corrected/studio-render/frames/frame-002.png`;
- live playback screenshots at t=0, t=6.9 and t=7.4 under
  `artifacts/agent/studio-live-playback-final-20260801T190026Z/`.

Observed only: all five city/editor scenes render; the corrected Yale frame
shows bus/ego/pedestrian geometry on the road; playback screenshots show
different actor states and later pedestrian absence. The images are
prototype-grade and were not evaluated against reference imagery. Therefore
this baseline makes no photorealism or human-behavior-realism claim.

## Verification performed in this milestone

```text
pnpm --filter @uniscenarios/cli typecheck
  PASS

pnpm --filter @uniscenarios/cli exec vitest run src/__tests__/catalog.test.ts
  PASS — 1 file, 6 tests

pnpm --filter @uniscenarios/cli exec vitest run --maxWorkers=1
  PASS — 6 files, 60 tests

pnpm --filter @uniscenarios/sim-engine typecheck
pnpm --filter @uniscenarios/anchor-matcher typecheck
pnpm --filter @uniscenarios/map-intel typecheck
pnpm --filter @uniscenarios/scenario-model typecheck
  PASS — all four

node packages/cli/bin/uniscenarios.js catalog verify \
  artifacts/qa/uniscenarios-catalog-sample-20260801/catalog.json
  PASS — 500 slots, 100/map, 500 reserved, 0 issues

catalog create repeat + cmp
  PASS — byte-identical
```

Parallel default CLI test execution was observed by audits to hit existing
5-second subprocess test timeouts under load. The controlled single-worker run
above passed all 60 tests; this does not erase the timeout/flakiness risk.

## Remaining release blockers, in order

1. Build a slot executor that deterministically selects site/draw attempts,
   passes catalog seeds into materialization, replaces rejects with a bounded
   reproducible policy, and either reaches 100 accepted incidents/map or emits
   a reproducible shortfall.
2. Add atomic lifecycle/status updates and semantic evidence verification,
   including `verifyEvidenceHashes`, replay coordinates, render hashes and a
   structured visual-inspection verdict.
3. Regenerate and re-evaluate the campaign under current engine/materializer
   semantics; make collisions, ineffective/unmeasurable occlusion, never-fired
   required triggers and unchecked required invariants hard gates.
4. Produce actual Studio renders and human inspection records per accepted
   incident; do not promote catalog slots based only on existence or metrics.
5. Complete map-bound traffic signal programs/head/stop-line bindings and live
   renderer state before signal-dependent incidents or exports.
6. Implement and officially validate ASAM OpenSCENARIO XML 1.4.0 and DSL 2.2.0;
   current support for both is zero.
7. Package/licence the five map assets for a truly portable open-source release;
   current `dev-assets/` is local and gitignored.
