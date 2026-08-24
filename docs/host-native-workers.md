# Host-Native Render Workers — Operator Guide

Architecture decision (Michael, 2026-08-24): **worker code never ships in
containers.** The only container anywhere is the pinned CARLA engine image
(`ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia@sha256:baed0d03…`),
which is never repackaged. Carla and browser workers run as host processes
(pinned node + uv venv, systemd units); a code deploy is
`git checkout + dep sync + systemctl restart` — no bake, no push, no pull.

Everything lives in `services/render-worker/native/`.

## Identity & approval (provenance never lies)

| | containerized (legacy) | host-native |
|---|---|---|
| `worker_version` | image tag / `native-v1` | **deployed git revision** (engine `options.engineVersion`) |
| digest binding | `labels.imageDigest` (image content digest) | **`labels.codeDigest`** = `sha256:` of `pnpm-lock.yaml` at the revision |
| metadata | base image labels | `deployment: "host-native"`, `sourceRevision` |

The approval row is unchanged mechanics: `approved_worker_version` +
`approved_image_digest` (carries the codeDigest) + `approved_hardware_profile`
+ `approved_at`. **A worker whose checkout or lockfile drifts from the
approved pair fails registration and exits; systemd restarts it until an
operator approves the new revision.** SimCloud side: `registerRenderWorkerV2`
accepts `labels.codeDigest` (commit `83b699565`).

## Per-host bootstrap (one-time)

```sh
scp services/render-worker/native/{bootstrap-host.sh,uniscenarios-native-worker@.service,simcloud-control-adapter.mjs} host:/tmp/
ssh host 'cd /tmp && sudo bash bootstrap-host.sh carla|browser|both [run-user]'
```

Pins node v22.14.0 + uv 0.9.28 into `/opt/simforge/uniscenarios-native/`,
installs ffmpeg/libxml2-utils, seeds the pinned engine image, extracts the
CARLA PythonAPI wheel from it into a python-3.10 uv venv (carla role),
installs playwright-pinned chromium (browser role; path written to
`…/chromium-path`), installs the systemd template unit, and creates the bare
deploy repo.

Then per worker instance:
1. Copy a config template from `native/templates/` to
   `/opt/simforge/uniscenarios-native/config-templates/<name>.json`
   (placeholders `__REV__`, `__REV8__`, `__CODE_DIGEST__` are stamped on every
   deploy — identity always reflects what is actually running).
2. Copy the matching `.env` template to `…/env/<name>.env`, fill the worker
   token (and chromium path for browser lanes). `chmod 600`.
3. Create the `worker_nodes` row + `render_worker_credentials` row (see
   "Approval SQL" below), then `sudo systemctl enable --now
   uniscenarios-native-worker@<name>.service`.
4. Carla hosts: run an engine **server** container per GPU from the pinned
   engine image (this is the only container):
   ```sh
   docker run -d --name uniscenarios-carla-server-native-0 --network host \
     --restart on-failure --gpus '"device=<GPU-UUID>"' \
     -e SDL_VIDEODRIVER=x11 -e NVIDIA_DRIVER_CAPABILITIES=all \
     ghcr.io/simforgeinc/carla-rfs-munich-belmont@sha256:baed0d03… \
     /bin/bash CarlaUnreal.sh -RenderOffScreen -nosound -ResX=320 -ResY=180 \
     -carla-rpc-port=<port matching the worker env CARLA_PORT>
   ```

## Deploy (every code change)

```sh
# 1. approve the revision (workers refuse to run unapproved code):
services/render-worker/native/deploy.sh --print-approval-sql <rev>   # → run via rds-data
# 2. roll the fleet (parallel per host):
services/render-worker/native/deploy.sh <rev> simforge1 rtx3080-01 rtx3080-02 rtx3080-03 rtx3080-04
```

Per host this pushes `<rev>` to the host's bare repo over ssh, checks it out,
runs `pnpm install --frozen-lockfile` (host-warm store) + package builds +
`pnpm deploy`, `uv pip install ./adapters/carla-bridge` (carla), re-stamps the
configs with `__REV__`/`__CODE_DIGEST__`, refreshes the control adapter, and
restarts the enabled `uniscenarios-native-worker@*` units. Prints per-host and
total wall time.

## Staged validation lane (validate on ONE live worker first)

Config key `validationLane` (see `native/templates/*.json`) fences a worker
off from production claims **using the control plane's existing compatibility
checks — no server changes**:

- `fenceCapability` is added to the declared engine capabilities. Probe specs
  put it in `capabilityIntent.required`; no production fleet worker declares
  it, so the fleet can never claim a staged probe.
  - carla lane fence: `artifact.frames` (active carla fleet doesn't declare it)
  - browser lane fence: `control.native` (browser fleet doesn't declare it)
- `maxWidth`/`maxHeight` (≤320×240) clamp the declared limits, so every
  production render is dimension-incompatible with the staged worker — it can
  never steal a fleet job.
- `workerId`/`instanceId` MUST end in `-staged` (enforced at config parse), so
  worker_nodes / render_attempts provenance is always distinguishable.
- `engineVersion` records the staged revision as `worker_version`.

Probe flow:
```sh
node services/render-worker/staged/make-probe-spec.mjs <known-good-spec.json> artifact.frames > probe.json
jq -n --slurpfile spec probe.json --arg key "staged-probe-$(date +%s)" \
  '{schema:"uniscenario.render-intent-submission/v1",engine:"carla",
    revisionId:"<rev id>",executionPackageId:"<pkg id>",
    renderSpec:$spec[0],idempotencyKey:$key,priority:-50}' \
| curl -s -b <cookies> -H 'content-type: application/json' -H 'Origin: https://dev.simforge.ai' \
    -d @- https://dev.simforge.ai/api/uniscenario/render-jobs
```
Verify the succeeded attempt's `worker_node_id` ends in `-staged`, then
approve + roll the fleet with the same revision.

## Operator flow summary

```
edit code → deploy.sh <rev> <pilot-host>       (staged lane, fenced)
          → submit 3s probe → succeeded on -staged worker
          → deploy.sh --print-approval-sql <rev> → approve fleet rows
          → deploy.sh <rev> <all hosts>          (~1 min, parallel)
```

## Appendix: optional container packaging (burst/cloud only)

`services/render-worker/docker/` retains a layer-split container path for
burst/cloud capacity: pinned worker-base images
(`base.carla.Dockerfile`, `base.browser.Dockerfile` — engine + OS deps +
node, no repo code) and thin code-layer worker Dockerfiles with
deps-before-code ordering and BuildKit cache mounts (`bake` group `bases`,
then `default`). Bake FROM a fleet-proven revision only (packaging-last).
Deprioritized: base digests in `docker-bake.hcl` are placeholders until a
base bake pins them. The staged-code override kit for baked images lives in
`services/render-worker/staged/`.

## Measured timings (2026-08-24, real trivial bridge change, real infrastructure)

| Cycle | Container era (baseline) | Host-native (measured) |
|---|---|---|
| (a) code-change → running+registered on pilot | 30–40 min (bake+push+pull+roll) | **40 s** |
| (b) code-change → validated by real probe render | 35–50 min | **9 m 07 s** (deploy 40 s + probe render; attempt 1 hit the known sensor-backpressure flake, retry succeeded — clean attempt was 2 m 51 s) |
| (c) fleet-wide code roll (5 hosts, commit → all registered) | 90–180+ min (ghcr pull tax per host) | **2 m 29 s** |

Evidence: pilot row `uniscenario-carla-simforge1-native-0-staged`; probe jobs
usrj_1845187fa300494b9453b5e7 (shakedown, succeeded) and
usrj_5040b2a01f874c29b29ca8d5 (timed, succeeded, attempt runtime_version =
the just-committed revision; renderer stderr carried the deploy marker).
