/** Canonical browser-safe OpenSCENARIO API for UniScenarios. */
export * from './export/index.js';
export {
  MAX_XOSC_BYTES,
  OpenScenarioImportError,
  analyzeOpenScenarioImport,
  resolveOpenScenarioMap,
  translateOpenScenarioImport,
  type OpenScenarioImportAnalysis,
  type OpenScenarioImportDiagnostic,
  type OpenScenarioImportMapCandidate,
  type OpenScenarioMapResolution,
} from './import.js';
export type {
  OpenScenarioSnapshot,
  OpenScenarioSourceMapping,
  OpenScenarioValidationStage,
  OpenScenarioValidationStatus,
} from './snapshot.js';
export {
  OpenScenarioExecutionPlanError,
  MAX_OPENSCENARIO_EXECUTION_PLAN_BYTES,
  compareTraceToOpenScenarioPlan,
  extractOpenScenarioExecutionPlan,
  type OpenScenarioEnvironmentPlan,
  type OpenScenarioExecutionPlan,
  type OpenScenarioExecutionPlanOptions,
  type OpenScenarioPlanActor,
  type OpenScenarioPlanDifference,
  type OpenScenarioPlanSample,
  type OpenScenarioPlanSignal,
  type OpenScenarioSignalChange,
  type OpenScenarioTraceComparison,
} from './execution-plan.js';
