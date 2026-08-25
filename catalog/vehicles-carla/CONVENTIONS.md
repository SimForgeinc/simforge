# SimForge CARLA vehicle models — conventions

18 CC BY 4.0 vehicle GLBs converted from CARLA Simulator content. Machine-readable
metadata lives in `manifest.json`; per-asset licensing in `ATTRIBUTION.json`.

## Coordinate frame

- **y-up, right-handed, meters.** `+X` = vehicle forward, `-Z` = vehicle left.
  This matches the engine actor frame (`render-core/src/catalog.rs`: length along
  `+X`, yaw about `+Y`).
- **Origin** = the CARLA vehicle pivot projected to the ground plane (`y = 0`).
  This is the same reference point CARLA uses for actor transforms, so CARLA-
  derived trajectories drop in without offset fixes. It sits mid-body, not at
  the rear axle; per-model bounds are in `manifest.json` (`bbox`) if a consumer
  needs to re-reference.
- Ground contact is `y ≈ 0` (tire bottoms).

## Scene graph

Rigid nodes, no skinning, one LOD:

| node | present on | purpose |
|---|---|---|
| `body` | all | main hull, interior, fixed glass, emissive lights |
| `wheel_fl` `wheel_fr` `wheel_rl` `wheel_rr` | 4-wheelers with rigged wheels | node origin = wheel center; spin = local rotation about `Z` (axle) |
| `door_fl` `door_fr` `door_rl` `door_rr` | vehicles with openable doors in CARLA | door shell + door glass; node origin = hinge (door bone bind pose), so door-open = local yaw |
| `wheel_f` `wheel_r`, `handlebar` | two-wheelers | same; handlebar node origin at steering pivot |

Static-source models (`tesla_model3`, `cybertruck`, `volkswagen_t2`,
`european_hgv`) are a single `body` node (their CARLA sources are static or
parked meshes without a wheel rig).

All primitives carry `POSITION`, `NORMAL`, `TANGENT`, `TEXCOORD_0`.

## Material slots

Material **names** are the contract:

- **`body_paint`** — neutral tintable paint. `baseColorFactor` ships as white
  with no base-color texture. Consumers apply the authored catalog color by
  setting `baseColorFactor` (or multiplying it in). Present on every vehicle
  whose `manifest.json` entry has `"tintable": true`.
- **`body_livery`** — authored livery texture (police, taxi, bus, classic van,
  Vespa, Ninja, Tesla, Cybertruck). **Do not tint**; the authored texture is
  the identity of the vehicle. `"tintable": false` in the manifest.
- **`glass`** (and `*_glass` variants) — `alphaMode: BLEND`, double-sided,
  low roughness. No texture.
- All other materials are conventional PBR: `baseColorTexture` +
  `normalTexture` + packed ORM (`occlusionTexture` and
  `metallicRoughnessTexture` point at the same image: occlusion=R,
  roughness=G, metallic=B — the CARLA `_orm` layout, which is glTF's native
  layout).

## Textures

- PNG only (render-core image features: `png`, `hdr`, `ktx2`; no WebP).
- Body/livery diffuse ≤ 2048², detail/normal/ORM ≤ 1024².
- Normal maps converted from UE (DirectX, −Y green) to glTF (OpenGL, +Y green).
- KTX2/UASTC migration is a possible follow-up; PNGs were chosen so the files
  load in both Bevy (`render-core`) and three.js today with zero extensions.

## Scale caveat

Meshes are exactly CARLA's authored geometry. A few CARLA models are known to
be larger than their real-world counterparts (e.g. the Fuso Rosa bus and the
2021 Mini). `manifest.json` carries per-model `dims_lwh_m`; if a consumer needs
catalog-exact footprints, uniformly scale the GLB to the catalog `dims`
(see PATCH-NOTES.md for the recommended wiring).
