import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Readable, Writable } from 'node:stream';

import {
  ENGINE_CAPABILITIES_V1_SCHEMA,
  hashFile,
  type EngineCapabilityDeclaration,
  type RenderArtifactManifest,
  type RenderEngineAdapter,
  type RenderExecutionContext,
} from '../index.js';
import { parseRenderIntent, type RenderSourceV3 } from '@simforge-oss/scenario';

import { lowerOpenScenarioToNative } from './lowering.js';
import { createNativeCameraSchedule } from './camera-schedule.js';
import { NativeServiceClient, stripRgbaPadding, type NativeFrameRecord } from './service-client.js';
import { ensureActorAssets } from './actor-assets.js';

export const NATIVE_RENDER_ENGINE_ID = 'bevy-retained';
const NATIVE_ENGINE_VERSION = '0.1.0-rc.59';

export interface NativeRenderEngineOptions {
  /** Path to the retained native-render-service binary. */
  readonly binary?: string;
  readonly ffmpegBinary?: string;
  readonly engineVersion?: string;
  readonly startupTimeoutMs?: number;
  readonly shmSizeMb?: number;
}

const CAPABILITIES: EngineCapabilityDeclaration = {
  schema: ENGINE_CAPABILITIES_V1_SCHEMA,
  engineId: NATIVE_RENDER_ENGINE_ID,
  engineVersion: NATIVE_ENGINE_VERSION,
  backend: 'native',
  protocolVersion: 1,
  capabilities: [
    'openscenario.1_4',
    'timing.fixed_step',
    'environment.authored',
    'sensor.rgb',
    'artifact.video',
    'artifact.manifest',
    'artifact.trace',
    'map.static_semantics',
  ],
  modalities: ['rgb'],
  limits: {
    maxSimultaneousSensors: 64,
    maxWidth: 4096,
    maxHeight: 4096,
    maxFramesPerSecond: 120,
  },
  requiresGpu: true,
};

export function resolveBinary(options: NativeRenderEngineOptions): string {
  if (options.binary) return options.binary;
  if (process.env.SIMFORGE_NATIVE_RENDER_BINARY) return process.env.SIMFORGE_NATIVE_RENDER_BINARY;
  const candidates = [
    path.resolve('renderer/target/release/native-render-service'),
    path.resolve('renderer/target/debug/native-render-service'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return 'native-render-service';
}


async function waitForSocket(socketPath: string, child: ChildProcess, timeoutMs: number, signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('native render aborted');
    if (child.exitCode !== null) throw new Error(`native render service exited during startup with code ${child.exitCode}`);
    try {
      const stat = await fs.stat(socketPath);
      if (stat.isSocket()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  throw new Error(`native render service did not create ${socketPath} within ${timeoutMs} ms`);
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  timer.unref();
}

interface Encoder {
  readonly source: RenderSourceV3;
  readonly process: ChildProcessByStdio<Writable, null, Readable>;
  readonly path: string;
  readonly stderr: string[];
  readonly completion: Promise<unknown[]>;
  frames: number;
}

function startEncoder(ffmpeg: string, outputPath: string, source: Encoder['source']): Encoder {
  if (source.modality !== 'rgb') throw new Error(`native retained adapter cannot encode ${source.modality}`);
  const child = spawn(ffmpeg, [
    '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${source.attributes.width}x${source.attributes.height}`,
    '-r', String(source.attributes.fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', outputPath,
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  const stderr: string[] = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr.push(chunk);
    if (stderr.length > 32) stderr.shift();
  });
  return { source, process: child, path: outputPath, stderr, completion: once(child, 'exit'), frames: 0 };
}

async function finishEncoder(encoder: Encoder): Promise<void> {
  encoder.process.stdin.end();
  const [code, signal] = await encoder.completion as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(`ffmpeg exited code=${String(code)} signal=${String(signal)}\n${encoder.stderr.join('')}`);
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

export function createRenderEngine(options: NativeRenderEngineOptions = {}): RenderEngineAdapter {
  const capabilities: EngineCapabilityDeclaration = options.engineVersion
    ? { ...CAPABILITIES, engineVersion: options.engineVersion }
    : CAPABILITIES;
  const binary = resolveBinary(options);
  const ffmpeg = options.ffmpegBinary ?? process.env.SIMFORGE_FFMPEG_BINARY ?? 'ffmpeg';

  return {
    capabilities,
    async execute(context: RenderExecutionContext): Promise<RenderArtifactManifest> {
      const startedAt = new Date().toISOString();
      const wallStarted = performance.now();
      await fs.mkdir(context.workspace, { recursive: true });
      const intent = parseRenderIntent(context.intent);
      const sources = intent.renderSpec.sources;
      if (sources.some((source) => source.modality !== 'rgb')) {
        throw new Error('native retained engine currently accepts RGB render sources only');
      }
      const rgbSchedules = context.schedules.filter((schedule) => {
        const source = sources.find((candidate) => candidate.outputName === schedule.sourceId);
        return source?.modality === 'rgb';
      });
      const xoscInput = context.inputs.get('scenario.xosc');
      if (!xoscInput) throw new Error('native render requires scenario.xosc');
      const tileInputs = [...context.inputs.values()]
        .filter((input) => /^map\.tile\.[A-Za-z0-9._-]+$/.test(input.inputId))
        .sort((left, right) => left.inputId.localeCompare(right.inputId));
      if (tileInputs.length === 0) throw new Error('native render requires map.tile.* native-corpus GLBs');
      let actorAssets: string | undefined;
      try {
        actorAssets = await ensureActorAssets();
      } catch (error) {
        process.stderr.write(`[simforge-native] actor asset closure unavailable; using proxy actors: ${error instanceof Error ? error.message : String(error)}\n`);
      }

      const xosc = await fs.readFile(xoscInput.path);
      const lowering = lowerOpenScenarioToNative(xosc.toString('utf8'), xoscInput.sha256, rgbSchedules);
      const cameraSchedule = createNativeCameraSchedule(sources, intent.sensorHosts, lowering.states);
      const traceRelative = 'trace/native-trace.json';
      const tracePath = path.join(context.workspace, traceRelative);
      await writeJson(tracePath, {
        schema: 'simforge.render-trace/v1',
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        mapId: lowering.plan.mapId,
        fixedTimestepSeconds: lowering.plan.dt,
        frames: lowering.states,
      });
      const traceDigest = await hashFile(tracePath);

      const scenePath = path.join(context.workspace, 'native-service-scene.json');
      const socketPath = path.join(context.workspace, 'native-render.sock');
      const shmPath = path.join(context.workspace, 'native-render.shm');
      const serviceLogPath = path.join(context.workspace, 'native-render-service.log');
      await Promise.all([fs.rm(socketPath, { force: true }), fs.rm(shmPath, { force: true })]);
      await writeJson(scenePath, {
        glbs: tileInputs.map((tile) => tile.path),
        profile: 'sensor',
        nearM: Math.min(...sources.map((source) => source.modality === 'rgb' ? source.attributes.nearM : 0.05)),
        farM: Math.max(...sources.map((source) => source.modality === 'rgb' ? source.attributes.farM : 1_000)),
        warmupFrames: 20,
        ...(actorAssets === undefined ? {} : {
          vehicleModels: actorAssets,
          pedestrianModels: actorAssets,
        }),
      });
      const serviceLog = await fs.open(serviceLogPath, 'w', 0o644);
      const service = spawn(binary, [
        '--scene', scenePath, '--socket', socketPath, '--shm', shmPath,
        '--shm-size-mb', String(options.shmSizeMb ?? 512),
      ], { stdio: ['ignore', 'ignore', serviceLog.fd] });
      const abort = (): void => terminate(service);
      context.signal.addEventListener('abort', abort, { once: true });

      let client: NativeServiceClient | undefined;
      const encoders = new Map<string, Encoder>();
      let serverMs = 0;
      let encodingComplete = false;
      try {
        await waitForSocket(socketPath, service, options.startupTimeoutMs ?? 300_000, context.signal);
        client = await NativeServiceClient.connect(socketPath);
        await client.rpc({ op: 'load_scene_state', states: lowering.states });
        const cameras = cameraSchedule;
        await fs.mkdir(path.join(context.workspace, 'video'), { recursive: true });
        for (const source of sources) {
          const outputPath = path.join(context.workspace, 'video', `${source.outputName}.mp4`);
          encoders.set(source.outputName, startEncoder(ffmpeg, outputPath, source));
        }
        const scheduleBySource = new Map(rgbSchedules.map((schedule) => [schedule.sourceId, schedule]));
        const wantedMicros = new Map<string, Set<number>>();
        for (const [sourceId, schedule] of scheduleBySource) {
          wantedMicros.set(sourceId, new Set(Array.from(
            { length: schedule.frameCount },
            (_, index) => Math.round((schedule.startSeconds + index / schedule.framesPerSecond) * 1_000_000),
          )));
        }

        for (let tick = 0; tick < lowering.states.length; tick += 1) {
          if (context.signal.aborted) throw context.signal.reason instanceof Error ? context.signal.reason : new Error('native render aborted');
          const response = await client.rpc({
            op: 'render_bundle', sim_tick: tick, tick_index: tick,
            cameras: cameras[tick], passes: ['rgb'],
          });
          serverMs += response.server_ms ?? 0;
          const frameMicros = Math.round(lowering.frameTimes[tick]! * 1_000_000);
          for (const frame of response.frames ?? []) {
            if (frame.pass !== 'rgb' || !wantedMicros.get(frame.sensorId)?.has(frameMicros)) continue;
            const encoder = encoders.get(frame.sensorId);
            if (!encoder) throw new Error(`native service returned unknown camera ${frame.sensorId}`);
            const rgba = stripRgbaPadding(await client.readFrame(frame as NativeFrameRecord), frame.width, frame.height);
            if (!encoder.process.stdin.write(rgba)) await once(encoder.process.stdin, 'drain');
            encoder.frames += 1;
          }
        }
        await Promise.all([...encoders.values()].map(finishEncoder));
        encodingComplete = true;
      } finally {
        if (!encodingComplete) {
          for (const encoder of encoders.values()) {
            encoder.process.stdin.destroy();
            terminate(encoder.process);
          }
        }
        context.signal.removeEventListener('abort', abort);
        if (client) await client.close();
        terminate(service);
        if (service.exitCode === null) await once(service, 'exit').catch(() => undefined);
        await serviceLog.close();
        await Promise.all([fs.rm(socketPath, { force: true }), fs.rm(shmPath, { force: true })]);
      }

      const videoRecords = [];
      const artifacts: RenderArtifactManifest['artifacts'] = [];
      for (const encoder of [...encoders.values()].sort((left, right) => left.source.outputName.localeCompare(right.source.outputName))) {
        const digest = await hashFile(encoder.path);
        const relativePath = path.relative(context.workspace, encoder.path);
        videoRecords.push({
          actorId: encoder.source.actorId, sensorId: encoder.source.sensorId, relativePath,
          frameCount: encoder.frames, sha256: digest.sha256, sizeBytes: digest.sizeBytes,
        });
        artifacts.push({
          identity: { role: 'video', actorId: encoder.source.actorId, sensorId: encoder.source.sensorId, modality: 'rgb' },
          relativePath, sha256: digest.sha256, sizeBytes: digest.sizeBytes,
          mediaType: 'video/mp4', frameCount: encoder.frames,
        });
      }
      artifacts.push({
        identity: { role: 'trace', actorId: null, sensorId: null, modality: null },
        relativePath: traceRelative, sha256: traceDigest.sha256, sizeBytes: traceDigest.sizeBytes,
        mediaType: 'application/json', frameCount: lowering.states.length,
      });

      const nativeManifestRelative = 'manifest/native-render.json';
      const nativeManifestPath = path.join(context.workspace, nativeManifestRelative);
      await writeJson(nativeManifestPath, {
        schema: 'simforge.native-render-manifest/v1',
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        frameCount: lowering.states.length,
        videos: videoRecords,
      });
      const nativeManifestDigest = await hashFile(nativeManifestPath);
      artifacts.push({
        identity: { role: 'manifest', actorId: null, sensorId: null, modality: null },
        relativePath: nativeManifestRelative, sha256: nativeManifestDigest.sha256, sizeBytes: nativeManifestDigest.sizeBytes,
        mediaType: 'application/json', frameCount: null,
      });

      const diagnosticsRelative = 'diagnostics/native-run.json';
      const diagnosticsPath = path.join(context.workspace, diagnosticsRelative);
      await writeJson(diagnosticsPath, {
        schema: 'simforge.native-run-diagnostics/v1',
        intentSha256: context.intentSha256,
        executionPackageControlSha256: context.executionPackageControlSha256,
        sourceXoscSha256: xoscInput.sha256,
        loweringSha256: lowering.sha256,
        fixedTimestepSeconds: lowering.plan.dt,
        frameCount: lowering.states.length,
        traceSha256: traceDigest.sha256,
        videoCount: videoRecords.length,
        videos: videoRecords.map(({ actorId, sensorId, frameCount, sha256 }) => ({ actorId, sensorId, frameCount, sha256 })),
        service: { protocol: 2, binary },
        timings: { wallMs: performance.now() - wallStarted, serverMs },
      });
      const diagnosticsDigest = await hashFile(diagnosticsPath);
      artifacts.push({
        identity: { role: 'diagnostics', actorId: null, sensorId: null, modality: null },
        relativePath: diagnosticsRelative, sha256: diagnosticsDigest.sha256, sizeBytes: diagnosticsDigest.sizeBytes,
        mediaType: 'application/json', frameCount: null,
      });

      return {
        schema: 'simforge.render-artifact-manifest/v1',
        intentSha256: context.intentSha256,
        engine: { engineId: NATIVE_RENDER_ENGINE_ID, engineVersion: capabilities.engineVersion, backend: 'native' },
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts,
        warnings: [],
      };
    },
  };
}
