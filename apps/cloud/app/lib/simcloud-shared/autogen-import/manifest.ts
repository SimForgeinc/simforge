import { z } from "zod";
import { ImportedCategorySchema } from "../scenario-catalog";

/**
 * Import bundle contract for publishing offline-reviewed automated scenarios.
 *
 * The bundle packages everything needed to display, audit, replay, edit, and
 * later production-render a selected scene WITHOUT depending on the directory
 * conventions of whichever emitter produced it. That independence is the whole
 * point: the nominal and conflict pipelines lay their output out differently,
 * and historical runs differ again, so any consumer that walked directories
 * would break on the next run shape.
 *
 * Two rules the schema enforces structurally:
 *
 *  - A compiled worker job is NOT a scenario. `scenario.spec` must be the
 *    uncompiled, editor-native draft, because a later phase has to open it,
 *    let an operator pick a rig, and compile it fresh. Bundles that carry only
 *    the compiled job would be replayable but not editable.
 *  - Only fully-evidenced scenes become items. Gate-rejected and
 *    composition-failed candidates never get an entry here, which is what
 *    keeps "rejected scenes never enter the review dataset" true by
 *    construction rather than by a downstream filter someone can forget.
 */

export const AUTOGEN_IMPORT_SCHEMA_VERSION = "simforge.autogen-import.v1" as const;

/** SHA-256, lowercase hex. */
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase sha256 hex");

/**
 * Artifact roles. Split deliberately: `evaluation_*` roles are what the
 * customer sees, `scenario_*`/`import_*` are system and provenance records.
 * Using a role registry rather than file names keeps emitter layout out of
 * every consumer.
 */
export const EvaluationArtifactRoleSchema = z.enum([
  "evaluation_review_video",
  "evaluation_review_poster",
  "cot_trace",
  "evaluation_summary",
  "evaluation_metrics",
  "scenario_events",
  "actor_track",
  "gate_report",
]);
export type EvaluationArtifactRole = z.infer<typeof EvaluationArtifactRoleSchema>;

export const SystemArtifactRoleSchema = z.enum([
  "scenario_spec",
  "scenario_replay",
  "import_manifest",
  "import_receipt",
]);

export const ArtifactRoleSchema = z.union([
  EvaluationArtifactRoleSchema,
  SystemArtifactRoleSchema,
]);
export type ArtifactRole = z.infer<typeof ArtifactRoleSchema>;

/**
 * Artifacts without which a scene cannot be displayed or audited. A scene
 * missing any of these fails eligibility rather than importing partially — a
 * half-evidenced scenario in a customer dataset is worse than an absent one,
 * because it looks complete.
 */
export const MANDATORY_ARTIFACT_ROLES: readonly EvaluationArtifactRole[] = [
  "evaluation_review_video",
  "cot_trace",
  "evaluation_summary",
  "scenario_events",
  "actor_track",
] as const;

export const BundleArtifactSchema = z.object({
  role: ArtifactRoleSchema,
  /** Path relative to the bundle root. Never absolute, never escaping root. */
  path: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
      message: "artifact path must be bundle-relative and must not traverse",
    }),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: Sha256Schema,
});
export type BundleArtifact = z.infer<typeof BundleArtifactSchema>;

/** Gate outcomes. `pass` is the only value that lets a scene become an item. */
export const GateStateSchema = z.enum(["pass", "fail", "missing"]);
export type GateState = z.infer<typeof GateStateSchema>;

export const BundleGatesSchema = z.object({
  phase2d: GateStateSchema,
  phase3d: GateStateSchema,
  cot: GateStateSchema,
  compose: GateStateSchema,
  /**
   * The authoritative 3D verdict, read from `sceneOutcome.verdict` in the run
   * summary. Recorded verbatim so a later taxonomy or policy change can
   * re-judge without re-reading every summary.
   *
   * Note this is read from `sceneOutcome`, NOT from a top-level `verdict` key
   * — summaries have no top-level verdict, so a naive reader sees `undefined`
   * and passes everything.
   */
  sceneVerdict: z.string().min(1),
});
export type BundleGates = z.infer<typeof BundleGatesSchema>;

export const BundleScenarioSchema = z.object({
  /** The uncompiled, editor-native draft. Required — see the note above. */
  spec: z.object({ path: z.string().min(1), sha256: Sha256Schema }),
  /** Deterministic replay identity, when the emitter produced one. */
  replay: z.object({ path: z.string().min(1), sha256: Sha256Schema }).optional(),
});

export const BundleMapSchema = z.object({
  mapAssetId: z.string().min(1),
  mapName: z.string().min(1),
  carlaMapName: z.string().min(1).optional(),
});

/** Everything needed to reproduce the scene from scratch. */
export const BundleReproducibilitySchema = z.object({
  seed: z.number().int().nullable(),
  generatorSha: z.string().nullable(),
  generatorVersion: z.string().nullable(),
  taxonomyVersion: z.string().min(1),
  /** The original generation request, verbatim. */
  request: z.unknown().optional(),
});

/**
 * A scene is eligible only when every mandatory artifact is present AND every
 * gate passed. Returns the reasons it is not, so the builder can report an
 * aggregate breakdown instead of a bare count.
 */
export function sceneEligibilityErrors(scene: {
  gates: BundleGates;
  artifacts: readonly { role: ArtifactRole }[];
}): string[] {
  const errors: string[] = [];
  const roles = new Set(scene.artifacts.map((a) => a.role));
  for (const role of MANDATORY_ARTIFACT_ROLES) {
    if (!roles.has(role)) errors.push(`missing_artifact:${role}`);
  }
  for (const [name, state] of [
    ["phase2d", scene.gates.phase2d],
    ["phase3d", scene.gates.phase3d],
    ["cot", scene.gates.cot],
    ["compose", scene.gates.compose],
  ] as const) {
    if (state !== "pass") errors.push(`gate_${name}:${state}`);
  }
  return errors;
}

/**
 * Eligibility is enforced by the SCHEMA, not only by the builder that happens
 * to write bundles today.
 *
 * If the contract accepted a scene with a failed gate or missing evidence, then
 * every downstream consumer — the import API, a future worker, anyone
 * hand-assembling a manifest — would have to remember to re-apply the filter,
 * which is exactly the "rejected scenes never enter the review dataset"
 * guarantee this contract exists to make structural. Parsing a manifest is now
 * sufficient to know its scenes are publishable.
 */
export const BundleSceneSchema = z
  .object({
    /** The offline scene id. Unique within a bundle; maps to a SimCloud id on commit. */
    externalSceneId: z.string().min(1),
    displayName: z.string().min(1),
    category: ImportedCategorySchema,
    map: BundleMapSchema,
    scenario: BundleScenarioSchema,
    gates: BundleGatesSchema,
    reproducibility: BundleReproducibilitySchema,
    artifacts: z.array(BundleArtifactSchema).min(1),
  })
  .superRefine((scene, ctx) => {
    for (const error of sceneEligibilityErrors(scene)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `ineligible scene "${scene.externalSceneId}": ${error}`,
        path: error.startsWith("gate_") ? ["gates"] : ["artifacts"],
      });
    }
  });
export type BundleScene = z.infer<typeof BundleSceneSchema>;

export const BundleSourceBatchSchema = z.object({
  id: z.string().min(1),
  generatorSha: z.string().nullable(),
  taxonomyVersion: z.string().min(1),
  /** Phase 0 accepts only an explicit operator allowlist. */
  selectionMode: z.literal("explicit_allowlist"),
  /** Hash of the selection file, so the receipt can prove what was asked for. */
  selectionSha256: Sha256Schema,
});

/**
 * Counts of what was considered but excluded. Recorded as aggregates only:
 * the run may say 40 scenes were gate-rejected, but must not carry importable
 * item records for them.
 */
export const BundleExclusionsSchema = z.object({
  notSelected: z.number().int().nonnegative(),
  gateRejected: z.number().int().nonnegative(),
  evidenceIncomplete: z.number().int().nonnegative(),
  categoryUnresolved: z.number().int().nonnegative(),
  /** Reason -> count, for explaining a short bundle without listing rejects. */
  byReason: z.record(z.number().int().nonnegative()).default({}),
});
export type BundleExclusions = z.infer<typeof BundleExclusionsSchema>;

export const AutogenImportManifestSchema = z.object({
  schemaVersion: z.literal(AUTOGEN_IMPORT_SCHEMA_VERSION),
  sourceBatch: BundleSourceBatchSchema,
  target: z.object({ datasetId: z.string().min(1).nullable() }),
  scenes: z.array(BundleSceneSchema),
  exclusions: BundleExclusionsSchema,
});
export type AutogenImportManifest = z.infer<typeof AutogenImportManifestSchema>;

/**
 * Operational guardrails from the design. Enforced by the builder so a runaway
 * selection fails locally rather than at the API boundary.
 */
export const IMPORT_LIMITS = {
  maxScenesPerRun: 2000,
  maxArtifactsPerScene: 12,
  maxManifestBytes: 25 * 1024 * 1024,
} as const;
