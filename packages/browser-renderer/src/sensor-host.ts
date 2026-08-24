import type { PlaybackBundle } from '@uniscenarios/playback';
import {
  PRONTO_CHASE_CAMERA_SENSOR_ID,
  type RenderSensorHost,
  type RenderSpecV3,
} from '@uniscenarios/scenario-model';

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
    .filter((source) => source.sensorId !== PRONTO_CHASE_CAMERA_SENSOR_ID
      && source.modality !== 'lidar' && source.modality !== 'radar')
    .map((source) => source.sensorId));
  const lidarIds = new Set(renderSpec.sources
    .filter((source) => source.modality === 'lidar')
    .map((source) => source.sensorId));
  const radarIds = new Set(renderSpec.sources
    .filter((source) => source.modality === 'radar')
    .map((source) => source.sensorId));
  if (cameraIds.size !== sensorHost.sensorRig.cameras
    || lidarIds.size !== sensorHost.sensorRig.lidars
    || radarIds.size !== sensorHost.sensorRig.radars) {
    throw new Error('Browser sensor counts do not match the immutable render sources.');
  }
}
