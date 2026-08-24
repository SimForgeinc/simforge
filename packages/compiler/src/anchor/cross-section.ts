/**
 * Cross-section queries: "standing on lane X at arc length s, what is beside
 * me?"
 *
 * Three things this module has to get right, all of them observed defects in
 * the raw data rather than theory:
 *
 * 1. **`adjacentLanes.left/right` is road-relative, not travel-relative.** For a
 *    lane whose travel runs against OpenDRIVE `s` the labels are inverted. Side
 *    is therefore decided geometrically (sign of the cross product against the
 *    travel-ordered reference polyline) and the links are used only as one
 *    source of connectivity.
 * 2. **`adjacentLanes` is sparse and never crosses the centreline.** On Yale
 *    only 100 of 622 driving lanes carry any adjacency at all, and a two-way
 *    road section's `-1` and `+1` lanes are not linked to each other. Relying on
 *    it alone would report every corridor as one lane wide with no opposing
 *    traffic.
 * 3. **Opposing traffic is often a different road entirely** (split
 *    carriageways), so same-`roadId` grouping is not enough either.
 *
 * The answer is nearest-neighbour *chaining* over a coarse spatial grid: step
 * outward lane by lane, accepting the next centreline while the lateral gap
 * stays below {@link MAX_LANE_GAP_M}. A median, a verge or the 15 m to the
 * parallel street ends the chain naturally.
 */

import { headingAtS, projectPoint, pointAtS, angleDiff } from './geometry.js';
import type { DerivedLane, LaneRsl, Point2 } from './types/map-index.js';

/** Largest centre-to-centre lateral gap that still counts as "the next lane". */
export const MAX_LANE_GAP_M = 6;
/** Radius of the cross-section query. */
export const CROSS_SECTION_RADIUS_M = 26;
/** Grid cell size for the lane lookup. */
const GRID_CELL_M = 25;

export interface NeighborLane {
  rsl: LaneRsl;
  laneType: string;
  sameDirection: boolean;
  /** Signed lateral offset from the reference lane: positive = left of travel. */
  lateralM: number;
}

export interface CrossSection {
  referenceRsl: LaneRsl;
  s: number;
  /** Same-direction driving lanes by signed k (0 = reference, +1 = one left). */
  sameDirDriving: Map<number, LaneRsl>;
  /** Opposing driving lanes, innermost first. */
  opposingDriving: LaneRsl[];
  /** Every lane reached by the chain, ordered left to right. */
  neighbors: NeighborLane[];
  laneWidthM: number;
  speedLimitKph: number;
}

/** Width of a lane at travel-order arc length `s`, linearly interpolated. */
export function laneWidthAt(lane: DerivedLane, s: number): number {
  const samples = lane.widthSamples;
  if (samples.length === 0) return lane.representativeWidthM;
  if (samples.length === 1) return (samples[0] as { widthM: number }).widthM;
  const clamped = Math.min(Math.max(s, samples[0]!.s), samples[samples.length - 1]!.s);
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (clamped <= b.s) {
      const span = b.s - a.s;
      const t = span <= 1e-9 ? 0 : (clamped - a.s) / span;
      return a.widthM + (b.widthM - a.widthM) * t;
    }
  }
  return samples[samples.length - 1]!.widthM;
}

type LaneRecord = Record<LaneRsl, DerivedLane>;

/** Uniform grid over lane polyline vertices, built once per lane table. */
const gridCache = new WeakMap<object, Map<string, LaneRsl[]>>();

const cellKey = (x: number, y: number): string =>
  `${Math.floor(x / GRID_CELL_M)}:${Math.floor(y / GRID_CELL_M)}`;

function laneGrid(lanes: LaneRecord): Map<string, LaneRsl[]> {
  const cached = gridCache.get(lanes as object);
  if (cached) return cached;
  const grid = new Map<string, LaneRsl[]>();
  for (const rsl of Object.keys(lanes).sort()) {
    const lane = lanes[rsl];
    if (!lane) continue;
    const seen = new Set<string>();
    for (const p of lane.polyline) {
      const key = cellKey(p.x, p.y);
      if (seen.has(key)) continue;
      seen.add(key);
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(rsl);
    }
  }
  gridCache.set(lanes as object, grid);
  return grid;
}

function lanesNear(lanes: LaneRecord, at: Point2, radius: number): LaneRsl[] {
  const grid = laneGrid(lanes);
  const found = new Set<LaneRsl>();
  const span = Math.ceil(radius / GRID_CELL_M);
  const cx = Math.floor(at.x / GRID_CELL_M);
  const cy = Math.floor(at.y / GRID_CELL_M);
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dy = -span; dy <= span; dy += 1) {
      for (const rsl of grid.get(`${cx + dx}:${cy + dy}`) ?? []) found.add(rsl);
    }
  }
  return [...found].sort();
}

/**
 * The cross-section at `(laneRsl, s)`.
 *
 * `s` is arc length **along the lane's travel-ordered polyline**.
 */
export function crossSectionAt(
  lanes: LaneRecord,
  laneRsl: LaneRsl,
  s: number,
): CrossSection | null {
  const ref = lanes[laneRsl];
  if (!ref || ref.polyline.length < 2) return null;
  const at = pointAtS(ref.polyline, s);
  const refHeading = headingAtS(ref.polyline, s);

  // Candidate lanes: everything nearby, plus the declared adjacency links (they
  // are accurate where present) and the rest of this road section.
  const candidates = new Set<LaneRsl>(lanesNear(lanes, at, CROSS_SECTION_RADIUS_M));
  for (const ref2 of [ref.adjacentLanes.left.laneRsl, ref.adjacentLanes.right.laneRsl]) {
    if (ref2 && lanes[ref2]) candidates.add(ref2);
  }
  candidates.delete(laneRsl);

  const measured: NeighborLane[] = [];
  for (const otherRsl of [...candidates].sort()) {
    const other = lanes[otherRsl];
    if (!other || other.polyline.length < 2) continue;
    if (other.isJunction) continue; // junction-internal lanes are not a cross-section
    const proj = projectPoint(other.polyline, at);
    if (proj.distance > CROSS_SECTION_RADIUS_M) continue;
    const otherHeading = headingAtS(other.polyline, proj.s);
    const delta = Math.abs(angleDiff(otherHeading, refHeading));
    // Parallel or anti-parallel only: a crossing street is not a neighbour.
    const parallel = delta < Math.PI / 8 || delta > Math.PI - Math.PI / 8;
    if (!parallel) continue;
    const otherPoint = pointAtS(other.polyline, proj.s);
    const back = projectPoint(ref.polyline, otherPoint);
    // Reject lanes that are ahead/behind rather than beside: their nearest point
    // must sit essentially at our own station.
    if (Math.abs(back.s - s) > MAX_LANE_GAP_M * 3) continue;
    measured.push({
      rsl: otherRsl,
      laneType: other.laneType,
      sameDirection: delta < Math.PI / 2,
      lateralM: back.side * back.distance,
    });
  }

  // Chain outward, lane by lane, stopping at the first gap wider than one lane.
  const chainSide = (side: 1 | -1): NeighborLane[] => {
    const pool = measured
      .filter((n) => Math.sign(n.lateralM) === side)
      .sort((a, b) => Math.abs(a.lateralM) - Math.abs(b.lateralM) || (a.rsl < b.rsl ? -1 : 1));
    const accepted: NeighborLane[] = [];
    let previous = 0;
    for (const candidate of pool) {
      const gap = Math.abs(candidate.lateralM) - previous;
      if (gap > MAX_LANE_GAP_M) break;
      // Two lanes at (almost) the same offset: keep the first, skip the copy.
      if (gap < 0.3 && accepted.length > 0) continue;
      accepted.push(candidate);
      previous = Math.abs(candidate.lateralM);
    }
    return accepted;
  };

  const neighbors = [...chainSide(1), ...chainSide(-1)].sort((a, b) => b.lateralM - a.lateralM);

  // `k` counts **contiguous same-direction driving lanes**. The chain stops at
  // the first neighbour that is not one: a bike lane, a shoulder, a sidewalk or
  // the opposing carriageway. Without that rule the chain happily walks across
  // a shoulder into the opposing lanes and out the far side, reporting eight
  // "same-direction" lanes at a two-lane approach (observed on Yale 31:0:-6).
  const sameDirDriving = new Map<number, LaneRsl>([[0, laneRsl]]);
  const takeThrough = (side: 1 | -1): NeighborLane[] => {
    const ordered = neighbors
      .filter((n) => Math.sign(n.lateralM) === side)
      .sort((a, b) => Math.abs(a.lateralM) - Math.abs(b.lateralM));
    const out: NeighborLane[] = [];
    for (const n of ordered) {
      if (!n.sameDirection || n.laneType !== 'driving') break;
      out.push(n);
    }
    return out;
  };
  takeThrough(1).forEach((n, i) => sameDirDriving.set(i + 1, n.rsl));
  takeThrough(-1).forEach((n, i) => sameDirDriving.set(-(i + 1), n.rsl));

  const opposingDriving = neighbors
    .filter((n) => !n.sameDirection && n.laneType === 'driving')
    .sort((a, b) => Math.abs(a.lateralM) - Math.abs(b.lateralM))
    .map((n) => n.rsl);

  return {
    referenceRsl: laneRsl,
    s,
    sameDirDriving,
    opposingDriving,
    neighbors,
    laneWidthM: laneWidthAt(ref, s),
    speedLimitKph: ref.speedLimitKph,
  };
}

/** Adjacent-kind vocabulary present at a cross-section (matcher clause units). */
export function adjacentKinds(cs: CrossSection): string[] {
  const kinds = new Set<string>();
  for (const n of cs.neighbors) {
    if (n.laneType === 'driving') {
      if (!n.sameDirection) kinds.add('opposing');
      continue;
    }
    if (n.laneType === 'parking') kinds.add('parking');
    else if (n.laneType === 'biking') kinds.add('biking');
    else if (n.laneType === 'sidewalk') kinds.add('sidewalk');
    else if (n.laneType === 'shoulder') kinds.add('shoulder');
    else if (n.laneType === 'median' || n.laneType === 'restricted') kinds.add('median');
  }
  return [...kinds].sort();
}
