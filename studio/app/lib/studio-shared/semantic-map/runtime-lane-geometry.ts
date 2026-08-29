import type {
  RuntimeBoundMapTopologyIndex,
  TopologyLane,
} from "@simforge-oss/maps/topology";
import {
  laneTravelIncreasesS,
  travelOrderedPolyline,
} from "@simforge-oss/maps/topology";
import type {
  RuntimeBoundLaneGeometry,
  SemanticMapPoint,
} from "./types";
import { quantizePoint } from "./geometry";

export function laneWidth(
  lane: TopologyLane,
  runtimeGeometry: RuntimeBoundLaneGeometry | undefined,
): number | null {
  return runtimeGeometry?.representativeWidthM ?? lane.representativeWidthM ?? null;
}

/** A runtime end is the same curve as the XODR lane within this much. */
const SPLICE_LATERAL_AGREEMENT_M = 0.5;

/** Below this the crawl reached the lane end and there is nothing to splice. */
const SPLICE_EPSILON_M = 0.05;

/** A splice must continue the crawl, not turn away onto a malformed XODR tail. */
const SPLICE_HEADING_AGREEMENT_RAD = Math.PI / 6;

type Projection = { stationM: number; lateralM: number };

/** Where `point` falls along `polyline`: arc-length station and offset from it. */
function project(
  polyline: readonly { x: number; y: number }[],
  point: { x: number; y: number },
): Projection {
  let station = 0;
  let best: Projection = { stationM: 0, lateralM: Number.POSITIVE_INFINITY };
  for (let index = 0; index + 1 < polyline.length; index += 1) {
    const from = polyline[index]!;
    const to = polyline[index + 1]!;
    const spanX = to.x - from.x;
    const spanY = to.y - from.y;
    const lengthSquared = spanX * spanX + spanY * spanY;
    const raw =
      lengthSquared === 0
        ? 0
        : ((point.x - from.x) * spanX + (point.y - from.y) * spanY) / lengthSquared;
    const t = Math.min(1, Math.max(0, raw));
    const lateralM = Math.hypot(from.x + t * spanX - point.x, from.y + t * spanY - point.y);
    const length = Math.sqrt(lengthSquared);
    if (lateralM < best.lateralM) best = { stationM: station + t * length, lateralM };
    station += length;
  }
  return best;
}

function heading(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function headingsAgree(left: number, right: number): boolean {
  let delta = right - left;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return Math.abs(delta) <= SPLICE_HEADING_AGREEMENT_RAD;
}

/**
 * The runtime centreline, with the stretches CARLA's crawl never sampled filled
 * in from the lane's own XODR vertices.
 *
 * ## Why a lane arrives short
 *
 * `road_segments[].centerline` is a waypoint crawl: CARLA steps along the lane
 * at a fixed interval and stops at the last whole step, so the geometry ends
 * BEFORE the lane does. Measured on Yale Street, 2026-07-29, all 617 crawled
 * lanes: the runtime vertices sit on the XODR lane to within 0.002 m laterally
 * (so it is the same curve, sampled), the first vertex is at station 0.000, and
 * the last is at 0.899 of the lane by median — median 89 % of the lane length,
 * p10 70 %.
 *
 * Every junction seam then inherits the missing tail as a manufactured gap of a
 * few metres. Against the 3 m seam limit that was the larger of the two
 * connectivity blockers: 200 of Yale's 281 movement variants carried
 * `GATE_GEOMETRY_DISCONTINUITY` and only 29.4 % of authorable corridors had an
 * authorable way out. Splicing the unsampled ends back takes those to 28 and
 * 74.8 % with no other change (`plans/2026-07-29-one-motion-model.md` §6.1).
 *
 * ## The same sampling step has a second victim
 *
 * This function fixes lanes the crawl sampled SHORT. It cannot help a lane the
 * crawl skipped ENTIRELY, which is what happens to a lane-section shorter than
 * the step — no waypoint falls inside it, so it appears in no segment, and every
 * junction gate naming it fails to bind. On Di Rosa every one of the 42 such
 * driving lanes is under 5.9 m and every sampled one is over 5.3 m; one of them,
 * a 1.6 m stub, was the whole reason a keep-lane ego stopped inside an
 * intersection. That half is handled in `build-runtime-parity.ts` by binding
 * lanes CARLA's own links attest to. Both fixes are the same root cause seen
 * from two sides, so a change to the crawl's sampling interval should be
 * measured against both.
 *
 * Spliced from the lane's own vertices rather than a straight chord to its
 * endpoint, so the reconstructed piece keeps the XODR's curvature. `z` is held
 * at the runtime end's elevation: the piece is metres long, and nulling it
 * instead would silently switch off the seam elevation check.
 *
 * An end whose runtime vertex does NOT agree laterally with the lane is left
 * alone — that is a different curve, not a short sample, and the seam gate
 * should report it rather than have this paper over it.
 */
function spliceUnsampledEnds(
  runtimePoints: readonly SemanticMapPoint[],
  lanePoints: readonly { x: number; y: number }[],
): readonly SemanticMapPoint[] {
  if (runtimePoints.length < 2 || lanePoints.length < 2) return runtimePoints;
  const first = runtimePoints[0]!;
  const last = runtimePoints[runtimePoints.length - 1]!;
  const head = project(lanePoints, first);
  const tail = project(lanePoints, last);
  const spliced: SemanticMapPoint[] = [];
  let station = 0;
  const stations = lanePoints.map((point, index) => {
    const previous = lanePoints[index - 1];
    if (previous) station += Math.hypot(point.x - previous.x, point.y - previous.y);
    return station;
  });
  const laneLengthM = stations[stations.length - 1]!;
  const headExtension = lanePoints.filter(
    (_, index) => stations[index]! < head.stationM - SPLICE_EPSILON_M,
  );
  const tailExtension = lanePoints.filter(
    (_, index) => stations[index]! > tail.stationM + SPLICE_EPSILON_M,
  );
  const headContinues =
    headExtension.length === 0 ||
    headingsAgree(
      heading(runtimePoints[0]!, runtimePoints[1]!),
      heading(headExtension[headExtension.length - 1]!, runtimePoints[0]!),
    );
  const tailContinues =
    tailExtension.length === 0 ||
    headingsAgree(
      heading(runtimePoints[runtimePoints.length - 2]!, last),
      heading(last, tailExtension[0]!),
    );

  if (
    head.lateralM <= SPLICE_LATERAL_AGREEMENT_M &&
    head.stationM > SPLICE_EPSILON_M &&
    headContinues
  ) {
    for (const point of headExtension) {
      spliced.push({ x: point.x, y: point.y, z: first.z });
    }
  }
  spliced.push(...runtimePoints);
  if (
    tail.lateralM <= SPLICE_LATERAL_AGREEMENT_M &&
    laneLengthM - tail.stationM > SPLICE_EPSILON_M &&
    tailContinues
  ) {
    for (const point of tailExtension) {
      spliced.push({ x: point.x, y: point.y, z: last.z });
    }
  }
  return spliced;
}

/**
 * Runtime geometry for the lanes the crawl never sampled but its links attest.
 *
 * A link-attested lane has no crawl entry, so `lanePolyline` falls back to its
 * OpenDRIVE vertices — which carry no `z`, because elevation is the one thing the
 * XODR index does not keep. That silence is not free. `buildApproaches` treats a
 * cluster containing a null-`z` corridor as `APPROACH_ELEVATION_AMBIGUOUS`, since
 * without elevation it cannot tell parallel lanes from stacked ones, and demotes
 * the whole approach — and with it every movement through it. Di Rosa's ego hit
 * exactly that: the gate bound, the variant compiled clean with no diagnostic
 * codes of its own, and the approach still refused it.
 *
 * The lane is metres long and sits between two lanes the crawl DID sample, so its
 * elevation is not a guess: interpolate along it from the predecessor's exit
 * height to the successor's entry height. With only one neighbour available, hold
 * that neighbour's height flat, which over a sub-6 m stub is well inside the 1.5 m
 * the elevation checks care about.
 *
 * Returns a NEW record rather than mutating the caller's, so the crawl's own
 * measurements are never overwritten by an inference.
 */
export function withLinkAttestedGeometry(
  lanes: Record<string, TopologyLane>,
  runtimeLaneGeometry: Record<string, RuntimeBoundLaneGeometry>,
  linkAttestedRsls: Iterable<string>,
): Record<string, RuntimeBoundLaneGeometry> {
  const augmented = { ...runtimeLaneGeometry };
  const endZ = (rsl: string, end: "first" | "last"): number | null => {
    const points = runtimeLaneGeometry[rsl]?.polyline;
    if (!points || points.length === 0) return null;
    const point = end === "first" ? points[0]! : points[points.length - 1]!;
    return typeof point.z === "number" && Number.isFinite(point.z) ? point.z : null;
  };

  for (const rsl of linkAttestedRsls) {
    const lane = lanes[rsl];
    if (!lane || lane.polyline.length < 2 || runtimeLaneGeometry[rsl]) continue;

    // The crawl stores lanes in `+s` order, and so does `lane.polyline`, so the
    // predecessor meets this lane's FIRST vertex and the successor its LAST
    // regardless of which way the lane is driven.
    let startZ: number | null = null;
    for (const predecessor of lane.predecessors) {
      startZ = endZ(predecessor, "last") ?? endZ(predecessor, "first");
      if (startZ !== null) break;
    }
    let finishZ: number | null = null;
    for (const successor of lane.successors) {
      finishZ = endZ(successor, "first") ?? endZ(successor, "last");
      if (finishZ !== null) break;
    }
    const from = startZ ?? finishZ;
    const to = finishZ ?? startZ;
    if (from === null || to === null) continue;

    const stations: number[] = [0];
    for (let index = 1; index < lane.polyline.length; index += 1) {
      stations.push(
        stations[index - 1]! +
          Math.hypot(
            lane.polyline[index]!.x - lane.polyline[index - 1]!.x,
            lane.polyline[index]!.y - lane.polyline[index - 1]!.y,
          ),
      );
    }
    const total = stations[stations.length - 1]!;
    augmented[rsl] = {
      rsl,
      storedOrder: "road_s",
      representativeWidthM: lane.representativeWidthM ?? null,
      polyline: lane.polyline.map((point, index) => ({
        x: point.x,
        y: point.y,
        z: total > 0 ? from + ((to - from) * stations[index]!) / total : from,
      })),
    };
  }
  return augmented;
}

/**
 * The lane's centreline in the order it is DRIVEN.
 *
 * `storedOrder: "travel"` means the source is already travel-ordered and needs
 * no flip. Otherwise the source is in `+s` order and the direction decides —
 * taken from CARLA's resolved answer when the caller passed a bound index, and
 * only otherwise from the lane-id sign convention.
 *
 * A `road_s` runtime source is also completed against the lane's XODR vertices
 * first: the crawl stops short of the lane end, and the difference is what broke
 * junction seams (`spliceUnsampledEnds`). Both are in `+s` order at that point,
 * which is what makes the comparison legitimate; a `travel`-ordered source is
 * returned as it stands.
 */
export function lanePolyline(
  lane: TopologyLane,
  runtimeLaneGeometry: Record<string, RuntimeBoundLaneGeometry>,
  resolvedTravelByRsl?: RuntimeBoundMapTopologyIndex["laneTravelIncreasesS"],
): SemanticMapPoint[] {
  const runtime = runtimeLaneGeometry[lane.rsl];
  const source = runtime
    ? runtime.storedOrder === "travel"
      ? runtime.polyline
      : spliceUnsampledEnds(runtime.polyline, lane.polyline)
    : lane.polyline.map((point) => ({ ...point, z: null }));
  const points = source.map(quantizePoint);
  if (runtime?.storedOrder === "travel") return points;
  return travelOrderedPolyline(
    points,
    laneTravelIncreasesS(resolvedTravelByRsl, lane.rsl, lane.laneId),
  );
}
