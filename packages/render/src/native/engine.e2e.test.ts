import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { extractOpenScenarioExecutionPlan } from '@simforge-oss/openscenario';
import type { RenderIntentV1 } from '@simforge-oss/scenario';
import { afterAll, describe, expect, it } from 'vitest';

import { createFixedSchedules } from '../schedule.js';
import { createRenderEngine } from './engine.js';

const enabled = process.env.SIMFORGE_NATIVE_E2E === '1';
const suite = enabled ? describe : describe.skip;
const executeFile = promisify(execFile);
const output = process.env.SIMFORGE_NATIVE_E2E_OUTPUT ?? path.resolve('native-e2e-output');

suite('native retained service GPU e2e', () => {
  afterAll(async () => {
    // The output is intentional release evidence; only transient service files are removed by the adapter.
    await fs.access(output);
  });

  it('spawns the real service and produces playable H.264 video from moving actors', async () => {
    const binary = process.env.SIMFORGE_NATIVE_RENDER_BINARY;
    const xoscPath = process.env.SIMFORGE_NATIVE_E2E_XOSC;
    const tiles = (process.env.SIMFORGE_NATIVE_E2E_TILES ?? '').split(path.delimiter).filter(Boolean);
    if (!binary || !xoscPath || tiles.length === 0) {
      throw new Error('native e2e requires SIMFORGE_NATIVE_RENDER_BINARY, SIMFORGE_NATIVE_E2E_XOSC, and SIMFORGE_NATIVE_E2E_TILES');
    }
    await fs.rm(output, { recursive: true, force: true });
    await fs.mkdir(output, { recursive: true });
    const xosc = await fs.readFile(xoscPath);
    const xoscSha256 = createHash('sha256').update(xosc).digest('hex');
    const plan = extractOpenScenarioExecutionPlan(xosc.toString('utf8'), { sourceSha256: xoscSha256 });
    const actor = plan.actors.find((candidate) => candidate.id === 'ego' && !candidate.static)
      ?? plan.actors.find((candidate) => !candidate.static)
      ?? plan.actors[0];
    if (!actor) throw new Error('e2e scenario contains no actors');
    const other = plan.actors.find((candidate) => candidate.id !== actor.id && !candidate.static);
    let encounterTime = Math.min(4, plan.clipSeconds);
    if (other && other.samples.length === actor.samples.length) {
      let closest = Number.POSITIVE_INFINITY;
      actor.samples.forEach((sample, index) => {
        const candidate = other.samples[index]!;
        const distance = Math.hypot(sample.x - candidate.x, sample.y - candidate.y);
        if (sample.present && candidate.present && distance < closest) {
          closest = distance;
          encounterTime = sample.t;
        }
      });
    }
    const clipStart = Math.max(0, Math.min(encounterTime - 1, plan.clipSeconds - 2));
    const clipEnd = clipStart + Math.min(2, plan.clipSeconds);
    const intent: RenderIntentV1 = {
      schema: 'simforge.render-intent/v1',
      intentId: 'native-gpu-e2e',
      executionPackage: { id: 'native-gpu-e2e-package', sourceInputDigest: 'a'.repeat(64) },
      scenarioRevision: {
        revisionId: 'native-gpu-e2e-revision', scenarioSha256: 'b'.repeat(64),
        openScenario: { sha256: xoscSha256, sizeBytes: xosc.byteLength },
        map: { mapId: plan.mapId, revisionId: 'native-corpus', sha256: 'c'.repeat(64) },
      },
      sensorHosts: [{ sourceId: 'front-rgb', actorId: actor.id, vehicleAsset: { catalogAssetId: 'vehicle.sedan' } }],
      renderSpec: {
        schema: 'simforge.render-spec/v3',
        sources: [{
          actorId: actor.id, sensorId: 'front-camera', outputName: 'front-rgb', modality: 'rgb',
          transform: {
            position: { x: 1.5, y: 1.8, z: 0 },
            rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 },
          },
          attributes: { width: 320, height: 180, fps: 12, horizontalFovDeg: 90, nearM: 0.05, farM: 1_000 },
        }],
        clip: { startSeconds: clipStart, endSeconds: clipEnd },
        video: { width: 320, height: 180, fps: 12, container: 'mp4', codec: 'h264', quality: 'high' },
        artifacts: ['manifest', 'video', 'trace'],
        capabilityIntent: {
          required: ['sensor.rgb', 'artifact.manifest', 'artifact.video', 'artifact.trace', 'environment.authored', 'timing.fixed_step'],
          preferred: [], fidelity: 'dataset',
        },
        authoredEnvironment: { weather: 'clear', timeOfDay: 'noon', surfacePatches: [] },
      },
      assets: [], seed: 1,
    };
    const inputRecords = await Promise.all([
      { inputId: 'scenario.xosc', path: xoscPath, sha256: xoscSha256, sizeBytes: xosc.byteLength },
      ...tiles.map(async (tile, index) => {
        const bytes = await fs.readFile(tile);
        return {
          inputId: `map.tile.${String(index).padStart(6, '0')}`, path: tile,
          sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength,
        };
      }),
    ]);
    const manifest = await createRenderEngine({ binary }).execute({
      jobId: 'native-gpu-e2e', attempt: 1, intent, intentSha256: 'd'.repeat(64),
      executionPackageControlSha256: 'e'.repeat(64), schedules: createFixedSchedules(intent),
      inputs: new Map(inputRecords.map((input) => [input.inputId, input])), workspace: output,
      signal: new AbortController().signal, reportProgress: async () => undefined,
    });
    const video = manifest.artifacts.find((artifact) => artifact.identity.role === 'video');
    expect(video?.frameCount).toBe(24);
    const probe = JSON.parse((await executeFile('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,nb_frames',
      '-of', 'json', path.join(output, video!.relativePath),
    ])).stdout) as { streams: Array<{ codec_name: string; pix_fmt: string; nb_frames: string }> };
    expect(probe.streams[0]).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', nb_frames: '24' });
    const trace = JSON.parse(await fs.readFile(path.join(output, 'trace/native-trace.json'), 'utf8')) as {
      frames: Array<{ actors: Array<{ id: string; transform: { position: number[] } }> }>;
    };
    const positions = trace.frames
      .map((frame) => frame.actors.find((candidate) => candidate.id === actor.id)?.transform.position.join(','))
      .filter(Boolean);
    expect(new Set(positions).size).toBeGreaterThan(1);
  }, 360_000);
});
