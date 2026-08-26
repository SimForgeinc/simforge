# Road detail layer — `simforge.road-detail/v1`

The Road-Painter-equivalent for the native (Bevy) renderer: per-tile
splat-blended asphalt/concrete variants, procedural wheel-track/oil wear,
worn lane markings, and baked decal stamps (cracks, patches, oil, stains) —
all CC0-seeded and **deterministic** (same inputs → same pixels on the same
device). This closes the last asset-level gap identified against CARLA's
Road Painter workflow (`nextdir/bevy-look-research.md`, paths 2/3).

Components:

| Piece | Location |
|---|---|
| Master material (Bevy `ExtendedMaterial`) | `renderer/render-core/src/road_detail.rs` |
| Fragment shader | `renderer/render-core/src/shaders/road_detail.wgsl` |
| Sidecar generator | `tools/road-detail-gen` |
| Job wiring (flag) | `renderer/render-core/src/job.rs` (`roadDetail`), `packages/render/src/native/engine.ts` (`NativeCameraSchedule.roadDetail`) |

## Sidecar document

One JSON sidecar + textures per tile, produced by `road-detail-gen`,
conventionally at
`<bundle>/browser/3d/tiles/<tile>.road-detail/<tile>.road-detail.json`.
Texture paths resolve **relative to the sidecar's directory**.

```json
{
  "schema": "simforge.road-detail/v1",
  "tileId": "easterbrook-discovery-school/road",
  "seed": 1337,
  "generator": { "tool": "road-detail-gen", "version": "1.0.0", "maxSize": 4096 },
  "bounds": { "minX": -230.9, "minZ": -13.4, "maxX": 267.4, "maxZ": 337.4 },
  "materials": {
    "road": ["Asphalt1"],
    "marking": ["LaneMarking1", "LaneMarkingYellow1"]
  },
  "splat": { "texture": "splat.png" },
  "decalOverlay": { "texture": "decals.png" },
  "decalAtlas": { "texture": "atlas.png" },
  "variants": [
    { "id": "asphalt_02", "role": "a",
      "baseColor": "asphalt_02_diff_1k.png",
      "normal": "asphalt_02_nor_gl_1k.png",
      "orm": "asphalt_02_arm_1k.png",
      "tilingPerMeter": 0.35,
      "source": { "provider": "Poly Haven", "url": "https://polyhaven.com/a/asphalt_02", "license": "CC0" } }
  ],
  "detailNormal": { "texture": "asphalt_02_nor_gl_1k.png", "tilingPerMeter": 1.7, "strength": 0.5 },
  "params": { "wearAlbedoDarken": 0.38, "wearRoughnessDelta": -0.22, "markingWearStrength": 0.85 },
  "decals": [
    { "type": "crack", "stamp": 0, "x": 219.3, "z": 320.1, "rotDeg": 12.5, "sizeM": 3.2, "intensity": 0.8 }
  ],
  "digests": {
    "splatRgbaSha256": "…", "decalOverlayRgbaSha256": "…", "atlasRgbaSha256": "…"
  }
}
```

Field semantics:

- **bounds** — world-XZ rectangle of the mask textures. Shader mapping:
  `uv = (world.xz − boundsMin) / boundsSize`, clamped.
- **materials** — GLB material names (as tagged by the glTF loader's
  `GltfMaterialName`) to rewire. `road` entries get surface mode, `marking`
  entries get marking mode. Everything else in the tile is untouched.
- **splat** channels (linear RGBA):
  - `R` — weight of variant A (aged asphalt), seeded world-space fbm inside
    driving/shoulder lanes + repair-patch rectangles.
  - `G` — weight of variant B (concrete repair), sparser fbm threshold.
  - `B` — wear: twin wheel-track bands (Gaussian around t = 0.55 of the lane
    half-width, per-lane seeded traffic amplitude) plus a center oil band.
    Drives albedo darkening (`wearAlbedoDarken`) and roughness shift
    (`wearRoughnessDelta`, negative = polish).
  - `A` — lane-marking erosion: strongest in a band along lane edges (where
    markings live) plus wheel-crossing bleed. Marking mode uses coherent
    noise to fade chipped regions toward asphalt gray and roughens surviving
    paint. It deliberately stays opaque because some source meshes have no
    road primitive beneath marking strips; fragment discard would expose the
    world clear color.
- **variants** — 1–2 extra surfaces blended over the authored GLB material
  (variant 0). `role` selects the splat channel (`a` → R, `b` → G). ORM uses
  the packed AO/rough/metal convention of `tools/glb-orm-repair`. Sources
  MUST be CC0 or SimForge-authored; the `source` block records provenance.
- **detailNormal** — high-frequency normal layer tiled at
  `tilingPerMeter`, scaled by `strength`; damped under decals.
- **decals** — the authored list of stamp instances (world transforms).
  `decalOverlay` is the pre-composited bake of these instances from
  `decalAtlas` (2×2 grid: crack / patch / oil / stain; R = shade,
  A = shape). Renderers consume only the baked overlay; the instance list
  is retained so future true-decal renderers (or the web viewer) can
  re-composite at higher fidelity.
- **digests** — sha256 of the **raw RGBA payloads** (not the PNG bytes);
  this is the determinism contract asserted by
  `tools/road-detail-gen/test/gen.test.mjs`.

## Generator

```bash
node tools/road-detail-gen/bin/road-detail-gen.mjs generate \
  --bundle ~/simforge-assets/map-bundles/easterbrook-discovery-school \
  --textures ~/simforge-assets/map-bundles/cc0-textures \
  --seed 1337
```

Inputs: `browser/lane-polygons.geojson.gz` (WGS84 lane polygons),
`browser/topology-index.json.gz` (lane widths), the map `xodr`
`<geoReference>` (tmerc origin). Lon/lat → SimForge XZ uses a local
ellipsoidal ENU approximation (≪ texel error over <1 km maps) with the
verified frame mapping `sf.x = local_x`, `sf.z = −local_y`.

Everything is seeded: value-noise lattices hash integer coordinates with the
tile seed; per-lane amplitudes hash the lane `road:section:lane` id; decal
placement consumes one deterministic `splitmix32` stream in input order. The
decal atlas is built from a fixed constant seed, so its digest is identical
across tiles and runs.

## Renderer wiring

`native-render-job` job files accept an optional flag block:

```json
{ "roadDetail": { "sidecars": ["/abs/path/road.road-detail.json"] } }
```

Absent → byte-identical legacy output. Present → after scene readiness the
engine loads the sidecar textures (CPU-decoded, mipless, fixed samplers) and
swaps every mesh whose `GltfMaterialName` is listed in `materials` to
`ExtendedMaterial<StandardMaterial, RoadDetailExtension>`; the authored
material remains the blend base, so tile UV density, alpha modes, and any
ORM repair (`tools/glb-orm-repair`) survive. The instance-ID pass and
legend are unaffected (ID clones use engine-created unlit materials).

The Node adapter (`@simforge-oss/render` native engine) forwards
`NativeCameraSchedule.roadDetail` verbatim into the job file.

## Determinism & tests

- `cargo test -p render-core --lib road_detail` — sidecar schema validation.
- `cargo test -p render-core --test road_detail_pipeline` — WGSL composes
  through naga_oil and specializes to an `Ok` pipeline on a real adapter
  (set `SF_NO_GPU=1` to skip on GPU-less hosts).
- `node --test tools/road-detail-gen/test/gen.test.mjs` — mask digest
  determinism, seed sensitivity, wear/erosion placement, atlas stability,
  PNG encoding, georeference math.

## Licensing

Variant textures: CC0 only (Poly Haven / ambientCG), staged under
`~/simforge-assets/map-bundles/cc0-textures/`, provenance pinned per variant
in the sidecar. The decal atlas is procedurally generated in-process
(SimForge-authored). No RoadRunner Asset Library content is referenced —
its redistribution is under legal review (`nextdir/asset-gap-analysis.md`).
