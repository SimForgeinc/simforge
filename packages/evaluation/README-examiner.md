# @simforge/evaluation — the WS2 faithfulness critic

Layered faithfulness grading over the engine's causal ground truth. The core
invariant: **truth judgment never leaves deterministic code.** A model may
parse natural language into claims; it never decides whether a claim is true.

```
NL description ──extractor (LLM, parsing only)──▶ claims.v1
                                                    │
engine artifacts (trace + causal channel) ──▶ deterministic checkers
                                                    │
                                              grader: score ∈ [0,1]
                                          = w·causality + (1−w)·coverage
```

## claims.v1 — the claim schema

A claim set is `{ schema: "…claims.v1.json", scenarioId, claims[] }`. Every
claim carries:

| field        | meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| `id`         | stable slug                                                    |
| `type`       | `visibility` \| `causal-trigger` \| `intent` \| `spatial`      |
| `actorIds`   | ≥1 engine actor ids the proposition is about                   |
| `tickRange`  | half-open `[fromTS, toTS)` in decision seconds                 |
| `checkable`  | `deterministic` (checker-judged) \| `extracted` (deferred)     |

### Proposition types

**`visibility`** — an actor's line-of-sight state to an observer (default the
ego), reconstructed from the rl-env causal channel's LOS transitions:

```json
{ "id": "v1", "type": "visibility", "actorIds": ["child"],
  "tickRange": { "fromTS": 3.0, "toTS": 4.5 }, "checkable": "deterministic",
  "state": "occluded" }
```

**`causal-trigger`** — an ordered event→event proposition. Events reference
the channel's trigger records (`trigger-fired`, `trigger-skipped`,
`preemption`, `released`, `completed`) or `conflict-genesis`, optionally
narrowed by `interactionId` / `actorId` / `metric`:

```json
{ "id": "c1", "type": "causal-trigger", "actorIds": ["child"],
  "tickRange": { "fromTS": 5.2, "toTS": 5.8 }, "checkable": "deterministic",
  "cause":   { "kind": "trigger-fired", "interactionId": "child-darts" },
  "effect":  { "kind": "conflict-genesis", "metric": "ttc" },
  "relation": "causes" }
```

`relation: "causes"` requires the effect within `CAUSAL_GAP_S` (2 s) of the
cause with no intervening trigger on the same actor; `"precedes"` is ordering
only.

**`intent`** — one actor's authored *and executed* interaction intent, as one
of the engine's verb classes (`speed`, `gap`, `changeLane`, `laneOffset`,
`route`, `exist-present`, `exist-absent`, `set`):

```json
{ "id": "i1", "type": "intent", "actorIds": ["child"],
  "tickRange": { "fromTS": 0, "toTS": 14 }, "checkable": "deterministic",
  "verb": "speed", "interactionId": "child-runs" }
```

**`spatial`** — a relation of one actor to a reference actor (default the
ego), sampled at every decision tick in the range: `ahead-of`, `behind`,
`left-of`, `right-of` (≥1 m margin in the ego frame), `same-lane` (equal RSL),
`within-distance` (`valueM` required):

```json
{ "id": "s1", "type": "spatial", "actorIds": ["bus"],
  "tickRange": { "fromTS": 2.0, "toTS": 5.0 }, "checkable": "deterministic",
  "relation": "ahead-of" }
```

The zod tree (`src/claims.ts`) is the parsing boundary;
`CLAIMS_V1_JSON_SCHEMA` is the same contract as JSON Schema for constrained
decoding. Verdicts are `pass` / `fail` / `unverifiable` (outside what the
engine recorded — never an error) / `deferred` (extracted claims).

## The grader

`grade(scenario, claims, { trueClaims? })` → `{ score, causality, coverage,
verdicts[], uncoveredTruth[], failedClaimIds[] }` — the WS7 contract (scalar
plus per-claim verdicts). `causality` is the pass rate of the candidate's own
deterministic claims; `coverage` is recall against the engine-derived true
claim set (`deriveTrueClaims`), matched by type + actor + temporal overlap +
payload compatibility.

## Grader benchmark (known ground truth, FACT-E / C2-Faith pattern)

True claim sets are derived from real simulated episodes; perturbation
operators corrupt copies in exactly one known way each; the grader must flag
exactly the injected position. Clean controls must stay unflagged (precision).

| operator                 | injected error                              | recovered |
| ------------------------ | ------------------------------------------- | --------- |
| flip-visibility          | occlusion state swapped                     | 68/68     |
| wrong-intent             | intent verb replaced                        | 83/83     |
| flip-spatial-relation    | ahead↔behind / left↔right                   | 87/87     |
| delete-actor             | all claims about an actor removed           | 58/58     |
| insert-phantom-actor     | hallucinated actor added                    | 24/24     |
| reverse-trigger-order    | cause/effect swapped                        | 61/61     |
| **total**                | **390 injected**                            | **100 %** |

- 423 cases (390 perturbed + 33 clean controls) over 33 simulated scenarios
  from 14 distinct template×site combinations (`examples/*.template.json` ×
  dev-assets maps, recorded by `tools/build-corpus.ts`).
- **recall 100 % ≥ 90 % gate — PASS; precision 100 %** (zero spurious flags).
- Report: `benchmark/report.v1.json` (regenerate with `pnpm bench:claims`;
  the script exits nonzero when the gate fails).

## Extractor (NL → claims.v1, parsing only)

Model-agnostic: `extractClaims(completion, description, { scenarioContext })`
takes any chat-completion callable, sends the schema as a structured-output
`response_format`, validates through zod, and runs one repair round-trip on
schema violations. `openAiCompatibleCompletion` wires it to any
OpenAI-compatible endpoint; the bearer token is read at call time from the
env var named by `--api-key-env` — no secrets in code, config, or logs.

```sh
pnpm --filter @simforge/evaluation exec simforge-extractor \
  --endpoint http://localhost:8000/v1 --model qwen2.5-7b-instruct \
  --api-key-env MY_LLM_KEY \
  --corpus fixtures/corpus.v1.json --scenario bus-stop-emergence__yale-street__fa9fa19457cf576f \
  --description-file desc.txt --grade
```

`--grade` runs the parsed set through the grader against engine ground truth.

## Commands

```sh
pnpm test           # vitest suite (schema, checkers, grader, extractor, benchmark gate)
pnpm corpus:build   # re-record fixtures/corpus.v1.json (needs dev-assets; SCEN_DEV_ASSETS)
pnpm bench:claims   # regenerate benchmark/report.v1.json; exit 1 on gate failure
pnpm build          # tsup ESM + dts
```

## Corpus provenance

`fixtures/corpus.v1.json` holds, per scenario: decimated true tracks (decision
grid), the versioned causal channel (`causalVersion: 1`), and the authored
interactions — all from one byte-deterministic engine pass pair over a
materialized instance (`template × site × seed`), with `traceDigest` pinned
for provenance. Regenerating with the same repo state is byte-identical.
