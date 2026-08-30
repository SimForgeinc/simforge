# Meshy asset generation

This tool turns entries from `packages/asset-catalog/catalog.json` into normalized GLB gallery assets. It runs Meshy's two-stage text-to-3D flow (preview, then refine), downloads the refined GLB, normalizes it to the catalog dimensions, and atomically maintains `state.json`, `manifest.json`, and `REPORT.md` beside the tool. Generated models are written under the ignored `dev-assets/gallery-assets/` directory.

## Generate assets

Install workspace dependencies, provide the key only through the process environment, and select one catalog entry while validating the flow:

```sh
MESHY_API_KEY='…' pnpm meshy:generate --only hazard.cardboard_box --concurrency 1
```

Omit `--only` to process the full catalog. `--dry-run` validates the catalog and initializes the state and manifest without contacting Meshy. `--retry-failed` permits one retry for failed, rejected, or credit-exhausted entries. State is resumable: task IDs are persisted before polling and completed downloads are not submitted again.

Do not put an API key in a repository file or command committed to shell history. Retrieve it from the approved secrets manager and inject it into the process environment.

## Smoke checks

The offline contract smoke is part of the repository test command and spends no credits:

```sh
pnpm meshy:smoke
```

It checks the current preview/refine request shape, catalog and manifest schemas, safe downloader paths, and a real local GLB download.

The live smoke performs one authenticated `GET /openapi/v1/balance` call and spends no credits. It skips cleanly when the key is absent, so the same command is safe in forks and local environments:

```sh
MESHY_API_KEY='…' pnpm meshy:smoke:live
```

CI runs both commands. The live step authenticates only when the repository `MESHY_API_KEY` secret is available.

## Recovery note

The original generator produced the local Meshy corpus but was never tracked in Git. A clean checkout therefore failed immediately with `Cannot find module 'tools/meshy/generate.mjs'`. The generator, offline contract smoke, and environment-gated live smoke are now tracked together so a clean checkout exercises the same entry point used for generation.
