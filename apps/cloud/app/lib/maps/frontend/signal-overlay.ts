"use client";

// The overlay file historically only carried point-shaped signals/signs, but
// crosswalk polygons now share the same FeatureCollection (see xodr-signals.ts).
// "crosswalk" lives at the head of this list so it renders below the circle
// signals visually and so the toggle sits at the top of the panel — pedestrian
// infrastructure is the most-asked-about layer in user testing.
export const SIGNAL_CATEGORY_CONFIG = [
  { id: "crosswalk", label: "Crosswalks", color: "#06d6a0" },
  { id: "traffic_light", label: "Traffic Lights", color: "#facc15" },
  { id: "stop_sign", label: "Stop Signs", color: "#ef4444" },
  { id: "yield_sign", label: "Yield Signs", color: "#f97316" },
  { id: "speed_limit_sign", label: "Speed Limit Signs", color: "#a78bfa" },
  { id: "regulatory_sign", label: "Regulatory Signs", color: "#fb923c" },
  { id: "turn_restriction_sign", label: "Turn Restrictions", color: "#f472b6" },
  { id: "parking_sign", label: "Parking Signs", color: "#38bdf8" },
  { id: "warning_sign", label: "Warning Signs", color: "#fbbf24" },
  { id: "school_sign", label: "School Signs", color: "#a3e635" },
  { id: "bus_stop", label: "Bus Stops", color: "#60a5fa" },
  { id: "stop_line", label: "Stop Lines", color: "#94a3b8" },
  { id: "other_sign", label: "Other Signs", color: "#6ee7b7" },
  { id: "street_name_sign", label: "Street Name Signs", color: "#d4d4d8" },
  { id: "unknown", label: "Unknown", color: "#737373" },
] as const;

export type SignalCategoryId = (typeof SIGNAL_CATEGORY_CONFIG)[number]["id"];

export const DEFAULT_ENABLED_SIGNAL_CATEGORY_IDS: SignalCategoryId[] = ["crosswalk"];

type SignalOverlayFeature = {
  properties?: {
    feature_kind?: string;
    signal_category?: string;
  };
};

type SignalOverlayData = {
  features?: SignalOverlayFeature[];
} | null;

export function countSignalCategories(signalOverlayGeoJSON: object | null) {
  const signalFeatures = signalOverlayGeoJSON as SignalOverlayData;
  const featureCount = signalFeatures?.features?.length ?? 0;
  // Crosswalk polygons land in the "crosswalk" bucket (matching their
  // SIGNAL_CATEGORY_CONFIG id); signal points keep their existing
  // signal_category bucket. Anything missing both fields falls through to
  // "unknown" as before.
  const categoryCounts =
    signalFeatures?.features?.reduce<Record<string, number>>((acc, feature) => {
      const category =
        feature.properties?.feature_kind === "crosswalk"
          ? "crosswalk"
          : feature.properties?.signal_category ?? "unknown";
      acc[category] = (acc[category] ?? 0) + 1;
      return acc;
    }, {}) ?? {};

  return { featureCount, categoryCounts };
}

/**
 * Count Overture crosswalk features that are NOT within `thresholdM` metres
 * of any XODR crosswalk in the signal overlay. Mirrors the dedup math used by
 * `buildOvertureCrosswalkCandidates` so the displayed total in MapStatsDisplay
 * matches what ends up in the search index — when the in-house data covers
 * the same intersection, only the in-house crosswalk gets counted.
 */
const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LAT = 111_320;

function distanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const cosLat = Math.cos(((a.lat + b.lat) / 2) * DEG2RAD);
  const dx = (b.lng - a.lng) * M_PER_DEG_LAT * cosLat;
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

function xodrCrosswalkCenters(
  signalOverlayGeoJSON: object | null,
): { lat: number; lng: number }[] {
  const fc = signalOverlayGeoJSON as
    | { features?: Array<{ properties?: { feature_kind?: string }; geometry?: { type?: string; coordinates?: unknown } }> }
    | null;
  const out: { lat: number; lng: number }[] = [];
  for (const f of fc?.features ?? []) {
    if (f?.properties?.feature_kind !== "crosswalk") continue;
    // The XODR crosswalk geometry is a Polygon; centroid the outer ring
    // (skip closing vertex). For non-Polygon geometries fall back to the
    // first coord pair we find — same shape as the search-index helper.
    const coords = f.geometry?.coordinates as unknown;
    const center = firstRepresentativeLngLat(coords, f.geometry?.type);
    if (center) out.push(center);
  }
  return out;
}

function firstRepresentativeLngLat(
  coords: unknown,
  geometryType?: string,
): { lat: number; lng: number } | null {
  if (geometryType === "Polygon") {
    const rings = coords as [number, number][][] | undefined;
    const ring = rings?.[0];
    if (!ring || ring.length === 0) return null;
    const last =
      ring.length > 1 &&
      ring[0]![0] === ring[ring.length - 1]![0] &&
      ring[0]![1] === ring[ring.length - 1]![1]
        ? ring.length - 1
        : ring.length;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < last; i++) {
      sx += ring[i]![0];
      sy += ring[i]![1];
    }
    return { lng: sx / last, lat: sy / last };
  }
  const visit = (node: unknown): { lat: number; lng: number } | null => {
    if (!Array.isArray(node)) return null;
    if (node.length >= 2 && typeof node[0] === "number" && typeof node[1] === "number") {
      return { lng: node[0] as number, lat: node[1] as number };
    }
    for (const child of node) {
      const r = visit(child);
      if (r) return r;
    }
    return null;
  };
  return visit(coords);
}

type OvertureCrosswalksLayer = {
  data?: {
    features?: Array<{
      properties?: {
        bbox?: { min_lng: number; min_lat: number; max_lng: number; max_lat: number };
        // Other Overture properties (id, name, class, …) are not consumed here
        // but allowed so callers can pass through their feature payloads as-is.
        [key: string]: unknown;
      };
      geometry?: { type?: string; coordinates?: unknown };
    }>;
  };
};

const DEFAULT_DEDUPE_THRESHOLD_M = 15;

export function countOvertureCrosswalkSurvivors(
  signalOverlayGeoJSON: object | null,
  overtureCrosswalksLayer: OvertureCrosswalksLayer | null | undefined,
  thresholdM: number = DEFAULT_DEDUPE_THRESHOLD_M,
): number {
  const overtureFeatures = overtureCrosswalksLayer?.data?.features ?? [];
  if (overtureFeatures.length === 0) return 0;
  const xodrCenters = xodrCrosswalkCenters(signalOverlayGeoJSON);

  let survivors = 0;
  for (const f of overtureFeatures) {
    const bbox = f?.properties?.bbox;
    let center: { lat: number; lng: number } | null = null;
    if (
      bbox &&
      Number.isFinite(bbox.min_lng) &&
      Number.isFinite(bbox.min_lat) &&
      Number.isFinite(bbox.max_lng) &&
      Number.isFinite(bbox.max_lat)
    ) {
      center = {
        lng: (bbox.min_lng + bbox.max_lng) / 2,
        lat: (bbox.min_lat + bbox.max_lat) / 2,
      };
    } else {
      center = firstRepresentativeLngLat(f?.geometry?.coordinates, f?.geometry?.type);
    }
    if (!center) continue;
    const tooClose = xodrCenters.some((c) => distanceMetres(c, center!) < thresholdM);
    if (!tooClose) survivors++;
  }
  return survivors;
}
