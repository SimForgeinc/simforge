# Vehicle pipeline tooling

Regenerates `../models/*.glb` from CARLA cooked content. Nothing here runs at
product runtime.

## 0. Source content (one-time, local machine)

Loose cooked UE 5.5 assets copied from the CARLA docker image layers to
`~/simforge-assets/carla-content/CarlaUnreal/Content/Carla/Static/{Car,Truck,Bus,Motorcycle,GenericMaterials}`
(union of the base + map layers, docker layer order). No pak/IoStore files
exist in these images; the legacy-era vehicle packages are *versioned* and need
no `.usmap` mappings. The 0.10-era `*2024` packages use unversioned properties
and would need a UE 5.5 usmap — not required, the versioned set covers every
family.

## 1. `extract/` — CUE4Parse export (C#, .NET 10)

```sh
cd extract && dotnet run -c Release -- \
  ~/simforge-assets/carla-content/CarlaUnreal \
  <export-dir> targets.txt
```

Builds against a local clone of https://github.com/FabianFG/CUE4Parse
(Apache-2.0; commit used: see report). Two local fixes were applied to the
clone: `ExportSession.ResolveOutputPath` drops the Windows `'/'→'\\'` replace,
and `SkiaSharp.NativeAssets.Linux` is added for texture decode on Linux.
Outputs per-mesh GLB (skinned, MI-named materials), PNG textures,
CMaterialParams2 JSON per material, and `materials-sidecar.json`
(mesh → slot → material-instance map).

## 1b. Blueprint component harvest (doors/glass/emissive)

CARLA's openable doors, window glass, and light-emissive quads are separate
static-mesh components in each vehicle blueprint, NOT part of the body
skeletal mesh. `extract` has a `--dumpbp` mode that serializes a cooked BP to
JSON; `extras.json` (committed here) is the harvested per-vehicle table
`{vid: [{mesh, socket, t, overrides}]}` — door components attach at door-bone
sockets, door glass carries a component-space offset. Regenerate it by dumping
`BP_<Vehicle>` for each vehicle and collecting mesh components (skip `SM_sc_*`
collision, `SK_*` rider dummies, `Wheel_Shape`).

## 2. `assemble.py` — final GLB authoring (python3 + numpy + Pillow)

```sh
python3 assemble.py <export-dir> <staging-dir> extras.json
```

Splits skinned meshes into rigid nodes by dominant bone (CARLA vehicle rigs
are 100% rigid-weighted), rewires PBR materials per CONVENTIONS.md (neutral
`body_paint`, `body_livery`, glass, ORM packing, normal-map green flip),
resizes/embeds PNG textures, writes one self-contained GLB per vehicle.

## 3. Decimate + validate

```sh
# >100k-tri meshes
npx @gltf-transform/cli simplify --ratio 0.18 --error 0.0008 in.glb out.glb
# all files: Khronos validator (0 errors expected)
node -e "require('gltf-validator').validateBytes(...)"
```

## 4. `bevy-smoke/` — render smoke test (bevy 0.19.1, matches render-core)

```sh
cargo run --release -- ../models/vehicle_sedan_lincoln_mkz.glb /tmp/out.png [--tint 2f4f74]
```

Loads the GLB, applies the tint to `body_paint` (proving the slot convention),
frames the scene AABB, saves a screenshot, exits.
