/**
 * Pure helpers for the map measure tool: great-circle arc distance between
 * two clicked points, its display formatting, and the overlay GeoJSON. The
 * interactive state lives in `useMeasureTool`; rendering in
 * `MeasureDistanceLayers`.
 */

export type MeasurePoint = { lng: number; lat: number };

const DEG2RAD = Math.PI / 180;
/** IUGG mean earth radius — the standard sphere for great-circle distance. */
const EARTH_RADIUS_M = 6_371_008.8;

/**
 * Great-circle (haversine) arc distance in metres. Exact on the mean-earth
 * sphere at any separation — unlike `haversineMetres` in `geo-math.ts`,
 * which is a flat-earth approximation tuned for sub-city spans.
 */
export function greatCircleArcMetres(a: MeasurePoint, b: MeasurePoint): number {
  const sinHalfLat = Math.sin(((b.lat - a.lat) * DEG2RAD) / 2);
  const sinHalfLng = Math.sin(((b.lng - a.lng) * DEG2RAD) / 2);
  const h =
    sinHalfLat * sinHalfLat +
    Math.cos(a.lat * DEG2RAD) * Math.cos(b.lat * DEG2RAD) * sinHalfLng * sinHalfLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Metric read-out for a measured distance: metres below 1 km (one decimal
 * under 10 m, where it still carries information), kilometres above.
 */
export function formatMeasuredDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return "—";
  if (metres < 10) return `${metres.toFixed(1)} m`;
  const rounded = Math.round(metres);
  if (rounded < 1000) return `${rounded} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

/**
 * Overlay geometry for the current measurement: an `endpoint` Point per
 * placed click, plus the segment tagged `fixed` (both endpoints placed) or
 * `preview` (rubber band from the first point to the cursor). Null until the
 * first point exists.
 */
export function measureOverlayGeoJSON(
  points: MeasurePoint[],
  cursor: MeasurePoint | null,
): object | null {
  const [a, b] = points;
  if (!a) return null;
  const features: object[] = points.map((point) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [point.lng, point.lat] },
    properties: { kind: "endpoint" },
  }));
  const end = b ?? cursor;
  if (end) {
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [a.lng, a.lat],
          [end.lng, end.lat],
        ],
      },
      properties: { kind: b ? "fixed" : "preview" },
    });
  }
  return { type: "FeatureCollection", features };
}

export type MeasureReadout = {
  /** Segment midpoint — where the distance pill anchors. */
  position: MeasurePoint;
  label: string;
  /** True once both endpoints are placed (the pill grows a clear button). */
  pinned: boolean;
};

/** Distance pill content for the current measurement, or null without a segment. */
export function measureReadout(
  points: MeasurePoint[],
  cursor: MeasurePoint | null,
): MeasureReadout | null {
  const [a, b] = points;
  if (!a) return null;
  const end = b ?? cursor;
  if (!end) return null;
  return {
    // Arithmetic midpoint is fine at map-asset scale (segments are km-ish).
    position: { lng: (a.lng + end.lng) / 2, lat: (a.lat + end.lat) / 2 },
    label: formatMeasuredDistance(greatCircleArcMetres(a, end)),
    pinned: Boolean(b),
  };
}
