# UniScenarios and SimCloud convergence contract

## Architecture decision

UniScenarios is the sole editable implementation of portable scenario behavior.
It must run locally without a SimCloud account or network service. SimCloud
Platform is the product shell: it installs one exact UniScenarios release and
adds cloud capabilities through adapters.

The dependency direction is one way:

```text
UniScenarios packages and public runtimes
                  |
          immutable release
                  v
SimCloud product adapters, APIs, durable jobs, storage, billing, and operations
```

UniScenarios must not import SimCloud code. SimCloud must not fork, patch, or
reimplement portable behavior. A product need that changes scenario semantics is
implemented and tested here first, released as a complete stack, and then
consumed by SimCloud.

### Addendum (2026-08-23): the local product surface `apps/cloud`

`apps/cloud` is a deliberate, scoped exception to "UniScenarios must not
import SimCloud code": it is a 1:1 COPY of SimCloud's product presentation and
API layer (dashboard, app switcher, scenario editor, control-plane routes)
living in this repo so the complete product runs locally with no cloud. It is
not a fork: files stay byte-faithful to SimCloud source except at three local
seams (embedded-Postgres DB adapter, filesystem object store behind the S3
helper API, fixed local identity) plus documented local additions
(browser-recording reservation routes, enriched worker claim closure, local
compiler/render worker, legacy-table migrations). Product behavior changes
still land in SimCloud first (or simultaneously) and are re-copied here;
`apps/cloud` must never grow product semantics SimCloud lacks. Engine
dependency direction is unchanged: `apps/cloud` consumes the workspace
packages the same way SimCloud consumes the released tarballs. See
`docs/simcloud-local-port-plan.md` and `docs/context/`.

## Ownership

| Capability | Canonical owner | SimCloud responsibility |
| --- | --- | --- |
| Scenario schemas, documents, migrations, and validation | UniScenarios | Persist and authorize documents through product APIs |
| V2 editor document, interactions, overlays, and viewer contract | UniScenarios | Product layout, identity, collaboration, and cloud actions |
| Materialization and deterministic seeds | UniScenarios | Supply authorized map/artifact references and store outputs |
| Physics, simulation, actors, triggers, actions, and traces | UniScenarios | Queue work and record durable lifecycle and artifacts |
| Playback, camera models, renderer contracts, and prop catalog | UniScenarios | Deliver product assets and cloud-backed media |
| OpenSCENARIO 1.4 and OpenDRIVE bindings | UniScenarios | Import/export endpoints and object storage |
| esmini and CARLA execution logic | UniScenarios public adapters | Worker transport, leasing, credentials, capacity, and observability |
| Accounts, workspaces, permissions, billing, datasets, jobs, and providers | SimCloud | Entire implementation |

The retired editor is not a compatibility authority. New work targets the
shared v2 editor only.

## Development flow

1. Reproduce the desired behavior in UniScenarios with a portable fixture.
2. Change the smallest canonical package or public runtime. Add deterministic
   tests at that boundary and cross-package tests when behavior spans packages.
3. Run local type checks, package tests, release tests, artifact verification,
   packed-package smoke tests, and CARLA adapter tests as applicable.
4. Increment the whole stack version. A stack release is one Git revision, one
   version for all npm packages, and the PEP 440 equivalent for the Python
   wheel. Do not publish selected packages from a mixed source tree.
5. Publish from the version tag with the trusted GitHub workflow and provenance.
6. In SimCloud, synchronize the exact release. Commit the stack lock,
   content-addressed npm tarballs, CARLA wheel, npm lock integrities, and source
   revision together.
7. Implement only the cloud adapter or product UI needed to expose the shared
   capability. Run SimCloud unit, integration, web, and worker tests.
8. Promote the same locked artifacts between environments. Do not rebuild the
   shared stack during promotion.

Urgent product fixes follow the same direction: first make the portable fix in
UniScenarios, then consume its release in SimCloud. A temporary private fork is
not an accepted hotfix mechanism.

## Local and offline contract

The following capabilities work from this repository without SimCloud:

- scenario creation, validation, migration, and materialization;
- v2 editor interaction and local trace playback;
- deterministic simulation, interaction, and comparison;
- OpenSCENARIO import/export and schema validation;
- local map inspection when the user supplies map files under `dev-assets/`;
- optional local esmini or CARLA execution when those external runtimes and
  assets are installed.

Cloud accounts, object storage, queues, managed maps, collaboration, billing,
and remote GPU capacity are SimCloud features. Optional AI assistance and
external simulators must fail as unavailable adapters, not prevent core local
authoring or deterministic simulation.

## Publication and immutable consumption

`config/uniscenarios-stack.json` defines release identity. The tag must be
`v<stackVersion>`. The publication workflow tests the canonical packages,
builds every package, verifies package contents, smoke-installs every packed npm
artifact and the CARLA wheel, and publishes with npm/PyPI provenance.

SimCloud's committed `vendor/uniscenarios/stack-lock.json` is the consumption
authority. Its CI verifies:

- all 16 expected npm packages and the one public CARLA wheel are present;
- package versions, source revision, SHA-256 digests, npm integrity values, and
  lockfile resolution agree;
- no editable duplicate package, editor implementation, physics engine,
  OpenSCENARIO implementation, or CARLA runtime has appeared in SimCloud;
- product code imports the public package names rather than retired aliases.

## Rollback

Rollback is a SimCloud dependency change, not a republication:

1. Restore a previously committed stack lock, matching vendor artifacts, and
   npm lockfile entries in one change.
2. Run SimCloud's stack verifier before build or deployment.
3. Redeploy the product adapters against those already immutable artifacts.
4. Preserve the failed release and its provenance for diagnosis. Never replace
   an npm/PyPI version or move a release tag.

Database or product API rollback remains a SimCloud concern and must be planned
separately from the portable stack rollback.

## Acceptance gates

A convergence change is complete only when all applicable gates pass:

- **Ownership:** the divergence audit reports no duplicate implementation or
  forbidden import.
- **Determinism:** repeated simulations are byte/trace equivalent for the same
  scenario, seed, map inputs, engine version, and fixed-step settings.
- **Conformance:** scenario model, materializer, engine, playback,
  OpenSCENARIO, v2 editor, and public adapter tests pass in UniScenarios.
- **Packaging:** every packed package and wheel installs in a clean environment;
  versions, exports, provenance inputs, and digests agree.
- **Offline:** core authoring, validation, materialization, simulation, and
  playback tests require no SimCloud service.
- **Product:** SimCloud verifies the locked stack, passes product/worker tests,
  and exercises v2 editor import, save, simulation, playback, OpenSCENARIO
  export, and cloud job submission at the appropriate test level.
- **Promotion and rollback:** staging/production use the same artifact digests,
  and a previously committed lock can be restored and verified without
  rebuilding or republishing.
- **Documentation:** behavior and ownership changes update public contracts and
  product adapter documentation in the same delivery.

The historical five-map, 500-slot incident campaign is a content and realism
qualification program. Its current failures must stay visible and be repaired,
but they do not authorize package forks or block proof that SimCloud consumes
the exact canonical architecture. Architecture conformance and campaign
qualification are reported as separate gates so neither can mask the other.
