import type { Bbox } from "@simforge-oss/scenario/contracts";

export type { Bbox };

function walkCoords(node: unknown): [number, number][] {
  if (
    Array.isArray(node) &&
    node.length >= 2 &&
    typeof node[0] === "number" &&
    typeof node[1] === "number"
  ) {
    return [[node[0], node[1]]];
  }
  if (Array.isArray(node)) {
    return node.flatMap(walkCoords);
  }
  return [];
}

export function bboxFromCoords(coords: [number, number][]): Bbox {
  const lngs = coords.map(([lng]) => lng);
  const lats = coords.map(([, lat]) => lat);
  return {
    min_lat: Math.min(...lats),
    min_lng: Math.min(...lngs),
    max_lat: Math.max(...lats),
    max_lng: Math.max(...lngs),
  };
}

export function clipBbox(bbox: Bbox, clipTo: Bbox): Bbox | null {
  const clipped: Bbox = {
    min_lat: Math.max(bbox.min_lat, clipTo.min_lat),
    min_lng: Math.max(bbox.min_lng, clipTo.min_lng),
    max_lat: Math.min(bbox.max_lat, clipTo.max_lat),
    max_lng: Math.min(bbox.max_lng, clipTo.max_lng),
  };
  if (clipped.min_lat >= clipped.max_lat || clipped.min_lng >= clipped.max_lng) {
    return null;
  }
  return clipped;
}

export function bboxIntersects(a: Bbox, b: Bbox): boolean {
  return !(
    a.max_lat < b.min_lat ||
    a.min_lat > b.max_lat ||
    a.max_lng < b.min_lng ||
    a.min_lng > b.max_lng
  );
}

/**
 * Expands a bbox outward by `meters` in all directions.
 * Uses a flat-earth approximation accurate to within ~0.3% at mid-latitudes.
 */
export function expandBbox(bbox: Bbox, meters: number): Bbox {
  const centerLat = (bbox.min_lat + bbox.max_lat) / 2;
  const latPad = meters / 111_320;
  const lngScale = Math.max(Math.cos((centerLat * Math.PI) / 180), 0.2);
  const lngPad = meters / (111_320 * lngScale);
  return {
    min_lat: bbox.min_lat - latPad,
    min_lng: bbox.min_lng - lngPad,
    max_lat: bbox.max_lat + latPad,
    max_lng: bbox.max_lng + lngPad,
  };
}

export function bboxToPolygon(bbox: Bbox): {
  type: "Polygon";
  coordinates: [number, number][][];
} {
  return {
    type: "Polygon",
    coordinates: [
      [
        [bbox.min_lng, bbox.min_lat],
        [bbox.max_lng, bbox.min_lat],
        [bbox.max_lng, bbox.max_lat],
        [bbox.min_lng, bbox.max_lat],
        [bbox.min_lng, bbox.min_lat],
      ],
    ],
  };
}

export function bboxToPoint(bbox: Bbox): {
  type: "Point";
  coordinates: [number, number];
} {
  return {
    type: "Point",
    coordinates: [
      (bbox.min_lng + bbox.max_lng) / 2,
      (bbox.min_lat + bbox.max_lat) / 2,
    ],
  };
}

export function bboxToLine(bbox: Bbox): {
  type: "LineString";
  coordinates: [number, number][];
} {
  const midLat = (bbox.min_lat + bbox.max_lat) / 2;
  return {
    type: "LineString",
    coordinates: [
      [bbox.min_lng, midLat],
      [bbox.max_lng, midLat],
    ],
  };
}

type MinimalGeometry = {
  type?: string;
  coordinates?: unknown;
  geometries?: Array<{ type?: string; coordinates?: unknown }>;
} | null;

export function featureBbox(feature: { geometry?: MinimalGeometry }): Bbox | null {
  const geometry = feature.geometry;
  if (!geometry) return null;

  let coords: [number, number][];
  if (geometry.type === "GeometryCollection") {
    coords = (geometry.geometries ?? []).flatMap((g) => walkCoords(g.coordinates));
  } else {
    coords = walkCoords(geometry.coordinates);
  }

  return coords.length > 0 ? bboxFromCoords(coords) : null;
}
