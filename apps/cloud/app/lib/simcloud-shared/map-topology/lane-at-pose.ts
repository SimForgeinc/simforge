/**
 * "Which lane is this world point on?" — the missing inverse for every reader
 * that has a position but needs a lane id.
 *
 * The motivating case is the .xosc importer. The writer emits absolute world
 * positions and never `LanePosition` (road ids renumber across UE5 map
 * rebuilds), so an exported file carries no lane ids at all — and without them
 * a reader cannot tell the travel frame from the reference-line frame, which
 * is the difference between a left swerve and a right one. The topology index
 * has the missing half: sampled lane centerlines in the same runtime-world
 * metres the writer emits.
 *
 * ## Nearest centreline, and deliberately no heading gate
 *
 * The obvious refinement — reject lanes whose stored centreline runs opposite
 * to the entity's heading — is WRONG here, and measurably so. Positive-id lane
 * centrelines are stored against the direction of travel (the same convention
 * `laneFrameSign` exists for; measured 195/195 on Munich and 342/342 on
 * Belmont in the XODR, and confirmed independently in the topology index: both
 * Munich actors spawn at heading 163.0 deg on lanes whose polylines run at
 * -16.9 deg, a dot product of exactly -1.000). A naive heading gate therefore
 * throws away the correct lane and reaches for a distant one: on Munich it
 * picked a lane 93.59 m away with the WRONG SIGN, which is the one error that
 * actually matters.
 *
 * Measured over the five E7 campaign maps (10 actors, ground truth from each
 * authored draft's `spawn.lane_id`): nearest-centreline gets the lane SIGN
 * right 10/10; a naive heading gate 9/10; a heading gate corrected for the
 * convention 10/10 — i.e. identical to plain nearest, for more code. So the
 * heading is used only to REPORT disagreement (`headingAgrees`), never to
 * filter.
 *
 * ## What this is accurate to
 *
 * Lane SIGN, which is all `laneFrameSign` consumes, was exact on all ten. The
 * exact lane ORDINAL was right on nine: Richmond's B resolves to lane -1 at
 * 0.1005 m where its draft records -2. That is not necessarily a resolver
 * error — an authored `spawn.lane_id` and a current topology index can come
 * from different map builds, which is the very renumbering the writer's
 * world-position policy exists to dodge. Treat the ordinal as advisory and the
 * sign as reliable.
 */
import type {
  MapTopologyIndex,
  RuntimeBoundMapTopologyIndex,
  TopologyLane,
} from "./types";
import { laneTravelIncreasesS } from "./lane-travel";

export type PoseXY = {
  x: number;
  y: number;
  /** Degrees, runtime-world frame. Only used to report `headingAgrees`. */
  yawDeg?: number | null;
};

export type LaneAtPose = {
  /** `"<road>:<section>:<lane>"`. */
  rsl: string;
  laneId: number;
  roadId: number;
  /** Perpendicular distance from the pose to the lane centreline, metres. */
  distanceM: number;
  /**
   * Whether the pose's heading agrees with the lane's direction of travel,
   * after correcting for the reversed storage of positive-id centrelines.
   * `null` when no heading was supplied. A `false` here means the entity is
   * facing up a lane it should be driving down — worth surfacing, never worth
   * silently acting on.
   */
  headingAgrees: boolean | null;
};

/**
 * Metres. Beyond this a "nearest lane" is a guess, not a resolution — the
 * campaign's worst honest match was 0.1563 m (Richmond), and a spawn placed by
 * the editor sits on a centreline to within a millimetre.
 */
export const DEFAULT_MAX_LANE_DISTANCE_M = 3;

/**
 * Whether to read the +s tangent forwards or backwards to get TRAVEL heading.
 *
 * Resolved from CARLA's waypoint yaw when the caller passed a bound index;
 * only an unbound index falls through to the lane-id sign convention.
 */
function tangentSign(
  resolvedByRsl: RuntimeBoundMapTopologyIndex["laneTravelIncreasesS"],
  rsl: string,
  laneId: number,
): 1 | -1 {
  return laneTravelIncreasesS(resolvedByRsl, rsl, laneId) ? 1 : -1;
}

function isResolvable(lane: TopologyLane): boolean {
  return lane.laneType === "driving" && lane.polyline.length >= 2;
}

/**
 * The driving lane whose centreline passes closest to `pose`, or `null` when
 * nothing is within `maxDistanceM`.
 */
export function laneAtPose(
  index: Pick<MapTopologyIndex, "lanes"> &
    Partial<Pick<RuntimeBoundMapTopologyIndex, "laneTravelIncreasesS">>,
  pose: PoseXY,
  options: { maxDistanceM?: number } = {},
): LaneAtPose | null {
  const maxDistanceM = options.maxDistanceM ?? DEFAULT_MAX_LANE_DISTANCE_M;
  let best: (LaneAtPose & { tangent: { dx: number; dy: number } }) | null = null;

  for (const lane of Object.values(index.lanes)) {
    if (!isResolvable(lane)) continue;
    const line = lane.polyline;
    for (let i = 0; i + 1 < line.length; i += 1) {
      const a = line[i]!;
      const b = line[i + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((pose.x - a.x) * dx + (pose.y - a.y) * dy) / len2));
      const distanceM = Math.hypot(pose.x - (a.x + dx * t), pose.y - (a.y + dy * t));
      if (best !== null && distanceM >= best.distanceM) continue;
      best = {
        rsl: lane.rsl,
        laneId: lane.laneId,
        roadId: lane.roadId,
        distanceM,
        headingAgrees: null,
        tangent: { dx, dy },
      };
    }
  }

  if (best === null || best.distanceM > maxDistanceM) return null;

  let headingAgrees: boolean | null = null;
  if (pose.yawDeg != null && Number.isFinite(pose.yawDeg)) {
    const sign = tangentSign(index.laneTravelIncreasesS, best.rsl, best.laneId);
    const travel = Math.atan2(best.tangent.dy * sign, best.tangent.dx * sign);
    headingAgrees = Math.cos((pose.yawDeg * Math.PI) / 180 - travel) > 0;
  }
  return {
    rsl: best.rsl,
    laneId: best.laneId,
    roadId: best.roadId,
    distanceM: best.distanceM,
    headingAgrees,
  };
}
