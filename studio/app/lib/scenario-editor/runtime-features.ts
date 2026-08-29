import type { OpenScenarioRendererRuntime as CarlaRuntime } from "@/app/lib/scenario/renderer/runtime-profile";
import {
  CARLA_RUNTIME_UE5,
  normalizeCarlaRuntime,
} from "@/app/lib/scenario/renderer/runtime-profile";
import type {
  SensorOutputModality,
} from "@simforge-oss/scenario/contracts";

// The normals camera was verified working on the UE5 image (2026-06-12
// spike: standalone spawn + frames + real pixel content), so nothing is
// hidden on UE5 anymore.
export const UE5_HIDDEN_SENSOR_TYPES = [] as const;
export const UE5_HIDDEN_MODALITIES: SensorOutputModality[] = [];
export const UE5_WEATHER_DISABLED_NOTICE = "UE5: weather fixed to daylight";
export const UE5_TRAILING_CAMERA_DISABLED_NOTICE =
  "UE5: trailing camera unavailable for this runtime.";

export type RuntimeFeatures = {
  /** When false, the weather/lighting UI must be disabled and a "fixed to daylight" notice shown. */
  weatherControls: boolean;
  /** Human-readable notice to show when weatherControls is false (null when controls are enabled). */
  weatherDisabledNotice: string | null;
  /** CARLA sensor type strings to hide from sensor pickers (e.g. "sensor.camera.normals"). */
  hiddenSensorTypes: string[];
  /** Output modality values to hide from modality pickers (e.g. "normals"). */
  hiddenModalities: SensorOutputModality[];
  /** When false, the add-vehicle palette/action must be hidden. */
  vehiclesEnabled: boolean;
  /** When false, the add-prop palette/action must be hidden. */
  propsEnabled: boolean;
  /** When false, placed pedestrians stay stationary. */
  walkerMovementEnabled: boolean;
  /** When false, the vehicle-following trailing camera must be disabled. */
  trailingCameraEnabled: boolean;
  /** Human-readable notice to show when vehicles/props are gated. */
  actorsDisabledNotice: string | null;
};

export function runtimeFeatures(
  runtime: CarlaRuntime | string | null | undefined,
): RuntimeFeatures {
  const normalizedRuntime = normalizeCarlaRuntime(runtime);

  if (normalizedRuntime === CARLA_RUNTIME_UE5) {
    return {
      weatherControls: false,
      weatherDisabledNotice: UE5_WEATHER_DISABLED_NOTICE,
      hiddenSensorTypes: [...UE5_HIDDEN_SENSOR_TYPES],
      hiddenModalities: [...UE5_HIDDEN_MODALITIES],
      vehiclesEnabled: true,
      propsEnabled: true,
      walkerMovementEnabled: true,
      trailingCameraEnabled: true,
      actorsDisabledNotice: null,
    };
  }

  return {
    weatherControls: true,
    weatherDisabledNotice: null,
    hiddenSensorTypes: [],
    hiddenModalities: [],
    vehiclesEnabled: true,
    propsEnabled: true,
    walkerMovementEnabled: true,
    trailingCameraEnabled: true,
    actorsDisabledNotice: null,
  };
}
