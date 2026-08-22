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
});

export type RenderWorkerConfig = z.infer<typeof RenderWorkerConfigSchema>;

export async function loadRenderWorkerConfig(path: string): Promise<RenderWorkerConfig> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  return RenderWorkerConfigSchema.parse(raw);
}
