import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  PRONTO_CHASE_CAMERA_SENSOR_ID,
  RENDER_INTENT_V1_SCHEMA,
  hashRenderIntent,
  parseRenderIntent,
} from '../render-intent.js';
import { Sha256 } from '../sha256.js';

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

/**
 * The exact sensorHost shape the retired Pronto lane wrote into queued
 * render_jobs rows. Those rows are immutable: this fixture must keep parsing
 * (and hashing identically) under the relaxed schema forever.
 */
const STORED_PRONTO_SENSOR_HOST = {
  actorId: HOST,
  vehicleAsset: {
    catalogAssetId: 'vehicle.kia.carnival',
    carlaBlueprintId: 'vehicle.kia.carnival',
    carlaClassPath: '/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C',
    make: 'Kia',
    model: 'Carnival',
    baseType: 'van',
    sourceImage: {
      repository: 'ghcr.io/simforgeinc/carla-rfs-munich-belmont',
      indexSha256: 'f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5',
      linuxAmd64ManifestSha256: 'baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64',
    },
  },
  sensorRig: { rigId: 'pronto.8-camera-6-lidar-4-radar', cameras: 8, lidars: 6, radars: 4 },
};

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
    sensorHost: STORED_PRONTO_SENSOR_HOST,
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

function nodeCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(nodeCanonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${nodeCanonicalJson(record[key])}`)
    .join(',')}}`;
}

describe('stored legacy Pronto-shaped intent rows (immutable superset parse)', () => {
  it('parses the pinned Kia sensorHost shape and preserves every provenance key', () => {
    const parsed = parseRenderIntent(intent(RIG));

    expect(parsed.sensorHost).toEqual(STORED_PRONTO_SENSOR_HOST);
    expect(parsed.renderSpec.sources).toHaveLength(18);
  });

  it('round-trips a stored row through parse without changing its content hash', () => {
    // Simulates a queued jsonb row: JSON round-trip, then claim-time parse.
    const storedRow = JSON.parse(JSON.stringify(intent(RIG)));
    const storedSha256 = createHash('sha256')
      .update(nodeCanonicalJson(storedRow), 'utf8')
      .digest('hex');

    expect(hashRenderIntent(storedRow)).toBe(storedSha256);
    expect(hashRenderIntent(parseRenderIntent(storedRow))).toBe(storedSha256);
  });

  it('no longer polices rig counts — count policy lives server-side, once', () => {
    // 9/6/4 against a rig declaring 8/6/4: shape-valid, so it parses.
    expect(parseRenderIntent(intent([...RIG, camera('pronto-cam8')])).renderSpec.sources)
      .toHaveLength(19);
  });

  it('accepts the rig plus a trailing chase camera', () => {
    const parsed = parseRenderIntent(intent([camera(PRONTO_CHASE_CAMERA_SENSOR_ID, 70), ...RIG]));

    expect(parsed.renderSpec.sources).toHaveLength(19);
    expect(parsed.renderSpec.sources[0]!.sensorId).toBe(PRONTO_CHASE_CAMERA_SENSOR_ID);
  });
});

describe('authored sensor host', () => {
  it('accepts any authored catalog vehicle', () => {
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

  it('rejects a source attached to an actor other than the sensor host', () => {
    const foreign = { ...camera('other-camera'), actorId: 'other-actor', outputName: 'other' };

    expect(() => parseRenderIntent(intent([...RIG, foreign])))
      .toThrow(/every render source must attach to sensorHost.actorId/);
  });

  it('rejects duplicate asset ids', () => {
    const value = {
      ...intent([camera('basic-dash-camera')]),
      assets: [
        { assetId: 'map.xodr', kind: 'map' as const, sha256: DIGEST, sizeBytes: 2048 },
        { assetId: 'map.xodr', kind: 'other' as const, sha256: DIGEST, sizeBytes: 1 },
      ],
    };

    expect(() => parseRenderIntent(value)).toThrow(/duplicate assetId/);
  });
});

describe('hashRenderIntent', () => {
  it('is the node:crypto SHA-256 of the canonical intent JSON', () => {
    const value = parseRenderIntent(intent(RIG));

    expect(hashRenderIntent(value)).toBe(
      createHash('sha256').update(nodeCanonicalJson(value), 'utf8').digest('hex'),
    );
  });

  it('pure Sha256 matches node:crypto across chunked random payloads', () => {
    for (let round = 0; round < 16; round += 1) {
      const bytes = randomBytes(1 + Math.floor(Math.random() * 4096));
      const hash = new Sha256();
      for (let offset = 0; offset < bytes.length; offset += 97) {
        hash.update(bytes.subarray(offset, Math.min(offset + 97, bytes.length)));
      }
      expect(hash.digestHex()).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});
