import { CityViewer } from '@simforge/viewer';
import { PlaybackController } from '@simforge/playback';
import { captureBrowserArtifacts, BROWSER_RENDER_ENGINE_ID, type BrowserCaptureResult } from './capture.js';
import { parseResolvedBrowserRenderRequest, type ResolvedBrowserRenderRequest } from './intent.js';
import type { ArtifactByteSink, ArtifactIdentity } from './artifacts.js';
import { assertBrowserSensorHost } from './pronto.js';

export interface HeadlessArtifactBridge {
  open(identity: ArtifactIdentity, mediaType: string): Promise<string>;
  write(handle: string, base64: string): Promise<void>;
  close(handle: string): Promise<void>;
  abort(handle: string, message: string): Promise<void>;
  progress(line: string): Promise<void> | void;
}

export interface BrowserEngineServices {
  readonly canvas: HTMLCanvasElement;
  readonly artifactBridge: HeadlessArtifactBridge;
  readonly signal?: AbortSignal;
}

/** Public worker adapter bound by stable engine ID `browser`. */
export const browserEngineAdapter = Object.freeze({
  engine: BROWSER_RENDER_ENGINE_ID,
  async render(value: unknown, services: BrowserEngineServices): Promise<BrowserCaptureResult> {
    const request = parseResolvedBrowserRenderRequest(value);
    return renderHeadlessIntent(request, services);
  },
});

export async function renderHeadlessIntent(request: ResolvedBrowserRenderRequest, services: BrowserEngineServices): Promise<BrowserCaptureResult> {
  assertBrowserSensorHost(request.intent.renderSpec, request.playbackBundle, request.intent.sensorHost);
  const viewer = new CityViewer(services.canvas, { antialias: false, maxPixelRatio: 1 });
  let controller: PlaybackController | null = null;
  try {
    await viewer.loadMap(request.mapManifestUrl);
    const ground = viewer.getGroundIndex();
    controller = new PlaybackController({
      viewer,
      bundle: request.playbackBundle,
      sampleHeight: (x, z) => ground?.sample(x, z) ?? viewer.sampleGroundHeight(x, z),
      externalClock: true,
      loop: false,
    });
    return await captureBrowserArtifacts({
      intentSha256: request.intentSha256,
      viewer,
      controller,
      bundle: request.playbackBundle,
      renderSpec: request.intent.renderSpec,
      schedule: request.intent.schedule,
      createArtifactSink: async (identity, mediaType) => new BridgeArtifactSink(services.artifactBridge, await services.artifactBridge.open(identity, mediaType)),
      signal: services.signal,
      onProgress: (line) => { void services.artifactBridge.progress(line); },
    });
  } finally {
    controller?.dispose();
    viewer.dispose();
  }
}

class BridgeArtifactSink implements ArtifactByteSink {
  private closed = false;
  constructor(private readonly bridge: HeadlessArtifactBridge, private readonly handle: string) {}

  async write(chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('Headless artifact bridge is closed.');
    if (signal?.aborted) throw signal.reason;
    // Bound CDP messages while preserving streaming backpressure.
    for (let offset = 0; offset < chunk.byteLength; offset += 192 * 1024) {
      const part = chunk.subarray(offset, Math.min(chunk.byteLength, offset + 192 * 1024));
      let binary = '';
      for (let index = 0; index < part.byteLength; index += 1) binary += String.fromCharCode(part[index]!);
      await this.bridge.write(this.handle, btoa(binary));
      if (signal?.aborted) throw signal.reason;
    }
  }

  async close(): Promise<void> {
    if (this.closed) throw new Error('Headless artifact bridge was closed more than once.');
    this.closed = true;
    await this.bridge.close(this.handle);
  }

  async abort(reason: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.bridge.abort(this.handle, reason instanceof Error ? reason.message : String(reason));
  }
}

export function installHeadlessHarness(input: { canvas?: HTMLCanvasElement; bridge: HeadlessArtifactBridge }): void {
  const canvas = input.canvas ?? document.querySelector<HTMLCanvasElement>('canvas#uniscenarios-render');
  if (!canvas) throw new Error('Headless renderer requires canvas#uniscenarios-render.');
  const api = {
    engine: BROWSER_RENDER_ENGINE_ID,
    render: (intent: unknown) => browserEngineAdapter.render(intent, { canvas, artifactBridge: input.bridge }),
  };
  Object.assign(globalThis, { __uniscenariosBrowserRender: api });
  globalThis.dispatchEvent(new CustomEvent('uniscenarios-browser-render-ready', { detail: { engine: BROWSER_RENDER_ENGINE_ID } }));
}

export function autoInstallHeadlessHarness(): void {
  const bridge = (globalThis as typeof globalThis & { __uniscenariosArtifactBridge?: HeadlessArtifactBridge }).__uniscenariosArtifactBridge;
  if (!bridge) throw new Error('Headless host did not install __uniscenariosArtifactBridge.');
  installHeadlessHarness({ bridge });
}

declare global {
  var __uniscenariosBrowserRender: Readonly<{ engine: 'browser'; render(intent: unknown): Promise<BrowserCaptureResult> }> | undefined;
}
