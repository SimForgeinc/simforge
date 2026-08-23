import { z } from "zod";
import { GalleryActorClassSchema, GalleryDimensionsSchema } from "./contracts";
import type { GalleryActorClass } from "./contracts";

/**
 * Contracts for generating a gallery asset from reference photographs.
 *
 * The provider (Meshy) is asked for a model that is already inside the editor's
 * budgets rather than one we shrink afterwards. That is a deliberate split of
 * labour: the browser import path in `model-import.ts` exists because an
 * arbitrary author file can be a 200 MB non-indexed FBX, whereas a generated
 * model is produced to order. Measured on a four-photo Kia Carnival request with
 * the parameters below: 4.39 MB GLB, 29,706 triangles, one mesh, one material,
 * 5.11 x 1.80 x 2.21 m, no `emissiveFactor` — inside every limit in
 * `contracts.ts` without a single decimation pass on our side.
 */

/** Reference photographs of one object, taken from different angles. */
export const GALLERY_GENERATION_MIN_IMAGES = 1;
export const GALLERY_GENERATION_MAX_IMAGES = 4;
export const GALLERY_MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;

export const GALLERY_REFERENCE_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png"] as const;
export const GalleryReferenceImageMediaTypeSchema = z.enum(GALLERY_REFERENCE_IMAGE_MEDIA_TYPES);
export type GalleryReferenceImageMediaType = z.infer<typeof GalleryReferenceImageMediaTypeSchema>;

/** File extension used for a reference image object key. */
export const GALLERY_REFERENCE_IMAGE_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
} as const satisfies Record<GalleryReferenceImageMediaType, string>;

/**
 * Triangle budget requested per actor class.
 *
 * These are what the provider remeshes down to, not a cap we enforce after the
 * fact, so they are chosen for how much silhouette detail the class needs at
 * the distances it is viewed from: a vehicle fills the frame in a chase camera,
 * a drone is usually a speck. All of them are two orders of magnitude below
 * `GALLERY_MAX_TRIANGLES`, which keeps a city full of generated actors cheap.
 */
export const GALLERY_GENERATION_POLYCOUNT = {
  vehicle: 30_000,
  pedestrian: 24_000,
  animal: 20_000,
  static_object: 20_000,
  sidewalk_robot: 16_000,
  drone: 12_000,
} as const satisfies Record<GalleryActorClass, number>;

/**
 * A person or animal is generated in an A-pose so the skeleton-shaped classes
 * come back with limbs separated rather than fused to the torso. Vehicles and
 * props take no pose.
 */
export const GALLERY_GENERATION_POSE = {
  pedestrian: "a-pose",
  animal: "a-pose",
  vehicle: "",
  static_object: "",
  sidewalk_robot: "",
  drone: "",
} as const satisfies Record<GalleryActorClass, "a-pose" | "t-pose" | "">;

export function galleryGenerationPolycountFor(actorClass: GalleryActorClass): number {
  return GALLERY_GENERATION_POLYCOUNT[actorClass];
}

/**
 * Lifecycle of one generation.
 *
 * `draft` exists because reference images are uploaded straight to object
 * storage with presigned PUTs, exactly like model uploads: the row has to exist
 * to own the keys before the bytes arrive. `generating` is the provider's phase,
 * `importing` is ours (download, measure, thumbnail, publish), and only then
 * does a gallery asset exist.
 */
export const GALLERY_GENERATION_STATES = [
  "draft",
  "generating",
  "importing",
  "ready",
  "failed",
  "cancelled",
] as const;
export const GalleryGenerationStateSchema = z.enum(GALLERY_GENERATION_STATES);
export type GalleryGenerationState = z.infer<typeof GalleryGenerationStateSchema>;

export const GALLERY_GENERATION_TERMINAL_STATES: readonly GalleryGenerationState[] = [
  "ready",
  "failed",
  "cancelled",
];

export function isGalleryGenerationTerminal(state: GalleryGenerationState): boolean {
  return GALLERY_GENERATION_TERMINAL_STATES.includes(state);
}

/** How many generations one user may start per rolling hour. */
export const GALLERY_GENERATIONS_PER_HOUR = 12;

/**
 * Credit floor below which we stop accepting work.
 *
 * The provider bills per task against one shared account, so an empty balance
 * is a platform outage rather than one user's problem. Refusing early turns it
 * into an explainable error instead of a task that fails halfway.
 */
export const GALLERY_GENERATION_MIN_CREDITS = 40;

const DeclaredReferenceImageSchema = z.strictObject({
  mediaType: GalleryReferenceImageMediaTypeSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().positive().max(GALLERY_MAX_REFERENCE_IMAGE_BYTES),
});

/**
 * Step 1: reserve a generation and its reference-image upload targets.
 *
 * The provider's own guidance is that the first image is the primary (front)
 * view, so image order is preserved end to end rather than sorted.
 */
export const CreateGalleryGenerationInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  actorClass: GalleryActorClassSchema,
  /**
   * Optional text guidance for the texture phase. Geometry follows the photos;
   * this only steers surface appearance (`"matte black paint, no decals"`).
   */
  texturePrompt: z.string().trim().max(600).optional(),
  images: z
    .array(DeclaredReferenceImageSchema)
    .min(GALLERY_GENERATION_MIN_IMAGES)
    .max(GALLERY_GENERATION_MAX_IMAGES),
});
export type CreateGalleryGenerationInput = z.infer<typeof CreateGalleryGenerationInputSchema>;

/** Step 2 body: the images are in storage, start the provider task. */
export const StartGalleryGenerationInputSchema = z.strictObject({});

export const GalleryGenerationIdSchema = z.string().uuid();

/**
 * What a client may see about a generation.
 *
 * `providerTaskId` is deliberately absent: it is only useful for talking to the
 * provider directly, which only the server does.
 */
export const GalleryGenerationSummarySchema = z.strictObject({
  generationId: z.string().uuid(),
  state: GalleryGenerationStateSchema,
  title: z.string(),
  actorClass: GalleryActorClassSchema,
  /** 0-100 while generating; 100 once the model is in hand. */
  progress: z.number().int().min(0).max(100),
  imageCount: z.number().int().min(GALLERY_GENERATION_MIN_IMAGES).max(GALLERY_GENERATION_MAX_IMAGES),
  /** Set once published; the asset then behaves like any uploaded asset. */
  assetId: z.string().uuid().nullable(),
  catalogId: z.string().nullable(),
  /** Populated from the finished model, so absent until `importing` completes. */
  dims: GalleryDimensionsSchema.nullable(),
  triangleCount: z.number().int().nonnegative().nullable(),
  /** Provider preview, available before our own thumbnail exists. */
  previewUrl: z.string().url().nullable(),
  /**
   * A stable `GALLERY_GENERATION_FAILURES` key, never provider text and never a
   * finished sentence. Clients render it through
   * `galleryGenerationFailureMessage`, which keeps the wording in one place and
   * leaves room to translate it; the raw provider error stays server-side in
   * `generation_jobs.provider_error` for operators.
   */
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  createdByUserId: z.string(),
  createdByName: z.string().nullable(),
  ownedByViewer: z.boolean(),
});
export type GalleryGenerationSummary = z.infer<typeof GalleryGenerationSummarySchema>;

export const ListGalleryGenerationsQuerySchema = z.strictObject({
  /** Only a user's own generations are listed; unfinished work is not a gallery entry yet. */
  limit: z.coerce.number().int().min(1).max(24).default(8),
});
export type ListGalleryGenerationsQuery = z.infer<typeof ListGalleryGenerationsQuerySchema>;

/**
 * Reasons a generation can fail that we state plainly to the author.
 *
 * Anything else becomes `provider_failed`, because provider error text can
 * contain request internals and is not written for end users.
 */
export const GALLERY_GENERATION_FAILURES = {
  provider_failed: "Generation failed. The reference photos may not show a single clear object.",
  provider_unavailable: "The generation service is unavailable. Try again shortly.",
  insufficient_credits: "The generation service is out of credits. Ask an administrator to top it up.",
  moderation_rejected: "The reference photos were rejected by content screening.",
  model_too_large: "The generated model came back larger than the gallery allows.",
  import_failed: "The generated model could not be read.",
  images_missing: "The reference photos were not uploaded.",
  timed_out: "Generation took too long and was abandoned.",
} as const;
export type GalleryGenerationFailure = keyof typeof GALLERY_GENERATION_FAILURES;

export function galleryGenerationFailureMessage(failure: string): string {
  return failure in GALLERY_GENERATION_FAILURES
    ? GALLERY_GENERATION_FAILURES[failure as GalleryGenerationFailure]
    : GALLERY_GENERATION_FAILURES.provider_failed;
}
