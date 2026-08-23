# Golden store

```
goldens/<gpuFingerprint>/<scene>.json
```

- `<gpuFingerprint>`: first 16 hex of sha256 over canonical
  `{gpus:[{name,driverVersion,vbiosVersion,pciBusId}], kernel, arch}` from the
  same nvidia-smi query as WSB4's `qualification/render-determinism/gpu-fingerprint.mjs`.
  Current entry: `75b333b1506af34f` = NVIDIA GeForce RTX 5080, driver 595.84,
  vbios 98.03.6C.00.3E, PCI 00000000:02:00.0.
- One file per scene; full evidence manifest (schema
  `uniscenarios.render-determinism-manifest.v1`, extensions in
  `docs/native-golden-ci.md`). Gates read `passHashes` + `timings.avgFrameMs`.

## Keying rules

Goldens are valid ONLY for the exact tuple recorded inside each file:
gpu fingerprint × renderer binary (`rendererPath.sha256`) × render profile ×
scene inputs (`rendererArgs` + `corpusChecksums`). Any element changing ⇒ new
golden required. Known families on this program:
- spike/native-render CLI (AgX tonemapping) — this store.
- WSB5 job-mode (`native-render-job`, Tonemapping::None linear) — separate RGB family.
- WSB3 `sensor-capture` (Tonemapping::None ID cam) — separate instance-hash family.

## Current status (2026-08-22)

| Scene | Pass | Hash (prefix) | Status |
|---|---|---|---|
| yale-frame0 | rgb0 | `e7185b3ae850c644` | **pre-realism-stack** — invalidated when WSB4's rung-2 sensor lighting (IBL + 100k lux + EV100) lands; re-record then |
| yale-frame0 | id0 | `8455e0f311aaa64f` | vacuous until WSB2 re-enables ID clones (tracked source hardcodes `id_clones_done: true`); gate stays armed |
| yale-frame0 | depth0 | `c0b89450f5822499` | valid; lighting-independent by construction |

Expected invariants across lighting/atmosphere changes: depth0 and id0 hold
(geometry/unlit passes); rgb0 drift is expected and handled by per-pass
re-record (superseded versions archived append-only under `previousVersions`).

| yale-pronto | pronto-cam0.rgb `7d9091c1af4a6a1a` · depth `517cf5171b7016d2` · instance `3b8b2be27a00bd7e` · semantic `8455e0f311aaa64f` · lidar-front-left PLY `e9c48979b3331bff` | sensor-capture (Tonemapping::None ID/semantic) — separate artifact family; rgb/depth independently reproduce WSB3's paired-run hashes |

yale-pronto reads WSB1's decoded corpus (`SCEN_SENSOR_CORPUS_WSB1` →
`.corpus/yale-street`, tiles/ subdir auto-detected), the committed
`run/evidence/scene-state.v1.json`, and `fixtures/yale-header.xodr`.
It has no timing instrumentation — frame-time gate is skipped for it.

## Re-record

```sh
cargo build --release -p render-core --bin native-render --manifest-path renderer/Cargo.toml
SCEN_SENSOR_CORPUS=<corpus root> node qualification/golden-harness/golden.mjs record yale-frame0
node qualification/golden-harness/golden.mjs verify all
```
