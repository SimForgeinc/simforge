import { z } from "zod";

import type { Manifest } from "./types";

// ---------------------------------------------------------------------------
// v1.2.0 schema
// `shadowLightmap` (scene-level) and per-tile `shadowLightmaps` are read as
// `unknown` so the parser tolerates pipeline shape changes without consuming
// them. See PRD `.scratch/3d-viewer-belmont-pipeline/PRD.md`.
// ---------------------------------------------------------------------------

const aabbSchema = z.object({
  min: z.tuple([z.number(), z.number(), z.number()]),
  max: z.tuple([z.number(), z.number(), z.number()]),
});

const lodLevelInfoSchema = z.object({
  level: z.number(),
  file: z.string(),
  triangles: z.number(),
  fileSize: z.number(),
  geometricError: z.number(),
});

const tileDescriptorSchema = z.object({
  id: z.string(),
  gridX: z.number(),
  gridZ: z.number(),
  bounds: aabbSchema,
  lods: z.array(lodLevelInfoSchema),
  shadowLightmaps: z.unknown().optional(),
});

const vegetationPrototypeSchema = z.object({
  meshName: z.string(),
  triangles: z.number(),
  instanceCount: z.number(),
});

const vegetationTileSchema = tileDescriptorSchema.extend({
  prototypes: z.array(vegetationPrototypeSchema),
  instanceFile: z.string(),
});

const staticLayerSchema = z.object({
  id: z.string(),
  file: z.string(),
  triangles: z.number(),
  fileSize: z.number(),
});

const sceneInfoSchema = z.object({
  bounds: aabbSchema,
  totalTriangles: z.number(),
  gridDimensions: z.tuple([z.number(), z.number()]),
  cellSize: z.tuple([z.number(), z.number()]),
  origin: z.tuple([z.number(), z.number(), z.number()]),
  lodLevels: z.number(),
  coordinateSystem: z.enum(["y-up", "z-up"]),
});

const staticSemanticsReferenceSchema = z.object({
  file: z.string().min(1),
});

const manifestSchema = z.object({
  version: z.string(),
  generator: z.string(),
  created: z.string(),
  scene: sceneInfoSchema,
  tiles: z.array(tileDescriptorSchema),
  staticLayers: z.array(staticLayerSchema),
  vegetationTiles: z.array(vegetationTileSchema).optional(),
  shadowLightmap: z.unknown().optional(),
  staticSemantics: staticSemanticsReferenceSchema.optional(),
});

function formatIssue(issue: z.ZodIssue): string {
  const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
  return `${path}: ${issue.message}`;
}

/**
 * Parse a raw manifest object into a typed `Manifest`.
 *
 * Accepts any v1.x manifest. Rejects v0.x and v2.x+ with an error citing the
 * version. Validation errors cite the offending field by path. The parser is
 * pure: same input always produces the same output or thrown error, and never
 * mutates its input.
 */
export function parseManifest(raw: unknown): Manifest {
  // Version gate runs first so version-mismatch errors are crisp instead of
  // appearing as a cascade of shape errors.
  const versionShape = z.object({ version: z.string() }).safeParse(raw);
  if (versionShape.success) {
    const v = versionShape.data.version;
    const major = v.split(".")[0];
    if (major !== "1") {
      throw new Error(
        `Manifest version ${v} is unsupported; this viewer accepts manifest 1.x only.`,
      );
    }
  }

  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(formatIssue).join("; ");
    throw new Error(`Manifest validation failed — ${issues}`);
  }

  return parsed.data as unknown as Manifest;
}
