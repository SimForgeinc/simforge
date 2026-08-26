import "server-only";

import Flatbush from "flatbush";
import type { MapSearchIndex, MapSearchIndexObject } from "@simforge-oss/studio-shared";

/**
 * In-memory spatial index over the `search_index.json` canonical objects.
 *
 * Built once per corpus-cache entry (same lifetime as the document list).
 * Internally projects WGS84 centroids/bboxes to a local equirectangular frame
 * in meters using a single origin lat — so every query radius is a real
 * "X meters" and flatbush sees a square coordinate space.
 *
 * Distances throughout the index are computed **bbox-to-bbox** (min distance
 * between two axis-aligned boxes), not centroid-to-centroid. That matters for
 * elongated objects like streets: a 300 m road whose nearest point sits 40 m
 * from a school has a centroid 150+ m away, and a centroid-only gate would
 * drop it from "bike lane near school" results.
 */

const M_PER_DEG_LAT = 110_540;

export interface SpatialIndex {
  /** Object ids, ordered to align with flatbush item indices. */
  readonly ids: readonly string[];
  /**
   * Range query centered on an lng/lat point with a radius in meters.
   * Returns canonical object ids whose projected bbox touches the disk.
   * The optional `filter` receives each candidate id and should return
   * `true` to keep it.
   */
  queryRange(
    centerLngLat: readonly [number, number],
    radiusM: number,
    filter?: (id: string) => boolean,
  ): string[];
  /**
   * k-nearest-neighbors query in lng/lat with an optional max radius cap.
   * Returns ids sorted by ascending bbox distance. `maxDistanceM` is
   * enforced in the local-meter frame, so small search radii are cheap.
   */
  queryKNN(
    centerLngLat: readonly [number, number],
    k: number,
    maxDistanceM?: number,
    filter?: (id: string) => boolean,
  ): Array<{ id: string; distanceM: number }>;
  /** Min distance (meters) between two canonical objects' projected bboxes. */
  pairDistanceM(a: string, b: string): number;
  /** Meters-per-degree factors used to derive this index (debug/tests). */
  readonly metersPerDegree: { lng: number; lat: number };
  /** Origin (lng, lat) used for the local-meter projection. */
  readonly origin: readonly [number, number];
}

interface ProjectedBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function pickOrigin(objects: MapSearchIndexObject[]): readonly [number, number] {
  // Use the bbox midpoint of all centroids so the projection error at any
  // object in the map is symmetric around the origin. A map spanning ~5 km
  // has <1 m projection drift with this choice.
  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  for (const obj of objects) {
    const [lng, lat] = obj.centroid;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) {
    return [0, 0];
  }
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
}

function projectBbox(
  obj: MapSearchIndexObject,
  origin: readonly [number, number],
  mPerDegLng: number,
): ProjectedBox {
  // Prefer the object's own bbox if present — a street's bbox spans its full
  // length, so proximity queries correctly account for "anywhere along this
  // street" rather than just the centroid. Fall back to a point bbox at the
  // centroid for objects without one.
  const [originLng, originLat] = origin;
  if (obj.bbox) {
    const [minLng, minLat, maxLng, maxLat] = obj.bbox;
    return {
      minX: (minLng - originLng) * mPerDegLng,
      minY: (minLat - originLat) * M_PER_DEG_LAT,
      maxX: (maxLng - originLng) * mPerDegLng,
      maxY: (maxLat - originLat) * M_PER_DEG_LAT,
    };
  }
  const [lng, lat] = obj.centroid;
  const x = (lng - originLng) * mPerDegLng;
  const y = (lat - originLat) * M_PER_DEG_LAT;
  return { minX: x, minY: y, maxX: x, maxY: y };
}

/** Min distance from a point to an axis-aligned bbox, in the same units. */
function pointToBoxDistance(
  px: number,
  py: number,
  box: ProjectedBox,
): number {
  const dx = px < box.minX ? box.minX - px : px > box.maxX ? px - box.maxX : 0;
  const dy = py < box.minY ? box.minY - py : py > box.maxY ? py - box.maxY : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Min distance between two axis-aligned bboxes, in the same units. */
function boxToBoxDistance(a: ProjectedBox, b: ProjectedBox): number {
  const dx =
    a.maxX < b.minX
      ? b.minX - a.maxX
      : b.maxX < a.minX
        ? a.minX - b.maxX
        : 0;
  const dy =
    a.maxY < b.minY
      ? b.minY - a.maxY
      : b.maxY < a.minY
        ? a.minY - b.maxY
        : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Build a flatbush-backed spatial index from the sidecar's object catalog.
 * Returns a stub with zero-length `ids` when the catalog is empty — callers
 * should short-circuit before running queries but the methods are safe to
 * invoke regardless (always return empty results).
 */
export function buildSpatialIndex(sidecar: MapSearchIndex): SpatialIndex {
  const objects = Object.values(sidecar.objects);
  const origin = pickOrigin(objects);
  const mPerDegLng = 111_320 * Math.cos((origin[1] * Math.PI) / 180);

  if (objects.length === 0) {
    return emptySpatialIndex(origin, mPerDegLng);
  }

  const ids: string[] = new Array(objects.length);
  const boxes: ProjectedBox[] = new Array(objects.length);
  const idToIndex = new Map<string, number>();
  const flatbush = new Flatbush(objects.length);

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i]!;
    ids[i] = obj.id;
    idToIndex.set(obj.id, i);
    const box = projectBbox(obj, origin, mPerDegLng);
    boxes[i] = box;
    flatbush.add(box.minX, box.minY, box.maxX, box.maxY);
  }
  flatbush.finish();

  function toLocal(lng: number, lat: number): [number, number] {
    return [(lng - origin[0]) * mPerDegLng, (lat - origin[1]) * M_PER_DEG_LAT];
  }

  return {
    ids,
    metersPerDegree: { lng: mPerDegLng, lat: M_PER_DEG_LAT },
    origin,
    queryRange(centerLngLat, radiusM, filter) {
      if (radiusM <= 0) return [];
      const [cx, cy] = toLocal(centerLngLat[0], centerLngLat[1]);
      const wrappedFilter = filter
        ? (idx: number, _x0: number, _y0: number, _x1: number, _y1: number) =>
            filter(ids[idx]!)
        : undefined;
      // Flatbush's `search` is an AABB query — it returns every item whose
      // bbox intersects the `radius × radius` square around the center.
      // That's a superset of the disk; we tighten it with point-to-bbox
      // distance so elongated items (e.g. a long street whose bbox enters
      // the disk but whose centroid is far outside it) are preserved.
      const hits = flatbush.search(
        cx - radiusM,
        cy - radiusM,
        cx + radiusM,
        cy + radiusM,
        wrappedFilter,
      );
      const out: string[] = [];
      for (const idx of hits) {
        if (pointToBoxDistance(cx, cy, boxes[idx]!) <= radiusM) {
          out.push(ids[idx]!);
        }
      }
      return out;
    },
    queryKNN(centerLngLat, k, maxDistanceM, filter) {
      if (k <= 0) return [];
      const [cx, cy] = toLocal(centerLngLat[0], centerLngLat[1]);
      const wrappedFilter = filter
        ? (idx: number) => filter(ids[idx]!)
        : undefined;
      // Flatbush's `neighbors` ranks by centroid distance. We keep its
      // ordering cheap and re-compute bbox distance when returning so
      // callers see the semantically-correct distance for elongated items.
      const maxDist = maxDistanceM ?? Number.POSITIVE_INFINITY;
      const hits = flatbush.neighbors(cx, cy, k, maxDist, wrappedFilter);
      const out: Array<{ id: string; distanceM: number }> = [];
      for (const idx of hits) {
        const d = pointToBoxDistance(cx, cy, boxes[idx]!);
        if (d <= maxDist) out.push({ id: ids[idx]!, distanceM: d });
      }
      // Re-sort by bbox distance since flatbush sorted by centroid distance.
      out.sort((a, b) => a.distanceM - b.distanceM);
      return out;
    },
    pairDistanceM(a, b) {
      const idxA = idToIndex.get(a);
      const idxB = idToIndex.get(b);
      if (idxA === undefined || idxB === undefined) return Number.POSITIVE_INFINITY;
      return boxToBoxDistance(boxes[idxA]!, boxes[idxB]!);
    },
  };
}

function emptySpatialIndex(
  origin: readonly [number, number],
  mPerDegLng: number,
): SpatialIndex {
  return {
    ids: [],
    metersPerDegree: { lng: mPerDegLng, lat: M_PER_DEG_LAT },
    origin,
    queryRange() {
      return [];
    },
    queryKNN() {
      return [];
    },
    pairDistanceM() {
      return Number.POSITIVE_INFINITY;
    },
  };
}
