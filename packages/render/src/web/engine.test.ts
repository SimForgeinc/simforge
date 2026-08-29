import { chromium } from 'playwright-core';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EngineCapabilityDeclarationSchema } from '../index.js';
import { bootBrowserHarness, browserChromiumArgs, createRenderEngine, decodePlaybackArchive, installArtifactBridgeInitScript, normalizeSavedPlaybackTrace, resolveBrowserHarnessUrl, resolveBrowserRenderIntent } from './engine.js';

describe('browser render engine registration', () => {
  it('publishes the canonical worker capability declaration', () => {
    const engine = createRenderEngine({ engineVersion: 'test-build' });

    expect(EngineCapabilityDeclarationSchema.parse(engine.capabilities)).toMatchObject({
      schema: 'simforge.render-engine-capabilities/v1',
      engineId: 'browser',
      engineVersion: 'test-build',
      backend: 'browser',
      protocolVersion: 1,
      modalities: ['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'],
      requiresGpu: false,
    });
  });
});

describe('browser worker harness boot', () => {
  it('installs the browser adapter with the worker Chromium flags and default harness', async () => {
    const browser = await chromium.launch({
      headless: true,
      args: browserChromiumArgs([]),
    });
    try {
      const page = await browser.newPage();
      await installArtifactBridgeInitScript(page);
      await bootBrowserHarness(page, await resolveBrowserHarnessUrl(), 10_000);
      await expect(page.evaluate(() => globalThis.__simforgeBrowserRender?.engine)).resolves.toBe('browser');
    } finally {
      await browser.close();
    }
  }, 20_000);
});

describe('browser render intent adapter', () => {
  it('derives the browser engine and fixed-step schedule from the portable intent', () => {
    const resolved = resolveBrowserRenderIntent({
      schema: 'simforge.render-intent/v1',
      intentId: 'intent-1',
      executionPackage: { id: 'package-1', sourceInputDigest: 'a'.repeat(64) },
      scenarioRevision: {
        revisionId: 'revision-1',
        scenarioSha256: 'b'.repeat(64),
        openScenario: { sha256: 'c'.repeat(64), sizeBytes: 1 },
        map: { mapId: 'map-1', revisionId: 'map-revision-1', sha256: 'd'.repeat(64) },
      },
      sensorHosts: [{
        sourceId: 'ego-camera-front-rgb',
        actorId: 'ego',
        vehicleAsset: { catalogAssetId: 'vehicle.generic.sedan' },
      }],
      renderSpec: {
        schema: 'simforge.render-spec/v3',
        sources: [{
          actorId: 'ego',
          sensorId: 'camera-front',
          outputName: 'ego-camera-front-rgb',
          transform: {
            position: { x: 1, y: 2, z: 0 },
            rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
          },
          modality: 'rgb',
          attributes: {
            width: 1280,
            height: 720,
            fps: 24,
            horizontalFovDeg: 90,
            nearM: 0.05,
            farM: 1000,
          },
        }],
        clip: { startSeconds: 0, endSeconds: 3 },
        video: {
          width: 1280,
          height: 720,
          fps: 24,
          container: 'webm',
          codec: 'vp9',
          quality: 'standard',
        },
        artifacts: ['manifest', 'video'],
        capabilityIntent: {
          required: ['sensor.rgb', 'artifact.manifest', 'artifact.video', 'environment.authored', 'timing.fixed_step'],
          preferred: [],
          fidelity: 'dataset',
        },
        authoredEnvironment: {
          weather: 'clear',
          timeOfDay: 'noon',
          surfacePatches: [],
        },
      },
      assets: [
        { assetId: 'map.manifest', kind: 'map', sha256: 'e'.repeat(64), sizeBytes: 1 },
        { assetId: 'playback.bundle', kind: 'other', sha256: 'f'.repeat(64), sizeBytes: 1 },
      ],
      seed: 1,
    });

    expect(resolved).toMatchObject({
      engine: 'browser',
      schedule: {
        startSeconds: 0,
        endSeconds: 3,
        fps: 24,
        frameCount: 72,
        endTimestampUs: 3_000_000,
      },
    });
  });
});

describe('browser playback materialization', () => {
  it('decodes the persisted gzip playback bundle before rendering', async () => {
    const bundle = { schema: 'simforge.simulation-preview/v1', draftVersion: 5 };
    await expect(decodePlaybackArchive(gzipSync(JSON.stringify(bundle)))).resolves.toEqual(bundle);
  });

  it('converts persisted scene coordinates back through strict playback validation', () => {
    expect(normalizeSavedPlaybackTrace({
      header: { frame: 'scene' },
      ticks: { t: [0, 1], actors: { ego: { x: [1, 2], z: [3, -4] } } },
    })).toMatchObject({
      header: { frame: 'xodr-local' },
      ticks: { actors: { ego: { x: [1, 2], y: [-3, 4], z: [3, -4] } } },
    });
  });
});
