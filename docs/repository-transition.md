# UniScenarios repository transition

This repository is the standalone successor to the Scenario Studio working tree.
It was extracted without modifying or deleting the source repository.

## Naming contract

- Product and repository: **UniScenarios** / `uniscenarios`
- Package scope: `@uniscenarios/*`
- Primary CLI: `uniscenarios`
- Compatibility CLI alias: `scen`
- Application workspaces: `apps/cloud` (`@uniscenarios/cloud`, the launched
  product surface since 2026-08-23) and `apps/studio` (`@uniscenarios/studio`,
  legacy authoring surface behind `dev:studio-legacy`, pending removal)

The `apps/studio` directory name describes the retired authoring surface; the
current product UI is the SimCloud-identical `apps/cloud` (see
`docs/context/project-overview.md`). Public UI, schemas, package metadata, and
documentation use UniScenarios naming.

The naming contract is executable:

```sh
pnpm verify:naming
```

The audit checks the root name, every workspace package scope, the primary and
compatibility CLI names, duplicate workspace names, and public documentation.
Legacy product naming is allowed only in these transition and extraction
documents, where it identifies historical provenance rather than the current
product.

## Provenance and local-only state

`MIGRATION-SOURCE.json` is an integrity inventory of the extraction input. It
records the source commit and branch, the dirty status, and the file kind,
POSIX mode, and SHA-256 digest of every tracked or non-ignored untracked source
file copied by the extractor.

The provenance classification is **verification-only, non-reconstructible**.
The manifest can prove that an independently obtained source checkout matches
the captured input, but it cannot create that checkout. In particular, hashes
do not contain the modified or untracked file bytes from the dirty working tree.
The committed `HEAD` alone is therefore insufficient to reproduce the exact
extraction input.

No source URL or source filesystem path is recorded. This is deliberate: no
public source location or continuing availability has been established, and a
machine-local path would expose local information without making the snapshot
portable. A caller that already has a candidate source checkout can verify it:

```sh
node scripts/verify-migration-source.mjs \
  --source /path/to/candidate-source-checkout
```

The verifier fails closed unless the Git `HEAD`, branch, complete porcelain
status, complete tracked/non-ignored path set, file kinds, modes, and SHA-256
digests all match. A successful check establishes identity with the recorded
snapshot; it does not establish how the checkout was obtained or that it will
remain available.

The extraction preserves committed history but intentionally configures no Git
remote, so publishing requires an explicit remote choice.

Ignored dependencies, generated build output, local render evidence, and
proprietary/local map assets are not committed. Publish selected evidence through
Git LFS or an external artifact store. For local development, provide `dev-assets/` separately or
use the extraction command's `--link-dev-assets` option on the source machine.

## Compatibility

Existing automation can continue invoking `scen`. New integrations should use
`uniscenarios`. Serialized scenario formats retain their schema versions; only
the owning product namespace and canonical schema host have changed.
