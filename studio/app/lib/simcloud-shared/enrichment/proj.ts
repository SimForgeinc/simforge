/**
 * Single chokepoint for every WGS84 ↔ CARLA-local-meter projection in the
 * codebase. Every consumer projecting between geographic and projected
 * coordinates does so through a `MapProjection` instance, which wraps proj4
 * against the PROJ string declared in the XODR's `<geoReference>` (or a
 * vanilla `+proj=tmerc` synthesized from `origin_lat`/`origin_lon` for legacy
 * assets that don't have a full PROJ string on record).
 *
 * Why a class instead of free functions: a `MapProjection` constructs its
 * proj4 converter once and reuses it across calls, instead of re-parsing the
 * PROJ string per call. It also gives us a single seam to swap proj4 for
 * another library later (or stub it in tests) without touching call sites.
 *
 * Why proj4 instead of hand-rolled math: SimCloud is a geospatial product and
 * the maps we ingest can in principle declare any PROJ-supported projection.
 * Hand-rolling the math (as we previously did with a Snyder series for TMerc)
 * works for one specific projection family but silently produces wrong
 * results the moment a new map declares anything else — different ellipsoid,
 * false easting/northing, a non-tmerc projection, etc. proj4 parses the full
 * PROJ string spec and handles every projection type the upstream PROJ
 * library supports.
 *
 * The historical bug this layer replaced: earlier code used a flat-earth
 * equirectangular approximation (`x = (lng - lon0) * 111320 * cos(lat0)`,
 * `y = (lat - lat0) * 111320`) that diverged from the XODR-declared TMerc by
 * 0.13–0.27% per metre away from origin. Routing every projection through
 * this class against the asset's actual `<geoReference>` PROJ string makes
 * that class of error structurally impossible.
 */
import proj4 from "proj4";

/** WGS84 geographic (lng, lat) — the source CRS for `geoToLocal`. */
const WGS84 = "+proj=longlat +datum=WGS84 +no_defs";

export class MapProjection {
  /**
   * proj4 converter, constructed once per instance. Calls to
   * `geoToLocal`/`localToGeo` are then cheap forward/inverse evaluations.
   */
  private readonly converter: proj4.Converter;

  constructor(private readonly projString: string) {
    this.converter = proj4(WGS84, projString);
  }

  /**
   * Project (lon, lat) in WGS84 → (x, y) in the projected frame this
   * `MapProjection` was constructed with. Output is y-up east/north — for
   * TMerc-style projections that's positive-east, positive-north, matching
   * the XODR's native CARLA local-meter convention.
   */
  geoToLocal(lon: number, lat: number): { x: number; y: number } {
    const [x, y] = this.converter.forward([lon, lat]);
    return { x, y };
  }

  /** Inverse of `geoToLocal`. Input (x, y) is y-up east/north. */
  localToGeo(x: number, y: number): { lon: number; lat: number } {
    const [lon, lat] = this.converter.inverse([x, y]);
    return { lon, lat };
  }

  /** The PROJ string this projection was constructed from. */
  get proj(): string {
    return this.projString;
  }

  /**
   * Build a `MapProjection` from an asset's coordinate reference: prefers the
   * XODR-declared `proj_string` verbatim, falls back to a synthesized vanilla
   * `+proj=tmerc` from `origin_lat`/`origin_lon`. Returns `undefined` when
   * neither is available — the asset can't be projected at all in that case.
   *
   * Instances are cached per PROJ string so callers in hot loops (e.g.
   * projecting thousands of CARLA road-overlay vertices on every overlay
   * rebuild) don't pay the cost of re-parsing the PROJ string and rebuilding
   * the proj4 converter on every call.
   */
  static fromCoordinateRef(ref: {
    proj_string?: string;
    origin_lat?: number;
    origin_lon?: number;
  }): MapProjection | undefined {
    let projString: string | undefined;
    if (ref.proj_string && ref.proj_string.includes("+proj=")) {
      projString = ref.proj_string;
    } else if (ref.origin_lat != null && ref.origin_lon != null) {
      projString = synthesizeTmercProjString(ref.origin_lat, ref.origin_lon);
    }
    if (!projString) return undefined;
    let cached = instanceCache.get(projString);
    if (!cached) {
      cached = new MapProjection(projString);
      instanceCache.set(projString, cached);
    }
    return cached;
  }
}

const instanceCache = new Map<string, MapProjection>();

/**
 * Build a vanilla `+proj=tmerc +lat_0=… +lon_0=…` PROJ string for assets
 * that have an origin lat/lon but no full PROJ string on record (legacy
 * uploads, synthetic test fixtures). Matches the form RoadRunner emits.
 */
export function synthesizeTmercProjString(lat0: number, lon0: number): string {
  return `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`;
}
