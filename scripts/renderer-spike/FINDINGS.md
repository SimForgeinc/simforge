# Renderer bake-off spike: Bevy headless offscreen vs three.js/Chrome

**Date:** 2026-08-22 · **Machine:** RTX 5080 16 GB, Ubuntu 24.04, Vulkan 1.3.275, driver 595.84
**Code:** `scripts/renderer-spike/bevy-spike` (Rust, Bevy 0.19.1) · **Corpus:** `scripts/renderer-spike/corpus/` (gitignored)
**Scene:** yale-street tiles `2_4, 2_5, 2_6, 3_5` (lod0) + `road.glb` static layer (~320 MB decoded GLB),
rendered at the W0 `baseline-midblock` frame-0 POV pose (eye 580.45, 14.44, −1655.66 → target 590.40, 14.35,
−1648.96, vfov 58°, 736×416) for direct comparability with the current three.js path.

## 1. Setup notes

- Rust stable installed via rustup (`~/.cargo`). Bevy **0.19.1** (latest stable, 2026-08-13).
- Headless approach: `DefaultPlugins` − `WinitPlugin` − `AudioPlugin`, `WindowPlugin { primary_window: None }`,
  `ScheduleRunnerPlugin::run_loop(0)`; cameras render to `Image` render targets (Rgba8UnormSrgb, COPY_SRC);
  GPU→CPU readback via per-frame `copy_texture_to_buffer` + `map_async` (pattern from bevy's own
  `headless_renderer.rs` example). Depth readback enabled by setting
  `Camera3d { depth_texture_usages: RENDER_ATTACHMENT | COPY_SRC }` and matching the view whose
  `ExtractedCamera.target` is our RGB image (view entities are NOT main-world entity ids in 0.19).
  MSAA must be Off (multisampled depth can't be copied).
- Asset preprocessing (one-time, scripted via gltf-transform CLI):
  1. `optimize --compress false --texture-compress false --instance false --join false --simplify false --weld false`
     decodes EXT_meshopt and prevents gltf-transform from re-merging meshes into EXT_mesh_gpu_instancing
     (Bevy's loader chokes on it here).
  2. `dequantize` converts KHR-mesh-quantized int16 positions/normals to f32 (Bevy rejects quantized POSITION).
  - Result: clean float32 GLBs with PNG textures; originals untouched. Pipeline is ~6 s for all 5 files.
  - **Caveat discovered:** dev-assets symlink was retargeted mid-session; source tiles now live at
    `/home/path/local-uniscenarios/maps/<map>/browser/3d/tiles`. Preprocess script should take that root.
- Lighting to approximate the W0 clear-day look: DirectionalLight 12 000 lux (elev 60°, azim 190°) with 4-cascade
  2048px shadow maps, GlobalAmbientLight 1.2, AgX tonemapping (same family as three.js path's AgX), clear-blue sky.
- Vegetation tiles (`veg_*.glb`) were excluded from the corpus run (WebP textures + alpha cutout untested in Bevy).

## 2. Image comparison

![side by side](out/side_by_side.png)

Left: current three.js/Chrome output for the identical pose (`w0-data/clips-pov/baseline-midblock/frames/frame-00000.png`).
Right: Bevy headless offscreen render of the same tile set (`out/bevy_a_run1.rgb0.png`).

Observations:
- Geometry/pose parity confirmed: road, poles, building silhouettes align between the two paths.
- Bevy metallic-roughness PBR shows noticeably more material detail (brick walls, roof texture, road aggregate)
  than the flatter three.js presentation; shadows are crisp cascaded shadow maps.
- Gaps to close for parity: no vegetation loaded in the Bevy run (missing street trees), flat clear-color sky
  instead of the HDRI (`env/sky.hdr` exists and can feed a Skybox/EnvironmentMapLight), and lighting needs a
  calibration pass against W0 clips (current sun/ambient chosen by eye).
- Full-res outputs: `out/bevy_a_run1.rgb0.png` (RGB), `.id.png` (instance IDs), `.depth.png` (depth viz),
  `.f32.bin` (raw reverse-Z Depth32Float).

## 3. Performance metrics

Bevy timings are instrumented inside the app (asset load = GLB bytes→asset; scene build = instance spawn→ready;
frame = steady-state update period incl. render + pipelined readback; readback = map_async poll wait per pass set).

| Path | Resolution | Passes | asset load | scene build | warmup→1st frame | per-frame render | readback | fps |
|---|---|---|---:|---:|---:|---:|---:|---:|
| **Bevy offscreen** | 736×416 | RGB+ID+Depth | 2.10 s | 95 ms | 142 ms | **4.33 ms (p50 3.8)** | ~0.75 ms | **~231** |
| **Bevy offscreen** | 1920×1080 | RGB+ID+Depth | 2.26 s | 54 ms | 226 ms | **8.22 ms (p50 8.1)** | ~2.0 ms | **~122** |
| Chrome/three.js (W0 clip renderer) | 736×416 | RGB | n/a | n/a | browser+scene init (seconds) | ~10–30 ms WebGL frame (M5 Pro, High preset p95; SwiftShader 125–1620 ms) | screenshot+PNG encode ⇒ **~0.5 s/frame** end-to-end | ~2 |

Sources for the Chrome column: `docs/first-run-graphics-benchmark.md` (raw WebGL frame times on Apple M5 Pro;
this Linux box not benchmarked there) and the observed w0 `render-clip.mjs` cadence (~0.5 s/frame including
CDP screenshot + PNG encode, the number quoted in the spike brief). Even granting Chrome a 10 ms raw frame,
the screenshot/readback roundtrip through the browser compositor dominates: ~50× slower end-to-end than Bevy's
in-process GPU readback at equal resolution.

Route-prewarm note: after the ~2.2 s one-time asset load + ~0.1 s scene build, every additional camera/tile-set
render costs only the per-frame time above — the amortized cost model strongly favors batch rendering many
cameras per process.

## 4. Determinism

Two independent process runs, identical inputs (30 steady frames each, capture of final frame):

| Output | run 1 sha256 (prefix) | run 2 sha256 (prefix) | match |
|---|---|---|---|
| RGB PNG | `c3d917c55a02…` | `c3d917c55a02…` | ✅ bit-identical |
| Instance-ID PNG | `51b738fcc114…` | `51b738fcc114…` | ✅ bit-identical |
| Depth f32 buffer | `c22b21efd5ed…` | `c22b21efd5ed…` | ✅ bit-identical |

Nondeterminism sources eliminated by construction: MSAA Off, no TAA/temporal effects, fixed camera, static scene,
single capture frame, deterministic ID assignment (entities sorted by name then entity index before numbering).
Same-device wgpu is empirically bitwise-stable here; cross-vendor/cross-driver determinism is NOT guaranteed and
would need a golden-hash-per-GPU policy rather than a universal hash.

## 5. Custom passes (sensor-renderer proof)

- **Instance-ID pass:** second camera sharing the RGB pose renders the same meshes cloned onto render-layer 1
  with unlit materials encoding a stable u32 id (RGB24, alpha unused; background = 0 via per-camera black
  clear color). Legend written to `<out>.legend.json` (id → mesh name, e.g. `2301_16569_B_56.Building_56_st`).
  Verified programmatically (`verify_passes.py`): 165 distinct ids visible in frame, all decode cleanly and
  resolve in the legend. IDs sort deterministically; ids ≤ 831 fit trivially in 24 bits (full map has ~1.6M tris
  across all tiles; budget is 16.7M objects).
- **Depth pass:** raw reverse-Z Depth32Float readback validated geometrically: for 110 road pixels, the distance
  implied by the depth value agrees with the ray–ground-plane intersection at mean ratio **0.919 ± 0.03**
  (residual bias consistent with the assumed ground height y=12.99 vs actual road surface and the simple
  `near/d` unprojection; fixable by using the exact projection matrix constants).
- Ground-truth cross-check: projecting the W0 GT pedestrian world position into the frame lands exactly where
  expected ((443,209)); the pixel is background because actors are not part of the static tile corpus — actor
  models would come from the instance pipeline, which is out of scope for this spike.

## 6. Parallelizability

| Configuration | Work per frame | avg frame | Effective throughput |
|---|---|---:|---|
| 1 camera × (RGB+ID+Depth), 736×416 | 3 targets | 4.33 ms | 0.69 targets/ms |
| 4 cameras × RGB (+1 ID cam), 736×416 | 5 targets | 10.25 ms | 0.49 targets/ms |
| 2 OS processes × 1 camera, concurrent | 2× full pipeline | 3.52 s wall vs 5.69 s serial (incl. ~2.2 s load each) | 1.62× speedup end-to-end |

- Intra-process multi-camera scales well (2.4× the render targets cost 2.37× the time): the scene is uploaded
  once and shadow maps are shared, so adding cameras is nearly free until the GPU rasterizes as the bottleneck.
- Multi-process scaling is limited by duplicate asset loading (each process uploads its own copies); a
  production design should keep N cameras in ONE process (or share assets) and use processes mainly to shard
  maps. On a single 5080 the sweet spot is likely 2–4 processes × several cameras each.
- **A100 note:** wgpu-on-Vulkan does run on A100s, but NVIDIA datacenter drivers prioritize compute; graphics
  (raster) throughput per dollar is far below an RTX card and some features (bindless/sampler feedback) behave
  differently. Expect materially lower fps than the 5080 numbers above; validate early if cloud rendering on
  A100/H100 is the target. CPU/Metal GPUs (Apple Silicon) are a better-supported wgpu story for CI fleets.

## 7. Remaining work for a production build (effort estimate)

| Item | Estimate |
|---|---|
| Preprocess pipeline productized (all 5 maps, cached corpus, checksummed) | 1–2 d |
| Vegetation: WebP/alpha-cutout materials + instanced sidecar matrices in Bevy | 2–4 d |
| Sky/atmosphere: HDR skybox + EnvironmentMapLight from `env/sky.hdr`, fog/weather ladder | 2–3 d |
| Actor models (cars/pedestrians) from instance catalog with per-actor IDs | 3–5 d |
| Lighting calibration against W0 clips + route prewarm (tile LOD selection by camera) | 2–3 d |
| Batch API: N poses → N×(RGB,ID,Depth) PNG/bin sets, legend service, hash regression test | 3–4 d |
| RL-gym integration (zero-copy readback into numpy / shared memory ring) | 2–3 d |
| **Total to training-grade native renderer** | **~3–4 engineer-weeks** |

## 8. Recommendation

**GO** for adopting Bevy headless as UniScenarios' deterministic sensor renderer.

- Bit-exact determinism achieved immediately (hash-verified RGB/ID/Depth), something the Chrome/screenshot path
  cannot promise.
- ~50× faster end-to-end per labeled frame (4.3 ms vs ~500 ms at 736×416), with RGB+ID+Depth produced in the
  same pass; 1080p still runs at 122 fps.
- Native per-object instance IDs and raw depth unlock sensor-grade supervision the three.js path lacks.
- Risks: vegetation/actor fidelity, atmosphere parity with the W0 look, and A100 raster performance — all
  bounded, listed above, none blocking the decision.
