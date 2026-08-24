# V2X Scenario Migration (V6)
> **Historical completion record:** Pre-rebrand UniScenarios package, CLI,
> application, and evidence paths are retained verbatim below.


Status: complete 2026-08-22, branch `v2x-scenario-migration`.
Retires the patched external ScenarioRunner: OpenSCENARIO authoring, GPS
trajectory authoring and traffic presets are re-expressed as native
UniScenarios artifacts on `richmond-field-station`. Everything here was
executed; evidence lives under `apps/v2x-migration/`.

## Per-scenario status matrix

| Source (.xosc, READ-ONLY at `/home/path/V2XCarla/v2x-backend/apps/bridge/scenarios/`) | Import (`uniscenarios import --map richmond-field-station`) | Status | Working artifact |
|---|---|---|---|
| `firetruck_from_north.xosc` | exit 2 — 2 actors preserved exactly (world positions + initial speed); storyboard semantics unsupported | **re-expressed** | `apps/v2x-migration/scenarios/firetruck-from-north.template.json` |
| `firetruck_from_south.xosc` | exit 2 — same profile | **re-expressed** | `apps/v2x-migration/scenarios/firetruck-from-south.template.json` |
| `sample.xosc` | exit 2 — ego dropped (`actor_position_unsupported`: no Init WorldPosition); NPC preserved | **re-expressed** | `apps/v2x-migration/scenarios/sample-npc-cruise.template.json` |

Import drafts + machine-readable findings: `apps/v2x-migration/imported/`
and `apps/v2x-migration/findings/*.import.json`.

### Lossy / unmapped constructs and their re-expression

| xosc construct | Importer disposition | Native re-expression |
|---|---|---|
| `AcquirePositionAction` (BasicAgent route to goal) | `storyboard_semantics_not_translated` (unsupported) | firetruck role carries `laneRef` + `initialRoute {mode:'lanePath'}` over the exact lane chain (`18:0:1 → 243:0:1 → 44:0:1` north; `26:0:1 → 143:0:1 → 44:0:-1 → 246:0:-1 → 18:0:-1` south); goal arrival verified against the xosc `ReachPositionCondition` tolerance of 6 m in the clear-road evidence run |
| `basic_agent_control` (yields/stops behind obstacles instead of ploughing through) | not representable | engine lane-route follower with default IDM collision avoidance + `driverProfile: "cautious"` + explicit `gap {role: ego_vehicle, value: 8 m}` standoff interaction |
| `external_control` ego attachment (ScenarioRunner binds by `role_name=ego_vehicle`) | not representable | non-static `scene_absolute` ego held standing by an explicit `speed {mode:'stop'}` interaction; live control arrives via the V2 BridgePort drive session. (A `static:true` stand-in is invisible to the follower's leader detection and must not be used.) |
| `ControllerAction` overrides (throttle/brake/steering) | not representable | dropped — exists only to stop SR's NpcVehicleControl fighting bridge control; the deterministic engine has no such fight |
| `criteria_CollisionTest` | evaluation criteria extracted by SR | engine contact guard + `debug --fail-on-collision`; asserted in verification |
| `SimulationTimeCondition` 120 s / 125 s safety timeouts | unsupported | `choreography.clipSeconds: 120` |
| `EnvironmentAction ClearNoon` | `environment_approximated` | `environment {weather: clear, timeOfDay: noon}` |
| catalog appearance (tesla model3 / carlamotors firetruck) | `catalog_appearance_approximated` | `vehicle.sedan` / `vehicle.fire_engine` with xosc BoundingBox-exact `dims` |

### Verification (all executed, `apps/v2x-migration/evidence/`)

`pnpm exec tsx apps/v2x-migration/tools/verify-migration.ts` →
`evidence/verification.json` — **PASS** for both firetruck scenarios:

- actor counts match the xosc Entities;
- approach geometry: clear-road run traverses the exact lane chain; yield-stop
  run stops within the chain behind the standing ego (27.9 m north / 17.1 m
  south centre distance, no contact);
- event ordering: rolling from spawn at cruise 8.33 m/s, controlled stop
  behind the ego (BasicAgent standoff), no collision (collision criterion);
- pass branch: clear-road run closes to 3.5 m (north) / 3.9 m (south) of the
  goal — inside the 6 m `ReachPositionCondition` tolerance;
- traces committed beside each report (`trace.json.gz`, digests in reports).

`sample-npc-cruise`: simulated clean (`evidence/sample-npc-cruise.debug.json`) —
NPC spawns at rest, accelerates linearly to 12 m/s after t = 1 s, no contact.

Known fidelity divergence (documented, not hidden): between keyframes the
engine's Hermite timed-route walk cuts corners where the recorded track is
jittery; and the deterministic follower's standoff distance is governed by its
own gap law rather than CARLA's BasicAgent overlap threshold.

## GPS trajectory JSON authoring

Converter: `apps/v2x-migration/tools/trajectory-to-template.mjs` — ports both
input formats of the READ-ONLY `trajectory_player.py` parser:

```bash
node apps/v2x-migration/tools/trajectory-to-template.mjs \
  <trajectory.json> --map richmond-field-station --out <template.json> \
  [--object-id ID] [--actor-id ID] [--class car] [--catalog-id vehicle.sedan] \
  [--pad-s 5] [--resample-s 0.25] [--no-snap]
```

- **V2X detection list** `[{object_id, timestamp_utc, gps_location:{latitude, longitude}}, ...]`:
  most-frequent `object_id` wins (override with `--object-id`), records sorted
  by ISO timestamp, times normalised to seconds from first.
- **Simple list** `[{t, lat, lon}, ...]` with t seconds since start.

Coordinates: WGS-84 → legacy flat-earth frame per `docs/v2x-coordinate-contract.md`
(V2 MapParity; reference impl `packages/xodr-tools/src/legacy-flat-earth.ts`,
`x = (lon−lon0)·111320·cos(lat0)`, `y = −(lat−lat0)·111320`), origin read from
the map bundle's own XODR `<geoReference>`. Scene frame z = negated northing
(= legacy CARLA y). Every emitted template pins `{mapId, xodrSha256}`;
consumers must refuse mismatched digests. Samples snap to lane-centre
polylines (counterpart of `get_waypoint(project_to_road)`) unless `--no-snap`.

Executed on `event1.json` (36 detection records for `global_car_1`, 14.33 s):
→ `apps/v2x-migration/trajectories/event1.template.json`, simulated clean
(`evidence/event1.debug.json`, `evidence/event1.verification.json`). The
timed-route walk passes within <5 cm of every checked keyframe exactly at its
recorded timestamp; inter-keyframe deviation (mean 2.76 m, max 7.02 m) is
Hermite corner-cutting on the perception-jittery track.

## Traffic presets

CARLA `drive_server.py` presets mapped onto `ambientTrafficProfile`
(`packages/sim-engine/src/ambient/traffic.ts`); configs in
`apps/v2x-migration/traffic/<name>.ambient.json`, each embedding its source
preset. Apply at instantiate/simulate time with the CLI ambient flags:

| CARLA preset | vehicles | TM speed_diff | TM distance | TM ignore lights/signs % | Uni config | `--ambient` | density veh/km | maxActors | aggressiveness |
|---|---|---|---|---|---|---|---|---|---|
| none   | 0   | 0   | 2.0 | 0 / 0    | `none.ambient.json`   | off      | 0  | 0   | 0.0 |
| light  | 20  | 30  | 3.0 | 0 / 0    | `light.ambient.json`  | light    | 3  | 20  | 0.10 |
| medium | 60  | 10  | 2.0 | 5 / 2    | `medium.ambient.json` | moderate | 8  | 60  | 0.35 |
| heavy  | 120 | 0   | 1.5 | 15 / 10  | `heavy.ambient.json`  | heavy    | 16 | 120 | 0.55 |
| chaos  | 180 | −20 | 1.0 | 35 / 30  | `chaos.ambient.json`  | custom   | 16 | 128 (capped) | 0.90 |

Fidelity gaps (documented per config):

- **Count semantics**: CARLA spawns an absolute vehicle count; ambient-traffic
  targets a *density* over eligible lanes near the scenario inside `radiusM`,
  so equal counts are not guaranteed at equal radii. `chaos` requests 180 but
  the schema caps `maxActors` at 128.
- **Per-vehicle light/sign running**: TM sets `ignore_lights_percentage` /
  `ignore_signs_percentage` per vehicle (up to 35 % / 30 %). Ambient-traffic
  has no per-vehicle compliance axis; the closest lever is the population-wide
  `aggressiveness`, which scales gaps/desired speed but does not produce
  red-light runners. Deterministic light-running choreography must be authored
  explicitly (driverProfile `violator` roles or signal overrides).
- **Speed differential**: TM `speed_diff` (±km/h offset from the limit,
  negative below) maps only indirectly via `aggressiveness`/`speedVariance`;
  there is no per-preset fleet speed offset.
- **Headway**: TM `distance` (metres base) has no direct knob; IDM
  `minimumGapM`/`timeHeadwayS` come from driver profiles.

## What V2 BridgePort calls, per authoring type

| Authoring type | Pipeline | BridgePort integration |
|---|---|---|
| Migrated .xosc scenario | template → `uniscenarios debug/instantiate` (map-bound materialization) or studio playback | load template; drive-session ego attaches to the `ego_vehicle` role (its stop command releases on first external control); EVA pull-over toast stays bridge-side logic keyed on the firetruck role |
| Fresh OpenSCENARIO | `uniscenarios import <file.xosc> --map …` → draft → hand-finish storyboard semantics per table above | same as migrated scenarios |
| GPS trajectory JSON | converter tool → timed-route template → simulate | treat like any scenario; for live uploads, convert then hot-load; timestamps survive conversion so replay pacing matches the source feed |
| Traffic presets | read `<name>.ambient.json` → pass equivalent `--ambient*` flags (or call `applyAmbientTraffic` programmatically) | expose preset names unchanged (`none/light/medium/heavy/chaos`) over the WS protocol; document the fidelity table above to clients |
