import { CityViewer } from '@simforge/viewer';
import { PlaybackController } from '@simforge/playback';
import { captureBrowserArtifacts, BROWSER_RENDER_ENGINE_ID, type BrowserCaptureResult } from './capture.js';
import { parseResolvedBrowserRenderRequest, type ResolvedBrowserRenderRequest } from './intent.js';
import type { ArtifactByteSink, ArtifactIdentity } from './artifacts.js';
import { assertBrowserSensorHost } from './sensor-host.js';

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

/**
 * Bound and batch CDP messages: exposeFunction round trips dominate per-frame
 * artifact writes, so bytes coalesce into 1 MiB bridge messages while keeping
 * streaming backpressure (one in-flight message per sink).
 */
const BRIDGE_MESSAGE_BYTES = 1024 * 1024;

export class BridgeArtifactSink implements ArtifactByteSink {
  private closed = false;
  private readonly buffer = new Uint8Array(BRIDGE_MESSAGE_BYTES);
  private bufferedBytes = 0;
  constructor(private readonly bridge: HeadlessArtifactBridge, private readonly handle: string) {}

  async write(chunk: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error('Headless artifact bridge is closed.');
    if (signal?.aborted) throw signal.reason;
    let offset = 0;
    while (offset < chunk.byteLength) {
      const take = Math.min(chunk.byteLength - offset, BRIDGE_MESSAGE_BYTES - this.bufferedBytes);
      this.buffer.set(chunk.subarray(offset, offset + take), this.bufferedBytes);
      this.bufferedBytes += take;
      offset += take;
      if (this.bufferedBytes === BRIDGE_MESSAGE_BYTES) await this.flush(signal);
    }
  }

  private async flush(signal?: AbortSignal): Promise<void> {
    if (this.bufferedBytes === 0) return;
    const pending = this.buffer.subarray(0, this.bufferedBytes);
    this.bufferedBytes = 0;
    await this.bridge.write(this.handle, base64Of(pending));
    if (signal?.aborted) throw signal.reason;
  }

  async close(): Promise<void> {
    if (this.closed) throw new Error('Headless artifact bridge was closed more than once.');
    await this.flush();
    this.closed = true;
    await this.bridge.close(this.handle);
  }

  async abort(reason: unknown): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.bufferedBytes = 0;
    await this.bridge.abort(this.handle, reason instanceof Error ? reason.message : String(reason));
  }
}

function base64Of(bytes: Uint8Array): string {
  // String.fromCharCode over bounded slabs is native-speed; per-byte string
  // concatenation was the previous hot spot at multi-megabyte artifact rates.
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + 0x8000))));
  }
  return btoa(parts.join(''));
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
