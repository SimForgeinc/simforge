import { createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { ENGINE_CAPABILITIES_V1_SCHEMA, type EngineCapabilityDeclaration, type RenderArtifactManifest, type RenderEngineAdapter, type RenderExecutionContext } from '../index.js';
import { fixedStepFrameCount, parseRenderIntent } from '@simforge/scenario';
import { parsePlaybackPair, type PlaybackBundle } from '@simforge/playback';
import { BROWSER_RENDER_ENGINE_ID, type BrowserCaptureResult } from './capture.js';
import type { ArtifactIdentity } from './artifacts.js';
import { BROWSER_RENDER_REQUEST_V1_SCHEMA, RENDER_INTENT_V1_SCHEMA, parseBrowserRenderIntent, type BrowserRenderIntentV1, type ResolvedBrowserRenderRequest } from './intent.js';

export interface BrowserRenderEngineOptions {
  readonly harnessUrl?: string;
  readonly chromiumExecutablePath?: string;
  /**
   * Extra Chromium switches appended after the safe defaults, e.g.
   * `--use-gl=angle --use-angle=gl-egl` to render on a real GPU instead of
   * SwiftShader. Defaults to `UNISCENARIOS_CHROMIUM_EXTRA_ARGS` (whitespace
   * separated) so hosts opt in without code changes.
   */
  readonly chromiumExtraArgs?: readonly string[];
  readonly headless?: boolean;
  readonly engineVersion?: string;
}

const gunzipAsync = promisify(gunzip);

const CAPABILITIES: EngineCapabilityDeclaration = {
  schema: ENGINE_CAPABILITIES_V1_SCHEMA,
  engineId: BROWSER_RENDER_ENGINE_ID,
  engineVersion: '0.1.0-rc.45',
  backend: 'browser',
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
    'artifact.video',
    'artifact.sensor_video',
    'artifact.frames',
    'artifact.sensor_archive',
    'artifact.manifest',
    'map.static_semantics',
  ],
  modalities: ['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'],
  limits: {
    maxSimultaneousSensors: 64,
    maxWidth: 8192,
    maxHeight: 8192,
    maxFramesPerSecond: 240,
  },
  requiresGpu: false,
};
async function defaultBrowserHarnessUrl(): Promise<string> {
  const packaged = new URL('../harness.html', import.meta.url);
  try {
    await fs.access(packaged);
    return packaged.href;
  } catch {
    const source = new URL('../../harness.html', import.meta.url);
    await fs.access(source);
    return source.href;
  }
}


/** Runtime package entrypoint discovered internally for public `--engine browser`. */
export function createRenderEngine(options: BrowserRenderEngineOptions = {}): RenderEngineAdapter {
  const capabilities: EngineCapabilityDeclaration = options.engineVersion
    ? { ...CAPABILITIES, engineVersion: options.engineVersion }
    : CAPABILITIES;
  return {
    capabilities,
    async execute(context: RenderExecutionContext): Promise<RenderArtifactManifest> {
      const startedAt = new Date().toISOString();
      const harnessUrl = options.harnessUrl
        ?? process.env.UNISCENARIOS_BROWSER_HARNESS_URL
        ?? await defaultBrowserHarnessUrl();
      await fs.mkdir(context.workspace, { recursive: true });
      const intent = resolveBrowserRenderIntent(context.intent);
      const scenarioInput = context.inputs.get('scenario.xosc');
      if (!scenarioInput) throw new Error('Browser render requires mandatory input scenario.xosc.');
      for (const asset of intent.assets) {
        const materialized = context.inputs.get(asset.assetId);
        if (!materialized) throw new Error(`Browser render input is missing declared asset ${asset.assetId}.`);
        if (materialized.sha256 !== asset.sha256 || materialized.sizeBytes !== asset.sizeBytes) throw new Error(`Browser render input ${asset.assetId} does not match its immutable declaration.`);
      }
      if (!intent.assets.some((asset) => asset.assetId === 'map.manifest')) throw new Error('Browser render intent must declare asset map.manifest.');
      if (!intent.assets.some((asset) => asset.assetId === 'playback.bundle')) throw new Error('Browser render intent must declare asset playback.bundle.');
      const mapInput = context.inputs.get('map.manifest');
      if (!mapInput) throw new Error('Browser render requires materialized asset map.manifest.');
      const playbackInput = context.inputs.get('playback.bundle');
      if (!playbackInput) throw new Error('Browser render requires materialized asset playback.bundle.');
      const request: ResolvedBrowserRenderRequest = {
        schema: BROWSER_RENDER_REQUEST_V1_SCHEMA,
        intentSha256: context.intentSha256,
        intent,
        mapManifestUrl: pathToFileURL(mapInput.path).href,
        playbackBundle: await materializePlaybackBundle(await fs.readFile(playbackInput.path)),
      };
      const outputs = new Map<string, OutputFile>();
      const chromiumExtraArgs = options.chromiumExtraArgs
        ?? process.env.UNISCENARIOS_CHROMIUM_EXTRA_ARGS?.split(/\s+/).filter(Boolean)
        ?? [];
      const browser = await chromium.launch({
        headless: options.headless ?? true,
        ...(options.chromiumExecutablePath ?? process.env.CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: options.chromiumExecutablePath ?? process.env.CHROMIUM_EXECUTABLE_PATH }
          : {}),
        args: [
          '--enable-webgl', '--ignore-gpu-blocklist', '--allow-file-access-from-files',
          // SwiftShader's Vulkan backend is the safe default; a host overriding
          // GL selection owns the whole GPU configuration (the feature flag
          // conflicts with --use-angle overrides).
          ...(chromiumExtraArgs.length === 0 ? ['--enable-features=Vulkan'] : []),
          ...chromiumExtraArgs,
        ],
      });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.exposeFunction('__simforgeArtifactOpen', async (identity: ArtifactIdentity, mediaType: string) => {
          const handle = `artifact-${outputs.size}`;
          const relativePath = artifactRelativePath(identity, mediaType);
          const absolutePath = path.join(context.workspace, relativePath);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          outputs.set(handle, { identity, mediaType, relativePath, stream: createWriteStream(absolutePath, { flags: 'wx' }), closed: false });
          return handle;
        });
        await page.exposeFunction('__simforgeArtifactWrite', async (handle: string, base64: string) => {
          const output = requiredOutput(outputs, handle);
          const bytes = Buffer.from(base64, 'base64');
          if (!output.stream.write(bytes)) await new Promise<void>((resolve, reject) => { output.stream.once('drain', resolve); output.stream.once('error', reject); });
        });
        await page.exposeFunction('__simforgeArtifactClose', async (handle: string) => {
          const output = requiredOutput(outputs, handle);
          if (output.closed) throw new Error(`Artifact ${handle} was closed more than once.`);
          output.closed = true;
          await new Promise<void>((resolve, reject) => { output.stream.end(resolve); output.stream.once('error', reject); });
        });
        await page.exposeFunction('__simforgeArtifactAbort', async (handle: string) => {
          const output = outputs.get(handle);
          if (!output || output.closed) return;
          output.closed = true;
          output.stream.destroy();
          await fs.rm(path.join(context.workspace, output.relativePath), { force: true });
        });
        await page.exposeFunction('__simforgeProgress', async (line: string) => {
          const progress = JSON.parse(line) as { event?: string; completedFrames?: number; totalFrames?: number };
          if (progress.event !== 'frame') return;
          await context.reportProgress({
            schema: 'uniscenario.render-progress/v1', jobId: context.jobId, attempt: context.attempt, sequence: 0,
            timestamp: new Date().toISOString(), event: 'stage.progress', stage: 'rendering',
            completed: progress.completedFrames ?? 0, total: progress.totalFrames ?? 0, unit: 'frames',
          });
        });
        await page.addInitScript(() => {
          const root = globalThis as typeof globalThis & Record<string, (...args: unknown[]) => Promise<unknown>>;
          Object.assign(globalThis, {
            __simforgeArtifactBridge: {
              open: (identity: unknown, mediaType: string) => root.__simforgeArtifactOpen!(identity, mediaType),
              write: (handle: string, base64: string) => root.__simforgeArtifactWrite!(handle, base64),
              close: (handle: string) => root.__simforgeArtifactClose!(handle),
              abort: (handle: string, message: string) => root.__simforgeArtifactAbort!(handle, message),
              progress: (line: string) => root.__simforgeProgress!(line),
            },
          });
        });
        const abort = () => { void page.close(); };
        context.signal.addEventListener('abort', abort, { once: true });
        try {
          await page.goto(harnessUrl, { waitUntil: 'networkidle' });
          await page.waitForFunction(() => globalThis.__simforgeBrowserRender?.engine === 'browser');
          const result = await page.evaluate(async (intent) => {
            if (!globalThis.__simforgeBrowserRender) throw new Error('Browser render harness did not install its adapter.');
            return globalThis.__simforgeBrowserRender.render(intent);
          }, request) as BrowserCaptureResult;
          const artifacts = result.artifacts.map((artifact) => {
            const output = [...outputs.values()].find((candidate) => sameIdentity(candidate.identity, artifact) && candidate.mediaType === artifact.mediaType);
            if (!output) throw new Error(`Browser harness did not register output for ${artifact.role}/${artifact.sensorId ?? 'global'}.`);
            const sensor = artifact.actorId !== null && artifact.sensorId !== null && ['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'].includes(artifact.modality);
            const role = artifact.role === 'sensor-archive'
              ? 'sensorArchive' as const
              : artifact.role === 'sensor-video'
                ? 'video' as const
                : artifact.role === 'render-manifest'
                  ? 'manifest' as const
                  : 'diagnostics' as const;
            return {
              identity: sensor
                ? { role: role as 'video' | 'sensorArchive', actorId: artifact.actorId, sensorId: artifact.sensorId, modality: artifact.modality as 'rgb' | 'depth' | 'semantic' | 'instance' | 'lidar' | 'radar' }
                : { role: role as 'manifest' | 'diagnostics', actorId: null, sensorId: null, modality: null },
              relativePath: output.relativePath,
              sha256: artifact.sha256,
              sizeBytes: artifact.byteLength,
              mediaType: artifact.mediaType,
              frameCount: sensor ? result.frameCount : null,
            };
          });
          return {
            schema: 'uniscenario.render-artifact-manifest/v1',
            intentSha256: context.intentSha256,
            engine: { engineId: BROWSER_RENDER_ENGINE_ID, engineVersion: options.engineVersion ?? '0.1.0-rc.45', backend: 'browser' },
            startedAt,
            completedAt: new Date().toISOString(),
            artifacts,
            warnings: result.omittedArtifacts.map((omitted) => ({
              code: omitted.role === 'sensor-video' ? 'sensor_video_omitted' : 'sensor_archive_omitted',
              message: `${omitted.role} omitted (${omitted.reason}): ${omitted.actorId}/${omitted.sensorId}/${omitted.modality}`,
            })),
          } as RenderArtifactManifest;
        } finally {
          context.signal.removeEventListener('abort', abort);
        }
      } finally {
        await browser.close();
        await Promise.all([...outputs.values()].filter((output) => !output.closed).map(async (output) => {
          output.closed = true;
          output.stream.destroy();
          await fs.rm(path.join(context.workspace, output.relativePath), { force: true });
        }));
      }
    },
  };
}
export async function decodePlaybackArchive(bytes: Uint8Array): Promise<unknown> {
  const decoded = bytes[0] === 0x1f && bytes[1] === 0x8b
    ? await gunzipAsync(bytes)
    : bytes;
  return JSON.parse(Buffer.from(decoded).toString('utf8')) as unknown;
}

export async function materializePlaybackBundle(bytes: Uint8Array): Promise<PlaybackBundle> {
  const stored = await decodePlaybackArchive(bytes);
  if (!stored || typeof stored !== 'object' || !('instance' in stored) || !('trace' in stored)) {
    throw new Error('Persisted playback bundle is missing instance or trace evidence.');
  }
  const envelope = stored as {
    instance: unknown;
    trace: unknown;
    ambientTraffic?: PlaybackBundle['ambientTraffic'];
    mapCollisions?: PlaybackBundle['mapCollisions'];
    openScenario?: PlaybackBundle['openScenario'];
  };
  return {
    ...parsePlaybackPair(envelope.instance, normalizeSavedPlaybackTrace(envelope.trace), {
      instanceName: 'saved scenario',
      traceName: 'saved simulation',
    }),
    ...(envelope.ambientTraffic ? { ambientTraffic: envelope.ambientTraffic } : {}),
    ...(envelope.mapCollisions ? { mapCollisions: envelope.mapCollisions } : {}),
    ...(envelope.openScenario ? { openScenario: envelope.openScenario } : {}),
  };
}

export function normalizeSavedPlaybackTrace(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const trace = value as Record<string, unknown>;
  const header = trace['header'];
  const ticks = trace['ticks'];
  if (!header || typeof header !== 'object' || (header as Record<string, unknown>)['frame'] !== 'scene'
    || !ticks || typeof ticks !== 'object') {
    return value;
  }
  const actors = (ticks as Record<string, unknown>)['actors'];
  if (!actors || typeof actors !== 'object') return value;
  return {
    ...trace,
    header: { ...(header as Record<string, unknown>), frame: 'xodr-local' },
    ticks: {
      ...(ticks as Record<string, unknown>),
      actors: Object.fromEntries(Object.entries(actors).map(([id, value]) => {
        const track = value as Record<string, unknown>;
        const z = track['z'];
        return [id, {
          ...track,
          ...(Array.isArray(z) ? { y: z.map((coordinate) => -Number(coordinate)) } : {}),
        }];
      })),
    },
  };
}

export function resolveBrowserRenderIntent(value: unknown): BrowserRenderIntentV1 {
  const portable = parseRenderIntent(value);
  const fps = portable.renderSpec.video?.fps ?? Math.max(
    1,
    ...portable.renderSpec.sources.flatMap((source) =>
      'fps' in source.attributes ? [source.attributes.fps] : []
    ),
  );
  const frameCount = fixedStepFrameCount(
    portable.renderSpec.clip.startSeconds,
    portable.renderSpec.clip.endSeconds,
    fps,
  );
  return parseBrowserRenderIntent({
    schema: RENDER_INTENT_V1_SCHEMA,
    engine: 'browser',
    sensorHost: portable.sensorHost,
    assets: portable.assets,
    renderSpec: portable.renderSpec,
    schedule: {
      startSeconds: portable.renderSpec.clip.startSeconds,
      endSeconds: portable.renderSpec.clip.endSeconds,
      fps,
      frameCount,
      timestampUnit: 'microseconds',
      firstTimestampUs: 0,
      endTimestampUs: Math.round(frameCount * 1_000_000 / fps),
    },
  });
}


type OutputFile = { identity: ArtifactIdentity; mediaType: string; relativePath: string; stream: WriteStream; closed: boolean };
function requiredOutput(outputs: ReadonlyMap<string, OutputFile>, handle: string): OutputFile { const output = outputs.get(handle); if (!output || output.closed) throw new Error(`Unknown or closed artifact handle: ${handle}`); return output; }
function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean { return left.role === right.role && left.actorId === right.actorId && left.sensorId === right.sensorId && left.modality === right.modality; }
function artifactRelativePath(identity: ArtifactIdentity, mediaType: string): string {
  const safe = (value: string) => { if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error(`Unsafe artifact path component: ${value}`); return value; };
  if (identity.actorId && identity.sensorId) {
    const extension = mediaType === 'video/webm' ? 'webm' : 'zip';
    return `sensors/${safe(identity.actorId)}/${safe(identity.sensorId)}/${safe(identity.modality)}.${extension}`;
  }
  if (identity.role === 'render-manifest') return 'render-manifest.json';
  return 'diagnostics/sensor-frames.ndjson';
}
