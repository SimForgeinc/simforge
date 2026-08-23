import { parseRenderSpecV3, RenderSensorHostSchema, type RenderSensorHost, type RenderSpecV3, type ResolvedFrameSchedule } from '@simforge/scenario';
import type { PlaybackBundle } from '@simforge/playback';

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
  readonly engine: 'browser';
  readonly sensorHost: RenderSensorHost;
  readonly assets: readonly PortableRenderAsset[];
  readonly renderSpec: RenderSpecV3;
  readonly schedule: ResolvedFrameSchedule;
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
  if (input.schema !== RENDER_INTENT_V1_SCHEMA || input.engine !== 'browser') throw new Error(`Browser engine requires ${RENDER_INTENT_V1_SCHEMA} with engine "browser".`);
  if (!Array.isArray(input.assets)) throw new Error('Browser render intent is missing assets.');
  const assets = input.assets.map((asset, index) => parseAsset(asset, index));
  if (new Set(assets.map((asset) => asset.assetId)).size !== assets.length) throw new Error('Browser render intent contains duplicate assetId values.');
  const sensorHost = RenderSensorHostSchema.parse(input.sensorHost);
  return Object.freeze({ schema: RENDER_INTENT_V1_SCHEMA, engine: 'browser', assets: Object.freeze(assets), sensorHost, renderSpec: parseRenderSpecV3(input.renderSpec), schedule: parseSchedule(input.schedule) });
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

function parseSchedule(value: unknown): ResolvedFrameSchedule {
  if (!value || typeof value !== 'object') throw new Error('Browser render intent is missing its fixed-step schedule.');
  const schedule = value as Record<string, unknown>;
  for (const key of ['startSeconds', 'endSeconds', 'fps'] as const) if (typeof schedule[key] !== 'number' || !Number.isFinite(schedule[key]) || (schedule[key] as number) < 0) throw new Error(`Capture schedule ${key} must be a non-negative finite number.`);
  for (const key of ['frameCount', 'firstTimestampUs', 'endTimestampUs'] as const) if (!Number.isSafeInteger(schedule[key]) || (schedule[key] as number) < 0) throw new Error(`Capture schedule ${key} must be a non-negative safe integer.`);
  if (schedule.timestampUnit !== 'microseconds' || schedule.firstTimestampUs !== 0 || (schedule.fps as number) <= 0 || (schedule.frameCount as number) <= 0 || (schedule.endSeconds as number) <= (schedule.startSeconds as number) || (schedule.endTimestampUs as number) <= 0) throw new Error('Capture schedule bounds are invalid.');
  return Object.freeze({ ...schedule }) as ResolvedFrameSchedule;
}
