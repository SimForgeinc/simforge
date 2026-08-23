/**
 * Map ingest contracts — the wire format between the browser upload dialog and
 * the publish routes.
 *
 * The division of labour is deliberate and load-bearing:
 *
 * - The **client** uploads only what a human authored: `map.xodr`, one GLB per
 *   layer, and a rendered thumbnail. It also runs a *preflight* over the XODR to
 *   fail fast with a real reason before megabytes move, but its preflight result
 *   is advisory — it never becomes an artifact.
 * - The **server** generates every derived byte at publish time: the city
 *   manifest, static semantics, the three road sidecars, the map-intel derived
 *   pair, and the roadway-consistency report.
 *
 * One implementation per artifact, therefore one source of truth for the digests
 * that the immutable closure binds. A browser that produced closure bytes would
 * be a second implementation of the same gzip and canonicalisation rules, and
 * the two would drift the first time one of them was upgraded.
 */
import { z } from "zod";

/** Layer ids the city manifest may carry. `road` is required by the derivative builder. */
export const MAP_LAYER_IDS = [
  "road",
  "sidewalk",
  "building",
  "buildings",
  "vegetation",
  "terrain",
  "furniture",
  "pole",
  "signage",
  "water",
  "other",
] as const;

export type MapLayerId = (typeof MAP_LAYER_IDS)[number];

/** Total authored GLB payload a browser tab is trusted to hash and upload. */
export const MAP_UPLOAD_MAX_GLB_BYTES = 256 * 1024 * 1024;

/** A single authored GLB layer. `layerId` comes from the file name. */
export const MapLayerInputSchema = z.object({
  layerId: z.enum(MAP_LAYER_IDS),
  fileName: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*\.glb$/, {
    message: "layer file names must be lowercase and end in .glb",
  }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().positive().max(MAP_UPLOAD_MAX_GLB_BYTES),
  triangleCount: z.number().int().nonnegative(),
});

export type MapLayerInput = z.infer<typeof MapLayerInputSchema>;

const BlobInputSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().positive(),
});

/**
 * Advisory client preflight. Recorded on the draft so a failed publish can be
 * explained after the fact, and compared against the server's own parse so a
 * mismatch surfaces instead of being silently preferred.
 */
export const MapPreflightSchema = z.object({
  laneCount: z.number().int().nonnegative(),
  junctionCount: z.number().int().nonnegative(),
  drivableLaneCount: z.number().int().nonnegative(),
  geometryKinds: z.array(z.string().min(1)).max(16),
  georeferenced: z.boolean(),
});

export type MapPreflight = z.infer<typeof MapPreflightSchema>;

export const CreateMapUploadInputSchema = z.object({
  label: z.string().min(3).max(120),
  locality: z.string().min(2).max(120),
  /**
   * Present only when an equivalent cooked CARLA map already exists. Absent
   * means the published version is browser-only, which is the normal case for an
   * uploaded map and is surfaced in the UI rather than hidden.
   */
  carlaMapName: z.string().min(1).max(120).nullable().default(null),
  xodr: BlobInputSchema,
  thumbnail: BlobInputSchema,
  layers: z.array(MapLayerInputSchema).min(1).max(32),
  preflight: MapPreflightSchema,
});

export type CreateMapUploadInput = z.infer<typeof CreateMapUploadInputSchema>;

export type MapUploadTarget = {
  /** Relative path inside the draft, e.g. `map.xodr` or `3d/road.glb`. */
  path: string;
  /** Absent when the content-addressed object is already stored. */
  url: string | null;
  headers: Record<string, string>;
};

export type CreateMapUploadResult = {
  draftId: string;
  uploads: MapUploadTarget[];
};

export const MapDraftIdSchema = z.string().regex(/^usmapdraft_[0-9a-f]{32}$/);

export type PublishedMapSummary = {
  mapVersionId: string;
  label: string;
  locality: string;
  sourceMapId: string;
  closureSha256: string;
  objectCount: number;
  byteLength: number;
  browserOnly: boolean;
  generated: {
    laneCount: number;
    junctionCount: number;
    locationCount: number;
    triangleCount: number;
    roadwayConsistencyVerdict: string;
  };
};

export type MapUploadDraftSummary = {
  draftId: string;
  label: string;
  locality: string;
  state: "pending" | "publishing" | "published" | "failed";
  failureReason: string | null;
  mapVersionId: string | null;
  createdAt: string;
};

/**
 * Closure paths the publisher materialises. The client never uploads these; the
 * list exists so the route, the tests and the UI agree on what "generated in the
 * background" actually means.
 *
 * The static-collider artifact itself is deliberately absent: it is named by its
 * own digest (`3d/variants/static-colliders/<sha256>.json`), so it cannot be a
 * constant. `3d/variants/manifest.json` is the fixed entry point that names it.
 */
export const SERVER_GENERATED_CLOSURE_PATHS = [
  "3d/manifest.json",
  "3d/semantics.json",
  "3d/variants/manifest.json",
  "topology-index.json.gz",
  "lane-polygons.geojson.gz",
  "signals.geojson.gz",
  "derived/topology-derived.json.gz",
  "derived/locations.json.gz",
  "derived/roadway-consistency.json.gz",
] as const;

/** Derive the layer id from an authored file name, or null when unsupported. */
export function layerIdFromFileName(fileName: string): MapLayerId | null {
  const stem = fileName.toLowerCase().replace(/\.glb$/, "");
  const candidate = stem.replace(/[^a-z]/g, "");
  return (MAP_LAYER_IDS as readonly string[]).includes(candidate)
    ? (candidate as MapLayerId)
    : null;
}

/**
 * A deferred optimization submits the COMPLETE intended closure of the new map
 * version, computed locally by the operator's toolchain. The server treats it as
 * a proposal: it must equal the published closure outside `3d/variants/`, and
 * every byte must actually be stored before anything is published.
 */
export const OptimizeMapVersionInputSchema = z.object({
  releaseSuffix: z.string().min(1).max(39),
  members: z
    .array(
      z.object({
        relativePath: z.string().min(1).max(256),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        byteLength: z.number().int().positive(),
        mediaType: z.string().min(1).max(128),
      }),
    )
    .min(1)
    .max(8192),
});

export type OptimizeMapVersionInput = z.infer<typeof OptimizeMapVersionInputSchema>;

export type MapOptimizationDelta = {
  added: string[];
  replaced: string[];
  unchanged: string[];
};

export type MapOptimizationPlan = {
  delta: MapOptimizationDelta;
  uploads: MapUploadTarget[];
};
