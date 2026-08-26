import type { SignalFeature } from './signals.js';

export interface PoleCameraIntrinsics {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

export interface PoleCameraCorrection {
  yawDeg?: number;
  pitchDeg?: number;
  heightM?: number;
  forwardM?: number;
}

export interface PoleCamera {
  /** Channel id, for example `ch1`. */
  id: string;
  /** Compass bearing the camera looks along: 0° north, 90° east. */
  headingDeg: number;
  /** Negative values look down. */
  pitchDeg: number;
  mountHeightM: number;
  intrinsics: PoleCameraIntrinsics;
  correction?: PoleCameraCorrection;
  /**
   * Runtime feed location. Stream URLs and credentials belong in deployment
   * configuration and must never be baked into a map bundle.
   */
  streamUrl?: string;
  label?: string;
}

export interface PoleCameraRig {
  featureId: string;
  label?: string;
  cameras: readonly PoleCamera[];
}

export interface ResolvedCameraPose {
  position: [number, number, number];
  target: [number, number, number];
  verticalFovDeg: number;
  yawDeg: number;
  pitchDeg: number;
}


const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}


/**
 * Resolve a configured pole camera into the viewer's y-up scene frame.
 *
 * `SignalFeature.position` is the mast base. `zOffset` is intentionally not
 * used: it describes the signal-head height, which is independent of the
 * camera's explicit mounting height. Compass bearing is converted to scene yaw
 * by subtracting 90°: north points toward -Z and east toward +X. A correction's
 * forward offset follows the corrected optical bearing.
 */
export function resolveCameraPose(
  feature: Pick<SignalFeature, 'position' | 'zOffset'>,
  camera: PoleCamera,
  opts?: { groundHeight?: number; poleHeadingDeg?: number },
): ResolvedCameraPose {
  const { correction } = camera;
  const width = requireFinite(camera.intrinsics.width, 'camera.intrinsics.width');
  const height = requireFinite(camera.intrinsics.height, 'camera.intrinsics.height');
  const fy = requireFinite(camera.intrinsics.fy, 'camera.intrinsics.fy');
  if (width <= 0 || height <= 0 || fy <= 0) {
    throw new RangeError('camera intrinsics width, height, and fy must be greater than zero');
  }

  const yawDeg =
    requireFinite(camera.headingDeg, 'camera.headingDeg') +
    requireFinite(opts?.poleHeadingDeg ?? 0, 'opts.poleHeadingDeg') +
    requireFinite(correction?.yawDeg ?? 0, 'camera.correction.yawDeg') -
    90;
  const pitchDeg =
    requireFinite(camera.pitchDeg, 'camera.pitchDeg') +
    requireFinite(correction?.pitchDeg ?? 0, 'camera.correction.pitchDeg');
  const yawRad = yawDeg * DEG_TO_RAD;
  const pitchRad = pitchDeg * DEG_TO_RAD;
  const forwardM = requireFinite(correction?.forwardM ?? 0, 'camera.correction.forwardM');
  const groundY = requireFinite(opts?.groundHeight ?? feature.position[1], 'ground height');

  const position: [number, number, number] = [
    requireFinite(feature.position[0], 'feature.position[0]') + Math.cos(yawRad) * forwardM,
    groundY +
      requireFinite(camera.mountHeightM, 'camera.mountHeightM') +
      requireFinite(correction?.heightM ?? 0, 'camera.correction.heightM'),
    requireFinite(feature.position[2], 'feature.position[2]') + Math.sin(yawRad) * forwardM,
  ];
  const horizontal = Math.cos(pitchRad);
  const target: [number, number, number] = [
    position[0] + Math.cos(yawRad) * horizontal,
    position[1] + Math.sin(pitchRad),
    position[2] + Math.sin(yawRad) * horizontal,
  ];

  return {
    position,
    target,
    verticalFovDeg: 2 * Math.atan(height / (2 * fy)) * RAD_TO_DEG,
    yawDeg,
    pitchDeg,
  };
}

/** Resolve only the explicitly configured pole; never guess by proximity. */
export function findRigFeature(
  features: readonly SignalFeature[],
  rig: PoleCameraRig,
): SignalFeature | null {
  return features.find((feature) => feature.id === rig.featureId) ?? null;
}
