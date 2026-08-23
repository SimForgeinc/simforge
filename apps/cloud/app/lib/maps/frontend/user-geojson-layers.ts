import { normalizeGeoJSONWithFeatureIds } from "./geojson-utils";
import { GEOJSON_FEATURE_ID_PROP } from "./feature-inspection-types";

/**
 * A user-uploaded GeoJSON layer, held in memory for the current session and
 * co-visualized on top of the map (e.g. scenario locations). Not persisted —
 * cleared on reload / map switch. Rendering + selection mirror the enrichment
 * overlays so the existing inspector, highlight, and aggregate-click flows all
 * apply unchanged.
 */
export type UserGeoJsonLayer = {
  /** Stable per-session id; also the MapLibre source-id suffix. */
  id: string;
  /** Display name (defaults to the uploaded filename). */
  name: string;
  /** Normalized FeatureCollection (each feature stamped with `__mapId`). */
  data: object;
  /** Number of features (shown as the row count). */
  featureCount: number;
  visible: boolean;
  /** One of USER_GEOJSON_PALETTE. */
  color: string;
  /** 0–1 fill/stroke opacity. */
  opacity: number;
  /**
   * Stroke/marker weight multiplier applied to the base sizes (see
   * `userGeoJsonSizes`). Scales point radius and line width; for polygons it
   * thickens the outline only — the filled area is real-world geometry and
   * must not grow.
   */
  thickness: number;
};

/**
 * Fixed swatch set for user layers — brand-neutral, high-contrast hues that
 * stay distinguishable against the dark basemap and from each other.
 */
export const USER_GEOJSON_PALETTE: readonly string[] = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
];

/** Default color for the Nth uploaded layer — cycles through the palette. */
export function defaultUserGeoJsonColor(index: number): string {
  return USER_GEOJSON_PALETTE[index % USER_GEOJSON_PALETTE.length]!;
}

export const DEFAULT_USER_GEOJSON_OPACITY = 0.7;

/** Neutral weight — base sizes render unscaled. */
export const DEFAULT_USER_GEOJSON_THICKNESS = 1;
export const MIN_USER_GEOJSON_THICKNESS = 0.5;
/** Capped so a heavy layer stays readable rather than swamping the basemap. */
export const MAX_USER_GEOJSON_THICKNESS = 4;

/** Unscaled render weights for each geometry primitive (MapLibre px). */
const BASE_POINT_RADIUS = 5;
const BASE_LINE_WIDTH = 3;
const BASE_POLYGON_OUTLINE_WIDTH = 2;

/**
 * Resolve a layer's thickness multiplier into concrete MapLibre paint sizes.
 * Polygons deliberately expose only an outline width — their fill traces real
 * geometry, so thickening must never inflate the area it covers.
 */
export function userGeoJsonSizes(thickness: number): {
  pointRadius: number;
  lineWidth: number;
  polygonOutlineWidth: number;
} {
  const t = clampUserGeoJsonThickness(thickness);
  return {
    pointRadius: BASE_POINT_RADIUS * t,
    lineWidth: BASE_LINE_WIDTH * t,
    polygonOutlineWidth: BASE_POLYGON_OUTLINE_WIDTH * t,
  };
}

/** Clamp to the supported range; non-finite input falls back to the default. */
export function clampUserGeoJsonThickness(thickness: number): number {
  if (!Number.isFinite(thickness)) return DEFAULT_USER_GEOJSON_THICKNESS;
  return Math.min(
    MAX_USER_GEOJSON_THICKNESS,
    Math.max(MIN_USER_GEOJSON_THICKNESS, thickness),
  );
}

/** Reject files larger than this to protect map render performance. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** MapLibre source id for a user layer. */
export function userGeoJsonSourceId(layerId: string): string {
  return `user-geojson-${layerId}`;
}

/**
 * MapLibre layer ids for a user layer's four stacked sublayers, in the same
 * order EnrichmentOverlayLayers uses for its heterogeneous branch. Used both
 * for rendering and to register the layers as click/hover query targets.
 */
export function userGeoJsonLayerIds(layerId: string): string[] {
  const s = userGeoJsonSourceId(layerId);
  return [`${s}-fill`, `${s}-polygon-outline`, `${s}-line`, `${s}-circle`];
}

/**
 * Panel properties for an uploaded feature. Unlike the authored-feature
 * `featurePropertiesForPanel` (which also drops a numeric `id` — an internal
 * artifact of the road-network export), uploads use `__mapId` as their only
 * internal id, so a numeric `id` here is a legitimate user attribute and must
 * be preserved. Strip only `__mapId` (and null/undefined, matching the
 * authored path) so the inspector + "Copy GeoJSON" keep every user field.
 */
export function userGeoJsonPropertiesForPanel(
  properties: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!properties || typeof properties !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (v === undefined || v === null) continue;
    if (k === GEOJSON_FEATURE_ID_PROP) continue;
    out[k] = v;
  }
  return out;
}

type ParseOk = { ok: true; data: object; featureCount: number };
type ParseErr = { ok: false; error: string };

/**
 * Validate + normalize arbitrary user-supplied GeoJSON text into a
 * FeatureCollection ready to render. Accepts a FeatureCollection, a single
 * Feature, or a bare geometry, wrapping the latter two so every path yields a
 * FeatureCollection. Each feature is stamped with `__mapId` (the same identity
 * contract the road-network layers use), so the inspector strips it from the
 * attribute view automatically.
 */
export function parseUserGeoJson(text: string): ParseOk | ParseErr {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "Invalid JSON — the file could not be parsed." };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Not GeoJSON — expected a JSON object." };
  }

  const obj = parsed as { type?: unknown; features?: unknown; geometry?: unknown; coordinates?: unknown };
  const type = typeof obj.type === "string" ? obj.type : "";

  let featureCollection: { type: "FeatureCollection"; features: unknown[] };

  if (type === "FeatureCollection") {
    if (!Array.isArray(obj.features)) {
      return { ok: false, error: "Invalid GeoJSON — FeatureCollection has no features array." };
    }
    featureCollection = { type: "FeatureCollection", features: obj.features };
  } else if (type === "Feature") {
    featureCollection = { type: "FeatureCollection", features: [parsed] };
  } else if (GEOMETRY_TYPES.has(type)) {
    // Bare geometry → wrap as a single property-less Feature.
    featureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: parsed, properties: {} }],
    };
  } else {
    return {
      ok: false,
      error: 'Not GeoJSON — "type" must be FeatureCollection, Feature, or a geometry.',
    };
  }

  if (featureCollection.features.length === 0) {
    return { ok: false, error: "GeoJSON contains no features." };
  }

  // Each feature must at least look like a Feature with a geometry.
  for (const f of featureCollection.features) {
    const feat = f as { type?: unknown; geometry?: { type?: unknown } | null } | null;
    if (!feat || typeof feat !== "object" || feat.type !== "Feature") {
      return { ok: false, error: "Invalid GeoJSON — every entry in features must be a Feature." };
    }
    // Null geometry is legal per spec, but nothing would render — flag it so
    // the user isn't confused by an "uploaded" layer that shows nothing.
    if (feat.geometry != null && !GEOMETRY_TYPES.has(String((feat.geometry as { type?: unknown }).type))) {
      return { ok: false, error: "Invalid GeoJSON — a feature has an unrecognized geometry type." };
    }
  }

  const normalized = normalizeGeoJSONWithFeatureIds(featureCollection);
  return { ok: true, data: normalized, featureCount: featureCollection.features.length };
}

const GEOMETRY_TYPES = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);
