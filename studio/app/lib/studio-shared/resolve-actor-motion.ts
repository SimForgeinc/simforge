/**
 * The ONE answer to "where does this actor start, where can it go, what does it
 * do by default".
 *
 * ## Why this exists
 *
 * Before this, five independent implementations answered that question and
 * agreed only by coincidence (`plans/2026-07-29-authoring-paradigm-design.md`
 * §2): `baseActionForDraft` and `placementFieldsFromBaseClip` compiling in
 * opposite directions, the worker's corridor precedence, the browser engine's
 * `resolvePaths`, and the .xosc writer's `placementClip`. Every defect in that
 * audit was two of the five disagreeing.
 *
 * This module is the single derivation. Every consumer — preview engine, .xosc
 * writer, editor UI, traffic-rule backend, and eventually the worker — reads
 * `resolveActorMotion` and nothing else. Legacy fields remain compiled at the
 * runtime boundary, so the wire contract and the worker are untouched while
 * the authority moves.
 *
 * ## The precedence is the worker's, not the declaration's
 *
 * A draft can say `autopilot: true` and carry a route; CARLA drives the route
 * (`actor_control.py:378` + `:3235` disable autopilot whenever `route` is
 * non-empty). 257 stored actors are that shape. So the resolution order below is
 * copied from the executor of record rather than from what the draft claims,
 * which is also what makes the migration lossless: the answer is recoverable
 * from geometry even when the declaration was wrong.
 *
 *   prop / is_static     -> parked
 *   timed_waypoints      -> path  (schedule if walker or path_timing=schedule)
 *   path_placement       -> path  (ordering; polyline is spawn..path..destination)
 *   route                -> drive along the authored anchors
 *   autopilot            -> drive, runway derived from the lane graph
 *   else                 -> drive at the authored speed
 *
 * ## What it deliberately does NOT do
 *
 * It does not walk the lane graph. `deriveRunway` does that, and it needs a
 * semantic graph the browser and worker each fetch differently. This module is a
 * pure function of ONE actor draft, so it can run anywhere — in a test, in a
 * migration script, in the editor's render path — and callers supply geometry
 * when they have it.
 */

import { baseClip } from "./behavior-base-clip";
import type { RunwayTurnIntent } from "./semantic-map/derive-runway";
import type { BehaviorAction } from "./scenario-behavior";
import type {
  ScenarioEditorActorDraft,
  ScenarioEditorMapPoint,
  ScenarioEditorTimedWaypoint,
} from "./scenario-editor";

/** Why a vehicle point is allowed to sit off the lane graph. */
export type FreeReason = "parking_manoeuvre" | "against_lane" | "off_road" | "pedestrian";

export type MotionPointLock = { kind: "lane" } | { kind: "free"; reason: FreeReason };

export type MotionPoint = {
  x: number;
  y: number;
  z?: number;
  lock: MotionPointLock;
  /** Arrival time. Present only under `timing: "schedule"`. */
  time?: number;
  /** Per-segment speed. Present only under `timing: "ordering"`. */
  speed_kph?: number;
  direction?: "forward" | "reverse";
};

export type MotionPlacement =
  | { kind: "lane"; roadId: string; sFraction: number; point: ScenarioEditorMapPoint | null; yawDeg: number | null }
  | { kind: "world"; point: ScenarioEditorMapPoint; yawDeg: number | null };

export type MotionBaseline =
  /** Keep lane, go straight, at this speed. Points, when present, steer it. */
  | { kind: "drive"; speedKph: number; timing: "ordering" | "schedule" }
  /** Traverse the crossing on foot. */
  | { kind: "walk"; speedKph: number | null; timing: "ordering" | "schedule" }
  /** Never moves. */
  | { kind: "parked" };

export type ResolvedActorMotion = {
  placement: MotionPlacement | null;
  baseline: MotionBaseline;
  /**
   * The actor's own geometry, or null when its route is derived from the graph.
   *
   * Non-null for walker crossings and for vehicles still carrying an authored
   * polyline. A vehicle whose route is a list of lane-graph anchors resolves to
   * `null` here and `anchorHints` instead — the anchors are not the corridor,
   * they are a coarse statement of where it should pass.
   */
  corridor: { points: MotionPoint[] } | null;
  /**
   * World positions the authored route anchors named, in order.
   *
   * Kept separate from `corridor` because they are not a driveable polyline —
   * they are 1 to 32 sparse points the lane graph fills in between. Consumers
   * that need the driven geometry call `deriveRunway`; consumers checking
   * equivalence or drawing an overlay use these.
   */
  anchorHints: Array<{ x: number; y: number; z?: number; yawDeg: number | null }>;
  /** Turn intents the actor's clips ask for, in clip order. */
  turns: RunwayTurnIntent[];
  /** True when the runway has to come from the lane graph rather than the draft. */
  runwayIsDerived: boolean;
};

const DEFAULT_SPEED_KPH = 48.28032;

function finite(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function pointOf(raw: unknown): ScenarioEditorMapPoint | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const x = finite(record.x);
  const y = finite(record.y);
  if (x === null || y === null) return null;
  const z = finite(record.z);
  return z === null ? { x, y } : { x, y, z };
}

/** Where the actor starts. A lane anchor when it has one, else a world pose. */
function resolvePlacement(actor: ScenarioEditorActorDraft): MotionPlacement | null {
  const roadId = typeof actor.spawn?.road_id === "string" ? actor.spawn.road_id.trim() : "";
  const sFraction = finite(actor.spawn?.s_fraction);
  const world = pointOf(actor.spawn?.world_anchor);
  const worldYaw = finite((actor.spawn?.world_anchor as { yaw?: unknown } | undefined)?.yaw);
  const spawnPoint = pointOf(actor.spawn_point);
  const spawnYaw = finite(actor.spawn_yaw);

  // A road id AND an s fraction is a lane placement, whatever else is present:
  // that is the only shape the runtime's anchor authentication accepts
  // (`assertRoadActorsReferenceRuntimeOverlay`).
  if (roadId && sFraction !== null) {
    return {
      kind: "lane",
      roadId,
      sFraction,
      point: spawnPoint ?? world,
      yawDeg: spawnYaw ?? worldYaw,
    };
  }
  const point = spawnPoint ?? world;
  if (!point) return null;
  return { kind: "world", point, yawDeg: spawnYaw ?? worldYaw };
}

/**
 * Turn intents an actor's program asks for, in clip order.
 *
 * `turn_at_next_intersection` is the existing action kind; its payload names a
 * direction. Read in clip order rather than by trigger time because the
 * derivation consumes them one junction at a time, and a clip list is already
 * ordered by the authoring surface.
 */
export function resolveTurnIntents(actor: ScenarioEditorActorDraft): RunwayTurnIntent[] {
  const clips = actor.behavior?.clips ?? [];
  const intents: RunwayTurnIntent[] = [];
  for (const clip of clips) {
    if (clip.enabled === false) continue;
    const action = clip.action as { kind?: string; direction?: unknown; side?: unknown };
    if (action?.kind !== "turn_at_next_intersection") continue;
    const raw = String(action.direction ?? action.side ?? "").toLowerCase();
    if (raw === "left") intents.push("left");
    else if (raw === "right") intents.push("right");
    else if (raw === "u_turn" || raw === "uturn") intents.push("u_turn");
    else intents.push("straight");
  }
  return intents;
}

function waypointsToPoints(
  waypoints: readonly ScenarioEditorTimedWaypoint[],
  timing: "ordering" | "schedule",
  defaultReason: FreeReason,
): MotionPoint[] {
  return waypoints.flatMap((waypoint) => {
    const point = pointOf(waypoint);
    if (!point) return [];
    const lock: MotionPointLock =
      waypoint.snap === "lane" ? { kind: "lane" } : { kind: "free", reason: defaultReason };
    const speed = finite(waypoint.speed_kph);
    return [
      {
        ...point,
        lock,
        // T1/T2 of the plan: a time exists only under a schedule, a per-segment
        // speed only under ordering. Carrying both is what let the .xosc writer
        // emit an absolute-time trajectory for a polyline CARLA drove by arc
        // length.
        ...(timing === "schedule" ? { time: Math.max(0, waypoint.time) } : {}),
        ...(timing === "ordering" && speed !== null ? { speed_kph: speed } : {}),
        ...(waypoint.direction === "forward" || waypoint.direction === "reverse"
          ? { direction: waypoint.direction }
          : {}),
      },
    ];
  });
}

/**
 * Resolve one actor draft to the target model.
 *
 * Pure. Reads the legacy fields when the new ones are absent, which is every
 * stored draft today; prefers the new ones once generators write them.
 */
export function resolveActorMotion(actor: ScenarioEditorActorDraft): ResolvedActorMotion {
  const placement = resolvePlacement(actor);
  const turns = resolveTurnIntents(actor);
  const speedKph = finite(actor.speed_kph) ?? DEFAULT_SPEED_KPH;
  const isWalker = actor.kind === "walker";

  const parked = (): ResolvedActorMotion => ({
    placement,
    baseline: { kind: "parked" },
    corridor: null,
    anchorHints: [],
    turns: [],
    runwayIsDerived: false,
  });

  if (actor.kind === "prop" || actor.is_static === true) return parked();

  // "Parked" is a DECLARATION, not a geometric fact, and it is the one part of
  // the baseline geometry cannot recover: an actor with no polyline is either
  // driving straight or deliberately holding, and only the authored base clip
  // says which. Everything else below is derived from geometry precisely because
  // geometry is what the executor obeys.
  //
  // This also covers the pending points actor — `hold` with an empty waypoint
  // list, which is what a freshly armed drive-by-points car looks like before
  // its first click. Treating it as a driving actor would compile it to a road
  // placement and bounce the editor's own mode readout.
  const baseAction = actor.behavior ? baseClip(actor.behavior)?.action : undefined;
  if (baseAction?.kind === "hold") return parked();

  const timedWaypoints = actor.timed_waypoints ?? [];
  const pathPlacement = actor.path_placement ?? [];
  // An authored route has TWO homes: the actor's `route` field and a
  // `follow_route` base clip's own `anchors`. They are the same statement — "go
  // via these lane positions" — and seven corpus scenarios keep it only on the
  // clip, with `route` empty.
  //
  // Reading just `route` therefore reported those cars as having no authored
  // geometry at all, which made the migration think it had nothing to preserve
  // and the equivalence gate think there was nothing to compare. E6's u-turn
  // survived a "successful" migration with its out-and-back anchors still sitting
  // in the base clip. The clip's anchors come second so an actor carrying both
  // keeps `route` as the leading statement, which is the order the worker reads
  // them in.
  const baseClipAnchors =
    baseAction?.kind === "follow_route" && Array.isArray(baseAction.anchors)
      ? baseAction.anchors
      : [];
  const anchors = [...(actor.route ?? []), ...baseClipAnchors];

  // 1. An authored timed polyline. Walkers always schedule; a vehicle only if it
  //    opted in, which mirrors `actorPathTimingIsSchedule` exactly.
  if (timedWaypoints.length > 0) {
    const timing: "ordering" | "schedule" =
      isWalker || actor.path_timing === "schedule" ? "schedule" : "ordering";
    return {
      placement,
      baseline: isWalker
        ? { kind: "walk", speedKph: finite(actor.speed_kph), timing }
        : { kind: "drive", speedKph, timing },
      corridor: {
        points: waypointsToPoints(timedWaypoints, timing, isWalker ? "pedestrian" : "off_road"),
      },
      anchorHints: [],
      turns,
      runwayIsDerived: false,
    };
  }

  // 2. An authored untimed polyline. The worker's driven polyline is
  //    [spawn, ...path_placement, destination_point] — `route_geometry
  //    ._path_points_for_actor`, mirrored in `xosc/effective-motion.ts` — so the
  //    corridor has to be built the same way or the two disagree about where the
  //    car starts.
  if (pathPlacement.length > 0) {
    const spawn = placement?.point ?? null;
    const destination = pointOf(actor.destination_point);
    const raw = [
      ...(spawn ? [spawn] : []),
      ...pathPlacement,
      ...(destination ? [destination] : []),
    ];
    const points: MotionPoint[] = raw.flatMap((candidate) => {
      const point = pointOf(candidate);
      return point
        ? [{ ...point, lock: { kind: "free" as const, reason: "off_road" as FreeReason } }]
        : [];
    });
    return {
      placement,
      baseline: isWalker
        ? { kind: "walk", speedKph: finite(actor.speed_kph), timing: "ordering" }
        : { kind: "drive", speedKph, timing: "ordering" },
      corridor: { points },
      anchorHints: [],
      turns,
      runwayIsDerived: false,
    };
  }

  // 3. Authored lane-graph anchors. The anchors are a HINT, not the corridor —
  //    the lane graph fills in between them. Under the target model these become
  //    `turn` clips plus a derived runway; until the migration runs they are the
  //    only statement of where the car goes, so they are reported.
  const anchorHints = anchors.flatMap((anchor) => {
    const world = pointOf((anchor as { world_anchor?: unknown }).world_anchor);
    if (!world) return [];
    const yaw = finite((anchor as { world_anchor?: { yaw?: unknown } }).world_anchor?.yaw);
    return [{ ...world, yawDeg: yaw }];
  });

  // 4. A walker with no geometry is inert, and `hold` says so honestly rather
  //    than inventing a crossing the schema would reject.
  if (isWalker) return parked();

  return {
    placement,
    baseline: { kind: "drive", speedKph, timing: "ordering" },
    corridor: null,
    anchorHints,
    turns,
    // With no authored polyline the runway comes from the lane graph — whether
    // the draft said `autopilot`, said `cruise`, or carried anchors. That is the
    // single behavioural claim of this module and the one the equivalence
    // harness measures.
    runwayIsDerived: true,
  };
}

/**
 * The three baselines an author can choose between, and nothing else.
 *
 * `MotionBaseline` is the READ side — what an actor is doing, recovered from
 * whatever its draft happens to carry. This is the WRITE side: the closed set a
 * picker may offer. They are deliberately the same three words, because a
 * control that can express something the resolver cannot recover is a control
 * that can put an actor into a state the editor then misreads.
 *
 * Under the legacy schema each choice still lands on an old action kind
 * (`cruise` / `walk_path` / `hold`); Phase G renames those. What Phase C removes
 * is the CHOICE of `autopilot`, `follow_route` and `follow_path` — a vehicle's
 * route is derived from the lane graph, so there is nothing left to pick.
 */
export type BaselineChoice = "drive" | "walk" | "parked";

/** Which of the three an actor is on now. */
export function baselineChoice(actor: ScenarioEditorActorDraft): BaselineChoice {
  return resolveActorMotion(actor).baseline.kind;
}

/**
 * Whether an actor may be offered `drive`.
 *
 * A walker cannot drive and a prop cannot move, so for those the picker is not a
 * choice at all — which is the point of asking here rather than rendering three
 * buttons and validating afterwards.
 */
export function baselineChoicesFor(
  actor: ScenarioEditorActorDraft,
): readonly BaselineChoice[] {
  if (actor.kind === "prop") return ["parked"];
  if (actor.kind === "walker") return ["walk", "parked"];
  return ["drive", "parked"];
}

/**
 * The base-clip action a choice writes.
 *
 * `speedKph` is carried across a change of choice so switching Drive -> Parked
 * -> Drive does not silently reset the speed the author set. `walk` leaves speed
 * unset when none was given, because a walker with no authored speed uses the
 * engine's default gait and stamping one here would freeze that default into the
 * draft.
 *
 * A walker keeps its crossing: the polyline IS the walk, so `walk` on a walker
 * with no points yet resolves to `hold` — the same honest answer
 * `baseActionForDraft` gives, rather than an empty `waypoints` the schema
 * rejects at `min(1)`.
 */
export function baselineAction(
  choice: BaselineChoice,
  actor: ScenarioEditorActorDraft,
  speedKph: number | null,
): BehaviorAction {
  if (choice === "parked") return { kind: "hold" };
  if (choice === "walk") {
    const waypoints = actor.timed_waypoints ?? [];
    if (waypoints.length === 0) return { kind: "hold" };
    return {
      kind: "walk_path",
      waypoints: [...waypoints],
      ...(speedKph === null ? {} : { speed_kph: speedKph }),
    };
  }
  return { kind: "cruise", speed_kph: speedKph ?? DEFAULT_SPEED_KPH };
}
