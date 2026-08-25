import { z } from "zod";

/**
 * SimForge evaluation campaign artifacts — EvalLane's wave-3 layout
 * (authoritative, agreed over hub 2026-08-24):
 *
 *   $SIMFORGE_RUNS_ROOT/<campaignId>/campaign.json      frozen resolved spec
 *   $SIMFORGE_RUNS_ROOT/<campaignId>/ledger.jsonl       APPEND-ONLY, one line per completed episode
 *   $SIMFORGE_RUNS_ROOT/<campaignId>/report.json|.md    aggregation
 *   $SIMFORGE_RUNS_ROOT/<campaignId>/<episodeId>/       episodeId = <scenarioId>__<policyId>__seed<seed>
 *       trace.jsonl  events.json  score.json  provenance.json  runner-summary.json  COMPLETE
 *
 * There is no run level on disk: a "run" in the dashboard is one policyId
 * column of a campaign. Every object is `.passthrough()` so the runner can
 * add keys freely. Schema identifiers are frozen wire identifiers — never
 * rename (docs/engineering/simcloud-sync.md tripwire).
 */

export const EVAL_SCORE_SCHEMA = "simforge.eval-score/v1";
export const EVAL_EVENTS_SCHEMA = "simforge.eval-events/v1";
export const EVAL_PROVENANCE_SCHEMA = "simforge.eval-provenance/v1";
export const EVAL_REPORT_SCHEMA = "simforge.eval-report/v1";

/** One ledger.jsonl line: a completed episode. */
const EvalLedgerLineRawSchema = z
  .object({
    episodeId: z.string().min(1),
    scenarioId: z.string().min(1),
    policyId: z.string().min(1),
    seed: z.number().int().nonnegative(),
    status: z.string().min(1),
    /** Early runners wrote `score`; mini-w3 onward writes `drivingScore`. */
    score: z.number().optional(),
    drivingScore: z.number().optional(),
    routeCompletion: z.number(),
    traceSha256: z.string().min(1).optional(),
    episodeDigest: z.string().min(1).optional(),
    completedAt: z.string().min(1),
  })
  .passthrough();

export const EvalLedgerLineSchema = EvalLedgerLineRawSchema.refine(
  (line) => line.score !== undefined || line.drivingScore !== undefined,
  { message: "ledger line needs score or drivingScore" },
).transform((line) => ({ ...line, score: line.score ?? line.drivingScore ?? 0 }));
export type EvalLedgerLine = z.infer<typeof EvalLedgerLineSchema>;

/** campaign.json is runner-owned; we read only what the dashboard needs. */
export const EvalCampaignSpecSchema = z
  .object({
    campaignId: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    createdAt: z.string().min(1).optional(),
  })
  .passthrough();
export type EvalCampaignSpec = z.infer<typeof EvalCampaignSpecSchema>;

export const EvalScoreSchema = z
  .object({
    schema: z.literal(EVAL_SCORE_SCHEMA),
    episodeId: z.string().min(1),
    scenarioId: z.string().min(1),
    policyId: z.string().min(1),
    seed: z.number().int().nonnegative(),
    drivingScore: z.number(),
    routeCompletion: z.number(),
    penaltyProduct: z.number().optional(),
    infractions: z.record(z.number()),
    ttc: z
      .object({ minTtcS: z.number().nullable().optional(), criticalCount: z.number().optional() })
      .passthrough()
      .optional(),
    comfort: z
      .object({
        maxAbsAccelMps2: z.number().optional(),
        maxAbsJerkMps3: z.number().optional(),
        accelViolations: z.number().optional(),
        jerkViolations: z.number().optional(),
      })
      .passthrough()
      .optional(),
    terminal: z
      .object({ collision: z.boolean().optional(), goal: z.boolean().optional() })
      .passthrough()
      .optional(),
    steps: z.number().int().nonnegative(),
    deadlineMisses: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type EvalScore = z.infer<typeof EvalScoreSchema>;

export const EvalEventSchema = z
  .object({
    type: z.string().min(1),
    tick: z.number().int().nonnegative(),
    tS: z.number().nonnegative(),
    severity: z.enum(["info", "warning", "infraction"]),
    position: z.object({ x: z.number(), y: z.number() }).passthrough().nullable().optional(),
    data: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type EvalEvent = z.infer<typeof EvalEventSchema>;

export const EvalEventsSchema = z
  .object({
    schema: z.literal(EVAL_EVENTS_SCHEMA),
    episodeId: z.string().min(1),
    events: z.array(EvalEventSchema),
  })
  .passthrough();

export const EvalProvenanceSchema = z
  .object({
    schema: z.literal(EVAL_PROVENANCE_SCHEMA),
    campaignId: z.string().min(1),
    episodeId: z.string().min(1),
    scenario: z
      .object({ scenarioId: z.string().min(1), fixtureSha256: z.string().optional() })
      .passthrough(),
    policy: z
      .object({
        policyId: z.string().min(1),
        kind: z.string().min(1).optional(),
        checkpointDigest: z.string().min(1).optional(),
        adapterVersion: z.string().min(1).optional(),
      })
      .passthrough(),
    seed: z.number().int().nonnegative(),
    policySeed: z.number().int().nonnegative().optional(),
    decisionHz: z.number().positive().optional(),
    episodeDigest: z.string().optional(),
    traceSha256: z.string().optional(),
    createdAt: z.string().min(1).optional(),
  })
  .passthrough();
export type EvalProvenance = z.infer<typeof EvalProvenanceSchema>;

/**
 * One trace.jsonl decision line (policy-runner rich trace). The first line is
 * `{reset:{...}}` and the last is `{summary:{...}}`; both are skipped by the
 * reader. `sv` is the 10-float ego state vector:
 * [x, y, cosH, sinH, speed, accel, latOff, latRate, routeS, nearestRange].
 */
export const EvalTraceLineSchema = z
  .object({
    step: z.number().int().nonnegative(),
    t: z.number().nonnegative(),
    a: z.unknown().optional(),
    miss: z.union([z.boolean(), z.number()]).optional(),
    applied: z.unknown().optional(),
    rw: z.number().optional(),
    term: z.union([z.boolean(), z.number()]).optional(),
    trunc: z.union([z.boolean(), z.number()]).optional(),
    sv: z.array(z.number()).min(10),
    objs: z.array(z.array(z.union([z.number(), z.string()]))).optional(),
    terms: z.array(z.number()).optional(),
    timing: z
      .object({ infer_ms: z.number().optional(), roundtrip_ms: z.number().optional() })
      .passthrough()
      .optional(),
    /** Optional passthroughs the dashboard renders when present. */
    reasoning: z.string().optional(),
    frames: z
      .object({ thumbs: z.record(z.string().min(1)) })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type EvalTraceLine = z.infer<typeof EvalTraceLineSchema>;

export const EvalReportSchema = z
  .object({
    schema: z.literal(EVAL_REPORT_SCHEMA),
    campaignId: z.string().min(1),
    perScenario: z.array(
      z
        .object({
          scenarioId: z.string().min(1),
          policyId: z.string().min(1),
          episodes: z.number().int().nonnegative(),
          meanDrivingScore: z.number(),
          meanRouteCompletion: z.number().optional(),
          infractions: z.record(z.number()).optional(),
        })
        .passthrough(),
    ),
    aggregate: z.object({ drivingScore: z.number(), episodes: z.number() }).passthrough(),
    infractionHistogram: z.record(z.number()).optional(),
  })
  .passthrough();
export type EvalReport = z.infer<typeof EvalReportSchema>;

/** ── Dashboard view models (API payloads; not wire artifacts) ── */

/** One policy column of a campaign, aggregated from ledger.jsonl. */
export type EvalPolicySummary = {
  policyId: string;
  episodes: number;
  meanScore: number;
  meanRouteCompletion: number;
  infractionEpisodes: number;
  lastCompletedAt: string | null;
  /** simforge.* registry version whose checkpointDigest matches this policy. */
  modelVersionId: string | null;
};

export type EvalCampaignSummary = {
  campaignId: string;
  name: string;
  createdAt: string | null;
  episodes: number;
  hasReport: boolean;
  policies: EvalPolicySummary[];
};

export type EvalPolicyEpisode = {
  episodeId: string;
  scenarioId: string;
  seed: number;
  completedAt: string;
  score: EvalScore | null;
  /** Ledger-line score when score.json is missing. */
  ledgerScore: number;
  ledgerRouteCompletion: number;
};

export type EvalPolicyDetail = {
  campaignId: string;
  policy: EvalPolicySummary;
  provenanceSample: EvalProvenance | null;
  episodes: EvalPolicyEpisode[];
};

/** Normalized playback tick derived from a trace decision line. */
export type EvalViewTick = {
  step: number;
  tS: number;
  x: number;
  y: number;
  yawRad: number;
  speedMps: number;
  accelMps2: number;
  latOffM: number;
  miss: boolean;
  rw: number | null;
  inferMs: number | null;
  roundtripMs: number | null;
  reasoning: string | null;
  action: unknown;
  thumbs: Record<string, string> | null;
};

export type EvalEpisodePayload = {
  campaignId: string;
  episodeId: string;
  score: EvalScore | null;
  provenance: EvalProvenance | null;
  ticks: EvalViewTick[];
  events: EvalEvent[];
  complete: boolean;
};

export type EvalEpisodeComparison = {
  scenarioId: string;
  seed: number;
  aEpisodeId: string | null;
  bEpisodeId: string | null;
  aScore: number | null;
  bScore: number | null;
  /** b - a; null unless both sides completed the scenario+seed. */
  scoreDelta: number | null;
  /** First trace step where ego positions drift apart beyond the threshold. */
  divergenceStep: number | null;
  divergenceTS: number | null;
};

export type EvalRunComparison = {
  campaignId: string;
  divergenceThresholdM: number;
  a: EvalPolicySummary;
  b: EvalPolicySummary;
  episodes: EvalEpisodeComparison[];
};
