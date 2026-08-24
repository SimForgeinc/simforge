import { z } from 'zod';

import { CATALOG_ACTOR_CLASSES, PROP_CLASSES, PROP_TAGS } from './types';
import type { ExternalCatalogEntry } from './catalog.js';
import type { CatalogEntry } from './types';

/**
 * The catalog ships as `catalog.json` for consumers that do not want to pull in
 * three.js. This schema is what makes that file trustworthy: it is enforced
 * both when the JSON is generated and in the test suite.
 *
 * The schemas are module-private; `parseCatalog` is the only export, because
 * nothing outside this file ever needed the pieces.
 *
 * The component schemas remain private implementation details; consumers use
 * `parseCatalog` for a stable validation boundary.
 */
const dimsSchema = z.object({
  l: z.number().positive(),
  w: z.number().positive(),
  h: z.number().positive(),
});

const paramValueSchema = z.union([z.number(), z.string(), z.boolean()]);

const animationProfileSchema = z.strictObject({
  rig: z.enum(['wheeled', 'rotorcraft', 'quadruped', 'humanoid', 'avian']),
  clips: z.array(z.string().min(1)).min(2),
  idleClip: z.string().min(1),
  locomotionClip: z.string().min(1),
  hoverHeightM: z.number().nonnegative().optional(),
});

const externalModelSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('glb'),
    url: z.string().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    scale: z.number().positive().optional(),
    yawRad: z.number().finite().optional(),
    animated: z.boolean().optional(),
    clips: z.strictObject({
      idle: z.string().min(1).optional(),
      locomotion: z.string().min(1).optional(),
    }).optional(),
  }),
  z.strictObject({
    kind: z.literal('proxy'),
    tint: z.string().optional(),
  }),
]);

const catalogEntrySchema = z.object({
  id: z
    .string()
    .regex(/^[a-z_]+(?:\.[a-z0-9_]+)+$/, 'id must be a dot-delimited lowercase catalog path'),
  label: z.string().min(1),
  class: z.enum(PROP_CLASSES as unknown as [string, ...string[]]),
  actorClass: z.enum(CATALOG_ACTOR_CLASSES as unknown as [string, ...string[]]).optional(),
  compatibleActorClasses: z.array(z.enum(CATALOG_ACTOR_CLASSES as unknown as [string, ...string[]])).optional(),
  description: z.string().min(20),
  dims: dimsSchema,
  tags: z.array(z.enum(PROP_TAGS as unknown as [string, ...string[]])).min(1),
  defaultParams: z.record(z.string(), paramValueSchema),
  legacyAliasOf: z.string().regex(/^[a-z_]+(?:\.[a-z0-9_]+)+$/).optional(),
  animation: animationProfileSchema.optional(),
});

const externalCatalogEntrySchema = z.strictObject({
  id: z
    .string()
    .regex(/^(?:gallery|carla)\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/, 'invalid external catalog id'),
  label: z.string().min(1),
  class: z.enum(PROP_CLASSES as unknown as [string, ...string[]]),
  actorClass: z.enum(CATALOG_ACTOR_CLASSES as unknown as [string, ...string[]]).optional(),
  compatibleActorClasses: z.array(z.enum(CATALOG_ACTOR_CLASSES as unknown as [string, ...string[]])).optional(),
  description: z.string().min(1),
  dims: dimsSchema,
  tags: z.array(z.enum(PROP_TAGS as unknown as [string, ...string[]])),
  defaultParams: z.record(z.string(), paramValueSchema),
  animation: animationProfileSchema.optional(),
  model: externalModelSchema,
});

const externalCatalogSchema = z
  .array(externalCatalogEntrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate external catalog id: ${entry.id}` });
      }
      seen.add(entry.id);
      if (entry.class === 'vehicle' && entry.actorClass === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${entry.id} must declare actorClass so its driving physics do not depend on its id`,
        });
      }
      if (entry.actorClass !== undefined
        && entry.compatibleActorClasses?.some((candidate) => candidate === entry.actorClass)) {
        ctx.addIssue({
          code: 'custom',
          message: `${entry.id} repeats actorClass in compatibleActorClasses`,
        });
      }
    }
  });

export const catalogSchema = z
  .array(catalogEntrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    const allIds = new Set(entries.map((entry) => entry.id));
    for (const entry of entries) {
      if (seen.has(entry.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate catalog id: ${entry.id}` });
      }
      seen.add(entry.id);
      if (entry.legacyAliasOf && (!allIds.has(entry.legacyAliasOf) || entry.legacyAliasOf === entry.id)) {
        ctx.addIssue({ code: 'custom', message: `${entry.id} has invalid legacyAliasOf ${entry.legacyAliasOf}` });
      }
      if (!entry.id.startsWith(`${entry.class}.`)) {
        // `street` and `occluder` props are addressed by their own prefix, so
        // the id prefix must agree with the class it is filed under.
        ctx.addIssue({
          code: 'custom',
          message: `id ${entry.id} does not match class ${entry.class}`,
        });
      }
      if (entry.class === 'vehicle' && entry.actorClass === undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `${entry.id} must declare actorClass so its driving physics do not depend on its id`,
        });
      }
      if (entry.actorClass !== undefined
        && entry.compatibleActorClasses?.some((candidate) => candidate === entry.actorClass)) {
        ctx.addIssue({
          code: 'custom',
          message: `${entry.id} repeats actorClass in compatibleActorClasses`,
        });
      }
      const tagged = entry.tags.filter((tag) => tag.startsWith('occlusion:'));
      if (tagged.length !== 1) {
        ctx.addIssue({
          code: 'custom',
          message: `${entry.id} must carry exactly one occlusion:* tag`,
        });
      }
      if (['sidewalk_robot', 'drone', 'animal'].includes(entry.class)) {
        if (!entry.animation) {
          ctx.addIssue({ code: 'custom', message: `${entry.id} must declare an animation profile` });
        } else if (!entry.animation.clips.includes(entry.animation.idleClip)
          || !entry.animation.clips.includes(entry.animation.locomotionClip)) {
          ctx.addIssue({ code: 'custom', message: `${entry.id} animation clips must include idle and locomotion clips` });
        }
      }
      if (entry.class === 'drone' && entry.animation?.hoverHeightM === undefined) {
        ctx.addIssue({ code: 'custom', message: `${entry.id} must declare hoverHeightM` });
      }
    }
  });

/** Validate an arbitrary catalog payload (e.g. a loaded `catalog.json`). */
export function parseCatalog(data: unknown): CatalogEntry[] {
  return catalogSchema.parse(data) as unknown as CatalogEntry[];
}

/** Validate runtime-backed entries without applying bundled id/class-prefix rules. */
export function parseExternalCatalogEntries(data: unknown): ExternalCatalogEntry[] {
  return externalCatalogSchema.parse(data) as unknown as ExternalCatalogEntry[];
}
