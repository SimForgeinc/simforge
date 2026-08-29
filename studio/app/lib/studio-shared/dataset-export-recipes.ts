import { z } from "zod";
import type { DatasetExportSourceFilter, ExportFormat } from "./dataset";
import type { DatasetExportRequestedOutput } from "./dataset-export-requested-outputs";
import { ALPAMAYO_SFT_V3_RECIPE_ID } from "./alpamayo-sft-v3";

export const DatasetExportRecipeIdSchema = z.enum([
  "review_bundle",
  "native_full",
  "sdg_odvg",
  "alpamayo_sft",
  ALPAMAYO_SFT_V3_RECIPE_ID,
]);
export type DatasetExportRecipeId = z.infer<typeof DatasetExportRecipeIdSchema>;
export type DatasetExportRecipeExecutionMode = "worker_queue" | "operator_package_go";

export type DatasetExportRecipeDefinition = {
  id: DatasetExportRecipeId;
  format: ExportFormat;
  name: string;
  description: string;
  executionMode: DatasetExportRecipeExecutionMode;
  queueBlockMessage?: string;
  defaultRequestedOutputs: DatasetExportRequestedOutput[];
  defaultSourceFilter: DatasetExportSourceFilter | null;
  includeScenarioJson: boolean;
};

const zipPackage: DatasetExportRequestedOutput[] = [
  { kind: "package", delivery: "zip", optional: false, allowPartial: false },
];

const immutablePrefixManifest: DatasetExportRequestedOutput[] = [
  { kind: "prefix", delivery: "prefix", optional: false, allowPartial: false },
  { kind: "manifest", delivery: "manifest", optional: false, allowPartial: false },
];

export const DATASET_EXPORT_RECIPES: DatasetExportRecipeDefinition[] = [
  {
    id: "review_bundle",
    format: "REVIEW_BUNDLE",
    name: "Review Bundle",
    description:
      "MP4-first package with generated scenario JSON files for review and sharing.",
    executionMode: "worker_queue",
    defaultRequestedOutputs: zipPackage,
    defaultSourceFilter: {
      artifactClasses: [
        "render_video",
        "rgb_bboxed_video",
        "edge_video",
        "cosmos_video",
        "cosmos_bboxed_video",
        "video_annotations",
        "video_poster",
        "recording",
      ],
    },
    includeScenarioJson: true,
  },
  {
    id: "native_full",
    format: "NATIVE_FULL",
    name: "Native Full Fidelity",
    description:
      "Complete SimForge-native archive with all matched artifacts and scenario JSON.",
    executionMode: "worker_queue",
    defaultRequestedOutputs: zipPackage,
    defaultSourceFilter: null,
    includeScenarioJson: true,
  },
  {
    id: "sdg_odvg",
    format: "ODVG",
    name: "SDG ODVG",
    description: "Training-oriented ODVG labels and source artifacts.",
    executionMode: "worker_queue",
    defaultRequestedOutputs: zipPackage,
    defaultSourceFilter: null,
    includeScenarioJson: false,
  },
  {
    id: "alpamayo_sft",
    format: "ALPAMAYO_SFT",
    name: "Alpamayo SFT",
    description:
      "PAI-compatible Alpamayo supervised fine-tuning package for rendered four-camera driving clips.",
    executionMode: "worker_queue",
    defaultRequestedOutputs: zipPackage,
    defaultSourceFilter: {
      artifactClasses: [
        "render_video",
        "video_annotations",
        "video_poster",
        "calibration_bundle",
        "metadata",
        "derived",
      ],
    },
    includeScenarioJson: true,
  },
  {
    id: ALPAMAYO_SFT_V3_RECIPE_ID,
    format: "ALPAMAYO_SFT",
    name: "Alpamayo Stage-1 Nav SFT",
    description:
      "Immutable prefix plus manifest for Alpamayo 1.5 Stage-1 navigation SFT packages.",
    executionMode: "operator_package_go",
    queueBlockMessage:
      "alpamayo_sft_v3 packages are materialized by the A100 Package-Go workflow; publish an immutable prefix and manifest from the Package-Go script instead of queueing the unified CPU runner.",
    defaultRequestedOutputs: immutablePrefixManifest,
    defaultSourceFilter: {
      artifactClasses: [
        "render_video",
        "render_manifest",
        "metadata",
        "derived",
      ],
    },
    includeScenarioJson: true,
  },
];

function cloneRequestedOutputs(outputs: DatasetExportRequestedOutput[]) {
  return outputs.map((output) => ({ ...output }));
}

function cloneSourceFilter(filter: DatasetExportSourceFilter | null) {
  if (!filter) return null;
  return {
    ...filter,
    artifactIds: filter.artifactIds ? [...filter.artifactIds] : undefined,
    scenarioIds: filter.scenarioIds ? [...filter.scenarioIds] : undefined,
    simulationIds: filter.simulationIds ? [...filter.simulationIds] : undefined,
    sensorIds: filter.sensorIds ? [...filter.sensorIds] : undefined,
    storageScopes: filter.storageScopes ? [...filter.storageScopes] : undefined,
    sensorCategories: filter.sensorCategories ? [...filter.sensorCategories] : undefined,
    outputModalities: filter.outputModalities ? [...filter.outputModalities] : undefined,
    artifactClasses: filter.artifactClasses ? [...filter.artifactClasses] : undefined,
    kinds: filter.kinds ? [...filter.kinds] : undefined,
  };
}

export function resolveDatasetExportRecipe(
  format: ExportFormat,
  recipeId?: string | null,
): DatasetExportRecipeDefinition {
  const explicit = DATASET_EXPORT_RECIPES.find((recipe) => recipe.id === recipeId);
  if (explicit) return explicit;
  const byFormat = DATASET_EXPORT_RECIPES.find((recipe) => recipe.format === format);
  if (!byFormat) {
    throw new Error(`No dataset export recipe registered for format ${format}`);
  }
  return byFormat;
}

export function isDatasetExportRecipeQueueable(
  recipe: DatasetExportRecipeDefinition,
): boolean {
  return recipe.executionMode === "worker_queue";
}

export function datasetExportRecipeQueueBlockMessage(
  recipe: DatasetExportRecipeDefinition,
): string {
  return (
    recipe.queueBlockMessage ??
    `${recipe.name} exports use ${recipe.executionMode} execution and cannot be queued through the unified CPU runner.`
  );
}

export function assertDatasetExportRecipeQueueable(
  recipe: DatasetExportRecipeDefinition,
): void {
  if (isDatasetExportRecipeQueueable(recipe)) return;
  throw new Error(datasetExportRecipeQueueBlockMessage(recipe));
}

export function defaultDatasetExportRequestedOutputs(
  format: ExportFormat,
  recipeId?: string | null,
): DatasetExportRequestedOutput[] {
  return cloneRequestedOutputs(
    resolveDatasetExportRecipe(format, recipeId).defaultRequestedOutputs,
  );
}

export function defaultDatasetExportSourceFilter(
  format: ExportFormat,
  recipeId?: string | null,
): DatasetExportSourceFilter | null {
  return cloneSourceFilter(
    resolveDatasetExportRecipe(format, recipeId).defaultSourceFilter,
  );
}

export function mergeDatasetExportSourceFilters(
  base: DatasetExportSourceFilter | null | undefined,
  override: DatasetExportSourceFilter | null | undefined,
): DatasetExportSourceFilter | null {
  if (!base && !override) return null;
  if (!base) return cloneSourceFilter(override ?? null);
  if (!override) return cloneSourceFilter(base);
  const merged: DatasetExportSourceFilter = { ...base };
  for (const [key, value] of Object.entries(override) as Array<
    [keyof DatasetExportSourceFilter, DatasetExportSourceFilter[keyof DatasetExportSourceFilter]]
  >) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return cloneSourceFilter(merged);
}
