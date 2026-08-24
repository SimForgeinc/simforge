# RESUME HERE — held-out run is 12/60 complete

## 1. State
- **Authoring model pivoted** (user-directed) from the archetype-grammar compiler to **agent-native
  tool authoring**. The grammar compiler is dead; its enumeration survives only as a coverage ledger.
- **Tool surface FROZEN** at tooldoc sha256 `acd3b247746af7ab`, 16 operations,
  `research/edge-case-corpus/tools/scenario_tools.py`. No tool or prompt change is permitted until
  HELDOUT completes.
- **Brief corpus**: 92 briefs across all 15 taxonomy categories,
  `agent-authoring/brief-corpus.json`. Split frozen at sha256 `dd4f360c16fd416f` — **DEV 32 /
  HELDOUT 60**, stratified by category.
- **DEV result: 18/32 admitted (0.563)**, mean iterations-to-admission **1.11**.
- **HELDOUT: PARTIAL — 12 of 60 done, 5 admitted.** Resumable.

## 2. Open work items
| # | Item | Blocked by |
|---|---|---|
| W1 | Finish HELDOUT (48 briefs remain) | — |
| W2 | Report generalization gap (DEV 0.563 − HELDOUT) | W1 |
| W3 | Add `preview()` (top-down render pre-simulation); measure iterations-to-admission with/without on held-out | W1, W2 |
| W4 | Requirement D: blind trace judge + judge review of corpus layout/taxonomy coverage | W1 |
| W5 | Engine gaps: B1 `close_lane` cannot edit the drivable surface (`roadControlSchema` is `kind:'stop'` only); B2 multi-lane junction approaches rare (157/210 fail); B5 `tFrac` clamped to [-1,1] so the verge is unaddressable | — |
| W6 | Wire `isKnownPropCatalogId` into `simforge template validate` (predicate + 4 tests already landed) | — |

## 3. Exact next steps
1. Rehydrate the runner in a notebook from `tools/scenario_tools.py` + `brief-corpus.json`
   (`ScenarioBuilder`, `TOOLDOC`, `run_program`, `author_with_agent`, `author_and_admit`).
2. Resume HELDOUT in chunks of ~12 at 12 workers, skipping ids already in `heldout-partial.json`.
   Budget **~85 min per 12 briefs**.
3. **Do not change sampling.** DEV used `solve(rounds=2, draws=4)` then `simulate(draws=10)`.
   Changing draws invalidates the gap measurement.
4. When all 60 finish, write `agent-authoring/GENERALIZATION.md` with DEV vs HELDOUT admission.
5. Only then build `preview()` and re-run a held-out subset for the iterations-to-admission delta.

## 4. Remote jobs
**None.** Everything ran as local subprocesses (`node packages/cli/bin/simforge.js`).
No background processes, no remote hosts, nothing to reattach or kill.

## Performance note
12 briefs took 5115 s at 12 workers (~7 min/brief wall clock), dominated by `simforge batch` —
each brief runs three batches (2 solve rounds + 1 final at 10 draws over ~37 sites).
