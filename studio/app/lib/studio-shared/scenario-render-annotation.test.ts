import { describe, expect, it } from "vitest";
import {
  SCENARIO_RENDER_ANNOTATION_SCHEMA_VERSION,
  ScenarioRenderAnnotationInputSchema,
  ScenarioRenderAnnotationSchema,
} from "./scenario-render-annotation";

describe("scenario render annotation ranges", () => {
  const input = {
    renderJobId: "render-1",
    artifactId: "video-1",
    startMs: 0,
    endMs: 4_000,
    observation: "A pedestrian is approaching the crosswalk.",
    action: "Slow down and prepare to yield.",
  };

  it("accepts an observation and action over a non-empty time range", () => {
    expect(ScenarioRenderAnnotationInputSchema.parse(input)).toEqual(input);
    expect(
      ScenarioRenderAnnotationSchema.parse({
        ...input,
        schemaVersion: SCENARIO_RENDER_ANNOTATION_SCHEMA_VERSION,
        id: "annotation-1",
        scenarioId: "scenario-1",
        createdByUserId: "user-1",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        source: "generated",
        simStartS: 0,
        simEndS: 10,
        primitive: "yield_pedestrian",
        groundingRefs: { event: "conflict_enters_ego_lane", t: 0 },
        generatorSchema: "simforge.cot-groundtruth.v2",
      }).schemaVersion,
    ).toBe("simforge.scenario-render-annotation.v3");
  });

  it("normalizes a v2 row to a human v3 annotation", () => {
    const parsed = ScenarioRenderAnnotationSchema.parse({
      ...input,
      schemaVersion: "simforge.scenario-render-annotation.v2",
      id: "annotation-v2",
      scenarioId: "scenario-1",
      createdByUserId: "user-1",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(parsed).toMatchObject({
      schemaVersion: "simforge.scenario-render-annotation.v3",
      source: "human",
      id: "annotation-v2",
    });
  });

  it("rejects point annotations and incomplete observation/action pairs", () => {
    expect(() =>
      ScenarioRenderAnnotationInputSchema.parse({
        ...input,
        endMs: 0,
      }),
    ).toThrow("Annotation end must be after its start.");
    expect(() =>
      ScenarioRenderAnnotationInputSchema.parse({
        ...input,
        action: "",
      }),
    ).toThrow();
  });
});
