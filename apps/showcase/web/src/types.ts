export type Engine = 'auto' | 'compiler' | 'vista2';
export type Status = 'pending' | 'running' | 'complete' | 'failed' | string;

export interface Artifact { path?: string; url?: string; name?: string; type?: string }
export interface StageEvent { stage: string; status: Status; artifacts?: Artifact[]; elapsedMs?: number; [key: string]: unknown }
export interface CellAcceptance {
  contract?: { version?: string };
  gatePassed?: boolean;
  semanticScreened?: boolean;
  semanticConfidence?: number | null;
  renderTier?: '2d' | '3d';
  renderStatus?: string | null;
}
export interface CellDecision {
  semanticAccepted?: boolean; accepted?: boolean;
  defectCodes?: string[]; unsupportedReason?: string | null; acceptance?: CellAcceptance;
}
export interface CellVerdict {
  cellId?: string; id?: string; map?: string;
  gate?: { pass?: boolean; admitted?: boolean; firstFailure?: string } | boolean;
  product?: CellDecision;
  artifacts?: Artifact[]; [key: string]: unknown;
}
export interface JobIndex {
  jobId?: string; id?: string; brief?: string; status?: Status; engine?: Engine;
  options?: Record<string, unknown>; stages?: StageEvent[] | Record<string, unknown>;
  cells?: CellVerdict[] | Record<string, CellVerdict>; artifacts?: Artifact[];
  [key: string]: unknown;
}
export interface IndexedFile { path: string; size?: number; json?: unknown; jsonError?: boolean }
export interface RawJobIndex { jobId: string; files: IndexedFile[] }
export interface GalleryCard {
  jobId?: string; id?: string; brief?: string; headline?: string; engine?: Engine;
  maps?: string[]; admitted?: number; total?: number; admittedCells?: number; totalCells?: number;
  realism?: number; dynamism?: number; media?: string; headlineArtifact?: string;
  artifacts?: Artifact[]; [key: string]: unknown;
}
export interface SubmitPayload {
  brief: string; methodology: 'production' | 'custom'; engine: Engine; nScenarios: number;
  maps: string[]; maxSitesPerMap: number;
  ambient: 'off' | 'light' | 'moderate' | 'city' | 'heavy'; seed: number;
  render3d: boolean; topK: number;
}

export type CampaignAttemptStatus = 'queued' | 'running' | 'complete' | 'failed' | string;
export type CampaignCaseState = 'complete' | 'running' | 'blocked' | 'idle' | 'unsupported';
export type BenchmarkOutcome = 'accepted' | 'attempting' | 'exhausted' | 'unsupported' | 'pending';

export interface Rate {
  numerator: number;
  denominator: number;
  value: number | null;
  wilson95: { low: number; high: number; z: number } | null;
}
export interface HourlyRate {
  numerator: number;
  denominatorHours: number | null;
  value: number | null;
}
export interface Distribution {
  n: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
  total: number | null;
}
export interface FunnelStage {
  id: string;
  label: string;
  phase: string;
  evidence: string;
  reached: number;
  denominator: number;
  denominatorStage: string;
  stepRate: Rate;
  cumulativeRate: Rate;
  cumulativeDenominatorLabel: string;
  censoredHere: number;
}
export interface BenchmarkThroughput {
  elapsedHours: number;
  generator: {
    boundary: string;
    attempts: number;
    gatePassedAttempts: number;
    gatePassedCells: number;
    eligibleAttempts: number;
    eligibleCells: number;
    yield: Rate;
    gateYield: Rate;
    wallS: Distribution;
    stageWallS: Record<string, Distribution>;
    attemptsPerHour: HourlyRate;
    gatePassedAttemptsPerHour: HourlyRate;
    eligibleAttemptsPerHour: HourlyRate;
    eligibleCellsPerHour: HourlyRate;
    tokensPerEligibleAttempt: number | null;
  };
  product: {
    boundary: string;
    attempts: number;
    acceptedAttempts: number;
    acceptedCells: number;
    yield: Rate;
    wallS: Distribution;
    renderWallS: Distribution;
    stageWallS: Record<string, Distribution>;
    attemptsPerHour: HourlyRate;
    acceptedAttemptsPerHour: HourlyRate;
    acceptedCellsPerHour: HourlyRate;
    tokensPerAcceptedCell: number | null;
  };
  note: string;
}
export interface BenchmarkDiversity {
  videos: number;
  distinctVideoSha256: number;
  distinctTrajectoryFingerprints: number;
  unfingerprintedVideos: number;
  trajectoryDistinctness: Rate;
  videoDigestDistinctness: Rate;
  reencodedOnlyGroups: Array<{
    trajectoryFingerprint: string;
    videos: number;
    distinctVideoSha256: number;
    cellIds: Array<string | null>;
  }>;
  reencodedOnlyVideos: number;
  maps: { distinct: number; coverage: Rate; balance: number | null; histogram: Record<string, number> };
  sites: { distinct: number; perVideo: Rate; balance: number | null; histogram: Record<string, number> };
  pairwise: { pairs: number; absoluteM: Distribution; shapeM: Distribution; speedMps: Distribution };
  note: string;
}
export interface BenchmarkCorpus {
  entries: number;
  reported: number;
  outcomes: Record<BenchmarkOutcome, number>;
  accountedFor: boolean;
  resolved: number;
  attemptBudgetPerCase: number;
  note: string;
}
export interface BenchmarkUnsupportedReason {
  id?: string;
  title?: string;
  reason: string;
  detail?: string;
  evidence?: string[];
  agreeingAttempts: number;
  attempts: number[];
  minimumAgreeingAttempts: number;
}
export interface BenchmarkCaseRow {
  id: string;
  title: string;
  index: number;
  priority: number | null;
  outcome: BenchmarkOutcome;
  resolved: boolean;
  target: number;
  acceptedVideos: number;
  submittedAttempts: number;
  generationAttempts: number;
  operationalFailures: number;
  activeAttempts: number;
  attemptBudget: number;
  furthestStage: string | null;
  semanticAccepted: boolean;
  productAccepted: boolean;
  defectCodes: string[];
  unsupportedReason: string | null;
}
export interface BenchmarkExecution {
  attempts: number;
  cold: Rate & { basis: string[]; note: string };
  resumed: Rate & { stages: Record<string, number>; note: string };
  concurrency: {
    activeJobsAtStart: Distribution;
    peakActiveJobs: Distribution;
    logicalCpus: Record<string, number>;
    load1AtStart: Distribution;
    load1AtSimulation: Distribution;
    scheduler: Record<string, number>;
    note: string;
  };
  models: {
    author: Record<string, number>;
    engineRequested: Record<string, number>;
    engineResolved: Record<string, number>;
    note: string;
  };
}

export interface CampaignBenchmark {
  schema: 'showcase-benchmark-report/v1';
  campaignId: string;
  generatedAt: string;
  corpus: BenchmarkCorpus;
  denominators: {
    corpusEntries: number;
    coverageDenominator: number;
    qualityDenominator: number;
    submittedAttempts: number;
    generatorAttempts: number;
    productAttempts: number;
    operationalFailures: number;
    note: string;
  };
  coverage: {
    entriesReported: Rate;
    accepted: Rate;
    unsupported: Rate;
    attemptedOrResolved: Rate;
  };
  quality: {
    acceptedOfSupported: Rate;
    semanticAcceptedOfSupported: Rate;
    productAcceptedOfSupported: Rate;
  };
  funnel: {
    stages: FunnelStage[];
    monotone: boolean;
    denominators: {
      submittedAttempts: number;
      generatorAttempts: number;
      productAttempts: number;
      operationalFailures: number;
    };
    note: string;
  };
  throughput: BenchmarkThroughput;
  cost: {
    wallS: Distribution;
    tokens: CampaignUsage & { dollarCost: Record<string, number> | null; dollarCostNote: string };
    cpu: { measuredAttempts: number; totalS: Distribution; exclusivelyAttributedAttempts: number; attributionNote: string };
    gpu: { measuredAttempts: number; gpuSecondsEquivalent: Distribution; attributionNote: string };
  };
  execution: BenchmarkExecution;
  diversity: BenchmarkDiversity;
  operational: {
    attempts: number;
    byClass: Record<string, number>;
    shareOfSubmitted: Rate;
    excludedFromGenerationDenominator: boolean;
    note: string;
  };
  defects: { vocabulary: string[]; attemptsByCode: Record<string, number>; unclassifiedAttempts: number };
  unsupported: BenchmarkUnsupportedReason[];
  cases: BenchmarkCaseRow[];
  verification?: { violations: string[]; consistent: boolean };
}

export interface CampaignUsage { calls: number; inputTokens: number; outputTokens: number; reasoningTokens: number; modelWallS: number }
export interface CampaignAttemptMetrics {
  wallS?: number; stageSeconds?: Record<string, number>; tokens?: CampaignUsage;
  tokenAccounting?: {
    version?: number; authorEvidenceFiles?: number; visionVerdicts?: number;
    dollarCost?: number | null; note?: string;
  };
}
export interface CampaignAttempt {
  number: number; jobId: string; seed?: number; status: CampaignAttemptStatus;
  submittedAt?: string; finishedAt?: string; acceptedVideos?: number; error?: string; metrics?: CampaignAttemptMetrics;
}
export interface CampaignVideo {
  sha256: string; jobId?: string; cellId?: string; source?: string; url: string;
  mapId?: string | null; acceptedAt?: string;
  semanticAccepted?: boolean; accepted?: boolean;
  productContractVersion?: string;
}
export interface CampaignCase {
  id: string; title: string; index: number; attempts: CampaignAttempt[]; validVideos: CampaignVideo[];
  outcome: BenchmarkOutcome | null; unsupported: BenchmarkUnsupportedReason | null;
  generationAttempts: number; operationalFailures: number;
}
export interface CampaignTotals {
  cases: number; completeCases: number; targetVideos: number; validVideos: number;
  jobs: number; activeJobs: number; failedJobs: number; wallS: number;
  stageSeconds: Record<string, number>; tokens: CampaignUsage;
  elapsedHours: number; validVideosPerHour: HourlyRate; jobsPerHour: HourlyRate;
  minimumObservationHours?: number; meanTokensPerValidVideo: number | null;
  benchmark?: CampaignBenchmark;
}
export interface CampaignValidityContract {
  semanticAcceptedRequired?: boolean; acceptedRequired?: boolean;
  frozenGateRequired?: boolean; briefAware2dSemanticOracleRequired?: boolean;
  uniqueVideoSha256Required?: boolean; durableCampaignCopyRequired?: boolean;
  currentProductContractRequired?: boolean; productContractVersion?: string;
  minimumPerCase?: number; canonicalDecisionFields?: string[];
  maxGenerationAttempts?: number; operationalFailuresConsumeAttempts?: boolean;
  distinctTrajectoryFingerprintRequired?: boolean;
}
export interface CampaignReport {
  campaignId: string; targetValidVideos: number; methodology?: string; version?: number;
  startedAt?: string; updatedAt: string; cases: CampaignCase[]; totals: CampaignTotals;
  validityContract: CampaignValidityContract;
}
export interface CampaignCaseProgress {
  state: CampaignCaseState; outcome: BenchmarkOutcome | null; unsupportedReason: string | null;
  accepted: number; target: number;
  attempts: number; active: number; failed: number; latest?: CampaignAttempt;
}
