/**
 * Footprint overlap between two placed actors.
 *
 * Actors are rectangles in plan: a centre, a heading, and the catalog's real
 * `l` x `w`. Circles would be far too generous for a 20 m semi-trailer and far
 * too mean for a pedestrian, so this is a proper oriented-box test — the
 * separating-axis theorem over the four box normals, which for two rectangles is
 * exact and takes about twenty multiplies.
 *
 * The margin is applied as a *clearance*, i.e. both boxes are inflated by half
 * of it, so `margin = 0.3` means "these two things end up at least 30 cm apart".
 */

/** An actor footprint in the scene's XZ plane. */
export interface Footprint {
  /** Centre X in scene metres. */
  x: number;
  /** Centre Z in scene metres. */
  z: number;
  /** Extent along the heading, metres (catalog `dims.l`). */
  length: number;
  /** Extent across the heading, metres (catalog `dims.w`). */
  width: number;
  /** Radians CCW about +Y from +X. */
  headingRad: number;
}

/** Axis projections reused across calls; overlap testing is on the hot path. */
const _axes: number[] = [0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Do two footprints overlap once inflated by `margin` metres of clearance?
 *
 * @param margin Total clearance required between the two boxes. Default `0.3`.
 */
export function footprintsOverlap(a: Footprint, b: Footprint, margin = 0.3): boolean {
  // Heading h points along (cos h, -sin h) in the (x, z) plane; the cross axis
  // is that rotated 90 degrees.
  const half = margin / 2;
  const ax = Math.cos(a.headingRad);
  const az = -Math.sin(a.headingRad);
  const bx = Math.cos(b.headingRad);
  const bz = -Math.sin(b.headingRad);

  _axes[0] = ax;
  _axes[1] = az;
  _axes[2] = -az;
  _axes[3] = ax;
  _axes[4] = bx;
  _axes[5] = bz;
  _axes[6] = -bz;
  _axes[7] = bx;

  const aHalfL = a.length / 2 + half;
  const aHalfW = a.width / 2 + half;
  const bHalfL = b.length / 2 + half;
  const bHalfW = b.width / 2 + half;

  const dx = b.x - a.x;
  const dz = b.z - a.z;

  for (let i = 0; i < 8; i += 2) {
    const nx = _axes[i] as number;
    const nz = _axes[i + 1] as number;
    // Projected half-extent of each box onto this axis.
    const ra = aHalfL * Math.abs(ax * nx + az * nz) + aHalfW * Math.abs(-az * nx + ax * nz);
    const rb = bHalfL * Math.abs(bx * nx + bz * nz) + bHalfW * Math.abs(-bz * nx + bx * nz);
    if (Math.abs(dx * nx + dz * nz) > ra + rb) return false; // separating axis found
  }
  return true;
}

/** Cheap reject before the SAT test: bounding circles. */
export function withinRange(a: Footprint, b: Footprint, margin = 0.3): boolean {
  const ra = Math.hypot(a.length, a.width) / 2;
  const rb = Math.hypot(b.length, b.width) / 2;
  const reach = ra + rb + margin;
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2 <= reach * reach;
}

/**
 * The first footprint in `others` that `probe` collides with, or `null`.
 *
 * @param skipId Ignore the actor being moved (it always overlaps itself).
 */
export function firstOverlap<T extends Footprint & { id: string }>(
  probe: Footprint,
  others: readonly T[],
  margin = 0.3,
  skipIds?: ReadonlySet<string>,
): T | null {
  for (const other of others) {
    if (skipIds?.has(other.id)) continue;
    if (!withinRange(probe, other, margin)) continue;
    if (footprintsOverlap(probe, other, margin)) return other;
  }
  return null;
}
