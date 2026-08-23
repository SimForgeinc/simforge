import { z } from "zod";

export const GALLERY_ACTOR_CLASSES = [
  "static_object",
  "animal",
  "sidewalk_robot",
  "drone",
  "pedestrian",
  "vehicle",
] as const;

export const GalleryActorClassSchema = z.enum(GALLERY_ACTOR_CLASSES);
export type GalleryActorClass = z.infer<typeof GalleryActorClassSchema>;

/**
 * What an uploaded model *does* in a scenario.
 *
 * Nothing in a GLB reveals this, and the answer decides how the editor places
 * the asset and what it can be told to do afterwards — so the author states it
 * at upload time instead of inheriting a default that is wrong half the time:
 *
 * - `static` — a fixed body. Placed as a prop: collides and occludes, never
 *   moves, takes no route. Editor-core cannot unset a static-object entry.
 * - `ground` — a pedestrian, animal, or robot. Placed as a role on the surface
 *   and accepts a custom timed route.
 * - `flying` — an aerial actor, placed as a role that holds altitude.
 * - `road_vehicle` — a car, van, truck, or bus. Anchored to an OpenDRIVE lane
 *   exactly like the built-in vehicles, so it drives the road network instead of
 *   floating wherever it was dropped.
 */
export const GALLERY_MOTION_ARCHETYPES = [
  "static",
  "ground",
  "flying",
  "road_vehicle",
] as const;

export const GalleryMotionArchetypeSchema = z.enum(GALLERY_MOTION_ARCHETYPES);
export type GalleryMotionArchetype = z.infer<typeof GalleryMotionArchetypeSchema>;

/** Classes an author may pick inside each archetype; the first is its default. */
export const GALLERY_ARCHETYPE_ACTOR_CLASSES = {
  static: ["static_object"],
  ground: ["sidewalk_robot", "pedestrian", "animal"],
  flying: ["drone"],
  road_vehicle: ["vehicle"],
} as const satisfies Record<GalleryMotionArchetype, readonly GalleryActorClass[]>;

export function galleryMotionArchetypeFor(
  actorClass: GalleryActorClass,
): GalleryMotionArchetype {
  for (const archetype of GALLERY_MOTION_ARCHETYPES) {
    const classes: readonly GalleryActorClass[] = GALLERY_ARCHETYPE_ACTOR_CLASSES[archetype];
    if (classes.includes(actorClass)) return archetype;
  }
  return "static";
}

export const GalleryDimensionsSchema = z.strictObject({
  l: z.number().finite().positive().max(200),
  w: z.number().finite().positive().max(200),
  h: z.number().finite().positive().max(200),
});
export type GalleryDimensions = z.infer<typeof GalleryDimensionsSchema>;

/**
 * The dimension that fixes an actor's real-world scale, per class.
 *
 * A model file carries no unit: an FBX from a generator is as likely to be
 * 190 units long as 1.9, and the centimetre guess the importer applies is only
 * a guess. What is knowable is roughly how big the thing itself is - a car is
 * about 4.6 m long, an adult is about 1.75 m tall - so an author can say "this
 * is a car" and have the scale derived from that instead of typed in.
 *
 * `axis` names the defining dimension: length for anything that drives or
 * flies, height for anything that stands upright. `metres` is a mid-range real
 * example of the class, not a limit; it is a starting point the author can
 * override, and `static_object` has none because a bollard and a warehouse are
 * the same class.
 */
export const GALLERY_TYPICAL_SIZE = {
  vehicle: { axis: "l", metres: 4.6, example: "a mid-size car" },
  pedestrian: { axis: "h", metres: 1.75, example: "an adult" },
  sidewalk_robot: { axis: "l", metres: 0.9, example: "a delivery robot" },
  animal: { axis: "l", metres: 1.0, example: "a large dog" },
  drone: { axis: "l", metres: 0.6, example: "a quadcopter" },
} as const satisfies Partial<
  Record<GalleryActorClass, { axis: "l" | "w" | "h"; metres: number; example: string }>
>;

export type GalleryTypicalSizeClass = keyof typeof GALLERY_TYPICAL_SIZE;

export function galleryTypicalSizeFor(actorClass: GalleryActorClass) {
  return actorClass in GALLERY_TYPICAL_SIZE
    ? GALLERY_TYPICAL_SIZE[actorClass as GalleryTypicalSizeClass]
    : null;
}

/**
 * The scale that would put a model at its class's typical size.
 *
 * `current` is the model as imported, so this composes with whatever scale
 * produced it rather than assuming the source was unscaled.
 */
export function gallerySuggestedScale(
  actorClass: GalleryActorClass,
  current: GalleryDimensions,
  appliedScale: number,
): number | null {
  const typical = galleryTypicalSizeFor(actorClass);
  if (!typical || !Number.isFinite(appliedScale) || appliedScale <= 0) return null;
  const measured = current[typical.axis];
  if (!Number.isFinite(measured) || measured <= 0) return null;
  const scale = appliedScale * (typical.metres / measured);
  return Number.isFinite(scale) && scale > 0 ? scale : null;
}

export const GALLERY_SOURCE_FORMATS = [
  "glb",
  "gltf",
  "fbx",
  "obj",
  "stl",
  "dae",
  "ply",
  "usdz",
] as const;
export const GallerySourceFormatSchema = z.enum(GALLERY_SOURCE_FORMATS);
export type GallerySourceFormat = z.infer<typeof GallerySourceFormatSchema>;


const GalleryDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const GalleryTagSchema = z.string().max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const GalleryClipNameSchema = z.string().trim().min(1).max(200);

export const GalleryAssetSummarySchema = z.strictObject({
  assetId: z.string().uuid(),
  catalogId: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().min(1).max(120),
  description: z.string().nullable(),
  actorClass: GalleryActorClassSchema,
  tags: z.array(GalleryTagSchema),
  thumbnailUrl: z.string().url(),
  dims: GalleryDimensionsSchema,
  triangleCount: z.number().int().nonnegative(),
  byteLength: z.number().int().positive(),
  sourceFormat: GallerySourceFormatSchema,
  animated: z.boolean(),
  clips: z.array(GalleryClipNameSchema),
  idleClip: z.string().nullable(),
  locomotionClip: z.string().nullable(),
  createdAt: z.string().datetime(),
  createdByUserId: z.string().min(1),
  createdByName: z.string().nullable(),
  ownedByViewer: z.boolean(),
});
export type GalleryAssetSummary = z.infer<typeof GalleryAssetSummarySchema>;

export const GalleryCatalogEntryDtoSchema = z.strictObject({
  catalogId: z.string().min(1),
  label: z.string().min(1),
  actorClass: GalleryActorClassSchema,
  dims: GalleryDimensionsSchema,
  tags: z.array(GalleryTagSchema),
  model: z.strictObject({
    url: z.string().url(),
    contentHash: GalleryDigestSchema,
    animated: z.boolean(),
    clips: z
      .strictObject({
        idle: z.string().min(1).optional(),
        locomotion: z.string().min(1).optional(),
      })
      .optional(),
  }),
});
export type GalleryCatalogEntryDto = z.infer<typeof GalleryCatalogEntryDtoSchema>;

/**
 * What the API will accept for one uploaded model.
 *
 * The importer fits an oversized source to these numbers before it posts, so
 * they are exported rather than inlined: a limit that only the schema knows is
 * a limit the client discovers by being rejected.
 */
export const GALLERY_MAX_GLB_BYTES = 80 * 1024 * 1024;
export const GALLERY_MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const GALLERY_MAX_TRIANGLES = 1_500_000;

const DeclaredUploadSchema = (maxBytes: number) =>
  z.strictObject({
    sha256: GalleryDigestSchema,
    byteLength: z.number().int().positive().max(maxBytes),
  });

export const CreateGalleryUploadInputSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    actorClass: GalleryActorClassSchema,
    tags: z.array(GalleryTagSchema).max(12).optional(),
    sourceFormat: GallerySourceFormatSchema,
    glb: DeclaredUploadSchema(GALLERY_MAX_GLB_BYTES),
    thumbnail: DeclaredUploadSchema(GALLERY_MAX_THUMBNAIL_BYTES),
    dims: GalleryDimensionsSchema,
    triangleCount: z.number().int().nonnegative().max(GALLERY_MAX_TRIANGLES),
    animated: z.boolean(),
    clips: z.array(GalleryClipNameSchema).max(128),
    idleClip: GalleryClipNameSchema.optional(),
    locomotionClip: GalleryClipNameSchema.optional(),
  })
  .superRefine((value, context) => {
    for (const [field, clip] of [
      ["idleClip", value.idleClip],
      ["locomotionClip", value.locomotionClip],
    ] as const) {
      if (clip && !value.clips.includes(clip)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must name an uploaded clip.`,
        });
      }
    }
  });
export type CreateGalleryUploadInput = z.infer<typeof CreateGalleryUploadInputSchema>;

/**
 * The one field an author may correct after publishing.
 *
 * Geometry, dims and the catalog id are what scenarios bind to and stay
 * immutable; the title is routinely the source filename and is what every
 * gallery tile and readiness warning shows, so it has to be fixable in place
 * rather than by re-uploading under a new catalog id.
 */
export const RenameGalleryAssetInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
});
export type RenameGalleryAssetInput = z.infer<typeof RenameGalleryAssetInputSchema>;

export const ListGalleryAssetsQuerySchema = z.strictObject({
  q: z.string().trim().max(120).optional(),
  actorClass: GalleryActorClassSchema.optional(),
  mine: z.enum(["0", "1"]).optional(),
  cursor: z.string().trim().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});
export type ListGalleryAssetsQuery = z.infer<typeof ListGalleryAssetsQuerySchema>;

export const ResolveGalleryCatalogIdsInputSchema = z.strictObject({
  catalogIds: z.array(z.string().trim().min(1).max(128)).max(200),
});
export type ResolveGalleryCatalogIdsInput = z.infer<typeof ResolveGalleryCatalogIdsInputSchema>;

export const CompleteGalleryUploadInputSchema = z.strictObject({});
export const GalleryAssetIdSchema = z.string().uuid();
export const GalleryVersionIdSchema = z.string().uuid();
