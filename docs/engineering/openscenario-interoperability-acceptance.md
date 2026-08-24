# OpenSCENARIO interoperability acceptance

This matrix is the release gate for the OpenSCENARIO workspace. A green XML
schema badge alone is not interoperability, and a visually plausible video is
not behavioral parity. The native export, compatibility export, external run,
and quantitative comparison are independent results.

## Required acceptance matrix

| Layer | Required evidence | Pass condition |
| --- | --- | --- |
| Native XML 1.4 | Generated `.xosc`, pinned official XSD digest, validator output | XML validates against the pinned ASAM OpenSCENARIO XML 1.4 XSD; no network or external entities are used during validation |
| esmini XML 1.3 | Compatibility `.xosc`, capability report | Header is genuinely 1.3; each source field/action is marked preserved, derived, approximated, trajectory-baked, omitted, or unsupported; unsupported required semantics fail closed |
| Runnable bundle | `.xosc`, complete immutable `.xodr`, dependency manifest, hashes | All references resolve inside the bundle; no absolute paths, `..`, remote URLs, catalogs outside the allowlist, or digest mismatch |
| External execution | Runner receipt, pinned esmini version/digest, stdout/stderr, exit code, trace | Sandboxed headless job reaches the authored 20.000 s stop condition at a fixed step without timeout, crash, missing assets, or simulation error |
| Quantitative parity | Canonical trace, esmini trace, comparator report and thresholds | Every mapped actor is aligned by stable identity; completion, position, heading, speed, final state, and collision results pass the declared tolerances |
| Studio workspace | Overview, Schema, Compatibility, Issues, Validation, Replay and Files views | Current immutable export snapshot is shown; stale results are visibly invalidated; raw XML is read-only; every displayed/downloaded artifact has the same snapshot identity |
| Replay comparison | Synchronized trace replay and delta panel | Scrubbing uses the same time in both traces; missing actors/samples and threshold failures are explicit; video is supporting evidence only |
| Provenance/cache | Scenario, map, exporter, schema, runner and threshold digests | Cache hits require the entire key; reports retain immutable inputs, tool versions, timestamps and hashes |
| Security | Adversarial bundle and runner tests | Reject traversal, symlinks escaping the bundle, remote dependencies, XML entities, oversized archives/files, unexpected file types, output floods and jobs exceeding CPU/memory/time limits |

## Representative scenario set

The gate is intentionally small but covers different portability modes.

| Fixture | Required semantics | Expected external verdict |
| --- | --- | --- |
| Vehicle action choreography | Absolute speed, stop, left lane change, left indicator on/off | XML 1.3 semantic execution when supported; all actions visible in the mapping report |
| Pedestrian crossing | Pedestrian entity and exact crossing trajectory | Trajectory parity required; pedestrian animation appearance is informational |
| Dynamic signal interaction | Signal phase/control state affects vehicle motion | Fail closed for semantic export when the pinned runner cannot preserve the control; trajectory-baked motion may pass only under a clearly different verdict |
| Exact trajectory replay | At least two actors, 20 s, fixed samples | Full numerical parity gate and the first mandatory real esmini smoke job |

At least one fixture must contain each of speed control, lane change, indicator
state, a pedestrian, and a dynamic traffic control. Unsupported features must
remain visible in capability reporting; fixtures must not be simplified merely
to make the runner green.

## Comparator contract

Comparison is fail closed. It must report at least:

- actor identity mapping and unmatched actors;
- requested and observed duration, sample count, and time alignment method;
- maximum and RMS planar position error;
- maximum heading error using wrapped angles;
- maximum and RMS speed error;
- final pose and presence agreement;
- collision pair/time agreement where both runtimes expose it;
- trigger/action timing where an external observable exists;
- traffic-signal state identity and edge timing (missing signal output fails);
- configured thresholds and whether interpolation was required.

Trajectory replay is accepted only when the external run reaches 20.000 s and
all required actor metrics pass. Editable-action exports use a separate
`semantic-compatibility` verdict and must never inherit a trajectory-parity
badge.

## Studio checks

Playwright must verify from a newly loaded editable scenario that:

1. the OpenSCENARIO tab opens without changing editor state;
2. XML 1.4 and esmini 1.3 are clearly different profiles;
3. the XML/tree, capability findings and dependency status refer to the same
   snapshot;
4. downloads include correct extensions and non-empty content;
5. editing the scenario invalidates prior validation instead of presenting it
   as current;
6. a completed external result exposes synchronized replay and numerical
   metrics;
7. an unsupported dynamic-signal export remains blocked or explicitly marked
   trajectory-baked;
8. refresh/reopen preserves receipts without confusing them with a different
   scenario revision.

## Release rule

The feature may ship when native XML 1.4 validation, an honest esmini 1.3
compatibility bundle, one real 20-second esmini trajectory job, quantitative
comparison, Studio downloads/replay, provenance, cache invalidation and security
negative tests are green. Optional rendered video cannot substitute for any of
these gates.

## Recorded local gate (2026-08-03)

`audit-xml14-suite.ts` ran all 12 curated `examples/edge-cases` instances
against digest-matched production OpenDRIVE/topology pairs and the pinned
official ASAM 1.4.0 XSD: 6 exported and validated, 6 were rejected with typed
fail-closed issues, 0 were asset-blocked, and 0 failed unexpectedly. Each
instance replay-key graph digest matched its production topology. Two blocked
instances lacked authoritative physical signal/controller map bindings, one
requested a hazard-light set action with no equivalent standard XML 1.4 action,
and five contain fixed catalog props whose identity and physical geometry the
current exporter does not emit (two of those overlap the other unsupported
categories). The baseline pins exact warning-code counts for every supported
scenario and exact issue-code counts for every blocked scenario. The blocked
count remains part of the report and is not presented as semantic support.
Missing, invalid, stale, or mismatched production assets are reported separately
as `asset-blocked` and make the hard gate fail.

A real independent smoke also ran the digest-verified official esmini 3.6.0
macOS universal binary at source revision
`131a5651737fd1e8bd5d800d8e77e89bb3178a1e`. It completed a generated
20.000-second trajectory at 0.02-second steps and passed the strict comparator:
position RMSE `0.0000002083 m`, p95 `0.0000004557 m`, max `0.0000004991 m`,
heading p95 `0°`, speed p95 `0.03034 m/s`, and 100% presence agreement. That
one-actor smoke had no signal or collision edges.

The pinned two-actor collision capability fixture has now also executed against
that same verified binary and passed. Its committed receipt is reproduced by
`run-pinned-capability-probe.ts`: canonical contact began at
`1.3196458789 s`, esmini reported `1.3200000000 s`, and the
`0.0003541211 s` error is within one `0.02 s` fixed step. Both actor lanes
agreed for the full trace and the strict comparator passed. The receipt closes
over the binary, OpenDRIVE, parsed input, generated scenario, and normalized
external CSV digests. Traffic-signal identity/state edges and signal-caused
stop-line behavior remain unobservable in esmini 3.6.0's CSV and therefore
fail closed; baked stopping motion is not accepted as evidence of signal
causality. Native OpenSCENARIO 1.4 remains unsupported by this player.
