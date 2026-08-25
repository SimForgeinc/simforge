# road-detail-gen

Deterministic `simforge.road-detail/v1` sidecar generator: seeded procedural
splat masks (variant weights, wheel-track/oil wear, marking erosion) and a
baked decal overlay derived from a map bundle's lane graph. Schema and
renderer wiring: `docs/road-detail.md`.

```bash
node tools/road-detail-gen/bin/road-detail-gen.mjs generate \
  --bundle ~/simforge-assets/map-bundles/easterbrook-discovery-school \
  --textures ~/simforge-assets/map-bundles/cc0-textures \
  --seed 1337 [--tile road] [--max-size 4096] [--out <dir>] \
  [--road-materials Asphalt1] [--marking-materials LaneMarking1,LaneMarkingYellow1]
```

Zero runtime dependencies (PNG encoding is in-tree). Determinism contract:
sidecar `digests.*RgbaSha256` over the raw RGBA payloads; asserted by

```bash
node --test tools/road-detail-gen/test/gen.test.mjs
```

Texture licensing: CC0 only (Poly Haven / ambientCG) or SimForge-authored;
never RoadRunner Asset Library content (see tools/glb-orm-repair/README.md).
