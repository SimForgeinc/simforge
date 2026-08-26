/**
 * `native` render engine adapter: render intent -> `native-render-job`
 * invocation -> artifact + hash contract identical to the browser engine.
 *
 * The adapter never renders itself; it validates the intent, derives an
 * immutable job document from the verified input map, spawns the Rust
 * binary (renderer/render-core), and repackages its raw pass outputs into
 * deterministic per-sensor tar archives that satisfy the render-runtime
 * artifact manifest schema.
 *
 * v1 coverage (pre-WSB3): camera passes rgb / instance-ID / depth for every
 * RGB camera source. LiDAR/radar/semantic sources are declared in the
 * capability list (the Pronto rig schema requires their presence) and are
 * reported as structured manifest warnings until WSB3 lands those passes —
 * no synthetic data is ever emitted for them.
 */
import { spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  ENGINE_CAPABILITIES_V1_SCHEMA,
  hashFile,
  type EngineCapabilityDeclaration,
  type RenderArtifactManifest,
  type RenderEngineAdapter,
  type RenderExecutionContext,
} from '../index.js';
import { parseRenderIntent, type RenderIntentV1 } from '@simforge-oss/scenario';

import { createTar, type TarEntry } from './tar.js';

export const NATIVE_RENDER_ENGINE_ID = 'uniscenarios-native';
export const NATIVE_CAMERA_SCHEDULE_SCHEMA = 'uniscenario.native-camera-schedule/v1';
const JOB_SCHEMA = 'uniscenario.native-render-job/v1';
const RESULTS_SCHEMA = 'uniscenario.native-render-results/v1';

export interface NativeRenderEngineOptions {
  /** Path to the native-render-job binary. */
  readonly binary?: string;
  readonly engineVersion?: string;
}

const CAPABILITIES: EngineCapabilityDeclaration = {
  schema: ENGINE_CAPABILITIES_V1_SCHEMA,
  engineId: NATIVE_RENDER_ENGINE_ID,
  engineVersion: '0.1.0',
  backend: 'native',
  protocolVersion: 1,
  capabilities: [
    'openscenario.1_4',
    'timing.fixed_step',
    'environment.authored',
    'sensor.rgb',
    'sensor.depth',
    'sensor.semantic',
    'sensor.instance',
    'sensor.lidar',
    'sensor.radar',
    'artifact.frames',
    'artifact.sensor_archive',
    'artifact.manifest',
    'artifact.video',
    'map.static_semantics',
  ],
  modalities: ['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'],
  limits: {
    maxSimultaneousSensors: 64,
    maxWidth: 4096,
    maxHeight: 4096,
    maxFramesPerSecond: 120,
  },
  requiresGpu: true,
};

/** Resolve the batch renderer binary. */
export function resolveBinary(options: NativeRenderEngineOptions): string {
  if (options.binary) return options.binary;
  if (process.env.UNISCENARIOS_NATIVE_RENDER_BINARY) return process.env.UNISCENARIOS_NATIVE_RENDER_BINARY;
  const candidates = [
    path.resolve('renderer/target/release/native-render-job'),
    path.resolve('renderer/target/debug/native-render-job'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return 'native-render-job';
}

/** The produced-pass mapping into artifact modalities. */
const PASS_MODALITY: Record<string, 'rgb' | 'instance' | 'depth'> = {
  rgb: 'rgb',
  id: 'instance',
  depth: 'depth',
};
const PASS_SUFFIX: Record<'rgb' | 'id' | 'depth', string> = {
  rgb: '.rgb.png',
  id: '.id.png',
  depth: '.depth.f32.bin',
};

interface ScheduleCamera {
  sensorId: string;
  width: number;
  height: number;
  fovDeg: number;
  eye: [number, number, number];
  target: [number, number, number];
}
interface ScheduleFrame {
  frameIndex: number;
  tSeconds?: number;
  cameras: ScheduleCamera[];
}
export interface NativeCameraSchedule {
  schema: typeof NATIVE_CAMERA_SCHEDULE_SCHEMA;
  profile: 'sensor' | 'cinematic';
  lighting?: {
    sunElevDeg?: number;
    sunAzimDeg?: number;
    sunLux?: number;
    ambient?: number;
  };
  /** Optional simforge.road-detail/v1 sidecars (absolute paths), applied by
   * the renderer after scene readiness (docs/road-detail.md). */
  roadDetail?: { sidecars: string[] };
  frames: ScheduleFrame[];
}

interface JobResults {
  schema: string;
  profile: string;
  legend: Array<{ id: number; name: string }>;
  artifacts: Array<{
    frameIndex: number;
    tSeconds?: number | null;
    sensorId: string;
    pass: 'rgb' | 'id' | 'depth' | 'depth_viz';
    relativePath: string;
    sha256: string;
    sizeBytes: number;
    mediaType: string;
    width: number;
    height: number;
  }>;
  timings: Record<string, number>;
}

export function createRenderEngine(options: NativeRenderEngineOptions = {}): RenderEngineAdapter {
  const capabilities: EngineCapabilityDeclaration = options.engineVersion
    ? { ...CAPABILITIES, engineVersion: options.engineVersion }
    : CAPABILITIES;
  const binary = resolveBinary(options);

  return {
    capabilities,
    async execute(context: RenderExecutionContext): Promise<RenderArtifactManifest> {
      const startedAt = new Date().toISOString();
      await fs.mkdir(context.workspace, { recursive: true });
      const intent: RenderIntentV1 = parseRenderIntent(context.intent);
      const sourceById = new Map(intent.renderSpec.sources.map((source) => [source.outputName, source]));

      // Verified inputs: map tiles + immutable camera schedule.
      const tileInputs = [...context.inputs.values()]
        .filter((input) => /^map\.tile\.[A-Za-z0-9._-]+$/.test(input.inputId))
        .sort((left, right) => left.inputId.localeCompare(right.inputId));
      if (tileInputs.length === 0) throw new Error('native render requires map.tile.* inputs (decoded corpus GLBs)');
      const scheduleInput = context.inputs.get('native.camera-schedule');
      if (!scheduleInput) throw new Error('native render requires the native.camera-schedule input');
      const schedule = JSON.parse(await fs.readFile(scheduleInput.path, 'utf8')) as NativeCameraSchedule;
      if (schedule.schema !== NATIVE_CAMERA_SCHEDULE_SCHEMA) {
        throw new Error(`camera schedule must use ${NATIVE_CAMERA_SCHEDULE_SCHEMA}`);
      }
      if (schedule.frames.length === 0) throw new Error('camera schedule has no frames');

      const jobPath = path.join(context.workspace, 'native-render-job.json');
      await fs.writeFile(jobPath, `${JSON.stringify({
        schema: JOB_SCHEMA,
        profile: schedule.profile,
        ...(schedule.lighting ? { lighting: schedule.lighting } : {}),
        ...(schedule.roadDetail ? { roadDetail: schedule.roadDetail } : {}),
        glbs: tileInputs.map((tile) => tile.path),
        schedule: schedule.frames.map((frame) => ({
          frameIndex: frame.frameIndex,
          ...(frame.tSeconds !== undefined ? { tSeconds: frame.tSeconds } : {}),
          cameras: frame.cameras,
        })),
        outDir: context.workspace,
      }, null, 2)}\n`, { mode: 0o600 });

      // Spawn the renderer; stderr streams progress lines.
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, ['--job', jobPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => {
          stderr = `${stderr}${chunk}`.slice(-16_384);
        });
        const terminate = (): void => {
          child.kill('SIGTERM');
          const hardKill = setTimeout(() => child.kill('SIGKILL'), 10_000);
          hardKill.unref();
        };
        context.signal.addEventListener('abort', terminate, { once: true });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
          context.signal.removeEventListener('abort', terminate);
          if (code === 0) resolve();
          else reject(new Error(`native renderer exited code=${String(code)} signal=${String(signal)}\n${stderr}\n${stdout}`));
        });
      });

      const resultsPath = path.join(context.workspace, 'results.json');
      const results = JSON.parse(await fs.readFile(resultsPath, 'utf8')) as JobResults;
      if (results.schema !== RESULTS_SCHEMA) throw new Error(`unexpected results schema ${results.schema}`);

      /* ---------------- package per sensor x modality tar archives ------- */

      const warnings: Array<{ code: string; message: string }> = [];
      const frameCount = schedule.frames.length;

      // Which modalities did the rig request vs what v1 produces?
      const requested = new Set(intent.renderSpec.sources.map((source: { modality: string }) => source.modality));
      for (const modality of ['lidar', 'radar', 'semantic'] as const) {
        if (requested.has(modality)) {
          warnings.push({
            code: 'native.v1.modality_deferred',
            message: `modality ${modality} is not produced by native engine v1 (lands with WSB3); no synthetic artifacts were emitted`,
          });
        }
      }

      const byGroup = new Map<string, typeof results.artifacts>();
      for (const artifact of results.artifacts) {
        const modality = PASS_MODALITY[artifact.pass];
        if (!modality) continue; // depth_viz stays out of archives
        const source = sourceById.get(artifact.sensorId);
        if (!source) throw new Error(`native renderer returned unknown source ${artifact.sensorId}`);
        const key = `${source.outputName}\u0000${modality}`;
        const group = byGroup.get(key) ?? [];
        group.push(artifact);
        byGroup.set(key, group);
      }

      const artifacts: RenderArtifactManifest['artifacts'] = [];
      for (const [key, group] of [...byGroup.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        const [sourceId, modality] = key.split('\u0000') as [string, 'rgb' | 'instance' | 'depth'];
        const source = sourceById.get(sourceId)!;
        group.sort((left, right) => left.frameIndex - right.frameIndex);
        const suffix = PASS_SUFFIX[modality === 'instance' ? 'id' : modality];
        const entries: TarEntry[] = [];
        for (const artifact of group) {
          const bytes = await fs.readFile(path.join(context.workspace, artifact.relativePath));
          entries.push({
            name: `frame-${String(artifact.frameIndex).padStart(5, '0')}${suffix}`,
            data: new Uint8Array(bytes),
          });
        }
        const archiveRelative = `sensors/${source.actorId}/${source.sensorId}/${modality}.tar`;
        const archivePath = path.join(context.workspace, archiveRelative);
        await fs.mkdir(path.dirname(archivePath), { recursive: true });
        const tar = createTar(entries);
        await pipeline(Readable.from([tar]), createWriteStream(archivePath, { flags: 'wx', mode: 0o644 }));
        const digest = await hashFile(archivePath);
        artifacts.push({
          identity: { role: 'sensorArchive', actorId: source.actorId, sensorId: source.sensorId, modality },
          relativePath: archiveRelative,
          sha256: digest.sha256,
          sizeBytes: digest.sizeBytes,
          mediaType: 'application/x-tar',
          frameCount,
        });
      }

      // Diagnostics bundle: legend + timings + job echo (one global entry).
      const diagnosticsRelative = 'diagnostics/native-run.json';
      await fs.mkdir(path.dirname(path.join(context.workspace, diagnosticsRelative)), { recursive: true });
      const diagnostics = {
        schema: 'uniscenario.native-run-diagnostics/v1',
        intentSha256: context.intentSha256,
        engineVersion: capabilities.engineVersion,
        legend: results.legend,
        timings: results.timings,
        frameCount,
      };
      const diagnosticsPath = path.join(context.workspace, diagnosticsRelative);
      await fs.writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, { mode: 0o644 });
      const diagnosticsDigest = await hashFile(diagnosticsPath);
      artifacts.push({
        identity: { role: 'diagnostics', actorId: null, sensorId: null, modality: null },
        relativePath: diagnosticsRelative,
        sha256: diagnosticsDigest.sha256,
        sizeBytes: diagnosticsDigest.sizeBytes,
        mediaType: 'application/json',
        frameCount: null,
      });

      if (artifacts.length === 0) throw new Error('native renderer produced no artifacts');

      return {
        schema: 'uniscenario.render-artifact-manifest/v1',
        intentSha256: context.intentSha256,
        engine: { engineId: NATIVE_RENDER_ENGINE_ID, engineVersion: capabilities.engineVersion, backend: 'native' },
        startedAt,
        completedAt: new Date().toISOString(),
        artifacts,
        warnings,
      };
    },
  };
}
