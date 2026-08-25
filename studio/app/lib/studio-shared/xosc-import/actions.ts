/**
 * `<PrivateAction>` → `BehaviorAction`.
 *
 * The inverse of `xosc-writer/actions.ts`. Reading is a two-stage job because
 * one authored action can become two `<PrivateAction>`s: the file is first
 * read into the flat `ReadPrivateAction` union (a faithful description of what
 * the XML says), and `composeAction` then folds an event's list back into the
 * single `BehaviorAction` that produced it.
 *
 * ## Where the fold is many-to-one
 *
 * The writer's vocabulary is smaller than the behavior vocabulary, so several
 * authored actions share an emission and cannot be told apart on the way back.
 * Every one of them is listed in the module doc of `index.ts` and reported as
 * an `imported_approximation`; none of them changes what a re-export produces,
 * which is why the round-trip is still byte-exact:
 *
 * * `follow_route` / `turn_at_next_intersection` → both an untimed
 *   `FollowTrajectoryAction`, both import as `follow_path {timed: false}`.
 * * `intercept` → a `SpeedAction` + `AcquirePositionAction`, exactly what a
 *   `go_to` with a speed emits; imports as `go_to`.
 * * `cruise {speed_kph: 0}` → a linear ramp to zero, exactly what `stop
 *   {deceleration_mps2: 3}` emits; imports as `stop`.
 * * `cut_in` with no `gap_m` → a bare `LaneChangeAction`; imports as
 *   `lane_change`. With a gap it is recoverable, because the gap rides on the
 *   start trigger as a named condition.
 */

import { laneFrameSign } from "../scenario-behavior";
import type {
  BehaviorAction,
  BehaviorActorRef,
  BehaviorWaypoint,
} from "../scenario-behavior";
import {
  attrNumber,
  attrString,
  childEl,
  childrenEl,
  descendantEl,
  type XmlElement,
} from "../xosc/xml-dom";

/** The writer's comfortable ramp for an unqualified speed change (m/s²). */
const DEFAULT_SPEED_RATE_MPS2 = 3;
/** The writer's ramp for `creep` and `reverse`. */
const SLOW_SPEED_RATE_MPS2 = 1;

export type ReadSpeedDynamics =
  | { shape: "step" }
  | { shape: "linear"; dimension: "rate" | "time"; value: number };

export type ReadPrivateAction =
  | { kind: "teleport"; x: number; y: number; z: number; headingRad: number }
  | { kind: "speed"; targetMps: number; dynamics: ReadSpeedDynamics }
  /** `laneDelta` is the RelativeTargetLane value, i.e. reference-line frame. */
  | { kind: "lane_change"; laneDelta: number; transitionM: number }
  | { kind: "lane_offset"; offsetM: number }
  | {
      kind: "trajectory";
      timed: boolean;
      points: Array<{ x: number; y: number; z: number; time: number }>;
    }
  | { kind: "acquire"; x: number; y: number; z: number }
  | { kind: "unsupported"; element: string };

function readWorldPosition(
  position: XmlElement | null,
): { x: number; y: number; z: number; headingRad: number } | null {
  const world = childEl(position, "WorldPosition");
  if (!world) return null;
  const x = attrNumber(world, "x");
  const y = attrNumber(world, "y");
  if (x === null || y === null) return null;
  return {
    x,
    y,
    z: attrNumber(world, "z") ?? 0,
    headingRad: attrNumber(world, "h") ?? 0,
  };
}

function readSpeed(speedAction: XmlElement): ReadPrivateAction | null {
  const target = descendantEl(speedAction, "SpeedActionTarget", "AbsoluteTargetSpeed");
  const targetMps = attrNumber(target, "value");
  if (targetMps === null) return null;
  const dynamicsEl = childEl(speedAction, "SpeedActionDynamics");
  const shape = attrString(dynamicsEl, "dynamicsShape");
  if (shape === "step") return { kind: "speed", targetMps, dynamics: { shape: "step" } };
  const dimension = attrString(dynamicsEl, "dynamicsDimension");
  const value = attrNumber(dynamicsEl, "value");
  if ((dimension !== "rate" && dimension !== "time") || value === null) return null;
  return { kind: "speed", targetMps, dynamics: { shape: "linear", dimension, value } };
}

function readTrajectory(followTrajectory: XmlElement): ReadPrivateAction {
  const polyline = descendantEl(followTrajectory, "Trajectory", "Shape", "Polyline");
  const points: Array<{ x: number; y: number; z: number; time: number }> = [];
  for (const vertex of childrenEl(polyline, "Vertex")) {
    const pose = readWorldPosition(childEl(vertex, "Position"));
    if (!pose) continue;
    points.push({ x: pose.x, y: pose.y, z: pose.z, time: attrNumber(vertex, "time") ?? 0 });
  }
  // `TimeReference/None` is the writer's "ordering only"; a `Timing` child is a
  // real schedule. Anything else (an OSC 1.1 relative timing, say) is read as
  // untimed, which is the conservative reading: it drops a schedule we cannot
  // trust rather than inventing arrival times.
  const timeReference = childEl(followTrajectory, "TimeReference");
  const timed = childEl(timeReference, "Timing") !== null;
  return { kind: "trajectory", timed, points };
}

/** Read one `<PrivateAction>` element into the flat union. */
export function readPrivateAction(privateAction: XmlElement): ReadPrivateAction {
  const teleport = childEl(privateAction, "TeleportAction");
  if (teleport) {
    const pose = readWorldPosition(childEl(teleport, "Position"));
    if (pose) return { kind: "teleport", ...pose };
    return { kind: "unsupported", element: "TeleportAction" };
  }

  const longitudinal = childEl(privateAction, "LongitudinalAction");
  if (longitudinal) {
    const speedAction = childEl(longitudinal, "SpeedAction");
    if (speedAction) {
      const read = readSpeed(speedAction);
      if (read) return read;
    }
    return { kind: "unsupported", element: longitudinal.children[0]?.name ?? "LongitudinalAction" };
  }

  const lateral = childEl(privateAction, "LateralAction");
  if (lateral) {
    const laneChange = childEl(lateral, "LaneChangeAction");
    if (laneChange) {
      const relative = descendantEl(laneChange, "LaneChangeTarget", "RelativeTargetLane");
      const delta = attrNumber(relative, "value");
      const transitionM = attrNumber(childEl(laneChange, "LaneChangeActionDynamics"), "value");
      if (delta !== null && transitionM !== null) {
        // Which SIDE this is depends on the actor's lane sign, which is not
        // readable here — `composeAction` turns it into a direction.
        return { kind: "lane_change", laneDelta: delta, transitionM };
      }
      return { kind: "unsupported", element: "LaneChangeAction" };
    }
    const laneOffset = childEl(lateral, "LaneOffsetAction");
    if (laneOffset) {
      const offsetM = attrNumber(
        descendantEl(laneOffset, "LaneOffsetTarget", "AbsoluteTargetLaneOffset"),
        "value",
      );
      if (offsetM !== null) return { kind: "lane_offset", offsetM };
      return { kind: "unsupported", element: "LaneOffsetAction" };
    }
    return { kind: "unsupported", element: lateral.children[0]?.name ?? "LateralAction" };
  }

  const routing = childEl(privateAction, "RoutingAction");
  if (routing) {
    const followTrajectory = childEl(routing, "FollowTrajectoryAction");
    if (followTrajectory) return readTrajectory(followTrajectory);
    const acquire = childEl(routing, "AcquirePositionAction");
    if (acquire) {
      const pose = readWorldPosition(childEl(acquire, "Position"));
      if (pose) return { kind: "acquire", x: pose.x, y: pose.y, z: pose.z };
      return { kind: "unsupported", element: "AcquirePositionAction" };
    }
    return { kind: "unsupported", element: routing.children[0]?.name ?? "RoutingAction" };
  }

  return { kind: "unsupported", element: privateAction.children[0]?.name ?? "PrivateAction" };
}

const MPS_TO_KPH = 3.6;

/** A lone `SpeedAction` as the longitudinal action that produced it. */
function speedToAction(
  action: Extract<ReadPrivateAction, { kind: "speed" }>,
): { action: BehaviorAction; approximation: string | null } {
  const kph = action.targetMps * MPS_TO_KPH;
  if (action.dynamics.shape === "step") {
    if (action.targetMps === 0) return { action: { kind: "hold" }, approximation: null };
    return {
      action: { kind: "cruise", speed_kph: kph },
      approximation:
        "a stepped speed change is only ever emitted for `hold`; this one has a non-zero target and imports as a cruise, which re-exports as a ramp",
    };
  }
  const { dimension, value } = action.dynamics;
  if (action.targetMps === 0) {
    // The writer picks the dimension from which knob the author set, so this
    // half of the inversion is exact.
    return {
      action:
        dimension === "rate"
          ? { kind: "stop", deceleration_mps2: value }
          : { kind: "stop", decel_window_s: value },
      approximation: null,
    };
  }
  if (action.targetMps < 0) {
    // A negative absolute target is how OSC says "travel opposite the heading".
    return { action: { kind: "reverse", speed_kph: -kph }, approximation: null };
  }
  if (dimension === "rate" && value === SLOW_SPEED_RATE_MPS2) {
    return { action: { kind: "creep", speed_kph: kph }, approximation: null };
  }
  return {
    action: { kind: "cruise", speed_kph: kph },
    approximation:
      dimension === "rate" && value === DEFAULT_SPEED_RATE_MPS2
        ? null
        : `a ${value} ${dimension === "rate" ? "m/s²" : "s"} speed ramp is outside the writer's vocabulary; it imports as a cruise and re-exports at the default ${DEFAULT_SPEED_RATE_MPS2} m/s² rate`,
  };
}

function waypointsFrom(
  points: ReadonlyArray<{ x: number; y: number; z: number; time: number }>,
  timed: boolean,
): BehaviorWaypoint[] {
  return points.map((point) => ({
    x: point.x,
    y: point.y,
    z: point.z,
    ...(timed ? { time: point.time } : {}),
  }));
}

export type ComposeContext = {
  /** Walkers get `walk_path`, everything else `follow_path`. */
  isWalker: boolean;
  /** The target of a `_cutin_gap` condition, when the start trigger had one. */
  cutInGap: { actorRef: BehaviorActorRef; gapM: number } | null;
  /** Set by a `_offset_return` follow-up event that belongs to this clip. */
  returnAfterS: number | null;
  /**
   * The OpenDRIVE lane the entity starts on, or `null` when the caller could
   * not supply one. Lateral values in the file are in the lane reference-line
   * frame and the behavior schema's are travel-relative; `laneFrameSign` maps
   * between them, and on a positive-id lane the two disagree. With `null` the
   * value passes through unconverted and an approximation is reported.
   */
  selfLaneId: number | null;
};

export type ComposedAction = {
  action: BehaviorAction | null;
  /** Documented lossy folds, one sentence each, for the diagnostics channel. */
  approximations: string[];
  /** `<PrivateAction>` subtrees this importer has no inverse for. */
  unsupported: string[];
};

/**
 * A lateral value read from the file is in the lane reference-line frame; the
 * behavior schema's is travel-relative. Without the entity's lane the importer
 * cannot tell them apart, and on a positive-id lane they are mirror images —
 * so say so rather than silently guessing right half the time.
 */
function noteUnknownLaneFrame(context: ComposeContext, approximations: string[]): void {
  if (context.selfLaneId !== null) return;
  approximations.push(
    "the entity's lane is unknown to this import, so the lateral value was read as travel-relative; " +
      "on a positive-id (left-side) lane the authored side is mirrored — pass `mapTopology` to resolve it " +
      "from the spawn position, or `laneIdByEntity` if the ids are already known",
  );
}

/** Travel-relative side for a RelativeTargetLane value. */
function lateralSide(
  laneDelta: number,
  context: ComposeContext,
  approximations: string[],
): "left" | "right" {
  noteUnknownLaneFrame(context, approximations);
  return laneDelta * laneFrameSign(context.selfLaneId) >= 0 ? "left" : "right";
}

/**
 * Fold one `<Event>`'s private actions back into the single authored action.
 *
 * An `<Action>` element holds exactly one `<PrivateAction>`, so a maneuver that
 * needed two (an `AcquirePositionAction` plus the speed to travel at) arrives
 * here as two entries in `read` and leaves as one `BehaviorAction`.
 */
export function composeAction(
  read: readonly ReadPrivateAction[],
  context: ComposeContext,
): ComposedAction {
  const approximations: string[] = [];
  const unsupported: string[] = [];
  const usable: ReadPrivateAction[] = [];
  for (const entry of read) {
    if (entry.kind === "unsupported") unsupported.push(entry.element);
    else usable.push(entry);
  }
  if (usable.length === 0) return { action: null, approximations, unsupported };

  const speed = usable.find(
    (entry): entry is Extract<ReadPrivateAction, { kind: "speed" }> => entry.kind === "speed",
  );
  const trajectory = usable.find(
    (entry): entry is Extract<ReadPrivateAction, { kind: "trajectory" }> =>
      entry.kind === "trajectory",
  );
  const acquire = usable.find(
    (entry): entry is Extract<ReadPrivateAction, { kind: "acquire" }> =>
      entry.kind === "acquire",
  );
  const laneChange = usable.find(
    (entry): entry is Extract<ReadPrivateAction, { kind: "lane_change" }> =>
      entry.kind === "lane_change",
  );
  const laneOffset = usable.find(
    (entry): entry is Extract<ReadPrivateAction, { kind: "lane_offset" }> =>
      entry.kind === "lane_offset",
  );

  if (trajectory) {
    const speedKph = speed ? speed.targetMps * MPS_TO_KPH : null;
    if (context.isWalker) {
      if (speedKph !== null) {
        approximations.push(
          "a walker's schedule already fixes its speed, so the speed action beside its trajectory is not carried onto the walk_path clip",
        );
      }
      return {
        action: { kind: "walk_path", waypoints: waypointsFrom(trajectory.points, true) },
        approximations,
        unsupported,
      };
    }
    if (!trajectory.timed) {
      approximations.push(
        "an untimed trajectory is what both `follow_route` and `turn_at_next_intersection` compile to; it imports as `follow_path` over the same world polyline",
      );
    }
    return {
      action: {
        kind: "follow_path",
        waypoints: waypointsFrom(trajectory.points, trajectory.timed),
        timed: trajectory.timed,
        ...(speedKph === null ? {} : { speed_kph: speedKph }),
      },
      approximations,
      unsupported,
    };
  }

  if (acquire) {
    approximations.push(
      "an acquire-position with a speed is what `intercept` compiles to as well; it imports as `go_to` at the target's start position",
    );
    return {
      action: {
        kind: "go_to",
        point: { x: acquire.x, y: acquire.y, z: acquire.z },
        ...(speed === undefined ? {} : { speed_kph: speed.targetMps * MPS_TO_KPH }),
      },
      approximations,
      unsupported,
    };
  }

  if (laneChange) {
    const side = lateralSide(laneChange.laneDelta, context, approximations);
    if (context.cutInGap) {
      return {
        action: {
          kind: "cut_in",
          actor: context.cutInGap.actorRef,
          side,
          gap_m: context.cutInGap.gapM,
          transition_m: laneChange.transitionM,
        },
        approximations,
        unsupported,
      };
    }
    approximations.push(
      "a bare lane change is also what a `cut_in` with no gap compiles to; it imports as `lane_change`, and the transition distance is explicit even if the author left it defaulted",
    );
    return {
      action: {
        kind: "lane_change",
        direction: side,
        transition_m: laneChange.transitionM,
      },
      approximations,
      unsupported,
    };
  }

  if (laneOffset) {
    approximations.push(
      "a lane offset's authored `transition_m` is not emitted by the writer and cannot come back",
    );
    noteUnknownLaneFrame(context, approximations);
    return {
      action: {
        kind: "lane_offset",
        offset_m: laneOffset.offsetM * laneFrameSign(context.selfLaneId),
        ...(context.returnAfterS === null ? {} : { return_after_s: context.returnAfterS }),
      },
      approximations,
      unsupported,
    };
  }

  if (speed) {
    const composed = speedToAction(speed);
    if (composed.approximation) approximations.push(composed.approximation);
    return { action: composed.action, approximations, unsupported };
  }

  return { action: null, approximations, unsupported };
}
