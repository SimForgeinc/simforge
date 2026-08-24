import { Box3, MathUtils, PerspectiveCamera, Vector3 } from 'three';

export interface CameraClampFlags {
  eyeX: boolean;
  eyeY: boolean;
  eyeZ: boolean;
  targetX: boolean;
  targetY: boolean;
  targetZ: boolean;
}

export interface CameraEnvelope {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minTargetY: number;
  maxTargetY: number;
  minEyeY: number;
  maxEyeY: number;
}

export function cameraEnvelopeFromBounds(
  sceneBox: Box3,
  inset: number,
  groundY: number,
  maxAltitude: number,
): CameraEnvelope {
  const sizeX = sceneBox.max.x - sceneBox.min.x;
  const sizeZ = sceneBox.max.z - sceneBox.min.z;
  const safeInset = Math.max(0, Math.min(inset, sizeX * 0.25, sizeZ * 0.25));
  const minEyeY = groundY + 2;
  const safeMaxAltitude = Math.max(minEyeY, maxAltitude);
  return {
    minX: sceneBox.min.x + safeInset,
    maxX: sceneBox.max.x - safeInset,
    minZ: sceneBox.min.z + safeInset,
    maxZ: sceneBox.max.z - safeInset,
    minTargetY: groundY,
    maxTargetY: safeMaxAltitude,
    minEyeY,
    maxEyeY: safeMaxAltitude,
  };
}

/**
 * Constrain both ends of the view ray to the loaded map footprint.
 *
 * Target overflow translates the eye by the same amount first, preserving the
 * authored view whenever possible. The eye is then clamped independently so a
 * very long orbit or pan can never put the editor outside its source map.
 */
export function constrainCameraToEnvelope(
  camera: PerspectiveCamera,
  target: Vector3,
  envelope: CameraEnvelope,
): CameraClampFlags {
  const originalTarget = target.clone();
  const originalEye = camera.position.clone();
  const targetX = MathUtils.clamp(finite(target.x, midpoint(envelope.minX, envelope.maxX)), envelope.minX, envelope.maxX);
  const targetZ = MathUtils.clamp(finite(target.z, midpoint(envelope.minZ, envelope.maxZ)), envelope.minZ, envelope.maxZ);
  const finiteTargetX = finite(target.x, targetX);
  const finiteTargetZ = finite(target.z, targetZ);
  target.x = targetX;
  target.z = targetZ;
  camera.position.x = finite(camera.position.x, targetX);
  camera.position.z = finite(camera.position.z, targetZ);
  const shiftX = targetX - finiteTargetX;
  const shiftZ = targetZ - finiteTargetZ;
  // Avoid even an algebraic `+ 0 - 0`: it can round the eye by an ULP and
  // violates eye-orbit's byte-exact position contract.
  if (shiftX !== 0) camera.position.x += shiftX;
  if (shiftZ !== 0) camera.position.z += shiftZ;

  target.y = MathUtils.clamp(finite(target.y, envelope.minTargetY), envelope.minTargetY, envelope.maxTargetY);
  camera.position.x = MathUtils.clamp(camera.position.x, envelope.minX, envelope.maxX);
  camera.position.y = MathUtils.clamp(finite(camera.position.y, envelope.minEyeY), envelope.minEyeY, envelope.maxEyeY);
  camera.position.z = MathUtils.clamp(camera.position.z, envelope.minZ, envelope.maxZ);

  return {
    eyeX: camera.position.x !== originalEye.x,
    eyeY: camera.position.y !== originalEye.y,
    eyeZ: camera.position.z !== originalEye.z,
    targetX: target.x !== originalTarget.x,
    targetY: target.y !== originalTarget.y,
    targetZ: target.z !== originalTarget.z,
  };
}

export function initialEditorCameraPose(
  center: Vector3,
  size: Vector3,
  groundY: number,
  buildingMax: number,
  maxAltitude: number,
): { position: Vector3; target: Vector3; maxDistance: number } {
  const span = Math.max(size.x, size.z);
  const neighborhood = Math.min(95, Math.max(32, Math.min(size.x, size.z) * 0.08));
  const eyeY = Math.min(maxAltitude, Math.max(buildingMax + 5, groundY + 20));
  return {
    position: new Vector3(center.x - neighborhood * 0.62, eyeY, center.z + neighborhood * 0.78),
    target: new Vector3(center.x, groundY + 1.5, center.z),
    maxDistance: Math.max(60, Math.min(500, span * 0.25)),
  };
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function midpoint(a: number, b: number): number {
  return (a + b) * 0.5;
}
