/**
 * OpenSCENARIO -> CARLA worker job_spec bridge.
 *
 * `parseXoscToActors` recovers the native actor fields; this turns them into a
 * job_spec the CARLA worker (`RealCarlaRuntimeAdapter.run`) executes with no
 * OpenSCENARIO awareness of its own. The resulting `actors[]` entries use the
 * exact field vocabulary `route_geometry._path_points_for_actor` /
 * `_timed_points_for_actor` read, so the OSC-derived job drives through the same
 * controller as a native draft — identical behavior by construction.
 *
 * Default job type is `simulate` (2D, rendering forced off) — the fast path for
 * validating that an `.xosc` runs and matches the native scenario. Pass
 * `type: "render"` for a full UE5 render.
 */
import { parseXoscToActors, type XoscImportedActor } from "./importer";

export interface XoscJobSpecActor {
  id: string;
  kind: "vehicle" | "walker";
  role: string;
  blueprint: string;
  placement_mode: "path" | "timed_path" | "point";
  spawn_point: { x: number; y: number; z?: number };
  spawn_yaw: number;
  speed_kph: number;
  path_placement: Array<{ x: number; y: number; z?: number }>;
  destination_point: { x: number; y: number; z?: number } | null;
  timed_waypoints: Array<{ x: number; y: number; z?: number; time: number; speed_kph?: number }>;
  autopilot: boolean;
  is_static: boolean;
  /**
   * Scripted traffic-control compliance: the CARLA worker's stop-line
   * targeting (`_stop_line_targets_for_route`) and its pursuit red-light path
   * key off this flag. Carried from `<Property name="stop_at_stop_line">` so a
   * managed OpenSCENARIO package can request a compliant ego (e.g. the parking
   * runway, PR-538). Omitted when the .xosc does not carry the property — the
   * worker's own default applies and legacy jobs stay byte-identical.
   */
  stop_at_stop_line?: boolean;
}

export interface XoscToJobSpecOptions {
  /** Backend CARLA map name the runtime bundle is keyed by (required). */
  mapName: string;
  /** Job type; `simulate` = 2D positions-only (default), `render` = full UE5. */
  type?: "simulate" | "render";
  /** Scenario id to stamp on the job for traceability. */
  scenarioId?: string;
  /** Fixed timestep; defaults to the platform-wide 0.05 s (20 Hz). */
  fixedDeltaSeconds?: number;
  /** Sim horizon seconds; falls back to the parsed StopTrigger, else 30. */
  durationSeconds?: number;
}

export interface XoscJobSpec {
  type: "simulate" | "render";
  map_name: string;
  fixed_delta_seconds: number;
  no_rendering_mode: boolean;
  render_enabled: boolean;
  duration_seconds: number;
  scenario_id?: string;
  /** Provenance: this job_spec was compiled from an imported .xosc. */
  source_format: "openscenario-1.0";
  actors: XoscJobSpecActor[];
}

function roleForKind(kind: "vehicle" | "walker"): string {
  return kind === "walker" ? "pedestrian" : "traffic";
}

/** Map imported OSC actors to worker actor_spec entries. */
export function xoscActorsToJobSpecActors(actors: XoscImportedActor[]): XoscJobSpecActor[] {
  return actors.map((a) => ({
    id: a.id,
    kind: a.kind,
    // Prefer the role recovered from the .xosc <Property name="role">; fall back
    // to a kind-based default only for legacy role-less files. This is what keeps
    // the ego designation (camera target) intact through the OSC round trip.
    role: a.role ?? roleForKind(a.kind),
    blueprint: a.blueprint,
    placement_mode: a.placement_mode,
    spawn_point: a.spawn_point,
    spawn_yaw: a.spawn_yaw,
    speed_kph: a.speed_kph,
    path_placement: a.path_placement,
    destination_point: a.destination_point,
    timed_waypoints: a.timed_waypoints,
    // The OSC subset the writer emits is scripted FollowTrajectory motion, so
    // the actors are driven by the custom pursuit controller, not TM autopilot.
    autopilot: false,
    is_static: false,
    // Only materialize the key when the .xosc carried the Property: an absent
    // key means "worker default", and legacy jobs stay byte-identical.
    ...(a.stop_at_stop_line == null ? {} : { stop_at_stop_line: a.stop_at_stop_line }),
  }));
}

/** Parse an `.xosc` and compile it straight into a submittable CARLA job_spec. */
export function xoscToJobSpec(xml: string, options: XoscToJobSpecOptions): XoscJobSpec {
  if (!options.mapName) {
    throw new Error("xoscToJobSpec requires options.mapName (the backend CARLA map name)");
  }
  const imported = parseXoscToActors(xml);
  const type = options.type ?? "simulate";
  const duration = options.durationSeconds ?? imported.durationSeconds ?? 30;
  const spec: XoscJobSpec = {
    type,
    map_name: options.mapName,
    fixed_delta_seconds: options.fixedDeltaSeconds ?? 0.05,
    // simulate forces no-render; render enables it.
    no_rendering_mode: type === "simulate",
    render_enabled: type === "render",
    duration_seconds: duration,
    source_format: "openscenario-1.0",
    actors: xoscActorsToJobSpecActors(imported.actors),
  };
  if (options.scenarioId) spec.scenario_id = options.scenarioId;
  return spec;
}
