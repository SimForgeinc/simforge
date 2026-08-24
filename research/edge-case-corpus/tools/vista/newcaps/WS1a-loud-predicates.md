# WS-1a — make silent predicate drops loud (IN PROGRESS)

Worktree `UniScenarios-vista` @ `vista-lane`. Owner: WS-1a agent. Status: **investigation complete,
implementation starting**. This file is written early and updated as work lands, per parent process rule.

## BOTTOM LINE (provisional)

The silent-drop path is **one function**: `packages/compiler/src/adapt.ts` →
`adaptTemplate()`. It records every discarded authored clause as an `AdaptNote {path, reason}` and
returns it; `template validate` prints those notes under an `adapter/note` heading and still exits 0,
and `sites match` puts them in `payload.adapterNotes` and still returns sites at score 1.00. Nothing
anywhere converts a note into an error. The three confirmed drops
(`feature kind "crest" is not matchable; feature dropped`, `the matcher has no parking-zone
predicates; clause not evaluated`, `adjacent kind "rail"/"bus"/"none" is not evaluable`) are all
emitted from that file, at `adapt.ts:300`, `adapt.ts:408` and `adapt.ts:192`.

Both missing capabilities are **cheap and the data exists**, verified directly against
`dev-assets/*/derived/locations.json.gz`:

* **crest** — 13 locations carry `facts.crest_present = true`, on locations of `type:
  "driving_corridor"`. `driving_corridor` is **not** in `normalize.ts`'s `LOCATION_KIND_MAP`, so those
  facts never become `PointFeature`s today. Adding a `crest` kind is: one entry in the location→kind
  map (guarded on `crest_present`), one enum member in `FeatureKindSchema`, one line in
  `FEATURE_KIND_MAP` in adapt.ts. **`sag` has no published fact** — there is no `sag_present` /
  `trough` key anywhere in the fact index — so sag is NOT symmetric and will not be added.
* **parking predicates** — `parking_lane` / `parking_area` / `parking_space` already normalize to
  `PointFeature.kind = 'parking_zone'`. The authored predicates map onto published facts:
  `orientation` ← `is_parallel_parking` / subtype `angled|parallel`, `capacity` ← `space_count`,
  `lengthM` ← `parking_length_m` / extent radius. **`occupancy` has no map evidence at all** and must
  report `supported: false` (loud when required) rather than silently pass.
* **`supported_scenario_templates`** — present on all 275 occlusion zones, but it is a **JSON array**,
  and `normalize.ts:pointFeaturesFromLocations` filters `facts` down to `string | number | boolean`,
  so the array is dropped before the matcher ever sees it. Surfacing it needs the `PointFeature.facts`
  value type widened to admit `readonly string[]` (only consumer is `factValue()` in `clauses.ts`).

## PLAN

A. `AdaptNote` grows `severity: 'note' | 'error'` + `code`. A discard is an **error** when the
   discarded clause's `essentiality` is `required` or `preferred`, and stays a **note** when it is
   `cosmetic` — `cosmetic` is the escape hatch that already exists in the schema ("freely relaxable"),
   no new opt-out is invented. `template validate` emits them as `severity: error`, code
   `clause_unmatchable`, exit 2. `matchOnMap()` in `packages/cli/src/sites.ts` (the single seam every
   command goes through) throws `CliError('clause_unmatchable', …)`.
B. Add `crest` feature kind + parking-zone predicates (`orientation`, `capacity`, `lengthM`;
   `occupancy` unsupported-by-evidence).
C. Add a `supportsScenario` clause readable from an anchor feature, backed by
   `facts.supported_scenario_templates`.

## BASELINE TEST COUNTS (measured BEFORE any change, this worktree, `npx vitest run` per package)

| package | files | tests |
|---|---|---|
| anchor-matcher | 12 passed | **128 passed, 0 failed** |
| scenario-model | 19 passed | **297 passed, 0 failed** |
| scenario-materializer | — | **75 passed, 0 failed** |
| cli | 29 failed / 11 passed / 1 skipped | **70 failed, 299 passed, 1 skipped (370)** |

The 70 cli failures are PRE-EXISTING and unrelated (the parent brief said ~67). Baseline failing test
names are saved to `/tmp/cli-baseline-failnames.txt` and are diffed after the change.
