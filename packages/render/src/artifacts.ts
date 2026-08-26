import { z } from 'zod';

import { RenderSha256Schema } from '@simforge-oss/scenario';

export const ARTIFACT_MANIFEST_V1_SCHEMA = 'uniscenario.render-artifact-manifest/v1' as const;

export const ArtifactRoleSchema = z.enum([
  'video',
  'frames',
  'sensorArchive',
  'manifest',
  'trace',
  'annotations',
  'diagnostics',
]);
export const ArtifactModalitySchema = z.enum([
  'rgb',
  'depth',
  'semantic',
  'instance',
  'lidar',
  'radar',
]);

/** Stable tuple identity. Nullable fields keep JSON and database keys unambiguous. */
export const ArtifactIdentitySchema = z.strictObject({
  role: ArtifactRoleSchema,
  actorId: z.string().min(1).max(128).nullable(),
  sensorId: z.string().min(1).max(128).nullable(),
  modality: ArtifactModalitySchema.nullable(),
}).check((ctx) => {
  const sensorFields = [ctx.value.actorId, ctx.value.sensorId, ctx.value.modality];
  const sensorScoped = ctx.value.role === 'video'
    || ctx.value.role === 'frames'
    || ctx.value.role === 'sensorArchive';
  if (sensorScoped && sensorFields.some((field) => field === null)) {
    ctx.issues.push({ code: 'custom', message: 'sensor-scoped artifacts require actorId, sensorId, and modality', input: ctx.value });
  }
  if (!sensorScoped && sensorFields.some((field) => field !== null)) {
    ctx.issues.push({ code: 'custom', message: 'global artifact identity fields must be null', input: ctx.value });
  }
});

export const ArtifactManifestEntrySchema = z.strictObject({
  identity: ArtifactIdentitySchema,
  relativePath: z.string().min(1).max(1024).refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), {
    message: 'must be a safe workspace-relative path',
  }),
  sha256: RenderSha256Schema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(1).max(255),
  frameCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
});

export const RenderArtifactManifestSchema = z.strictObject({
  schema: z.literal(ARTIFACT_MANIFEST_V1_SCHEMA),
  intentSha256: RenderSha256Schema,
  engine: z.strictObject({
    engineId: z.string().min(1).max(128),
    engineVersion: z.string().min(1).max(128),
    backend: z.enum(['browser', 'carla', 'native']),
  }),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  artifacts: z.array(ArtifactManifestEntrySchema).max(4096),
  warnings: z.array(z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
  })).max(1024),
}).check((ctx) => {
  const identities = new Set<string>();
  ctx.value.artifacts.forEach((artifact, index) => {
    const key = artifactIdentityKey(artifact.identity);
    if (identities.has(key)) {
      ctx.issues.push({ code: 'custom', path: ['artifacts', index, 'identity'], message: 'duplicate artifact identity', input: artifact.identity });
    }
    identities.add(key);
  });
});

export type ArtifactRole = z.infer<typeof ArtifactRoleSchema>;
export type ArtifactModality = z.infer<typeof ArtifactModalitySchema>;
export type ArtifactIdentity = z.infer<typeof ArtifactIdentitySchema>;
export type ArtifactManifestEntry = z.infer<typeof ArtifactManifestEntrySchema>;
export type RenderArtifactManifest = z.infer<typeof RenderArtifactManifestSchema>;

export function artifactIdentityKey(identity: ArtifactIdentity): string {
  return [identity.role, identity.actorId ?? '', identity.sensorId ?? '', identity.modality ?? ''].join('\u0000');
}
