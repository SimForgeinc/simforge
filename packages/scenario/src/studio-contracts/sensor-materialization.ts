import { z } from 'zod';

import {
  SensorRigPresetSchema,
  sensorRigPreset,
  type SensorRigPreset,
  type SensorRigSensorTemplate,
} from '../schema/v2/sensor-rigs.js';

export const CAMERA_UPDATE_RATE_HZ = 30;
export const LIDAR_UPDATE_RATE_HZ = 20;
export const RADAR_UPDATE_RATE_HZ = 20;
export const LIDAR_CHANNELS = 64;
export const LIDAR_POINTS_PER_SECOND = 1_200_000;
export const LIDAR_ROTATION_FREQUENCY_HZ = 20;

const CameraMaterializationSchema = z.strictObject({
  type: z.literal('dash_camera'),
  templateId: z.string().min(1),
  updateRateHz: z.number().positive(),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  horizontalFovDeg: z.number().positive(),
});
const LidarMaterializationSchema = z.strictObject({
  type: z.literal('lidar'),
  templateId: z.string().min(1),
  updateRateHz: z.number().positive(),
  channels: z.number().int().positive(),
  pointsPerSecond: z.number().int().positive(),
  rotationFrequencyHz: z.number().positive(),
  rangeM: z.number().positive(),
  horizontalFovDeg: z.number().positive().optional(),
  upperFovDeg: z.number(),
  lowerFovDeg: z.number(),
});
const RadarMaterializationSchema = z.strictObject({
  type: z.literal('radar'),
  templateId: z.string().min(1),
  updateRateHz: z.number().positive(),
  horizontalFovDeg: z.number().positive(),
  verticalFovDeg: z.number().positive(),
  rangeM: z.number().positive(),
});

/** Concrete capture parameters produced from a portable rig template. */
export const SensorMaterializationSchema = z.discriminatedUnion('type', [
  CameraMaterializationSchema,
  LidarMaterializationSchema,
  RadarMaterializationSchema,
]);
export type SensorMaterialization = z.infer<typeof SensorMaterializationSchema>;

function cameraResolution(presetId: string, templateId: string): { widthPx: number; heightPx: number } {
  if (presetId === 'nvidia-sdg-av' || presetId === 'alpamayo-pai') {
    return { widthPx: 1920, heightPx: 1208 };
  }
  if (presetId === 'waymo-5th-gen' && templateId === 'waymo-front') {
    return { widthPx: 1920, heightPx: 1280 };
  }
  if (presetId === 'alpamayo-2cam' || presetId === 'alpamayo-4cam') {
    return { widthPx: 512, heightPx: 384 };
  }
  return { widthPx: 854, heightPx: 480 };
}

/** Materialize one rig slot without adding platform attachment or presentation metadata. */
export function materializeSensorRigTemplate(
  presetId: string,
  template: SensorRigSensorTemplate,
): SensorMaterialization {
  if (template.type === 'dash_camera') {
    return SensorMaterializationSchema.parse({
      type: template.type,
      templateId: template.id,
      updateRateHz: CAMERA_UPDATE_RATE_HZ,
      ...cameraResolution(presetId, template.id),
      horizontalFovDeg: template.camera.horizontalFovDeg,
    });
  }
  if (template.type === 'lidar') {
    return SensorMaterializationSchema.parse({
      type: template.type,
      templateId: template.id,
      updateRateHz: LIDAR_UPDATE_RATE_HZ,
      channels: LIDAR_CHANNELS,
      pointsPerSecond: LIDAR_POINTS_PER_SECOND,
      rotationFrequencyHz: LIDAR_ROTATION_FREQUENCY_HZ,
      rangeM: template.field.farM,
      ...(template.field.horizontalFovDeg < 180
        ? { horizontalFovDeg: template.field.horizontalFovDeg }
        : {}),
      upperFovDeg: template.field.verticalFovDeg / 2,
      lowerFovDeg: -template.field.verticalFovDeg / 2,
    });
  }
  return SensorMaterializationSchema.parse({
    type: template.type,
    templateId: template.id,
    updateRateHz: RADAR_UPDATE_RATE_HZ,
    horizontalFovDeg: template.field.horizontalFovDeg,
    verticalFovDeg: template.field.verticalFovDeg,
    rangeM: template.field.farM,
  });
}

/** Materialize every slot in a built-in or caller-supplied rig, preserving order. */
export function materializeSensorRig(presetOrId: SensorRigPreset | string): SensorMaterialization[] {
  const preset = typeof presetOrId === 'string'
    ? sensorRigPreset(presetOrId)
    : SensorRigPresetSchema.parse(presetOrId);
  if (!preset) throw new Error(`unknown sensor rig preset "${presetOrId}"`);
  return preset.sensors.map((template) => materializeSensorRigTemplate(preset.id, template));
}

/** Optional preview overlay; it is never inserted into the portable perception rig itself. */
export const TRAILING_PREVIEW_CAMERA_PRESET = Object.freeze({
  id: 'trailing-camera',
  label: 'Trailing',
  mountId: 'preview_trailing',
  mountRole: 'preview' as const,
  attachmentType: 'spring_arm_ghost' as const,
  mount: {
    position: { x: -5.5, y: 2.8, z: 0 },
    rotation: { yawRad: 0, pitchRad: 15 * Math.PI / 180, rollRad: 0 },
  },
  updateRateHz: CAMERA_UPDATE_RATE_HZ,
  widthPx: 854,
  heightPx: 480,
  horizontalFovDeg: 90,
});
