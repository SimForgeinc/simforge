/**
 * "Worker-effective motion" — the behavior an actor_spec actually produces when
 * the CARLA worker drives it, reduced to a comparable canonical form.
 *
 * This is a faithful TS mirror of the worker's driven-polyline construction in
 * `services/carla-worker/carla_worker/route_geometry.py`:
 *   - path      -> `_path_points_for_actor`: [spawn_point, ...path_placement, destination_point]
 *   - timed_path -> `_timed_points_for_actor`: [{spawn, t:0}, ...timed_waypoints]
 * minus the CARLA road projection (`_project_frontend_point_to_road`), which is
 * applied identically to both sides of a round trip and therefore cancels.
 *
 * We use this — not field-by-field equality — as the definition of "OSC is
 * identical to our scenario format": the writer folds the authoring-time split
 * between `path_placement` and `destination_point` into a single trajectory
 * polyline, and the worker re-concatenates them into a single driven polyline,
 * so only the *effective trajectory* is behavior-defining. Comparing effective
 * motion is the honest property; comparing raw fields would flag a difference
 * (which slot a point lands in) that the executor cannot observe.
 */

export interface EffectiveMotionActorInput {
  kind?: string;
  placement_mode?: string | null;
  spawn_point?: { x: number; y: number; z?: number | null } | null;
  spawn_yaw?: number | null;
  speed_kph?: number | null;
  path_placement?: Array<{ x: number; y: number; z?: number | null }> | null;
  destination_point?: { x: number; y: number; z?: number | null } | null;
  timed_waypoints?: Array<{ x: number; y: number; z?: number | null; time: number }> | null;
}

export interface EffectivePoint {
  x: number;
  y: number;
}

export interface EffectiveTimedPoint {
  x: number;
  y: number;
  time: number;
}

export interface EffectiveMotion {
  kind: string;
  placement_mode: "path" | "timed_path" | "point";
  spawn: EffectivePoint;
  spawn_yaw: number;
  speed_kph: number;
  /** path / point modes: the driven polyline. Empty for timed_path. */
  polyline: EffectivePoint[];
  /** timed_path mode: the driven timed polyline. Empty otherwise. */
  timed: EffectiveTimedPoint[];
}

function round6(value: number): number {
  return Number(Number(value).toFixed(6));
}

function pt(p: { x: number; y: number }): EffectivePoint {
  return { x: round6(p.x), y: round6(p.y) };
}

/** Drop consecutive coincident points, mirroring the worker's `_dedupe_points`. */
function dedupe(points: EffectivePoint[]): EffectivePoint[] {
  const out: EffectivePoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  return out;
}

function dedupeTimed(points: EffectiveTimedPoint[]): EffectiveTimedPoint[] {
  const out: EffectiveTimedPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  return out;
}

/**
 * Reduce a native/imported actor to its worker-effective motion. Accepts both
 * a `ScenarioEditorActorDraft`-shaped object and an `XoscImportedActor` — they
 * share the field vocabulary the worker reads.
 */
export function computeEffectiveMotion(actor: EffectiveMotionActorInput): EffectiveMotion {
  const mode = String(actor.placement_mode ?? "point");
  const spawn = actor.spawn_point ? pt(actor.spawn_point) : { x: 0, y: 0 };
  const spawn_yaw = round6(Number(actor.spawn_yaw ?? 0));
  const speed_kph = round6(Number(actor.speed_kph ?? 0));
  const kind = String(actor.kind ?? "vehicle");

  if (mode === "timed_path") {
    const timed: EffectiveTimedPoint[] = [{ x: spawn.x, y: spawn.y, time: 0 }];
    for (const wp of actor.timed_waypoints ?? []) {
      timed.push({ x: round6(wp.x), y: round6(wp.y), time: round6(Math.max(0, wp.time)) });
    }
    return {
      kind,
      placement_mode: "timed_path",
      spawn,
      spawn_yaw,
      speed_kph,
      polyline: [],
      timed: dedupeTimed(timed),
    };
  }

  // path / point
  const polyPoints: EffectivePoint[] = [spawn];
  for (const p of actor.path_placement ?? []) polyPoints.push(pt(p));
  if (actor.destination_point) polyPoints.push(pt(actor.destination_point));
  const polyline = dedupe(polyPoints);
  // The worker treats a single-point path as `point` mode (spawn only).
  const placement_mode: EffectiveMotion["placement_mode"] =
    mode === "path" && polyline.length > 1 ? "path" : "point";

  return {
    kind,
    placement_mode,
    spawn,
    spawn_yaw,
    speed_kph,
    polyline,
    timed: [],
  };
}

export interface EffectiveMotionDiff {
  equal: boolean;
  reasons: string[];
}

export interface EffectiveMotionTolerance {
  /**
   * Position tolerance in meters. Positions round-trip exactly (the writer
   * serializes meters at 6 decimals and the parser reads them back at 6
   * decimals — no unit conversion), so the default is tight (1e-6 m = 1 micron).
   */
  position?: number;
  /**
   * Scalar tolerance for the unit-converted quantities (spawn_yaw in degrees,
   * speed_kph). These pass through the writer's 6-decimal quantization *in the
   * serialized unit* (radians, m/s), so the inverse conversion inflates the
   * quantization: yaw by 180/pi (~2.9e-5 deg) and speed by 3.6 (~3.6e-6 kph).
   * The default (1e-3) sits comfortably above that ceiling while remaining
   * physically meaningless (1e-3 deg, 1e-3 kph = 2.8e-7 m/s).
   */
  scalar?: number;
}

/**
 * Compare two effective motions. Positions use a tight tolerance (they
 * round-trip exactly); the unit-converted scalars (yaw, speed) use a looser but
 * still physically-negligible tolerance that absorbs the writer's serialized
 * 6-decimal quantization. Returns the specific reasons on mismatch so a failing
 * round-trip test points at the exact divergence.
 */
export function diffEffectiveMotion(
  a: EffectiveMotion,
  b: EffectiveMotion,
  tolerance: EffectiveMotionTolerance = {},
): EffectiveMotionDiff {
  const posTol = tolerance.position ?? 1e-6;
  const scalarTol = tolerance.scalar ?? 1e-3;
  const reasons: string[] = [];
  const nearPos = (x: number, y: number) => Math.abs(x - y) <= posTol;
  const nearScalar = (x: number, y: number) => Math.abs(x - y) <= scalarTol;

  if (a.kind !== b.kind) reasons.push(`kind: ${a.kind} != ${b.kind}`);
  if (a.placement_mode !== b.placement_mode)
    reasons.push(`placement_mode: ${a.placement_mode} != ${b.placement_mode}`);
  if (!nearPos(a.spawn.x, b.spawn.x) || !nearPos(a.spawn.y, b.spawn.y))
    reasons.push(`spawn: (${a.spawn.x},${a.spawn.y}) != (${b.spawn.x},${b.spawn.y})`);
  if (!nearScalar(a.spawn_yaw, b.spawn_yaw))
    reasons.push(`spawn_yaw: ${a.spawn_yaw} != ${b.spawn_yaw}`);
  if (!nearScalar(a.speed_kph, b.speed_kph))
    reasons.push(`speed_kph: ${a.speed_kph} != ${b.speed_kph}`);

  if (a.polyline.length !== b.polyline.length) {
    reasons.push(`polyline length: ${a.polyline.length} != ${b.polyline.length}`);
  } else {
    for (let i = 0; i < a.polyline.length; i++) {
      if (!nearPos(a.polyline[i]!.x, b.polyline[i]!.x) || !nearPos(a.polyline[i]!.y, b.polyline[i]!.y)) {
        reasons.push(
          `polyline[${i}]: (${a.polyline[i]!.x},${a.polyline[i]!.y}) != (${b.polyline[i]!.x},${b.polyline[i]!.y})`,
        );
      }
    }
  }

  if (a.timed.length !== b.timed.length) {
    reasons.push(`timed length: ${a.timed.length} != ${b.timed.length}`);
  } else {
    for (let i = 0; i < a.timed.length; i++) {
      if (
        !nearPos(a.timed[i]!.x, b.timed[i]!.x) ||
        !nearPos(a.timed[i]!.y, b.timed[i]!.y) ||
        !nearPos(a.timed[i]!.time, b.timed[i]!.time)
      ) {
        reasons.push(`timed[${i}] mismatch`);
      }
    }
  }

  return { equal: reasons.length === 0, reasons };
}
