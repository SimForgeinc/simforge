# External runner API contract

The transport is intentionally thin. An HTTP or durable-queue deployment MUST
preserve the exported TypeScript contracts without accepting arbitrary command
lines, archive paths, URLs, or environment variables.

## Submit

`POST /v1/external-runs` with an `EsminiExecutionJob`. Return `202` with the
current `ExternalRunSnapshot`. The job contains the exact
`EsminiBundleManifest` emitted by `@simforge-oss/openscenario/node` plus opaque server content
handles created by `ingestRunnableBundle`.

## Inspect

`GET /v1/external-runs/{jobId}` returns `ExternalRunSnapshot`. Terminal snapshots
embed `ExternalRunResult`. Artifact IDs are opaque; deployment-specific signed
download URLs must be minted by the artifact service, never accepted in jobs.

## Cancel

`DELETE /v1/external-runs/{jobId}` requests cancellation and returns `202`.
Cancellation kills the whole process group (or container), releases the queue
slot, and produces a terminal `cancelled` result.

## Evidence semantics

- Every artifact listed in the immutable job `record` request is required. The
  production container profile records CSV, DAT, OSI, and logs. The local macOS
  Studio profile intentionally omits OSI because esmini 3.6.0's OSI writer
  crashes on some otherwise valid production OpenDRIVE object records; this is
  disclosed in the attached local receipt and never weakens CSV trace parity.
- `parseEsminiCsv` converts CSV to `RawExternalTrace` from
  `@simforge-oss/openscenario/trace-diff`.
- esmini CSV exposes collision pairs but no semantic action lifecycle, therefore
  `ESMINI_OBSERVABLE_EVENT_KINDS` is empty.
- Frames/video, when provided by a deployment renderer, are non-authoritative.
- A zero exit code can still contain error-level esmini diagnostics; consumers
  must display `ExternalRunLog.level` rather than infer severity from stdout.

The cache key is immutable over scenario export digest, full OpenDRIVE digest,
runner digest, behavior-parity scope, and execution options.
