import { contentHash } from '@simforge/engine';
import {
  TRACE_COMPARISON_FORMAT_VERSION,
  type ActorComparisonMetrics,
  type CollisionComparison,
  type ComparisonFinding,
  type ComparisonProfile,
  type ComparisonProfileId,
  type ComparisonUiModel,
  type DistributionMetric,
  type DualTracePlaybackData,
  type EntityMappingResult,
  type EventComparison,
  type FailureClass,
  type NormalizedActorTrack,
  type NormalizedTrace,
  type ObservableCollision,
  type ObservableEvent,
  type ObservableSignalState,
  type SignalComparison,
  type TraceComparisonOptions,
  type TraceComparisonReport,
} from './types.js';
import { headingDeltaRad } from './normalize.js';

export const COMPARISON_PROFILES: Readonly<Record<ComparisonProfileId, ComparisonProfile>> = {
  'strict-trajectory-v1': {
    id: 'strict-trajectory-v1',
    version: 1,
    description: 'Trajectory-baked parity: tight 50 Hz motion, event, collision, lane, and completion agreement.',
    tolerances: {
      xyRmseM: 0.1, xyP95M: 0.2, xyMaxM: 0.25, zMaxM: 0.25,
      headingP95Rad: Math.PI / 180, speedP95Mps: 0.2, accelerationP95Mps2: 0.75,
      eventOnsetS: 0.02, collisionOnsetS: 0.02, signalOnsetS: 0.02, laneAgreementMin: 0.995,
      presenceAgreementMin: 0.999, durationToleranceS: 0.02,
    },
    requireAllActors: true,
    requireEventOrder: true,
    requireCollisionParity: true,
  },
  'supported-actions-v1': {
    id: 'supported-actions-v1',
    version: 1,
    description: 'Native supported-action contract: permits integration differences while preserving scenario behavior.',
    tolerances: {
      xyRmseM: 0.75, xyP95M: 1.5, xyMaxM: 3, zMaxM: 1,
      headingP95Rad: 5 * Math.PI / 180, speedP95Mps: 1, accelerationP95Mps2: 2.5,
      eventOnsetS: 0.25, collisionOnsetS: 0.1, signalOnsetS: 0.25, laneAgreementMin: 0.95,
      presenceAgreementMin: 0.99, durationToleranceS: 0.02,
    },
    requireAllActors: true,
    requireEventOrder: true,
    requireCollisionParity: true,
  },
};

const emptyDistribution = (): DistributionMetric => ({ rmse: 0, p95: 0, max: 0, samples: 0 });

function distribution(values: readonly number[]): DistributionMetric {
  if (values.length === 0) return emptyDistribution();
  const sorted = [...values].sort((a, b) => a - b);
  return {
    rmse: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length),
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    max: sorted[sorted.length - 1]!,
    samples: values.length,
  };
}

function agreement(a: readonly (string | null)[], b: readonly (string | null)[], mask: readonly boolean[]): number | null {
  let observed = 0, matches = 0;
  for (let i = 0; i < mask.length; i++) {
    // Lane identity namespaces are only comparable when both simulators emit
    // the dimension. A one-sided null is "not observable", not disagreement.
    if (!mask[i] || a[i] == null || b[i] == null) continue;
    observed++;
    if (a[i] === b[i]) matches++;
  }
  return observed === 0 ? null : matches / observed;
}

function nullableErrors(a: readonly (number | null)[], b: readonly (number | null)[], mask: readonly boolean[]): DistributionMetric | null {
  const values: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] && a[i] != null && b[i] != null) values.push(Math.abs(a[i]! - b[i]!));
  return values.length === 0 ? null : distribution(values);
}

interface ActorErrors {
  xy: number[]; z: number[]; heading: number[]; speed: number[]; acceleration: number[];
  s: number[]; offset: number[];
}

function actorMetrics(actorId: string, a: NormalizedActorTrack, b: NormalizedActorTrack): { metrics: ActorComparisonMetrics; errors: ActorErrors } {
  const both = a.present.map((present, i) => present && b.present[i]!);
  const errors: ActorErrors = { xy: [], z: [], heading: [], speed: [], acceleration: [], s: [], offset: [] };
  let presenceMatches = 0;
  for (let i = 0; i < both.length; i++) {
    if (a.present[i] === b.present[i]) presenceMatches++;
    if (!both[i]) continue;
    errors.xy.push(Math.hypot(a.x[i]! - b.x[i]!, a.y[i]! - b.y[i]!));
    errors.z.push(Math.abs(a.z[i]! - b.z[i]!));
    errors.heading.push(Math.abs(headingDeltaRad(a.headingRad[i]!, b.headingRad[i]!)));
    errors.speed.push(Math.abs(a.speedMps[i]! - b.speedMps[i]!));
    errors.acceleration.push(Math.abs(a.accelerationMps2[i]! - b.accelerationMps2[i]!));
    if (a.s[i] != null && b.s[i] != null) errors.s.push(Math.abs(a.s[i]! - b.s[i]!));
    if (a.offsetM[i] != null && b.offsetM[i] != null) errors.offset.push(Math.abs(a.offsetM[i]! - b.offsetM[i]!));
  }
  let end = both.length - 1;
  while (end >= 0 && !both[end]) end--;
  return {
    errors,
    metrics: {
      actorId,
      xyM: distribution(errors.xy), zM: distribution(errors.z), headingRad: distribution(errors.heading),
      speedMps: distribution(errors.speed), accelerationMps2: distribution(errors.acceleration),
      roadAgreement: agreement(a.roadId, b.roadId, both),
      laneAgreement: agreement(a.laneId, b.laneId, both),
      laneRslAgreement: agreement(a.laneRsl, b.laneRsl, both),
      sM: nullableErrors(a.s, b.s, both), offsetM: nullableErrors(a.offsetM, b.offsetM, both),
      presenceAgreement: presenceMatches / both.length,
      endState: {
        positionErrorM: end < 0 ? null : Math.hypot(a.x[end]! - b.x[end]!, a.y[end]! - b.y[end]!, a.z[end]! - b.z[end]!),
        headingErrorRad: end < 0 ? null : Math.abs(headingDeltaRad(a.headingRad[end]!, b.headingRad[end]!)),
        speedErrorMps: end < 0 ? null : Math.abs(a.speedMps[end]! - b.speedMps[end]!),
        presenceMatches: a.present.at(-1) === b.present.at(-1),
      },
    },
  };
}

function eventKey(event: ObservableEvent): string {
  return `${event.kind}:${[...event.actorIds].sort().join('+')}:${event.sourceId ?? ''}`;
}

function compareEvents(canonical: readonly ObservableEvent[], external: readonly ObservableEvent[]): EventComparison[] {
  const grouped = (events: readonly ObservableEvent[]) => {
    const map = new Map<string, ObservableEvent[]>();
    for (const event of events.filter((item) => item.kind !== 'collision')) {
      const key = eventKey(event);
      map.set(key, [...(map.get(key) ?? []), event]);
    }
    return map;
  };
  const a = grouped(canonical), b = grouped(external);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: EventComparison[] = [];
  const indexedOrder = (events: readonly ObservableEvent[]) => {
    const counts = new Map<string, number>();
    const positions = new Map<string, number>();
    events.filter((item) => item.kind !== 'collision').forEach((event, position) => {
      const base = eventKey(event);
      const occurrence = (counts.get(base) ?? 0) + 1;
      counts.set(base, occurrence);
      positions.set(`${base}#${occurrence}`, position);
    });
    return positions;
  };
  const canonicalOrder = indexedOrder(canonical);
  const externalOrder = indexedOrder(external);
  for (const key of keys) {
    const aa = a.get(key) ?? [], bb = b.get(key) ?? [];
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
      const at = aa[i]?.t ?? null, bt = bb[i]?.t ?? null;
      const occurrenceKey = `${key}#${i + 1}`;
      out.push({
        key: aa.length > 1 || bb.length > 1 ? `${key}#${i + 1}` : key,
        canonicalT: at, externalT: bt,
        onsetErrorS: at === null || bt === null ? null : Math.abs(at - bt),
        orderMatches: canonicalOrder.get(occurrenceKey) === externalOrder.get(occurrenceKey),
      });
    }
  }
  return out;
}

function collisionKey(collision: ObservableCollision): string { return [...collision.actorIds].sort().join('+'); }

function compareCollisions(canonical: readonly ObservableCollision[], external: readonly ObservableCollision[]): CollisionComparison[] {
  const first = (events: readonly ObservableCollision[]) => new Map(events.map((event) => [collisionKey(event), event.t]));
  const a = first(canonical), b = first(external);
  return [...new Set([...a.keys(), ...b.keys()])].sort().map((key) => {
    const at = a.get(key) ?? null, bt = b.get(key) ?? null;
    return {
      pair: key.split('+') as [string, string], canonicalT: at, externalT: bt,
      onsetErrorS: at === null || bt === null ? null : Math.abs(at - bt),
    };
  });
}

function compareSignals(canonical: readonly ObservableSignalState[], external: readonly ObservableSignalState[]): SignalComparison[] {
  const grouped = (signals: readonly ObservableSignalState[]) => {
    const groups = new Map<string, number[]>();
    for (const signal of signals) {
      const key = `${signal.signalId}:${signal.state}`;
      groups.set(key, [...(groups.get(key) ?? []), signal.t]);
    }
    return groups;
  };
  const a = grouped(canonical), b = grouped(external);
  const result: SignalComparison[] = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const aa = a.get(key) ?? [], bb = b.get(key) ?? [];
    for (let index = 0; index < Math.max(aa.length, bb.length); index++) {
      const canonicalT = aa[index] ?? null, externalT = bb[index] ?? null;
      result.push({
        key: Math.max(aa.length, bb.length) > 1 ? `${key}#${index + 1}` : key,
        canonicalT,
        externalT,
        onsetErrorS: canonicalT === null || externalT === null ? null : Math.abs(canonicalT - externalT),
      });
    }
  }
  return result;
}

function delta(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null || b == null ? null : b - a;
}

function addThresholdFindings(metrics: ActorComparisonMetrics, profile: ComparisonProfile, findings: ComparisonFinding[]): void {
  const checks: Array<[string, number, number, string]> = [
    ['xy-rmse', metrics.xyM.rmse, profile.tolerances.xyRmseM, 'position RMSE (m)'],
    ['xy-p95', metrics.xyM.p95, profile.tolerances.xyP95M, 'position p95 (m)'],
    ['xy-max', metrics.xyM.max, profile.tolerances.xyMaxM, 'position max (m)'],
    ['z-max', metrics.zM.max, profile.tolerances.zMaxM, 'elevation max (m)'],
    ['heading-p95', metrics.headingRad.p95, profile.tolerances.headingP95Rad, 'heading p95 (rad)'],
    ['speed-p95', metrics.speedMps.p95, profile.tolerances.speedP95Mps, 'speed p95 (m/s)'],
    ['acceleration-p95', metrics.accelerationMps2.p95, profile.tolerances.accelerationP95Mps2, 'acceleration p95 (m/s²)'],
  ];
  for (const [code, observed, limit, label] of checks) if (observed > limit) findings.push({
    code: `actor-${code}`, severity: 'error', classification: 'execution-divergence', actorId: metrics.actorId,
    message: `${metrics.actorId} ${label} ${observed.toFixed(4)} exceeds ${limit.toFixed(4)}`, observed, limit,
  });
  const lane = metrics.laneRslAgreement ?? metrics.laneAgreement ?? metrics.roadAgreement;
  if (lane !== null && lane < profile.tolerances.laneAgreementMin) findings.push({
    code: 'actor-lane-agreement', severity: 'error', classification: 'execution-divergence', actorId: metrics.actorId,
    message: `${metrics.actorId} lane/road agreement is ${(lane * 100).toFixed(2)}%`, observed: lane, limit: profile.tolerances.laneAgreementMin,
  });
  if (metrics.presenceAgreement < profile.tolerances.presenceAgreementMin) findings.push({
    code: 'actor-presence-agreement', severity: 'error', classification: 'execution-divergence', actorId: metrics.actorId,
    message: `${metrics.actorId} presence agreement is ${(metrics.presenceAgreement * 100).toFixed(2)}%`,
    observed: metrics.presenceAgreement, limit: profile.tolerances.presenceAgreementMin,
  });
}

function addRequiredOccupancyFinding(
  actorId: string,
  canonical: NormalizedActorTrack,
  external: NormalizedActorTrack,
  profile: ComparisonProfile,
  findings: ComparisonFinding[],
): void {
  if (profile.id !== 'strict-trajectory-v1') return;
  const dimensions = [
    ['laneRsl', canonical.laneRsl, external.laneRsl],
    ['laneId', canonical.laneId, external.laneId],
    ['roadId', canonical.roadId, external.roadId],
  ] as const;
  for (const [dimension, expected, observed] of dimensions) {
    const requiredIndices = expected.flatMap((value, index) => canonical.present[index] && value !== null ? [index] : []);
    if (requiredIndices.length === 0) continue;
    const available = requiredIndices.filter((index) => external.present[index] && observed[index] !== null).length;
    const coverage = available / requiredIndices.length;
    if (coverage < 1) findings.push({
      code: 'actor-occupancy-missing', severity: 'error', classification: 'export-loss', actorId,
      message: `${actorId} external trace supplies ${(coverage * 100).toFixed(2)}% of required ${dimension} occupancy samples`,
      observed: coverage, limit: 1,
    });
  }
}

export function compareNormalizedTraces(
  canonical: NormalizedTrace,
  external: NormalizedTrace,
  mapping: EntityMappingResult,
  options: TraceComparisonOptions = {},
): TraceComparisonReport {
  if (canonical.side !== 'canonical' || external.side !== 'external') throw new Error('Trace sides must be canonical and external');
  const profile = typeof options.profile === 'object' ? options.profile : COMPARISON_PROFILES[options.profile ?? 'strict-trajectory-v1'];
  const findings: ComparisonFinding[] = [];
  if (options.externalFailure) findings.push({
    code: `external-${options.externalFailure.stage}-failure`, severity: 'error',
    classification: options.externalFailure.stage === 'export' ? 'export-loss' : 'external-parse-runtime',
    message: options.externalFailure.message,
  });
  for (const id of mapping.missingCanonicalIds) findings.push({
    code: 'missing-external-actor', severity: profile.requireAllActors ? 'error' : 'warning', classification: 'export-loss',
    actorId: id, message: `Canonical actor ${id} is absent from the external trace`,
  });
  for (const id of mapping.ambiguousExternalIds) findings.push({
    code: 'ambiguous-actor-mapping', severity: 'error', classification: 'export-loss',
    message: `External actor ${id} cannot be mapped unambiguously`,
  });
  for (const id of mapping.extraExternalIds) findings.push({
    code: 'unexpected-external-actor', severity: 'error', classification: 'export-loss',
    actorId: id, message: `External actor ${id} is not present in the canonical actor closure`,
  });
  for (const semantic of [...(options.unsupportedSemantics ?? [])].sort()) findings.push({
    code: 'unsupported-semantic',
    severity: profile.id === 'strict-trajectory-v1' ? 'error' : 'warning',
    classification: 'unsupported-semantic', message: semantic,
  });
  const ids = Object.keys(canonical.actors).filter((id) => external.actors[id]).sort();
  const compared = ids.map((id) => actorMetrics(id, canonical.actors[id]!, external.actors[id]!));
  for (const item of compared) {
    addThresholdFindings(item.metrics, profile, findings);
    addRequiredOccupancyFinding(item.metrics.actorId, canonical.actors[item.metrics.actorId]!, external.actors[item.metrics.actorId]!, profile, findings);
  }
  const allErrors = (key: keyof ActorErrors) => compared.flatMap((item) => item.errors[key]);
  const aggregateAgreement = (key: 'roadAgreement' | 'laneAgreement' | 'laneRslAgreement') => {
    const values = compared.map((item) => item.metrics[key]).filter((value): value is number => value !== null);
    return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  };
  const globalMetrics = {
    xyM: distribution(allErrors('xy')), zM: distribution(allErrors('z')), headingRad: distribution(allErrors('heading')),
    speedMps: distribution(allErrors('speed')), accelerationMps2: distribution(allErrors('acceleration')),
    roadAgreement: aggregateAgreement('roadAgreement'), laneAgreement: aggregateAgreement('laneAgreement'),
    laneRslAgreement: aggregateAgreement('laneRslAgreement'),
    sM: allErrors('s').length === 0 ? null : distribution(allErrors('s')),
    offsetM: allErrors('offset').length === 0 ? null : distribution(allErrors('offset')),
    presenceAgreement: compared.length === 0 ? 0 : compared.reduce((sum, item) => sum + item.metrics.presenceAgreement, 0) / compared.length,
  };
  const observableKinds = new Set(options.observableEventKinds ?? external.events.map((event) => event.kind));
  const eventComparison = compareEvents(
    canonical.events.filter((event) => observableKinds.has(event.kind)),
    external.events.filter((event) => observableKinds.has(event.kind)),
  );
  for (const event of eventComparison) {
    if (event.canonicalT === null || event.externalT === null || (event.onsetErrorS ?? Infinity) > profile.tolerances.eventOnsetS || (profile.requireEventOrder && !event.orderMatches)) findings.push({
      code: 'event-parity', severity: 'error', classification: event.externalT === null ? 'export-loss' : 'execution-divergence',
      message: `Event ${event.key} did not meet onset/order parity`, observed: event.onsetErrorS, limit: profile.tolerances.eventOnsetS,
    });
  }
  const collisionComparison = compareCollisions(canonical.collisions, external.collisions);
  if (profile.requireCollisionParity) for (const collision of collisionComparison) {
    if (collision.canonicalT === null || collision.externalT === null || (collision.onsetErrorS ?? Infinity) > profile.tolerances.collisionOnsetS) findings.push({
      code: 'collision-parity', severity: 'error', classification: 'execution-divergence',
      message: `Collision ${collision.pair.join('/')} differs between simulations`, observed: collision.onsetErrorS, limit: profile.tolerances.collisionOnsetS,
    });
  }
  const signalComparison = compareSignals(canonical.signals, external.signals);
  for (const signal of signalComparison) {
    if (signal.canonicalT === null || signal.externalT === null || (signal.onsetErrorS ?? Infinity) > profile.tolerances.signalOnsetS + 1e-9) findings.push({
      code: 'signal-parity', severity: 'error',
      classification: signal.externalT === null ? 'export-loss' : 'execution-divergence',
      message: `Signal edge ${signal.key} differs between simulations`,
      observed: signal.onsetErrorS, limit: profile.tolerances.signalOnsetS,
    });
  }
  const durationError = Math.abs(canonical.sourceDurationS - external.sourceDurationS);
  if (!canonical.completed || !external.completed || durationError > profile.tolerances.durationToleranceS) findings.push({
    code: 'duration-completion', severity: 'error', classification: 'execution-divergence',
    message: 'External replay did not complete the canonical 20-second clip', observed: external.sourceDurationS, limit: canonical.sourceDurationS,
  });
  if (options.scenarioRubric?.verdict === 'fail') findings.push({
    code: 'scenario-rubric-failed', severity: 'error', classification: 'execution-divergence',
    message: `Scenario-specific intent rubric ${options.scenarioRubric.id} failed`,
  });
  findings.sort((a, b) => a.code.localeCompare(b.code) || (a.actorId ?? '').localeCompare(b.actorId ?? '') || a.message.localeCompare(b.message));
  const failureClasses = [...new Set(findings.filter((item) => item.severity === 'error').map((item) => item.classification))].sort() as FailureClass[];
  const base = {
    formatVersion: TRACE_COMPARISON_FORMAT_VERSION as 1,
    profile,
    verdict: findings.some((item) => item.severity === 'error') ? 'fail' as const : 'pass' as const,
    failureClasses,
    mapping,
    canonicalTraceHash: canonical.contentHash,
    externalTraceHash: external.contentHash,
    actorMetrics: compared.map((item) => item.metrics), globalMetrics,
    eventComparison, collisionComparison, signalComparison,
    metricDelta: {
      minClearanceM: delta(canonical.metrics.minClearanceM, external.metrics.minClearanceM),
      minTtcS: delta(canonical.metrics.minTtcS, external.metrics.minTtcS),
      minPetS: delta(canonical.metrics.minPetS, external.metrics.minPetS),
    },
    duration: { canonicalS: canonical.sourceDurationS, externalS: external.sourceDurationS, externalCompleted: external.completed },
    ...(options.scenarioRubric ? { scenarioRubric: options.scenarioRubric } : {}),
    unsupportedSemantics: [...(options.unsupportedSemantics ?? [])].sort(),
    findings,
  };
  return { ...base, reportHash: contentHash(base) };
}

export function toComparisonUiModel(report: TraceComparisonReport): ComparisonUiModel {
  const errorActors = new Set(report.findings.filter((item) => item.severity === 'error').map((item) => item.actorId));
  return {
    status: report.verdict,
    headline: report.verdict === 'pass' ? 'External replay matches' : `${report.findings.filter((item) => item.severity === 'error').length} parity issue(s)`,
    reportHash: report.reportHash,
    summary: [
      { label: 'Position p95', value: `${report.globalMetrics.xyM.p95.toFixed(2)} m`, status: report.globalMetrics.xyM.p95 <= report.profile.tolerances.xyP95M ? 'ok' : 'error' },
      { label: 'Heading p95', value: `${(report.globalMetrics.headingRad.p95 * 180 / Math.PI).toFixed(1)}°`, status: report.globalMetrics.headingRad.p95 <= report.profile.tolerances.headingP95Rad ? 'ok' : 'error' },
      { label: 'Completion', value: report.duration.externalCompleted ? `${report.duration.externalS.toFixed(2)} s` : 'Incomplete', status: report.duration.externalCompleted ? 'ok' : 'error' },
      { label: 'Intent rubric', value: report.scenarioRubric?.verdict ?? 'Retained separately', status: report.scenarioRubric?.verdict === 'fail' ? 'error' : report.scenarioRubric?.verdict === 'not-run' ? 'warn' : 'ok' },
    ],
    actorRows: report.actorMetrics.map((item) => ({
      actorId: item.actorId, positionP95M: item.xyM.p95, headingP95Deg: item.headingRad.p95 * 180 / Math.PI,
      speedP95Mps: item.speedMps.p95, presencePercent: item.presenceAgreement * 100,
      status: errorActors.has(item.actorId) ? 'error' : 'ok',
    })),
    findings: report.findings,
  };
}

export function buildDualTracePlaybackData(canonical: NormalizedTrace, external: NormalizedTrace): DualTracePlaybackData {
  const ids = [...new Set([...Object.keys(canonical.actors), ...Object.keys(external.actors)])].sort();
  return {
    sampleHz: 50, durationS: 20, canonicalTraceHash: canonical.contentHash, externalTraceHash: external.contentHash,
    frames: canonical.t.map((t, i) => ({
      t,
      actors: Object.fromEntries(ids.map((id) => {
        const a = canonical.actors[id], b = external.actors[id];
        const canonicalPose = a ? { x: a.x[i]!, y: a.y[i]!, z: a.z[i]!, headingRad: a.headingRad[i]!, present: a.present[i]! } : null;
        const externalPose = b ? { x: b.x[i]!, y: b.y[i]!, z: b.z[i]!, headingRad: b.headingRad[i]!, present: b.present[i]! } : null;
        return [id, {
          canonical: canonicalPose, external: externalPose,
          positionErrorM: canonicalPose?.present && externalPose?.present
            ? Math.hypot(canonicalPose.x - externalPose.x, canonicalPose.y - externalPose.y, canonicalPose.z - externalPose.z)
            : null,
        }];
      })),
    })),
  };
}
