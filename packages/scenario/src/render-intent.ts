import { z } from 'zod';

import { RenderSpecV3Schema } from './render-spec.js';
import { EntityIdSchema } from './schema/v1.js';
import { Sha256 } from './sha256.js';

export const CANONICAL_RENDER_INTENT_V1_SCHEMA = 'simforge.render-intent/v1' as const;
export const LEGACY_RENDER_INTENT_V1_SCHEMA = 'uniscenario.render-intent/v1' as const;
/** Digest-preserving writer switch; keep false until canonical-document cutover. */
export const EMIT_CANONICAL_RENDER_INTENT_SCHEMA = false;
export const RENDER_INTENT_V1_SCHEMA = (
  EMIT_CANONICAL_RENDER_INTENT_SCHEMA
    ? CANONICAL_RENDER_INTENT_V1_SCHEMA
    : LEGACY_RENDER_INTENT_V1_SCHEMA
) as typeof CANONICAL_RENDER_INTENT_V1_SCHEMA | typeof LEGACY_RENDER_INTENT_V1_SCHEMA;
/**
 * A trailing presentation camera authored on the sensor host. It rides outside the
 * measurement rig so a render can ship a drive-along view without restating the rig counts.
 */
export const PRONTO_CHASE_CAMERA_SENSOR_ID = 'chase-cam-trailing' as const;

export const RenderSha256Schema = z.string().regex(
  /^[0-9a-f]{64}$/,
  'must be a lowercase hexadecimal SHA-256 digest',
);

export const RenderIntentIdSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  'must be a stable 1-128 character identifier',
);

export const RenderIntentAssetSchema = z.strictObject({
  assetId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/),
  kind: z.enum(['map', 'catalog', 'texture', 'mesh', 'other']),
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export const RenderIntentScenarioRevisionSchema = z.strictObject({
  revisionId: RenderIntentIdSchema,
  scenarioSha256: RenderSha256Schema,
  openScenario: z.strictObject({
    sha256: RenderSha256Schema,
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  map: z.strictObject({
    mapId: RenderIntentIdSchema,
    revisionId: RenderIntentIdSchema,
    sha256: RenderSha256Schema,
  }),
});

/**
 * Immutable catalog identity for one selected render source's authored host.
 * `sourceId` is the source's unique `outputName`; actor identity remains
 * explicit so sensors mounted on different actors can share one intent.
 *
 * `vehicleAsset` tolerates unknown keys because it may carry renderer-specific
 * catalog provenance, but host selection never depends on those extra keys.
 */
export const RenderSensorSourceHostSchema = z.strictObject({
  sourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  actorId: EntityIdSchema,
  vehicleAsset: z.looseObject({
    catalogAssetId: z.string().trim().min(1).max(200),
  }),
});

/**
 * Immutable, renderer-neutral input to every SimForge rendering backend.
 * Transfer URLs and lease data deliberately live in the worker-control claim,
 * so refreshing credentials never changes this document's content hash.
 */
export const RenderIntentV1Schema = z.strictObject({
  schema: z.union([
    z.literal(CANONICAL_RENDER_INTENT_V1_SCHEMA),
    z.literal(LEGACY_RENDER_INTENT_V1_SCHEMA),
  ]),
  intentId: RenderIntentIdSchema,
  executionPackage: z.strictObject({
    id: RenderIntentIdSchema,
    sourceInputDigest: RenderSha256Schema,
  }),
  scenarioRevision: RenderIntentScenarioRevisionSchema,
  sensorHosts: z.array(RenderSensorSourceHostSchema).min(1).max(64),
  renderSpec: RenderSpecV3Schema,
  assets: z.array(RenderIntentAssetSchema).max(4096),
  seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).check((ctx) => {
  const ids = new Set<string>();
  ctx.value.assets.forEach((asset, index) => {
    if (ids.has(asset.assetId)) {
      ctx.issues.push({
        code: 'custom',
        path: ['assets', index, 'assetId'],
        message: `duplicate assetId "${asset.assetId}"`,
        input: asset.assetId,
      });
    }
    ids.add(asset.assetId);
  });
  const sourcesById = new Map(ctx.value.renderSpec.sources.map((source) => [source.outputName, source]));
  const hostSourceIds = new Set<string>();
  ctx.value.sensorHosts.forEach((host, index) => {
    if (hostSourceIds.has(host.sourceId)) {
      ctx.issues.push({
        code: 'custom',
        path: ['sensorHosts', index, 'sourceId'],
        message: `duplicate sensor host sourceId "${host.sourceId}"`,
        input: host.sourceId,
      });
    }
    hostSourceIds.add(host.sourceId);
    const source = sourcesById.get(host.sourceId);
    if (!source) {
      ctx.issues.push({
        code: 'custom',
        path: ['sensorHosts', index, 'sourceId'],
        message: `sensor host sourceId "${host.sourceId}" does not name a render source`,
        input: host.sourceId,
      });
    } else if (source.actorId !== host.actorId) {
      ctx.issues.push({
        code: 'custom',
        path: ['sensorHosts', index, 'actorId'],
        message: `sensor host actorId must match render source "${host.sourceId}"`,
        input: host.actorId,
      });
    }
  });
  ctx.value.renderSpec.sources.forEach((source, index) => {
    if (!hostSourceIds.has(source.outputName)) {
      ctx.issues.push({
        code: 'custom',
        path: ['renderSpec', 'sources', index, 'outputName'],
        message: `render source "${source.outputName}" has no sensor host mapping`,
        input: source.outputName,
      });
    }
  });
});

export type RenderIntentAsset = z.infer<typeof RenderIntentAssetSchema>;
export type RenderIntentScenarioRevision = z.infer<typeof RenderIntentScenarioRevisionSchema>;
export type RenderSensorSourceHost = z.infer<typeof RenderSensorSourceHostSchema>;
export type RenderIntentV1 = z.infer<typeof RenderIntentV1Schema>;

export function parseRenderIntent(value: unknown): RenderIntentV1 {
  return RenderIntentV1Schema.parse(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON cannot contain non-finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot contain ${typeof value}`);
}

function compareSourceId(
  left: { outputName?: string; sourceId?: string },
  right: { outputName?: string; sourceId?: string },
): number {
  return (left.outputName ?? left.sourceId ?? '').localeCompare(right.outputName ?? right.sourceId ?? '');
}

export function canonicalizeRenderIntent(intent: RenderIntentV1): string {
  const parsed = RenderIntentV1Schema.parse(intent);
  return canonicalJson({
    ...parsed,
    sensorHosts: [...parsed.sensorHosts].sort(compareSourceId),
    renderSpec: {
      ...parsed.renderSpec,
      sources: [...parsed.renderSpec.sources].sort(compareSourceId),
    },
  });
}

/**
 * THE render-intent content hash. Every layer — submit, claim fencing, worker
 * verification, CLI — must call this one implementation; a second copy is how
 * `render_intent_digest_mismatch` incidents happen. Pure (no platform crypto)
 * so browser and server bundles hash identically.
 */
export function hashRenderIntent(intent: RenderIntentV1): string {
  return new Sha256()
    .update(new TextEncoder().encode(canonicalizeRenderIntent(intent)))
    .digestHex();
}
