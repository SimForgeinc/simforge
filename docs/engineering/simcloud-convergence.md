# SimForge and SimForge Cloud convergence contract

> **Status (2026-08-23):** The SimForge rebrand and 24→13 package
> consolidation are executed by this branch program. The next Cloud intake is
> one mechanical synchronization using the rename manifest.

## Architecture decision

SimForge is the sole editable implementation of portable scenario behavior. It
runs locally without a Cloud account or network service. SimForge Cloud installs
one exact SimForge release and adds hosted capabilities through adapters.

```text
SimForge packages and public runtimes
                  |
          immutable release
                  v
SimForge Cloud product adapters, APIs, durable jobs, storage, billing, operations
```

SimForge portable packages do not import Cloud code. Cloud does not fork, patch,
or reimplement portable behavior. A product need that changes scenario semantics
is implemented and tested here first, released as a complete stack, and then
consumed by Cloud.

### The local Studio surface: `studio/`

`studio/` exposes the same portable authoring, playback, evaluation, model,
map, and rendering surfaces as the hosted product, stripped of productization.
Code flows one way, from SimForge to SimForge Cloud: shared logic is extracted
into a SimForge package and consumed by the platform, never copied from product
code back into this repository. Identity, organizations, billing, entitlements,
managed storage, remote fleets, and hosted job controls belong only in Cloud.

## Ownership

| Capability | Canonical owner | SimForge Cloud responsibility |
|---|---|---|
| Scenario schemas, documents, migrations, validation | `@simforge-oss/scenario` | Persist and authorize documents through product APIs |
| Fixed-step execution, physics, traces, scene state | `@simforge-oss/engine` | Queue work and record durable lifecycle and artifacts |
| OpenDRIVE intelligence and world compilation | `@simforge-oss/maps`, `@simforge-oss/compiler` | Supply authorized map/artifact references and store outputs |
| Authoring, viewport, playback, traffic, assets | `@simforge-oss/editor`, `@simforge-oss/viewer`, `@simforge-oss/playback`, `@simforge-oss/asset-catalog` | Product layout, identity, collaboration, and cloud-backed media |
| Render contracts and engines | `@simforge-oss/render`, `renderer/` | Worker transport, leasing, credentials, capacity, and observability |
| OpenSCENARIO and conformance runners | `@simforge-oss/openscenario` | Import/export endpoints and object storage |
| Training and evaluation protocols | `@simforge-oss/training-env`, `@simforge-oss/evaluation` | Managed training and evaluation jobs |
| CARLA API and CARLA execution logic | `adapters/carla-api`, `adapters/carla-exec` | External runtime capacity and credentials |
| Accounts, workspaces, permissions, billing, datasets, jobs, providers | SimForge Cloud | Entire implementation |

## Development flow

1. Reproduce the desired behavior in SimForge with a portable fixture.
2. Change the smallest canonical package or runtime and verify the boundary.
3. Run local type checks, package tests, release tests, artifact verification,
   packed-package smoke tests, and adapter tests as applicable.
4. Increment the entire lockstep stack version. A stack release is one Git
   revision and one version for all 13 npm packages.
5. Publish from the version tag with provenance.
6. In Cloud, synchronize the exact release. Commit its stack lock,
   content-addressed tarballs/wheels, lockfile integrities, and source revision
   together, following [simcloud-sync.md](simcloud-sync.md).
7. Add only the Cloud adapter or UI needed to expose the shared capability.
8. Promote the same locked artifacts between environments; never rebuild the
   shared stack during promotion.

Urgent fixes follow the same direction. A temporary private package fork is not
an accepted hotfix mechanism.

## Local and offline contract

Without Cloud, this repository supports scenario authoring and validation,
world compilation, deterministic simulation and replay, Studio operation,
OpenSCENARIO import/export and validation, supplied local map assets, native and
web rendering, Gymnasium-semantics training, and optional esmini or CARLA
execution when those external runtimes are installed.

Accounts, collaboration, billing, managed storage, remote queues, and hosted
capacity remain Cloud responsibilities. An unavailable optional service must not
prevent core local authoring or deterministic simulation.

## Publication and immutable consumption

`config/simforge-oss-stack.json` defines release identity and lists the 13-package
stack at `0.1.0-rc.48`. Its historical `renameManifest` records the prior
package consolidation. The release tag is `v<stackVersion>`.

Cloud's committed stack lock is the consumption authority. Its CI verifies:

- all 13 expected npm packages and required Python distributions are present;
- package versions, source revision, digests, npm integrities, and lockfile
  resolution agree;
- no duplicate editor, engine, compiler, OpenSCENARIO, or CARLA implementation
  has appeared in Cloud;
- product code imports `@simforge-oss/*` rather than retired package names;
- frozen database, route, document, and worker contracts remain unchanged.

## Frozen wire contract

The following compatibility values are intentionally not rebranded:

- Postgres schemas and tables under `uniscenario.*`;
- HTTP routes under `/api/uniscenario/**`;
- `uniscenario.*` scenario-format identifiers;
- the `scene-state.v1` wire document id;
- environment variable names consumed by the live worker, including
  `UNISCENARIO_RENDER_WORKER_TOKEN`.

## Rollback

Rollback is a Cloud dependency change, never a republication: restore a prior
stack lock, matching vendor artifacts, and lockfile entries; run the stack
verifier; redeploy against those immutable artifacts; retain the failed release
for diagnosis. Database/API rollback remains a separate Cloud concern.

## Acceptance gates

A convergence change is complete only when ownership audits show no forks,
repeated simulations reproduce the same trace, package and adapter tests pass,
every packed artifact installs cleanly, core operation remains offline, Cloud
verifies and exercises the locked stack, staging and production use identical
digests, rollback restores a prior lock without rebuilding, and the ownership
and wire-contract documentation ships in the same delivery.
