import { createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
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

const HOST_ASSET = {
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
};

function sensorHosts(sources: readonly unknown[]) {
  return sources.map((source) => {
    const selected = source as { actorId: string; outputName: string };
    return {
      sourceId: selected.outputName,
      actorId: selected.actorId,
      vehicleAsset: selected.actorId === HOST
        ? HOST_ASSET
        : { catalogAssetId: 'infrastructure.roadside-sensor' },
    };
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
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
    sensorHosts: sensorHosts(sources),
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

describe('authored sensor hosts', () => {
  it('preserves per-source catalog provenance', () => {
    const parsed = parseRenderIntent(intent(RIG));

    expect(parsed.sensorHosts).toHaveLength(18);
    expect(parsed.sensorHosts[0]!.vehicleAsset).toEqual(HOST_ASSET);
    expect(parsed.renderSpec.sources).toHaveLength(18);
  });

  it('accepts sources mounted on multiple authored actors', () => {
    const roadside = {
      ...camera('roadside-camera'),
      actorId: 'roadside-unit',
      outputName: 'roadside-unit-camera-rgb',
    };
    const parsed = parseRenderIntent(intent([camera('ego-camera'), roadside]));

    expect(new Set(parsed.sensorHosts.map((host) => host.actorId))).toEqual(
      new Set([HOST, 'roadside-unit']),
    );
  });

  it('requires exact source coverage', () => {
    const value = intent([camera('camera-front'), camera('camera-rear')]);
    value.sensorHosts = value.sensorHosts.slice(1);

    expect(() => parseRenderIntent(value)).toThrow(/has no sensor host mapping/);
  });

  it('requires each mapped actor to match its source actor', () => {
    const value = intent([camera('camera-front')]);
    value.sensorHosts[0] = { ...value.sensorHosts[0]!, actorId: 'other-actor' };

    expect(() => parseRenderIntent(value)).toThrow(/actorId must match render source/);
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

  it('is stable when equivalent sources and host mappings arrive in a different order', () => {
    const forward = parseRenderIntent(intent(RIG));
    const reversed = parseRenderIntent({
      ...intent([...RIG].reverse()),
      sensorHosts: sensorHosts(RIG).reverse(),
    });

    expect(hashRenderIntent(reversed)).toBe(hashRenderIntent(forward));
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
