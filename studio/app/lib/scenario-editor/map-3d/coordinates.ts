/**
 * THE bridge between the editor's runtime frame and the MapLibre map's mercator
 * frame, for the map's 3D mode. Pure: no three.js, no maplibre-gl, no DOM, so
 * the one piece of math that can be wrong in a way that looks almost right is
 * the piece with tests around it.
 *
 * ## Why this is not `preview-3d/coordinates.ts`
 *
 * The docked 3D viewport owns its own camera and can pick any scene frame it
 * likes. This layer does not: it shares MapLibre's camera, so the scene frame is
 * dictated by the matrix MapLibre hands the layer. Both modules happen to land
 * on the SAME frame (north on -z, `rotation.y = +yaw`) — see the derivation
 * below — but that is a result, not an assumption, and it is re-derived here so
 * that deleting the preview-3d module cannot silently change it.
 *
 * ## The frames
 *
 * - **Runtime frame** (`PreviewFrame` actors, `bundle.runtime.traffic_lights`):
 *   `x` east, `y` north, `z` up, metres; `yaw` DEGREES counter-clockwise from
 *   +x, so heading is `(cos yaw, sin yaw)` in (east, north).
 * - **Mercator frame** (MapLibre): `x` east, `y` SOUTH, `z` up, in "mercator
 *   units" where 1 unit spans the whole world at the equator. Left-handed.
 * - **Scene frame** (three.js, right-handed, y-up): derived below.
 *
 * ## The camera composition, and what it implies about the scene frame
 *
 * MapLibre hands `render(gl, matrix)` a mercator -> clip matrix. The canonical
 * three-in-maplibre bridge folds the rest into the projection matrix:
 *
 *     projection = M_maplibre * translate(origin) * scale(s, -s, s) * rotateX(pi/2)
 *
 * where `origin` is a fixed mercator anchor and `s` is
 * `meterInMercatorCoordinateUnits()` at that anchor's latitude. Read right to
 * left, a scene point `(x, y, z)` becomes:
 *
 *     rotateX(pi/2):    (x, y, z) -> (x, -z,  y)
 *     scale(s, -s, s):           -> (s*x, s*z, s*y)
 *     translate(origin):         -> origin + (s*x, s*z, s*y)
 *
 * and since mercator is (east, south, up):
 *
 *     scene.x -> east      scene.y -> up      scene.z -> SOUTH
 *
 * So north is on -z, exactly as `preview-3d/coordinates.ts` chose independently.
 * The basis (east, up, south) is right-handed in the physical world — east x up
 * = south — so the scene frame is a proper right-handed frame and no geometry
 * is mirrored. The `-s` is not a typo and cannot be tidied away: it is what
 * reconciles mercator's south-positive Y with a physical up-positive frame.
 *
 * ## Heading
 *
 * Vehicle meshes here are built +X-forward. Rotating by `rotation.y = t` sends
 * local +X to `(cos t, 0, -sin t)`. The wanted scene heading for runtime yaw
 * `psi` is east `cos psi`, north `sin psi`, and north is -z, so the wanted
 * vector is `(cos psi, 0, -sin psi)`. Identical expression, therefore:
 *
 *     mesh.rotation.y = degreesToRadians(actor.yaw)      // no negation
 *
 * The 2D overlay's `90 - yaw` (`useScenarioEditorMapModel.ts`) is not a rival
 * convention — it is the same yaw converted for CSS `rotate()`, which is
 * clockwise-from-north because the SVG car's nose points up.
 *
 * ## Positions: exact, not linearised
 *
 * Object positions are NOT computed by treating the runtime frame as locally
 * flat around one anchor. Each object goes runtime -> lng/lat through the
 * existing proj4-backed `runtimePointToLngLat`, then lng/lat -> mercator, and
 * only the SUBTRACTION from the anchor happens here. Positions therefore land
 * exactly where the 2D SVG markers land, by construction, with no drift across
 * a 2 km bundle.
 *
 * The one shared quantity is `metersToMercator`, taken at the anchor's latitude
 * and used for every object's SIZE. Across a 2 km span `cos(lat)` varies by
 * ~0.02%, i.e. under 1 mm on a 4.7 m car. Grid convergence between the runtime
 * frame's transverse-mercator north and web-mercator north is
 * `atan(tan(dlon) * sin(lat))`, under 0.01 degrees for a bundle spanning less
 * than 0.02 degrees of longitude, and is likewise ignored.
 */

export interface RuntimePoint3 {
  x: number;
  y: number;
  z?: number;
}

export interface ScenePoint3 {
  x: number;
  y: number;
  z: number;
}

/** A mercator-frame point: x east, y south, z up, in mercator units. */
export interface MercatorPoint3 {
  x: number;
  y: number;
  z: number;
}

/**
 * The fixed mercator anchor the scene is expressed relative to, plus the metre
 * scale at its latitude. Supplied by the GL layer from maplibre's own
 * `MercatorCoordinate`, so there is no second implementation of the projection.
 */
export interface SceneAnchor extends MercatorPoint3 {
  /** `MercatorCoordinate.meterInMercatorCoordinateUnits()` at the anchor. */
  metersToMercator: number;
}

/** North lives on -z. See the module header for the derivation. */
export const MAP_3D_SCENE_NORTH_AXIS_SIGN = -1;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

export function degreesToRadians(degrees: number): number {
  return degrees * DEG2RAD;
}

/** Normalised to `[0, 360)`, matching the frontend's `normalizeYawDegrees`. */
export function normalizeYawDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * Runtime yaw (degrees CCW from east) -> `rotation.y` in radians, for a mesh
 * whose local +X is its forward axis.
 */
export function runtimeYawToSceneRotationY(yawDegrees: number): number {
  return degreesToRadians(Number.isFinite(yawDegrees) ? yawDegrees : 0);
}

/** Inverse of {@link runtimeYawToSceneRotationY}, normalised to `[0, 360)`. */
export function sceneRotationYToRuntimeYaw(rotationY: number): number {
  return normalizeYawDegrees(rotationY * RAD2DEG);
}

/**
 * The scene-frame unit vector an actor at `yawDegrees` travels along. Tests use
 * it as the independent check that {@link runtimeYawToSceneRotationY} orients a
 * +X-forward mesh correctly.
 */
export function runtimeYawToSceneHeading(yawDegrees: number): ScenePoint3 {
  const radians = degreesToRadians(yawDegrees);
  return {
    x: Math.cos(radians),
    y: 0,
    z: MAP_3D_SCENE_NORTH_AXIS_SIGN * Math.sin(radians),
  };
}

/**
 * Recover runtime yaw from the 2D marker's CSS rotation.
 *
 * The 3D layer is fed the same `RuntimeActorMarker[]` the SVG markers consume,
 * which is what makes the two renderers agree about where every actor is by
 * construction. That array carries `rotationDeg` — a CSS `rotate()` value,
 * clockwise-from-north, because the SVG car's nose points up — rather than the
 * runtime yaw a mesh needs. `useScenarioEditorMapModel` builds it as
 * `90 - yaw` for vehicles and passes yaw straight through for everything else
 * (a walker glyph has no nose). This is the exact inverse, and it is here rather
 * than inline in the layer so there is one place to change if that ever moves.
 */
export function markerRotationToRuntimeYawDegrees(
  kind: string | null | undefined,
  rotationDegrees: number,
): number {
  const rotation = Number.isFinite(rotationDegrees) ? rotationDegrees : 0;
  return kind === "vehicle" ? 90 - rotation : rotation;
}

/** Mercator point -> scene metres relative to `anchor`. */
export function mercatorToScenePosition(
  anchor: SceneAnchor,
  point: MercatorPoint3,
): ScenePoint3 {
  const inverseScale = 1 / anchor.metersToMercator;
  return {
    x: (point.x - anchor.x) * inverseScale,
    // Mercator y grows south and scene z grows south, so this is a straight
    // difference — the sign flip lives in the camera matrix, not here.
    z: (point.y - anchor.y) * inverseScale,
    y: (point.z - anchor.z) * inverseScale,
  };
}

/** Inverse of {@link mercatorToScenePosition}. Exists so tests can round-trip. */
export function sceneToMercatorPosition(
  anchor: SceneAnchor,
  point: ScenePoint3,
): MercatorPoint3 {
  return {
    x: anchor.x + point.x * anchor.metersToMercator,
    y: anchor.y + point.z * anchor.metersToMercator,
    z: anchor.z + point.y * anchor.metersToMercator,
  };
}

// ---------------------------------------------------------------------------
// Column-major 4x4 matrices, in the layout WebGL and three.js both consume.
//
// Hand-rolled rather than reached for from three so that the composition can be
// asserted in a jsdom unit test with no GL context anywhere near it.
// ---------------------------------------------------------------------------

export type Matrix4Array = number[];

export function identityMatrix4(): Matrix4Array {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** `a * b`, both column-major. */
export function multiplyMatrix4(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): Matrix4Array {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += a[k * 4 + row]! * b[column * 4 + k]!;
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function translationMatrix4(x: number, y: number, z: number): Matrix4Array {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function scalingMatrix4(x: number, y: number, z: number): Matrix4Array {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

export function rotationXMatrix4(radians: number): Matrix4Array {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}

/** Apply a column-major matrix to a point (w = 1), returning the raw clip vec4. */
export function applyMatrix4(
  matrix: ArrayLike<number>,
  point: ScenePoint3,
): { x: number; y: number; z: number; w: number } {
  const { x, y, z } = point;
  return {
    x: matrix[0]! * x + matrix[4]! * y + matrix[8]! * z + matrix[12]!,
    y: matrix[1]! * x + matrix[5]! * y + matrix[9]! * z + matrix[13]!,
    z: matrix[2]! * x + matrix[6]! * y + matrix[10]! * z + matrix[14]!,
    w: matrix[3]! * x + matrix[7]! * y + matrix[11]! * z + matrix[15]!,
  };
}

/**
 * The per-frame camera matrix: scene metres -> clip space, given MapLibre's
 * mercator -> clip matrix for this frame.
 *
 * `mapProjectionMatrix` is the `matrix` argument of `CustomLayerInterface.render`.
 */
export function composeSceneCameraMatrix(
  mapProjectionMatrix: ArrayLike<number>,
  anchor: SceneAnchor,
): Matrix4Array {
  const s = anchor.metersToMercator;
  const model = multiplyMatrix4(
    multiplyMatrix4(
      translationMatrix4(anchor.x, anchor.y, anchor.z),
      scalingMatrix4(s, -s, s),
    ),
    rotationXMatrix4(Math.PI / 2),
  );
  return multiplyMatrix4(mapProjectionMatrix, model);
}

/**
 * Metres per screen pixel at a given zoom and latitude — the web-mercator
 * standard, and the basis for every "how big is this on screen" decision the 3D
 * mode makes.
 */
export const EQUATOR_METERS_PER_PIXEL_AT_Z0 = 156543.03392;

export function metersPerPixel(zoom: number, latitudeDegrees: number): number {
  const latitude = Number.isFinite(latitudeDegrees) ? latitudeDegrees : 0;
  const safeZoom = Number.isFinite(zoom) ? zoom : 0;
  return (
    (EQUATOR_METERS_PER_PIXEL_AT_Z0 * Math.cos(latitude * DEG2RAD)) /
    Math.pow(2, safeZoom)
  );
}
