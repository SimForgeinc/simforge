# ORM material path for map tiles

Status: shipped (lane/orm, 2026-08-24). Owner: asset pipeline.

## Contract

Map-tile materials carry PBR response as one packed ORM texture per surface,
wired per glTF 2.0 core:

- **R = ambient occlusion** → `material.occlusionTexture`
- **G = roughness**, **B = metallic** → `pbrMetallicRoughness.metallicRoughnessTexture`
- Both slots reference the **same texture**; `metallicFactor`/`roughnessFactor`
  are 1 when the texture is wired (factors multiply texels).
- ORM images are non-color data: KTX2 encodes must stay linear (the pinned
  `gltf-transform uastc` already assigns per-slot transfer functions).

This is byte-compatible with RoadRunner `*_AORM` maps and Poly Haven `*_arm_*`
maps. Bevy `StandardMaterial` and three.js `MeshStandardMaterial` consume it
natively — no engine work needed.

## Why a repair stage exists

The UE 5.5 glTF export that produces our tiles drops every `*_AORM` map
(roughness frozen at 0.5, no occlusion) and sometimes mis-slots spec/gloss
maps into `baseColorTexture` (Easterbrook `tiles_road.glb`: `Curb_Saratoga`,
`sidewalk_material`). RoadRunner project sources are vendor-held, so the loss
is repaired post-export: **`tools/glb-orm-repair`** (see its README) rewires
named materials from sidecar textures while keeping the authored BIN chunk a
byte-verbatim prefix of the output — meshopt/quantization identity is
untouched by construction, and every run re-verifies before writing.

## Where the pipeline already preserves ORM

- **city-preprocess → tiles**: photogrammetry materials in
  `fixtures/yale-tile_0_0.lod3.glb` carry `metallicRoughnessTexture` (and one
  `occlusionTexture`) through tiling, WebP re-encode, quantization, and
  meshopt — the tile pipeline is ORM-transparent when the input has it.
- **corpus build** (`simforge corpus build`, WSB1): decodes meshopt,
  dequantizes, converts WebP→PNG; texture slots pass through untouched.
  Contract test: `packages/cli/src/__tests__/corpus-orm.test.ts`.
- **geometry-only / roads-only derivatives**: rebuild or strip materials by
  design; ORM-carrying inputs are handled (materials are reconstructed from
  scratch, so no dangling texture references).
- **KTX2 optimization pass** (platform `tools/map-optimize`): `gltf-transform`
  preserves material slots; its structural identity gate intentionally
  excludes materials/textures. Note the known WebP limitation — authored WebP
  payloads are skipped by the UASTC command (KTX2-lane ownership); PNG ORM
  sidecars compress fine.

## Runtime notes

- Bevy render-core: full ORM response out of the box (verified before/after on
  Easterbrook road, 2026-08-24; see lane report `tmp/lanes/sf-orm.md`).
- Web viewer: `tile-manager.ts` currently clamps streamed tile materials to
  `envMapIntensity = 0`, `roughness ≥ 0.9` — repaired ORM data survives to the
  renderer but its specular response is deliberately suppressed there.
  Removing/conditioning that clamp is ranked item 3 in
  `nextdir/asset-gap-analysis.md` §6 and is not part of this lane.

## Licensing

Sidecar textures for repairs must be CC0 (Poly Haven / ambientCG; staged under
`~/simforge-assets/map-bundles/cc0-textures/`). RoadRunner Asset Library
textures must not be wired into new payloads pending legal review.
