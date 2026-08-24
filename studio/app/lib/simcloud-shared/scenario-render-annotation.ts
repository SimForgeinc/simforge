import { z } from "zod";

export const SCENARIO_RENDER_ANNOTATION_SCHEMA_VERSION =
  "simforge.scenario-render-annotation.v3" as const;

const rangeFields = {
  renderJobId: z.string().trim().min(1),
  artifactId: z.string().trim().min(1).nullable(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  observation: z.string().trim().min(1).max(10_000),
  action: z.string().trim().min(1).max(10_000),
  source: z.enum(["generated", "human_edited", "human"]).optional(),
  simStartS: z.number().finite().nonnegative().optional(),
  simEndS: z.number().finite().positive().optional(),
  primitive: z.string().trim().min(1).optional(),
  groundingRefs: z.record(z.unknown()).optional(),
  generatorSchema: z.string().trim().min(1).optional(),
};

function validMediaRange(value: {
  startMs: number;
  endMs: number;
}) {
  return value.endMs > value.startMs;
}

function validSimulationRange(value: {
  simStartS?: number;
  simEndS?: number;
}) {
  if ((value.simStartS == null) !== (value.simEndS == null)) return false;
  return (
    value.simStartS == null ||
    value.simEndS == null ||
    value.simEndS > value.simStartS
  );
}

const CurrentScenarioRenderAnnotationSchema = z
  .object({
    ...rangeFields,
    schemaVersion: z.literal(SCENARIO_RENDER_ANNOTATION_SCHEMA_VERSION),
    id: z.string().trim().min(1),
    scenarioId: z.string().trim().min(1),
    createdByUserId: z.string().trim().min(1),
    createdAt: z.string(),
    updatedAt: z.string(),
    source: z.enum(["generated", "human_edited", "human"]).default("human"),
  })
  .strict()
  .refine(validMediaRange, {
    message: "Annotation end must be after its start.",
    path: ["endMs"],
  })
  .refine(validSimulationRange, {
    message: "Simulation range must be complete and end after its start.",
    path: ["simEndS"],
  });

/**
 * Rows created under v2 did not persist provenance or simulation-time fields.
 * They remain valid human annotations and are normalized to the current wire
 * version at the schema boundary.
 */
export const ScenarioRenderAnnotationSchema = z.preprocess((value) => {
  if (
    value &&
    typeof value === "object" &&
    "schemaVersion" in value &&
    value.schemaVersion === "simforge.scenario-render-annotation.v2"
  ) {
    return {
      ...value,
      schemaVersion: SCENARIO_RENDER_ANNOTATION_SCHEMA_VERSION,
      source: "human",
    };
  }
  return value;
}, CurrentScenarioRenderAnnotationSchema);

export const ScenarioRenderAnnotationInputSchema = z
  .object(rangeFields)
  .strict()
  .refine(validMediaRange, {
    message: "Annotation end must be after its start.",
    path: ["endMs"],
  })
  .refine(validSimulationRange, {
    message: "Simulation range must be complete and end after its start.",
    path: ["simEndS"],
  });

export type ScenarioRenderAnnotation = z.infer<
  typeof ScenarioRenderAnnotationSchema
>;
export type ScenarioRenderAnnotationInput = z.infer<
  typeof ScenarioRenderAnnotationInputSchema
>;
