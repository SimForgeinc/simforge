# Immutable SimForge stack publication

SimForge is the source repository for the 13-package TypeScript stack, Python
adapters, Studio, and Renderer. SimForge Cloud consumes published artifacts; it
does not keep private copies of portable implementations.

## Release contract

1. Every public package has the exact lockstep version in
   `config/simforge-stack.json`; the current stack version is `0.1.0-rc.45`.
2. The config contains exactly 13 `@simforge/*` packages and a
   `renameManifest` mapping every old name to its new package or subpath.
3. A release tag is exactly `v<stackVersion>` and identifies one immutable Git
   tree. Published versions are never overwritten or reused.
4. Internal dependencies in packed artifacts are pinned to that stack version;
   no `workspace:` specifier survives publication.
5. Export maps and packed files are verified before publication. Browser-safe
   roots do not pull Node-only, three.js, or native execution code through
   merged subpaths.
6. npm and Python publication run only from the tagged trusted workflow with
   provenance. Local release commands prepare and verify artifacts but do not
   publish.
7. The source revision, tarball/wheel SHA-256, npm integrity, package role, and
   version are recorded in the generated release manifest.

## Package set

`@simforge/scenario`, `@simforge/engine`, `@simforge/maps`,
`@simforge/compiler`, `@simforge/viewer`, `@simforge/editor`,
`@simforge/playback`, `@simforge/asset-catalog`, `@simforge/render`,
`@simforge/openscenario`, `@simforge/training-env`, `@simforge/evaluation`, and
`@simforge/cli`.

## Release procedure

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:release
pnpm release:manifest
pnpm release:pack
pnpm release:verify
pnpm release:smoke
```

Inspect the generated manifest and packed contents. Commit the version and
manifest changes, create `v<stackVersion>`, and push the tag. The trusted
workflow rebuilds from the tag, reruns verification, checks the tag/version/tree
identity, publishes, and attaches provenance.

The Cloud intake follows [simcloud-sync.md](simcloud-sync.md): its stack lock,
13 vendored artifacts, import rewrites, package-manager lockfile, and divergence
audit expectations change atomically.

## Rollback

Rollback Cloud by restoring a previously committed stack lock and its matching
content-addressed artifacts. Never republish an old version, overwrite an npm
package, or move a release tag.
