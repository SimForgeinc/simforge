import { describe, expect, it } from "vitest";
import type { PoleCameraRig } from "@simforge-oss/maps/camera-rig";
import {
  CAMERA_ADJUSTMENTS_STORAGE_KEY,
  applyCameraAdjustment,
  cameraAdjustmentKey,
  exportAdjustedRigs,
  loadCameraAdjustments,
  saveCameraAdjustments,
  wrapHeading,
  type CameraAdjustment,
} from "./camera-adjustments";

const rig: PoleCameraRig = {
  featureId: "372",
  label: "RFS Mast 1",
  cameras: [
    {
      id: "ch1",
      label: "cam-001-ch1",
      headingDeg: 153.94,
      pitchDeg: -39.2,
      mountHeightM: 7,
      intrinsics: { fx: 1325.4, fy: 1325.4, cx: 1280, cy: 960, width: 2560, height: 1920 },
      correction: { yawDeg: 0, pitchDeg: 0, heightM: 0, forwardM: 0.5 },
      streamUrl: "/streams/ch1.mjpg",
    },
  ],
};

const adjustment: CameraAdjustment = {
  headingDeg: 201.25,
  pitchDeg: -33.5,
  mountHeightM: 7.25,
  correction: { yawDeg: 1.5, pitchDeg: -2.25, heightM: 0.1, forwardM: 1.75 },
};

describe("pole camera adjustments", () => {
  it("wraps compass headings in both directions", () => {
    expect(wrapHeading(371.25)).toBe(11.25);
    expect(wrapHeading(-5)).toBe(355);
  });

  it("applies a copied adjustment without mutating the loaded camera", () => {
    const loadedCamera = rig.cameras[0];
    const adjusted = applyCameraAdjustment(loadedCamera, adjustment);

    expect(adjusted).toMatchObject(adjustment);
    expect(adjusted.intrinsics).toBe(loadedCamera.intrinsics);
    expect(loadedCamera.headingDeg).toBe(153.94);
    expect(loadedCamera.correction?.forwardM).toBe(0.5);
  });

  it("persists only finite complete records and restores the versioned payload", () => {
    let value = "";
    const storage = {
      getItem: (key: string) => key === CAMERA_ADJUSTMENTS_STORAGE_KEY ? value : null,
      setItem: (key: string, next: string) => {
        expect(key).toBe(CAMERA_ADJUSTMENTS_STORAGE_KEY);
        value = next;
      },
    };
    const key = cameraAdjustmentKey("372", "ch1");

    saveCameraAdjustments(storage, { [key]: adjustment });
    expect(loadCameraAdjustments(storage)).toEqual({ [key]: adjustment });

    value = JSON.stringify({ valid: adjustment, incomplete: { headingDeg: 12 }, infinite: { ...adjustment, pitchDeg: null } });
    expect(loadCameraAdjustments(storage)).toEqual({ valid: adjustment });
  });

  it("exports the complete rig envelope with only the selected camera values folded in", () => {
    const key = cameraAdjustmentKey("372", "ch1");
    const payload = JSON.parse(exportAdjustedRigs([rig], { [key]: adjustment })) as { rigs: PoleCameraRig[] };

    expect(payload.rigs).toHaveLength(1);
    expect(payload.rigs[0]).toEqual({
      ...rig,
      cameras: [{ ...rig.cameras[0], ...adjustment, correction: adjustment.correction }],
    });
    expect(rig.cameras[0].headingDeg).toBe(153.94);
  });
});
