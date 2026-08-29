# SimForge Cloud lockstep synchronization checklist

This checklist is the complete Cloud-side intake for one immutable SimForge OSS
release. Dependency updates are atomic: do not mix stack versions, source
revisions, or artifacts.

## Release inputs

- [ ] Pin the exact SimForge OSS source revision and `stackVersion`.
- [ ] Read `config/simforge-oss-stack.json` as the release authority.
- [ ] Confirm the stack schema is `simforge-oss.stack-config/v1`.
- [ ] Confirm all 15 npm entries have the same `0.1.0-rc.<N>` or stable version.
- [ ] Confirm each public Python distribution has the corresponding normalized
      Python version.
- [ ] Fetch artifacts published from the matching `v<stackVersion>` tag and
      verify provenance before vendoring them.

## Expected npm stack

The vendor lock must contain exactly these packages:

- [ ] `@simforge-oss/scenario`
- [ ] `@simforge-oss/engine`
- [ ] `@simforge-oss/maps`
- [ ] `@simforge-oss/compiler`
- [ ] `@simforge-oss/viewer`
- [ ] `@simforge-oss/editor`
- [ ] `@simforge-oss/playback`
- [ ] `@simforge-oss/asset-catalog`
- [ ] `@simforge-oss/render`
- [ ] `@simforge-oss/openscenario`
- [ ] `@simforge-oss/training-env`
- [ ] `@simforge-oss/evaluation`
- [ ] `@simforge-oss/cli`
- [ ] `@simforge-oss/map-pipeline`
- [ ] `@simforge-oss/map-registry`

Subpath imports such as `engine/scene-state`, `maps/opendrive`, `render/web`, and
`openscenario/esmini` resolve from these package artifacts; they are not separate
stack entries.

## Atomic vendor update

- [ ] Write `vendor/simforge-oss/stack-lock.json` with schema
      `simcloud.simforge-oss-vendor/v1`.
- [ ] Record the canonical repository, exact source revision, stack version,
      package role, tarball or wheel filename, SHA-256, and npm integrity.
- [ ] Vendor every artifact under `vendor/simforge-oss/`.
- [ ] Update the root dependency manifest to use public `@simforge-oss/*`
      packages through the vendored tarballs.
- [ ] Update `services/render-worker` to the exact public Python adapter versions.
- [ ] Regenerate JavaScript and Python dependency locks.
- [ ] Commit the stack lock, vendored artifacts, dependency manifests, lockfiles,
      and consumer code changes together.

## Platform boundaries

- [ ] Keep scenario compilation integration in `services/scenario-compiler`.
- [ ] Keep managed render integration in `services/render-worker`.
- [ ] Import only documented package exports; never import vendored `src/` or
      `dist/` paths.
- [ ] Do not create platform-local packages corresponding to any of the 15 stack
      packages.
- [ ] Keep identity, organizations, billing, entitlements, durable storage,
      remote fleets, and hosted job controls in Cloud.
- [ ] Move any portable semantic or rendering behavior to SimForge OSS, publish
      it, then consume the new release.

## Verification

- [ ] Run the divergence audit using `config/simcloud-integration.json`.
- [ ] Verify every package and wheel version, role, digest, integrity, source
      revision, and dependency-lock resolution.
- [ ] Build Cloud using only public package entry points.
- [ ] Exercise scenario load/save, compilation, simulation, replay, web/native
      rendering, OpenSCENARIO import/export, map ingestion, and evaluation.
- [ ] Confirm staging and production promote the identical locked artifacts.
- [ ] Confirm the previous committed lock and artifact set remains a viable
      rollback target.

## Historical naming

Immutable, already-applied database migrations retain historical `uniscenario`
identifiers so existing local databases remain loadable. No compatibility alias
is prescribed for new packages, environment variables, routes, or source paths.
