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

## Verified Phase-2 artifacts (`0.1.0-rc.45`)

The release dry-run produced exactly these npm tarballs. Sizes are compressed
bytes from `/tmp/simforge-pack`; Cloud must replace these local paths with the
published integrity-pinned artifacts.

| Tarball | Bytes |
|---|---:|
| `simforge-asset-catalog-0.1.0-rc.45.tgz` | 284900 |
| `simforge-cli-0.1.0-rc.45.tgz` | 230536 |
| `simforge-compiler-0.1.0-rc.45.tgz` | 388113 |
| `simforge-editor-0.1.0-rc.45.tgz` | 174603 |
| `simforge-engine-0.1.0-rc.45.tgz` | 486922 |
| `simforge-evaluation-0.1.0-rc.45.tgz` | 80944 |
| `simforge-maps-0.1.0-rc.45.tgz` | 207118 |
| `simforge-openscenario-0.1.0-rc.45.tgz` | 205743 |
| `simforge-playback-0.1.0-rc.45.tgz` | 139209 |
| `simforge-render-0.1.0-rc.45.tgz` | 112629 |
| `simforge-scenario-0.1.0-rc.45.tgz` | 415188 |
| `simforge-training-env-0.1.0-rc.45.tgz` | 58351 |
| `simforge-viewer-0.1.0-rc.45.tgz` | 260046 |

All 13 archives were checked for matching package name/version and export map,
existing `dist` export targets, allowed top-level files, files larger than
5 MB, and the literal retired scope `@uniscenarios`; no mismatch, oversized
file, unexpected top-level file, or retired-scope string was found.

## Verified import rewrite table

`renameManifest` in `config/simforge-stack.json` is the machine-readable
authority. This rendered snapshot is for review; the sync tool must read the
JSON object rather than parse this table.

| Old import/dependency | New import/dependency |
|---|---|
| `@uniscenarios/ambient-traffic` | `@simforge/playback/traffic` |
| `@uniscenarios/anchor-matcher` | `@simforge/compiler` |
| `@uniscenarios/browser-renderer` | `@simforge/render/web` |
| `@uniscenarios/camera-rig` | `@simforge/viewer` |
| `@uniscenarios/city-renderer` | `@simforge/viewer` |
| `@uniscenarios/cli` | `@simforge/cli` |
| `@uniscenarios/editor-core` | `@simforge/editor` |
| `@uniscenarios/editor-ui` | `@simforge/editor` (the retired presentation package is removed; delete the dependency if no editor-core import remains) |
| `@uniscenarios/esmini-runner` | `@simforge/openscenario/esmini` |
| `@uniscenarios/examiner` | `@simforge/evaluation` |
| `@uniscenarios/map-intel` | `@simforge/maps` |
| `@uniscenarios/native-renderer` | `@simforge/render/native` |
| `@uniscenarios/openscenario` | `@simforge/openscenario` |
| `@uniscenarios/playback` | `@simforge/playback` |
| `@uniscenarios/policy-eval` | `@simforge/evaluation` |
| `@uniscenarios/prop-catalog` | `@simforge/asset-catalog` |
| `@uniscenarios/render-runtime` | `@simforge/render` |
| `@uniscenarios/rl-env` | `@simforge/training-env` |
| `@uniscenarios/scenario-materializer` | `@simforge/compiler` |
| `@uniscenarios/scenario-model` | `@simforge/scenario` |
| `@uniscenarios/scene-state` | `@simforge/engine/scene-state` |
| `@uniscenarios/sim-engine` | `@simforge/engine` |
| `@uniscenarios/trace-comparator` | `@simforge/openscenario/trace-diff` |
| `@uniscenarios/xodr-tools` | `@simforge/maps/opendrive` |

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

Use the following extended-regexp as the frozen-contract tripwire:

```sh
FROZEN_CONTRACT='uniscenario\.[[:alnum:]_./-]+|schemas\.uniscenarios\.dev|/api/uniscenario(/|[^[:alnum:]_-]|$)|scene-state\.v1|UNISCENARIO_RENDER_WORKER_TOKEN'
git grep -n -E "$FROZEN_CONTRACT"
git diff -U0 "$PRE_SYNC_REVISION" -- . | grep -E "^[+-][^+-].*($FROZEN_CONTRACT)"
```

The first command inventories the retained wire identifiers. The second must
print nothing: a changed line containing any frozen identifier is outside this
mechanical sync and requires a separate wire migration. In addition, run
`git grep -n -E '@uniscenarios/'`; it must print nothing after import rewriting.

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
