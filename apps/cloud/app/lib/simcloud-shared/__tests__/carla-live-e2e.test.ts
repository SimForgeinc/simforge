import { describe, expect, it } from "vitest";
import {
  CARLA_LIVE_E2E_FIXTURE_VERSION,
  CARLA_LIVE_E2E_REPORT_VERSION,
  CarlaLiveE2eFixtureManifestSchema,
  CarlaLiveE2eReportSchema,
  CarlaTimelineArtifactSchema,
} from "../carla-live-e2e";

function timeline(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    job_id: "cj_test",
    fixed_delta_seconds: 0.05,
    frame_count: 1,
    frames: [
      {
        frame: 1,
        timestamp: 0.05,
        actors: [
          {
            actor_spec_id: "autopilot-30mph",
            carla_actor_id: 42,
            x: 1,
            y: 2,
            yaw: 90,
            speed_mps: 13.4112,
            road_id: 10,
            lane_id: -1,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("CarlaTimelineArtifactSchema", () => {
  it("accepts the current worker timeline shape", () => {
    expect(CarlaTimelineArtifactSchema.parse(timeline()).frame_count).toBe(1);
  });

  it("accepts speed_kph compatibility samples", () => {
    const value = timeline();
    const actor = value.frames[0]!.actors[0]!;
    delete (actor as { speed_mps?: number }).speed_mps;
    (actor as { speed_kph?: number }).speed_kph = 48.28032;
    expect(CarlaTimelineArtifactSchema.safeParse(value).success).toBe(true);
  });

  it("rejects mismatched frame counts and unknown major versions", () => {
    expect(
      CarlaTimelineArtifactSchema.safeParse(
        timeline({ schema_version: "simforge.carla-timeline.v2", frame_count: 2 }),
      ).success,
    ).toBe(false);
  });

  it("requires a stable authored actor identifier and observed speed", () => {
    const value = timeline();
    value.frames[0]!.actors[0] = { x: 0, y: 0 } as never;
    expect(CarlaTimelineArtifactSchema.safeParse(value).success).toBe(false);
  });
});

describe("CarlaLiveE2eFixtureManifestSchema", () => {
  it("enforces UE5 fixtures and behavior-specific invariants", () => {
    const base = {
      schemaVersion: CARLA_LIVE_E2E_FIXTURE_VERSION,
      defaultFixtureId: "behavior-parity-v1",
      tolerance: {
        maxPositionDeltaM: 1,
        maxYawDeltaDeg: 3,
        maxSpeedDeltaKph: 3,
        staticDriftM: 0.1,
        routeCorridorM: 2,
        minimumTargetSpeedRatio: 0.9,
        maximumTargetSpeedRatio: 1.1,
        minimumTrafficLaneCount: 2,
        trafficRadiusToleranceM: 2,
        minimumAnnotatedFrameRatio: 0.25,
      },
      maps: [{ mapName: "Munich_Phase_1A", coverage: ["required", "behavior", "render"] }],
      fixtures: [
        {
          id: "behavior-parity-v1",
          scenarioPath: "scenarios/behavior-parity-v1.json",
          runtime: "carla_ue5",
          mapName: "Munich_Phase_1A",
          durationSeconds: 12,
          fixedDeltaSeconds: 0.05,
          invariants: [
            {
              actorId: "autopilot-30mph",
              behavior: "autopilot_speed",
              targetSpeedKph: 48.28032,
            },
          ],
          requiredArtifactTypes: [],
        },
      ],
    };
    expect(CarlaLiveE2eFixtureManifestSchema.safeParse(base).success).toBe(true);
    const invalid = structuredClone(base);
    delete invalid.fixtures[0]!.invariants[0]!.targetSpeedKph;
    expect(CarlaLiveE2eFixtureManifestSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("CarlaLiveE2eReportSchema", () => {
  it("accepts a complete classified report", () => {
    expect(
      CarlaLiveE2eReportSchema.safeParse({
        schemaVersion: CARLA_LIVE_E2E_REPORT_VERSION,
        status: "blocked_capacity",
        suite: "merge",
        environment: "dev",
        runId: "carla-live-e2e-test",
        sourceSha: "0123456789abcdef",
        startedAt: "2026-07-16T00:00:00.000Z",
        finishedAt: "2026-07-16T00:01:00.000Z",
        fixtureId: null,
        scenarioId: null,
        jobIds: [],
        checks: [],
        blockers: ["no test worker capacity"],
        cleanup: { attempted: false, passed: true, remainingResourceIds: [] },
      }).success,
    ).toBe(true);
  });
});
