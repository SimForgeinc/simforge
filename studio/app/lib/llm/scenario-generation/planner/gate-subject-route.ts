/**
 * Gate → subject route math, extracted from `gated-collision-planner.ts` so it
 * can be reused by the pedestrian-crossing planner (and any future planner
 * that needs "build the subject polyline from a topology gate").
 *
 * Everything here is a pure function of topology data — no server I/O.
 * The module intentionally has no "server-only" guard so unit tests can
 * import it without a Next.js server context.
 */
import type { MapTopologyIndex, TopologyGate, TopologyLane, Vec2 } from "@simcloud/shared";
import type { PlannedActor } from "@/app/lib/llm/scenario-generation/collision-route-planner";

// ── Polyline utilities ──────────────────────────────────────────────────────

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polylineLength(poly: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) {
    len += dist(poly[i - 1]!, poly[i]!);
  }
  return len;
}

/** Reverse a copy of `poly`. */
export function reversed(poly: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (let i = poly.length - 1; i >= 0; i--) out.push(poly[i]!);
  return out;
}

/**
 * Orient `poly` so its FIRST point is the one farther from `near` and its
 * LAST point is closer (= adjacent to the neighbor `near` lives in). Used
 * to chain lane polylines end-to-end regardless of how the topology builder
 * stored them (always reference-line s-increasing, regardless of sign).
 */
export function orientPolylineTowards(poly: readonly Vec2[], near: Vec2): Vec2[] {
  if (poly.length < 2) return [...poly];
  const dStart = dist(poly[0]!, near);
  const dEnd = dist(poly[poly.length - 1]!, near);
  return dEnd <= dStart ? [...poly] : reversed(poly);
}

/**
 * Orient a lane's stored polyline to the lane's TRAVEL direction.
 *
 * `TopologyLane.polyline` is sampled strictly in reference-line `+s` order for
 * every lane, but positive-id lanes (left of the reference line, right-hand
 * traffic) travel OPPOSITE `+s` — the same convention `laneTravelHeadingChange`
 * codifies in the topology builder. Consumers that use a lane polyline as a
 * DRIVING path (not as a link to be joint-oriented by `orientPolylineTowards`)
 * must go through this, or a positive-id lane authors the route wrong-way from
 * its very first waypoint (allfam-avoid 2026-08-01: 7/16 wrong-way ledger rows
 * were ped-midblock scenes built from the raw polyline).
 *
 * `laneId` is read from the lane node when present, else parsed from the RSL
 * (`road:section:lane`) so sparse test topologies keep working.
 */
export function orientLanePolylineToTravel(
  rsl: string,
  lane: { laneId?: number; polyline: readonly Vec2[] },
): Vec2[] {
  const laneId = lane.laneId ?? Number(rsl.split(":")[2] ?? 0);
  return laneId > 0 ? reversed(lane.polyline) : [...lane.polyline];
}

/** Flatten a chain to a single polyline, dropping duplicate joint
 *  vertices. ONLY used for conflict-finding (where we just need a
 *  geometric path to intersect another). Arc math for spawn placement
 *  goes through `arcPositionOnChain`, which walks link-by-link so
 *  joint gaps (topology lanes' endpoints can be off by metres because
 *  XODR/sample rounding) don't accumulate into phantom path length. */
export function concatChain(chain: ReadonlyArray<{ oriented: Vec2[] }>): Vec2[] {
  const out: Vec2[] = [];
  for (const link of chain) {
    for (const v of link.oriented) {
      const last = out[out.length - 1];
      if (!last || last.x !== v.x || last.y !== v.y) out.push({ x: v.x, y: v.y });
    }
  }
  return out;
}

/**
 * Find the world point + heading at a given arc length from the start of
 * a polyline.
 */
export function arcPositionOnPolyline(
  poly: readonly Vec2[],
  arcLength: number,
): { point: Vec2; yawRad: number; segmentIdx: number; tWithinSegment: number } | null {
  if (poly.length < 2) return null;
  if (arcLength <= 0) {
    const a = poly[0]!;
    const b = poly[1]!;
    return {
      point: { x: a.x, y: a.y },
      yawRad: Math.atan2(b.y - a.y, b.x - a.x),
      segmentIdx: 0,
      tWithinSegment: 0,
    };
  }
  let consumed = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const segLen = dist(a, b);
    if (segLen < 1e-9) continue;
    if (consumed + segLen >= arcLength) {
      const t = (arcLength - consumed) / segLen;
      return {
        point: { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) },
        yawRad: Math.atan2(b.y - a.y, b.x - a.x),
        segmentIdx: i - 1,
        tWithinSegment: t,
      };
    }
    consumed += segLen;
  }
  // Beyond the end — clamp to the last vertex.
  const a = poly[poly.length - 2]!;
  const b = poly[poly.length - 1]!;
  return {
    point: { x: b.x, y: b.y },
    yawRad: Math.atan2(b.y - a.y, b.x - a.x),
    segmentIdx: poly.length - 2,
    tWithinSegment: 1,
  };
}

/**
 * Position + heading at arc `arc` along a chain, where arc is measured
 * as the sum of individual link arc lengths (NOT the concat polyline's
 * length). Joint gaps between links contribute zero arc — the chain
 * "teleports" across them. Returns the link index + arc-within-link so
 * the caller can also recover the rsl, plus a clamped point.
 */
export function arcPositionOnChain(
  chain: ReadonlyArray<{ rsl: string; oriented: Vec2[] }>,
  arc: number,
): {
  point: Vec2;
  yawRad: number;
  linkIdx: number;
  arcWithinLink: number;
  linkLength: number;
} | null {
  if (chain.length === 0) return null;
  let consumed = 0;
  for (let li = 0; li < chain.length; li++) {
    const link = chain[li]!;
    const linkLen = polylineLength(link.oriented);
    if (consumed + linkLen >= arc || li === chain.length - 1) {
      const within = Math.max(0, Math.min(linkLen, arc - consumed));
      const pos = arcPositionOnPolyline(link.oriented, within);
      if (!pos) return null;
      return {
        point: pos.point,
        yawRad: pos.yawRad,
        linkIdx: li,
        arcWithinLink: within,
        linkLength: linkLen,
      };
    }
    consumed += linkLen;
  }
  return null;
}

/**
 * Slice a chain between two arc positions, producing a single polyline
 * along the "real" path (joint gaps removed). Each link contributes its
 * portion; we walk each link's polyline from the relevant arcs and
 * concatenate, dropping joint-gap segments entirely. Result's
 * polylineLength() equals (arcEnd - arcStart) exactly.
 */
export function chainSlice(
  chain: ReadonlyArray<{ rsl: string; oriented: Vec2[] }>,
  arcStart: number,
  arcEnd: number,
): Vec2[] {
  if (arcEnd <= arcStart) return [];
  const startPos = arcPositionOnChain(chain, arcStart);
  const endPos = arcPositionOnChain(chain, arcEnd);
  if (!startPos || !endPos) return [];
  const out: Vec2[] = [{ x: startPos.point.x, y: startPos.point.y }];

  for (let li = startPos.linkIdx; li <= endPos.linkIdx; li++) {
    const link = chain[li]!;
    const sliceStart = li === startPos.linkIdx ? startPos.arcWithinLink : 0;
    const sliceEnd =
      li === endPos.linkIdx
        ? endPos.arcWithinLink
        : polylineLength(link.oriented);
    if (sliceEnd <= sliceStart) continue;
    // Walk this link's polyline from sliceStart to sliceEnd.
    let consumed = 0;
    for (let i = 1; i < link.oriented.length; i++) {
      const a = link.oriented[i - 1]!;
      const b = link.oriented[i]!;
      const segLen = dist(a, b);
      if (segLen < 1e-9) continue;
      const segStartArc = consumed;
      const segEndArc = consumed + segLen;
      if (segEndArc <= sliceStart) {
        consumed += segLen;
        continue;
      }
      if (segStartArc >= sliceEnd) break;
      // Determine entry and exit points within this segment.
      const entry = Math.max(sliceStart, segStartArc);
      const exit = Math.min(sliceEnd, segEndArc);
      const tEntry = (entry - segStartArc) / segLen;
      const tExit = (exit - segStartArc) / segLen;
      if (entry > sliceStart || li > startPos.linkIdx) {
        // First point of this link section — push the entry point IF
        // it's not the very first slice point (which we already
        // pushed) and we're crossing a link boundary.
        const px = a.x + tEntry * (b.x - a.x);
        const py = a.y + tEntry * (b.y - a.y);
        const last = out[out.length - 1]!;
        if (last.x !== px || last.y !== py) out.push({ x: px, y: py });
      }
      // Push exit point.
      const ex = a.x + tExit * (b.x - a.x);
      const ey = a.y + tExit * (b.y - a.y);
      const last = out[out.length - 1]!;
      if (last.x !== ex || last.y !== ey) out.push({ x: ex, y: ey });
      consumed += segLen;
      if (segEndArc >= sliceEnd) break;
    }
  }
  return out;
}

/** Heading at the END of a polyline (from second-to-last → last). */
export function polylineExitHeading(poly: readonly Vec2[]): number {
  const a = poly[poly.length - 2]!;
  const b = poly[poly.length - 1]!;
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Heading at the START of a polyline (from first → second). */
export function polylineEntryHeading(poly: readonly Vec2[]): number {
  const a = poly[0]!;
  const b = poly[1]!;
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export function normPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

// ── Gate polyline builder ───────────────────────────────────────────────────

/**
 * Build a connected gate path: approach + connecting + first-exit
 * polylines, oriented end-to-end so the chain reads from
 * "well before junction" → through the junction → "past junction".
 * Returns null when any required lane lacks a polyline.
 *
 * Orientation strategy: anchor the connecting lane's segments by their
 * geometric meeting points. The connecting lane is short and sits inside
 * the junction; its two endpoints are the approach-side and the exit-side
 * meeting points. Orient the connecting lane so the endpoint nearer the
 * APPROACH lane's centroid comes first; then orient the approach so its
 * end touches connecting.start, and the exit so its start touches
 * connecting.end. Endpoint-proximity at every step.
 */
export function buildGatePolyline(
  topology: MapTopologyIndex,
  gate: TopologyGate,
): { chain: Array<{ rsl: string; oriented: Vec2[] }>; flat: Vec2[] } | null {
  const approach = topology.lanes[gate.approachLaneRsl];
  const connecting = topology.lanes[gate.connectingLaneRsl];
  if (!approach || !connecting) return null;
  if (approach.polyline.length < 2 || connecting.polyline.length < 2) return null;

  // Anchor: connecting lane's approach-side endpoint should be the one
  // nearer to the approach lane's centroid.
  const approachCentroid =
    approach.polyline[Math.floor(approach.polyline.length / 2)]!;
  const connectingOriented = orientPolylineTowards(
    connecting.polyline,
    approachCentroid,
  );
  // Now connectingOriented[length-1] is the approach-side meeting point.
  // Wait — orientPolylineTowards puts the FAR endpoint first, NEAR last.
  // So connectingOriented[last] is closer to approachCentroid. That makes
  // connectingOriented[last] the "approach side" of the connecting lane.
  // We want the chain to read approach → connecting → exit, so we need
  // the approach to end at connectingOriented[0] (the FAR end from the
  // approach centroid? no — the near end). Let me re-derive.
  //
  // The connecting lane has two endpoints: A (touches approach) and B
  // (touches exit). The approach's centroid is far from BOTH because the
  // approach lane is long and the connecting lane is small, BUT it's
  // FAR LESS far from A than from B. orientPolylineTowards puts the
  // closer endpoint LAST → connectingOriented[last] = A.
  //
  // For the chain "approach → connecting → exit", connecting must be
  // ordered so A comes FIRST (entry) and B comes LAST (exit). So we
  // need to reverse the result.
  const connOriented = reversed(connectingOriented);
  // Now connOriented[0] = A (approach meeting point), connOriented[last] = B.

  const approachOriented = orientPolylineTowards(approach.polyline, connOriented[0]!);
  // approachOriented[last] should be near connOriented[0].

  const chain: Array<{ rsl: string; oriented: Vec2[] }> = [
    { rsl: approach.rsl, oriented: approachOriented },
    { rsl: connecting.rsl, oriented: connOriented },
  ];

  // Optional exit lane. Selection is guarded (dib 2026-07-10 review):
  //  - laneType must be DRIVING — the first-with-polyline pick could land on a
  //    BIKE lane, and the avoided subject's appended exit path then IS the bike-lane
  //    centerline ("ends up in the rightmost bike lane after the left turn").
  //  - heading continuity — the exit walked away from the junction must CONTINUE
  //    the connecting lane's exit heading (dot > 0.2); a same-endpoint lane of the
  //    cross street's OPPOSITE direction otherwise passes the positional
  //    orientation and the subject "veers into the wrong lane after the turn".
  const connEnd = connOriented[connOriented.length - 1]!;
  const connHdg =
    connOriented.length >= 2
      ? {
          x: connEnd.x - connOriented[connOriented.length - 2]!.x,
          y: connEnd.y - connOriented[connOriented.length - 2]!.y,
        }
      : null;
  const connHdgLen = connHdg ? Math.hypot(connHdg.x, connHdg.y) || 1 : 1;
  // CLOSEST lane wins (dib r10 review: "subject should turn left onto the closest
  // left lane — this should be captured in the actual map's lane connections").
  // exitLaneRsls comes from the XODR lane links but can carry several
  // candidates (multiple succIds, or the same-lane-id fallback guess); taking
  // the FIRST valid one sometimes landed a lane-width or more off the
  // connecting lane's delivery point — the subject then swept wide across the
  // exit road (r10 left-4207-9 veered into the bike lane). Among the valid
  // candidates, pick the one whose entry endpoint is nearest connEnd — that
  // IS the lane the junction connection physically delivers into.
  let bestExit: { rsl: string; oriented: Vec2[]; gap: number } | null = null;
  for (const exitRsl of gate.exitLaneRsls) {
    const exit = topology.lanes[exitRsl];
    if (!exit || exit.polyline.length < 2) continue;
    // Skip KNOWN non-driving lanes (biking/sidewalk/shoulder). An absent/empty
    // laneType (synthetic fixtures) is accepted — real topology lanes always
    // carry the XODR type.
    const exitLaneType = (exit.laneType || "").toLowerCase();
    if (exitLaneType && exitLaneType !== "driving") continue;
    const exitOriented = orientPolylineTowards(exit.polyline, connEnd);
    // exitOriented[0] should be near connOriented[last] = B → reverse.
    const exitFinal = reversed(exitOriented);
    if (connHdg && exitFinal.length >= 2) {
      const dx = exitFinal[1]!.x - exitFinal[0]!.x;
      const dy = exitFinal[1]!.y - exitFinal[0]!.y;
      const dl = Math.hypot(dx, dy) || 1;
      const dot = (dx * connHdg.x + dy * connHdg.y) / (dl * connHdgLen);
      if (dot < 0.2) continue; // doubles back / wrong-direction lane
    }
    const entry = exitFinal[0]!;
    const gap = Math.hypot(entry.x - connEnd.x, entry.y - connEnd.y);
    if (!bestExit || gap < bestExit.gap) {
      bestExit = { rsl: exit.rsl, oriented: exitFinal, gap };
    }
  }
  if (bestExit) {
    chain.push({ rsl: bestExit.rsl, oriented: bestExit.oriented });
  }

  const flat = concatChain(chain);
  if (flat.length < 2) return null;

  // Reject gate chains that are NOT a clean left/right turn. The per-lane guards above
  // keep the exit CONTINUOUS with the connecting lane, but nothing bounds the OVERALL
  // approach → exit turn — so a junction whose "left" connecting lane arcs ~180° (a
  // U-turn connection) or an exit route that winds around a block passes every check and
  // the subject U-turns / loops instead of turning (dib 2026-07-25 US crosswalk-turn review:
  // leftped-611-8 planned a 180° exit, leftped-202-11 wound 270°; both are legal-direction
  // but the WRONG maneuver for a "turn left + ped crossing" scene). A real left/right turn
  // nets ~90°; cap the net at MAX_NET_TURN_DEG and total winding at MAX_WINDING_DEG.
  // Downsample to ~2 m before measuring winding so dense-polyline heading noise can't
  // inflate it. Fail-closed: an unmeasurable chain is kept (older/synthetic fixtures).
  const MAX_NET_TURN_DEG = 135;
  const MAX_WINDING_DEG = 200;
  const STEP_M = 2;
  const wrapDeg = (d: number): number => (((d + 180) % 360) + 360) % 360 - 180;
  const hdgDeg = (a: Vec2, b: Vec2): number => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const ds: Vec2[] = [flat[0]!];
  for (const p of flat) {
    const last = ds[ds.length - 1]!;
    if (Math.hypot(p.x - last.x, p.y - last.y) >= STEP_M) ds.push(p);
  }
  if (ds[ds.length - 1] !== flat[flat.length - 1]) ds.push(flat[flat.length - 1]!);
  if (ds.length >= 3) {
    const net = Math.abs(wrapDeg(hdgDeg(ds[ds.length - 2]!, ds[ds.length - 1]!) - hdgDeg(ds[0]!, ds[1]!)));
    let winding = 0;
    for (let i = 2; i < ds.length; i++) {
      winding += wrapDeg(hdgDeg(ds[i - 1]!, ds[i]!) - hdgDeg(ds[i - 2]!, ds[i - 1]!));
    }
    if (net > MAX_NET_TURN_DEG || Math.abs(winding) > MAX_WINDING_DEG) return null;
  }
  return { chain, flat };
}

// ── Predecessor walk ────────────────────────────────────────────────────────

/**
 * Walk topology predecessors upstream of `startRsl` until accumulated
 * length is `≥ neededM` or no predecessors remain. Each emitted lane
 * is oriented so its END abuts the prior lane's upstream end.
 *
 * Selection priority (per step):
 *   1. **Non-junction first.** A junction-internal lane as predecessor
 *      would be one of the OTHER connecting lanes of the same junction
 *      we're trying to leave (gate edges are mirrored in
 *      `lane.predecessors`) — picking one would chain subject BACK INTO
 *      the junction interior. Always prefer non-junction; only fall
 *      back to a junction-internal lane when no non-junction
 *      predecessor exists (rare: lane that genuinely starts inside a
 *      junction with no upstream road).
 *   2. **Heading alignment at the joint.** When multiple non-junction
 *      candidates share an exact endpoint at `currentUpstream` (common
 *      when the approach lane sits between two junctions, with N
 *      different connecting lanes all listed as its predecessors), the
 *      tie-break is whichever predecessor enters at a heading that
 *      best continues the current lane's heading at the joint — the
 *      smoothest chain. Without this, the walk picks an arbitrary
 *      junction connector and introduces a 50°+ kink at the joint.
 *   3. **Endpoint proximity** (final tie-break).
 *
 * `entryHdgRad` is the heading the current chain leaves the current
 * lane's upstream end at — i.e. the direction of travel *toward* the
 * predecessor we're picking. Pass `null` for the first step (no
 * meaningful entry heading on the very first predecessor).
 */
export function walkPredecessorsBackward(
  topology: MapTopologyIndex,
  startRsl: string,
  startUpstreamPoint: Vec2,
  startEntryHdg: number | null,
  neededM: number,
  opts?: {
    allowReversal?: boolean;
    /** Optional semantic-authority boundary for predecessor expansion. */
    allowedRsls?: ReadonlySet<string>;
  },
): { chain: Array<{ rsl: string; oriented: Vec2[] }>; totalLen: number } {
  // Forward-only by default: the subject must have a continuous forward run-up, so
  // reversing predecessors (the oncoming lane, cross-traffic) are rejected
  // rather than soft-ranked. This keeps `totalLen`/`room` honest (genuine
  // forward distance) and prevents the subject path from U-turning to manufacture
  // run-up at sites whose forward segment is too short. Set `allowReversal` only
  // for families that intentionally back up (e.g. a car pulling out of a parking
  // spot) — most families are forward-motion.
  const allowReversal = opts?.allowReversal ?? false;
  // A predecessor whose exit heading differs from our entry heading by more than
  // this is a reversal / cross-street lane, not a forward continuation.
  const MAX_FORWARD_TURN_RAD = Math.PI / 2;

  const chain: Array<{ rsl: string; oriented: Vec2[] }> = [];
  if (neededM <= 0) return { chain, totalLen: 0 };

  const visited = new Set<string>([startRsl]);
  let currentRsl = startRsl;
  let currentUpstream = startUpstreamPoint;
  let entryHdg = startEntryHdg;
  let total = 0;

  while (total < neededM) {
    const lane = topology.lanes[currentRsl];
    if (!lane) break;
    const candidates = lane.predecessors
      .filter(
        (r) =>
          !visited.has(r) &&
          (!opts?.allowedRsls || opts.allowedRsls.has(r)),
      )
      .map((r) => topology.lanes[r])
      .filter((l): l is TopologyLane => !!l && l.polyline.length >= 2);
    if (candidates.length === 0) break;

    const nonJ = candidates.filter((l) => !l.isJunction);
    const usable = nonJ.length > 0 ? nonJ : candidates;

    // Score each candidate by (heading mismatch, endpoint distance).
    // Heading mismatch is the absolute angular difference between the
    // candidate's exit heading (toward currentUpstream) and `entryHdg`
    // — small = smooth joint.
    const scored = usable.map((cand) => {
      const oriented = orientPolylineTowards(cand.polyline, currentUpstream);
      const exitHdg = polylineExitHeading(oriented);
      const headingMismatch =
        entryHdg == null
          ? 0
          : Math.abs(normPi(exitHdg - entryHdg));
      const endptDist = dist(
        oriented[oriented.length - 1]!,
        currentUpstream,
      );
      return { cand, oriented, headingMismatch, endptDist };
    });
    // Forward-only gate: drop reversals before choosing. When the entry heading
    // isn't known yet (first hop with a null heading) we can't judge direction,
    // so we don't filter — callers needing a strictly forward run-up pass the
    // approach heading. If every remaining predecessor reverses, this is a
    // genuine forward dead-end: stop the walk here rather than U-turning.
    let pool = scored;
    if (!allowReversal && entryHdg != null) {
      const forward = scored.filter(
        (s) => s.headingMismatch <= MAX_FORWARD_TURN_RAD,
      );
      if (forward.length === 0) break;
      pool = forward;
    }

    // Sort: heading first (within a 60° tolerance band), then endpoint distance.
    pool.sort((a, b) => {
      const aBucket = a.headingMismatch < Math.PI / 3 ? 0 : 1;
      const bBucket = b.headingMismatch < Math.PI / 3 ? 0 : 1;
      if (aBucket !== bBucket) return aBucket - bBucket;
      if (Math.abs(a.headingMismatch - b.headingMismatch) > 0.1) {
        return a.headingMismatch - b.headingMismatch;
      }
      return a.endptDist - b.endptDist;
    });

    const picked = pool[0]!;
    chain.unshift({ rsl: picked.cand.rsl, oriented: picked.oriented });
    total += polylineLength(picked.oriented);
    // Next iteration: continue back from this predecessor's FAR end,
    // and we'll be looking for a smoother continuation of THIS
    // predecessor's heading at its far end.
    entryHdg = polylineEntryHeading(picked.oriented);
    currentRsl = picked.cand.rsl;
    currentUpstream = picked.oriented[0]!;
    visited.add(picked.cand.rsl);
  }
  return { chain, totalLen: total };
}

// ── Backward walk → PlannedActor ────────────────────────────────────────────

/**
 * Wrap up a planned actor by scaling `expectedSpeedKph` to the
 * polyline's ACTUAL arc length / planned arrival time.
 *
 * Why: the polyline naturally includes joint-bridging segments —
 * consecutive topology lanes have endpoints up to a few metres apart
 * (OpenDRIVE rounding + the topology builder's per-lane sampling),
 * and concatenation has to bridge those gaps. Without scaling, the
 * kinematic sim would integrate `speed × time` against the intended
 * `backwardDistanceM` but the actor would actually traverse the
 * longer real polyline — under-shooting the conflict at the planned
 * arrival (the "missed by N m" failure mode).
 *
 * Family-default speeds become a hint for run-up sizing, not a hard
 * constraint on sim speed. Trade-off: the actor's actual speed
 * deviates from the family default by the ratio of (polyline length)
 * to (intended arc). For typical 5 m of joint gap across a 100 m
 * polyline, that's a 5 % speed delta — well inside natural traffic
 * variation, and well worth the timing precision.
 */
function finalizePlannedActor(args: {
  spawnLaneId: string;
  spawnSFraction: number;
  spawnPoint: Vec2;
  spawnYaw: number;
  waypoints: Vec2[];
  arrivalTimeS: number;
  postConflictWaypoints?: Vec2[];
}): PlannedActor {
  const polyLen = polylineLength(args.waypoints);
  const scaledSpeedKph = (polyLen / Math.max(1e-3, args.arrivalTimeS)) * 3.6;
  return {
    spawnLaneId: args.spawnLaneId,
    spawnSFraction: args.spawnSFraction,
    spawnPoint: args.spawnPoint,
    spawnYaw: args.spawnYaw,
    waypoints: args.waypoints,
    expectedSpeedKph: scaledSpeedKph,
    arcLengthM: polyLen,
    postConflictWaypoints:
      args.postConflictWaypoints && args.postConflictWaypoints.length >= 2
        ? args.postConflictWaypoints
        : undefined,
  };
}

/**
 * From a conflict position inside `gateChain` (at arc-length
 * `conflictArc` from chain start), back-walk `backwardDistanceM`
 * meters. Extends the chain upstream via topology predecessors when the
 * approach lane alone isn't long enough.
 */
export function buildPlannedActorFromTopology(
  topology: MapTopologyIndex,
  gateChain: ReadonlyArray<{ rsl: string; oriented: Vec2[] }>,
  conflictArc: number,
  backwardDistanceM: number,
  conflictPoint: Vec2,
  arrivalTimeS: number,
  opts?: {
    allowedPredecessorRsls?: ReadonlySet<string>;
    /** Absolute floor (seconds) on the REALISED approach — see the check below. */
    minApproachTimeS?: number;
  },
): PlannedActor | null {
  if (gateChain.length === 0 || backwardDistanceM <= 0) return null;

  // The rest of the turn PAST the conflict — the connecting/exit-lane centerline
  // from the conflict to the end of the gate chain. The avoided variant appends this
  // so the subject completes a proper turn into the exit lane instead of overshooting
  // (dib 2026-07-09). Empty when the conflict sits at/after the chain end.
  const chainTotalArc = polylineLength(concatChain(gateChain));
  const postConflictWaypoints =
    conflictArc < chainTotalArc - 0.5
      ? chainSlice(gateChain, conflictArc, chainTotalArc)
      : [];

  // Target spawn arc relative to gateChain start. May be negative — then
  // we need to walk predecessors.
  const targetArcInChain = conflictArc - backwardDistanceM;

  if (targetArcInChain >= 0) {
    // Spawn lies within the gate chain proper.
    const spawn = arcPositionOnChain(gateChain, targetArcInChain);
    if (!spawn) return null;
    const waypoints = chainSlice(gateChain, targetArcInChain, conflictArc);
    if (waypoints.length === 0) return null;
    const last = waypoints[waypoints.length - 1]!;
    if (last.x !== conflictPoint.x || last.y !== conflictPoint.y) {
      waypoints.push({ x: conflictPoint.x, y: conflictPoint.y });
    }
    const sFraction = spawn.linkLength > 0 ? spawn.arcWithinLink / spawn.linkLength : 0;
    return finalizePlannedActor({
      spawnLaneId: gateChain[spawn.linkIdx]!.rsl,
      spawnSFraction: sFraction,
      spawnPoint: { x: spawn.point.x, y: spawn.point.y },
      spawnYaw: spawn.yawRad,
      waypoints,
      arrivalTimeS,
      postConflictWaypoints,
    });
  }

  // Need to walk predecessors to make up the deficit.
  const deficit = -targetArcInChain;
  const approachStart = gateChain[0]!.oriented[0]!;
  // Heading the chain LEAVES the approach lane at its upstream end —
  // i.e. the heading the predecessor's far end should match.
  const approachEntryHdg =
    gateChain[0]!.oriented.length >= 2
      ? polylineEntryHeading(gateChain[0]!.oriented)
      : null;
  const { chain: predChain, totalLen: predTotalLen } = walkPredecessorsBackward(
    topology,
    gateChain[0]!.rsl,
    approachStart,
    approachEntryHdg,
    deficit,
    { allowedRsls: opts?.allowedPredecessorRsls },
  );
  if (predTotalLen <= 0) {
    // Dead-end predecessor walk — refuse rather than emit a spawn at
    // approach.start (which would be a sub-`MIN_RUNUP_FRACTION` run-up).
    // Belt with the validator's t≈0 / mistimed guard.
    return null;
  }
  // After prepending, new chain = predChain + gateChain. The conflict
  // arc in the NEW chain = predTotalLen + conflictArc.
  // The spawn arc in the new chain = predTotalLen - deficit.
  const newChain = [...predChain, ...gateChain];
  const newConflictArc = predTotalLen + conflictArc;
  const newSpawnArc = Math.max(0, predTotalLen - deficit);

  // If predTotalLen < deficit, we couldn't cover the full backward
  // distance — reject if the achieved run-up is sub-50% of the request
  // (mirrors `MIN_RUNUP_FRACTION` in collision-route-planner).
  const achievedRunup = newConflictArc - newSpawnArc;
  if (achievedRunup < 0.5 * backwardDistanceM) return null;

  // ABSOLUTE floor on the REALISED approach, in seconds.
  //
  // The fraction above is relative to whatever was requested, so it cannot
  // express "this scene needs N seconds of approach": a turn family requesting a
  // 4 s arrival still passes at half of it, which renders as a conflict ~2 s
  // after spawn — dib 2026-07-30, "in some scenes the collision happens in the
  // first 1-2 seconds, immediately after spawn". `generateCollisionScenarioBatch`
  // reaches its unprotected-left / right-hook sites through THIS function, not
  // `buildPlannedActorFromBackwardWalk`, so the floor added there never ran on
  // the emitting path.
  //
  // Opt-in rather than blanket, deliberately. The implied speed is
  // `backwardDistanceM / arrivalTimeS`, so a floor of F seconds is equivalent to
  // demanding `achievedRunup >= backwardDistanceM * F / arrivalTimeS`. At the
  // pedestrian families' 5 s arrival a 3 s floor would mean a 0.6 fraction —
  // stricter than the 0.5 those families are tuned for, and it rejects sites they
  // currently emit. Callers that want the floor pass it.
  const minApproachTimeS = opts?.minApproachTimeS;
  if (minApproachTimeS !== undefined && arrivalTimeS > 0) {
    const impliedSpeedMps = backwardDistanceM / arrivalTimeS;
    if (impliedSpeedMps > 0 && achievedRunup / impliedSpeedMps < minApproachTimeS) {
      return null;
    }
  }

  const spawn = arcPositionOnChain(newChain, newSpawnArc);
  if (!spawn) return null;
  const waypoints = chainSlice(newChain, newSpawnArc, newConflictArc);
  if (waypoints.length === 0) return null;
  const last = waypoints[waypoints.length - 1]!;
  if (last.x !== conflictPoint.x || last.y !== conflictPoint.y) {
    waypoints.push({ x: conflictPoint.x, y: conflictPoint.y });
  }
  const sFraction = spawn.linkLength > 0 ? spawn.arcWithinLink / spawn.linkLength : 0;
  return finalizePlannedActor({
    spawnLaneId: newChain[spawn.linkIdx]!.rsl,
    spawnSFraction: sFraction,
    spawnPoint: { x: spawn.point.x, y: spawn.point.y },
    spawnYaw: spawn.yawRad,
    waypoints,
    arrivalTimeS,
    // The post-conflict continuation lives in the ORIGINAL gate chain (forward of the
    // conflict), unaffected by the predecessor prepend that only extended the run-up.
    postConflictWaypoints,
  });
}

// ── New composed helper ─────────────────────────────────────────────────────

export interface BuildSubjectRouteArgs {
  topology: MapTopologyIndex;
  gate: TopologyGate;
  conflictArc: number;
  conflictPoint: Vec2;
  backwardDistanceM: number;
  arrivalTimeS: number;
}

/**
 * High-level helper: build the subject `PlannedActor` from a single gate.
 * Composes `buildGatePolyline` + `buildPlannedActorFromTopology`.
 * Returns null when the gate chain can't be resolved or the backward walk
 * fails.
 */
export function buildSubjectRouteFromGate(a: BuildSubjectRouteArgs): PlannedActor | null {
  const built = buildGatePolyline(a.topology, a.gate);
  if (!built) return null;
  return buildPlannedActorFromTopology(
    a.topology,
    built.chain,
    a.conflictArc,
    a.backwardDistanceM,
    a.conflictPoint,
    a.arrivalTimeS,
  );
}
