# OpenSCENARIO architecture

This document is the architecture authority for OpenSCENARIO in SimForge and
SimForge Cloud. The implementation authority is `@simforge-oss/openscenario`.

## Decision

Standards semantics flow in one direction:

```text
@simforge-oss/scenario + @simforge-oss/engine + @simforge-oss/maps
                         |
                         v
                @simforge-oss/openscenario
             /esmini          /trace-diff
                         |
       +-----------------+------------------+
       v                 v                  v
@simforge-oss/cli      SimForge Studio    adapters/carla-exec
```

`@simforge-oss/openscenario` never depends on the CLI, Studio, Cloud, esmini, or
CARLA presentation/transport code. Its browser-safe root does not import
Node-only execution modules.

## Public boundaries

| Entry point | Runtime | Owns |
|---|---|---|
| `@simforge-oss/openscenario` | Browser-safe | Import analysis/translation, export compilers, capability reports, snapshots |
| `@simforge-oss/openscenario/import` | Browser-safe | Bounded XML parsing, security rejection, map resolution, translation |
| `@simforge-oss/openscenario/export` | Browser-safe | Format selection and portable compiler profiles |
| `@simforge-oss/openscenario/types` | Type-only | Options, results, issues, warnings, fidelity vocabulary |
| `@simforge-oss/openscenario/xml-1.4` | Browser-worker-safe | Native XML 1.4 compiler without Node dependencies |
| `@simforge-oss/openscenario/node` | Node-only | Digest-pinned XSD validation and complete runnable bundles |
| `@simforge-oss/openscenario/esmini` | Node-only | Sandboxed esmini execution and receipts; never rewrites a bundle |
| `@simforge-oss/openscenario/trace-diff` | Portable/Node | Deterministic canonical-vs-external trace comparison |
| `adapters/carla-exec` | Python/runtime | Execute SimForge scenarios in real CARLA; never author standards semantics |

`@simforge-oss/cli` owns argument parsing, files, exit codes, and JSON output.
Studio owns interaction and presentation. Cloud owns identity, authorization,
durable jobs, storage, observability, and billing.

## Canonical flows

### Native export

1. Authoring produces a validated `@simforge-oss/scenario` document.
2. `@simforge-oss/compiler` creates a concrete world bound to map digests.
3. `@simforge-oss/engine` produces the canonical trace.
4. `@simforge-oss/openscenario` creates an immutable snapshot bound to document,
   concrete input, trace, map, and exporter digests.
5. The selected compiler emits XML/DSL plus a complete capability report.
6. Node validation checks XML against the digest-pinned ASAM schema when
   requested; browser compilation remains available without Node.

### esmini compatibility and execution

1. The snapshot is lowered into the explicitly named XML 1.3 compatibility
   profile.
2. The Node resolver supplies the complete digest-matched OpenDRIVE file.
3. `/esmini` validates and runs the immutable bundle in a sandbox.
4. `/trace-diff` compares the external trajectory against the canonical trace
   and reports tolerances, discontinuities, missing actors, and time alignment.

### Import

1. An adapter applies transport limits before parsing.
2. The browser-safe importer rejects unsupported DTD/entity behavior and
   produces structured findings.
3. Map references resolve through `@simforge-oss/maps` using explicit map identity
   and digest.
4. Translation produces a draft scenario plus a capability report; unsupported
   constructs remain visible and never silently disappear.

## Artifact identity

Published artifacts and external results bind scenario/document revision,
concrete input hash, trace hash, map id and OpenDRIVE digest, exporter profile
and version, package stack revision, external runner version/image digest, and
the capability report. XML validity alone is not behavioral equivalence.

## Repository ownership

| Concern | Canonical location | Adapter-only locations |
|---|---|---|
| Scenario/schema semantics | `packages/scenario` | Studio/Cloud view models |
| World compilation | `packages/compiler` | Studio/Cloud request handlers |
| OpenDRIVE resolution | `packages/maps` | Storage and delivery adapters |
| Snapshot/export/import | `packages/openscenario` | CLI/Studio/Cloud transports |
| esmini execution | `packages/openscenario` `/esmini` | Local/cloud process transport |
| Trace comparison | `packages/openscenario` `/trace-diff` | Qualification runners |
| CARLA execution | `adapters/carla-exec` | Cloud worker leasing/storage |

## Change protocol

Change semantics in `packages/openscenario` with a portable fixture; validate
browser-safe compilation separately from Node execution; update the capability
matrix before enabling a new construct; test the CLI and Studio adapters without
moving standards logic into them; publish the complete lockstep stack; then
synchronize Cloud using [simcloud-sync.md](simcloud-sync.md).
