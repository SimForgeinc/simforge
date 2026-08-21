import { once } from 'node:events';
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright-core';
import { parsePlaybackPair, type PlaybackBundle } from '@uniscenarios/playback';
import { ENGINE_CAPABILITIES_V1_SCHEMA, type EngineCapabilityDeclaration, type RenderArtifactManifest, type RenderEngineAdapter, type RenderExecutionContext } from '@uniscenarios/render-runtime';
import { BROWSER_RENDER_ENGINE_ID, type BrowserCaptureResult } from './capture.js';
import type { ArtifactIdentity } from './artifacts.js';
import { BROWSER_RENDER_REQUEST_V1_SCHEMA, parseBrowserRenderIntent, type ResolvedBrowserRenderRequest } from './intent.js';

export interface BrowserRenderEngineOptions {
  readonly harnessUrl?: string;
  readonly chromiumExecutablePath?: string;
  readonly headless?: boolean;
  readonly engineVersion?: string;
}

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
  requiresGpu: true,
};

const SAVED_PREVIEW_SCHEMA = 'simforge.uniscenario-browser-preview/v2';

/** Accept both a direct worker bundle and SimCloud's persisted preview envelope. */
export function decodePlaybackArtifact(value: unknown): PlaybackBundle {
  if (!value || typeof value !== 'object') throw new Error('Browser playback artifact must be an object.');
  if ('schema' in value && value.schema === SAVED_PREVIEW_SCHEMA) {
    if (!('instance' in value) || !('trace' in value)) {
      throw new Error('Saved browser preview omits its scenario instance or trace.');
    }
    const base = parsePlaybackPair(value.instance, value.trace, {
      instanceName: 'saved scenario',
      traceName: 'saved simulation',
    });
    const ambientTraffic = 'ambientTraffic' in value && value.ambientTraffic && typeof value.ambientTraffic === 'object'
      ? value.ambientTraffic as PlaybackBundle['ambientTraffic']
      : undefined;
    const mapCollisions = 'mapCollisions' in value && value.mapCollisions && typeof value.mapCollisions === 'object'
      ? value.mapCollisions as PlaybackBundle['mapCollisions']
      : undefined;
    const openScenario = 'openScenario' in value && value.openScenario && typeof value.openScenario === 'object'
      ? value.openScenario as PlaybackBundle['openScenario']
      : undefined;
    return {
      ...base,
      ...(ambientTraffic ? { ambientTraffic } : {}),
      ...(mapCollisions ? { mapCollisions } : {}),
      ...(openScenario ? { openScenario } : {}),
    };
  }
  if (!('actors' in value) || !Array.isArray(value.actors)) {
    throw new Error('Direct browser playback bundle omits actor metadata.');
  }
  // The direct bundle is produced by the pinned browser compiler; the actor
  // closure above distinguishes it from the persisted preview envelope.
  return value as PlaybackBundle;
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
      const harnessUrl = options.harnessUrl ?? process.env.UNISCENARIOS_BROWSER_HARNESS_URL ?? new URL('../harness.html', import.meta.url).href;
      await fs.mkdir(context.workspace, { recursive: true });
      const intent = parseBrowserRenderIntent(context.intent);
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
      const playbackBytes = await fs.readFile(playbackInput.path);
      const playbackJson = playbackBytes[0] === 0x1f && playbackBytes[1] === 0x8b
        ? gunzipSync(playbackBytes).toString('utf8')
        : playbackBytes.toString('utf8');
      const request: ResolvedBrowserRenderRequest = {
        schema: BROWSER_RENDER_REQUEST_V1_SCHEMA,
        intentSha256: context.intentSha256,
        intent,
        mapManifestUrl: pathToFileURL(mapInput.path).href,
        playbackBundle: decodePlaybackArtifact(JSON.parse(playbackJson)),
      };
      const outputs = new Map<string, OutputFile>();
      const browser = await chromium.launch({
        // GPU-backed Chromium currently requires a display server. Container
        // images provide an isolated Xvfb display; local callers without one
        // retain headless mode for diagnostics and tests.
        headless: options.headless ?? !process.env.DISPLAY,
        ...(options.chromiumExecutablePath ?? process.env.CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: options.chromiumExecutablePath ?? process.env.CHROMIUM_EXECUTABLE_PATH }
          : {}),
        args: [
          '--enable-webgl',
          '--ignore-gpu-blocklist',
          '--enable-features=Vulkan,VulkanFromANGLE',
          '--use-angle=vulkan',
          '--disable-software-rasterizer',
          '--allow-file-access-from-files',
        ],
      });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.exposeFunction('__uniscenariosArtifactOpen', async (identity: ArtifactIdentity, mediaType: string) => {
          const handle = `artifact-${outputs.size}`;
          const relativePath = artifactRelativePath(identity, mediaType);
          const absolutePath = path.join(context.workspace, relativePath);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          const stream = createWriteStream(absolutePath, { flags: 'wx' });
          await once(stream, 'open');
          outputs.set(handle, { identity, mediaType, relativePath, stream, closed: false });
          return handle;
        });
        await page.exposeFunction('__uniscenariosArtifactWrite', async (handle: string, base64: string) => {
          const output = requiredOutput(outputs, handle);
          const bytes = Buffer.from(base64, 'base64');
          if (!output.stream.write(bytes)) await once(output.stream, 'drain');
        });
        await page.exposeFunction('__uniscenariosArtifactClose', async (handle: string) => {
          const output = requiredOutput(outputs, handle);
          if (output.closed) throw new Error(`Artifact ${handle} was closed more than once.`);
          output.closed = true;
          const finished = once(output.stream, 'finish');
          output.stream.end();
          await finished;
        });
        await page.exposeFunction('__uniscenariosArtifactAbort', async (handle: string) => {
          const output = outputs.get(handle);
          if (!output || output.closed) return;
          output.closed = true;
          output.stream.destroy();
          await fs.rm(path.join(context.workspace, output.relativePath), { force: true });
        });
        await page.exposeFunction('__uniscenariosProgress', async (line: string) => {
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
            __uniscenariosArtifactBridge: {
              open: (identity: unknown, mediaType: string) => root.__uniscenariosArtifactOpen!(identity, mediaType),
              write: (handle: string, base64: string) => root.__uniscenariosArtifactWrite!(handle, base64),
              close: (handle: string) => root.__uniscenariosArtifactClose!(handle),
              abort: (handle: string, message: string) => root.__uniscenariosArtifactAbort!(handle, message),
              progress: (line: string) => root.__uniscenariosProgress!(line),
            },
          });
        });
        const abort = () => { void page.close(); };
        context.signal.addEventListener('abort', abort, { once: true });
        try {
          await page.goto(harnessUrl, { waitUntil: 'networkidle' });
          await page.waitForFunction(() => globalThis.__uniscenariosBrowserRender?.engine === 'browser');
          const webgl = await page.evaluate(() => {
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
            const extension = context?.getExtension('WEBGL_debug_renderer_info');
            return {
              available: context !== null,
              renderer: context && extension
                ? String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL))
                : null,
            };
          });
          if (!webgl.available || webgl.renderer === null) {
            throw new Error('Browser render requires an inspectable hardware WebGL context.');
          }
          if (/swiftshader|llvmpipe|software/i.test(webgl.renderer)) {
            throw new Error(`Browser render refused software WebGL renderer: ${webgl.renderer}`);
          }
          const result = await page.evaluate(async (intent) => {
            if (!globalThis.__uniscenariosBrowserRender) throw new Error('Browser render harness did not install its adapter.');
            return globalThis.__uniscenariosBrowserRender.render(intent);
          }, request) as BrowserCaptureResult;
          const artifacts = result.artifacts.map((artifact) => {
            const output = [...outputs.values()].find((candidate) => sameIdentity(candidate.identity, artifact) && candidate.mediaType === artifact.mediaType);
            if (!output) throw new Error(`Browser harness did not register output for ${artifact.role}/${artifact.sensorId ?? 'global'}.`);
            const sensor = artifact.actorId !== null && artifact.sensorId !== null && ['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'].includes(artifact.modality);
            const role = artifact.role === 'sensor-archive'
              ? 'sensorArchive' as const
              : artifact.role === 'sensor-video' || artifact.role === 'render-video'
                ? 'video' as const
                : artifact.role === 'render-manifest'
                  ? 'manifest' as const
                  : 'diagnostics' as const;
            return {
              identity: sensor
                ? { role: role as 'video' | 'sensorArchive', actorId: artifact.actorId, sensorId: artifact.sensorId, modality: artifact.modality as 'rgb' | 'depth' | 'semantic' | 'instance' | 'lidar' | 'radar' }
                : { role: role as 'video' | 'manifest' | 'diagnostics', actorId: null, sensorId: null, modality: null },
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
            warnings: [],
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
  if (identity.role === 'render-video' && mediaType === 'video/webm') return 'render-video.webm';
  return 'diagnostics/sensor-frames.ndjson';
}
