import { describe, expect, it } from "vitest";
import {
  PUBLISHABLE_VERDICTS,
  cotGateState,
  gateFromSummary,
  parseSceneDirName,
} from "../evidence";

describe("publication verdicts", () => {
  it("matches the worker's PUBLISHABLE_VERDICTS exactly", () => {
    // Mirrors services/carla-worker/carla_worker/review_compose.py. If the two
    // drift, a bundle either ships scenes the compositor refused to publish or
    // silently drops valid ones — both invisible until a customer notices.
    expect([...PUBLISHABLE_VERDICTS].sort()).toEqual([
      "clean_miss",
      "edge_case",
      "intended_collision",
    ]);
  });

  it("accepts intended_collision and edge_case", () => {
    for (const verdict of ["intended_collision", "edge_case", "clean_miss"]) {
      expect(
        gateFromSummary({ sceneOutcome: { verdict }, terminalStatus: "succeeded" }),
      ).toEqual({ state: "pass", verdict });
    }
  });

  it("rejects verdicts from other outcome vocabularies", () => {
    // contact / maneuver / stop vocabularies answer different questions about
    // the same run and are not publication decisions.
    for (const verdict of ["collision", "avoided", "near_miss", "valid", "valid_resume"]) {
      expect(
        gateFromSummary({ sceneOutcome: { verdict }, terminalStatus: "succeeded" }).state,
        `${verdict} must not be publishable`,
      ).toBe("fail");
    }
  });
});

describe("verdict reading", () => {
  it("treats an absent verdict as missing, never as a pass", () => {
    // Summaries have NO top-level `verdict`; a reader looking for one sees
    // undefined and would pass every scene including the broken ones.
    expect(gateFromSummary({ terminalStatus: "succeeded" }).state).toBe("missing");
    expect(gateFromSummary({ sceneOutcome: {} }).state).toBe("missing");
    expect(gateFromSummary({ verdict: "clean_miss" }).state).toBe("missing");
    expect(gateFromSummary(null).state).toBe("missing");
  });

  it("fails a run that did not terminate successfully", () => {
    expect(
      gateFromSummary({
        sceneOutcome: { verdict: "clean_miss" },
        terminalStatus: "failed",
      }).state,
    ).toBe("fail");
  });
});

describe("cot self-gate", () => {
  const doc = (extra: Record<string, unknown>) => ({
    schema: "simforge.cot.v1",
    segments: [{ t_sim: 0, text: "x" }],
    ...extra,
  });

  it("passes only on a recorded self_gate.ok === true", () => {
    expect(cotGateState(doc({ self_gate: { ok: true } }))).toBe("pass");
  });

  it("fails a recorded failing gate", () => {
    expect(cotGateState(doc({ self_gate: { ok: false } }))).toBe("fail");
  });

  it("does NOT trust a document with no self_gate block", () => {
    // Matches _cot_passed_its_gate: ungated documents predate the gate, and the
    // generator used to write the document before checking it — so an absent
    // gate may be exactly the failed narration the gate exists to catch.
    expect(cotGateState(doc({}))).toBe("missing");
  });

  it("does not accept unrecognized gate shapes as success", () => {
    for (const gate of [{ status: "pass" }, { passed: true }, { ok: "true" }, {}]) {
      expect(cotGateState(doc({ self_gate: gate })), JSON.stringify(gate)).toBe("fail");
    }
  });

  it("rejects a wrong schema, empty segments, or a missing document", () => {
    expect(cotGateState(null)).toBe("missing");
    expect(cotGateState({ schema: "other", segments: [], self_gate: { ok: true } })).toBe("fail");
    expect(
      cotGateState({ schema: "simforge.cot.v1", segments: [], self_gate: { ok: true } }),
    ).toBe("fail");
  });
});

describe("scene directory names", () => {
  it("splits map/family/sceneId and tolerates hyphens in the id", () => {
    expect(parseSceneDirName("yale__biketurnavoid__left-1549-4")).toEqual({
      map: "yale",
      family: "biketurnavoid",
      sceneId: "left-1549-4",
    });
  });

  it("returns null for a name that is not a scene directory", () => {
    expect(parseSceneDirName("videos-review")).toBeNull();
    expect(parseSceneDirName("a__b")).toBeNull();
  });
});
