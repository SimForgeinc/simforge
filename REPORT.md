# 3D LLM judge removal — showcase scenario pipeline

Branch `opus-judge-removal`, commit `67cd4c7`. Not pushed.

**Net diff: 26 files, +1123 / −2531 = −1408 lines.**

The 2D semantic oracle (`62-semantic2d`) is now the only acceptance authority for scenario
semantics. The 2D→3D transfer is deterministic — the exporter replays the same recorded trace and
fails closed on any instance/trace/manifest identity mismatch — so a completed render *is* the proof
that the footage shows the reviewed scenario.

---

## The new acceptance contract

Version string, everywhere a version is recorded: **`showcase-deterministic-product/v1`**
(`PRODUCT_CONTRACT_VERSION`). The retired `showcase-acceptance-contract-v1` /
`showcase-acceptance-split/v1` names are never reused for the new meaning, so a decision recorded
under the old split can never read as current.

`75-product.json` layout bumped to `uniscenarios.showcase-product-decision.v2`. Per cell:

| field | definition |
|---|---|
| `semanticAccepted` | the `62-semantic2d` row for this cell has `semanticMatch === true` |
| `accepted` | `gatePassed && semanticAccepted && its deterministic render completed` (3D when `job.render3d`, else the 2D clip) |
| `unsupportedReason` | `never screened by the 2D semantic oracle` for a cell no oracle verdict covers — never a fabricated verdict |
| `defectCodes` | deterministic eligibility codes + render defect codes + the oracle's `scenario.*` codes + `scenario.gate` when the gate rejected the cell |

`presentationAccepted` is **deleted as a concept**, not aliased. Every consumer reads `accepted`.
No `judge.*` code can exist for a new job: the namespace is gone from the emitting registry, so
`retryForDefectCode('judge.uncertain')` now throws `unknown defect namespace`.

Acceptance is not rationed. `job.topK` still bounds how many cells a job pays to 3D-render, in the
`65-render3d` candidate selection where render spend is chosen — never in acceptance.

---

## Deleted

### `apps/showcase/server/pipeline.mjs` — 2377 → 2085 lines (+~110 / −402)
- the entire **`70-judge` stage** (68 lines) and every artifact it wrote
- **`review3dRenders`** (21 lines) and the **review-frames recapture loop** (12 lines: "one
  recapture before its failure becomes evidence")
- **`applyJudgeEvidence`** (32 lines)
- the **judge acceptance cache**: `acceptanceCache`, `reviewCodeDigest`, the `stage(…, {cacheKey})`
  parameter, the `<stage-dir>/.stale/` retirement path, `context.staleArtifacts`, and
  `execution.staleArtifacts` in the attempt record (~40 lines). Nothing else was ever keyed.
- the whole **`80-presentation-retry` branch** (56 lines) — recompose/recapture retries existed only
  to appease the judge
- `job.judge`, `job.judgeModel`, `job.judgeEffort`, `job.judgeStrategy` and their plumbing through
  `10-route.json`, the attempt record, and the API

`applyProductDecision` was rewritten from a 50-line `evaluateReview` + topK-quota + prose-injection
routine into a 28-line deterministic predicate. `planRetry` went from 63 lines of contract-driven
retry recommendation to 24 lines with two outcomes: `reauthor` or `none`.

### `apps/showcase/server/review-contract.mjs` (494) + `review-contract.test.mjs` (358) — deleted
Replaced by **`product-contract.mjs` (103 lines)**: the version string, the gate defect code, the
never-screened reason, the oracle's `scenario.*` codes, the assembled defect vocabulary,
`contractIdentity`, `isCurrentAcceptance`, `acceptsCampaignVideo`, `campaignVideoRow`,
`productAcceptanceSummary`. Everything else in the old module served only the judge:
`evaluateReview`, `withDefectCodes`, `acceptanceFields`, `rowReview`, the axis machinery, the prose
taxonomy (`classifyText`/`attribute`/`defectRecords`), `retryRecommendation`,
`retryRequiresAuthor`, `normalizeHistoricalReview`, `normalizeJudgeDocument`,
`judgeAcceptanceSummary`, `acceptanceCache`, `reviewCodeDigest`, `REVIEW_CODE_PATHS`,
`canonicalJson`, `sha256Text`.

Net for the module pair: **−749 lines.**

### `tools/research/showcase/stages.py` — 747 → 587 (+3 / −163)
`review_3d` and its `review3d` subparser, the `REVIEW3D_PROMPT`, and the dead `_video_seek_time`
helper. `semantic2d`, `semantic2d_verdict`, the blind 2D `judge` command, `gate`, `mutate`,
`author`, and `vista_author` are untouched.

### `tools/research/showcase/qualify.py` — 411 → 329 (+12 / −94)
The `review` subcommand and its only implementation (`_run_reviewer`, `_stage_render`). See
*Could not delete* below.

### Other deletions
- `benchmark.mjs`: `ACCEPTANCE_SPLIT_SCHEMA`, `defectClass` (no production consumer — only its own
  test), the `models.judge` and `models.productReviewVersion` histograms, the
  `defects.unclassifiedAttempts` counter and `outcome.unclassifiedDefects` (reviewer prose that no
  longer exists).
- `campaign.mjs`: the `70-judge.json` fallback in both `collectAccepted` and `validateSavedVideos`,
  and the `reviewContractVersion` / `reviewContractSha256` / `reviewVersion` / `realism` / `dynamism`
  fields on an accepted-video row.
- `index.mjs`: the `70-judge` saved-stage entry and the `normalizeJudgeDocument` read-boundary
  rewrite. Old artifacts are now served verbatim.
- `scripts/trace-validity-lib.mjs`: `judge.uncertain` and `scenario.review_rejected` from the defect
  registry, the `['judge.', 'manual-review']` retry prefix, and `'manual-review'` from `RETRY_KINDS`.
- `90-gallery.json`: the `scores: {realism, dynamism}` block (judge axes) and `presentationAccepted`.
- Web: the `Judge` stage card, the `70-judge.json` read, the judge/product-review-version
  histograms, the realism/dynamism cell scores, and the "Footage judge" submit toggle.

---

## Contract decisions

1. **Where the surviving contract lives.** `review-contract.mjs` was deleted rather than trimmed.
   Its name would have been a lie: nothing it held reviewed anything. The 103-line
   `product-contract.mjs` holds the whole new contract and depends only on
   `scripts/trace-validity-lib.mjs`, which keeps `benchmark.mjs`'s import graph acyclic.

2. **The defect vocabulary is assembled from the emitters, not from a hashed prompt.**
   `DEFECT_CODE_VOCABULARY` = the deterministic validator registry keys ∪ the oracle's five
   `scenario.*` codes ∪ `scenario.gate`. `defects.taxonomy` in the benchmark report now names
   `apps/showcase/server/product-contract.mjs`. Previously it named the judge's 25-code contract,
   which did not contain the finer deterministic codes the pipeline actually emits — every
   `simulation.actor.frozen_tail` was reported as an *unknown* code.

3. **Contract identity is a version string, not a body hash.** The predicate is deterministic code,
   not a hashed prompt, so there is nothing to hash. `isCurrentAcceptance` compares
   `contract.version`; a saved campaign video carries `productContractVersion` and is dropped on any
   bump. Fail-closed behaviour is preserved; the sha256/promptSha256/reviewVersion triple is gone.

4. **The oracle owns the repair budget.** `planRetry` returns `reauthor` in exactly one case: the
   oracle screened *nothing* (no admitted draw reached it), so no semantic evidence exists to repair
   against and a new template is the only control. When the oracle screened and matched nothing, the
   bounded mutation loop upstream already spent every authoring pass — retry `none`, detail
   `oracle-rejected`. `manual-review`, `recompose`, `recapture`, and `rereview` are gone.
   `retry.cellIds` and `retry.recommendation` are gone with them (presentation retries were the only
   consumers). Final `retry` shape: `{kind: 'reauthor'|'none', detail, reason, authorisedBy}`.

5. **The blind 2D footage review survives, gated on the gateway rather than on `job.judge`.** It is
   not the 3D judge: it ranks 3D candidates for a job the oracle could not screen and decides
   nothing. Deleting it would have left the `semantic-reviewed` funnel stage permanently
   unreachable, which the owner's 12→11 funnel count rules out. Its model/effort/strategy became
   pipeline constants (`REVIEW_MODEL`/`REVIEW_EFFORT`/`REVIEW_STRATEGY`) instead of job knobs, since
   the spec deletes the knobs and forbids new ones. `judgeConcurrency` /
   `SHOWCASE_JUDGE_CONCURRENCY` was renamed to `reviewConcurrency` / `SHOWCASE_REVIEW_CONCURRENCY`
   — it bounds both vision reviews, neither of which is a judge.

6. **Funnel: 12 → 11 stages.** `semantic-3d` and `presentation` dropped; `accepted` (evidence
   `75-product.json`) is the terminal product stage. The JS list in `benchmark.mjs` and the Python
   list in `benchmark_report.py` were verified byte-identical, ids and evidence paths, by a
   cross-check script.

7. **Two contracts now coexist in Python, deliberately.** `qualification.py` keeps the hashed review
   contract's `DECISION_FIELDS`/`normalize_decision` for the deferred human gold labels (the sealed
   `reviewer-gold.json` manifest depends on them) and gains
   `PRODUCT_DECISION_FIELDS`/`normalize_product_decision`/`assert_current_product_contract` for
   pipeline attempt evidence. Mixing them would have either broken the gold seal or let a product
   decision be validated by predicates that no longer describe it.

8. **Old artifacts stay readable, and only readable.** `collectJobUsage` still bills historical
   `70-judge.json` / `quality.json` token usage so an old job's cost is not silently zeroed, and the
   `70-judge` byStage bucket exists for exactly that reason. `directoryIndex` serves a legacy
   `70-judge.json` verbatim. No stage writes one, and no acceptance path reads one: a campaign
   refuses it because it carries no current product contract version.

---

## Could not delete, and why

- **`config/showcase-review-contract.json` and `tools/research/showcase/review_contract.py`.**
  Two live consumers remain: `stages.py semantic2d` reuses `review.clamp_number`,
  `review.MAX_DEFECTS`, and `review.MAX_TEXT` for its emission limits (62-semantic2d behaviour is
  out of scope by owner instruction), and the deferred human-calibration workflow
  (`qualify.py gold-template|label|calibrate`, `qualification.py`'s gold/flip-rate section,
  `apps/showcase/campaigns/reviewer-gold.json`) is built on the hashed contract's predicates.

- **`qualify.py review` was deleted even though the spec only mandated deleting `review3d`.**
  `review` existed solely to run `stages.py review3d` over hash-verified evidence and score the 3D
  product reviewer against human gold. With `review3d` gone, leaving the subprocess call would have
  produced a confusing `CalledProcessError` instead of an honest refusal. **Consequence, stated
  plainly: the deferred human-calibration arm can no longer collect new model reviews.**
  `calibrate` and `evaluate` still run over a reviews JSONL already on disk — reading old evidence is
  fine; producing new judge evidence is not.

- **`apps/showcase/campaigns/reviewer-gold.json`** keeps `presentationAccepted` in its 12 human
  labels and its `labelInstructions`. Those are immutable human labels under a sealed manifest
  digest; rewriting them would forge label provenance.

- **`scripts/trace-validity-lib.mjs` `'manual-review'` in `RETRY_KINDS`** — removed. But
  `retryForDefectCode` still *throws* on an unknown namespace rather than returning `'none'`; that
  fail-closed behaviour was left as-is because it is load-bearing for the deterministic validators
  and out of this change's scope.

---

## Simplified away

- one acceptance predicate instead of two (`accepted` replaces `semanticAccepted` ∧
  `presentationAccepted` ∧ topK quota ∧ tier check ∧ empty-defects check ∧ null-unsupported check)
- the LLM prose→code attribution taxonomy (23 regex rules, 5 legacy code aliases, a fallback code,
  and the `unclassifiedDefects` escape hatch it needed)
- the axis machinery: `mechanismFidelity`, `visualGrounding`, `actorFidelity`, `eventSequence`,
  `plausible`, `realism` floor, `confidence` floor, and the `tier` distinction
- the artifact cache-key/retirement subsystem (its only client was the judge verdict)
- one retry vocabulary instead of two — `recompose`, `recapture`, `rereview`, `manual-review`, and
  `resimulate`-escalation are gone from the product path
- `judge.*` as a defect namespace, and `scenario.review_rejected` as a code
- three job knobs, one env var, two report histograms, and one gallery score block
- 138 lines of retired stage vocabulary in the regenerated `apps/showcase/campaigns/breadth.json`

## Not touched

`tools/gates/tg_gate.py`, evidence hashing, `62-semantic2d` stage behaviour and its prompt, the
mutation-repair loop (`62-mutation-01`, `62-mutation-02`, `62-fallback-author`), `packages/`.
The frozen-gate hash tripwire still passes unchanged.

---

## Verification

All commands run from the worktree root, at commit `67cd4c7`.

```
$ node --test apps/showcase/server/*.test.mjs
# tests 69 / # pass 69 / # fail 0

$ node --test scripts/__tests__/export-render.test.mjs scripts/__tests__/trace-validity.test.mjs
# tests 23 / # pass 23 / # fail 0

$ python3 tools/research/showcase/test_showcase_tools.py
Ran 61 tests in 0.095s
OK

$ python3 tools/gates/verify_gate_hash.py
GATE-HASH TRIPWIRE: PASS -- frozen gate v1 1a08698e95fca4bc / v2 3823182614e5a5ba unchanged

$ cd apps/showcase/web && npm test
Test Files  1 passed (1) / Tests  12 passed (12)

$ cd apps/showcase/web && npm run build      # tsc -b && vite build
✓ built in 243ms

$ node --check <every touched .mjs>
clean
```

Cross-checks run explicitly, not assumed:

- the 11-stage funnel list in `benchmark.mjs` and `benchmark_report.py` match on ids *and* evidence
  paths: `MATCH True count 11`
- `PRODUCT_CONTRACT_VERSION` and the product schema string match between `product-contract.mjs` and
  `qualification.py`: `MATCH True`
- `grep -rn 'staleArtifacts\|cacheKey' apps/showcase/server tools/research/showcase` → none
- repo-wide `review3d` → no hits

The web dashboard was driven in a real browser against the built `dist` served by
`scripts/mock-server.mjs`: the job view shows the `62 Semantic` and `75 Decision` stages, the
"Gate and semantic oracle evidence" section, and per-cell `Gate PASS / Semantic PASS / Accepted PASS`
verdicts, with no judge terminology anywhere.

### What the rewritten pipeline tests assert (live behaviour, not weakened)

| test | asserts |
|---|---|
| a 3D render failure rejects the cell with its own code and never reaches the author | `semanticAccepted` stands alone, `accepted: false`, `render.camera.composition_failed`, `retry.detail: 'oracle-rejected'`, no `80-*` directory, one authoring pass, no `70-judge.json` |
| a resumed job reads the product decision it already recorded | `65-render3d`/`75-product`/`90-gallery` all resolve `complete` from artifacts; the recorded decision is byte-identical; `outcome.kind: 'accepted'` |
| a physically invalid trace is dropped before the 3D render and reauthors once | nothing rendered or screened, `scenario.no_eligible_simulation`, exactly one `80-reauthor-01`, whose own decision is `retry.detail: 'exhausted'` |
| a valid trace renders, matches the oracle and is accepted with no retry at all | full `acceptance` evidence object checked field-by-field; the blind 2D pass still runs and still decides nothing |
| a gate-rejected cell is reported, never re-decided, and never rendered | the gate-rejected cell holds no verdict at all |
| a cell the oracle never screened is unsupported, not given a verdict | `unsupportedReason === NEVER_SCREENED_REASON`, `screenedCells: 0`, `unsupportedCells: 1` |
| a semantic mismatch mutates the template once and 3D renders only the matched cell | mutation loop still runs; one 3D render on the matched cell; the rejected original keeps the oracle's own `scenario.mechanism` |
| an exhausted semantic loop rejects honestly instead of reauthoring | both mutation rounds + capped fallback ran, 3D skipped, no reauthor, `outcome.kind: 'rejected'` |
