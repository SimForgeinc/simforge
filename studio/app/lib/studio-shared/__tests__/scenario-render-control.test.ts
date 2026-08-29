import { describe, expect, it } from "vitest";
import {
  isScenarioParityEvidenceAccepted,
  SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
  SCENARIO_REFERENCE_EQUIVALENCE_LIMITS,
  ScenarioParityEvidenceV1Schema,
  ScenarioRenderResourceRequestSchema,
  ScenarioRenderWorkerIdentitySchema,
} from "../scenario-render-control";

const digest = "a".repeat(64);

function acceptedEvidence() {
  return {
    schema: "simforge.parity-evidence/v1" as const,
    identity: {
      revisionId: "usrv_1",
      executionPackageId: "usep_1",
      executionPackageControlSha256: digest,
      sourceInputDigest: digest,
      planSha256: digest,
    },
    execution: { mode: "native-physics" as const, fixedTimestepS: 0.02 as const },
    semantics: {
      verdict: "pass" as const,
      evaluatedInteractionCount: 3,
      unclassifiedDifferenceCount: 0,
      failedCheckIds: [],
    },
    trajectory: {
      verdict: "pass" as const,
      evaluatedActorCount: 2,
      failedActorIds: [],
      metrics: { maxPositionM: 0.12 },
    },
    collisions: { verdict: "pass" as const, evaluatedPairCount: 1, failedPairs: [] },
    artifacts: { verdict: "pass" as const, verifiedKinds: ["trace", "manifest"], missingKinds: [] },
    divergences: [{ code: "post_contact_tail", classification: "expected-carla-physics" as const }],
    verdict: "pass" as const,
  };
}

describe("managed render control contracts", () => {
  it("accepts evidence only when every required comparison passes", () => {
    const parsed = ScenarioParityEvidenceV1Schema.parse(acceptedEvidence());
    expect(isScenarioParityEvidenceAccepted(parsed)).toBe(true);
  });

  it("keeps reference equivalence distinct from the bounded native-physics ceiling", () => {
    expect(SCENARIO_REFERENCE_EQUIVALENCE_LIMITS).toEqual({
      positionM: 0.25,
      headingDeg: 2,
      speedMps: 0.25,
    });
    // Calibrated 2026-08-12: sample-wise 5°/1 mps gates are unattainable for native physics
    // tracking the kinematic browser-sim reference (sub-2 m turn radii swing heading ~41° in a
    // second at 2 m/s). Position stays strict; see scenario-render-control.ts for rationale.
    expect(SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS).toEqual({
      positionM: 2,
      headingDeg: 45,
      speedMps: 2,
    });
  });

  it("rejects a claimed pass with an unclassified semantic difference", () => {
    expect(() => ScenarioParityEvidenceV1Schema.parse({
      ...acceptedEvidence(),
      semantics: {
        ...acceptedEvidence().semantics,
        unclassifiedDifferenceCount: 1,
      },
    })).toThrow(/verdict/i);
  });

  it("accepts a truthful failed evidence document for durable diagnosis", () => {
    const failed = ScenarioParityEvidenceV1Schema.parse({
      ...acceptedEvidence(),
      trajectory: {
        ...acceptedEvidence().trajectory,
        verdict: "fail",
        failedActorIds: ["ego"],
      },
      verdict: "fail",
    });
    expect(isScenarioParityEvidenceAccepted(failed)).toBe(false);
  });

  it("keeps diagnostic replay evidence transportable but never accepted", () => {
    const diagnostic = ScenarioParityEvidenceV1Schema.parse({
      ...acceptedEvidence(),
      execution: { mode: "diagnostic-replay", fixedTimestepS: 0.02 },
      verdict: "fail",
    });
    expect(diagnostic.execution.mode).toBe("diagnostic-replay");
    expect(isScenarioParityEvidenceAccepted(diagnostic)).toBe(false);
    expect(() => ScenarioParityEvidenceV1Schema.parse({
      ...diagnostic,
      verdict: "pass",
    })).toThrow(/verdict/i);
  });

  it("keeps resource admission and worker identity provider neutral", () => {
    expect(ScenarioRenderResourceRequestSchema.parse({
      schema: "simforge.render-resource-request/v1",
      durationS: 10,
      sensors: 1,
      captureFrames: 300,
      actors: 256,
      actorFrameStates: 128_000,
      sensorPixels: 622_080_000,
      outputBytes: 2_147_483_648,
      maxCameraWidth: 1920,
      maxCameraHeight: 1080,
      pixelsPerFrame: 2_073_600,
    })).not.toHaveProperty("provider");
    expect(ScenarioRenderWorkerIdentitySchema.parse({
      workerVersion: "b".repeat(40),
      imageDigest: `sha256:${"c".repeat(64)}`,
      hardwareProfile: "rtx3080-10gb-v1",
    })).not.toHaveProperty("hostName");
    expect(ScenarioRenderWorkerIdentitySchema.parse({
      workerVersion: "b".repeat(40),
      imageDigest: `sha256:${"c".repeat(64)}`,
      hardwareProfile: "rtx5080-16gb-local-v1",
    }).hardwareProfile).toBe("rtx5080-16gb-local-v1");
    expect(ScenarioRenderWorkerIdentitySchema.safeParse({
      workerVersion: "b".repeat(40),
      imageDigest: `sha256:${"c".repeat(64)}`,
      hardwareProfile: "generic-local-gpu",
    }).success).toBe(false);
  });
});
