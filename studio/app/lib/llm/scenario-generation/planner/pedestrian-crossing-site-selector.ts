/**
 * Pedestrian-crossing site selector.
 *
 * Given a `MapTopologyIndex` and an anchor point (e.g. a document's
 * `documentCenter`), this module picks the best junction-approach Straight
 * gate for a subject vehicle that drives straight through the junction.
 *
 * Filters applied in order:
 *   1. **turnRelation guard** — only `"Straight"` gates.
 *   2. **Lane guard** — all chain lanes (approach, connecting, exit) must be
 *      `driving` or `bidirectional`.  Lanes like `biking`, `sidewalk`, and
 *      `shoulder` are for non-motorised users; a car must never be routed
 *      onto them.
 *   3. **Polyline guard** — `buildGatePolyline` must succeed.
 *   4. **Room guard** — the approach lane's polyline length PLUS the backward
 *      predecessor walk must provide ≥ `minRoomM` upstream of the junction,
 *      where `minRoomM = subjectSpeedKph × minTimeS / 3.6` (the MINIMUM acceptable
 *      run-up = the collision-window minimum, not the ideal). Gates with room
 *      between the min and ideal are kept; the planner floats the subject's
 *      arrival time up to the available room so the subject stays at full speed.
 *
 * Ranking: survivors are ranked by proximity to the anchor (nearest first);
 * upstream room is a hard guard (step 4), NOT a ranking objective.  Ties are
 * broken by room descending then gate.id ascending for determinism.
 *
 * No server I/O — pure math on topology data.
 */
import type { MapTopologyIndex, TopologyGate, Vec2 } from "@simforge/studio-shared";
import {
  buildGatePolyline,
  walkPredecessorsBackward,
  polylineLength,
  polylineEntryHeading,
  arcPositionOnPolyline,
} from "./gate-subject-route";

// ── Constants ────────────────────────────────────────────────────────────────

/** Lane types that a motorised subject vehicle may travel on. */
const DRIVING_LANE_TYPES = new Set(["driving", "bidirectional"]);

/** How far upstream of the approach→connecting joint to place the conflict
 *  point.  Represents "pedestrian crossing is a few metres before the
 *  stop-line". */
const DEFAULT_SETBACK_M = 3;

// ── Public types ─────────────────────────────────────────────────────────────

export interface PedCrossingSite {
  gate: TopologyGate;
  approachLaneRsl: string;
  /** World point where subject and pedestrian paths intersect. */
  conflictPoint: Vec2;
  /** Arc length from the gate chain start to `conflictPoint`. */
  conflictArc: number;
  /** Perpendicular axis (radians) for the pedestrian's crossing path. */
  crossingAxisRad: number;
  /** Upstream room (m) available for the subject run-up: approach-lane length
   *  plus the backward predecessor walk. The planner uses this to float the
   *  subject's arrival time in `[minTimeS, idealTimeS]` at full speed. */
  roomM: number;
  /** Composite selection score (higher = better). */
  score: number;
}

export interface PedSiteSelectionTrace {
  /** Total Straight gates in the topology. */
  candidates: number;
  /** Survivors after lane guard. */
  afterLaneGuard: number;
  /** Survivors after room guard. */
  afterRoomGuard: number;
  /** Top-5 scored candidates (gate id + score + any notes). */
  topN: { gate: string; score: number; reasons: string[] }[];
  /** All rejected gates with the reason for rejection. */
  rejected: { gate: string; reason: string }[];
  /** Id of the chosen gate, or null when no viable gate exists. */
  chosen: string | null;
}

export interface SelectPedSiteArgs {
  topology: MapTopologyIndex;
  anchor: Vec2;
  /** Subject speed used to compute the minimum required upstream room. */
  subjectSpeedKph: number;
  /** Minimum acceptable seconds of approach run-up (the collision-window
   *  minimum). The room guard requires only `subjectSpeedKph × minTimeS / 3.6`
   *  of upstream room, keeping gates that have enough for a viable (if
   *  shorter-than-ideal) run-up. */
  minTimeS: number;
}

// ── Private helpers ──────────────────────────────────────────────────────────

function euclidean(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Compute the conflict point on the approach lane: walk `setbackM` metres
 * backward from the approach→connecting joint along the approach polyline.
 *
 * The approach link is `built.chain[0]`; its LAST point is adjacent to the
 * connecting lane.  We subtract `setbackM` from the approach polyline's total
 * arc length to place the conflict point slightly before the stop-line.
 */
function conflictOnApproach(
  built: { chain: Array<{ rsl: string; oriented: Vec2[] }>; flat: Vec2[] },
  setbackM: number,
): { conflictPoint: Vec2; conflictArc: number; crossingAxisRad: number } | null {
  const approachOriented = built.chain[0]?.oriented;
  if (!approachOriented || approachOriented.length < 2) return null;

  const approachLen = polylineLength(approachOriented);
  const targetArc = Math.max(0, approachLen - setbackM);
  const pos = arcPositionOnPolyline(approachOriented, targetArc);
  if (!pos) return null;

  // Arc from chain start to conflict point.
  // Chain start = approach start (chain[0].oriented[0]).
  // Arc within approach = targetArc.  Chain arc = targetArc (since approach
  // is the first link at arc offset 0).
  const conflictArc = targetArc;

  // Perpendicular to the approach heading = crossing axis.
  const crossingAxisRad = pos.yawRad + Math.PI / 2;

  return {
    conflictPoint: { x: pos.point.x, y: pos.point.y },
    conflictArc,
    crossingAxisRad,
  };
}

/**
 * Proximity score for a candidate site.
 *
 * `score = 1 / (1 + distToAnchor)` — higher means closer to the anchor.
 * This is the primary ranking key (descending), reflecting the policy that
 * the anchor (documentCenter) determines WHERE the crossing is built.  Room
 * is a hard guard upstream, not a ranking factor here.
 */
function proximityScore(distToAnchor: number): number {
  return 1 / (1 + distToAnchor);
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Select the pedestrian-crossing sites from the topology.
 *
 * Returns the full proximity-ranked list of viable sites (`sites[0]` = the
 * nearest-to-anchor = current best). Returns `null` when no viable gate passes
 * all guards. The builder consumes the ranked list to try sites nearest-first
 * and accept the first whose post-snap scenario kinematically validates
 * (topological reachability gate); `sites[0]` alone preserves the legacy
 * single-site behavior for existing callers.
 */
export function selectPedestrianCrossingSite(
  a: SelectPedSiteArgs,
): { sites: PedCrossingSite[]; trace: PedSiteSelectionTrace } | null {
  const { topology, anchor, subjectSpeedKph, minTimeS } = a;

  // Step 1: Minimum required upstream room (m) = speed × minTime / 3.6.
  const minRoomM = (subjectSpeedKph * minTimeS) / 3.6;

  // Step 2: Candidates = all Straight gates.
  const candidates = topology.gates.filter(
    (g) => g.turnRelation === "Straight",
  );

  const rejected: { gate: string; reason: string }[] = [];

  // Step 3: Lane guard.
  const afterLaneGuardList: TopologyGate[] = [];
  for (const gate of candidates) {
    const chainRsls = [
      gate.approachLaneRsl,
      gate.connectingLaneRsl,
      ...gate.exitLaneRsls,
    ];
    const resolvedLanes = chainRsls
      .map((rsl) => topology.lanes[rsl])
      .filter((l) => l != null);

    if (resolvedLanes.length < 2) {
      rejected.push({
        gate: gate.id,
        reason: "non-driving chain (insufficient lanes resolved)",
      });
      continue;
    }

    const nonDriving = resolvedLanes.filter(
      (l) => !DRIVING_LANE_TYPES.has(l.laneType),
    );
    if (nonDriving.length > 0) {
      const badTypes = [...new Set(nonDriving.map((l) => l.laneType))].join("/");
      rejected.push({
        gate: gate.id,
        reason: `non-driving chain (${badTypes})`,
      });
      continue;
    }

    afterLaneGuardList.push(gate);
  }

  // Step 4 + 5: Polyline guard + Room guard.
  type BuiltGate = NonNullable<ReturnType<typeof buildGatePolyline>>;
  interface Survivor {
    gate: TopologyGate;
    built: BuiltGate;
    room: number;
    distToAnchor: number;
  }

  const survivors: Survivor[] = [];

  for (const gate of afterLaneGuardList) {
    // Step 4: Polyline guard.
    const built = buildGatePolyline(topology, gate);
    if (!built) {
      rejected.push({ gate: gate.id, reason: "ungappable gate polyline" });
      continue;
    }

    // Step 5: Room guard.
    const approachOriented = built.chain[0]?.oriented ?? [];
    const approachStart = approachOriented[0];
    if (!approachStart) {
      rejected.push({ gate: gate.id, reason: "ungappable gate polyline" });
      continue;
    }

    const approachLen = polylineLength(approachOriented);
    // Pass the approach entry heading so the FIRST predecessor hop is also
    // direction-checked — otherwise the room estimate could count a reversing
    // lane on the first hop and over-report forward run-up.
    const approachEntryHdg =
      approachOriented.length >= 2 ? polylineEntryHeading(approachOriented) : null;
    const { totalLen: walkLen } = walkPredecessorsBackward(
      topology,
      gate.approachLaneRsl,
      approachStart,
      approachEntryHdg,
      minRoomM,
    );
    const room = approachLen + walkLen;

    if (room < minRoomM) {
      rejected.push({
        gate: gate.id,
        reason: `no room (${room | 0}m<${minRoomM | 0}m)`,
      });
      continue;
    }

    // Compute anchor distance: use approach lane midpoint as proxy.
    const approachMid =
      approachOriented[Math.floor(approachOriented.length / 2)] ??
      approachOriented[0]!;
    const distToAnchor = euclidean(approachMid, anchor);

    survivors.push({ gate, built, room, distToAnchor });
  }

  const afterRoomGuard = survivors.length;

  if (survivors.length === 0) {
    return null;
  }

  // Step 6 + 7: Compute conflict geometry and proximity score.
  interface ScoredSurvivor {
    gate: TopologyGate;
    site: PedCrossingSite;
    /** Proximity score: 1/(1+distToAnchor) — higher = nearer = better. */
    score: number;
    distToAnchor: number;
    room: number;
  }

  const scored: ScoredSurvivor[] = [];
  for (const s of survivors) {
    const conflict = conflictOnApproach(s.built, DEFAULT_SETBACK_M);
    if (!conflict) continue;

    const score = proximityScore(s.distToAnchor);

    scored.push({
      gate: s.gate,
      site: {
        gate: s.gate,
        approachLaneRsl: s.gate.approachLaneRsl,
        conflictPoint: conflict.conflictPoint,
        conflictArc: conflict.conflictArc,
        crossingAxisRad: conflict.crossingAxisRad,
        roomM: s.room,
        score,
      },
      score,
      distToAnchor: s.distToAnchor,
      room: s.room,
    });
  }

  if (scored.length === 0) {
    return null;
  }

  // Step 8: Sort by proximity (distToAnchor ascending = score descending);
  // tiebreak by room descending, then gate.id ascending for determinism.
  scored.sort((a, b) => {
    const distDiff = a.distToAnchor - b.distToAnchor;
    if (Math.abs(distDiff) > 1e-9) return distDiff;
    const roomDiff = b.room - a.room;
    if (Math.abs(roomDiff) > 1e-9) return roomDiff;
    return a.gate.id < b.gate.id ? -1 : 1;
  });

  const topN = scored.slice(0, 5).map((s) => ({
    gate: s.gate.id,
    score: +s.score.toFixed(4),
    reasons: [
      `dist=${s.distToAnchor.toFixed(1)}m`,
      `room=${s.room.toFixed(1)}m`,
    ],
  }));

  // Full proximity-ranked viable list; sites[0] = nearest = current best.
  const sites = scored.map((s) => s.site);

  const trace: PedSiteSelectionTrace = {
    candidates: candidates.length,
    afterLaneGuard: afterLaneGuardList.length,
    afterRoomGuard,
    topN,
    rejected,
    chosen: sites[0]?.gate.id ?? null,
  };

  return { sites, trace };
}
