# glb-ktx2-repack

Image-only WebP → KTX2 repacker for production GLB tiles (asset-gap-analysis
item 5 / L5). Unblocks native Bevy decode of the tiles and cuts texture VRAM
4× — **without touching geometry**: every mesh/accessor byte range, including
`EXT_meshopt_compression` streams and KHR-quantized attributes, is
byte-identical after repacking, and the tool proves it before writing output.

Map-wide KTX2 was previously blocked because glTF-Transform 4.3's UASTC
command skips WebP inputs *and* decodes/re-encodes meshopt, breaking geometry
identity (docs/product/runtime-surface-materials.md). This tool avoids
glTF-Transform entirely for the repack: it parses the GLB container itself,
re-encodes only the image payloads, rebuilds the BIN chunk from byte slices,
and rewrites only `images[*]`, `textures[*]`, and `extensionsUsed/Required`.
Samplers and every geometry-bearing JSON node are untouched.

## Usage

```sh
# repack (writes out.glb only after geometry identity is proven)
node tools/glb-ktx2-repack/bin/glb-ktx2-repack.mjs repack in.glb out.glb \
  [--ktx-bin <dir>] [--color-codec uastc|etc1s] [--no-core-source] [--report r.json]

# re-prove geometry identity between any source/output pair
node tools/glb-ktx2-repack/bin/glb-ktx2-repack.mjs verify in.glb out.glb

# prepare a repacked tile for Bevy render-core (meshopt decode + dequantize +
# KHR_texture_basisu -> texture.source flatten; sensor-corpus decode minus WebP->PNG)
node tools/glb-ktx2-repack/scripts/bevy-decode.mjs out.ktx2.glb out.bevy.glb

# focused tests: geometry-identity assertion + KTX2 decode smoke on the real
# production fixture fixtures/yale-tile_0_0.lod3.glb
pnpm --filter @simforge/glb-ktx2-repack test
```

## Codec choices (and why ETC1S is NOT the default for baseColor)

| Class | Slots | Codec | Transfer | Rationale |
|---|---|---|---|---|
| `color` | baseColor, emissive | **UASTC + RDO λ=1 + zstd-18** | sRGB | see below |
| `normal` | normalTexture | UASTC + zstd-18, **no RDO** | linear | RDO causes directional artifacts on normals (pinned-toolchain doc); ETC1S endpoint sharing bends normals |
| `data` | occlusion, metallicRoughness, other `*Texture` | UASTC + RDO λ=1 + zstd-18 | linear | ETC1S cross-contaminates independent packed channels |

ETC1S would be acceptable *quality-wise* for albedo, but **bevy_image 0.19.1
cannot decode it**: BasisLZ supercompression is rejected outright
(`Unsupported supercompression scheme`, src/ktx2.rs), and its `Etc1s` arm is a
no-transcode ETC2 passthrough desktop GPUs can't sample. Since native Bevy
decode is the point of this tool, the default is UASTC everywhere (transcodes
to BC7 via Bevy's `basis-universal` feature, enabled in render-core by this
lane). `--color-codec etc1s` remains for web-only derivatives — Three's
KTX2Loader transcodes BasisLZ fine and it cuts the color payload ~4×
(tiles_road: 16.6 MB → with etc1s colors vs 27.9 MB all-UASTC).

An image referenced by both a color and a non-color slot is encoded as the
non-color (linear UASTC) variant.

## Reference rewrite

- `images[*].mimeType` → `image/ktx2`; payload replaced in place.
- `textures[*].extensions.KHR_texture_basisu.source` set (spec route, Three);
  `EXT_texture_webp`/`EXT_texture_avif` dropped.
- `textures[*].source` also points at the KTX2 image by default. Core-spec
  non-compliant (exactly like the source tiles' bare `image/webp` sources),
  but required by Bevy, which ignores the basisu syntax and reads only
  `texture.source` (bevyengine/bevy#19104). `--no-core-source` emits strictly
  spec-compliant output instead.
- `KHR_texture_basisu` added to `extensionsUsed` + `extensionsRequired`.

## Geometry-identity guarantee

The BIN chunk is rebuilt by walking every byte-carrying range (plain
bufferView ranges + `EXT_meshopt_compression` streams) in original offset
order; non-image ranges are copied verbatim at 4-byte alignment. Before any
output is written, `verifyGeometryIdentity` re-parses the result and checks,
against the source: sha256 of every non-image byte range, byte-equality of
`accessors` and `meshes` JSON, and equality of every geometry bufferView
definition modulo `byteOffset`. `repack` throws on any mismatch; `verify`
re-runs the same proof on demand.

## Toolchain

KTX-Software **4.4.2** (Apache-2.0), official Khronos release only, unpacked
without a system install (no large assets in git):

```sh
mkdir -p ~/simforge-assets/tools && cd ~/simforge-assets/tools
curl -sSLO https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Linux-x86_64.tar.bz2
# sha256: a8781bad05f9624edbf910b7f258cd0a4ba7d3e63b49ecc0a0ab440bf6a0a245
tar xjf KTX-Software-4.4.2-Linux-x86_64.tar.bz2
```

Archive/executable/library SHA-256 pins live in
`config/map-derivative-toolchain.json` (`platforms.linux-x86_64`). Resolution
order: `--ktx-bin` → `SIMFORGE_KTX_BIN_DIR` →
`~/simforge-assets/tools/KTX-Software-4.4.2-Linux-x86_64/bin`. `TOKTX_OPTIONS`
is cleared for every invocation. WebP decode uses the workspace-pinned
`sharp` 0.34.5 (same as the sensor-corpus builder).

## Measured results (2026-08-24, RTX 5080 machine)

Production tiles from `~/tmp/glb-easterbrook` + `fixtures/yale-tile_0_0.lod3.glb`,
default all-UASTC profile. VRAM: WebP must be CPU-decoded and uploaded as
RGBA8 (4 B/px × 4/3 mips); UASTC transcodes to BC7 (1 B/px × 4/3) — **4.0×**.

| File | Images | File before → after | Texture payload | VRAM RGBA8 → BC7 |
|---|---|---|---|---|
| tiles_road.glb | 57 | 7.56 → 30.19 MB | 5.31 → 27.94 MB | 309 → 77 MB |
| tiles_tile_0_1.lod0.glb | 83 | 8.37 → 43.31 MB | 5.06 → 39.99 MB | 515 → 129 MB |
| tiles_tile_1_0.lod0.glb | 54 | 6.68 → 33.69 MB | 5.18 → 32.19 MB | 352 → 88 MB |
| tiles_tile_1_1.lod0.glb | 65 | 9.26 → 38.49 MB | 3.75 → 32.96 MB | 414 → 104 MB |
| yale-tile_0_0.lod3.glb | 50 | 1.68 → 3.63 MB | 0.29 → 2.23 MB | 17 → 4 MB |
| **total** | 309 | 33.6 → 149.3 MB | 19.6 → 135.3 MB | **1607 → 402 MB** |

File size grows ~4× (WebP is a far stronger *transfer* codec than UASTC+zstd);
the wins are GPU-native decode (no CPU WebP decode + RGBA8 upload), 4× VRAM,
and native Bevy ingestion without the corpus WebP→PNG detour (55.6 MB
PNG-decoded corpus road.glb vs 30.2 MB repacked). For transfer-sensitive
web-only derivatives use `--color-codec etc1s`. Geometry ranges verified
identical on all five files (137/29/19/25/72 ranges).

Every extracted payload passes official `ktx2check`; `ktxinfo` confirms
UASTC (`VK_FORMAT_UNDEFINED`), `KTX_SS_ZSTD`, full mip chains, sRGB transfer
on color and linear on normal/data.

## Consumers

- **Bevy render-core**: `scripts/bevy-decode.mjs` (geometry decode only, no
  image work), then `native-render` — requires the `basis-universal` bevy
  feature (renderer/render-core/Cargo.toml).
- **Three viewer**: repacked GLBs load through GLTFLoader + KTX2Loader +
  MeshoptDecoder unchanged (same wiring as the deploy-build city-viewer
  streaming tile-loader). `scripts/three-verify/index.html` is a minimal
  harness reproducing that path.
