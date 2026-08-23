import { describe, expect, it } from "vitest";

import {
  compareRuns,
  ParityReportSchema,
  type ParityFrame,
} from "../parity";

function frames(input: {
  actorId?: string;
  offsetX?: number;
  speed?: number;
  end?: number;
} = {}): ParityFrame[] {
  const actorId = input.actorId ?? "ego";
  const offsetX = input.offsetX ?? 0;
  const speed = input.speed ?? 4;
  const end = input.end ?? 1;
  return Array.from({ length: Math.round(end * 10) + 1 }, (_, index) => {
    const timestamp = index / 10;
    return {
      timestamp,
      actors: [
        {
          id: actorId,
          kind: "vehicle",
          x: timestamp * speed + offsetX,
          y: 2,
          yaw: 0,
          speed,
        },
      ],
    };
  });
}

describe("compareRuns", () => {
  it("passes identical runs with zero deviations", () => {
    const report = compareRuns(frames(), frames());

    expect(ParityReportSchema.safeParse(report).success).toBe(true);
    expect(report.verdict).toBe("pass");
    expect(report.actors[0]).toMatchObject({
      maxDeviation: 0,
      rmse: 0,
      endStateDelta: 0,
      maxSpeedDelta: 0,
      verdict: "pass",
    });
  });

  it("measures a constant 0.3 metre offset analytically", () => {
    const report = compareRuns(frames(), frames({ offsetX: 0.3 }));

    expect(report.actors[0]!.maxDeviation).toBeCloseTo(0.3, 6);
    expect(report.actors[0]!.rmse).toBeCloseTo(0.3, 6);
    expect(report.verdict).toBe("pass");
  });

  it("computes collision timing delta for unordered pairs", () => {
    const report = compareRuns(
      frames(),
      frames(),
      undefined,
      {
        reference: { collisions: [{ pair: ["ego", "npc"], t: 2 }] },
        candidate: { collisions: [{ pair: ["npc", "ego"], t: 2.4 }] },
      },
    );

    expect(report.collisions).toMatchObject({
      evaluated: true,
      verdict: "pass",
      pairs: [{ pair: ["ego", "npc"], verdict: "pass" }],
    });
    expect(report.collisions.pairs[0]!.timingDelta).toBeCloseTo(0.4, 6);
  });

  it("reports actors missing from either side and returns partial", () => {
    const report = compareRuns(frames({ actorId: "ego" }), [
      ...frames({ actorId: "ego" }),
      ...frames({ actorId: "candidate-only" }),
    ]);

    expect(report.verdict).toBe("partial");
    expect(report.excludedActors).toContainEqual({
      actorId: "candidate-only",
      reason: "missing_from_reference",
    });
  });

  it("honours a deep threshold override", () => {
    const defaultReport = compareRuns(frames(), frames({ offsetX: 0.7 }));
    const overridden = compareRuns(
      frames(),
      frames({ offsetX: 0.7 }),
      { position: { rmseMeters: 0.8 } },
    );

    expect(defaultReport.verdict).toBe("fail");
    expect(overridden.verdict).toBe("pass");
    expect(overridden.config.position.maxDeviationMeters.vehicle).toBe(1.5);
  });
});
