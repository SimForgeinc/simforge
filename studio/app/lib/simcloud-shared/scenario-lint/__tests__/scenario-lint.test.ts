import { describe, expect, it } from "vitest";
import {
  fromCarlaActorTrack,
  fromEsminiTrajectories,
  fromPreviewFrames,
  lintActorTracks,
  resolveLintConfig,
  type LintActorTrack,
  type LintMetricSample,
  type LintViolation,
} from "../index";

const DT = 0.05;

function times(durationS: number): number[] {
  return Array.from(
    { length: Math.round(durationS / DT) + 1 },
    (_value, index) => index * DT,
  );
}

function metricPeak(
  track: LintActorTrack,
  field: keyof Omit<LintMetricSample, "t">,
): number {
  return Math.max(
    ...lintActorTracks([track]).perActor[0]!.samples.map((sample) =>
      Math.abs(sample[field]),
    ),
  );
}

function violationsOfKind(
  track: LintActorTrack,
  kind: LintViolation["kind"],
): LintViolation[] {
  return lintActorTracks([track]).violations.filter(
    (violation) => violation.kind === kind,
  );
}

function brakingTrack(
  actorId: string,
  initialSpeed: number,
  deceleration: number,
  durationS: number,
): LintActorTrack {
  return {
    actorId,
    kind: "vehicle",
    samples: times(durationS).map((t) => ({
      t,
      x: initialSpeed * t - 0.5 * deceleration * t * t,
      y: 0,
      yaw: 0,
      speed: initialSpeed - deceleration * t,
    })),
  };
}

describe("lintActorTracks", () => {
  it("passes a constant-speed straight line with zero derived dynamics", () => {
    const track: LintActorTrack = {
      actorId: "steady",
      kind: "vehicle",
      samples: times(3).map((t) => ({
        t,
        x: 10 * t,
        y: 2,
        yaw: 0,
        speed: 10,
      })),
    };

    const report = lintActorTracks([track]);

    expect(report.schemaVersion).toBe("simforge.scenario-lint.v1");
    expect(report.summary).toEqual({
      verdict: "pass",
      violationCount: 0,
      warningCount: 0,
      byKind: {},
    });
    for (const sample of report.perActor[0]!.samples) {
      expect(sample.longitudinalAcceleration).toBeCloseTo(0, 10);
      expect(sample.longitudinalDeceleration).toBeCloseTo(0, 10);
      expect(sample.lateralAcceleration).toBeCloseTo(0, 10);
      expect(sample.longitudinalJerk).toBeCloseTo(0, 10);
      expect(sample.yawRate).toBeCloseTo(0, 10);
    }
  });

  it("classifies comfort and emergency braking with analytical peaks", () => {
    const comfortBrake = brakingTrack("comfort", 20, 5, 2);
    const emergencyBrake = brakingTrack("emergency", 20, 10, 2);

    const comfort = violationsOfKind(
      comfortBrake,
      "longitudinal_deceleration",
    );
    const emergency = violationsOfKind(
      emergencyBrake,
      "longitudinal_deceleration",
    );

    expect(comfort).toHaveLength(1);
    expect(comfort[0]!.severity).toBe("warning");
    expect(comfort[0]!.threshold).toBe(3.5);
    expect(comfort[0]!.peakValue).toBeCloseTo(5, 1);
    expect(emergency).toHaveLength(1);
    expect(emergency[0]!.severity).toBe("violation");
    expect(emergency[0]!.threshold).toBe(9);
    expect(emergency[0]!.peakValue).toBeCloseTo(10, 1);
    expect(metricPeak(emergencyBrake, "longitudinalDeceleration")).toBeCloseTo(
      10,
      1,
    );
  });

  it("detects and windows a teleport from raw positions", () => {
    const track: LintActorTrack = {
      actorId: "teleport",
      kind: "vehicle",
      samples: times(2).map((t) => ({
        t,
        x: 5 * t + (t >= 1 ? 20 : 0),
        y: 0,
        yaw: 0,
        speed: 5,
      })),
    };

    const violations = violationsOfKind(track, "position_discontinuity");

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      actorId: "teleport",
      severity: "violation",
      tEnd: 1,
      threshold: 2,
    });
    expect(violations[0]!.tStart).toBeCloseTo(0.95, 10);
    expect(violations[0]!.peakValue).toBeCloseTo(20.25, 10);
  });

  it("detects a high-jerk stop without relying on speed discontinuity", () => {
    const samples = times(2.25).map((t) => {
      const brakingTime = Math.max(0, t - 1);
      return {
        t,
        x:
          t <= 1
            ? 10 * t
            : 10 + 10 * brakingTime - 4 * brakingTime * brakingTime,
        y: 0,
        yaw: 0,
        speed: Math.max(0, 10 - 8 * brakingTime),
      };
    });
    const report = lintActorTracks([
      { actorId: "jerky-stop", kind: "vehicle", samples },
    ]);

    const jerk = report.violations.filter(
      (violation) => violation.kind === "longitudinal_jerk",
    );
    expect(jerk.some((violation) => violation.severity === "violation")).toBe(
      true,
    );
    expect(Math.max(...jerk.map((violation) => violation.peakValue))).toBeGreaterThan(
      10,
    );
    expect(
      report.violations.filter(
        (violation) => violation.kind === "speed_discontinuity",
      ),
    ).toHaveLength(0);
  });

  it("requires the default jerk warning to persist for more than 0.5 s", () => {
    const rampingBrake = (durationS: number): LintActorTrack => ({
      actorId: `jerk-${durationS}`,
      kind: "vehicle",
      samples: times(durationS).map((t) => ({
        t,
        x: 20 * t - 1.5 * t * t - (2.5 / 3) * t * t * t,
        y: 0,
        yaw: 0,
        speed: 20 - 3 * t - 2.5 * t * t,
      })),
    });

    const sustained = violationsOfKind(
      rampingBrake(1),
      "longitudinal_jerk",
    );
    const brief = violationsOfKind(
      rampingBrake(0.4),
      "longitudinal_jerk",
    );

    expect(sustained).toHaveLength(1);
    expect(sustained[0]!.severity).toBe("warning");
    expect(sustained[0]!.peakValue).toBeCloseTo(5, 0);
    expect(brief).toHaveLength(0);
  });

  it("derives circular-path lateral acceleration when yaw and speed are absent", () => {
    const radius = 20;
    const speed = 10;
    const omega = speed / radius;
    const track: LintActorTrack = {
      actorId: "arc",
      kind: "vehicle",
      samples: times(4).map((t) => ({
        t,
        x: radius * Math.sin(omega * t),
        y: radius * (1 - Math.cos(omega * t)),
      })),
    };

    const peak = metricPeak(track, "lateralAcceleration");

    expect(peak).toBeCloseTo((speed * speed) / radius, 1);
    expect(Math.abs(peak - (speed * speed) / radius) / 5).toBeLessThan(0.05);
  });

  it("flags a walker sprint above the walker violation speed", () => {
    const track: LintActorTrack = {
      actorId: "sprinter",
      kind: "walker",
      samples: times(2).map((t) => ({
        t,
        x: 8 * t,
        y: 0,
        speed: 8,
      })),
    };

    const report = lintActorTracks([track]);
    const speed = report.violations.filter(
      (violation) => violation.kind === "speed",
    );

    expect(speed).toHaveLength(1);
    expect(speed[0]).toMatchObject({
      severity: "violation",
      peakValue: 8,
      threshold: 7,
      tStart: 0,
      tEnd: 2,
    });
    expect(report.summary.verdict).toBe("fail");
  });

  it("detects raw speed and heading discontinuities", () => {
    const track: LintActorTrack = {
      actorId: "discontinuous",
      kind: "vehicle",
      samples: [
        { t: 0, x: 0, y: 0, yaw: 0, speed: 0 },
        { t: 0.05, x: 0, y: 0, yaw: Math.PI, speed: 20 },
        { t: 0.1, x: 1, y: 0, yaw: Math.PI, speed: 20 },
      ],
    };

    const report = lintActorTracks([track]);

    expect(
      report.violations.some(
        (violation) => violation.kind === "speed_discontinuity",
      ),
    ).toBe(true);
    expect(
      report.violations.some(
        (violation) => violation.kind === "heading_discontinuity",
      ),
    ).toBe(true);
  });
});

describe("configuration", () => {
  it("deep-merges a single threshold override with all remaining defaults", () => {
    const resolved = resolveLintConfig({
      smoothingWindowS: 0.2,
      thresholds: {
        vehicle: {
          longitudinalDeceleration: { warning: 6 },
        },
      },
    });

    expect(resolved.smoothingWindowS).toBe(0.2);
    expect(resolved.thresholds.vehicle.longitudinalDeceleration).toEqual({
      warning: 6,
      violation: 9,
      warningMinDurationS: 0,
    });
    expect(resolved.thresholds.vehicle.lateralAcceleration.warning).toBe(3);
    expect(resolved.thresholds.walker.speed).toEqual({
      warning: 3,
      violation: 7,
      warningMinDurationS: 0,
    });
    expect(
      lintActorTracks([brakingTrack("override", 20, 5, 2)], {
        thresholds: {
          vehicle: {
            longitudinalDeceleration: { warning: 6 },
          },
        },
      }).violations.filter(
        (violation) => violation.kind === "longitudinal_deceleration",
      ),
    ).toHaveLength(0);
  });
});

describe("source adapters", () => {
  it("produces equivalent lint findings for esmini, CARLA, and preview motion", () => {
    const motion = brakingTrack("same-motion", 20, 5, 2).samples;
    const esmini = fromEsminiTrajectories([
      {
        actor_id: "same-motion",
        points: motion.map((sample) => ({
          t: sample.t,
          x: sample.x,
          y: sample.y,
          yaw: sample.yaw!,
          speed: sample.speed!,
        })),
      },
    ]);
    const carla = fromCarlaActorTrack({
      version: 1,
      frame_count: motion.length,
      fixed_delta_seconds: DT,
      frames: motion.map((sample, index) => ({
        frame: index,
        timestamp: sample.t,
        actors: [
          {
            actor_spec_id: "same-motion",
            kind: "vehicle",
            role: "ego",
            x: sample.x,
            y: sample.y,
            yaw: sample.yaw! * (180 / Math.PI),
            speed_mps: sample.speed,
          },
        ],
      })),
    });
    const preview = fromPreviewFrames(
      motion.map((sample) => ({
        timestamp: sample.t,
        actors: [
          {
            id: "same-motion",
            x: sample.x,
            y: sample.y,
            yaw: sample.yaw,
            speed: sample.speed,
          },
        ],
      })),
    );

    const reports = [esmini, carla, preview].map((tracks) =>
      lintActorTracks(tracks),
    );
    const baseline = reports[0]!.violations;
    for (const report of reports.slice(1)) {
      expect(report.violations).toHaveLength(baseline.length);
      report.violations.forEach((violation, index) => {
        const expected = baseline[index]!;
        expect(violation).toMatchObject({
          actorId: expected.actorId,
          kind: expected.kind,
          severity: expected.severity,
          tStart: expected.tStart,
          tEnd: expected.tEnd,
          threshold: expected.threshold,
        });
        expect(violation.peakValue).toBeCloseTo(expected.peakValue, 10);
      });
    }
  });

  it("maps walker kinds and omits out-of-domain CARLA props", () => {
    const tracks = fromCarlaActorTrack({
      frames: [
        {
          timestamp: 0,
          actors: [
            {
              actor_spec_id: "walker",
              kind: "walker",
              x: 0,
              y: 0,
              yaw: 90,
              speed_kph: 28.8,
            },
            {
              actor_spec_id: "barrier",
              kind: "prop",
              x: 1,
              y: 1,
            },
          ],
        },
      ],
    });

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      actorId: "walker",
      kind: "walker",
      samples: [{ yaw: Math.PI / 2, speed: 8 }],
    });
  });
});
