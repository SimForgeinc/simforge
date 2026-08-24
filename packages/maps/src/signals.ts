/**
 * Signal / road-furniture loading.
 *
 * `signals.geojson.gz` is *not* a pure point layer despite the name. Yale
 * Street's 164 features break down as:
 *
 * - **143 `Point`** features with `feature_kind: "signal"` — traffic lights,
 *   signs, stop lines, bus stops. These carry `signal_category`.
 * - **21 `Polygon`** features with `feature_kind: "crosswalk"` and **no
 *   `signal_category` at all**. Their surface ring is kept on
 *   {@link SignalFeature.outline} and their {@link SignalFeature.position} is
 *   the ring centroid.
 *
 * So `signal_category` is optional in the wild; it is normalised to
 * `'unknown'` here and the raw value is preserved in `properties`.
 *
 * The layer also contains bad rows: four duplicated `Stop Line` features on
 * road 918 carry `t = -1725.5` m and `z_offset = -12.24` m, which projects them
 * ~1.7 km outside the map, onto the projection origin. They are flagged via
 * {@link SignalFeature.withinExtents} rather than silently dropped.
 */

import type { CoordinateFrame, Vec3 } from './coordinate-frame.js';
import type { Feature, FeatureCollection } from './geojson.js';
import { loadGzipJson } from './gzip.js';

/** Signal categories emitted by the map pipeline. */
export type SignalCategory =
  | 'traffic_light'
  | 'stop_sign'
  | 'parking_sign'
  | 'regulatory_sign'
  | 'warning_sign'
  | 'stop_line'
  | 'street_name_sign'
  | 'bus_stop'
  | 'turn_restriction_sign'
  | 'other_sign'
  | 'unknown';

const KNOWN_CATEGORIES = new Set<string>([
  'traffic_light',
  'stop_sign',
  'parking_sign',
  'regulatory_sign',
  'warning_sign',
  'stop_line',
  'street_name_sign',
  'bus_stop',
  'turn_restriction_sign',
  'other_sign',
  'unknown',
]);

/** Raw GeoJSON properties on a signal feature. */
export interface SignalProperties {
  feature_kind?: string;
  id?: string;
  name?: string;
  source_name?: string;
  road_id?: string;
  s?: number;
  t?: number;
  hdg?: number;
  signal_category?: string;
  /** `"yes"`/`"no"` in RoadRunner exports; a real boolean in some pipelines. */
  dynamic?: string | boolean;
  type?: string;
  subtype?: string;
  height?: number;
  width?: number;
  length?: number;
  z_offset?: number;
  mutcd_code?: string;
  sign_description?: string;
  sign_group?: string;
  [key: string]: unknown;
}

/** A signal / road-furniture feature in scene space. */
export interface SignalFeature {
  /** Stable id from the source data (falls back to `signal-<index>`). */
  id: string;
  /** Human-readable name, e.g. `No Parking Any Time (R7-1)`. */
  name: string;
  /** `signal` for the point layer, `crosswalk` for the polygon layer. */
  featureKind: string;
  /** Normalised category; `'unknown'` when the source omits `signal_category`. */
  category: SignalCategory;
  /** OpenDRIVE road id the signal is referenced to. */
  roadId: string;
  /** OpenDRIVE `s` along the road, metres. */
  s: number;
  /** OpenDRIVE `t` lateral offset, metres. */
  t: number;
  /** `dynamic="yes"` — i.e. a state-changing device such as a traffic light. */
  dynamic: boolean;
  /** Physical face height in metres, when known. */
  height: number | null;
  /** Physical face width in metres, when known. */
  width: number | null;
  /**
   * Mounting height above ground, metres. Add this to `position[1]` to place
   * the signal *head*; `position` itself is the base of the pole.
   */
  zOffset: number;
  /** MUTCD sign code, e.g. `R7-1`. */
  mutcdCode: string | null;
  /** Long-form sign description. */
  signDescription: string | null;
  /** Coarse sign grouping from the source data, e.g. `regulatory`. */
  signGroup: string | null;
  /** Source WGS84 `[lon, lat]`. */
  lonLat: [number, number];
  /** OpenDRIVE-local `[x, y]` metres. */
  localPosition: [number, number];
  /**
   * Scene-space position of the **base of the pole**: `[x, groundY, z]`.
   * Ground height comes from `options.heightSampler` when supplied, otherwise
   * `options.groundHeight`.
   */
  position: Vec3;
  /**
   * Alias of {@link position}, spelled the way overlay code reads best.
   * Same object identity is not guaranteed; the values always match.
   */
  scenePosition: Vec3;
  /**
   * `false` when the feature projects outside the road-network extents — i.e.
   * the source row is bad. See {@link SignalLoadOptions.dropOutsideExtents}.
   */
  withinExtents: boolean;
  /** For polygon features (crosswalks): flat scene-space `[x, z, ...]` outline. */
  outline?: Float64Array;
  /** Untouched GeoJSON properties. */
  properties: SignalProperties;
}

/** Options for {@link signalsFromGeoJson} / {@link loadSignals}. */
export interface SignalLoadOptions {
  /** Fallback scene Y when no sampler is given, or the sampler returns null. Default `0`. */
  groundHeight?: number;
  /** Ground height lookup in scene space; return `null` where unknown. */
  heightSampler?: (x: number, z: number) => number | null;
  /**
   * Drop features that project outside the road-network extents instead of
   * merely flagging them via {@link SignalFeature.withinExtents}. Default `false`,
   * so the returned array always matches the source feature count.
   */
  dropOutsideExtents?: boolean;
  /** Slack in metres for the extent test. Default `25`. */
  extentMargin?: number;
}

function normaliseCategory(raw: unknown): SignalCategory {
  if (typeof raw === 'string' && KNOWN_CATEGORIES.has(raw)) return raw as SignalCategory;
  return 'unknown';
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Area-weighted centroid of a flat `[x, z, ...]` ring in metres.
 *
 * Coordinates are re-based on the first vertex before the shoelace sum:
 * evaluating it on absolute coordinates (let alone on raw lon/lat, where a
 * crosswalk's area is ~1e-9 deg² against ~1e2 deg coordinates) destroys the
 * result through catastrophic cancellation. Falls back to the vertex mean for
 * degenerate rings.
 */
function ringCentroidXZ(flat: Float64Array): [number, number] {
  const n = flat.length / 2;
  const ox = flat[0] as number;
  const oz = flat[1] as number;
  let area = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = (flat[i * 2] as number) - ox;
    const az = (flat[i * 2 + 1] as number) - oz;
    const bx = (flat[j * 2] as number) - ox;
    const bz = (flat[j * 2 + 1] as number) - oz;
    const cross = ax * bz - bx * az;
    area += cross;
    cx += (ax + bx) * cross;
    cz += (az + bz) * cross;
  }
  if (Math.abs(area) > 1e-9) return [ox + cx / (3 * area), oz + cz / (3 * area)];
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    sx += flat[i * 2] as number;
    sz += flat[i * 2 + 1] as number;
  }
  return [sx / n, sz / n];
}

/**
 * Convert a parsed signals FeatureCollection into scene space.
 *
 * Handles both the `Point` signal layer and the `Polygon` crosswalk layer that
 * shares the file.
 */
export function signalsFromGeoJson(
  collection: FeatureCollection<SignalProperties>,
  frame: CoordinateFrame,
  options: SignalLoadOptions = {},
): SignalFeature[] {
  const {
    groundHeight = 0,
    heightSampler,
    dropOutsideExtents = false,
    extentMargin = 25,
  } = options;
  const out: SignalFeature[] = [];
  const features = collection?.features ?? [];

  for (let i = 0; i < features.length; i++) {
    const feature = features[i] as Feature<SignalProperties>;
    const geom = feature?.geometry;
    if (!geom) continue;

    let lonLat: [number, number] | null = null;
    let outline: Float64Array | undefined;

    if (geom.type === 'Point') {
      const c = geom.coordinates as number[];
      if (c.length >= 2) lonLat = [c[0] as number, c[1] as number];
    } else if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      const ring = (
        geom.type === 'Polygon'
          ? (geom.coordinates as number[][][])[0]
          : ((geom.coordinates as number[][][][])[0] as number[][][] | undefined)?.[0]
      ) as number[][] | undefined;
      if (ring && ring.length >= 3) {
        const closed =
          (ring[0] as number[])[0] === (ring[ring.length - 1] as number[])[0] &&
          (ring[0] as number[])[1] === (ring[ring.length - 1] as number[])[1];
        const count = closed ? ring.length - 1 : ring.length;
        outline = new Float64Array(count * 2);
        for (let k = 0; k < count; k++) {
          const p = ring[k] as number[];
          const s = frame.wgs84ToScene(p[0] as number, p[1] as number, 0);
          outline[k * 2] = s[0];
          outline[k * 2 + 1] = s[2];
        }
        // Centroid in metres, then back out to WGS84 — never in degrees.
        const [cxScene, czScene] = ringCentroidXZ(outline);
        lonLat = frame.sceneToWgs84([cxScene, 0, czScene]);
      }
    }
    if (!lonLat || !Number.isFinite(lonLat[0]) || !Number.isFinite(lonLat[1])) continue;

    const p = feature.properties ?? {};
    const local = frame.wgs84ToLocal(lonLat[0], lonLat[1]);
    const withinExtents = frame.localWithinExtents(local[0], local[1], extentMargin);
    if (!withinExtents && dropOutsideExtents) continue;
    const flat = frame.localToScene(local[0], local[1], 0);
    const sampled = heightSampler?.(flat[0], flat[2]);
    const groundY = sampled === undefined || sampled === null ? groundHeight : sampled;
    const position: Vec3 = [flat[0], groundY, flat[2]];

    out.push({
      id: String(p.id ?? `signal-${i}`),
      name: String(p.name ?? ''),
      featureKind: String(p.feature_kind ?? 'signal'),
      category: normaliseCategory(p.signal_category),
      roadId: String(p.road_id ?? ''),
      s: num(p.s, 0),
      t: num(p.t, 0),
      dynamic: p.dynamic === 'yes' || p.dynamic === true,
      height: numOrNull(p.height),
      width: numOrNull(p.width),
      zOffset: num(p.z_offset, 0),
      mutcdCode: strOrNull(p.mutcd_code),
      signDescription: strOrNull(p.sign_description),
      signGroup: strOrNull(p.sign_group),
      lonLat,
      localPosition: [local[0], local[1]],
      position,
      scenePosition: position,
      withinExtents,
      ...(outline ? { outline } : {}),
      properties: p,
    });
  }
  return out;
}

/**
 * Fetch and convert `signals.geojson(.gz)`.
 *
 * @param url Location of the (optionally gzipped) GeoJSON.
 * @param frame Coordinate frame for the map.
 * @param options Ground-height resolution.
 */
export async function loadSignals(
  url: string,
  frame: CoordinateFrame,
  options?: SignalLoadOptions,
): Promise<SignalFeature[]> {
  const json = await loadGzipJson<FeatureCollection<SignalProperties>>(url);
  return signalsFromGeoJson(json, frame, options);
}
