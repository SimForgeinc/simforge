# UniScenarios showcase server

From the repository root:

```sh
SHOWCASE_TOKEN=replace-me pnpm --filter @uniscenarios/showcase start
```

The server listens on `0.0.0.0:4174` by default. Set `SHOWCASE_HOST`,
`SHOWCASE_PORT`, or `SHOWCASE_DATA_DIR` to override those values. Every API and
artifact request requires either `?token=replace-me` or
`Authorization: Bearer replace-me`.

After `pnpm -r build`, the same process serves the frontend build at `/`. A
successful `?token=` page request sets a same-site, HTTP-only token cookie so
the browser can fetch hashed JS/CSS assets without placing the token in their
URLs.

Job artifacts are written beneath `showcase-data/jobs/<jobId>/`. The data
directory is intentionally not committed.

## Acceptance contract

`server/product-contract.mjs` is the whole acceptance contract, version
`showcase-deterministic-product/v1`. Acceptance is deterministic and has exactly one semantic
authority: the brief-aware 2D semantic oracle (`62-semantic2d`). The 2D-to-3D transfer is
deterministic — the exporter replays the same recorded trace and fails closed on any instance,
trace, or manifest identity mismatch — so a completed render *is* the proof that the footage shows
the scenario the oracle reviewed. Nothing scores realism, materials, lighting, or camera framing:
that was renderer telemetry, never a scenario verdict.

Each `75-product.json` cell carries four fields and the evidence behind them:

- `semanticAccepted` — the `62-semantic2d` row for this cell has `semanticMatch === true`.
- `accepted` — the frozen gate admitted the cell, `semanticAccepted` holds, and its deterministic
  render completed (3D when `job.render3d`, else the 2D clip). Only this verdict yields a
  deliverable video.
- `defectCodes` — the codes the emitting stages attributed: deterministic trace-validity codes
  (`simulation.*`), the exporter's classified render failures (`render.*`, `capture.*`), the
  oracle's own `scenario.*` codes, and `scenario.gate` when the frozen gate rejected the cell. No
  `judge.*` code can exist.
- `unsupportedReason` — `never screened by the 2D semantic oracle` for a cell no oracle verdict
  covers. A cell without evidence is reported unsupported, never given a verdict.

`75-product.json` also records `contract`, so a decision made under the retired acceptance split
can never read as current: `isCurrentAcceptance` compares the version string, and a campaign
refuses to collect anything else. A `70-judge.json` left by a job from before the 3D product review
was removed stays on disk and is served verbatim as evidence; nothing re-derives a verdict from it,
and no stage writes one again.

`config/showcase-review-contract.json` and `tools/research/showcase/review_contract.py` survive only
for the deferred human-calibration workflow (gold manifest, reviewer flip rate) and for the field
limits `stages.py semantic2d` reuses. No production decision reads them.

## Benchmark evidence

Each generation attempt writes exactly one record, `95-benchmark.json`, updated
after every stage so a crashed attempt still leaves a truthful partial record.
Every field is either measured or `null`; nothing is imputed. `GET
/api/jobs/<jobId>/benchmark` returns it.

The campaign runner folds those records into `totals.benchmark` inside
`showcase-data/campaigns/<id>/report.json`, also served by `GET
/api/campaigns/<id>/benchmark`. Read it with:

```sh
python3 tools/research/showcase/benchmark_report.py \
  --report showcase-data/campaigns/edge-cases-67x5/report.json \
  --expect-entries 67 --strict
```

That tool verifies rather than recomputes: it fails when a rate lacks its
denominator or disagrees with it, when the corpus does not account for every
entry exactly once, when the funnel is not monotone, or when benchmark evidence
violates the report contract.

Generator throughput ends at the brief-aware 2D semantic verdict
(`62-semantic2d`), the last verdict reached before a 3D render is spent. Product
throughput adds the deterministic render and the `75-product` decision. The
report's `execution` block records cold-vs-warm starts, host concurrency, and the
models behind the numbers, because token and wall-time costs are comparable only
within one set of execution conditions.

Two verdicts are recorded separately for every decided cell. `semanticAccepted`
asks whether the requested behaviour happened and is visible in the schematic
footage; `accepted` additionally requires the frozen gate and a completed
deterministic render, and is the only verdict that admits a video into a campaign
case. Operational failures (provider outages, renderer infrastructure, host
exhaustion) censor an attempt at the stage where they occurred: earlier stage
outcomes stay in their denominators, so an outage cannot lower a generator
conversion rate.

Defect codes in the report come from the stages that emit them, assembled in
`product-contract.mjs`; the benchmark module never attributes a code itself,
because a second taxonomy could disagree with the verdicts it summarises and the
disagreement would be invisible. `defects.taxonomy` names that module and
`defects.unknownCodes` lists any counted code outside the vocabulary — non-empty
means the report is summarising verdicts from a stage this runner does not know
about.

Set `SHOWCASE_BENCHMARK_GPU=0` to skip `nvidia-smi` sampling; GPU cost is then
reported as `null` rather than estimated.
