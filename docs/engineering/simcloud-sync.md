# SimForge Cloud one-mechanical-sync checklist

This checklist is the complete Cloud-side intake for the SimForge rebrand and
package consolidation. It is one atomic dependency synchronization, not an API
redesign.

## Inputs

- [ ] Pin the exact SimForge source revision and lockstep stack version.
- [ ] Read `config/simforge-stack.json` as the release authority.
- [ ] Use its `renameManifest` for every old package → new package or subpath
      rewrite; do not maintain a second hand-written map.
- [ ] Verify the manifest contains all previous vendored package names exactly
      once and points only to the 13-package target stack.

## Stack lock: 21 → 13 npm entries

- [ ] Replace the 21 old npm entries with these 13 entries:
      `@simforge/scenario`, `@simforge/engine`, `@simforge/maps`,
      `@simforge/compiler`, `@simforge/viewer`, `@simforge/editor`,
      `@simforge/playback`, `@simforge/asset-catalog`, `@simforge/render`,
      `@simforge/openscenario`, `@simforge/training-env`,
      `@simforge/evaluation`, and `@simforge/cli`.
- [ ] Update merged entry points: `@simforge/engine/scene-state`,
      `@simforge/maps/opendrive`, `@simforge/playback/traffic`,
      `@simforge/render/web`, `@simforge/render/native`,
      `@simforge/openscenario/esmini`, and
      `@simforge/openscenario/trace-diff`.
- [ ] Replace every `@uniscenarios/*` import and package dependency according to
      `renameManifest`; do not infer destinations from similar names.
- [ ] Vendor the 13 content-addressed tarballs and record source revision,
      version, SHA-256, npm integrity, and role for each.
- [ ] Regenerate the package-manager lockfile and verify every internal edge
      resolves to the same stack version.
- [ ] Remove retired vendored entries for `editor-ui` and packages absorbed by
      merged packages.
- [ ] Keep Python adapters distinct: `carla-api` is the `import carla` facade
      over SimForge; `carla-exec` runs scenarios in real CARLA.

## Frozen wire contract: no changes

- [ ] Keep Postgres schemas and tables under `uniscenario.*` byte-compatible.
- [ ] Keep HTTP routes under `/api/uniscenario/**` unchanged.
- [ ] Keep `uniscenario.*` identifiers embedded in scenario documents
      unchanged.
- [ ] Keep the `scene-state.v1` document id and serialization contract
      unchanged.
- [ ] Keep environment variable names consumed by the live worker unchanged,
      including `UNISCENARIO_RENDER_WORKER_TOKEN`.
- [ ] Treat any proposed rename in this list as a separate wire migration and
      reject it from this mechanical synchronization.

## Verification and commit boundary

- [ ] Run the Cloud divergence audit: no copied SimForge engine, editor,
      compiler, rendering, or OpenSCENARIO implementation is introduced.
- [ ] Run the stack verifier against all 13 artifacts, their digests, npm
      integrities, and the pinned source revision.
- [ ] Build Cloud with only public `@simforge/*` entry points.
- [ ] Exercise scenario load/save, simulation, replay, web/native render job
      submission, and OpenSCENARIO export without changing request or stored
      document bytes.
- [ ] Commit stack lock, vendored artifacts, import rewrites, package-manager
      lockfile, and divergence-audit expectations together.
- [ ] Preserve the previous committed stack lock and artifacts as the rollback
      target; never republish or overwrite a package version.
