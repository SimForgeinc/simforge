# `@simforge-oss/openscenario/esmini`

Pinned external execution boundary for esmini 3.6.0. It consumes only the typed
`EsminiExecutionJob` produced by the compatibility bundle builder and returns a
browser-safe `ExternalRunResult` containing execution status, immutable cache
identity, structured logs, and opaque artifact handles.

Production jobs must use the Docker invocation profile: no network, read-only
root and inputs, an unprivileged user, no Linux capabilities, bounded CPU,
memory, processes, runtime, and output. `LocalProcessExecutor` is explicitly a
developer convenience and reports `developer-local` isolation; it must not be
used as production evidence.

The numerical CSV/DAT/OSI outputs and collision log are authoritative external
evidence. Frames and video are optional, non-authoritative human evidence.

Install the official pinned binary locally with:

```sh
node packages/openscenario/scripts/fetch-pinned-esmini.mjs
```

The helper verifies the upstream archive SHA-256 before extraction. `.tools/`
must remain untracked. See [NOTICE.md](./NOTICE.md) for licensing.

For a real local interoperability smoke (not a mocked executor), run
`scripts/run-pinned-trajectory-smoke.ts` with that binary and the
`straight_500m.xodr` fixture from the exact pinned esmini source revision. The
script verifies the binary digest, executes a SimForge-generated 20-second
trajectory at 0.02 s, strictly parses the external CSV, and applies the normal
trace-comparison release thresholds. Binaries, source clones, maps, and run
outputs stay outside version control.

`scripts/run-pinned-capability-probe.ts` extends that real-engine check to two
actors and requires the collision onset reported through esmini 3.6.0's
`collision_ids` CSV field to agree with the canonical trace within one 0.02 s
step. It also makes the traffic-signal boundary executable: the pinned wide
CSV has no signal identity/state channel, while the compatibility export
promises motion-only replay for signal programs. Signal-edge timing and
signal-caused stop-line behavior therefore remain fail-closed; a stopped baked
trajectory is not accepted as proof of traffic-signal execution. Native OSC
1.4 execution remains unsupported by this pinned player.
