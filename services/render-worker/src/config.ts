import { readFile } from 'node:fs/promises';

import { z } from 'zod';

const ModuleOptionsSchema = z.record(z.string(), z.unknown());
const ModuleSpecifierSchema = z.string().min(1).max(2048);

const HttpControlConfigSchema = z.strictObject({
  kind: z.literal('http'),
  baseUrl: z.url(),
  tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
  headers: z.record(z.string().min(1), z.string()).default({}),
  requestTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
});
const ModuleControlConfigSchema = z.strictObject({
  kind: z.literal('module'),
  module: ModuleSpecifierSchema,
  options: ModuleOptionsSchema.default({}),
});

/**
 * Images-last staged validation lane. A worker carrying this block is a
 * temporary "-staged" identity that runs unreleased code (mounted wheel/dist)
 * on top of a baked chassis image. The lane is fenced off from production
 * claims in both directions by the control plane's own compatibility checks:
 * - `fenceCapability` is added to the engine's declared capabilities; probe
 *   render specs list it in `capabilityIntent.required`, which no permanent
 *   fleet worker declares, so the fleet can never claim a staged probe.
 * - `maxWidth`/`maxHeight` clamp the declared limits so every production
 *   render (>=540p sources) is dimension-incompatible with this worker and
 *   can never be claimed by it. Probe specs must fit inside the clamp.
 * - `engineVersion` (typically the staged source commit SHA) overrides the
 *   engine's version string so worker_nodes provenance records exactly which
 *   unreleased code ran.
 */
const ValidationLaneConfigSchema = z.strictObject({
  fenceCapability: z.string().min(1).max(64),
  maxWidth: z.number().int().min(16).max(1024),
  maxHeight: z.number().int().min(16).max(1024),
  engineVersion: z.string().min(1).max(128).optional(),
});
export const RenderWorkerConfigSchema = z.strictObject({
  workerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  instanceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
  engine: z.union([
    z.strictObject({
      id: z.enum(['browser', 'carla', 'native']),
      options: ModuleOptionsSchema.default({}),
    }),
    z.strictObject({
      module: ModuleSpecifierSchema,
      options: ModuleOptionsSchema.default({}),
    }),
  ]),
  control: z.discriminatedUnion('kind', [HttpControlConfigSchema, ModuleControlConfigSchema]),
  labels: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/), z.string().max(256)).default({}),
  scratchDir: z.string().min(1),
  cacheDir: z.string().min(1),
  gpuLockPath: z.string().min(1),
  /** Parallel artifact hash+reserve+upload lanes per completed job. */
  uploadConcurrency: z.number().int().min(1).max(8).default(3),
  pollIntervalMs: z.number().int().min(100).max(300_000).default(5_000),
  retries: z.strictObject({
    maxAttempts: z.number().int().min(1).max(20).default(4),
    initialDelayMs: z.number().int().min(10).max(60_000).default(500),
    maxDelayMs: z.number().int().min(10).max(300_000).default(10_000),
  }).prefault({}),
  health: z.strictObject({
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().min(1).max(65535).default(8080),
  }).prefault({}),
  validationLane: ValidationLaneConfigSchema.optional(),
}).check((ctx) => {
  if (!ctx.value.validationLane) return;
  for (const field of ['workerId', 'instanceId'] as const) {
    if (!ctx.value[field].endsWith('-staged')) {
      ctx.issues.push({
        code: 'custom',
        path: [field],
        message: `${field} must end with "-staged" when validationLane is configured so worker provenance is always distinguishable`,
        input: ctx.value[field],
      });
    }
  }
});

export type RenderWorkerConfig = z.infer<typeof RenderWorkerConfigSchema>;

export async function loadRenderWorkerConfig(path: string): Promise<RenderWorkerConfig> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return RenderWorkerConfigSchema.parse(raw);
}
