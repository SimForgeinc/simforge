# SimForge scenario visual QA

This pipeline turns one concrete catalog slot's instance, exact simulation
trace, and accepted evaluation result into reviewable incident evidence. It does not treat map screenshots,
editor screenshots, orbit videos, load tests, or renderer stress tests as
scenario evidence.

## Evidence lifecycle

1. The trace-only preflight verifies that four distinct recorded ticks exist
   for `pre-event`, `reveal`, `conflict`, and `aftermath`, and that both
   incident actors remain present in the aftermath. A failed preflight writes
   `preflight.json`, exits non-zero, and does not render frames or video.
2. Catalog evidence is renderable only when `instance.json`, `trace.json.gz`,
   and `result.json` carry the same full catalog-slot closure (reservation seed,
   attempt seed, location, matcher site, variant, and provenance), and the
   result is `ok`, feasible, and accepted. Rejected or missing inputs remain
   explicit zero-credit ledger entries.
3. A passing preflight drives the real Studio renderer. It writes four named
   PNGs, a continuous H.264 MP4, all three source snapshots, and a deterministic
   `manifest.json` containing every actor pose, catalog model, camera, viewport,
   composition result, topology digest, input hash, trace digest, and artifact
   hash.
   Successful MP4 encoding removes its temporary per-video-frame PNGs; failed
   encodes preserve those inputs for diagnosis.
4. Machine gates reject missing/duplicate frames, wrong phase times, incomplete
   actor poses, absent aftermath actors, bad composition, camera intersections,
   missing MP4s, incomplete video coverage, topology provenance gaps, or browser
   errors. Rejected output never counts toward coverage.
5. A passing machine manifest is still only `pending-human-review`. Generate a
   review template and inspect the exact four PNG hashes and MP4 hash in the
   actual SimForge Studio browser surface, recording its URL and inspection
   session ID. Only an
   `accepted` review with all five artifacts marked observed can enter the
   scenario review ledger with `countsTowardScenarioCoverage: true`.

## Commands

```bash
pnpm render:export -- \
  --url http://127.0.0.1:5199 \
  --instance path/to/instance.json \
  --trace path/to/trace.json.gz \
  --result path/to/result.json \
  --out path/to/render-evidence \
  --headless --fps 12

pnpm render:review -- \
  --manifest path/to/render-evidence/manifest.json \
  --template path/to/render-evidence/review.json

# After a reviewer fills reviewer, completedAt, verdict, browser environment,
# notes, and marks the exact frame/video records observed:
pnpm render:review -- \
  --manifest path/to/render-evidence/manifest.json \
  --review path/to/render-evidence/review.json \
  --ledger artifacts/qa/scenario-visual-review-ledger.json
```

The ledger updater rejects a changed manifest, changed frame/video hash,
unobserved artifact, machine-rejected render, map-orbit render, and stress/smoke
render. A pending or rejected review always counts as zero accepted incidents.

## Resumable 500-scenario run

The batch layer consumes the catalog's reserved evidence paths; it does not
materialize or mutate catalog slots. Reconciliation always re-reads the source,
frame, MP4, manifest, and review bytes, so a stale ledger cannot award credit.
The ledger has an explicit 500-scenario denominator and 100-scenario
denominator for every map.

```bash
# Reconcile only. Missing instance/trace/result sets remain zero-credit missing-inputs.
pnpm render:batch -- \
  --catalog catalog/simforge-oss-five-map-v2.catalog.json \
  --ledger artifacts/qa/scenario-render-review-batch.json \
  --report artifacts/qa/scenario-render-review-batch-report.json

# Resume machine rendering for input-ready slots. The default is one browser;
# jobs and limit allow a controlled worker pool and a bounded smoke run.
pnpm render:batch -- --render --jobs 2 --limit 10 \
  --url http://127.0.0.1:5199 \
  --ledger artifacts/qa/scenario-render-review-batch.json
```

The first run pins the catalog bytes, declared catalog digest, renderer/review
source hashes, viewport, frame rate, UI mode, and Studio URL. Resume refuses any
drift in those values. Before each attempt the ledger atomically records
`rendering`; SIGINT/SIGTERM stops active children, records `cancelled`, and does
not launch further work. Interrupted, cancelled, and failed attempts retain
their exact attempt history and are deterministically queued again. A successful attempt still receives zero credit until every required
machine gate passes and a reviewer (human or agent) accepts the exact manifest,
four exact PNG hashes, and exact MP4 hash in the slot's
`visualInspection` file. Tampering or deleted evidence removes credit on the
next reconciliation.

## Current Yale checkpoint

The four existing Yale bus-stop key frames and representative beginning,
middle, and tail video frames were visually inspected. The scene and motion are
tangible, but the pedestrian disappears on the tick immediately after conflict
(`6.90 s` present, `6.92 s` absent). The old aftermath therefore depicts a
teleport, not aftermath. The strict preflight rejects this instance before GPU
rendering, and the written inspection records zero coverage credit in
`artifacts/qa/golden-yale-bus-stop-20260801-corrected/visual-inspection.json`.

The same inspection also found simultaneously bright red/yellow/green signal
lamp geometry and prototype-grade scene assets. Until dynamic signal state and
the incident-actor lifetime are corrected, this checkpoint is useful renderer
diagnostic evidence but is not a visually accepted realistic scenario.
