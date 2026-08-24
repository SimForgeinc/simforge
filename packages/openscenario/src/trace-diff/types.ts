export const TRACE_COMPARISON_FORMAT_VERSION = 1;
export const COMMON_SAMPLE_HZ = 50;
export const COMMON_DURATION_S = 20;

export type TraceSide = 'canonical' | 'external';
export type ComparisonProfileId = 'strict-trajectory-v1' | 'supported-actions-v1';
export type ComparisonVerdict = 'pass' | 'fail' | 'not-run';
export type FailureClass =
  | 'export-loss'
  | 'unsupported-semantic'
  | 'external-parse-runtime'
  | 'execution-divergence';

/** Converts source XY coordinates/headings into the canonical XODR-local frame. */
export interface FrameTransform {
  readonly translationM: readonly [number, number, number?];
  readonly rotationRad: number;
  readonly scale?: number;
}

export interface RawTraceSample {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly headingRad: number;
  readonly speedMps?: number;
  readonly accelerationMps2?: number;
  readonly roadId?: string | null;
  readonly laneId?: string | null;
  readonly laneRsl?: string | null;
  readonly s?: number | null;
  readonly offsetM?: number | null;
  readonly present?: boolean;
}

export interface RawTraceEntity {
  /** Stable simulator-side identifier. */
  readonly id: string;
  /** Optional display/catalog name used only for unambiguous fallback mapping. */
  readonly name?: string;
  readonly samples: readonly RawTraceSample[];
}

export interface ObservableEvent {
  readonly t: number;
  readonly kind: string;
  readonly actorIds: readonly string[];
  readonly sourceId?: string;
}

export interface ObservableCollision {
  readonly t: number;
  readonly actorIds: readonly [string, string];
}

/** A signal state edge, including the initial state at t=0 when observable. */
export interface ObservableSignalState {
  readonly t: number;
  readonly signalId: string;
  readonly state: string;
}

export interface ObservableEpisodeMetrics {
  readonly minClearanceM?: number | null;
  readonly minTtcS?: number | null;
  readonly minPetS?: number | null;
}

export interface RawExternalTrace {
  readonly format: string;
  readonly simulator: { readonly name: string; readonly version: string };
  readonly frameTransform: FrameTransform;
  /** Added before sampling, e.g. to remove an external warm-up/prologue. */
  readonly timeOffsetS?: number;
  readonly durationS: number;
  readonly completed: boolean;
  readonly entities: readonly RawTraceEntity[];
  readonly events?: readonly ObservableEvent[];
  readonly collisions?: readonly ObservableCollision[];
  readonly signals?: readonly ObservableSignalState[];
  readonly metrics?: ObservableEpisodeMetrics;
}

export interface EntityMappingOptions {
  /** external entity id -> canonical actor id; always takes precedence. */
  readonly explicit?: Readonly<Record<string, string>>;
  /** canonical actor id -> stable aliases expected from the exporter. */
  readonly aliases?: Readonly<Record<string, readonly string[]>>;
}

export interface EntityMappingEntry {
  readonly canonicalId: string;
  readonly externalId: string;
  readonly basis: 'explicit' | 'exact-id' | 'unique-alias' | 'unique-normalized-name';
}

export interface EntityMappingResult {
  readonly entries: readonly EntityMappingEntry[];
  readonly missingCanonicalIds: readonly string[];
  readonly extraExternalIds: readonly string[];
  readonly ambiguousExternalIds: readonly string[];
}

export interface NormalizedActorTrack {
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly z: readonly number[];
  readonly headingRad: readonly number[];
  readonly speedMps: readonly number[];
  readonly accelerationMps2: readonly number[];
  readonly roadId: readonly (string | null)[];
  readonly laneId: readonly (string | null)[];
  readonly laneRsl: readonly (string | null)[];
  readonly s: readonly (number | null)[];
  readonly offsetM: readonly (number | null)[];
  readonly present: readonly boolean[];
}

export interface NormalizedTrace {
  readonly side: TraceSide;
  readonly source: string;
  readonly sampleHz: 50;
  readonly durationS: 20;
  readonly t: readonly number[];
  /** Canonical actor ids on both sides after entity mapping. */
  readonly actors: Readonly<Record<string, NormalizedActorTrack>>;
  readonly events: readonly ObservableEvent[];
  readonly collisions: readonly ObservableCollision[];
  readonly signals: readonly ObservableSignalState[];
  readonly metrics: ObservableEpisodeMetrics;
  readonly completed: boolean;
  readonly sourceDurationS: number;
  readonly contentHash: string;
}

export interface DistributionMetric {
  readonly rmse: number;
  readonly p95: number;
  readonly max: number;
  readonly samples: number;
}

export interface ActorComparisonMetrics {
  readonly actorId: string;
  readonly xyM: DistributionMetric;
  readonly zM: DistributionMetric;
  readonly headingRad: DistributionMetric;
  readonly speedMps: DistributionMetric;
  readonly accelerationMps2: DistributionMetric;
  readonly roadAgreement: number | null;
  readonly laneAgreement: number | null;
  readonly laneRslAgreement: number | null;
  readonly sM: DistributionMetric | null;
  readonly offsetM: DistributionMetric | null;
  readonly presenceAgreement: number;
  readonly endState: {
    readonly positionErrorM: number | null;
    readonly headingErrorRad: number | null;
    readonly speedErrorMps: number | null;
    readonly presenceMatches: boolean;
  };
}

export interface ComparisonTolerances {
  readonly xyRmseM: number;
  readonly xyP95M: number;
  readonly xyMaxM: number;
  readonly zMaxM: number;
  readonly headingP95Rad: number;
  readonly speedP95Mps: number;
  readonly accelerationP95Mps2: number;
  readonly eventOnsetS: number;
  readonly collisionOnsetS: number;
  readonly signalOnsetS: number;
  readonly laneAgreementMin: number;
  readonly presenceAgreementMin: number;
  readonly durationToleranceS: number;
}

export interface ComparisonProfile {
  readonly id: ComparisonProfileId;
  readonly version: 1;
  readonly description: string;
  readonly tolerances: ComparisonTolerances;
  readonly requireAllActors: boolean;
  readonly requireEventOrder: boolean;
  readonly requireCollisionParity: boolean;
}

export interface ComparisonFinding {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly classification: FailureClass;
  readonly message: string;
  readonly actorId?: string;
  readonly observed?: number | string | boolean | null;
  readonly limit?: number | string | boolean | null;
}

export interface EventComparison {
  readonly key: string;
  readonly canonicalT: number | null;
  readonly externalT: number | null;
  readonly onsetErrorS: number | null;
  readonly orderMatches: boolean;
}

export interface CollisionComparison {
  readonly pair: readonly [string, string];
  readonly canonicalT: number | null;
  readonly externalT: number | null;
  readonly onsetErrorS: number | null;
}

export interface SignalComparison {
  readonly key: string;
  readonly canonicalT: number | null;
  readonly externalT: number | null;
  readonly onsetErrorS: number | null;
}

export interface ScenarioRubricSnapshot {
  readonly id: string;
  readonly version: string | number;
  readonly verdict: 'pass' | 'fail' | 'not-run';
  readonly criteriaPassed?: number;
  readonly criteriaTotal?: number;
  readonly contentHash?: string;
}

export interface TraceComparisonReport {
  readonly formatVersion: 1;
  readonly profile: ComparisonProfile;
  readonly verdict: ComparisonVerdict;
  readonly failureClasses: readonly FailureClass[];
  readonly mapping: EntityMappingResult;
  readonly canonicalTraceHash: string;
  readonly externalTraceHash: string;
  readonly reportHash: string;
  readonly actorMetrics: readonly ActorComparisonMetrics[];
  readonly globalMetrics: Omit<ActorComparisonMetrics, 'actorId' | 'endState'>;
  readonly eventComparison: readonly EventComparison[];
  readonly collisionComparison: readonly CollisionComparison[];
  readonly signalComparison: readonly SignalComparison[];
  readonly metricDelta: {
    readonly minClearanceM: number | null;
    readonly minTtcS: number | null;
    readonly minPetS: number | null;
  };
  readonly duration: {
    readonly canonicalS: number;
    readonly externalS: number;
    readonly externalCompleted: boolean;
  };
  /** Preserved from the normal scenario evaluator; this comparator never replaces it. */
  readonly scenarioRubric?: ScenarioRubricSnapshot;
  readonly unsupportedSemantics: readonly string[];
  readonly findings: readonly ComparisonFinding[];
}

export interface TraceComparisonOptions {
  readonly profile?: ComparisonProfileId | ComparisonProfile;
  readonly unsupportedSemantics?: readonly string[];
  readonly scenarioRubric?: ScenarioRubricSnapshot;
  /** Event kinds the target exposes. Missing occurrences of these kinds are failures; unobservable kinds are not guessed. */
  readonly observableEventKinds?: readonly string[];
  /** Supplied by the runner when no comparable external trace could be produced. */
  readonly externalFailure?: {
    readonly stage: 'export' | 'parse' | 'runtime';
    readonly message: string;
  };
}

export interface ComparisonUiModel {
  readonly status: ComparisonVerdict;
  readonly headline: string;
  readonly reportHash: string;
  readonly summary: readonly { readonly label: string; readonly value: string; readonly status: 'ok' | 'warn' | 'error' }[];
  readonly actorRows: readonly {
    readonly actorId: string;
    readonly positionP95M: number;
    readonly headingP95Deg: number;
    readonly speedP95Mps: number;
    readonly presencePercent: number;
    readonly status: 'ok' | 'error';
  }[];
  readonly findings: readonly ComparisonFinding[];
}

export interface DualTraceFrame {
  readonly t: number;
  readonly actors: Readonly<Record<string, {
    readonly canonical: { readonly x: number; readonly y: number; readonly z: number; readonly headingRad: number; readonly present: boolean } | null;
    readonly external: { readonly x: number; readonly y: number; readonly z: number; readonly headingRad: number; readonly present: boolean } | null;
    readonly positionErrorM: number | null;
  }>>;
}

export interface DualTracePlaybackData {
  readonly sampleHz: 50;
  readonly durationS: 20;
  readonly canonicalTraceHash: string;
  readonly externalTraceHash: string;
  readonly frames: readonly DualTraceFrame[];
}
