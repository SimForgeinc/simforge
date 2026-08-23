import { z } from 'zod';

import type { RenderIntentV1 } from '@simforge/scenario';

export const ENGINE_CAPABILITIES_V1_SCHEMA = 'uniscenario.render-engine-capabilities/v1' as const;

export const EngineCapabilitySchema = z.enum([
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
  'artifact.trace',
  'artifact.annotations',
  'map.static_semantics',
  'control.native',
  'divergence.classified',
]);

export const EngineCapabilityDeclarationSchema = z.strictObject({
  schema: z.literal(ENGINE_CAPABILITIES_V1_SCHEMA),
  engineId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  engineVersion: z.string().min(1).max(128),
  backend: z.enum(['browser', 'carla', 'native']),
  protocolVersion: z.literal(1),
  capabilities: z.array(EngineCapabilitySchema).min(1).max(32),
  modalities: z.array(z.enum(['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'])).min(1).max(6),
  limits: z.strictObject({
    maxSimultaneousSensors: z.number().int().positive().max(1024),
    maxWidth: z.number().int().positive().max(32768),
    maxHeight: z.number().int().positive().max(32768),
    maxFramesPerSecond: z.number().int().positive().max(1000),
  }),
  requiresGpu: z.boolean(),
}).check((ctx) => {
  for (const [field, values] of [
    ['capabilities', ctx.value.capabilities],
    ['modalities', ctx.value.modalities],
  ] as const) {
    if (new Set(values).size !== values.length) {
      ctx.issues.push({ code: 'custom', path: [field], message: `${field} must not contain duplicates`, input: values });
    }
  }
});

export type EngineCapability = z.infer<typeof EngineCapabilitySchema>;
export type EngineCapabilityDeclaration = z.infer<typeof EngineCapabilityDeclarationSchema>;

export class UnsupportedRenderIntentError extends Error {
  readonly code = 'unsupported_render_intent';
  constructor(readonly reasons: readonly string[]) {
    super(`engine cannot execute render intent: ${reasons.join('; ')}`);
    this.name = 'UnsupportedRenderIntentError';
  }
}

export function assertEngineSupportsIntent(
  declaration: EngineCapabilityDeclaration,
  intent: RenderIntentV1,
): void {
  const reasons: string[] = [];
  const spec = intent.renderSpec;
  if (spec.sources.length > declaration.limits.maxSimultaneousSensors) {
    reasons.push(`sensor count ${spec.sources.length} exceeds ${declaration.limits.maxSimultaneousSensors}`);
  }
  const modalities = new Set(declaration.modalities);
  for (const source of spec.sources) {
    if (!modalities.has(source.modality)) reasons.push(`unsupported modality ${source.modality}`);
  }
  if (spec.video) {
    if (spec.video.width > declaration.limits.maxWidth || spec.video.height > declaration.limits.maxHeight) {
      reasons.push(`video dimensions ${spec.video.width}x${spec.video.height} exceed engine limits`);
    }
    if (spec.video.fps > declaration.limits.maxFramesPerSecond) {
      reasons.push(`video frame rate ${spec.video.fps} exceeds engine limit`);
    }
  }
  const capabilities = new Set<string>(declaration.capabilities);
  for (const required of spec.capabilityIntent.required) {
    if (!capabilities.has(required)) reasons.push(`missing capability ${required}`);
  }
  for (const artifact of spec.artifacts) {
    const capability = artifact === 'sensorArchive' ? 'artifact.sensor_archive' : `artifact.${artifact}`;
    if (!capabilities.has(capability)) reasons.push(`missing capability ${capability}`);
  }
  if (reasons.length > 0) throw new UnsupportedRenderIntentError([...new Set(reasons)]);
}
