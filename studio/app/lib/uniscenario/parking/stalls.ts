/**
 * Parking stalls, extracted from the road-network GeoJSON.
 *
 * The painted rectangles on the ground are `Type: "ParkingSpace"` polygon
 * features in the per-map RoadRunner GeoJSON. They are not in the XODR —
 * RoadRunner's `<object>` export is dropped per map, and Di Rosa's XODR carries
 * zero objects while its GeoJSON carries 859 stalls (see
 * `apps/web/app/lib/maps/topology/server/environment-objects.ts`). The semantic
 * map only references parking as a derived `parking_space` context kind.
 *
 * Measured over Di Rosa's 859 stalls: every one is a true 4-corner rectangle,
 * long axis median 4.96 m (p05 4.07, p95 5.52), short axis median 2.58 m, and
 * `EntryPosition` sits at the midpoint of one short edge — its bearing from the
 * centroid is along the long axis for 855 of 859. So a stall determines both a
 * car's axis and which way it faces.
 */

export const PARKING_STALL_SCHEMA_VERSION = 1;

/**
 * One stall, in the **scene** frame the editor and `ActorView` use.
 *
 * The projection (`MapProjection.geoToLocal`) yields the z-up runtime frame
 * `{x east, y north}`; the scene is that frame embedded y-up, so `x` carries
 * over and `z = -runtime.y` (the conversion used by
 * `@simforge/playback` staticMapColliders and `control-plan.server.ts`). `headingRad` is
 * numerically identical in both frames: the model defines it as CCW about +Y
 * from +X where heading `h` points along `(cos h, sin h)` z-up, which is
 * `(cos h, -sin h)` in scene `(x, z)`.
 */
export interface ParkingStall {
  readonly id: string;
  /** Stall centre, scene metres. */
  readonly x: number;
  readonly z: number;
  /** Ground height at the stall, metres, averaged over the polygon vertices. */
  readonly y: number;
  /** Direction a nose-in car faces. */
  readonly headingRad: number;
  /** Long axis — how much car length the stall accepts. */
  readonly lengthM: number;
  /** Short axis — how much car width the stall accepts. */
  readonly widthM: number;
  /** False when the stall had no usable `EntryPosition` and the nose direction is arbitrary. */
  readonly facingKnown: boolean;
}

export interface ParkingStallArtifact {
  readonly schemaVersion: number;
  readonly mapAssetId: string;
  readonly stalls: readonly ParkingStall[];
  /** Features that looked like stalls but could not be reduced to a rectangle. */
  readonly skipped: number;
}

/** lng/lat to runtime metres. `lngLatToRuntimePoint` bound to one asset. */
export type RuntimeProjection = (
  lng: number,
  lat: number,
) => { x: number; y: number } | null;

interface Corner {
  readonly x: number;
  readonly y: number;
  readonly elevation: number;
}

/**
 * Drop the closing duplicate and any repeated vertex. RoadRunner writes closed
 * rings, so a 4-corner stall arrives as 5 positions.
 */
function distinctRing(
  ring: readonly (readonly number[])[],
  project: RuntimeProjection,
): Corner[] | null {
  const corners: Corner[] = [];
  for (const position of ring) {
    const lng = position[0];
    const lat = position[1];
    if (typeof lng !== "number" || typeof lat !== "number") return null;
    const point = project(lng, lat);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const elevation = typeof position[2] === "number" ? position[2] : 0;
    const duplicate = corners.some(
      (corner) =>
        Math.abs(corner.x - point.x) < 1e-6 && Math.abs(corner.y - point.y) < 1e-6,
    );
    if (!duplicate) corners.push({ x: point.x, y: point.y, elevation });
  }
  return corners;
}

/** Longest and shortest edge of a closed quad, with the long edge's bearing. */
function axes(corners: readonly Corner[]) {
  let longest = { length: -Infinity, bearing: 0 };
  let shortest = { length: Infinity, bearing: 0 };
  for (let index = 0; index < corners.length; index += 1) {
    const from = corners[index]!;
    const to = corners[(index + 1) % corners.length]!;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    const bearing = Math.atan2(dy, dx);
    if (length > longest.length) longest = { length, bearing };
    if (length < shortest.length) shortest = { length, bearing };
  }
  return { longest, shortest };
}

function normalizeHeading(value: number): number {
  const twoPi = Math.PI * 2;
  return ((value % twoPi) + twoPi) % twoPi;
}

/**
 * A stall's own geometry, before any car is chosen. Exported for tests: it is
 * the one place the coordinate and rotation conventions are applied.
 */
export function stallFromRing(
  id: string,
  ring: readonly (readonly number[])[],
  entryPosition: readonly number[] | null,
  project: RuntimeProjection,
): ParkingStall | null {
  const corners = distinctRing(ring, project);
  // Fewer than 4 corners is not a rectangle; more than 4 means RoadRunner
  // emitted something this feature has never seen, and guessing an axis for it
  // would place a car at an angle nobody authored.
  if (!corners || corners.length !== 4) return null;

  const { longest, shortest } = axes(corners);
  if (!(longest.length > 0) || !(shortest.length > 0)) return null;

  const centre = corners.reduce(
    (accumulator, corner) => ({
      x: accumulator.x + corner.x / corners.length,
      y: accumulator.y + corner.y / corners.length,
      elevation: accumulator.elevation + corner.elevation / corners.length,
    }),
    { x: 0, y: 0, elevation: 0 },
  );

  let heading = longest.bearing;
  let facingKnown = false;
  if (entryPosition) {
    const lng = entryPosition[0];
    const lat = entryPosition[1];
    if (typeof lng === "number" && typeof lat === "number") {
      const entry = project(lng, lat);
      if (entry && Number.isFinite(entry.x) && Number.isFinite(entry.y)) {
        const toEntryX = entry.x - centre.x;
        const toEntryY = entry.y - centre.y;
        const alongAxis =
          toEntryX * Math.cos(heading) + toEntryY * Math.sin(heading);
        // A nose-in car faces away from the stall's mouth.
        if (alongAxis > 0) heading += Math.PI;
        facingKnown = Math.hypot(toEntryX, toEntryY) > 1e-3;
      }
    }
  }

  // Millimetre / microradian precision. Far finer than any placement a user can
  // perform and orders of magnitude below the map pipeline's own calibration
  // residual, and it keeps the served artifact small: full float precision more
  // than doubles it for no usable accuracy.
  return {
    id,
    x: Math.round(centre.x * 1e3) / 1e3,
    z: Math.round(-centre.y * 1e3) / 1e3,
    y: Math.round(centre.elevation * 1e3) / 1e3,
    headingRad: Math.round(normalizeHeading(heading) * 1e6) / 1e6,
    lengthM: Math.round(longest.length * 1e3) / 1e3,
    widthM: Math.round(shortest.length * 1e3) / 1e3,
    facingKnown,
  };
}

interface GeoJsonLike {
  readonly features?: readonly {
    readonly properties?: Record<string, unknown> | null;
    readonly geometry?: {
      readonly type?: string;
      readonly coordinates?: unknown;
    } | null;
  }[];
}

function stallId(properties: Record<string, unknown> | null | undefined, index: number): string {
  const raw = properties?.["Id"] ?? properties?.["id"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.replace(/[{}]/g, "");
  }
  return `stall-${index}`;
}

function entryPositionOf(
  properties: Record<string, unknown> | null | undefined,
): readonly number[] | null {
  const raw = properties?.["EntryPosition"];
  return Array.isArray(raw) && raw.length >= 2 ? (raw as readonly number[]) : null;
}

/** Every `ParkingSpace` polygon in a road-network GeoJSON, as placeable stalls. */
export function extractParkingStalls(
  geojson: unknown,
  project: RuntimeProjection,
): { stalls: ParkingStall[]; skipped: number } {
  const features = (geojson as GeoJsonLike | null)?.features;
  if (!Array.isArray(features)) return { stalls: [], skipped: 0 };

  const stalls: ParkingStall[] = [];
  let skipped = 0;
  let index = 0;
  for (const feature of features) {
    const type = feature?.properties?.["Type"] ?? feature?.properties?.["type"];
    if (type !== "ParkingSpace") continue;
    index += 1;

    const geometryType = feature?.geometry?.type;
    const coordinates = feature?.geometry?.coordinates;
    // A MultiPolygon stall would be one stall with several rings; take the
    // first, which is the outer ring of the first part.
    const ring =
      geometryType === "Polygon"
        ? (coordinates as readonly (readonly number[])[][] | undefined)?.[0]
        : geometryType === "MultiPolygon"
          ? (coordinates as readonly (readonly number[])[][][] | undefined)?.[0]?.[0]
          : undefined;
    if (!Array.isArray(ring)) {
      skipped += 1;
      continue;
    }

    const stall = stallFromRing(
      stallId(feature?.properties, index),
      ring,
      entryPositionOf(feature?.properties),
      project,
    );
    if (stall) stalls.push(stall);
    else skipped += 1;
  }
  return { stalls, skipped };
}
