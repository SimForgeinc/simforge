import { fixedStepFrameCount, parseRenderSpecV3, ProntoSensorHostSchema, type ProntoSensorHost, type RenderSpecV3, type ResolvedFrameSchedule } from '@uniscenarios/scenario-model';
import type { PlaybackBundle } from '@uniscenarios/playback';

export const RENDER_INTENT_V1_SCHEMA = 'uniscenario.render-intent/v1' as const;
export const BROWSER_RENDER_REQUEST_V1_SCHEMA = 'uniscenario.browser-render-request/v1' as const;

export interface PortableRenderAsset {
  readonly assetId: string;
  readonly kind: 'map' | 'catalog' | 'texture' | 'mesh' | 'other';
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Portable immutable intent: no URLs, local paths, signed transfers, or module names. */
export interface BrowserRenderIntentV1 {
  readonly schema: typeof RENDER_INTENT_V1_SCHEMA;
  readonly intentId: string;
  readonly scenarioRevision: Readonly<Record<string, unknown>>;
  readonly sensorHost: ProntoSensorHost;
  readonly assets: readonly PortableRenderAsset[];
  readonly renderSpec: RenderSpecV3;
  readonly schedule: ResolvedFrameSchedule;
  readonly seed: number;
}

/** Internal browser-process request resolved from the worker's verified input map. */
export interface ResolvedBrowserRenderRequest {
  readonly schema: typeof BROWSER_RENDER_REQUEST_V1_SCHEMA;
  readonly intentSha256: string;
  readonly intent: BrowserRenderIntentV1;
  readonly mapManifestUrl: string;
  readonly playbackBundle: PlaybackBundle;
}

export function parseBrowserRenderIntent(value: unknown): BrowserRenderIntentV1 {
  if (!value || typeof value !== 'object') throw new Error('Browser render intent must be an object.');
  const input = value as Record<string, unknown>;
  if (input.schema !== RENDER_INTENT_V1_SCHEMA) throw new Error(`Browser engine requires ${RENDER_INTENT_V1_SCHEMA}.`);
  if (typeof input.intentId !== 'string' || input.intentId.length === 0) throw new Error('Browser render intent is missing intentId.');
  if (!input.scenarioRevision || typeof input.scenarioRevision !== 'object') throw new Error('Browser render intent is missing scenarioRevision.');
  if (!Number.isSafeInteger(input.seed) || (input.seed as number) < 0) throw new Error('Browser render intent has an invalid seed.');
  if (!Array.isArray(input.assets)) throw new Error('Browser render intent is missing assets.');
  const assets = input.assets.map((asset, index) => parseAsset(asset, index));
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) throw new Error('Browser render intent contains duplicate assetId values.');
  const sensorHost = ProntoSensorHostSchema.parse(input.sensorHost);
  const renderSpec = parseRenderSpecV3(input.renderSpec);
  return Object.freeze({
    schema: RENDER_INTENT_V1_SCHEMA,
    intentId: input.intentId,
    scenarioRevision: Object.freeze({ ...(input.scenarioRevision as Record<string, unknown>) }),
    assets: Object.freeze(assets),
    sensorHost,
    renderSpec,
    schedule: captureSchedule(renderSpec),
    seed: input.seed as number,
  });
}

export function parseResolvedBrowserRenderRequest(value: unknown): ResolvedBrowserRenderRequest {
  if (!value || typeof value !== 'object') throw new Error('Resolved browser render request must be an object.');
  const input = value as Record<string, unknown>;
  if (input.schema !== BROWSER_RENDER_REQUEST_V1_SCHEMA) throw new Error(`Resolved browser request must use ${BROWSER_RENDER_REQUEST_V1_SCHEMA}.`);
  if (typeof input.intentSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.intentSha256)) throw new Error('Resolved browser request has an invalid intentSha256.');
  if (typeof input.mapManifestUrl !== 'string' || input.mapManifestUrl.length === 0) throw new Error('Resolved browser request is missing mapManifestUrl.');
  if (!input.playbackBundle || typeof input.playbackBundle !== 'object') throw new Error('Resolved browser request is missing playbackBundle.');
  return Object.freeze({ schema: BROWSER_RENDER_REQUEST_V1_SCHEMA, intentSha256: input.intentSha256, intent: parseBrowserRenderIntent(input.intent), mapManifestUrl: input.mapManifestUrl, playbackBundle: input.playbackBundle as PlaybackBundle });
}

function parseAsset(value: unknown, index: number): PortableRenderAsset {
  if (!value || typeof value !== 'object') throw new Error(`Render asset ${index} must be an object.`);
  const asset = value as Record<string, unknown>;
  if (typeof asset.assetId !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(asset.assetId)) throw new Error(`Render asset ${index} has an invalid assetId.`);
  if (!['map', 'catalog', 'texture', 'mesh', 'other'].includes(String(asset.kind))) throw new Error(`Render asset ${asset.assetId} has an invalid kind.`);
  if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`Render asset ${asset.assetId} has an invalid sha256.`);
  if (!Number.isSafeInteger(asset.sizeBytes) || (asset.sizeBytes as number) < 0) throw new Error(`Render asset ${asset.assetId} has an invalid sizeBytes.`);
  return Object.freeze({ assetId: asset.assetId, kind: asset.kind, sha256: asset.sha256, sizeBytes: asset.sizeBytes }) as PortableRenderAsset;
}

function captureSchedule(renderSpec: RenderSpecV3): ResolvedFrameSchedule {
  const sourceRates = renderSpec.sources.flatMap((source) => {
    if (source.modality === 'lidar') return [source.attributes.rotationFrequencyHz];
    if (source.modality === 'radar') return [];
    return [source.attributes.fps];
  });
  const fps = renderSpec.video?.fps ?? (sourceRates.length === 0 ? 1 : Math.max(...sourceRates));
  const frameCount = fixedStepFrameCount(renderSpec.clip.startSeconds, renderSpec.clip.endSeconds, fps);
  return Object.freeze({
    startSeconds: renderSpec.clip.startSeconds,
    endSeconds: renderSpec.clip.endSeconds,
    fps,
    frameCount,
    timestampUnit: 'microseconds',
    firstTimestampUs: 0,
    endTimestampUs: Math.round(frameCount * 1_000_000 / fps),
  });
}
