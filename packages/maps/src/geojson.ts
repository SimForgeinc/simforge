/** Minimal structural GeoJSON types (avoids a `@types/geojson` dependency). */

/** `[lon, lat]` or `[lon, lat, elevation]`. */
export type Position = number[];

export interface PointGeometry {
  type: 'Point';
  coordinates: Position;
}
export interface PolygonGeometry {
  type: 'Polygon';
  /** `coordinates[0]` is the outer ring; the rest are holes. */
  coordinates: Position[][];
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon';
  coordinates: Position[][][];
}
export interface LineStringGeometry {
  type: 'LineString';
  coordinates: Position[];
}

export type Geometry =
  | PointGeometry
  | PolygonGeometry
  | MultiPolygonGeometry
  | LineStringGeometry
  | { type: string; coordinates: unknown };

export interface Feature<P = Record<string, unknown>> {
  type: 'Feature';
  geometry: Geometry | null;
  properties: P | null;
  id?: string | number;
}

export interface FeatureCollection<P = Record<string, unknown>> {
  type: 'FeatureCollection';
  features: Feature<P>[];
}
