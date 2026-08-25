/**
 * Mid-block pedestrian-crossing site enumerator (dib review 2026-07-08: "we
 * should be able to have pedestrian collisions literally anywhere in the maps
 * — just add some occlusion").
 *
 * The gate-anchored selector limits ped conflicts to junction approaches, so a
 * map's spatial variety collapses to its few best gates. This enumerator walks
 * every non-junction DRIVING lane and emits crossing stations every
 * {@link STATION_SPACING_M}, each shaped as a {@link PedCrossingSite} with a
 * SYNTHETIC gate (id prefixed {@link MIDBLOCK_GATE_PREFIX}) so the existing
 * planner, occluder placement (D2), LOS verifier, and draft plumbing consume it
 * unchanged. The subject route is built straight along the lane (see the midblock
 * branch in pedestrian-crossing-topology-planner); the occluder is SYNTHESIZED
 * by the caller when no DB-discovered occluder matches, which is what makes
 * "anywhere" viable.
 */
import type { MapTopologyIndex, TopologyGate } from "@simforge/studio-shared";
import type { PedCrossingSite } from "./pedestrian-crossing-site-selector";
import {
  arcPositionOnPolyline,
  orientLanePolylineToTravel,
  polylineLength,
  walkPredecessorsBackward,
  polylineEntryHeading,
} from "./gate-subject-route";

export const MIDBLOCK_GATE_PREFIX = "midblock:";

/** Station spacing along a lane. Dense enough for variety; the diversity
 *  re-ranking + per-anchor cap keep one long lane from flooding the batch. */
const STATION_SPACING_M = 30;
/** Keep stations off the lane's upstream end (spawn/geometry jitter). */
const LANE_START_MARGIN_M = 12;
/** Downstream room so the subject can carry through the conflict. */
const LANE_END_MARGIN_M = 15;
/** Exclusion radius around junction polygons — mid-block means MID-BLOCK; the
 *  gate family owns junction-adjacent crossings. */
const JUNCTION_CLEARANCE_M = 20;
/** Hard cap per map: enumeration is cheap but downstream fit-scoring resolves
 *  a crossing line per site. */
const MAX_SITES_PER_MAP = 400;

const DRIVING_LANE_TYPES = new Set(["driving", "bidirectional"]);

export interface SelectMidblockPedSitesArgs {
  topology: MapTopologyIndex;
  subjectSpeedKph: number;
  /** Minimum approach run-up seconds (same contract as the gate selector). */
  minTimeS: number;
}

export function isMidblockGateId(gateId: string): boolean {
  return gateId.startsWith(MIDBLOCK_GATE_PREFIX);
}

/** Junction exclusion centers: centroid of each junction's internal-lane
 *  polyline points, with a radius covering them (plus clearance). */
function junctionExclusionZones(
  topology: MapTopologyIndex,
): Array<{ x: number; y: number; r: number }> {
  const zones: Array<{ x: number; y: number; r: number }> = [];
  for (const junction of Object.values(topology.junctions ?? {})) {
    let sx = 0;
    let sy = 0;
    let n = 0;
    const pts: Array<{ x: number; y: number }> = [];
    for (const rsl of junction.internalLaneRsls ?? []) {
      const poly = topology.lanes?.[rsl]?.polyline ?? [];
      for (const p of poly) {
        sx += p.x;
        sy += p.y;
        n += 1;
        pts.push(p);
      }
    }
    if (n === 0) continue;
    const cx = sx / n;
    const cy = sy / n;
    let r = 0;
    for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.y - cy));
    zones.push({ x: cx, y: cy, r: r + JUNCTION_CLEARANCE_M });
  }
  return zones;
}

/**
 * Enumerate mid-block crossing stations as PedCrossingSites (synthetic gate).
 * Room accounting matches the gate selector: same-lane upstream arc, extended
 * by a predecessor walk when the lane alone can't cover the required run-up.
 */
export function selectMidblockPedSites(args: SelectMidblockPedSitesArgs): PedCrossingSite[] {
  const { topology, subjectSpeedKph, minTimeS } = args;
  const requiredRunUpM = (subjectSpeedKph * minTimeS) / 3.6;
  const zones = junctionExclusionZones(topology);
  const sites: PedCrossingSite[] = [];

  const laneRsls = Object.keys(topology.lanes ?? {}).sort();
  for (const rsl of laneRsls) {
    if (sites.length >= MAX_SITES_PER_MAP) break;
    const lane = topology.lanes[rsl]!;
    if (lane.isJunction || !DRIVING_LANE_TYPES.has(lane.laneType)) continue;
    if (!lane.polyline || lane.polyline.length < 2) continue;
    // Travel-oriented polyline: every downstream quantity (station arc,
    // upstream room, entry heading, crossing axis, the subject route itself) is
    // measured in DRIVING direction. The raw polyline is +s-ordered for every
    // lane, which is BACKWARD for positive-id lanes — the root cause of the
    // ped-midblock subject-wrong-way ledger cluster (2026-08-01 corpus).
    const poly = orientLanePolylineToTravel(rsl, lane);
    const lenM = polylineLength(poly);
    if (lenM < LANE_START_MARGIN_M + LANE_END_MARGIN_M + 5) continue;

    for (
      let arc = LANE_START_MARGIN_M;
      arc <= lenM - LANE_END_MARGIN_M && sites.length < MAX_SITES_PER_MAP;
      arc += STATION_SPACING_M
    ) {
      const at = arcPositionOnPolyline(poly, arc);
      if (!at) continue;
      const p = { x: at.point.x, y: at.point.y };
      if (zones.some((z) => Math.hypot(p.x - z.x, p.y - z.y) <= z.r)) continue;

      // Upstream room: same-lane arc, plus a predecessor walk for the deficit
      // (mirrors buildPlannedActorFromTopology, which does the same at plan
      // time — so the room we advertise is the room the planner can realize).
      let roomM = arc;
      if (roomM < requiredRunUpM) {
        const entryHdg = poly.length >= 2 ? polylineEntryHeading(poly) : null;
        const { totalLen } = walkPredecessorsBackward(
          topology,
          rsl,
          poly[0]!,
          entryHdg,
          requiredRunUpM - roomM,
        );
        roomM += totalLen;
        if (roomM < requiredRunUpM) continue; // genuinely short approach
      }

      const gate: TopologyGate = {
        id: `${MIDBLOCK_GATE_PREFIX}${rsl}@${Math.round(arc)}`,
        junctionId: `${MIDBLOCK_GATE_PREFIX}${rsl}`,
        turnRelation: "Straight",
        headingChangeRad: 0,
        connectingLaneRsl: rsl,
        approachLaneRsl: rsl,
        exitLaneRsls: [],
      };
      sites.push({
        gate,
        approachLaneRsl: rsl,
        conflictPoint: p,
        conflictArc: arc,
        crossingAxisRad: at.yawRad + Math.PI / 2,
        roomM,
        score: 0,
      });
    }
  }
  return sites;
}
