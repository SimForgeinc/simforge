import { z } from 'zod';

import { RenderSpecV3Schema } from './render-spec.js';
import { EntityIdSchema } from './schema/v1.js';

export const RENDER_INTENT_V1_SCHEMA = 'uniscenario.render-intent/v1' as const;
export const PRONTO_KIA_CATALOG_ASSET_ID = 'vehicle.kia.carnival' as const;
export const PRONTO_KIA_CARLA_BLUEPRINT_ID = 'vehicle.kia.carnival' as const;
export const PRONTO_KIA_CARLA_CLASS_PATH =
  '/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C' as const;
export const PRONTO_CARLA_IMAGE_REPOSITORY =
  'ghcr.io/simforgeinc/carla-rfs-munich-belmont' as const;
export const PRONTO_CARLA_IMAGE_INDEX_SHA256 =
  'f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5' as const;
export const PRONTO_CARLA_IMAGE_AMD64_SHA256 =
  'baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64' as const;
export const PRONTO_SENSOR_RIG_ID = 'pronto.8-camera-6-lidar-4-radar' as const;
/**
 * A trailing presentation camera authored on the sensor host. It rides outside the 8/6/4
 * measurement rig so a render can ship a drive-along view without restating the rig counts.
 */
export const PRONTO_CHASE_CAMERA_SENSOR_ID = 'chase-cam-trailing' as const;

export const RenderSha256Schema = z.string().regex(
  /^[0-9a-f]{64}$/,
  'must be a lowercase hexadecimal SHA-256 digest',
);

export const RenderIntentIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  'must be a stable 1-128 character identifier',
);

export const RenderIntentAssetSchema = z.strictObject({
  assetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
  kind: z.enum(['map', 'catalog', 'texture', 'mesh', 'other']),
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const RenderIntentScenarioRevisionSchema = z.strictObject({
  revisionId: RenderIntentIdSchema,
  scenarioSha256: RenderSha256Schema,
  openScenario: z.strictObject({
    sha256: RenderSha256Schema,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  map: z.strictObject({
    mapId: RenderIntentIdSchema,
    revisionId: RenderIntentIdSchema,
    sha256: RenderSha256Schema,
  }),
});
export const ProntoSensorHostSchema = z.strictObject({
  actorId: EntityIdSchema,
  vehicleAsset: z.strictObject({
    catalogAssetId: z.literal(PRONTO_KIA_CATALOG_ASSET_ID),
    carlaBlueprintId: z.literal(PRONTO_KIA_CARLA_BLUEPRINT_ID),
    carlaClassPath: z.literal(PRONTO_KIA_CARLA_CLASS_PATH),
    make: z.literal('Kia'),
    model: z.literal('Carnival'),
    baseType: z.literal('van'),
    sourceImage: z.strictObject({
      repository: z.literal(PRONTO_CARLA_IMAGE_REPOSITORY),
      indexSha256: z.literal(PRONTO_CARLA_IMAGE_INDEX_SHA256),
      linuxAmd64ManifestSha256: z.literal(PRONTO_CARLA_IMAGE_AMD64_SHA256),
    }),
  }),
  sensorRig: z.strictObject({
    rigId: z.literal(PRONTO_SENSOR_RIG_ID),
    cameras: z.literal(8),
    lidars: z.literal(6),
    radars: z.literal(4),
  }),
});

/**
 * A browser-renderable sensor host authored directly on a catalog vehicle.
 *
 * CARLA's Pronto lane retains its pinned vehicle and image provenance above. The browser lane only
 * needs the immutable actor/catalog identity and selected physical-sensor counts because it renders
 * the authored meshes and sensors from the execution package.
 */
export const AuthoredSensorHostSchema = z.strictObject({
  actorId: EntityIdSchema,
  vehicleAsset: z.strictObject({
    catalogAssetId: z.string().trim().min(1).max(200),
  }),
  sensorRig: z.strictObject({
    rigId: z.literal('authored'),
    cameras: z.number().int().nonnegative().max(1024),
    lidars: z.number().int().nonnegative().max(1024),
    radars: z.number().int().nonnegative().max(1024),
  }),
});

export const RenderSensorHostSchema = z.union([
  ProntoSensorHostSchema,
  AuthoredSensorHostSchema,
]);

/**
 * Immutable, renderer-neutral input to every UniScenarios rendering backend.
 * Transfer URLs and lease data deliberately live in the worker-control claim,
 * so refreshing credentials never changes this document's content hash.
 */
export const RenderIntentV1Schema = z.strictObject({
  schema: z.literal(RENDER_INTENT_V1_SCHEMA),
  intentId: RenderIntentIdSchema,
  executionPackage: z.strictObject({
    id: RenderIntentIdSchema,
    sourceInputDigest: RenderSha256Schema,
  }),
  scenarioRevision: RenderIntentScenarioRevisionSchema,
  sensorHost: RenderSensorHostSchema,
  renderSpec: RenderSpecV3Schema,
  assets: z.array(RenderIntentAssetSchema).max(4096),
  seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).check((ctx) => {
  const ids = new Set<string>();
  ctx.value.assets.forEach((asset, index) => {
    if (ids.has(asset.assetId)) {
      ctx.issues.push({
        code: 'custom',
        path: ['assets', index, 'assetId'],
        message: `duplicate assetId "${asset.assetId}"`,
        input: asset.assetId,
      });
    }
    ids.add(asset.assetId);
  });
  const hostSources = ctx.value.renderSpec.sources.filter(
    (source) => source.actorId === ctx.value.sensorHost.actorId,
  );
  if (hostSources.length !== ctx.value.renderSpec.sources.length) {
    ctx.issues.push({
      code: 'custom',
      path: ['renderSpec', 'sources'],
      message: 'every render source must attach to sensorHost.actorId',
      input: ctx.value.renderSpec.sources,
    });
  }
  const cameraIds = new Set(hostSources
    .filter((source) => source.modality !== 'lidar'
      && source.modality !== 'radar'
      && source.sensorId !== PRONTO_CHASE_CAMERA_SENSOR_ID)
    .map((source) => source.sensorId));
  const lidarIds = new Set(hostSources
    .filter((source) => source.modality === 'lidar')
    .map((source) => source.sensorId));
  const radarIds = new Set(hostSources
    .filter((source) => source.modality === 'radar')
    .map((source) => source.sensorId));
  if (ctx.value.sensorHost.sensorRig.rigId === 'authored') {
    const counts = ctx.value.sensorHost.sensorRig;
    if (cameraIds.size !== counts.cameras
      || lidarIds.size !== counts.lidars
      || radarIds.size !== counts.radars) {
      ctx.issues.push({
        code: 'custom',
        path: ['sensorHost', 'sensorRig'],
        message: `authored sensor counts do not match render sources; expected ${counts.cameras}/${counts.lidars}/${counts.radars}, got ${cameraIds.size}/${lidarIds.size}/${radarIds.size}`,
        input: ctx.value.renderSpec.sources,
      });
    }
    return;
  }
  const chaseCameras = hostSources.filter(
    (source) => source.sensorId === PRONTO_CHASE_CAMERA_SENSOR_ID,
  );
  const measurementCameraIds = new Set(hostSources
    .filter((source) => source.modality !== 'lidar'
      && source.modality !== 'radar'
      && source.sensorId !== PRONTO_CHASE_CAMERA_SENSOR_ID)
    .map((source) => source.sensorId));
  if (measurementCameraIds.size !== 8 || lidarIds.size !== 6 || radarIds.size !== 4) {
    ctx.issues.push({
      code: 'custom',
      path: ['renderSpec', 'sources'],
      message: `Pronto rig requires 8 cameras, 6 LiDARs, and 4 radars; got ${measurementCameraIds.size}/${lidarIds.size}/${radarIds.size}`,
      input: ctx.value.renderSpec.sources,
    });
  }
  if (chaseCameras.length > 1 || chaseCameras.some((source) => source.modality !== 'rgb')) {
    ctx.issues.push({
      code: 'custom',
      path: ['renderSpec', 'sources'],
      message: 'a render carries at most one RGB trailing chase camera',
      input: ctx.value.renderSpec.sources,
    });
  }
});

export type RenderIntentAsset = z.infer<typeof RenderIntentAssetSchema>;
export type RenderIntentScenarioRevision = z.infer<typeof RenderIntentScenarioRevisionSchema>;
export type ProntoSensorHost = z.infer<typeof ProntoSensorHostSchema>;
export type AuthoredSensorHost = z.infer<typeof AuthoredSensorHostSchema>;
export type RenderSensorHost = z.infer<typeof RenderSensorHostSchema>;
export type RenderIntentV1 = z.infer<typeof RenderIntentV1Schema>;

export function parseRenderIntent(value: unknown): RenderIntentV1 {
  return RenderIntentV1Schema.parse(value);
}
