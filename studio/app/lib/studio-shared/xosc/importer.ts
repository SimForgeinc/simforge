/**
 * OpenSCENARIO 1.0 XML -> native SimForge actor job_spec importer.
 *
 * This is the inverse of `apps/web/app/lib/scenario-editor/xosc-writer` and the
 * keystone that lets an `.xosc` file execute inside the REAL CARLA worker: the
 * worker never learns to read OpenSCENARIO. Instead we parse the `.xosc` back
 * into the flat per-actor `job_spec` shape the worker already consumes
 * (`services/carla-worker/carla_worker/route_geometry.py`,
 * `carla_worker/validation.py:_semantic_executable_projection`), and hand that
 * to the exact same `RealCarlaRuntimeAdapter.run`. Because one executor drives
 * both the native draft and the OSC-derived job, behavior is identical *by
 * construction* — see `xoscRoundTripEffectiveMotion` for the property we assert.
 *
 * Scope: the OSC 1.0 subset the in-house writer emits — Entities
 * (Vehicle/Pedestrian), Init (TeleportAction + SpeedAction), and one
 * FollowTrajectoryAction per actor (Polyline of WorldPosition vertices). A
 * `TimeReference/None` trajectory imports as `placement_mode: "path"`; a
 * `TimeReference/Timing` trajectory imports as `placement_mode: "timed_path"`.
 * A ScenarioObject with an Init spawn but no trajectory imports as
 * `placement_mode: "point"` (spawn-only).
 *
 * Coordinate frames: the writer emits WorldPosition x/y verbatim in the draft's
 * runtime frame, and this parser reads them back verbatim. No Y-flip happens
 * here — the runtime->CARLA flip is applied identically by the worker
 * (`coordinate_frames.py`) regardless of whether the job_spec came from a native
 * draft or an OSC import, so it cancels in the round trip. (esmini, by contrast,
 * interprets WorldPosition against the `.xodr` CARLA frame; that mismatch is a
 * validation-layer concern, not a round-trip concern.)
 */
import { XMLParser } from "fast-xml-parser";

/** Per-actor world point in the runtime/draft frame. */
export interface XoscMapPoint {
  x: number;
  y: number;
  z?: number;
}

/** A single timed waypoint recovered from a Timing-referenced trajectory. */
export interface XoscTimedWaypoint {
  x: number;
  y: number;
  z?: number;
  time: number;
  /**
   * Per-segment speed (kph) reconstructed from the position/time deltas of the
   * Timing-referenced trajectory. In an OSC Timing trajectory the speed IS the
   * timing (position-at-time), so `dist / dt` recovers the authored segment
   * speed exactly — this is what the CARLA worker's `_timed_points_for_actor`
   * consumes to drive the actor at the intended speed. Omitted for the first
   * waypoint and any zero-duration (coincident hold) segment.
   */
  speed_kph?: number;
}

/**
 * One actor imported from an `.xosc`, expressed in the native job_spec field
 * names the CARLA worker reads. This is deliberately the same vocabulary as
 * `ScenarioEditorActorDraft` / the flat worker `actor_spec` so it can be spread
 * straight into a job_spec `actors[]` entry.
 */
export interface XoscImportedActor {
  id: string;
  kind: "vehicle" | "walker";
  /**
   * Actor role recovered from `<Property name="role">` (ego/traffic/pedestrian/
   * prop). OpenSCENARIO has no first-class ego flag, so the writer carries it as
   * a Property; null when the .xosc predates that or omits it. The job_spec
   * bridge needs this to preserve which actor the cameras attach to.
   */
  role: string | null;
  /**
   * Traffic-control compliance recovered from
   * `<Property name="stop_at_stop_line">`: whether the worker's controller
   * scripts stops at stop lines / stop signs (and, for pursuit egos, red
   * lights) along this actor's route. OpenSCENARIO has no first-class flag for
   * a scripted-trajectory actor's sign compliance — TM ignore-percentages
   * don't apply to trajectory followers, and these maps import stop signs as
   * props with no `traffic.stop` actors — so the managed contract carries it
   * the same way as `role`. Null when the .xosc omits it (legacy files):
   * consumers keep their current default, byte-identical to before.
   */
  stop_at_stop_line: boolean | null;
  blueprint: string;
  placement_mode: "path" | "timed_path" | "point";
  spawn_point: XoscMapPoint;
  spawn_yaw: number;
  speed_kph: number;
  /** path mode: intermediate polyline points between spawn and destination. */
  path_placement: XoscMapPoint[];
  /** path mode: final polyline point (null when the trajectory had only spawn). */
  destination_point: XoscMapPoint | null;
  /** timed_path mode: the authored timed polyline (x/y/time). */
  timed_waypoints: XoscTimedWaypoint[];
}

export interface XoscImportedScenario {
  description: string | null;
  /** Relative OpenDRIVE filename from <RoadNetwork><LogicFile filepath>. */
  logicFile: string | null;
  /** Scenario stop time in seconds (from the Storyboard StopTrigger), if present. */
  durationSeconds: number | null;
  actors: XoscImportedActor[];
}

export class XoscImportError extends Error {
  constructor(
    message: string,
    public actorId?: string,
  ) {
    super(message);
    this.name = "XoscImportError";
  }
}

const RAD_TO_DEG = 180 / Math.PI;
const MPS_TO_KPH = 3.6;

/**
 * Round to 6 decimals. The writer serializes coordinates via `toFixed(6)`, so
 * matching that precision here makes `job_spec -> .xosc -> job_spec` exact
 * rather than off by float noise.
 */
function round6(value: number): number {
  return Number(Number(value).toFixed(6));
}

/** fast-xml-parser groups attributes under this key (see parser options). */
const ATTR = "@";

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attrs(node: unknown): Record<string, unknown> {
  if (node && typeof node === "object" && ATTR in (node as Record<string, unknown>)) {
    const a = (node as Record<string, unknown>)[ATTR];
    if (a && typeof a === "object") return a as Record<string, unknown>;
  }
  return {};
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function requireNum(value: unknown, what: string, actorId?: string): number {
  const parsed = num(value);
  if (parsed === null) {
    throw new XoscImportError(`expected a finite number for ${what}`, actorId);
  }
  return parsed;
}

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function makeParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributesGroupName: ATTR,
    attributeNamePrefix: "",
    parseAttributeValue: true,
    parseTagValue: false,
    trimValues: true,
    // Force these to arrays so single-child documents and multi-child documents
    // parse to the same shape. Order of same-named siblings is preserved.
    isArray: (name) =>
      [
        "ScenarioObject",
        "Private",
        "PrivateAction",
        "ManeuverGroup",
        "Maneuver",
        "Event",
        "Action",
        "Vertex",
        "EntityRef",
        "Act",
        "Story",
      ].includes(name),
  });
}

function worldPositionPoint(positionNode: unknown, actorId?: string): { point: XoscMapPoint; yawDeg: number } {
  const position = (positionNode as Record<string, unknown>) ?? {};
  const world = position["WorldPosition"];
  if (!world) {
    throw new XoscImportError("Position is missing a WorldPosition", actorId);
  }
  const a = attrs(world);
  const x = requireNum(a["x"], "WorldPosition/@x", actorId);
  const y = requireNum(a["y"], "WorldPosition/@y", actorId);
  const zRaw = num(a["z"]);
  const hRaw = num(a["h"]);
  const point: XoscMapPoint = { x: round6(x), y: round6(y) };
  if (zRaw !== null && zRaw !== 0) point.z = round6(zRaw);
  const yawDeg = hRaw === null ? 0 : round6(hRaw * RAD_TO_DEG);
  return { point, yawDeg };
}

/** Read the RAW `<Property name="..." value="...">` attribute from a
 * Vehicle/Pedestrian element. Raw because `parseAttributeValue: true` already
 * coerces `value="true"` to a boolean — callers pick their own coercion. */
function readEntityProperty(entityElement: unknown, name: string): unknown {
  const el = entityElement as Record<string, unknown> | undefined;
  const properties = el?.["Properties"] as Record<string, unknown> | undefined;
  if (!properties) return undefined;
  for (const prop of asArray(properties["Property"])) {
    const a = attrs(prop);
    if (str(a["name"]) === name) return a["value"];
  }
  return undefined;
}

function readRoleProperty(entityElement: unknown): string | null {
  const value = str(readEntityProperty(entityElement, "role"));
  return value === "" ? null : value;
}

/** `<Property name="stop_at_stop_line">` — absent/unrecognized reads as null
 * (consumer default), so legacy files stay byte-identical through the bridge. */
function readStopLineProperty(entityElement: unknown): boolean | null {
  const value = readEntityProperty(entityElement, "stop_at_stop_line");
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

interface InitActorState {
  spawn_point: XoscMapPoint;
  spawn_yaw: number;
  speed_kph: number;
}

function parseInit(storyboard: Record<string, unknown>): Map<string, InitActorState> {
  const byEntity = new Map<string, InitActorState>();
  const init = storyboard["Init"] as Record<string, unknown> | undefined;
  if (!init) return byEntity;
  const actions = init["Actions"] as Record<string, unknown> | undefined;
  if (!actions) return byEntity;

  for (const priv of asArray(actions["Private"])) {
    const privNode = priv as Record<string, unknown>;
    const entityRef = str(attrs(privNode)["entityRef"]);
    if (!entityRef) continue;

    let spawn: XoscMapPoint | null = null;
    let yaw = 0;
    let speedKph = 0;

    for (const pa of asArray(privNode["PrivateAction"])) {
      const paNode = pa as Record<string, unknown>;
      const teleport = paNode["TeleportAction"] as Record<string, unknown> | undefined;
      if (teleport) {
        const { point, yawDeg } = worldPositionPoint(teleport["Position"], entityRef);
        spawn = point;
        yaw = yawDeg;
      }
      const longitudinal = paNode["LongitudinalAction"] as Record<string, unknown> | undefined;
      if (longitudinal) {
        const speedAction = longitudinal["SpeedAction"] as Record<string, unknown> | undefined;
        const target = speedAction?.["SpeedActionTarget"] as Record<string, unknown> | undefined;
        const absolute = target?.["AbsoluteTargetSpeed"];
        const mps = num(attrs(absolute)["value"]);
        if (mps !== null) speedKph = round6(mps * MPS_TO_KPH);
      }
    }

    if (spawn) {
      byEntity.set(entityRef, { spawn_point: spawn, spawn_yaw: yaw, speed_kph: speedKph });
    }
  }
  return byEntity;
}

interface TrajectoryResult {
  mode: "path" | "timed_path";
  vertices: Array<{ point: XoscMapPoint; time: number | null }>;
}

function parseTrajectoryForEntity(
  storyboard: Record<string, unknown>,
): Map<string, TrajectoryResult> {
  const byEntity = new Map<string, TrajectoryResult>();
  for (const story of asArray(storyboard["Story"])) {
    for (const act of asArray((story as Record<string, unknown>)["Act"])) {
      for (const group of asArray((act as Record<string, unknown>)["ManeuverGroup"])) {
        const groupNode = group as Record<string, unknown>;
        const actorsNode = groupNode["Actors"] as Record<string, unknown> | undefined;
        const entityRef = str(attrs(asArray(actorsNode?.["EntityRef"])[0])["entityRef"]);
        if (!entityRef) continue;

        for (const maneuver of asArray(groupNode["Maneuver"])) {
          for (const event of asArray((maneuver as Record<string, unknown>)["Event"])) {
            for (const action of asArray((event as Record<string, unknown>)["Action"])) {
              // PrivateAction is forced to an array (isArray); find the one that
              // carries the RoutingAction/FollowTrajectoryAction.
              let follow: Record<string, unknown> | undefined;
              for (const pa of asArray((action as Record<string, unknown>)["PrivateAction"])) {
                const routing = (pa as Record<string, unknown>)["RoutingAction"] as
                  | Record<string, unknown>
                  | undefined;
                const candidate = routing?.["FollowTrajectoryAction"] as
                  | Record<string, unknown>
                  | undefined;
                if (candidate) {
                  follow = candidate;
                  break;
                }
              }
              if (!follow) continue;

              const trajectory = follow["Trajectory"] as Record<string, unknown> | undefined;
              const shape = trajectory?.["Shape"] as Record<string, unknown> | undefined;
              const polyline = shape?.["Polyline"] as Record<string, unknown> | undefined;
              if (!polyline) continue;

              const timeRef = follow["TimeReference"] as Record<string, unknown> | undefined;
              const isTimed = timeRef !== undefined && "Timing" in timeRef;

              const vertices: Array<{ point: XoscMapPoint; time: number | null }> = [];
              for (const vertex of asArray(polyline["Vertex"])) {
                const vNode = vertex as Record<string, unknown>;
                const { point } = worldPositionPoint(vNode["Position"], entityRef);
                const time = num(attrs(vNode)["time"]);
                vertices.push({ point, time });
              }
              if (vertices.length > 0) {
                byEntity.set(entityRef, {
                  mode: isTimed ? "timed_path" : "path",
                  vertices,
                });
              }
            }
          }
        }
      }
    }
  }
  return byEntity;
}

function parseDurationSeconds(storyboard: Record<string, unknown>): number | null {
  const stop = storyboard["StopTrigger"] as Record<string, unknown> | undefined;
  const group = stop?.["ConditionGroup"] as Record<string, unknown> | undefined;
  const condition = asArray(group?.["Condition"])[0] as Record<string, unknown> | undefined;
  const byValue = condition?.["ByValueCondition"] as Record<string, unknown> | undefined;
  const simTime = byValue?.["SimulationTimeCondition"];
  return num(attrs(simTime)["value"]);
}

/**
 * Parse an OpenSCENARIO 1.0 document (as produced by the in-house writer) back
 * into the native job_spec actor shape.
 */
export function parseXoscToActors(xml: string): XoscImportedScenario {
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new XoscImportError("empty or non-string xosc input");
  }
  const parsed = makeParser().parse(xml) as Record<string, unknown>;
  const root = parsed["OpenSCENARIO"] as Record<string, unknown> | undefined;
  if (!root) {
    throw new XoscImportError("document has no <OpenSCENARIO> root");
  }

  const header = root["FileHeader"];
  const description = str(attrs(header)["description"]) || null;

  const roadNetwork = root["RoadNetwork"] as Record<string, unknown> | undefined;
  const logicFileNode = roadNetwork?.["LogicFile"];
  const logicFile = str(attrs(logicFileNode)["filepath"]) || null;

  const entitiesNode = root["Entities"] as Record<string, unknown> | undefined;
  const storyboard = (root["Storyboard"] as Record<string, unknown> | undefined) ?? {};

  const initByEntity = parseInit(storyboard);
  const trajectoryByEntity = parseTrajectoryForEntity(storyboard);
  const durationSeconds = parseDurationSeconds(storyboard);

  const actors: XoscImportedActor[] = [];
  for (const obj of asArray(entitiesNode?.["ScenarioObject"])) {
    const objNode = obj as Record<string, unknown>;
    const id = str(attrs(objNode)["name"]);
    if (!id) continue;

    const vehicle = objNode["Vehicle"] as Record<string, unknown> | undefined;
    const pedestrian = objNode["Pedestrian"] as Record<string, unknown> | undefined;

    let kind: "vehicle" | "walker";
    let blueprint: string;
    let role: string | null;
    let stopAtStopLine: boolean | null;
    if (pedestrian) {
      kind = "walker";
      blueprint = str(attrs(pedestrian)["model"]) || str(attrs(pedestrian)["name"]);
      role = readRoleProperty(pedestrian);
      stopAtStopLine = readStopLineProperty(pedestrian);
    } else if (vehicle) {
      kind = "vehicle";
      blueprint = str(attrs(vehicle)["name"]);
      role = readRoleProperty(vehicle);
      stopAtStopLine = readStopLineProperty(vehicle);
    } else {
      // Unknown entity category — skip rather than fabricate motion.
      continue;
    }

    const init = initByEntity.get(id);
    if (!init) {
      throw new XoscImportError(`entity "${id}" has no Init spawn (TeleportAction)`, id);
    }

    const trajectory = trajectoryByEntity.get(id);
    let placement_mode: XoscImportedActor["placement_mode"] = "point";
    let path_placement: XoscMapPoint[] = [];
    let destination_point: XoscMapPoint | null = null;
    let timed_waypoints: XoscTimedWaypoint[] = [];

    if (trajectory && trajectory.mode === "path") {
      placement_mode = "path";
      const pts = trajectory.vertices.map((v) => v.point);
      // Writer folded [spawn, ...path_placement, destination] into one polyline.
      // The worker re-concatenates [spawn_point, ...path_placement,
      // destination_point] identically, so the split is behaviorally free — we
      // reconstruct spawn = pts[0], destination = pts[last], middle = between.
      if (pts.length >= 2) {
        destination_point = pts[pts.length - 1] ?? null;
        path_placement = pts.slice(1, -1);
      } else {
        path_placement = pts.slice(1);
      }
    } else if (trajectory && trajectory.mode === "timed_path") {
      placement_mode = "timed_path";
      timed_waypoints = trajectory.vertices.map((v, i) => {
        const wp: XoscTimedWaypoint = {
          x: v.point.x,
          y: v.point.y,
          time: v.time === null ? 0 : round6(v.time),
        };
        if (v.point.z !== undefined) wp.z = v.point.z;
        // Reconstruct the per-segment speed from position/time deltas: for a
        // Timing trajectory the speed is implicit in the timing, so this
        // recovers the speed the writer did not emit explicitly.
        if (i > 0) {
          const prev = trajectory.vertices[i - 1]!;
          const dt = wp.time - (prev.time === null ? 0 : prev.time);
          const dist = Math.hypot(v.point.x - prev.point.x, v.point.y - prev.point.y);
          if (dt > 0 && dist > 0) wp.speed_kph = round6((dist / dt) * MPS_TO_KPH);
        }
        return wp;
      });
    }

    actors.push({
      id,
      kind,
      role,
      stop_at_stop_line: stopAtStopLine,
      blueprint,
      placement_mode,
      spawn_point: init.spawn_point,
      spawn_yaw: init.spawn_yaw,
      speed_kph: init.speed_kph,
      path_placement,
      destination_point,
      timed_waypoints,
    });
  }

  return { description, logicFile, durationSeconds, actors };
}
