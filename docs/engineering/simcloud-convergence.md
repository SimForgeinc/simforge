# SimForge OSS and SimForge Cloud convergence contract

## Architecture decision

SimForge OSS is the sole editable implementation of portable scenario behavior.
It runs locally without a Cloud account or network service. SimForge Cloud
installs one exact lockstep release and adds hosted capabilities through product
adapters.

```text
SimForge OSS packages and public runtimes
                    |
            immutable release
                    v
SimForge Cloud APIs, durable jobs, storage, billing, and operations
```

Portable packages never import Cloud code. Cloud does not fork, patch, or
reimplement portable behavior. A product change to scenario semantics is made
and verified here first, released as a complete stack, then consumed by Cloud.
Code flows one way: shared behavior is extracted into SimForge OSS and imported
by the platform, never copied from the platform back into this repository.

## Ownership

| Capability | Canonical owner | Cloud responsibility |
|---|---|---|
| Scenario schemas and validation | `@simforge-oss/scenario` | Persistence, authorization, and product APIs |
| Fixed-step execution, physics, and scene state | `@simforge-oss/engine` | Durable job lifecycle and artifact storage |
| OpenDRIVE intelligence and world compilation | `@simforge-oss/maps`, `@simforge-oss/compiler` | Authorized map and artifact references |
| Authoring, viewport, playback, and assets | `@simforge-oss/editor`, `@simforge-oss/viewer`, `@simforge-oss/playback`, `@simforge-oss/asset-catalog` | Product layout, collaboration, and cloud-backed media |
| Render contracts and engines | `@simforge-oss/render`, `renderer/` | Leasing, credentials, capacity, and observability |
| OpenSCENARIO import, export, and conformance | `@simforge-oss/openscenario` | Endpoints and object storage |
| Training and evaluation protocols | `@simforge-oss/training-env`, `@simforge-oss/evaluation` | Managed training and evaluation jobs |
| Command-line workflows | `@simforge-oss/cli` | Product orchestration only |
| Map ingestion and publication | `@simforge-oss/map-pipeline`, `@simforge-oss/map-registry` | Managed source intake and access control |
| CARLA API and execution adapters | `adapters/carla-api`, `adapters/carla-exec` | External runtime capacity and credentials |
| Accounts, workspaces, permissions, billing, datasets, and hosted providers | SimForge Cloud | Entire implementation |

## Lockstep release contract

`config/simforge-oss-stack.json` is the release authority. It lists exactly 15
npm packages and the public Python distributions. Every npm package has the same
`stackVersion`; prereleases use `0.1.0-rc.<N>`, and the release tag is
`v<stackVersion>`. A release is one source revision, one version, and one
immutable artifact set.

The 15 npm packages are:

- `@simforge-oss/scenario`
- `@simforge-oss/engine`
- `@simforge-oss/maps`
- `@simforge-oss/compiler`
- `@simforge-oss/viewer`
- `@simforge-oss/editor`
- `@simforge-oss/playback`
- `@simforge-oss/asset-catalog`
- `@simforge-oss/render`
- `@simforge-oss/openscenario`
- `@simforge-oss/training-env`
- `@simforge-oss/evaluation`
- `@simforge-oss/cli`
- `@simforge-oss/map-pipeline`
- `@simforge-oss/map-registry`

Cloud commits its lock at `vendor/simforge-oss/stack-lock.json`. The lock records
the source revision, stack version, package roles, artifact digests, npm
integrities, and Python wheel identities. All deployment environments promote
those exact artifacts; none rebuild the shared stack.

## Development and intake flow

1. Reproduce the required behavior in SimForge OSS with a portable fixture.
2. Change the smallest canonical package or runtime and verify its boundary.
3. Increment the complete lockstep stack version and publish from the matching
   source tag with provenance.
4. In Cloud, synchronize the exact release and commit the vendor lock, artifacts,
   dependency lockfiles, and source revision together.
5. Add only the Cloud adapter or product UI required to expose the capability.
6. Run the divergence audit and exercise the complete platform flow.

The current platform integration points are `services/scenario-compiler` and
`services/render-worker`. Urgent fixes follow the same direction; a private
package fork is not an accepted hotfix mechanism.

## Historical naming

Immutable, already-applied database migrations retain historical `uniscenario`
identifiers so existing local databases remain loadable. They are historical
storage facts, not names for new code, routes, environment variables, packages,
or documentation.

## Rollback

Rollback is a dependency change, never a republication. Restore a prior vendor
lock, matching artifacts, and dependency lockfiles; run the stack verifier; then
redeploy those immutable artifacts. Retain the failed release for diagnosis.

## Acceptance gates

A convergence change is complete only when ownership audits find no portable
forks, all 15 package artifacts match the stack version and source revision,
packed artifacts install cleanly, core local operation remains offline, Cloud
exercises the locked stack, staging and production use identical digests, and
rollback restores a prior lock without rebuilding.
