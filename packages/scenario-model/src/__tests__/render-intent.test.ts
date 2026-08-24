import { describe, expect, it } from 'vitest';

import {
  PRONTO_CHASE_CAMERA_SENSOR_ID,
  PRONTO_CARLA_IMAGE_AMD64_SHA256,
  PRONTO_CARLA_IMAGE_INDEX_SHA256,
  PRONTO_CARLA_IMAGE_REPOSITORY,
  PRONTO_KIA_CARLA_BLUEPRINT_ID,
  PRONTO_KIA_CARLA_CLASS_PATH,
  PRONTO_KIA_CATALOG_ASSET_ID,
  PRONTO_SENSOR_RIG_ID,
  RENDER_INTENT_V1_SCHEMA,
  parseRenderIntent,
} from '../render-intent.js';

const DIGEST = 'a'.repeat(64);
const HOST = 'vehicle-host';

function camera(sensorId: string, horizontalFovDeg = 120) {
  return {
    actorId: HOST,
    sensorId,
    outputName: `${HOST}-${sensorId}-rgb`,
    modality: 'rgb' as const,
    transform: {
      position: { x: 0.7, y: 1.83, z: 0 },
      rotation: { yawRad: 0, pitchRad: 0.17, rollRad: 0 },
    },
    attributes: { width: 1280, height: 720, fps: 24, horizontalFovDeg, nearM: 0.05, farM: 1000 },
  };
}

function lidar(sensorId: string) {
  return {
    actorId: HOST,
    sensorId,
    outputName: `${HOST}-${sensorId}-lidar`,
    modality: 'lidar' as const,
    transform: {
      position: { x: 0.72, y: 1.9, z: 0 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
    attributes: {
      channels: 32, rangeM: 200, pointsPerSecond: 100_000,
      rotationFrequencyHz: 10, upperFovDeg: 12.5, lowerFovDeg: -12.5,
    },
  };
}

function radar(sensorId: string) {
  return {
    actorId: HOST,
    sensorId,
    outputName: `${HOST}-${sensorId}-radar`,
    modality: 'radar' as const,
    transform: {
      position: { x: 0.79, y: 1.85, z: 0 },
      rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
    },
    attributes: { horizontalFovDeg: 30, verticalFovDeg: 30, rangeM: 100, pointsPerSecond: 1500 },
  };
}

function intent(sources: readonly unknown[]) {
  return {
    schema: RENDER_INTENT_V1_SCHEMA,
    intentId: 'usri_test',
    executionPackage: {
      id: 'usepkg_test',
      sourceInputDigest: DIGEST,
    },
    scenarioRevision: {
      revisionId: 'usrev_test',
      scenarioSha256: DIGEST,
      openScenario: { sha256: DIGEST, sizeBytes: 1024 },
      map: { mapId: 'map', revisionId: 'usmap_test', sha256: DIGEST },
    },
    sensorHost: {
      actorId: HOST,
      vehicleAsset: {
        catalogAssetId: PRONTO_KIA_CATALOG_ASSET_ID,
        carlaBlueprintId: PRONTO_KIA_CARLA_BLUEPRINT_ID,
        carlaClassPath: PRONTO_KIA_CARLA_CLASS_PATH,
        make: 'Kia',
        model: 'Carnival',
        baseType: 'van',
        sourceImage: {
          repository: PRONTO_CARLA_IMAGE_REPOSITORY,
          indexSha256: PRONTO_CARLA_IMAGE_INDEX_SHA256,
          linuxAmd64ManifestSha256: PRONTO_CARLA_IMAGE_AMD64_SHA256,
        },
      },
      sensorRig: { rigId: PRONTO_SENSOR_RIG_ID, cameras: 8, lidars: 6, radars: 4 },
    },
    renderSpec: {
      schema: 'uniscenario.render-spec/v3',
      sources,
      clip: { startSeconds: 0, endSeconds: 20 },
      video: { width: 1280, height: 720, fps: 24, container: 'mp4', codec: 'h264', quality: 'standard' },
      artifacts: ['manifest', 'video', 'frames', 'sensorArchive'],
      capabilityIntent: { required: ['sensor.rgb', 'sensor.lidar', 'sensor.radar'], preferred: [], fidelity: 'dataset' },
      authoredEnvironment: { weather: 'clear', timeOfDay: 'noon', sunAzimuthDeg: 180, sunElevationDeg: 60, surfacePatches: [] },
    },
    assets: [{ assetId: 'map.xodr', kind: 'map' as const, sha256: DIGEST, sizeBytes: 2048 }],
    seed: 7,
  };
}

const RIG = [
  ...Array.from({ length: 8 }, (_unused, index) => camera(`pronto-cam${index}`)),
  ...Array.from({ length: 6 }, (_unused, index) => lidar(`pronto-lidar-${index}`)),
  ...Array.from({ length: 4 }, (_unused, index) => radar(`pronto-rad-${index}`)),
];

describe('pronto render intent', () => {
  it('accepts the rig alone', () => {
    expect(parseRenderIntent(intent(RIG)).renderSpec.sources).toHaveLength(18);
  });

  it('counts physical camera identities across multiple modalities', () => {
    const depthSources = RIG
      .filter((source) => source.modality === 'rgb')
      .map((source) => ({
        ...source,
        modality: 'depth' as const,
        outputName: `${source.sensorId}-depth`,
      }));

    expect(parseRenderIntent(intent([...RIG, ...depthSources])).renderSpec.sources).toHaveLength(26);
  });

  it('accepts the rig plus a trailing chase camera', () => {
    const sources = [camera(PRONTO_CHASE_CAMERA_SENSOR_ID, 70), ...RIG];

    const parsed = parseRenderIntent(intent(sources));

    expect(parsed.renderSpec.sources).toHaveLength(19);
    expect(parsed.renderSpec.sources[0]!.sensorId).toBe(PRONTO_CHASE_CAMERA_SENSOR_ID);
  });

  it('still rejects an extra measurement camera', () => {
    expect(() => parseRenderIntent(intent([...RIG, camera('pronto-cam8')])))
      .toThrow(/8 cameras, 6 LiDARs, and 4 radars; got 9\/6\/4/);
  });

  it('rejects a chase camera that is not RGB', () => {
    const depthChase = { ...camera(PRONTO_CHASE_CAMERA_SENSOR_ID, 70), modality: 'depth' as const };

    expect(() => parseRenderIntent(intent([...RIG, depthChase])))
      .toThrow(/at most one RGB trailing chase camera/);
  });
});

describe('authored browser sensor host', () => {
  it('accepts one authored dash camera without Pronto vehicle metadata', () => {
    const value = {
      ...intent([camera('basic-dash-camera')]),
      sensorHost: {
        actorId: HOST,
        vehicleAsset: { catalogAssetId: 'vehicle.tesla.model3' },
        sensorRig: { rigId: 'authored', cameras: 1, lidars: 0, radars: 0 },
      },
    };

    const parsed = parseRenderIntent(value);

    expect(parsed.sensorHost.vehicleAsset.catalogAssetId).toBe('vehicle.tesla.model3');
    expect(parsed.renderSpec.sources).toHaveLength(1);
  });

  it('excludes the trailing chase camera from authored physical sensor counts', () => {
    const value = {
      ...intent([camera('basic-dash-camera'), camera(PRONTO_CHASE_CAMERA_SENSOR_ID, 70)]),
      sensorHost: {
        actorId: HOST,
        vehicleAsset: { catalogAssetId: 'vehicle.tesla.model3' },
        sensorRig: { rigId: 'authored', cameras: 1, lidars: 0, radars: 0 },
      },
    };

    const parsed = parseRenderIntent(value);

    expect(parsed.renderSpec.sources).toHaveLength(2);
  });

  it('rejects authored counts that do not match selected physical sensors', () => {
    const value = {
      ...intent([camera('basic-dash-camera')]),
      sensorHost: {
        actorId: HOST,
        vehicleAsset: { catalogAssetId: 'vehicle.tesla.model3' },
        sensorRig: { rigId: 'authored', cameras: 2, lidars: 0, radars: 0 },
      },
    };

    expect(() => parseRenderIntent(value)).toThrow(/authored sensor counts do not match/);
  });
});
