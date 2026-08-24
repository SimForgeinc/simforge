import { describe, expect, it } from "vitest";
import {
  BILLING,
  estimateCosmosCostCents,
  estimateRenderCostCents,
} from "../billing";

describe("billing pricing", () => {
  it("charges render jobs $5 per configured sensor", () => {
    const estimate = estimateRenderCostCents({
      sensors: [
        { id: "front", sensorCategory: "camera", outputModality: "rgb" },
        { id: "rear", sensorCategory: "camera", outputModality: "rgb" },
      ],
    });

    expect(BILLING.renderCentsPerSensor).toBe(500);
    expect(estimate).toMatchObject({
      sensorCount: 2,
      outputMethodCount: 0,
      totalCents: 1000,
    });
  });

  it("charges render output methods after expanding bundled SDG dependencies", () => {
    const estimate = estimateRenderCostCents({
      render_output_plan: {
        schemaVersion: "simforge.render-output-plan.v1",
        profile: "sdg",
        cameraMountIds: ["front_center"],
        outputs: {
          frames: ["rgb"],
          annotations: ["rgb_bboxed"],
          media: ["videos"],
        },
      },
    });

    expect(estimate.expandedOutputMethods).toEqual([
      "rgb",
      "semantic_segmentation",
      "instance_segmentation",
      "videos",
      "rgb_bboxed",
    ]);
    expect(estimate).toMatchObject({
      sensorCount: 1,
      outputMethodCount: 5,
      sensorCostCents: 500,
      outputMethodCostCents: 2500,
      totalCents: 3000,
    });
  });

  it("applies the priority queue premium with integer-safe rounding", () => {
    const estimate = estimateRenderCostCents(
      {
        sensors: [{ id: "front", sensorCategory: "camera", outputModality: "rgb" }],
        render_output_plan: {
          schemaVersion: "simforge.render-output-plan.v1",
          profile: "sdg",
          cameraMountIds: ["front_center"],
          outputs: {
            frames: ["rgb"],
            annotations: [],
            media: [],
          },
        },
      },
      { queueTier: "priority" },
    );

    expect(estimate).toMatchObject({
      queueTier: "priority",
      costMultiplierBps: 15000,
      baseTotalCents: 1000,
      premiumCents: 500,
      totalCents: 1500,
    });
  });

  it("charges Cosmos by selected video multiplied by selected weather/preset count", () => {
    expect(estimateCosmosCostCents({ videoCount: 1, weatherCount: 10 })).toMatchObject({
      outputCount: 10,
      totalCents: 5000,
    });
    expect(estimateCosmosCostCents({ videoCount: 2, weatherCount: 3 })).toMatchObject({
      outputCount: 6,
      totalCents: 3000,
    });
  });
});
