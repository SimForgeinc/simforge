# SimForge repository transition

> **Status (2026-08-23):** The SimForge rebrand and 24→13 package consolidation
> are executed by this branch program. The extraction provenance below remains
> unchanged.

This repository is the standalone successor to the Scenario Studio working tree.
It was extracted without modifying or deleting the source repository.

## Current naming contract

- Platform and repository: **SimForge** / `simforge`
- Components: **SimForge Engine**, **SimForge Renderer**, **SimForge Studio**,
  and **SimForge Cloud**
- Package scope: `@simforge/*`; exactly 13 public TypeScript packages
- Primary CLI: `simforge`; short alias: `sf`
- Compatibility CLI: `uniscenarios` is a deprecated one-release alias that
  warns and delegates
- Application workspace: `studio/` (`@simforge/studio`)
- Native renderer workspace: `renderer/`

The legacy Vite `apps/studio` application and `packages/editor-ui` are deleted.
The naming contract is executable:

```sh
pnpm verify:naming
```

The audit checks the root name, workspace package scope, 13-package stack, CLI
names, duplicate workspace names, target directories, and public documentation.
Historical documents may retain pre-rebrand names when their header identifies
them as historical provenance.

## Frozen compatibility identifiers

The rebrand does not rename Postgres `uniscenario.*` schemas,
`/api/uniscenario/**` routes, scenario-format identifiers, `scene-state.v1`, or
environment variables consumed by the live worker, including
`UNISCENARIO_RENDER_WORKER_TOKEN`. These values are the SimForge Cloud wire
contract rather than public product names.

## Provenance and local-only state

`MIGRATION-SOURCE.json` is an integrity inventory of the extraction input. It
records the source commit and branch, dirty status, file kind, POSIX mode, and
SHA-256 digest of every tracked or non-ignored untracked source file copied by
the extractor.

The provenance classification is **verification-only, non-reconstructible**.
The manifest can prove that an independently obtained source checkout matches
the captured input, but it cannot create that checkout. Hashes do not contain
the modified or untracked file bytes from the dirty working tree; committed
`HEAD` alone is insufficient to reproduce the exact extraction input.

No source URL or source filesystem path is recorded. A caller that already has
a candidate source checkout can verify it:

```sh
node scripts/verify-migration-source.mjs \
  --source /path/to/candidate-source-checkout
```

The verifier fails closed unless Git `HEAD`, branch, complete porcelain status,
tracked/non-ignored path set, file kinds, modes, and SHA-256 digests all match.
A successful check establishes identity with the recorded snapshot; it does not
establish how the checkout was obtained or that it will remain available.

The extraction preserves committed history but configures no Git remote, so
publishing requires an explicit remote choice. Ignored dependencies, generated
output, local render evidence, and proprietary/local map assets are not
committed. Provide `dev-assets/` separately for local development.

## Compatibility

New integrations use `simforge` or `sf`. The deprecated `uniscenarios` binary
exists for one release only and emits a warning before delegating. Serialized
scenario and wire formats retain their frozen identifiers.
