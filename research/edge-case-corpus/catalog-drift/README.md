# `catalog verify` failure — diagnosis

## Symptom
`simforge catalog verify catalog/uniscenarios-five-map-v2.catalog.json` exits 2 with
7 issues: 6 x `invalid_provenance` (designDigest mismatch) + 1 `catalog_digest_mismatch`.
All 6 are the same incident, `lane-change.lane-drop-late-merge`, on yale-street and el-camino-road.

## Root cause — matcher drift, not corruption
The digests are stale because the **site bindings changed**. For that incident the stored
`matcherSiteId` is `2282b44455e98df3`; the current matcher produces `0a8fc7e0ff2a6cad`, and the
incident's slot count fell from 6 to 4. `catalogDesignDigest` covers all authored fields, so a
re-bound site invalidates the digest.

The 7 reported issues are the visible tip. Comparing slot identities against a freshly generated
catalog: **378 of 500 identities no longer reproduce** under the current matcher and
derived map indexes — 37 distinct incident types, led by
`intersection.opposing-turn-encroachment` (22), `workzone.worker-intrusion` (20),
`obstacle.disabled-vehicle` (18).

**`catalog verify` failing is correct behaviour.** `docs/research/retargeting.md` is explicit:
"Stamps: mismatch => re-derive, never trust. Re-match with a visible diff on digest change; never
silently re-bind." Recomputing the 6 digests would be precisely the silent re-bind the design
forbids, and would leave the other 372 drifted bindings hidden.

## Fix
Re-derive. `simforge catalog create` regenerates all 500 slots and the result **verifies clean**
(exit 0, 0 issues, 100 slots per map, all five maps). The re-derived catalog is checked in here as
`uniscenarios-five-map-v2.rederived.catalog.json` (digest `ae4a28462693cd4c...` vs
committed `688dd78dadc62d5c...`).

**Not applied automatically.** The committed catalog is a provenance artifact and swapping it is a
deliberate act, so it is left to a human. Nothing downstream depends on the stale bindings: the
committed catalog reports `authored 500, generated 0, simulated 0, rendered 0, visuallyAccepted 0`,
so no evidence is invalidated by re-deriving.

To apply:
```sh
node packages/cli/bin/simforge.js catalog create --out catalog/uniscenarios-five-map-v2.catalog.json
node packages/cli/bin/simforge.js catalog verify catalog/uniscenarios-five-map-v2.catalog.json
```
