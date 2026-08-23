import type { PlaybackBundle } from '@simforge/playback';
import {
  PRONTO_CARLA_IMAGE_AMD64_SHA256,
  PRONTO_CARLA_IMAGE_REPOSITORY,
  PRONTO_CARLA_IMAGE_INDEX_SHA256,
  PRONTO_KIA_CARLA_BLUEPRINT_ID,
  PRONTO_KIA_CARLA_CLASS_PATH,
  PRONTO_KIA_CATALOG_ASSET_ID,
  PRONTO_SENSOR_RIG_ID,
  ProntoSensorHostSchema,
  type RenderSensorHost,
  type ProntoSensorHost,
  type RenderSpecV3,
} from '@simforge/scenario';

export const PRONTO_KIA_CARNIVAL_CATALOG_ID = PRONTO_KIA_CATALOG_ASSET_ID;
export const PRONTO_KIA_CARNIVAL_BLUEPRINT_ID = PRONTO_KIA_CARLA_BLUEPRINT_ID;
export const PRONTO_KIA_CARNIVAL_CLASS = PRONTO_KIA_CARLA_CLASS_PATH;
export const PRONTO_SOURCE_IMAGE_OCI_DIGEST = PRONTO_CARLA_IMAGE_INDEX_SHA256;
export const PRONTO_SOURCE_IMAGE_AMD64_DIGEST = PRONTO_CARLA_IMAGE_AMD64_SHA256;
export const PRONTO_SENSOR_COUNTS = Object.freeze({ camera: 8, lidar: 6, radar: 4 });

/** Browser-side defense after portable schema validation and input materialization. */
export function assertBrowserSensorHost(renderSpec: RenderSpecV3, bundle: PlaybackBundle, sensorHost: RenderSensorHost): void {
  const hosts = new Set(renderSpec.sources.map((source) => source.actorId));
  if (hosts.size !== 1 || !hosts.has(sensorHost.actorId)) {
    throw new Error('Every browser render source must attach to the declared sensor host.');
  }
  const actor = bundle.actors.find((candidate) => candidate.id === sensorHost.actorId);
  if (!actor) throw new Error(`Browser sensor host ${sensorHost.actorId} is absent from immutable playback metadata.`);
  if (actor.catalogId !== sensorHost.vehicleAsset.catalogAssetId) {
    throw new Error(`Browser sensor host ${sensorHost.actorId} expected ${sensorHost.vehicleAsset.catalogAssetId}; received ${actor.catalogId}.`);
  }
  const cameraIds = new Set(renderSpec.sources
    .filter((source) => source.modality !== 'lidar' && source.modality !== 'radar')
    .map((source) => source.sensorId));
  const lidarIds = new Set(renderSpec.sources
    .filter((source) => source.modality === 'lidar')
    .map((source) => source.sensorId));
  const radarIds = new Set(renderSpec.sources
    .filter((source) => source.modality === 'radar')
    .map((source) => source.sensorId));
  if (sensorHost.sensorRig.rigId === 'authored') {
    if (cameraIds.size !== sensorHost.sensorRig.cameras
      || lidarIds.size !== sensorHost.sensorRig.lidars
      || radarIds.size !== sensorHost.sensorRig.radars) {
      throw new Error('Authored browser sensor counts do not match the immutable render sources.');
    }
    return;
  }
  assertProntoKiaSensorHost(renderSpec, bundle, ProntoSensorHostSchema.parse(sensorHost));
}

/** Pronto-specific provenance and exact-rig validation, retained for the managed Pronto lane. */
export function assertProntoKiaSensorHost(renderSpec: RenderSpecV3, bundle: PlaybackBundle, sensorHost: ProntoSensorHost): void {
  if (sensorHost.vehicleAsset.catalogAssetId !== PRONTO_KIA_CATALOG_ASSET_ID
    || sensorHost.vehicleAsset.carlaBlueprintId !== PRONTO_KIA_CARLA_BLUEPRINT_ID
    || sensorHost.vehicleAsset.carlaClassPath !== PRONTO_KIA_CARLA_CLASS_PATH
    || sensorHost.vehicleAsset.make !== 'Kia'
    || sensorHost.vehicleAsset.model !== 'Carnival'
    || sensorHost.vehicleAsset.baseType !== 'van') {
    throw new Error('Pronto browser presentation requires the exact Kia Carnival catalog and CARLA blueprint identity.');
  }
  if (sensorHost.sensorRig.rigId !== PRONTO_SENSOR_RIG_ID
    || sensorHost.sensorRig.cameras !== PRONTO_SENSOR_COUNTS.camera
    || sensorHost.sensorRig.lidars !== PRONTO_SENSOR_COUNTS.lidar
    || sensorHost.sensorRig.radars !== PRONTO_SENSOR_COUNTS.radar) {
    throw new Error(`Pronto sensor host must use rig ${PRONTO_SENSOR_RIG_ID} with exact 8/6/4 counts.`);
  }
  const cameraIds = new Set(renderSpec.sources.filter((source) => source.modality !== 'lidar' && source.modality !== 'radar').map((source) => source.sensorId));
  const lidarIds = new Set(renderSpec.sources.filter((source) => source.modality === 'lidar').map((source) => source.sensorId));
  const radarIds = new Set(renderSpec.sources.filter((source) => source.modality === 'radar').map((source) => source.sensorId));
  if (cameraIds.size !== PRONTO_SENSOR_COUNTS.camera || lidarIds.size !== PRONTO_SENSOR_COUNTS.lidar || radarIds.size !== PRONTO_SENSOR_COUNTS.radar) {
    throw new Error(`Pronto rig must contain exactly 8 cameras, 6 LiDARs and 4 radars; received ${cameraIds.size}/${lidarIds.size}/${radarIds.size}.`);
  }
  if (sensorHost.vehicleAsset.sourceImage.repository !== PRONTO_CARLA_IMAGE_REPOSITORY
    || sensorHost.vehicleAsset.sourceImage.indexSha256 !== PRONTO_CARLA_IMAGE_INDEX_SHA256
    || sensorHost.vehicleAsset.sourceImage.linuxAmd64ManifestSha256 !== PRONTO_CARLA_IMAGE_AMD64_SHA256) {
    throw new Error('Pronto Kia Carnival provenance does not match the pinned source image.');
  }
  const hosts = new Set(renderSpec.sources.map((source) => source.actorId));
  if (hosts.size !== 1 || !hosts.has(sensorHost.actorId)) throw new Error('Every Pronto render source must attach to the declared Kia Carnival sensor host.');
  const actor = bundle.actors.find((candidate) => candidate.id === sensorHost.actorId);
  if (!actor) throw new Error(`Pronto sensor host ${sensorHost.actorId} is absent from immutable playback metadata.`);
  if (actor.catalogId !== PRONTO_KIA_CATALOG_ASSET_ID) throw new Error(`Pronto sensor host ${sensorHost.actorId} must render ${PRONTO_KIA_CATALOG_ASSET_ID}; received ${actor.catalogId}.`);
}
