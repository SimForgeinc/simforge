# Meshy asset generation

This tool turns entries from `packages/asset-catalog/catalog.json` into normalized GLB gallery assets. It runs Meshy's two-stage text-to-3D flow (preview, then refine), downloads the refined GLB, normalizes it to the catalog dimensions, and atomically maintains `state.json`, `manifest.json`, and `REPORT.md` beside the tool. Generated models are written under the ignored `dev-assets/gallery-assets/` directory.

## Generate assets

Install workspace dependencies, provide the key only through the process environment, and select one catalog entry while validating the flow:

```sh
MESHY_API_KEY='…' pnpm meshy:generate --only hazard.cardboard_box --concurrency 1
```

Omit `--only` to process the full catalog. `--dry-run` validates the catalog and initializes the state and manifest without contacting Meshy. `--retry-failed` permits one retry for failed, rejected, or credit-exhausted entries. State is resumable: task IDs are persisted before polling and completed downloads are not submitted again.

Do not put an API key in a repository file or command committed to shell history. Retrieve it from the approved secrets manager and inject it into the process environment.

## Texture prompt contract

Meshy's current [Text to 3D API](https://docs.meshy.ai/en/api/text-to-3d) accepts `texture_prompt` only on the refine request. `texture_richness` has no functional effect, and `art_style` is deprecated and ignored by current Meshy models, so the generator sends neither legacy field. The preview `prompt` carries the complete catalog description, and the refine `texture_prompt` repeats that description while making every stated color, material, and pattern mandatory. This repetition is intentional: an API task inspection showed that refine inherits the preview prompt, but a generic texture prompt asking only for “realistic base color” produced a charcoal traffic cone despite the preview prompt specifying orange with reflective bands.

The offline smoke asserts that the built refine request contains the generated `texture_prompt`. When resuming, prompts are refreshed from the current catalog until their corresponding Meshy task has been submitted; submitted tasks retain their recorded prompt/task pairing.


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
