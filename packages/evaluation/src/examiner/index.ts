/**
 * ../index.js — WS2 Examiner: the faithfulness critic.
 *
 * Layered so truth never leaves deterministic code:
 * - `claims.ts`        — the versioned claims.v1 schema (parse + JSON Schema);
 * - `timeline.ts`      — ground-truth timelines from the rl-env causal channel;
 * - `checkers.ts`      — deterministic proposition checkers;
 * - `ground-truth.ts`  — true claim sets derived from engine artifacts;
 * - `grader.ts`        — scalar score + causality/coverage decomposition (WS7 contract);
 * - `perturb.ts`       — known-position corruptions for the grader benchmark;
 * - `benchmark.ts`     — precision/recall of error recovery on the perturbed set;
 * - `extractor/*`      — NL→schema parsing only (never truth judgment).
 */

export {
  CAUSAL_GAP_S,
  CLAIMS_SCHEMA_ID,
  CLAIMS_SCHEMA_VERSION,
  CLAIMS_V1_JSON_SCHEMA,
  EVENT_LOCATE_SLACK_S,
  INTENT_VERBS,
  SPATIAL_RELATIONS,
  claimSchema,
  claimSetSchema,
  eventRefSchema,
  tickRangeSchema,
} from './claims.js';
export type { Claim, ClaimSet, EventRef } from './claims.js';

export {
  OBJECT_LIST_RANGE_M,
  SPATIAL_MARGIN_M,
  allGenesis,
  allTriggers,
  egoFrameOffsets,
  frameAt,
  losTimeline,
  pairEvaluated,
} from './timeline.js';
export type { LosSample } from './timeline.js';

export { checkClaim, checkClaims, intentVerbOf } from './checkers.js';
export type { Verdict, VerdictStatus } from './checkers.js';

export { deriveTrueClaims, resetClaimIds } from './ground-truth.js';

export { grade } from './grader.js';
export type { GraderOptions, GraderReport, UncoveredTruth } from './grader.js';

export { RECOVERY_GATE, MAX_TARGETS_PER_OP, buildCases, runBenchmark } from './benchmark.js';
export type { BenchmarkReport, CaseOutcome, OpBreakdown } from './benchmark.js';

export { applyPerturbation, perturbationTargets } from './perturb.js';
export type { InjectedError, PerturbedCase, PerturbationOp } from './perturb.js';

export { extractClaims, ExtractionError } from './extractor/extract.js';
export type { CompletionFn, ExtractOptions } from './extractor/extract.js';
export {
  EXTRACTION_RESPONSE_FORMAT,
  EXTRACTION_SYSTEM_PROMPT,
  extractionUserPrompt,
  scenarioContextLine,
} from './extractor/prompt.js';
export { openAiCompatibleCompletion } from './extractor/openai-compatible.js';
export type { OpenAiCompatibleOptions } from './extractor/openai-compatible.js';
