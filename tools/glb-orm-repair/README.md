# glb-orm-repair

Wire packed ORM textures into an existing GLB and fix spec/gloss-as-baseColor
mis-wiring, without touching any authored byte.

## Why this exists

Our map tiles are UE 5.5 glTF exports of RoadRunner scenes. That export drops
the RoadRunner `*_AORM` maps entirely — no road or terrain material carries a
`metallicRoughnessTexture` or `occlusionTexture`, and roughness is frozen at a
constant 0.5 — and on some maps it mis-slots specular/glossiness maps into
`baseColorTexture` (Easterbrook `tiles_road.glb`: `Curb_Saratoga` renders the
`Asphalt3_Spec` map as its color; `sidewalk_material` renders a near-empty
glossiness map). We cannot re-export (no RoadRunner project sources exist on
our infrastructure — see `nextdir/asset-gap-analysis.md` §2), so the fix is a
post-export repair: this tool takes the GLB plus sidecar ORM textures and
rewires the named materials.

## ORM channel convention

One packed image, per glTF 2.0 core:

| Channel | Content           | glTF slot |
|---------|-------------------|-----------|
| R       | ambient occlusion | `material.occlusionTexture` (spec samples R only) |
| G       | roughness         | `pbrMetallicRoughness.metallicRoughnessTexture` (G) |
| B       | metallic          | `pbrMetallicRoughness.metallicRoughnessTexture` (B) |

`occlusionTexture` and `metallicRoughnessTexture` reference the **same
texture index** — this is the standard packing that Bevy `StandardMaterial`,
three.js `MeshStandardMaterial`, and `gltf-transform` all consume natively.
It is byte-compatible with RoadRunner `*_AORM` maps and Poly Haven `*_arm_*`
maps (no repacking needed). Separate AO/rough/metal maps (e.g. ambientCG) can
be packed with the `pack` subcommand. When an ORM texture is wired,
`metallicFactor` and `roughnessFactor` are set to 1 so the texture governs
(spec: factors multiply texels). ORM images are non-color data — any
downstream KTX2 encode must use a linear (not sRGB) transfer, which
`gltf-transform uastc` already does per slot.

## Identity guarantee

The output BIN chunk begins with the source BIN chunk **byte-for-byte**; new
image payloads are appended after it. Scenes, nodes, meshes, accessors, and
all authored bufferViews/images/textures/samplers are preserved verbatim —
EXT_meshopt_compression streams and KHR quantization are untouched by
construction (the tool never decodes geometry). Every run re-verifies this
before writing and fails loudly otherwise. Replaced base-color textures stay
embedded (unreferenced) rather than being GC'd — compacting image payloads
would shift authored byte offsets, and stripping is the image-only KTX2
packer's job (`docs/product/runtime-surface-materials.md`).

Sidecar images are content-addressed: sharing one ORM map across materials or
re-running a repair never appends a duplicate payload.

## Use

```bash
# 1. See the wiring and the defects (flags: spec-as-baseColor, frozen-roughness)
node tools/glb-orm-repair/bin/glb-orm-repair.mjs audit tiles_road.glb

# 2. Repair from a config; texture paths resolve against the config's directory
node tools/glb-orm-repair/bin/glb-orm-repair.mjs repair \
  --config ~/simforge-assets/map-bundles/cc0-textures/easterbrook-road-repair.json \
  --input tiles_road.glb --output tiles_road.orm.glb

# Optional: pack separate maps into one ORM PNG (requires the workspace sharp)
node tools/glb-orm-repair/bin/glb-orm-repair.mjs pack \
  --ao ao.png --roughness rough.png --metalness metal.png --output orm.png
```

Config shape:

```json
{
  "version": 1,
  "materials": {
    "Asphalt1":          { "orm": "asphalt_02/asphalt_02_arm_1k.png" },
    "Curb_Saratoga":     { "orm": "concrete_pavement/concrete_pavement_arm_1k.png",
                           "baseColor": "concrete_pavement/concrete_pavement_diff_1k.png",
                           "normal": "concrete_pavement/concrete_pavement_nor_gl_1k.png" },
    "sidewalk_material": { "baseColor": null, "baseColorFactor": [0.6, 0.6, 0.6, 1] }
  }
}
```

`"baseColor": null` removes a mis-wired texture and falls back to the factor.
Per-material options: `baseColorFactor`, `metallicFactor`, `roughnessFactor`,
`occlusionStrength`, `normalScale`, `optional` (skip silently when the
material is absent — for configs shared across tiles). New textures reuse the
material's existing sampler and UV set, so tiling density is unchanged
(≈1 repeat/m on roads).

PNG sidecars are recommended: Bevy's loader has no WebP decode, and the corpus
build (`simforge corpus build`) leaves non-WebP payloads byte-identical while
converting authored WebP to PNG. WebP/JPEG sidecars are accepted (magic-byte
sniffed) when wire size matters for the web viewer.

## Texture licensing

Test and machine-local repairs use **CC0 texture sets only** (Poly Haven /
ambientCG), staged under `~/simforge-assets/map-bundles/cc0-textures/`. Do not
wire RoadRunner Asset Library textures into new payloads — their
redistribution status is under legal review (`nextdir/asset-gap-analysis.md`
§5b). The tool never extracts or re-embeds existing authored images.

## Tests

```bash
node --test tools/glb-orm-repair/test/repair.test.mjs
```

Zero runtime dependencies (only `pack` needs the workspace `sharp`). The
corpus-side preservation contract lives in
`packages/cli/src/__tests__/corpus-orm.test.ts`.
