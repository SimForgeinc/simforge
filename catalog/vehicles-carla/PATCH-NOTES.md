# Patch notes: wiring `model` into asset-catalog and the renderers

This lane ships new files only. The following integration edits are left to the
merge owner (they touch existing files).

## 1. `packages/asset-catalog/catalog.json` (+ its TS types)

Per the cross-lane contract, vehicle entries gain an optional `model` field:

```jsonc
{
  "id": "vehicle.sedan",
  // ...existing fields...
  "model": {
    "glbPath": "catalog/vehicles-carla/models/vehicle_sedan_lincoln_mkz.glb",
    "attribution": "\"Lincoln MKZ 2017\" vehicle model © CARLA Simulator contributors (carla.org), CC BY 4.0; converted to glTF for SimForge.",
    "source": "carla-0.10.0-ue5"
  }
}
```

The exact id → GLB assignment (including family fallbacks for ids without a
bespoke model) is precomputed in **`catalog-models.json`** in this directory —
it can be merged into `catalog.json` mechanically. Suggested extras kept in the
sidecar: `tintable`, `scaleToDims`.

Type addition (`packages/asset-catalog/src/…` wherever `CatalogEntry` lives):

```ts
model?: { glbPath: string; attribution: string; source: string };
```

## 2. Bevy — `renderer/render-core/src/catalog.rs` (`actor_parts`)

- When the resolved catalog entry has `model.glbPath`, spawn the GLB scene
  (`WorldAssetRoot`) instead of the box/cylinder parts, parented under the
  actor entity so the existing transform/heading path is untouched (origin and
  axes already match — see CONVENTIONS.md).
- Tint: after instance-ready, query spawned descendants for
  `GltfMaterialName("body_paint")` and set
  `StandardMaterial.base_color = entry.defaultParams.color` (or scenario
  override). `tools/bevy-smoke/src/main.rs` in this directory contains a
  working reference implementation of load → tint → frame.
- Optional exact footprint: uniform-scale the spawned root by
  `catalog.dims.l / manifest.dims_lwh_m[0]` when `scaleToDims` is set.
- ID/legend pass: reuse the existing mesh-clone path (`IdClone`) — GLB meshes
  arrive as ordinary `Mesh3d` descendants.
- Wheel spin (follow-up): rotate `wheel_*` nodes about local `Z` by
  `speed / wheel_radius`; wheel node origins are at wheel centers.

## 3. three.js — `apps/web/.../map-3d-scene.ts` + `city-viewer/actor-overlays.ts`

- Replace `BoxGeometry` actor bodies with `GLTFLoader` instances when
  `model.glbPath` is present (keep the box path as fallback).
- Tint: `scene.traverse`, match `material.name === 'body_paint'`, set
  `material.color` from the authored hex. Never tint `body_livery`.
- Cache one parsed GLTF per glbPath and `SkeletonUtils.clone`/`.clone()` per
  actor instance.

## 4. Serving

`models/*.glb` are self-contained binaries (embedded PNG); serve them like the
existing map GLB tiles (same static-asset route), no new loader features
needed (no Draco/meshopt/quantization/WebP anywhere in these files).
