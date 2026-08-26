import type { PoleCamera, PoleCameraRig } from "@simforge/maps/camera-rig";

export const CAMERA_ADJUSTMENTS_STORAGE_KEY = "simforge.drive.camera-adjustments.v1";

export interface CameraAdjustment {
  headingDeg: number;
  pitchDeg: number;
  mountHeightM: number;
  correction: {
    yawDeg: number;
    pitchDeg: number;
    heightM: number;
    forwardM: number;
  };
}

export type CameraAdjustments = Readonly<Record<string, CameraAdjustment>>;

export function cameraAdjustmentKey(featureId: string, cameraId: string): string {
  return `${featureId}\u0000${cameraId}`;
}

export function wrapHeading(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function adjustmentFromCamera(camera: PoleCamera): CameraAdjustment {
  return {
    headingDeg: wrapHeading(camera.headingDeg),
    pitchDeg: camera.pitchDeg,
    mountHeightM: camera.mountHeightM,
    correction: {
      yawDeg: camera.correction?.yawDeg ?? 0,
      pitchDeg: camera.correction?.pitchDeg ?? 0,
      heightM: camera.correction?.heightM ?? 0,
      forwardM: camera.correction?.forwardM ?? 0,
    },
  };
}

export function applyCameraAdjustment(
  camera: PoleCamera,
  adjustment: CameraAdjustment | undefined,
): PoleCamera {
  if (!adjustment) return camera;
  return {
    ...camera,
    headingDeg: adjustment.headingDeg,
    pitchDeg: adjustment.pitchDeg,
    mountHeightM: adjustment.mountHeightM,
    correction: { ...adjustment.correction },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseAdjustment(value: unknown): CameraAdjustment | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CameraAdjustment>;
  const correction = candidate.correction;
  if (
    !isFiniteNumber(candidate.headingDeg) ||
    !isFiniteNumber(candidate.pitchDeg) ||
    !isFiniteNumber(candidate.mountHeightM) ||
    !correction ||
    !isFiniteNumber(correction.yawDeg) ||
    !isFiniteNumber(correction.pitchDeg) ||
    !isFiniteNumber(correction.heightM) ||
    !isFiniteNumber(correction.forwardM)
  ) {
    return null;
  }
  return {
    headingDeg: wrapHeading(candidate.headingDeg),
    pitchDeg: candidate.pitchDeg,
    mountHeightM: candidate.mountHeightM,
    correction: { ...correction },
  };
}

export function loadCameraAdjustments(storage: Pick<Storage, "getItem"> | null): CameraAdjustments {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(CAMERA_ADJUSTMENTS_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const adjustments: Record<string, CameraAdjustment> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const adjustment = parseAdjustment(value);
      if (adjustment) adjustments[key] = adjustment;
    }
    return adjustments;
  } catch {
    return {};
  }
}

export function saveCameraAdjustments(
  storage: Pick<Storage, "setItem">,
  adjustments: CameraAdjustments,
): void {
  storage.setItem(CAMERA_ADJUSTMENTS_STORAGE_KEY, JSON.stringify(adjustments));
}

export function exportAdjustedRigs(
  rigs: readonly PoleCameraRig[],
  adjustments: CameraAdjustments,
): string {
  return JSON.stringify(
    {
      rigs: rigs.map((rig) => ({
        ...rig,
        cameras: rig.cameras.map((camera) =>
          applyCameraAdjustment(
            camera,
            adjustments[cameraAdjustmentKey(rig.featureId, camera.id)],
          ),
        ),
      })),
    },
    null,
    2,
  );
}
