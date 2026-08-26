import {
  SDG_OUTPUTS,
  SDG_RAW_OUTPUT_MODALITIES,
  expandSdgOutputs,
  getRequiredSdgRawModalities,
  type SdgOutput,
  type SdgRecipeConfig,
  type Sensor,
  type SensorOutputModality,
} from "@simforge-oss/studio-shared";

export type { SdgOutput };

export function getSdgRequestedOutputs(
  config: SdgRecipeConfig,
): SdgOutput[] {
  const configured = expandSdgOutputs(config.recorder_config.outputs);
  return configured.length > 0 ? configured : [...SDG_OUTPUTS];
}

export function getSensorSupportedOutputModalities(sensor: Sensor): SensorOutputModality[] {
  const configured = sensor.supportedOutputModalities?.filter(Boolean) ?? [];
  if (configured.length > 0) return configured;
  return [sensor.outputModality];
}

export function isSdgEligibleCameraMount(sensor: Sensor) {
  return sensor.sensorCategory === "camera";
}

/** Camera mounts for profile-driven sensor expansion. Render outputs are selected separately. */
export function getProfileExpansionCameras(sensors: Sensor[]): Sensor[] {
  return sensors.filter(isSdgEligibleCameraMount);
}

export function getSdgPrimaryCameraMount(
  sensors: Sensor[],
): Sensor | null {
  const eligible = getProfileExpansionCameras(sensors);
  const preferred = eligible.find((sensor) => sensor.mountRole === "sdg_primary");
  return preferred ?? eligible[0] ?? null;
}

export function getMissingSdgSensorOutputs(
  config: SdgRecipeConfig,
  sensors: Sensor[],
): SensorOutputModality[] {
  const eligible = getProfileExpansionCameras(sensors);
  if (eligible.length === 0) return [...SDG_RAW_OUTPUT_MODALITIES];
  // Profile expansion synthesises one CARLA sensor per (camera, modality).
  // Frontend has no per-camera modality whitelist anymore — every camera
  // mount emits every requested modality — so nothing is missing as long as
  // at least one camera survives.
  return [];
}

export function getSdgSensorConfigWarning(
  configOrSensors: SdgRecipeConfig | Sensor[],
  maybeSensors?: Sensor[],
): string | null {
  const sensors = Array.isArray(configOrSensors) ? configOrSensors : maybeSensors ?? [];
  const eligible = getProfileExpansionCameras(sensors);
  if (eligible.length === 0) {
    return "Add at least one camera mount to run SDG export.";
  }
  return null;
}

function compiledSensorId(base: Sensor, modality: SensorOutputModality) {
  return modality === "rgb" ? base.id : `${base.id}__${modality}`;
}

function compiledSensorLabel(base: Sensor, modality: SensorOutputModality) {
  if (modality === "rgb") return base.label;
  return `${base.label} ${modality.replaceAll("_", " ")}`;
}

function createCompiledSensor(
  base: Sensor,
  modality: SensorOutputModality,
  mountId: string,
  mountLabel: string,
): Sensor {
  return {
    ...base,
    id: compiledSensorId(base, modality),
    label: compiledSensorLabel(base, modality),
    outputModality: modality,
    mountId,
    mountLabel,
    mountRole: "sdg_primary",
    supportedOutputModalities: [modality],
    sourceSensorId: base.id,
  };
}

/**
 * Profile-agnostic sensor expansion. For every camera in the rig, emit one
 * CARLA sensor per requested modality at the camera's pose. Non-camera
 * sensors (lidar, etc.) pass through unchanged.
 */
export function expandSensorsForProfile(
  sensors: Sensor[],
  modalitiesToEmit: SensorOutputModality[],
): Sensor[] {
  const expansionModalities = modalitiesToEmit.filter(
    (value, index, all) => all.indexOf(value) === index,
  );
  if (expansionModalities.length === 0) return sensors;

  const expanded: Sensor[] = [];
  for (const sensor of sensors) {
    if (!isSdgEligibleCameraMount(sensor)) {
      expanded.push(sensor);
      continue;
    }
    const mountId = sensor.mountId ?? sensor.id;
    const mountLabel = sensor.mountLabel ?? sensor.label;
    for (const modality of expansionModalities) {
      expanded.push(createCompiledSensor(sensor, modality, mountId, mountLabel));
    }
  }
  return expanded;
}

export function compileSdgSensors(
  config: SdgRecipeConfig,
  sensors: Sensor[],
): Sensor[] {
  return compileSdgSensorsForOutputs(getSdgRequestedOutputs(config), sensors);
}

export function compileSdgSensorsForOutputs(
  outputs: SdgOutput[],
  sensors: Sensor[],
): Sensor[] {
  const eligible = getProfileExpansionCameras(sensors);
  if (eligible.length === 0) return sensors;
  const requiredOutputs = getRequiredSdgRawModalities(
    outputs,
  );
  return expandSensorsForProfile(sensors, requiredOutputs);
}
