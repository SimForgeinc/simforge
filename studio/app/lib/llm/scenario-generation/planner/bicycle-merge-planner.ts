/**
 * Bicycle-merge planner (workstream J — dib): a cyclist rides a bike lane that
 * runs parallel to the subject's driving lane, then steers laterally OUT of the bike
 * lane into the subject's lane just ahead of it — the "bike suddenly merges into
 * traffic" conflict that happens where bike lanes mix into the main carriageway
 * (the BIKE_INTERSECTION_MIXING_ZONE candidates; 66 across our maps).
 *
 * Deterministic + topology-driven (no LLM): enumerate same-road, same-direction
 * (driving lane, biking lane) pairs, place the subject on the driving lane and the
 * cyclist on the parallel biking lane, and author the cyclist's final waypoint as
 * a lateral cut-in to the shared conflict point. Reuses the gated planner's
 * `buildPlannedActorFromTopology` so spawn/backward-walk/timing match the other
 * families. Sites carry a pre-solved `PlannedCollision` like the turn families.
 */
import type {
  MapTopologyIndex,
  TopologyLane,
  Vec2,
} from "@simforge-oss/studio-shared";
import type { TravelAwareTopologyIndex } from "@simforge-oss/studio-shared";
import { laneTravelIncreasesS, travelOrderedPolyline } from "@simforge-oss/studio-shared";
import type { PlannedCollision } from "../collision-route-planner";
import {
  buildPlannedActorFromTopology,
  arcPositionOnPolyline,
  polylineLength,
  dist,
} from "./gate-subject-route";

/** A bike lane must sit within this lateral distance of the driving lane to be
 *  a real merge (a parallel bike lane is ~1.5–4 m off the travel lane). Beyond
 *  this the "bike lane" is across the road — not a merge. */
const MERGE_LATERAL_MAX_M = 6.0;
const MERGE_LATERAL_MIN_M = 0.5;
/** Place the merge conflict this fraction along the driving lane (leaves run-up
 *  behind it and lane ahead for the run-out). */
const MERGE_CONFLICT_FRACTION = 0.6;
/** A site needs at least this much subject run-up to be worth keeping. */
const MIN_MERGE_RUNUP_M = 12;
/** The cyclist leaves the bike lane this far UPSTREAM of the abeam point, so the
 *  cut-in is a forward DIAGONAL that ends roughly aligned with the lane (rather
 *  than a 90° lateral dart whose post-conflict run-out would shoot sideways
 *  across the road). */
const MERGE_LEAD_M = 6.0;

/** The lane's polyline in the order it is DRIVEN, so subject and cyclist orient
 *  the same way. Direction comes from CARLA's resolved answer on a bound
 *  index, falling back to the lane-id sign convention only without one. */
function orientedForTravel(
  topology: TravelAwareTopologyIndex,
  lane: TopologyLane,
): Vec2[] {
  return travelOrderedPolyline(
    lane.polyline,
    laneTravelIncreasesS(topology.laneTravelIncreasesS, lane.rsl, lane.laneId),
  );
}

/** Arc along `poly` to the vertex nearest `p`, plus that nearest point. */
function abeamArc(poly: readonly Vec2[], p: Vec2): { arc: number; point: Vec2; gap: number } {
  let arc = 0;
  let best = { arc: 0, point: poly[0]!, gap: dist(poly[0]!, p) };
  for (let i = 1; i < poly.length; i++) {
    arc += dist(poly[i - 1]!, poly[i]!);
    const g = dist(poly[i]!, p);
    if (g < best.gap) best = { arc, point: poly[i]!, gap: g };
  }
  return best;
}

export interface RankedBicycleMergeSite {
  laneId: string; // driving lane rsl (the site key)
  bikeLaneId: string;
  conflictPoint: Vec2;
  plan: PlannedCollision;
  /** Lateral merge distance (m) — smaller = tighter, more abrupt cut-in. */
  lateralM: number;
  /** Subject run-up length (m) for fit ranking. */
  runUpM: number;
}

interface PlanArgs {
  topology: MapTopologyIndex;
  subjectSpeedKph: number;
  npcSpeedKph: number;
  arrivalTimeS: number;
}

function planBicycleMerge(
  topology: MapTopologyIndex,
  drivingRsl: string,
  driving: TopologyLane,
  bikeRsl: string,
  biking: TopologyLane,
  args: PlanArgs,
): { plan: PlannedCollision; conflictPoint: Vec2; lateralM: number; runUpM: number } | null {
  if (driving.polyline.length < 2 || biking.polyline.length < 2) return null;
  const dOriented = orientedForTravel(topology, driving);
  const bOriented = orientedForTravel(topology, biking);
  const dLen = polylineLength(dOriented);
  if (dLen < MIN_MERGE_RUNUP_M) return null;

  // Conflict at ~60% along the driving lane (leaving run-up + run-out).
  const conflictArc = Math.min(MERGE_CONFLICT_FRACTION * dLen, dLen - 5);
  const cp = arcPositionOnPolyline(dOriented, conflictArc);
  if (!cp) return null;
  const conflictPoint = cp.point;

  // Where the cyclist leaves the bike lane (abeam the conflict). Reject pairs
  // that aren't a real adjacent merge (too far / coincident).
  const abeam = abeamArc(bOriented, conflictPoint);
  if (abeam.gap > MERGE_LATERAL_MAX_M || abeam.gap < MERGE_LATERAL_MIN_M) return null;

  const subjectBackwardM = (args.subjectSpeedKph * args.arrivalTimeS) / 3.6;
  const npcBackwardM = (args.npcSpeedKph * args.arrivalTimeS) / 3.6;

  const subject = buildPlannedActorFromTopology(
    topology,
    [{ rsl: drivingRsl, oriented: dOriented }],
    conflictArc,
    subjectBackwardM,
    conflictPoint,
    args.arrivalTimeS,
  );
  if (!subject) return null;
  // The cyclist leaves the bike lane MERGE_LEAD_M upstream of the abeam point so
  // the final segment (departure → conflict) is a forward diagonal into the
  // lane, not a 90° dart. The builder appends the conflict point as that final
  // waypoint.
  const departArc = Math.max(2, abeam.arc - MERGE_LEAD_M);
  const npc = buildPlannedActorFromTopology(
    topology,
    [{ rsl: bikeRsl, oriented: bOriented }],
    departArc,
    npcBackwardM,
    conflictPoint,
    args.arrivalTimeS,
  );
  if (!npc) return null;

  const runUpM = subject.arcLengthM;
  if (runUpM < MIN_MERGE_RUNUP_M) return null;

  return {
    plan: {
      conflictPoint,
      arrivalTimeS: args.arrivalTimeS,
      subject,
      npc,
      rationale:
        `Bicycle merge — cyclist on bike lane ${bikeRsl} steers into subject's lane ` +
        `${drivingRsl} at (${conflictPoint.x.toFixed(1)}, ${conflictPoint.y.toFixed(1)}); ` +
        `lateral cut-in ${abeam.gap.toFixed(1)} m.`,
      subjectGate: null,
    },
    conflictPoint,
    lateralM: abeam.gap,
    runUpM,
  };
}

/**
 * Enumerate viable bicycle-merge sites: every same-road, same-section,
 * same-direction (driving lane, biking lane) pair that forms a real adjacent
 * merge. Each driving lane keeps its single best (nearest) bike-lane partner.
 */
export function findBicycleMergeSites(args: PlanArgs): RankedBicycleMergeSite[] {
  const lanes = Object.entries(args.topology.lanes);
  const byRoadSection = new Map<string, Array<[string, TopologyLane]>>();
  for (const [rsl, lane] of lanes) {
    const key = `${lane.roadId}:${lane.section}`;
    (byRoadSection.get(key) ?? byRoadSection.set(key, []).get(key)!).push([rsl, lane]);
  }

  const sites: RankedBicycleMergeSite[] = [];
  for (const group of byRoadSection.values()) {
    const driving = group.filter(
      ([, l]) => String(l.laneType).toLowerCase() === "driving" && l.polyline.length >= 2,
    );
    const biking = group.filter(
      ([, l]) => String(l.laneType).toLowerCase() === "biking" && l.polyline.length >= 2,
    );
    if (driving.length === 0 || biking.length === 0) continue;
    for (const [drsl, dlane] of driving) {
      // Best same-direction bike lane for this driving lane.
      let best: { rsl: string; lane: TopologyLane } | null = null;
      let bestGap = Infinity;
      const dMid = dlane.polyline[Math.floor(dlane.polyline.length / 2)]!;
      for (const [brsl, blane] of biking) {
        if (Math.sign(blane.laneId) !== Math.sign(dlane.laneId)) continue;
        const g = dist(blane.polyline[Math.floor(blane.polyline.length / 2)]!, dMid);
        if (g < bestGap) {
          bestGap = g;
          best = { rsl: brsl, lane: blane };
        }
      }
      if (!best) continue;
      const solved = planBicycleMerge(args.topology, drsl, dlane, best.rsl, best.lane, args);
      if (!solved) continue;
      sites.push({
        laneId: drsl,
        bikeLaneId: best.rsl,
        conflictPoint: solved.conflictPoint,
        plan: solved.plan,
        lateralM: solved.lateralM,
        runUpM: solved.runUpM,
      });
    }
  }
  // Rank: more subject run-up first (room to reach speed + react), tie-break by a
  // tighter (more abrupt) lateral cut-in, then by lane id for determinism.
  sites.sort(
    (a, b) =>
      b.runUpM - a.runUpM || a.lateralM - b.lateralM || a.laneId.localeCompare(b.laneId),
  );
  return sites;
}
