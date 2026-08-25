# Browser renderer gate spike

This directory is a **non-product feasibility gate** for evaluating a Rust/WASM/WebGPU renderer in browsers. It is not a supported SimForge renderer, is not shipped, and is deliberately isolated from product builds:

- `renderer/Cargo.toml` lists only `render-core`, `sensors`, and `service` as workspace members.
- This crate declares its own standalone workspace and `publish = false`.
- Generated `target/` and `www/pkg/` outputs are ignored and must not be checked in.
- The harness uses measurement-only behavior, including a tick-coded color swatch for exact-frame `VideoFrame` capture checks.

## Scope

The spike loads three prepared BC7/KTX2 glTF map tiles and one animated glTF actor, uploads textures to WebGPU, renders an orbiting camera, performs GPU ID-buffer picking, and exposes an asynchronous wasm-bindgen API:

- `spikeInit(canvas)`
- `loadTiles(urls)`
- `spawnActor(url, x?, y?, z?, scale?)`
- `setCamera(pose)`
- `renderAt(tick)`
- `pick(x, y)`

`renderAt(tick)` resolves only after submitted GPU work completes. The page harness checks whether `new VideoFrame(canvas)` immediately captures the requested tick.

## Build and run

Prerequisites are the Rust `wasm32-unknown-unknown` target, `wasm-bindgen-cli` 0.2.127, Node.js, a WebGPU-capable browser, and externally prepared assets. Assets remain outside the repository.

```sh
./build.sh
ASSET_DIR=/path/to/prepared-assets PORT=8787 node serve.mjs
```

Open the printed local URL. The harness writes measurements to `window.__results` and exposes `runOrbit`, `runPick`, and `runVideoFrame` for browser automation.

The feasibility thresholds are TTFF below 5 seconds, steady small-scene frame-time p50 below 16 ms, measured browser memory below 1.5 GB, and a mandatory pass for exact-frame `VideoFrame` capture. Gate results belong in the lane report, not in product documentation.
