/**
 * Publishing offline-reviewed automated scenarios into SimCloud datasets.
 *
 * `manifest` is the wire contract; everything else is the offline tooling that
 * produces a bundle satisfying it. Consumers that only need to READ or validate
 * a bundle should import from here and touch nothing else — the run-tree
 * knowledge in `evidence` and the back-catalogue recovery in `materialize` are
 * implementation details of the builder.
 *
 * See docs/autogen-scenario-publishing.md.
 */

export {
  AUTOGEN_IMPORT_SCHEMA_VERSION,
  ArtifactRoleSchema,
  AutogenImportManifestSchema,
  BundleArtifactSchema,
  BundleExclusionsSchema,
  BundleGatesSchema,
  BundleSceneSchema,
  EvaluationArtifactRoleSchema,
  GateStateSchema,
  IMPORT_LIMITS,
  MANDATORY_ARTIFACT_ROLES,
  SystemArtifactRoleSchema,
  sceneEligibilityErrors,
} from "./manifest";
export type {
  ArtifactRole,
  AutogenImportManifest,
  BundleArtifact,
  BundleExclusions,
  BundleGates,
  BundleScene,
  EvaluationArtifactRole,
  GateState,
} from "./manifest";

export { PUBLISHABLE_VERDICTS, cotGateState, gateFromSummary } from "./evidence";
export { SCENARIO_SPEC_SCHEMA_VERSION, materializeSpec } from "./materialize";
export type { MaterializeInput, MaterializeResult } from "./materialize";
export {
  deriveSelection,
  formatSelectionFile,
  parseCsv,
  parseSelectionFile,
} from "./selection";
export type { DeriveOptions, DeriveResult } from "./selection";
export { buildBundle } from "./build-bundle";
export type { BuildOptions, BuildResult } from "./build-bundle";
