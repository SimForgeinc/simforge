# Immutable SimForge stack publication

SimForge is the source repository for the 13-package TypeScript stack, Python
adapters, Studio, and Renderer. SimForge Cloud consumes published artifacts; it
does not keep private copies of portable implementations.

## Release contract

1. Every public package has the exact lockstep version in
   `config/simforge-oss-stack.json`; the current stack version is `0.1.0-rc.47`.
2. The config contains exactly 13 `@simforge-oss/*` packages and a
   historical `renameManifest` recording the previous package consolidation.
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

`@simforge-oss/scenario`, `@simforge-oss/engine`, `@simforge-oss/maps`,
`@simforge-oss/compiler`, `@simforge-oss/viewer`, `@simforge-oss/editor`,
`@simforge-oss/playback`, `@simforge-oss/asset-catalog`, `@simforge-oss/render`,
`@simforge-oss/openscenario`, `@simforge-oss/training-env`, `@simforge-oss/evaluation`, and
`@simforge-oss/cli`.

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
