/**
 * The three coordinate frames UniScenarios has to reconcile, and the
 * transforms between them.
 *
 * ## The frames
 *
 * 1. **WGS84** — `[lon, lat]` degrees (EPSG:4326). What the GeoJSON sidecars
 *    (`lane-polygons.geojson`, `signals.geojson`) are stored in.
 * 2. **OpenDRIVE-local** — `[x, y, z]` metres, x-east / y-north / z-up. The
 *    frame the `.xodr` road network lives in, defined by the `<geoReference>`
 *    PROJ string (a transverse Mercator centred on the map).
 * 3. **Scene** — `[x, y, z]` metres, y-up, what the glTF tiles are authored in.
 *
 * ## The local -> scene transform (empirically determined)
 *
 * ```
 *   scene.x =  local.x        local.x =  scene.x
 *   scene.y =  local.z        local.y = -scene.z
 *   scene.z = -local.y        local.z =  scene.y
 * ```
 *
 * i.e. a −90° rotation about +X (determinant +1, no mirroring) and **no
 * translation** — scene coordinates are absolute OpenDRIVE-local coordinates,
 * merely re-axed. This is the standard z-up -> y-up glTF convention, and it was
 * verified three ways against the Yale Street data rather than assumed:
 *
 * - The mapped xodr extent rectangle is *contained* in `manifest.scene.bounds`
 *   with small non-negative residuals on all four sides; every other axis /
 *   sign permutation lands the rectangle entirely outside the scene box.
 * - glTF tile node translations map back inside the xodr extents (19/19 for
 *   this candidate, 0/19 for the alternatives) with a median distance of 7.4 m
 *   to the nearest road reference line — the alternatives are 1400–3500 m off.
 * - Projected lane-polygon and signal coordinates land inside the scene bounds.
 *
 * ### `manifest.scene.origin` is NOT a translation
 *
 * It is the corner of the LOD tile grid: `tile_i_j.bounds.min == origin + [i,j]
 * * cellSize` holds exactly for every tile. Applying it as an offset would move
 * the overlays ~360 m east and ~2 km north of the geometry. `CoordinateFrame`
 * therefore defaults `sceneOrigin` to `[0, 0, 0]` and exposes the manifest
 * value separately as {@link CoordinateFrame.tileGridOrigin}. The constructor
 * still accepts an explicit `sceneOrigin` for map pipelines that *do* recentre
 * their scenes.
 */

import proj4 from 'proj4';
import { parseXodrHeader, type MapExtents, type XodrHeader } from './header.js';

/** A three-component tuple. */
export type Vec3 = [number, number, number];
/** A two-component tuple. */
export type Vec2 = [number, number];
/** Anything three.js-`Vector3`-shaped, or a plain tuple. */
export type Vec3Like = Vec3 | { x: number; y: number; z: number };

/** Axis-aligned box in scene space. */
export interface SceneBox {
  min: Vec3;
  max: Vec3;
}

/** The subset of the 3D tile manifest that `CoordinateFrame` reads. */
export interface SceneManifestLike {
  scene: {
    coordinateSystem?: string;
    origin?: number[];
    bounds?: { min: number[]; max: number[] };
  };
}

/** Options for the {@link CoordinateFrame} constructor. */
export interface CoordinateFrameOptions {
  /** PROJ.4 string from the `.xodr` `<geoReference>`. */
  projString: string;
  /**
   * Translation applied *after* the axis swap, in scene units.
   * Defaults to `[0, 0, 0]`, which is correct for `city-preprocess` manifests.
   */
  sceneOrigin?: Vec3;
  /** Road-network extents from the `.xodr` header, if known. */
  extents?: MapExtents;
  /** `manifest.scene.origin` (tile-grid anchor), carried for reference. */
  tileGridOrigin?: Vec3;
  /** `manifest.scene.bounds`, carried for calibration reporting. */
  sceneBounds?: SceneBox;
}

/** Result of {@link CoordinateFrame.calibrationReport}. */
export interface CalibrationReport {
  /** The xodr extent rectangle pushed through `localToScene`. */
  mappedExtents: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** `manifest.scene.bounds` for comparison. */
  sceneBounds: SceneBox;
  /**
   * Per-side slack, in metres, of the scene box around the mapped extents.
   * All values are >= 0 when the scene box contains the road network.
   */
  residuals: { west: number; east: number; south: number; north: number };
  /** True when every residual is >= `-tolerance`. */
  contained: boolean;
}

function toTuple(v: Vec3Like): Vec3 {
  return Array.isArray(v) ? [v[0], v[1], v[2]] : [v.x, v.y, v.z];
}

/**
 * Bidirectional transforms between WGS84, OpenDRIVE-local and the y-up 3D
 * scene frame for a single map.
 *
 * @example
 * ```ts
 * const frame = CoordinateFrame.fromMapAssets(headerText, manifest);
 * const [x, y, z] = frame.wgs84ToScene(-122.1491, 37.4275);
 * ```
 */
export class CoordinateFrame {
  /** PROJ.4 string this frame projects with. */
  readonly projString: string;
  /** Translation applied after the axis swap. `[0, 0, 0]` for city-preprocess maps. */
  readonly sceneOrigin: Vec3;
  /** Road-network extents in OpenDRIVE-local metres, when known. */
  readonly extents?: MapExtents;
  /** `manifest.scene.origin` — the LOD tile-grid corner, *not* a translation. */
  readonly tileGridOrigin?: Vec3;
  /** `manifest.scene.bounds`, when a manifest was supplied. */
  readonly sceneBounds?: SceneBox;

  readonly #converter: { forward(c: number[]): number[]; inverse(c: number[]): number[] };

  constructor(options: CoordinateFrameOptions) {
    if (!options.projString?.trim()) {
      throw new Error('CoordinateFrame: projString is required');
    }
    this.projString = options.projString.trim();
    this.sceneOrigin = options.sceneOrigin ?? [0, 0, 0];
    this.extents = options.extents;
    this.tileGridOrigin = options.tileGridOrigin;
    this.sceneBounds = options.sceneBounds;
    this.#converter = proj4('EPSG:4326', this.projString);
  }

  /**
   * Build a frame from the raw assets a map ships with.
   *
   * @param xodrHeaderText Raw `.xodr` text (a leading slice is enough — see
   *   {@link parseXodrHeader}).
   * @param manifest The 3D scene manifest (`3d/manifest.json`). Optional; when
   *   omitted the frame still works, it just cannot report calibration.
   * @param sceneOrigin Override the post-swap translation. Only pass this for
   *   pipelines that recentre their scenes; city-preprocess maps do not.
   * @throws If the manifest declares a coordinate system other than `y-up`.
   */
  static fromMapAssets(
    xodrHeaderText: string,
    manifest?: SceneManifestLike,
    sceneOrigin?: Vec3,
  ): CoordinateFrame {
    return CoordinateFrame.fromHeader(parseXodrHeader(xodrHeaderText), manifest, sceneOrigin);
  }

  /**
   * Build a frame from an already-parsed header.
   *
   * The same thing as {@link fromMapAssets} for callers that reached for
   * {@link fetchXodrHeader} — which Range-requests 16 KB instead of pulling a
   * 6 MB `.xodr` — and therefore hold a parsed {@link XodrHeader} rather than
   * text. Without this, every such caller hand-wires `sceneBounds` and
   * `tileGridOrigin` out of the manifest, and the one that forgets `sceneBounds`
   * silently loses {@link calibrationReport}.
   *
   * @param header Parsed `.xodr` header.
   * @param manifest The 3D scene manifest (`3d/manifest.json`). Optional; when
   *   omitted the frame still works, it just cannot report calibration.
   * @param sceneOrigin Override the post-swap translation. Only pass this for
   *   pipelines that recentre their scenes; city-preprocess maps do not.
   * @throws If the manifest declares a coordinate system other than `y-up`.
   */
  static fromHeader(
    header: XodrHeader,
    manifest?: SceneManifestLike,
    sceneOrigin?: Vec3,
  ): CoordinateFrame {
    const cs = manifest?.scene?.coordinateSystem;
    if (cs !== undefined && cs !== 'y-up') {
      throw new Error(
        `CoordinateFrame: manifest declares coordinateSystem "${cs}"; only "y-up" is supported`,
      );
    }
    const rawOrigin = manifest?.scene?.origin;
    const rawBounds = manifest?.scene?.bounds;
    return new CoordinateFrame({
      projString: header.projString,
      extents: header.extents,
      sceneOrigin,
      tileGridOrigin:
        rawOrigin && rawOrigin.length >= 3
          ? [rawOrigin[0] as number, rawOrigin[1] as number, rawOrigin[2] as number]
          : undefined,
      sceneBounds:
        rawBounds && rawBounds.min.length >= 3 && rawBounds.max.length >= 3
          ? {
              min: [rawBounds.min[0] as number, rawBounds.min[1] as number, rawBounds.min[2] as number],
              max: [rawBounds.max[0] as number, rawBounds.max[1] as number, rawBounds.max[2] as number],
            }
          : undefined,
    });
  }

  /** WGS84 degrees -> OpenDRIVE-local metres (x-east, y-north). */
  wgs84ToLocal(lon: number, lat: number): Vec2 {
    const out = this.#converter.forward([lon, lat]);
    return [out[0] as number, out[1] as number];
  }

  /** OpenDRIVE-local metres -> WGS84 degrees `[lon, lat]`. */
  localToWgs84(x: number, y: number): Vec2 {
    const out = this.#converter.inverse([x, y]);
    return [out[0] as number, out[1] as number];
  }

  /**
   * OpenDRIVE-local (z-up) -> scene (y-up).
   *
   * @param x Local easting.
   * @param y Local northing.
   * @param z Local elevation (defaults to 0).
   */
  localToScene(x: number, y: number, z = 0): Vec3 {
    const o = this.sceneOrigin;
    return [x + o[0], z + o[1], -y + o[2]];
  }

  /** Scene (y-up) -> OpenDRIVE-local `[x, y, z]` (z-up). */
  sceneToLocal(v: Vec3Like): Vec3 {
    const [sx, sy, sz] = toTuple(v);
    const o = this.sceneOrigin;
    return [sx - o[0], -(sz - o[2]), sy - o[1]];
  }

  /**
   * WGS84 degrees -> scene metres.
   *
   * @param elev Local elevation in metres (ground height); defaults to 0.
   */
  wgs84ToScene(lon: number, lat: number, elev = 0): Vec3 {
    const [x, y] = this.wgs84ToLocal(lon, lat);
    return this.localToScene(x, y, elev);
  }

  /** Scene metres -> WGS84 `[lon, lat]`. */
  sceneToWgs84(v: Vec3Like): Vec2 {
    const [x, y] = this.sceneToLocal(v);
    return this.localToWgs84(x, y);
  }

  /**
   * Is an OpenDRIVE-local point inside the road-network extents?
   *
   * Useful for quarantining bad source rows — Yale Street's signals layer
   * contains four `Stop Line` features whose `t` offset is ~1.7 km, which
   * projects them onto the projection origin far outside the map.
   *
   * @param margin Extra slack in metres. Defaults to 25 m, roughly the widest
   *   the network's own furniture strays past the declared extents.
   * @returns `true` when the frame has no extents to test against.
   */
  localWithinExtents(x: number, y: number, margin = 25): boolean {
    const e = this.extents;
    if (!e) return true;
    return (
      x >= e.west - margin &&
      x <= e.east + margin &&
      y >= e.south - margin &&
      y <= e.north + margin
    );
  }

  /**
   * The `.xodr` extent rectangle expressed in scene space (y is left at 0).
   *
   * @throws If the frame was built without header extents.
   */
  extentsToSceneBox(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const e = this.extents;
    if (!e) throw new Error('CoordinateFrame: no xodr extents available');
    const a = this.localToScene(e.west, e.south, 0);
    const b = this.localToScene(e.east, e.north, 0);
    return {
      minX: Math.min(a[0], b[0]),
      maxX: Math.max(a[0], b[0]),
      minZ: Math.min(a[2], b[2]),
      maxZ: Math.max(a[2], b[2]),
    };
  }

  /**
   * Compare the mapped road-network extents against the manifest scene bounds.
   *
   * The scene box legitimately *contains* the road box (it also covers
   * vegetation, terrain and buildings beyond the road network), so containment
   * with small non-negative residuals is the pass condition — not equality.
   *
   * @param tolerance Metres of allowed negative slack before `contained` flips false.
   */
  calibrationReport(tolerance = 0.5): CalibrationReport {
    const bounds = this.sceneBounds;
    if (!bounds) throw new Error('CoordinateFrame: no manifest scene bounds available');
    const m = this.extentsToSceneBox();
    const residuals = {
      west: m.minX - bounds.min[0],
      east: bounds.max[0] - m.maxX,
      south: m.minZ - bounds.min[2],
      north: bounds.max[2] - m.maxZ,
    };
    return {
      mappedExtents: m,
      sceneBounds: bounds,
      residuals,
      contained: Object.values(residuals).every((r) => r >= -tolerance),
    };
  }
}
