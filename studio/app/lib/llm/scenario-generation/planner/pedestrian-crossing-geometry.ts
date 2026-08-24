/**
 * Deterministic pedestrian crossing-line resolver.
 *
 * Implements the deterministic placement model: from the collision point, find
 * the nearest REAL pedestrian SURFACE — a crosswalk polygon, a sidewalk
 * line-string, or the carriageway curb — and spawn the walker there so it can
 * loiter and then cross THROUGH the collision point to meet the subject. Selection
 * is by distance to the ACTUAL geometry (nearest point on the line / polygon
 * edge), never a centroid; a generous centroid radius is only a pre-filter to
 * narrow the candidate set. Tiers, in priority order:
 *
 *   1. `crosswalk` — a crosswalk polygon AT the conflict point: the walker
 *      crosses ALONG it (the polygon's span across the road), through P.
 *   2. `sidewalk`  — the nearest **road-network sidewalk lane** (the same set
 *      the "Sidewalks" map layer renders — `LaneType ∈ {sidewalk, Sidewalk}`
 *      from the XODR-derived geojson; projected by the loader). Spawn at the
 *      nearest point on the line, cross straight toward and through P.
 *   3. `sidewalk`  — topology `sidewalk` LANES flanking the subject's road (XODR),
 *      a fallback when no geojson sidewalk was supplied.
 *   4. `poi`       — the nearest pedestrian POI point (bus stop / frontage):
 *      spawn at it, cross through P. A genuine fallback now that the real
 *      sidewalk set is wired in (sidewalks/crosswalks win for normal junctions).
 *   5. `road_edge` — the outermost drivable-lane edge (the carriageway curb).
 *
 * Per the placement model: "find the nearest sidewalk OR crosswalk OR POI." POIs
 * also BIAS which curb the perpendicular tiers spawn on (via `orient()`).
 *
 * For the sidewalk-line / POI tiers the crossing is `spawn → P → far`, where the
 * far endpoint resolves to the opposite sidewalk along the crossing ray when one
 * is mapped (so the walker finishes on a real curb instead of stopping
 * mid-carriageway on a near-miss) and otherwise mirrors the spawn across P. For
 * the crosswalk / road-edge tiers it is the curb-to-curb line through P along the
 * crossing axis. Either way the walker passes through the conflict point and the
 * planner's timing solver lands it there at the subject's ETA — the far endpoint is
 * always collinear with `spawn → P`, so lengthening it never shifts the meet
 * timing. Everything is in runtime-world meters; the loader projects WGS84
 * geometry via `MapProjection` before calling this. Returns `null` on degenerate
 * input so the planner can fall back to its legacy fixed crossing.
 */
import type { MapTopologyIndex, TopologyLane, Vec2 } from "@simcloud/shared";

const DRIVING_LANE_TYPES = new Set(["driving", "bidirectional"]);

/** Non-driving lanes that are still part of the paved cross-section, so their
 *  OUTER edge is the real carriageway boundary. `resolveSideCurb` used to see
 *  only sidewalk and driving lanes; on a road whose outermost sibling is a
 *  shoulder it therefore found nothing on that side, and the caller mirrored the
 *  FAR curb's offset instead — putting the walker metres outside the road. See
 *  the mirror note at the tier-3 fallback. */
const PAVED_EDGE_LANE_TYPES = new Set(["shoulder", "parking", "border", "restricted", "stop"]);

/** Pre-filter radius: only pedestrian geometries whose centroid is within this
 *  distance of the conflict point are searched. This narrows the candidate set;
 *  the ACTUAL spawn is the nearest point on the real geometry, never a centroid.
 *  Generous (≫ the old 8 m) so a real crosswalk/sidewalk a little off the
 *  conflict point is still considered. */
const SEARCH_RADIUS_M = 40;

/** A crosswalk is treated as "at the conflict point" when its nearest edge is
 *  within this distance of P (so we cross along it rather than walk to it).
 *  Tuned against real Yale St geometry: marked crossings sit 7–17 m from the
 *  conflict point (set back ~3 m from the junction on the approach lane), so
 *  the old 8 m gate rejected most real crosswalks. The crosswalk must still
 *  STRADDLE the conflict along the crossing axis, so this widens proximity,
 *  not alignment. */
const CROSSWALK_NEAR_M = 20;

/** Half a typical lane, used to extend the outermost driving-lane CENTRE to the
 *  carriageway edge when that side has no sidewalk lane. */
const DEFAULT_HALF_LANE_M = 1.75;

/** Degenerate guard: a resolved half-crossing below this is treated as no curb
 *  found on that side (topology tier). */
const MIN_HALF_M = 1.5;

/** A spawn closer than this to the conflict point is degenerate (no real
 *  crossing) and rejected. */
const MIN_SPAWN_DIST_M = 0.75;

/** A resolved far curb must lie at least this far past the conflict (along the
 *  crossing ray) to count — otherwise the walker wouldn't actually clear P. */
const MIN_FAR_DIST_M = MIN_SPAWN_DIST_M;

/** Max perpendicular deviation (m) of a far-curb candidate from the crossing
 *  ray. Keeps the far endpoint "straight across the road" rather than a sidewalk
 *  off to the side. */
const FAR_CORRIDOR_M = 6;

/** Max distance (m) past the conflict for a far curb to count as "across the
 *  road". Beyond this the nearest aligned sidewalk is almost certainly a
 *  parallel street down the crossing ray, not the opposite curb — so we keep the
 *  mirrored fallback rather than send the walker on a block-long march. A wide
 *  multi-lane junction crossing through a set-back conflict point stays under
 *  this. */
const MAX_FAR_DIST_M = 24;

export type CrossingSource = "crosswalk" | "sidewalk" | "poi" | "road_edge";

/** A crosswalk polygon already projected into runtime-world meters. */
export interface ProjectedCrosswalk {
  /** Polygon ring (runtime meters); first/last may or may not repeat. */
  ring: Vec2[];
}

/** A sidewalk centreline (Overture `sidewalk_segment`) projected to runtime m. */
export interface ProjectedSidewalk {
  /** Polyline of the sidewalk centreline (runtime meters). */
  polyline: Vec2[];
}

export interface ResolveCrossingArgs {
  topology: MapTopologyIndex;
  /** Conflict point on the subject lane centreline (runtime meters). */
  conflictPoint: Vec2;
  /** rsl of the subject's approach lane. */
  approachLaneRsl: string;
  /** Perpendicular crossing axis (radians). */
  crossingAxisRad: number;
  /** Crosswalk polygons near the conflict, projected to runtime meters. */
  crosswalks?: ProjectedCrosswalk[];
  /** Sidewalk centrelines near the conflict, projected to runtime meters. */
  sidewalks?: ProjectedSidewalk[];
  /** Pedestrian POI points (bus stop / transit / frontage), runtime meters. */
  poiPoints?: Vec2[];
  /** Override the candidate pre-filter radius (m). Default SEARCH_RADIUS_M. */
  searchRadiusM?: number;
}

export interface ResolvedCrossing {
  /** Walker spawn point = near curb / sidewalk / crosswalk end. */
  spawn: Vec2;
  /** Far curb point. */
  far: Vec2;
  source: CrossingSource;
  /** Signed lateral offset (m) of the spawn curb relative to the conflict. */
  spawnOffsetM: number;
  /** Signed lateral offset (m) of the far curb relative to the conflict. */
  farOffsetM: number;
}

// ── vector helpers ────────────────────────────────────────────────────────────

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Closest point on a polyline to `p`, and its distance. Exported for the
 *  turn-ped planner's driveway-mouth crossing (snapping the mouth crossing's
 *  half-extents onto the main road's sidewalk line). */
export function closestOnPolyline(
  poly: Vec2[],
  p: Vec2,
): { point: Vec2; dist: number } | null {
  if (poly.length === 0) return null;
  if (poly.length === 1) return { point: poly[0]!, dist: dist(poly[0]!, p) };
  let best: { point: Vec2; dist: number } | null = null;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const ab = sub(b, a);
    const len2 = dot(ab, ab);
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
    const point = { x: a.x + ab.x * t, y: a.y + ab.y * t };
    const d = dist(point, p);
    if (!best || d < best.dist) best = { point, dist: d };
  }
  return best;
}

/** Close a polygon ring (append the first vertex) so the closing edge is
 *  included in nearest-point / projection queries. */
function closedRing(ring: Vec2[]): Vec2[] {
  if (ring.length < 2) return ring;
  const a = ring[0]!;
  const b = ring[ring.length - 1]!;
  return a.x === b.x && a.y === b.y ? ring : [...ring, a];
}

// ── pedestrian-surface selection (actual geometry, not centroids) ──────────────

/**
 * The nearest crosswalk that lies AT the conflict point: its nearest edge is
 * within `CROSSWALK_NEAR_M` of P and its span across the road (projected onto
 * the crossing axis `u`) straddles P. Returns the curb-to-curb offsets along u.
 */
function crosswalkAtConflict(
  P: Vec2,
  u: Vec2,
  crosswalks: ProjectedCrosswalk[] | undefined,
): { lo: number; hi: number } | null {
  let best: { lo: number; hi: number; edge: number } | null = null;
  for (const cw of crosswalks ?? []) {
    if (cw.ring.length < 3) continue;
    const ring = closedRing(cw.ring);
    // Gate by the ACTUAL nearest edge distance, never the polygon centroid —
    // CROSSWALK_NEAR_M below is the real-geometry test.
    const near = closestOnPolyline(ring, P);
    if (!near || near.dist > CROSSWALK_NEAR_M) continue;
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of cw.ring) {
      const t = dot(sub(v, P), u);
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    if (lo < -MIN_HALF_M && hi > MIN_HALF_M && (!best || near.dist < best.edge)) {
      best = { lo, hi, edge: near.dist };
    }
  }
  return best ? { lo: best.lo, hi: best.hi } : null;
}

interface SpawnPick {
  point: Vec2;
  distM: number;
}

/** Nearest point on any of `polylines` to P, within `radiusM`. The filter is on
 *  the ACTUAL nearest distance, not the polyline centroid: a long sidewalk
 *  LineString can have a far centroid yet pass right next to P. */
function nearestPolylineSpawn(
  P: Vec2,
  polylines: Vec2[][] | undefined,
  radiusM: number,
): SpawnPick | null {
  let best: SpawnPick | null = null;
  for (const poly of polylines ?? []) {
    if (poly.length === 0) continue;
    const near = closestOnPolyline(poly, P);
    if (!near || near.dist < MIN_SPAWN_DIST_M || near.dist > radiusM) continue;
    if (!best || near.dist < best.distM) best = { point: near.point, distM: near.dist };
  }
  return best;
}

/** Nearest of `points` to P within radius (POI spawn). */
function nearestPointSpawn(P: Vec2, points: Vec2[] | undefined, radiusM: number): SpawnPick | null {
  let best: SpawnPick | null = null;
  for (const q of points ?? []) {
    const d = dist(q, P);
    if (d > radiusM || d < MIN_SPAWN_DIST_M) continue;
    if (!best || d < best.distM) best = { point: q, distM: d };
  }
  return best;
}

/**
 * Resolve the FAR curb for the spawn-then-cross tiers (sidewalk line, POI): the
 * nearest pedestrian surface on the FAR side of the conflict, along the crossing
 * ray, so the walker finishes the crossing on a curb instead of stopping
 * mid-carriageway (which looks wrong on a near-miss, where the subject passes and the
 * walker is left standing in the road). The result is collinear with `spawn → P`
 * and beyond P, so `dist(spawn, P)` — and therefore the meet-at-P timing — is
 * unchanged; only the post-conflict tail of the crossing lengthens. Returns null
 * when no far-side surface is found, so the caller keeps the mirrored fallback.
 */
function resolveFarCurb(
  P: Vec2,
  spawn: Vec2,
  polylines: Vec2[][] | undefined,
): Vec2 | null {
  const dlen = dist(P, spawn);
  if (dlen < MIN_SPAWN_DIST_M) return null;
  const d: Vec2 = { x: (P.x - spawn.x) / dlen, y: (P.y - spawn.y) / dlen };
  let bestAlong = Infinity;
  for (const poly of polylines ?? []) {
    if (poly.length === 0) continue;
    // No centroid prefilter — gate on the ACTUAL geometry below (a long sidewalk
    // can have a far centroid yet pass right across the conflict).
    const near = closestOnPolyline(poly, P);
    if (!near) continue;
    const along = dot(sub(near.point, P), d);
    if (along < MIN_FAR_DIST_M || along > MAX_FAR_DIST_M) continue; // far side, across the road
    const foot = { x: P.x + d.x * along, y: P.y + d.y * along };
    if (dist(near.point, foot) > FAR_CORRIDOR_M) continue; // roughly across
    if (along < bestAlong) bestAlong = along; // nearest far curb
  }
  if (!Number.isFinite(bestAlong)) return null;
  return { x: P.x + d.x * bestAlong, y: P.y + d.y * bestAlong };
}

/**
 * Cross straight from `spawn` through P. The far endpoint is resolved from real
 * geometry on the far side when `farPolylines` are supplied and one is found
 * (so the walker finishes on a curb); otherwise it mirrors the spawn across P.
 */
function crossThroughConflict(
  P: Vec2,
  pick: SpawnPick,
  source: CrossingSource,
  farPolylines?: Vec2[][],
): ResolvedCrossing {
  const far =
    (farPolylines ? resolveFarCurb(P, pick.point, farPolylines) : null) ??
    ({ x: 2 * P.x - pick.point.x, y: 2 * P.y - pick.point.y } as Vec2);
  return {
    spawn: pick.point,
    far,
    source,
    spawnOffsetM: -pick.distM,
    farOffsetM: dist(far, P),
  };
}

// ── topology side-curb fallback (perpendicular) ────────────────────────────────

interface SiblingOffset {
  lane: TopologyLane;
  offset: number;
}

function siblingOffsets(
  topology: MapTopologyIndex,
  approach: TopologyLane,
  conflict: Vec2,
  u: Vec2,
): SiblingOffset[] {
  const out: SiblingOffset[] = [];
  for (const lane of Object.values(topology.lanes)) {
    if (lane.roadId !== approach.roadId || lane.section !== approach.section) continue;
    if (lane.polyline.length === 0) continue;
    const near = closestOnPolyline(lane.polyline, conflict);
    if (!near) continue;
    out.push({ lane, offset: dot(sub(near.point, conflict), u) });
  }
  return out;
}

function resolveSideCurb(
  siblings: SiblingOffset[],
  side: 1 | -1,
): { offset: number; source: "sidewalk" | "road_edge" } | null {
  const onSide = siblings.filter((s) => Math.sign(s.offset) === side && Math.abs(s.offset) >= 0.05);

  const sidewalks = onSide
    .filter((s) => s.lane.laneType === "sidewalk")
    .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
  if (sidewalks[0] && Math.abs(sidewalks[0].offset) >= MIN_HALF_M) {
    return { offset: sidewalks[0].offset, source: "sidewalk" };
  }

  const driving = onSide
    .filter((s) => DRIVING_LANE_TYPES.has(s.lane.laneType))
    .sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
  if (driving[0]) {
    const edge = driving[0].offset + side * DEFAULT_HALF_LANE_M;
    if (Math.abs(edge) >= MIN_HALF_M) return { offset: edge, source: "road_edge" };
  }

  // The APPROACH lane is itself the outermost driving lane on this side, so the
  // filter above (which excludes the approach at |offset| >= 0.05) found
  // nothing. Take the outer edge of the outermost PAVED sibling — a shoulder,
  // parking or border lane is still road surface, and its far edge is the real
  // curb. Without this the caller mirrors the opposite curb across P, which is
  // how richmond leftped-313-6's walker was authored 3.0 m beyond the
  // carriageway onto off-network terrain.
  const paved = onSide
    .filter((s) => PAVED_EDGE_LANE_TYPES.has(s.lane.laneType))
    .sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
  if (paved[0]) {
    const w = laneHalfWidthM(paved[0].lane);
    const edge = paved[0].offset + side * w;
    if (Math.abs(edge) >= MIN_HALF_M) return { offset: edge, source: "road_edge" };
  }

  // Genuinely nothing on this side. Return null and let the caller mirror: on a
  // plain two-lane road with no shoulder, sidewalk or parking modelled, the
  // mirrored far curb IS the right answer and every existing crossing depends
  // on it. Do NOT substitute the approach lane's own half-width here — that
  // halves the crossing on ordinary roads and breaks the meet-timing solve.
  return null;
}

/** Half-width of a lane, from the topology when it carries one. Shoulders are
 *  narrow (0.5 m on Richmond); assuming a full traffic lane would overshoot the
 *  curb by ~1.2 m and reintroduce the same class of defect more quietly. */
function laneHalfWidthM(lane: TopologyLane): number {
  const w = lane.representativeWidthM;
  return typeof w === "number" && Number.isFinite(w) && w > 0
    ? w / 2
    : DEFAULT_HALF_LANE_M;
}

// ── main ──────────────────────────────────────────────────────────────────────

export function resolveCrossingLine(a: ResolveCrossingArgs): ResolvedCrossing | null {
  const { topology, conflictPoint: P, approachLaneRsl, crossingAxisRad } = a;
  const u: Vec2 = { x: Math.cos(crossingAxisRad), y: Math.sin(crossingAxisRad) };
  const radius = a.searchRadiusM ?? SEARCH_RADIUS_M;

  const approach = topology.lanes[approachLaneRsl];
  if (!approach) return null;

  // ── Tier 1: a crosswalk AT the conflict — cross ALONG it ────────────────────
  const cw = crosswalkAtConflict(P, u, a.crosswalks);
  if (cw) {
    return orient({ negOffset: cw.lo, posOffset: cw.hi, source: "crosswalk" }, P, u, a.poiPoints);
  }

  // ── Tier 2: nearest enrichment sidewalk line — spawn on it, cross through P ──
  // The FAR endpoint resolves to the opposite sidewalk (when mapped) so the
  // walker finishes on a real curb instead of stopping mid-road on a near-miss.
  const sidewalkLines = a.sidewalks?.map((s) => s.polyline);
  const sw = nearestPolylineSpawn(P, sidewalkLines, radius);
  if (sw) return crossThroughConflict(P, sw, "sidewalk", sidewalkLines);

  // ── Tier 3: topology sidewalk LANE (XODR) — wins over POI ───────────────────
  const siblings = siblingOffsets(topology, approach, P, u);
  const neg = resolveSideCurb(siblings, -1);
  const pos = resolveSideCurb(siblings, 1);
  let roadEdge: { negOffset: number; posOffset: number } | null = null;
  if (neg || pos) {
    // MIRROR OF LAST RESORT. `resolveSideCurb` now always returns something for
    // a side that has the approach lane on it, so this branch is reached only
    // for a genuinely one-sided cross-section. It used to fire routinely: on
    // Richmond road 37 the subject's own side holds only a 0.5 m shoulder, which
    // was neither `sidewalk` nor `driving`, so `pos` came back null and the
    // walker was authored at -(neg) = +5.25 m — 3.0 m PAST the carriageway
    // edge, onto an off-network RoadRunner surface with ~1 m of relief.
    //
    // It wedged there. Measured on leftped-313-6: 2.19 m of a 14.50 m planned
    // walk (15%), then 12.5 s of 0.00061 m/step creep at 89.7 deg to its
    // commanded heading — a tangential slide along a vertical face. All six
    // richmond leftped scenes in cpta-us-20260729-3d spawned on the mirrored
    // side (|midpoint - P| under 1.7 m in every case); completion ran 15-94%.
    // dib: "pedestrians are stuck just outside the wall of the building - never
    // seen this mode before."
    const negOffset = neg?.offset ?? -(pos!.offset);
    const posOffset = pos?.offset ?? -(neg!.offset);
    const isRoadEdge =
      neg?.source === "road_edge" || pos?.source === "road_edge" || !neg || !pos;
    if (!isRoadEdge) {
      return orient({ negOffset, posOffset, source: "sidewalk" }, P, u, a.poiPoints);
    }
    // Road-edge result: hold it and try a POI spawn before falling back.
    roadEdge = { negOffset, posOffset };
  }

  // ── Tier 4: nearest pedestrian POI — spawn at it, cross through P ────────────
  // "find the nearest sidewalk OR crosswalk OR POI": once the real sidewalk set
  // (road-network geojson) is wired in, sidewalks/crosswalks win for normal
  // junctions, so the POI tier is a genuine fallback (e.g. a bus stop where the
  // map models no sidewalk lane) rather than the default.
  const poi = nearestPointSpawn(P, a.poiPoints, radius);
  if (poi) return crossThroughConflict(P, poi, "poi", a.sidewalks?.map((s) => s.polyline));

  // ── Tier 5: carriageway curb (road edge) ────────────────────────────────────
  if (roadEdge) return orient({ ...roadEdge, source: "road_edge" }, P, u, a.poiPoints);
  return null;
}

/**
 * Place spawn/far for the perpendicular tiers (crosswalk span, topology lane,
 * road edge). POI bias decides which side is the spawn; with no POI, default to
 * the negative side for determinism.
 */
function orient(
  r: { negOffset: number; posOffset: number; source: CrossingSource },
  P: Vec2,
  u: Vec2,
  poiPoints: Vec2[] | undefined,
): ResolvedCrossing {
  let spawnSidePositive = false;

  const nearestPoi = (poiPoints ?? [])
    .map((q) => ({ q, t: dot(sub(q, P), u), d: dist(q, P) }))
    .sort((x, y) => x.d - y.d)[0];
  if (nearestPoi && Math.abs(nearestPoi.t) >= 0.05) {
    spawnSidePositive = nearestPoi.t > 0;
  }

  const spawnOffsetM = spawnSidePositive ? r.posOffset : r.negOffset;
  const farOffsetM = spawnSidePositive ? r.negOffset : r.posOffset;
  return {
    spawn: { x: P.x + u.x * spawnOffsetM, y: P.y + u.y * spawnOffsetM },
    far: { x: P.x + u.x * farOffsetM, y: P.y + u.y * farOffsetM },
    source: r.source,
    spawnOffsetM,
    farOffsetM,
  };
}
