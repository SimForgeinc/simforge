import { describe, expect, it } from "vitest";
import { ALPAMAYO_SFT_V3_RECIPE_ID } from "../alpamayo-sft-v3";
import {
  DATASET_EXPORT_RECIPES,
  assertDatasetExportRecipeQueueable,
  defaultDatasetExportRequestedOutputs,
  defaultDatasetExportSourceFilter,
  datasetExportRecipeQueueBlockMessage,
  isDatasetExportRecipeQueueable,
  mergeDatasetExportSourceFilters,
  resolveDatasetExportRecipe,
} from "../dataset-export-recipes";

describe("dataset export recipes", () => {
  it("registers practical export recipes and resolves legacy Alpamayo by default", () => {
    expect(DATASET_EXPORT_RECIPES.map((recipe) => recipe.format)).toEqual([
      "REVIEW_BUNDLE",
      "NATIVE_FULL",
      "ODVG",
      "ALPAMAYO_SFT",
      "ALPAMAYO_SFT",
    ]);
    expect(resolveDatasetExportRecipe("REVIEW_BUNDLE").id).toBe("review_bundle");
    expect(resolveDatasetExportRecipe("NATIVE_FULL").id).toBe("native_full");
    expect(resolveDatasetExportRecipe("ODVG").id).toBe("sdg_odvg");
    expect(resolveDatasetExportRecipe("ALPAMAYO_SFT").id).toBe("alpamayo_sft");
    expect(resolveDatasetExportRecipe("ALPAMAYO_SFT", ALPAMAYO_SFT_V3_RECIPE_ID).id).toBe(
      ALPAMAYO_SFT_V3_RECIPE_ID,
    );
    expect(DATASET_EXPORT_RECIPES.map((recipe) => recipe.executionMode)).toEqual([
      "worker_queue",
      "worker_queue",
      "worker_queue",
      "worker_queue",
      "operator_package_go",
    ]);
  });

  it("defaults Review Bundle to a zip package and video-oriented source filter", () => {
    expect(defaultDatasetExportRequestedOutputs("REVIEW_BUNDLE")).toEqual([
      { kind: "package", delivery: "zip", optional: false, allowPartial: false },
    ]);
    expect(defaultDatasetExportSourceFilter("REVIEW_BUNDLE")).toMatchObject({
      artifactClasses: expect.arrayContaining(["render_video", "cosmos_video", "recording"]),
    });
  });

  it("clones default outputs and filters so callers cannot mutate recipe state", () => {
    const outputs = defaultDatasetExportRequestedOutputs("REVIEW_BUNDLE");
    outputs[0]!.optional = true;
    const filter = defaultDatasetExportSourceFilter("REVIEW_BUNDLE");
    filter!.artifactClasses!.push("mutated");

    expect(defaultDatasetExportRequestedOutputs("REVIEW_BUNDLE")[0]!.optional).toBe(false);
    expect(defaultDatasetExportSourceFilter("REVIEW_BUNDLE")!.artifactClasses).not.toContain("mutated");
  });

  it("defaults Alpamayo Stage-1 nav v3 to immutable prefix and manifest only", () => {
    const recipe = resolveDatasetExportRecipe("ALPAMAYO_SFT", ALPAMAYO_SFT_V3_RECIPE_ID);
    expect(isDatasetExportRecipeQueueable(recipe)).toBe(false);
    expect(() => assertDatasetExportRecipeQueueable(recipe)).toThrow(
      "A100 Package-Go workflow",
    );
    expect(datasetExportRecipeQueueBlockMessage(recipe)).toContain("A100 Package-Go workflow");
    expect(defaultDatasetExportRequestedOutputs("ALPAMAYO_SFT", ALPAMAYO_SFT_V3_RECIPE_ID)).toEqual([
      { kind: "prefix", delivery: "prefix", optional: false, allowPartial: false },
      { kind: "manifest", delivery: "manifest", optional: false, allowPartial: false },
    ]);
    expect(
      defaultDatasetExportRequestedOutputs("ALPAMAYO_SFT", ALPAMAYO_SFT_V3_RECIPE_ID),
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "package" })]));
  });

  it("lets explicit UI filters override recipe defaults", () => {
    expect(
      mergeDatasetExportSourceFilters(
        { artifactClasses: ["render_video"], scenarioIds: ["scenario_1"] },
        { scenarioIds: ["scenario_2"] },
      ),
    ).toEqual({
      artifactClasses: ["render_video"],
      scenarioIds: ["scenario_2"],
    });
  });
});
