# Native sensor suite — class taxonomy, legend, and conventions

WSB3 reference for the semantic-class pass, instance-ID pass, lidar
intensity proxy, and frame conventions. Code: `native/sensors/src/taxonomy.rs`.

## Semantic classes (closed set)

Encoded in the red channel of an unlit RGBA8 render (`Tonemapping::None`,
black clear). Background/sky = 0.

| ID | Class      | Source                                                        |
|----|------------|---------------------------------------------------------------|
| 0  | unlabeled  | background / sky                                              |
| 1  | road       | static mesh names matching road/asphalt/sidewalk/curb/ground/pavement/crosswalk/marking |
| 2  | building   | static mesh names containing "building"                       |
| 3  | vegetation | mesh names containing tree/veg/bush/shrub/plant/foliage/grass/hedge |
| 4  | car        | scenario-model actor class `car`                              |
| 5  | truck      | actor class `truck`; scenario `kind: bus` folds into truck    |
| 6  | pedestrian | actor class `pedestrian`                                      |
| 7  | cyclist    | actor class `cyclist`                                         |
| 8  | prop       | any other prop-catalog static                                 |

Matching order for statics: vegetation before building before road keywords,
fallback `prop`.

## Instance IDs

Per-scene, deterministic, independent of process/ECS entity ids:

1. every rendered mesh entity (static tiles + actor cuboids) gets a name:
   its GLB node name, or `actor:<actorId>` for scene-state actors;
2. entities are sorted by `(name, world-space triangle-centroid bits)`;
3. ids are assigned 1-based in that order; 0 = background.

Duplicate mesh names (instanced geometry) are disambiguated by position, so
the assignment is byte-stable across processes. The mapping is written to
`legend.json` per capture (`schema: uniscenarios.sensor-legend/v1`, sorted by
id), alongside per-instance semantic classes.

## Lidar intensity proxy

`intensity = albedo(class) × (0.25 + 0.75 × |cos incidence|)`, clamped to
[0, 1] — a deterministic stand-in for reflectivity, not a calibrated model.
Class albedos: road 0.25, building 0.45, vegetation 0.55, car 0.70,
truck/bus 0.65, pedestrian/cyclist 0.60, prop 0.50, unlabeled 0.

## Beam / fan conventions

- Sensor frame: x forward, y up, z left (canonical Pronto frame; mounts come
  from `qualification/render-qualification-program.v1.json prontoRig`, lowered
  via pod datum 0.85 m forward / plate 1.78 m up exactly like
  `adapters/carla-bridge .../run_local.py::_mount`).
- Lidar azimuth 0 = sensor forward, positive toward +z (left); elevation
  positive up; channels span [-vfov/2, +vfov/2]; one scan = one revolution at
  azimuth step 0; steps/rev = points_per_second / (channels × rotation_hz).
- Radar azimuth positive-left, altitude positive-up; velocity is the relative
  radial component along the beam (target − host).
- World frame = tile GLB frame: x = map x, z = −map y, y up. GNSS inverts the
  map's OpenDRIVE `+proj=tmerc geoReference` (local origin at lat_0/lon_0).

## Output formats (CARLA-path parity)

- lidar → ASCII PLY (`x,y,z,intensity` float properties + one extra declared
  `uint instance_id`); parses with carla-bridge `sensor_video._read_lidar_points`.
- radar → CSV header `depth_m,azimuth_rad,altitude_rad,velocity_mps`, rows
  `%.9g`-style — byte-compatible with `_write_radar_csv`.
- IMU/GNSS → JSONL (`imu.jsonl`, `gnss.jsonl`).

## Interim notes

- Actor meshes are cuboids sized per actor class until WSB2's prop-catalog
  actor pipeline lands in render-core; sensor math/determinism unaffected.
- RGB uses AgX tonemapping with fixed sun+ambient (sensor profile baseline);
  WSB4's lighting stack supersedes this when wired.
