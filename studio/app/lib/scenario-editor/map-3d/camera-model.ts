/**
 * The 3D model for a world-placed camera.
 *
 * A camera you place was visible in 2D and simply absent in 3D — the mode drew
 * actors and signal heads and nothing else — so switching to 3D silently lost
 * every sensor in the scene.
 *
 * It is built as a `Map3DActorModel` (the same parts list `car-model.ts`
 * produces) rather than a new instance kind, because `map-3d-scene.ts` already
 * turns any parts list into meshes in `setActors`. A camera is therefore an
 * actor-shaped instance with camera parts, and the renderer needs no knowledge
 * of sensors at all.
 *
 * Local frame is the one `car-model.ts` uses: **+X forward, +Y up, +Z across**.
 * The lens sits on +X, which is the axis `runtimeYawToSceneRotationY` orients,
 * so the lens points where the sensor's yaw says it looks.
 */

import type { Map3DActorModel, Map3DExtents, Map3DPart } from "./car-model";

/** Housing, in metres. Small enough to read as equipment, not as a vehicle. */
const BODY_LENGTH_M = 0.34;
const BODY_WIDTH_M = 0.18;
const BODY_HEIGHT_M = 0.18;
const LENS_RADIUS_M = 0.07;
const LENS_LENGTH_M = 0.12;
const POLE_RADIUS_M = 0.06;

/**
 * A camera's mount height is authored (`pose.z`), so unlike a car the model is
 * not one fixed shape: the pole is however tall the mount is. Below this the
 * camera is treated as hand-height and gets no pole — a 0.2 m "pole" under a
 * street camera reads as a rendering bug.
 */
const MIN_POLE_HEIGHT_M = 0.6;

export interface Map3DCameraModelInput {
  /** `pose.z` — metres above the ground. */
  mountHeightM: number;
}

export function buildMap3DCameraModel({
  mountHeightM,
}: Map3DCameraModelInput): Map3DActorModel {
  const height = Number.isFinite(mountHeightM) ? Math.max(0, mountHeightM) : 0;
  const drawPole = height >= MIN_POLE_HEIGHT_M;
  // The body hangs at the mount height; with no pole it sits on the ground.
  const bodyCenterY = drawPole ? height : BODY_HEIGHT_M / 2;

  const parts: Map3DPart[] = [];

  if (drawPole) {
    parts.push({
      shape: "cylinder",
      material: "bodyDark",
      // Half the mount height, so the pole runs from the ground to the body.
      position: { x: 0, y: height / 2, z: 0 },
      size: { x: 0, y: 0, z: 0 },
      radius: POLE_RADIUS_M,
      length: height,
      axis: "y",
    });
  }

  parts.push({
    shape: "box",
    material: "body",
    position: { x: 0, y: bodyCenterY, z: 0 },
    size: { x: BODY_LENGTH_M, y: BODY_HEIGHT_M, z: BODY_WIDTH_M },
  });

  parts.push({
    shape: "cylinder",
    material: "glass",
    // Forward of the housing, on the axis the yaw points down.
    position: {
      x: BODY_LENGTH_M / 2 + LENS_LENGTH_M / 2,
      y: bodyCenterY,
      z: 0,
    },
    size: { x: 0, y: 0, z: 0 },
    radius: LENS_RADIUS_M,
    length: LENS_LENGTH_M,
    axis: "x",
  });

  const extents: Map3DExtents = {
    lengthM: BODY_LENGTH_M + LENS_LENGTH_M,
    widthM: BODY_WIDTH_M,
    heightM: Math.max(height + BODY_HEIGHT_M / 2, BODY_HEIGHT_M),
  };

  return { category: "prop", extents, parts };
}
