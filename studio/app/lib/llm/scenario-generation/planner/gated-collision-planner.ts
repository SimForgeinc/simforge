/**
 * Gate-driven collision route planner — **pure-XODR Tier-0**.
 *
 * Selects subject + conflicting lanes from the XODR-derived `MapTopologyIndex`
 * gates (the exact directed turn affordances CARLA drives), then resolves
 * gate geometry entirely from `topology.lanes[rsl].polyline` and walks
 * `topology.lanes[rsl].predecessors` for the backward run-up. The runtime
 * lane-graph is no longer consulted: that was a geojson-derived projection
 * with PLANNER_BUNDLE_RADIUS_M coverage, and it failed to include many
 * XODR lanes the topology references (the bug Path A solves).
 *
 * `unprotected_left_turn`: junction → a `Left` gate (subject's
 * approach→connecting→exit) and the `Straight` gate whose connecting lane
 * geometrically crosses subject's turn (the genuine oncoming movement). No
 * heading heuristic anywhere — turn identity is the gate's `turnRelation`.
 * Lane polylines are sampled at build time from each road's `<planView>`
 * (line/arc/spiral) + `<laneOffset>` + per-lane `<width>` polynomials.
 */
import "server-only";
import type {
  MapTopologyIndex,
  TopologyGate,
  TopologyLane,
  Vec2,
} from "@simforge-oss/maps/topology";
import {
  findPolylineConflict,
  type PlannedActor,
  type PlannedCollision,
} from "@/app/lib/llm/scenario-generation/collision-route-planner";
import {
  buildGatePolyline,
  buildPlannedActorFromTopology,
  dist,
  orientPolylineTowards,
  polylineLength,
  reversed,
} from "@/app/lib/llm/scenario-generation/planner/gate-subject-route";

/**
 * Strict chain-vs-chain intersection. Looks for a true segment-segment
 * intersection between any (subject link × npc link) pair, then returns the
 * conflict point + each side's chain arc (measured as the sum of prior
 * links' polyline lengths + the arc within the hit segment's link —
 * NOT the gap-included flat-polyline arc).
 *
 * Using chain arc here matches the convention `chainSlice` /
 * `arcPositionOnChain` use, so the slice from spawn to conflict has
 * polyline length exactly `speed × arrivalTimeS / 3.6`. Treating the
 * concatenated polyline's gap-segments as arc would inflate the
 * intersection arc and make the spawn-to-conflict slice 10-35m longer
 * than intended.
 */

// ---------------------------------------------------------------------------
// Subject run-up: solved from the REAL speed profile, not `speed x time`
// ---------------------------------------------------------------------------
//
// The subject does not drive its approach at constant cruise — it DECELERATES through the turn.
// It cannot take a ~7 m radius corner at 35 km/h. The planner used to place it
// `subjectSpeedKph * arrivalTimeS` metres back anyway, so it arrived LATE and the NPC — which
// DOES hold its speed — had already crossed. The collision never happened.
//
// Measured over 28 turn-collision scenes (2026-07-14): the subject's mean run-up speed was only
// 0.80x nominal (range 0.23-0.97) — a ~25% late arrival, ~1.5 s on a 6 s run-up, during which
// the NPC travels ~14.5 m. That IS the observed miss distance (median 17.4 m on
// right_turn_hook, 2.8-9.8 m on the near-misses), and why unprotected_left_turn converted at
// 16% and right_turn_hook at 5%.
//
// The slowdown is REAL and must be KEPT — a car cornering at full cruise is not a scene we
// want. So model it instead of cancelling it with a fudge factor:
//   1. curvature-limited speed:  v = sqrt(A_LAT_MAX / |kappa|), capped at cruise
//   2. a backward pass so the subject can BRAKE IN TIME for the corner ahead
//   3. walk BACKWARD from the conflict accumulating dt = ds / v(s) until arrivalTimeS is spent
// The distance covered IS the run-up. Identical to `speed x time` on a straight approach, and
// correctly SHORTER the sharper the turn. Per-scene, from the real geometry.
const A_LAT_MAX_MPS2 = 3.0;   // comfortable lateral accel — sets the cornering speed
const A_BRAKE_MPS2 = 2.5;     // comfortable deceleration into the corner
const V_MIN_TURN_MPS = 3.0;   // floor: even a hairpin is taken slowly, not at zero
const PROFILE_STEP_M = 1.0;

/** Menger curvature at b (1/m). */
function curvatureAt(a: Vec2, b: Vec2, c: Vec2): number {
  const ab = Math.hypot(b.x - a.x, b.y - a.y);
  const bc = Math.hypot(c.x - b.x, c.y - b.y);
  const ca = Math.hypot(a.x - c.x, a.y - c.y);
  if (ab < 1e-6 || bc < 1e-6 || ca < 1e-6) return 0;
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return Math.abs(2 * cross) / (ab * bc * ca);
}

function pointAtArc(poly: Vec2[], s: number): Vec2 {
  if (poly.length === 0) return { x: 0, y: 0 };
  let acc = 0;
  for (let i = 0; i + 1 < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + seg >= s) {
      const t = seg < 1e-9 ? 0 : (s - acc) / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    acc += seg;
  }
  return poly[poly.length - 1]!;
}

/** Distance back from the conflict at which the subject must spawn to ARRIVE at `arrivalTimeS`,
 *  driving the speed profile the geometry actually allows. */
/** Absolute floor (seconds) on the REALISED approach for the JUNCTION-ARC
 *  families planned here (unprotected_left_turn, right_turn_hook).
 *
 *  The relative MIN_RUNUP_FRACTION cannot express "this scene needs N seconds of
 *  approach": at a 4 s arrival it still passes half of it, which renders as a
 *  conflict ~2 s after spawn — dib 2026-07-30, "the collision happens in the
 *  first 1-2 seconds, immediately after spawn".
 *
 *  Set BELOW the request (TURN_MIN_TIME_S 3.5 / TURN_ARRIVAL_TIME_S 4) on
 *  purpose: a floor at or above the request rejects every site however good,
 *  which is the coupling documented in batch-collision-generator.ts. */
const TURN_MIN_APPROACH_TIME_S = 3.0;

export function subjectRunUpDistanceForArrival(
  polyline: Vec2[],
  conflictArc: number,
  subjectSpeedKph: number,
  arrivalTimeS: number,
): number {
  const cruise = subjectSpeedKph / 3.6;
  if (!Number.isFinite(conflictArc) || conflictArc <= 0 || polyline.length < 3) {
    return cruise * arrivalTimeS;
  }
  const n = Math.max(3, Math.ceil(conflictArc / PROFILE_STEP_M) + 1);
  const ds = conflictArc / (n - 1);
  const v: number[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    const sArc = i * ds;
    const kappa = curvatureAt(
      pointAtArc(polyline, Math.max(0, sArc - ds)),
      pointAtArc(polyline, sArc),
      pointAtArc(polyline, Math.min(conflictArc, sArc + ds)),
    );
    const vCurve = kappa > 1e-6 ? Math.sqrt(A_LAT_MAX_MPS2 / kappa) : cruise;
    v[i] = Math.min(cruise, Math.max(V_MIN_TURN_MPS, vCurve));
  }
  for (let i = n - 2; i >= 0; i -= 1) {
    v[i] = Math.min(v[i]!, Math.sqrt(v[i + 1]! * v[i + 1]! + 2 * A_BRAKE_MPS2 * ds));
  }
  let t = 0;
  let dist = 0;
  for (let i = n - 1; i >= 1; i -= 1) {
    const vSeg = Math.max(V_MIN_TURN_MPS, 0.5 * (v[i]! + v[i - 1]!));
    const dt = ds / vSeg;
    if (t + dt >= arrivalTimeS) return dist + (arrivalTimeS - t) * vSeg;
    t += dt;
    dist += ds;
  }
  // Modelled approach is shorter than the run-up: the rest is cruise on the straight upstream.
  return dist + (arrivalTimeS - t) * cruise;
}

function strictChainIntersection(
  subjectChain: ReadonlyArray<{ rsl: string; oriented: Vec2[] }>,
  npcChain: ReadonlyArray<{ rsl: string; oriented: Vec2[] }>,
): { point: Vec2; subjectArc: number; npcArc: number } | null {
  const TOL = 0.25;
  let subjectPrior = 0;
  for (let ei = 0; ei < subjectChain.length; ei++) {
    const subject = subjectChain[ei]!.oriented;
    let npcPrior = 0;
    for (let ni = 0; ni < npcChain.length; ni++) {
      const npc = npcChain[ni]!.oriented;
      const hit = findPolylineConflict(subject, npc);
      if (!hit) {
        npcPrior += polylineLength(npc);
        continue;
      }
      // Reject the closest-approach fallback (point off-polyline).
      const dSubject = nearestPointDistance(subject, hit.point);
      const dNpc = nearestPointDistance(npc, hit.point);
      if (dSubject > TOL || dNpc > TOL) {
        npcPrior += polylineLength(npc);
        continue;
      }
      return {
        point: hit.point,
        subjectArc: subjectPrior + hit.subjectArc,
        npcArc: npcPrior + hit.npcArc,
      };
    }
    subjectPrior += polylineLength(subject);
  }
  return null;
}

function nearestPointDistance(poly: ReadonlyArray<Vec2>, p: Vec2): number {
  if (poly.length < 2) return Infinity;
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const d = pointSegmentDistance(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface GatedPlanArgs {
  topology: MapTopologyIndex;
  /** Chosen scenario location, runtime-world meters (geometry.documentCenter). */
  documentCenter: { x: number; y: number };
  subjectSpeedKph: number;
  npcSpeedKph: number;
  arrivalTimeS: number;
}

/**
 * Minimum allowed center-to-center distance between subject and NPC spawn
 * points so two CAR-size actors don't overlap at t=0.
 *
 * The strict-intersection conflict filter only checks the contact lies
 * inside the junction — it does NOT verify the spawn points themselves
 * have room to coexist. Low arrival times + low speeds (or predecessor
 * walks that hit the same upstream segment) can land both spawns
 * inside a ~3m circle, producing an immediate t≈0 overlap (the yale-134
 * regression).
 *
 * The planner doesn't know vehicle blueprints — those are decided
 * downstream — so this uses the CAR + CAR worst-case (4.5m each, per
 * `draft-validator` footprint) plus a 1.5m bumper-to-bumper margin.
 * Smaller blueprints (bike, motorcycle) still clear it; larger ones
 * (truck, bus) are not currently used as default Tier-0 NPCs.
 */
const MIN_SPAWN_SPREAD_M = 4.5 + 4.5 + 1.5;

/**
 * Center-to-center spawn-spread predicate. Returns true when subject and
 * NPC would spawn closer than `MIN_SPAWN_SPREAD_M` and the gated planner
 * should reject this pair and fall through to the next gate combination.
 */
function spawnsTooClose(subject: PlannedActor, npc: PlannedActor): boolean {
  const d = Math.hypot(
    subject.spawnPoint.x - npc.spawnPoint.x,
    subject.spawnPoint.y - npc.spawnPoint.y,
  );
  return d < MIN_SPAWN_SPREAD_M;
}

/** Half-width band (m) around a spawn in which a driving lane counts as "the
 *  lane this actor is on" for the direction check. ~one lane width. */
const LANE_ALIGN_RADIUS_M = 3.5;
/** Max heading deviation (deg) from a nearby lane's travel direction for the
 *  actor to count as travelling WITH traffic. */
const LANE_ALIGN_MAX_DEG = 45;

/**
 * True when the planned actor's initial travel heading aligns with a real
 * driving lane's direction of travel at its spawn — i.e. it drives WITH
 * traffic, not head-on against it. Guards the "oncoming NPC coming head-on in
 * the wrong direction — can't have them behave like pedestrians" failure (dib
 * review 2026-07-08: 2 of 4 belmont lefts had a wrong-way conflict car). A
 * genuine oncoming NPC sits in the opposing lane whose travel direction its
 * own heading matches; a wrong-way NPC has NO nearby lane its heading follows.
 *
 * Lane polylines are stored in the lane's direction of travel (schema), so a
 * segment's heading IS its travel direction. Fails OPEN when topology carries
 * no usable driving lane near the spawn (keeps un-enriched maps working).
 */
export function travelsWithLane(topology: MapTopologyIndex, planned: PlannedActor): boolean {
  const wps = planned.waypoints;
  let heading: number | null = null;
  for (let i = 1; i < wps.length; i++) {
    const dx = wps[i]!.x - wps[0]!.x;
    const dy = wps[i]!.y - wps[0]!.y;
    if (Math.hypot(dx, dy) > 0.5) {
      heading = Math.atan2(dy, dx);
      break;
    }
  }
  if (heading === null) return true; // degenerate route — not our concern here
  const sp = planned.spawnPoint;
  const maxRad = (LANE_ALIGN_MAX_DEG * Math.PI) / 180;
  let sawLane = false;
  for (const lane of Object.values(topology.lanes) as TopologyLane[]) {
    if (!DRIVING_LANE_TYPES.has(lane.laneType) || lane.polyline.length < 2) continue;
    for (let i = 0; i + 1 < lane.polyline.length; i++) {
      const a = lane.polyline[i]!;
      const b = lane.polyline[i + 1]!;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      if (Math.hypot(mx - sp.x, my - sp.y) > LANE_ALIGN_RADIUS_M) continue;
      sawLane = true;
      const laneHdg = Math.atan2(b.y - a.y, b.x - a.x);
      const diff = Math.abs(((heading - laneHdg + Math.PI) % (2 * Math.PI)) - Math.PI);
      if (diff <= maxRad) return true;
    }
  }
  return !sawLane; // fail open only when no driving lane is near the spawn
}

const DRIVING_LANE_TYPES = new Set(["driving", "bidirectional"]);

// ── Junction resolution ─────────────────────────────────────────────────────

/**
 * Compute a topology junction's geometric centroid + maximum radius
 * from that centroid to any internal-lane midpoint. This is the
 * authoritative "where this scenario happens" for a junction —
 * downstream validators consult it instead of the geojson document
 * centroid (which can differ by tens of metres on big junctions).
 */
export function topologyJunctionCentroid(
  topology: MapTopologyIndex,
  junctionId: string,
): { center: Vec2; maxRadiusM: number } | null {
  const j = topology.junctions[junctionId];
  if (!j) return null;
  const mids: Vec2[] = [];
  for (const rsl of j.internalLaneRsls) {
    const lane = topology.lanes[rsl];
    if (!lane || lane.polyline.length === 0) continue;
    mids.push(lane.polyline[Math.floor(lane.polyline.length / 2)]!);
  }
  if (mids.length === 0) return null;
  const center = {
    x: mids.reduce((s, p) => s + p.x, 0) / mids.length,
    y: mids.reduce((s, p) => s + p.y, 0) / mids.length,
  };
  let maxR = 0;
  for (const m of mids) {
    const d = dist(m, center);
    if (d > maxR) maxR = d;
  }
  return { center, maxRadiusM: maxR };
}

/** Compare two junctionIds for a deterministic tie-break: numeric order
 *  when both parse as numbers (the XODR norm), else lexicographic. */
function compareJunctionIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Topology junction the chosen document sits closest to, scored by the
 * **minimum distance from `center` to any of the junction's lane
 * polylines** — approach lanes and connecting (internal) lanes alike.
 * Pure-topology, no lane-graph lookup.
 *
 * Why not the mean centroid of internal lanes (the previous rule): on
 * dense maps centroid scoring misfires. A large junction whose internal
 * lanes straddle `center` can win on centroid even when the point
 * actually lies on a small neighbouring junction's approach lane, and a
 * sprawling junction's centroid drifts tens of metres off its own
 * geometry. Nearest-lane distance answers "which junction is this point
 * on/near" directly — and it folds in the approach lanes the user most
 * often clicks near, not just the junction interior.
 *
 * Ties (within 1mm) break to the lower numeric junctionId so selection is
 * deterministic across runs. Junctions with no sampled lane geometry are
 * skipped (nothing to fall back to — a centroid needs the same geometry).
 */
export function resolveJunctionId(
  topology: MapTopologyIndex,
  center: Vec2,
): string | null {
  const scored: Array<{ id: string; d: number }> = [];
  for (const j of Object.values(topology.junctions)) {
    let minD = Infinity;
    for (const rsl of [...j.approachLaneRsls, ...j.internalLaneRsls]) {
      const lane = topology.lanes[rsl];
      if (!lane || lane.polyline.length < 2) continue;
      const d = nearestPointDistance(lane.polyline, center);
      if (d < minD) minD = d;
    }
    if (minD !== Infinity) scored.push({ id: j.junctionId, d: minD });
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) =>
    Math.abs(a.d - b.d) > 1e-6 ? a.d - b.d : compareJunctionIds(a.id, b.id),
  );
  return scored[0]!.id;
}

// ── Public solvers ──────────────────────────────────────────────────────────

/**
 * Shared gate-driven turn-vs-through-movement planner.
 *
 * Subject takes a gate of `turn` relation (Left | Right); the conflicting NPC
 * is the junction's Straight gate whose connecting lane geometrically
 * crosses subject's turn. `preferBikeNpc` biases NPC selection toward a
 * Straight gate whose approach lane is a `biking` lane — the cyclist
 * right-hook (`right_turn_hook`). Returns null (caller → legacy planner)
 * when no resolvable turn gate or no crossing Straight gate exists.
 */
function planGatedTurn(
  args: GatedPlanArgs,
  turn: "Left" | "Right",
  opts: { preferBikeNpc?: boolean; label: string },
): PlannedCollision | null {
  const { topology, documentCenter, subjectSpeedKph, npcSpeedKph, arrivalTimeS } = args;

  const junctionId = resolveJunctionId(topology, documentCenter);
  if (!junctionId) return null;
  const junction = topology.junctions[junctionId];
  if (!junction) return null;

  // Junction interior bounds. The genuine crossing between a Left gate
  // and the Straight gate it crosses ALWAYS happens inside the junction.
  // If our oriented (approach+connecting+exit) chains intersect outside
  // this radius, they're crossing on a DIFFERENT downstream junction or
  // bug-orientation — reject those conflicts. Generous margin
  // (centroid + 1.5×maxR + 10m) since exit-stub tails legitimately
  // reach a bit past the junction edge.
  const junctionGeom = topologyJunctionCentroid(topology, junctionId);
  const junctionConflictRadiusM = junctionGeom
    ? junctionGeom.maxRadiusM * 1.5 + 10
    : 50;

  const gatesById = new Map(topology.gates.map((g) => [g.id, g]));
  const junctionGates = junction.gateIds
    .map((id) => gatesById.get(id))
    .filter((g): g is TopologyGate => !!g);

  const turnGates = junctionGates.filter((g) => g.turnRelation === turn);
  let straightGates = junctionGates.filter((g) => g.turnRelation === "Straight");
  if (opts.preferBikeNpc) {
    // Right-hook: the classic victim is a cyclist continuing straight in
    // the bike lane subject turns across. Try bike-approach straights first,
    // then fall back to any crossing straight.
    const isBike = (rsl: string) =>
      topology.lanes[rsl]?.laneType === "biking";
    straightGates = [
      ...straightGates.filter((g) => isBike(g.approachLaneRsl)),
      ...straightGates.filter((g) => !isBike(g.approachLaneRsl)),
    ];
  }

  for (const subject of turnGates) {
    const subjectBuild = buildGatePolyline(topology, subject);
    if (!subjectBuild) continue;

    for (const npc of straightGates) {
      // The conflicting through movement must come from a different
      // ROAD tha subject — not just a different rsl. Two lanes on the same
      // road (e.g. 13:0:5 and 13:0:4) point the same physical direction
      // and any "crossing" between their polylines is geometric noise,
      // not a genuine cross-traffic conflict. The XODR knows this
      // authoritatively via `lane.roadId`.
      const subjectApproach = topology.lanes[subject.approachLaneRsl];
      const npcApproach = topology.lanes[npc.approachLaneRsl];
      if (!subjectApproach || !npcApproach) continue;
      if (subjectApproach.roadId === npcApproach.roadId) continue;
      const npcBuild = buildGatePolyline(topology, npc);
      if (!npcBuild) continue;

      const conflict = strictChainIntersection(subjectBuild.chain, npcBuild.chain);
      if (!conflict) continue;
      // Reject conflicts that fall OUTSIDE the junction's interior —
      // those are crossings between the chain TAILS (exit lanes that
      // happen to meet at a downstream junction, or wrong-orientation
      // bugs). The genuine left-turn-vs-oncoming crossing always
      // happens inside the junction.
      if (junctionGeom) {
        const d = Math.hypot(
          conflict.point.x - junctionGeom.center.x,
          conflict.point.y - junctionGeom.center.y,
        );
        if (d > junctionConflictRadiusM) continue;
      }

      // The subject DECELERATES through the turn, so `speed x time` overshoots and it arrives
      // late (the NPC is long gone). Solve the run-up from the real speed profile instead.
      const subjectBackwardM = subjectRunUpDistanceForArrival(
        subjectBuild.chain.flatMap((c) => c.oriented),
        conflict.subjectArc,
        subjectSpeedKph,
        arrivalTimeS,
      );
      const npcBackwardM = (npcSpeedKph * arrivalTimeS) / 3.6;

      const subjectPlan = buildPlannedActorFromTopology(
        topology,
        subjectBuild.chain,
        conflict.subjectArc,
        subjectBackwardM,
        conflict.point,
        arrivalTimeS,
        { minApproachTimeS: TURN_MIN_APPROACH_TIME_S },
      );
      const npcPlan = buildPlannedActorFromTopology(
        topology,
        npcBuild.chain,
        conflict.npcArc,
        npcBackwardM,
        conflict.point,
        arrivalTimeS,
        { minApproachTimeS: TURN_MIN_APPROACH_TIME_S },
      );
      if (!subjectPlan || !npcPlan) continue;
      // Spawn-spread guard. Strict-intersection only verified the
      // CONFLICT lies in the junction; the SPAWN points can still land
      // inside each other's footprint when arrival time / speeds are
      // low or both predecessor walks dead-end on a short upstream
      // segment. Reject and let the loop try the next gate pair.
      if (spawnsTooClose(subjectPlan, npcPlan)) continue;
      // The conflicting through-movement must drive WITH traffic, not head-on
      // against it. A geometric crossing alone can select a straight gate whose
      // route runs backward down its lane — the "wrong-direction oncoming car"
      // dib flagged. Reject and let the loop try the next straight gate.
      if (!travelsWithLane(topology, npcPlan)) continue;

      return {
        conflictPoint: conflict.point,
        arrivalTimeS,
        subject: subjectPlan,
        npc: npcPlan,
        rationale:
          `${opts.label} (gate-driven) — junction ${junctionId}, ` +
          `subject ${turn} gate ${subject.id} (${subject.approachLaneRsl}→${subject.connectingLaneRsl}) ` +
          `crosses Straight gate ${npc.id} (${npc.approachLaneRsl}) at ` +
          `(${conflict.point.x.toFixed(1)}, ${conflict.point.y.toFixed(1)}); ` +
          `arrival ${arrivalTimeS.toFixed(1)}s.`,
        // Hand the validator the authoritative gate identity so
        // `maneuver_executed` can consult `turnRelation` directly
        // (instead of inferring turn from waypoint headings — which
        // misfires when collisions happen mid-turn).
        subjectGate: {
          junctionId,
          gateId: subject.id,
          turnRelation: subject.turnRelation,
          headingChangeRad: subject.headingChangeRad,
        },
      };
    }
  }

  return null;
}

/**
 * Gate-driven `unprotected_left_turn`: subject Left gate vs. the opposing
 * Straight through movement it crosses.
 */
export function planUnprotectedLeftTurnGated(
  args: GatedPlanArgs,
): PlannedCollision | null {
  return planGatedTurn(args, "Left", { label: "Unprotected left turn" });
}

/**
 * Gate-driven `right_turn_hook`: subject Right gate hooking a through movement
 * on its right — preferring a cyclist in the bike lane subject turns across.
 */
export function planRightTurnHookGated(
  args: GatedPlanArgs,
): PlannedCollision | null {
  return planGatedTurn(args, "Right", {
    preferBikeNpc: true,
    label: "Right-turn hook",
  });
}

/**
 * Non-junction driving lane whose midpoint sits closest to `center`.
 * Returns null when no qualifying lane exists. Bus / biking / parking
 * lanes are skipped — a rear-end on a parking lane is a configuration
 * error, not a scenario we want the planner to emit.
 */
function findNearestNonJunctionDrivingLane(
  topology: MapTopologyIndex,
  center: Vec2,
): TopologyLane | null {
  let best: { lane: TopologyLane; d: number } | null = null;
  for (const lane of Object.values(topology.lanes)) {
    if (lane.isJunction) continue;
    if (lane.laneType !== "driving") continue;
    if (lane.polyline.length < 2) continue;
    const mid = lane.polyline[Math.floor(lane.polyline.length / 2)]!;
    const d = dist(mid, center);
    if (!best || d < best.d) best = { lane, d };
  }
  return best?.lane ?? null;
}

/**
 * Orient `lane.polyline` in travel direction. Topology polylines are
 * stored reference-line s-increasing regardless of laneId sign, so a
 * positive-id lane's stored polyline runs backwards in travel. We use
 * the lane's predecessor (when present) as a "this is upstream" anchor:
 * orient so the polyline's FIRST point sits near a predecessor — that's
 * where travel enters. Falls back to the stored order when no
 * predecessor has geometry (lane that starts cold at the map edge).
 */
function orientLaneTravelDirection(
  topology: MapTopologyIndex,
  lane: TopologyLane,
): Vec2[] {
  if (lane.predecessors.length === 0) return [...lane.polyline];
  for (const predRsl of lane.predecessors) {
    const pred = topology.lanes[predRsl];
    if (!pred || pred.polyline.length === 0) continue;
    const predMid = pred.polyline[Math.floor(pred.polyline.length / 2)]!;
    // `orientPolylineTowards` puts the endpoint CLOSER to `near` LAST.
    // For travel direction we want the closer-to-predecessor endpoint
    // FIRST (that's where travel enters the lane), so reverse.
    return reversed(orientPolylineTowards(lane.polyline, predMid));
  }
  return [...lane.polyline];
}

/**
 * Tier-0 `rear_end` planner — single non-junction driving lane, two
 * actors traveling the same direction. NPC trails subject on the same lane
 * chain; both end at the same conflict point at `arrivalTimeS`. NPC
 * must travel farther tha subject in the same time, so its spawn lies
 * upstream of subject's by exactly `(npc_dist − subject_dist)` of chain arc.
 *
 * Implementation: orient the chosen lane in travel direction, build a
 * one-link chain on it, anchor the conflict at the chain's END, then
 * delegate per-actor placement to `buildPlannedActorFromTopology`.
 * That helper walks `lane.predecessors` upstream when a single lane
 * isn't long enough to fit the requested backward distance — reusing
 * the same chain machinery the turn solvers use.
 *
 * Returns null (caller → legacy planner) when:
 *   - documentCenter is not near any non-junction driving lane.
 *   - `subjectSpeedKph <= 0` — stopped-subject rear-ends are the largest sub-
 *     share of the corpus (FAMILY_EVENT_PRIOR.rear_end.subjectStoppedShare
 *     ≈ 0.638) but the current `buildPlannedActorFromTopology` rejects
 *     `backwardDistanceM <= 0`. Wiring stopped-subject support is queued
 *     alongside the rest of the FAMILY_EVENT_PRIOR integration; until
 *     then the stopped case falls through to the legacy grid.
 *   - `npcSpeedKph <= subjectSpeedKph` — without a relative speed delta the
 *     NPC never catches subject, so there is no rear-end.
 *   - the predecessor walk can't cover either backward distance.
 *   - the spawn-spread guard rejects the spawn pair (`npc_dist` only
 *     marginally above `subject_dist`).
 */
export function planRearEndTopology(
  args: GatedPlanArgs,
): PlannedCollision | null {
  const { topology, documentCenter, subjectSpeedKph, npcSpeedKph, arrivalTimeS } = args;
  if (subjectSpeedKph <= 0) return null;
  if (npcSpeedKph <= subjectSpeedKph) return null;

  const lane = findNearestNonJunctionDrivingLane(topology, documentCenter);
  if (!lane) return null;

  const oriented = orientLaneTravelDirection(topology, lane);
  if (oriented.length < 2) return null;
  const chain: Array<{ rsl: string; oriented: Vec2[] }> = [
    { rsl: lane.rsl, oriented },
  ];
  const conflictArc = polylineLength(oriented);
  const conflictPoint = oriented[oriented.length - 1]!;

  const subjectBackwardM = (subjectSpeedKph * arrivalTimeS) / 3.6;
  const npcBackwardM = (npcSpeedKph * arrivalTimeS) / 3.6;

  const subjectPlan = buildPlannedActorFromTopology(
    topology,
    chain,
    conflictArc,
    subjectBackwardM,
    conflictPoint,
    arrivalTimeS,
    { minApproachTimeS: TURN_MIN_APPROACH_TIME_S },
  );
  const npcPlan = buildPlannedActorFromTopology(
    topology,
    chain,
    conflictArc,
    npcBackwardM,
    conflictPoint,
    arrivalTimeS,
    { minApproachTimeS: TURN_MIN_APPROACH_TIME_S },
  );
  if (!subjectPlan || !npcPlan) return null;
  if (spawnsTooClose(subjectPlan, npcPlan)) return null;

  return {
    conflictPoint,
    arrivalTimeS,
    subject: subjectPlan,
    npc: npcPlan,
    rationale:
      `Rear-end (topology-driven) — non-junction lane ${lane.rsl}, ` +
      `subject ${subjectSpeedKph.toFixed(0)}kph + trailing NPC ${npcSpeedKph.toFixed(0)}kph ` +
      `same direction; conflict at lane end ` +
      `(${conflictPoint.x.toFixed(1)}, ${conflictPoint.y.toFixed(1)}); ` +
      `arrival ${arrivalTimeS.toFixed(1)}s.`,
    // Rear-end is a straight-line same-direction collision, not a
    // gated turn — leave `subjectGate` undefined so the validator's
    // `maneuver_executed` infers (correctly) from waypoint headings.
  };
}
