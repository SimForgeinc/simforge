# UniScenarios repository extraction
> **Historical record:** The UniScenarios repository name and extraction
> commands are retained verbatim because they identify the source snapshot.


This document records the one-time historical extraction procedure. The source
Scenario Studio working tree contained active, uncommitted work from multiple
agents, so it could not be moved, reset, or treated as the final repository
boundary before that work was preserved.

Use the one-way extractor to create the standalone UniScenarios repository:

```sh
node scripts/extract-uniscenarios.mjs \
  --destination /path/to/UniScenarios \
  --link-dev-assets \
  --commit
```

The destination must not already exist. The extractor:

1. clones the source Git history without filesystem hard links;
2. overlays every tracked file, tracked edit, and non-ignored untracked file;
3. records source provenance, file kinds and modes, and SHA-256 hashes in
   `MIGRATION-SOURCE.json`;
4. changes the product and package namespace to UniScenarios / `@uniscenarios`;
5. exposes `uniscenarios` as the primary CLI while preserving `scen` as an alias;
6. removes the clone's local-source remote, leaving remote publication explicit;
7. optionally links ignored local `dev-assets/` so the new checkout can run on
   the same workstation without copying proprietary or multi-gigabyte map data.

The source repository is never modified beyond adding this extraction tooling.
The extractor requires an explicit absolute destination and refuses to overwrite
an existing destination. It has no author- or machine-specific default path.

## Provenance boundary

The manifest produced for this transition describes a dirty working tree. It is
an identity record, not a source archive: the status entries and SHA-256 hashes
do not include enough information to recover modified or untracked file bytes.
Consequently, the exact extraction input is not reconstructible from
`MIGRATION-SOURCE.json` and the recorded Git `HEAD` alone.

There is no asserted source locator. Do not infer or publish a URL from the old
repository name, and do not treat an author-specific filesystem path as a
portable locator. Verification requires a candidate checkout obtained through
an independent, authorized channel:

```sh
node scripts/verify-migration-source.mjs \
  --source /path/to/candidate-source-checkout
```

The verifier compares the candidate's `HEAD`, branch, full porcelain status,
tracked/non-ignored path set, file kinds, POSIX modes, and file or symlink-target
SHA-256 digests. It reports success only when every check matches. The default
manifest is `MIGRATION-SOURCE.json`; tests or audits can select another manifest
with `--manifest /path/to/manifest.json`.
