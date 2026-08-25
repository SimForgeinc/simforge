import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const ImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const SCENARIO_RENDER_RESOURCE_REQUEST_VERSION =
  "uniscenario.render-resource-request/v1" as const;

/**
 * Provider-neutral admission envelope derived by the control plane from the
 * immutable scenario revision and render specification. It deliberately does
 * not contain a host, GPU slot, rental identifier, or cloud-provider name.
 */
export const ScenarioRenderResourceRequestSchema = z.strictObject({
  schema: z.literal(SCENARIO_RENDER_RESOURCE_REQUEST_VERSION),
  durationS: z.number().finite().positive().max(300),
  sensors: z.number().int().nonnegative().max(64),
  captureFrames: z.number().int().nonnegative(),
  actors: z.number().int().positive(),
  actorFrameStates: z.number().int().positive(),
  sensorPixels: z.number().int().nonnegative(),
  outputBytes: z.number().int().positive(),
  maxCameraWidth: z.number().int().nonnegative(),
  maxCameraHeight: z.number().int().nonnegative(),
  pixelsPerFrame: z.number().int().nonnegative(),
});
export type ScenarioRenderResourceRequest = z.infer<
  typeof ScenarioRenderResourceRequestSchema
>;

export const SCENARIO_PARITY_EVIDENCE_VERSION =
  "uniscenario.parity-evidence/v1" as const;

/**
 * Hard acceptance ceiling for CARLA-owned vehicle motion. The tighter
 * 0.25 m / 2 degree / 0.25 mps reference band remains part of worker evidence;
 * these values only classify bounded native-physics lag instead of forcing
 * actors onto authored poses.
 *
 * Position is the load-bearing guarantee and stays at 2 m over every sample.
 * Heading and speed must tolerate turn and stop transients: the authoring
 * sim's kinematic reference can swing tens of degrees within a half second at
 * walking speeds (an unreachable sub-2 m turning radius for any real vehicle),
 * so a physical vehicle that holds the 2 m position band still lags the
 * reference heading through sharp turns and carries speed into stops a little
 * longer. 45 degrees / 2 mps bounds those transients without letting an actor
 * leave its path.
 */
export const SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS = {
  positionM: 2,
  headingDeg: 45,
  speedMps: 2,
} as const;

export const SCENARIO_REFERENCE_EQUIVALENCE_LIMITS = {
  positionM: 0.25,
  headingDeg: 2,
  speedMps: 0.25,
} as const;

const ComparisonVerdictSchema = z.enum(["pass", "fail"]);

export const ScenarioParityEvidenceV1Schema = z
  .strictObject({
    schema: z.literal(SCENARIO_PARITY_EVIDENCE_VERSION),
    identity: z.strictObject({
      revisionId: z.string().trim().min(1),
      executionPackageId: z.string().trim().min(1),
      executionPackageControlSha256: Sha256Schema,
      sourceInputDigest: Sha256Schema,
      planSha256: Sha256Schema,
    }),
    execution: z.strictObject({
      mode: z.enum(["native-physics", "diagnostic-replay"]),
      fixedTimestepS: z.literal(0.02),
    }),
    semantics: z.strictObject({
      verdict: ComparisonVerdictSchema,
      evaluatedInteractionCount: z.number().int().nonnegative(),
      unclassifiedDifferenceCount: z.number().int().nonnegative(),
      failedCheckIds: z.array(z.string().trim().min(1)).max(10_000),
    }),
    trajectory: z.strictObject({
      verdict: ComparisonVerdictSchema,
      acceptanceGate: z.enum(["full-trajectory", "through-first-contact"]).optional(),
      evaluatedActorCount: z.number().int().nonnegative(),
      failedActorIds: z.array(z.string().trim().min(1)).max(10_000),
      // Grounded-spawn placement evidence from the CARLA worker: actors the
      // runtime dropped (unplaceable) or nudged onto valid ground before
      // execution. Diagnostic identity data; absent from browser evidence.
      droppedActorIds: z.array(z.string().trim().min(1)).max(10_000).optional(),
      nudgedActorIds: z.array(z.string().trim().min(1)).max(10_000).optional(),
      postContactFailedActorIds: z.array(z.string().trim().min(1)).max(10_000).optional(),
      postContactClassification: z.enum(["blocking", "expected-carla-physics"]).optional(),
      metrics: z.record(z.string(), z.number().finite().nonnegative()),
    }),
    collisions: z.strictObject({
      verdict: ComparisonVerdictSchema,
      evaluatedPairCount: z.number().int().nonnegative(),
      failedPairs: z.array(z.tuple([z.string().trim().min(1), z.string().trim().min(1)])).max(10_000),
    }),
    artifacts: z.strictObject({
      verdict: ComparisonVerdictSchema,
      verifiedKinds: z.array(z.string().trim().min(1)).min(1).max(100),
      missingKinds: z.array(z.string().trim().min(1)).max(100),
    }),
    divergences: z
      .array(
        z.strictObject({
          code: z.string().trim().min(1).max(200),
          classification: z.enum(["expected-carla-physics", "unclassified"]),
          actorId: z.string().trim().min(1).max(200).optional(),
          details: z.record(z.string(), z.unknown()).optional(),
        }),
      )
      .max(10_000),
    verdict: ComparisonVerdictSchema,
  })
  .superRefine((evidence, context) => {
    const hasUnclassifiedDivergence = evidence.divergences.some(
      (item) => item.classification === "unclassified",
    );
    // Diagnostic replay stays transportable for inspection, but teleport-
    // driven playback can never satisfy the native CARLA acceptance gate.
    const accepted =
      evidence.execution.mode === "native-physics" &&
      evidence.semantics.verdict === "pass" &&
      evidence.semantics.unclassifiedDifferenceCount === 0 &&
      evidence.semantics.failedCheckIds.length === 0 &&
      evidence.trajectory.verdict === "pass" &&
      evidence.trajectory.failedActorIds.length === 0 &&
      evidence.collisions.verdict === "pass" &&
      evidence.collisions.failedPairs.length === 0 &&
      evidence.artifacts.verdict === "pass" &&
      evidence.artifacts.missingKinds.length === 0 &&
      !hasUnclassifiedDivergence;
    if ((evidence.verdict === "pass") !== accepted) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "The parity verdict must be derived from every required comparison.",
      });
    }
  });

export type ScenarioParityEvidenceV1 = z.infer<
  typeof ScenarioParityEvidenceV1Schema
>;

export function isScenarioParityEvidenceAccepted(
  evidence: ScenarioParityEvidenceV1,
): boolean {
  return evidence.execution.mode === "native-physics" && evidence.verdict === "pass";
}

export const UNISCENARIO_RTX3080_HARDWARE_PROFILE = "rtx3080-10gb-v1" as const;
export const UNISCENARIO_LOCAL_RTX5080_HARDWARE_PROFILE =
  "rtx5080-16gb-local-v1" as const;

export const ScenarioRenderHardwareProfileSchema = z.enum([
  UNISCENARIO_RTX3080_HARDWARE_PROFILE,
  UNISCENARIO_LOCAL_RTX5080_HARDWARE_PROFILE,
]);
export type ScenarioRenderHardwareProfile = z.infer<
  typeof ScenarioRenderHardwareProfileSchema
>;

/** Exact runtime identity submitted at registration and completion. */
export const ScenarioRenderWorkerIdentitySchema = z.strictObject({
  workerVersion: z.string().regex(/^[a-f0-9]{40}$/),
  imageDigest: ImageDigestSchema,
  hardwareProfile: ScenarioRenderHardwareProfileSchema,
});
export type ScenarioRenderWorkerIdentity = z.infer<
  typeof ScenarioRenderWorkerIdentitySchema
>;

const scenarioRenderControl = {
  SCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
  SCENARIO_REFERENCE_EQUIVALENCE_LIMITS,
} as const;

export default scenarioRenderControl;
