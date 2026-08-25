import { describe, expect, it } from "vitest";
import {
  SCENARIO_RATING_SCHEMA_VERSION,
  ScenarioRatingAggregateSchema,
  ScenarioRatingInputSchema,
  ScenarioReviewedViaSchema,
  ScenarioReviewQueuePageSchema,
  ScenarioRatingSchema,
} from "./scenario-rating";

describe("scenario rating contracts", () => {
  it("accepts strict rating inputs and durable rating DTOs", () => {
    expect(ScenarioRatingInputSchema.parse({ score: 4 })).toEqual({ score: 4 });
    expect(
      ScenarioRatingSchema.parse({
        schemaVersion: SCENARIO_RATING_SCHEMA_VERSION,
        id: "rating-1",
        scenarioId: "scenario-1",
        raterUserId: "user-1",
        score: 5,
        comment: null,
        createdAt: "2026-07-22T00:00:00.000Z",
        updatedAt: "2026-07-22T00:00:00.000Z",
      }).schemaVersion,
    ).toBe("simforge.scenario-rating.v1");
  });

  it("rejects scores outside one through five and unknown fields", () => {
    expect(() => ScenarioRatingInputSchema.parse({ score: 0 })).toThrow();
    expect(() =>
      ScenarioRatingInputSchema.parse({ score: 6, legacyRating: 5 }),
    ).toThrow();
  });

  it("accepts pending, accepted, and rejected aggregate states", () => {
    for (const reviewState of ["pending", "accepted", "rejected"] as const) {
      expect(
        ScenarioRatingAggregateSchema.parse({
          scenarioId: "scenario-1",
          averageScore: reviewState === "pending" ? 0 : 4.5,
          ratingCount: reviewState === "pending" ? 0 : 2,
          myScore: reviewState === "pending" ? null : 4,
          reviewState,
        }).reviewState,
      ).toBe(reviewState);
    }
  });

  it("accepts strict queue pages and review-surface provenance", () => {
    expect(ScenarioReviewedViaSchema.parse("queue")).toBe("queue");
    expect(() => ScenarioReviewedViaSchema.parse("review.csv")).toThrow();
    expect(
      ScenarioReviewQueuePageSchema.parse({
        items: [
          {
            scenarioId: "scenario-1",
            displayName: "Crosswalk yield",
            mapName: "Town10HD",
            family: null,
            scenarioIntention: { outcome: "collision_avoidance" },
            createdAt: "2026-07-22T00:00:00.000Z",
            latestRender: {
              jobId: "render-1",
              createdAt: "2026-07-22T01:00:00.000Z",
              videoMediaPath:
                "/api/scenario-runtime/artifacts/video-1/media",
              posterMediaPath: null,
              lintVerdict: "pass",
            },
          },
        ],
        nextCursor: null,
      }).items[0]?.scenarioId,
    ).toBe("scenario-1");
  });
});
