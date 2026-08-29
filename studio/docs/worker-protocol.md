# Local worker HTTP protocol

All internal worker endpoints require `Authorization: Bearer <token>`. The token is `SIMFORGE_RENDER_WORKER_TOKEN`, defaulting locally to `simforge-local-worker`. Native render requests also require `x-simforge-worker-node-id: <id>`. JSON errors use HTTP 400 for invalid bodies, 401 for invalid tokens, and 409 when a lease/fence is invalid or expired.

## Browser render and CPU jobs

### Claim

`POST /api/uniscenario/internal/cpu-jobs/claim`

```json
{
  "workerId": "local-browser-worker",
  "leaseSeconds": 900,
  "families": ["openscenario_render"]
}
```

`leaseSeconds` is 30–1800. Families are `openscenario_compile`, `openscenario_validate`, `openscenario_render`, and `artifact_postprocess`. No work returns HTTP 204. A browser-render claim returns:

```json
{
  "contract": "uniscenario.cpu-job-claim/v1",
  "jobFamily": "openscenario_render",
  "jobId": "...",
  "attemptId": "...",
  "fenceToken": "...",
  "leaseExpiresAt": "ISO-8601",
  "payload": {
    "mode": "browser_render",
    "engine": "browser",
    "intent": {
      "schema": "uniscenario.render-intent/v1",
      "engine": "browser",
      "assets": [
        { "assetId": "map.manifest", "kind": "map", "sha256": "...", "sizeBytes": 123 },
        { "assetId": "map/3d/tiles/tile.glb", "kind": "other", "sha256": "...", "sizeBytes": 456 },
        { "assetId": "playback.bundle", "kind": "other", "sha256": "...", "sizeBytes": 789 }
      ]
    },
    "intentSha256": "64 lowercase hex characters",
    "inputs": [
      {
        "inputId": "scenario.xosc",
        "relativePath": "scenario.xosc",
        "sha256": "...",
        "sizeBytes": 123,
        "download": { "url": "...", "headers": {} }
      },
      {
        "inputId": "map.manifest",
        "relativePath": "3d/manifest.json",
        "sha256": "...",
        "sizeBytes": 123,
        "download": { "url": "...", "headers": {} }
      },
      {
        "inputId": "map/3d/tiles/tile.glb",
        "relativePath": "3d/tiles/tile.glb",
        "sha256": "...",
        "sizeBytes": 456,
        "download": { "url": "...", "headers": {} }
      },
      {
        "inputId": "playback.bundle",
        "relativePath": "playback.bundle",
        "sha256": "...",
        "sizeBytes": 789,
        "download": { "url": "...", "headers": {} }
      }
    ],
    "recording": {
      "revisionId": "...",
      "documentId": "...",
      "renderSpec": {},
      "resolvedManifest": {},
      "idempotencyKey": "browser-render-..."
    }
  }
}
```

The claim contains every verified member of the map's active
`browser_asset_set`. The manifest member has the reserved input ID
`map.manifest`; other members use `map/<relative-path>`. `relativePath`
preserves the published city tree beneath the worker's input root so
CityViewer can resolve tiles and textures relative to `3d/manifest.json`.

`playback.bundle` is decoded JSON from the matching immutable
`simulation_previews` artifact. A preview matches only when its document
version, content digest, and map version equal the revision. Jobs without this
materialized evidence remain queued rather than receiving an incomplete claim.
The `recording` object is a complete `CreateBrowserRecordingSchema` value
resolved from that exact playback evidence, revision, map, and render spec.

Every subsequent CPU request includes this fence:

```json
{
  "jobFamily": "openscenario_render",
  "attemptId": "...",
  "fenceToken": "..."
}
```

### Heartbeat and events

`POST /api/uniscenario/internal/cpu-jobs/{jobId}/heartbeat`

```json
{ "jobFamily": "openscenario_render", "attemptId": "...", "fenceToken": "...", "leaseSeconds": 900, "progress": 0.5 }
```

`progress` is optional and 0–1. The response contains the renewed expiry and `cancelRequested`.

`POST /api/uniscenario/internal/cpu-jobs/{jobId}/events`

```json
{ "jobFamily": "openscenario_render", "attemptId": "...", "fenceToken": "...", "type": "render.progress", "payload": {} }
```

### Reserve outputs

`POST /api/uniscenario/internal/cpu-jobs/{jobId}/reserve`

```json
{
  "jobFamily": "openscenario_render",

  "attemptId": "...",
  "fenceToken": "...",
  "artifacts": [{ "kind": "state-trace", "mediaType": "application/json", "sha256": "64 lowercase hex characters", "sizeBytes": 123 }]
}
```

One to four artifacts are accepted, each at most 512 MiB. The response supplies artifact IDs and checksum-bound upload URLs/headers. Browser recording output is normally produced through the recordings API; the CPU completion references that recording job.

The local port adds the mutation endpoints missing upstream. Create and reserve
in one `POST /api/uniscenario/recordings` call with
`{\"recording\": <CreateBrowserRecordingSchema>, \"artifacts\": <artifact declarations>}`.
The response is `{\"recording\": <detail>, \"artifacts\": <checksum-bound upload
authorizations>}`. Upload the exact declared closure, then finalize it with
`PATCH /api/uniscenario/recordings/{recordingId}` using the
`FinalizeBrowserRecordingSchema` body. Both mutations use the worker bearer
token. Use the succeeded recording ID in the CPU completion below.

### Complete or fail

`POST /api/uniscenario/internal/cpu-jobs/{jobId}/complete`

```json
{
  "jobFamily": "openscenario_render",
  "attemptId": "...",
  "fenceToken": "...",
  "artifacts": [{ "id": "...", "kind": "manifest", "sha256": "64 lowercase hex characters", "sizeBytes": 123 }],
  "browserRender": { "recordingJobId": "..." }
}
```

`browserRender.recordingJobId` is required by the store for browser render completion. That recording must match the render job's workspace/revision/spec and have completed manifest output plus video when requested. The store links those recording artifacts to the render job before succeeding it.

`POST /api/uniscenario/internal/cpu-jobs/{jobId}/fail`

```json
{ "jobFamily": "openscenario_render", "attemptId": "...", "fenceToken": "...", "code": "render_failed", "detail": {} }
```

## Native render lease protocol

The body schema is `uniscenario.render-worker-control/v2`. Claim with:

`POST /api/uniscenario/internal/render-jobs/lease`

```json
{ "schema": "uniscenario.render-worker-control/v2", "type": "job.claim", "registrationId": "..." }
```

No work returns `{"schema":"uniscenario.render-worker-control/v2","type":"job.none","retryAfterMs":2000}`. A lease returns:

```json
{
  "schema": "uniscenario.render-worker-control/v2",
  "type": "job.leased",
  "jobId": "...",
  "attempt": 1,
  "lease": { "leaseId": "...", "fenceToken": "at least 32 characters", "expiresAt": "ISO-8601" },
  "intent": {},
  "intentSha256": "64 lowercase hex characters",
  "inputs": [{ "inputId": "...", "sha256": "...", "sizeBytes": 123, "download": { "url": "...", "headers": {} } }]
}
```

### Heartbeat

`POST /api/uniscenario/internal/render-jobs/{jobId}/heartbeat`

```json
{ "schema": "uniscenario.render-worker-control/v2", "type": "lease.heartbeat", "leaseId": "...", "fenceToken": "...", "progressSequence": 0 }
```

The response reports renewed expiry, cancellation, and the durable progress sequence.

### Progress

`POST /api/uniscenario/internal/render-jobs/{jobId}/events`

```json
{
  "schema": "uniscenario.render-worker-control/v2",
  "type": "lease.progress",
  "leaseId": "...",
  "fenceToken": "...",
  "records": [{ "schema": "uniscenario.render-progress/v1", "jobId": "...", "attempt": 1, "sequence": 1, "timestamp": "ISO-8601", "event": "job.started" }]
}
```

Allowed events are `job.started`, `stage.started`, `stage.progress`, `artifact.ready`, `warning`, and `job.canceled`. Stages are `downloading`, `preparing`, `rendering`, `encoding`, `uploading`, and `finalizing`.

### Reserve and upload an artifact

`POST /api/uniscenario/internal/render-jobs/{jobId}/artifacts`

```json
{
  "schema": "uniscenario.render-worker-control/v2",
  "type": "artifact.reserve",
  "leaseId": "...",
  "fenceToken": "...",
  "identity": { "role": "manifest", "actorId": null, "sensorId": null, "modality": null },
  "sha256": "64 lowercase hex characters",
  "sizeBytes": 123,
  "mediaType": "application/json"
}
```

Sensor outputs use roles `video`, `frames`, or `sensorArchive` and require actor, sensor, and modality. Job outputs use `manifest`, `trace`, `annotations`, or `diagnostics` with null actor/sensor/modality. Upload bytes with the returned URL and required headers.

### Complete or fail

`POST /api/uniscenario/internal/render-jobs/{jobId}/complete`

```json
{
  "schema": "uniscenario.render-worker-control/v2",
  "type": "job.complete",
  "leaseId": "...",
  "fenceToken": "...",
  "intentSha256": "...",
  "manifest": { "artifacts": [{ "artifactId": "...", "identity": { "role": "manifest", "actorId": null, "sensorId": null, "modality": null }, "sha256": "...", "sizeBytes": 123, "mediaType": "application/json" }] }
}
```

`POST /api/uniscenario/internal/render-jobs/{jobId}/fail`

```json
{
  "schema": "uniscenario.render-worker-control/v2",
  "type": "job.fail",
  "leaseId": "...",
  "fenceToken": "...",
  "intentSha256": "...",
  "failure": { "code": "render_failed", "message": "...", "retryable": true, "details": {} }
}
```

Lease IDs, fence tokens, attempt IDs, job IDs, and intent hashes are checked transactionally. A stale worker cannot heartbeat, append events, reserve output, complete, or fail another attempt.
