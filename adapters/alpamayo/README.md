# @simforge/alpamayo-runtime

Locally runnable, quantized **Alpamayo 1.5 (10B reasoning VLA)** inference
service for closed-loop evaluation on a single RTX 5080 (16 GB). Exposes
`act(observation) -> trajectory + chain-of-causation reasoning` over a
unix-socket, length-prefixed MessagePack wire (same framing as the simforge
env-server).

All revisions are pinned in [`manifest.json`](./manifest.json). No weights or
caches live in the repo: HF caches go to `~/simforge-assets/hf-cache`
(`HF_HOME`), quantized artifacts (if serialized) to `~/simforge-assets/models`.

## Quantization recipe

The model is quantized **at load time** from the pinned BF16 checkpoint —
reproducible from the recipe alone, no serialized artifact required:

| Mode | Tooling | What is quantized | Kept BF16 |
| --- | --- | --- | --- |
| `nf4` (default) | bitsandbytes 4-bit NF4, double-quant, bf16 compute | every `nn.Linear` in the Cosmos-Reason2-8B VLM **and** the 2.3B action expert | vision tower, `embed_tokens`, `lm_head`, action in/out projections, diffusion head |
| `fp8` | torchao `Float8WeightOnlyConfig` (e4m3) | same set | same set |
| `bf16` | none | — | everything (does **not** fit in 16 GB; debug only) |

AWQ was evaluated and rejected: autoawq has no support for the custom
`alpamayo1_5` architecture (Qwen3-VL backbone + fused diffusion expert +
non-HF generation path), and would need a calibration set from the gated
driving dataset. NF4 needs no calibration and keeps the whole model
GPU-resident. **No CPU offload anywhere.**

Why the config/tokenizer pin matters: the checkpoint (`nvidia/Alpamayo-1.5-10B`,
ungated, OpenMDW-1.1) references gated-auto `nvidia/Cosmos-Reason2-8B` for its
Qwen3-VL config + tokenizer. The engine pins both and verifies at load that the
tokenizer reproduces the exact trajectory-token ids baked into the checkpoint
(`traj_token_start_idx=151669`, vocab `155697`).

## Setup

```bash
hf auth login            # any HF account (Cosmos-Reason2-8B is gated: auto)
scripts/setup.sh         # vendor pinned inference code, venv, prefetch ~22 GB
```

## Run

```bash
# start server (INT4/NF4), warm it up with a 2-cam synthetic act
scripts/run_server.sh --quant nf4 --socket /tmp/simforge-alpamayo.sock --warmup-cams 2

# smoke test from another shell
PYTHONPATH=src vendor/alpamayo1.5/.venv/bin/python -m simforge_alpamayo.client \
    --socket /tmp/simforge-alpamayo.sock --cams 2 --seed 42
```

Server prints `READY <socket>` on stdout once listening.

### Wire protocol

`[uint32 LE length][msgpack]` frames (matches packages/training-env env-server.ts). Ops: `hello`, `health`,
`warmup {cams}`, `act {obs, seed, params}`, `reset`, `close`, `shutdown`.

`act` request:

```jsonc
{
  "op": "act",
  "seed": 42,                       // deterministic: seeds VLM sampling + diffusion noise
  "obs": {
    "cameras": [{
      "camera_id": 1,               // 0..6, upstream camera convention
      "frames": ["<bytes>", ...],   // 4 frames, oldest->newest (t0 last)
      "encoding": "raw",            // raw RGB HxWx3 uint8 | jpeg | png
      "width": 512, "height": 384
    }],
    "ego_history_xyz": [[x,y,z], ...],  // 16 steps @10 Hz, ego frame at t0
    "ego_history_rot": [[[...3x3...]], ...],  // optional, default identity
    "nav_text": null                // optional navigation instruction
  },
  "params": {"top_p": 0.98, "temperature": 0.6, "num_traj_samples": 1,
             "max_generation_length": 256, "num_diffusion_steps": null}
}
```

`act` response: `result.trajectories` = `num_traj_samples x 64 x [x,y,z]`
waypoints (6.4 s @ 10 Hz, ego frame at t0), `result.reasoning` =
chain-of-causation text per sample, plus timings and VRAM stats.

Closed-loop integration note: frames arriving from the Bevy shm ring
(sim_tick, camera_id, digest headers) map 1:1 onto `cameras[].frames` as
`encoding: "raw"`; the `policy_step` bridge only needs to accumulate 4 ticks
per camera and forward the ego history.

## Camera-rig bridge (frame bundles -> observations)

`src/simforge_alpamayo/bridge.py` (torch-free; numpy only, PIL only when
resizing) converts `render_bundle` shm frame bundles into wire observations:

- `BundleObservationBridge.for_profile("alpamayo-2cam" | "alpamayo-4cam")`
  mirrors the authored sensor-rig presets in
  `packages/scenario/src/schema/v2/sensor-rigs.ts` — preset sensor ids ARE
  the dataset camera names, mapped to upstream indices via
  `ALPAMAYO_CAMERA_INDEX` (2-cam = [1, 6], 4-cam = [0, 1, 2, 6]).
- `push_bundle(bundle)` ingests one tick zero-copy up to the single
  unavoidable RGBA->RGB pack (~0.6 ms/cam/frame at 512x384, measured in
  `last_convert_s`); `observation(ego_history_xyz)` assembles the rolling
  4-frame window (cold start replicates the oldest frame) with cameras
  emitted camera-index ascending.
- Ego history helpers produce the FLU ego frame at t0 frozen with the
  trajectory executor (x forward, y left, z up, newest == origin).

End-to-end conformance (render -> bundle -> bridge -> act -> trajectory) on
a real map tile: `scripts/rig_conformance.py` (both servers must already be
running). Unit tests: `python3 -m pytest adapters/alpamayo/tests/test_bridge.py`
from the repo root, against the recorded ring in `renderer/service/testdata`.

## Benchmarks / quality

```bash
# latency p50/p95 at 2-cam and 7-cam profiles + VRAM (server must be running)
vendor/alpamayo1.5/.venv/bin/python scripts/bench_latency.py --iters 12 --out out/bench_nf4.json

# INT4-vs-FP8 divergence on 10 identical synthetic inputs (loads one engine at
# a time), optionally + golden-clip open-loop minADE vs dataset ground truth
vendor/alpamayo1.5/.venv/bin/python scripts/compare_quant.py --modes nf4 fp8 --n 10 --out out/divergence.json
vendor/alpamayo1.5/.venv/bin/python scripts/compare_quant.py --modes nf4 --clip --n 0 --out out/openloop_nf4.json
```

Measured results live in the lane report
(`/home/path/tmp/lanes/alpamayo.md`).

## Licenses

Inference code (vendored): Apache-2.0. Model weights: OpenMDW-1.1.
This adapter: simforge-internal.
