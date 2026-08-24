import { contentHash } from '../core/hash.js';
import type { LaneGraph } from '../map/lane-graph.js';
import type { SimScenarioInput } from '../schema/input.js';
import { runSimulation } from '../sim/engine.js';
import { evaluateTrace, type EvaluateFilters, type TraceEvaluation } from '../trace/evaluate.js';
import type { SimEvent, SimTrace } from '../trace/trace.js';
import {
  applyAmbientTraffic,
  type AmbientTrafficOptions,
  type AmbientTrafficProfile,
  type AmbientTrafficProvenance,
} from './traffic.js';

export interface AmbientRobustnessCase {
  readonly label: string;
  readonly profile: AmbientTrafficProfile;
}

export interface AmbientRobustnessCaseReport {
  readonly label: string;
  readonly profile: AmbientTrafficProfile;
  readonly provenance: AmbientTrafficProvenance;
  readonly evaluation: TraceEvaluation;
  readonly deterministic: boolean;
  readonly authoredEventOrderPreserved: boolean;
  readonly authoredNeverFiredPreserved: boolean;
  readonly ambientCollisions: number;
  readonly runtimeMs: number;
  readonly accepted: boolean;
  readonly failures: readonly string[];
  readonly trace: SimTrace;
}

export interface AmbientRobustnessReport {
  readonly version: 1;
  readonly baseInputHash: string;
  readonly baselineEvaluation: TraceEvaluation;
  readonly baselineTrace: SimTrace;
  readonly cases: readonly AmbientRobustnessCaseReport[];
  readonly accepted: boolean;
}

export interface AmbientRobustnessOptions extends AmbientTrafficOptions {
  readonly filters?: EvaluateFilters;
  /** Measurement/reporting gate only; simulation behavior never depends on wall time. */
  readonly maxRuntimeMs?: number;
  /** Injected by CLI/Studio; omitted in deterministic core tests. */
  readonly now?: () => number;
}

export const DEFAULT_AMBIENT_ROBUSTNESS_CASES: readonly AmbientRobustnessCase[] = [
  { label: 'off', profile: { version: 1, preset: 'off', seed: 'robustness-off' } },
  { label: 'light', profile: { version: 1, preset: 'light', seed: 'robustness-light' } },
  { label: 'moderate', profile: { version: 1, preset: 'moderate', seed: 'robustness-moderate' } },
];

/**
 * Reusable campaign/browser-worker evaluator. It never relaxes the caller's
 * filters and separately protects the authored trigger chronology from ambient
 * side effects.
 */
export function evaluateAmbientRobustness(
  base: SimScenarioInput,
  graph: LaneGraph,
  cases: readonly AmbientRobustnessCase[] = DEFAULT_AMBIENT_ROBUSTNESS_CASES,
  options: AmbientRobustnessOptions = {},
): AmbientRobustnessReport {
  const baselineTrace = runSimulation(base, { graph, guards: 'throw' }).trace;
  const baselineEvaluation = evaluateTrace(baselineTrace, options.filters);
  const authoredIds = new Set(base.actors.map((actor) => actor.id));
  const authoredInteractionIds = new Set(base.interactions.map((interaction) => interaction.id));
  const baselineEvents = authoredEventSignature(baselineTrace.events, authoredIds, authoredInteractionIds);
  const baselineNeverFired = [...baselineTrace.metrics.triggerNeverFired]
    .filter((id) => authoredInteractionIds.has(id))
    .sort();
  const reports: AmbientRobustnessCaseReport[] = [];

  for (const item of cases) {
    const generated = applyAmbientTraffic(base, graph, item.profile, {
      reservations: options.reservations,
      maxAchievableDecelMps2: options.filters?.maxAchievableDecelMps2,
    });
    const started = options.now?.() ?? 0;
    const first = runSimulation(generated.input, { graph, guards: 'throw' }).trace;
    const runtimeMs = options.now ? options.now() - started : 0;
    const second = runSimulation(generated.input, { graph, guards: 'throw' }).trace;
    const deterministic = contentHash(first) === contentHash(second);
    const eventOrderPreserved = contentHash(authoredEventSignature(first.events, authoredIds, authoredInteractionIds)) === contentHash(baselineEvents);
    const neverFired = [...first.metrics.triggerNeverFired]
      .filter((id) => authoredInteractionIds.has(id))
      .sort();
    const authoredNeverFiredPreserved = contentHash(neverFired) === contentHash(baselineNeverFired);
    const ambientIds = new Set(generated.provenance.actors.map((actor) => actor.id));
    const ambientCollisions = first.metrics.collisions.filter((collision) => ambientIds.has(collision.a) || ambientIds.has(collision.b)).length;
    const evaluation = evaluateTrace(first, options.filters);
    const failures: string[] = [];
    if (!deterministic) failures.push('same seed produced a different trace');
    if (!eventOrderPreserved) failures.push('authored trigger/event order changed');
    if (!authoredNeverFiredPreserved) failures.push('authored trigger completion changed');
    if (ambientCollisions > 0) failures.push(`${ambientCollisions} collision(s) involved ambient actors`);
    if (baselineEvaluation.verdict === 'accept' && evaluation.verdict !== 'accept') failures.push('ambient traffic changed an accepted scenario to rejected');
    if (options.now && options.maxRuntimeMs !== undefined && runtimeMs > options.maxRuntimeMs) {
      failures.push(`simulation took ${runtimeMs.toFixed(1)} ms (budget ${options.maxRuntimeMs.toFixed(1)} ms)`);
    }
    reports.push({
      label: item.label,
      profile: item.profile,
      provenance: generated.provenance,
      evaluation,
      deterministic,
      authoredEventOrderPreserved: eventOrderPreserved,
      authoredNeverFiredPreserved,
      ambientCollisions,
      runtimeMs,
      accepted: failures.length === 0,
      failures,
      trace: first,
    });
  }

  return {
    version: 1,
    baseInputHash: contentHash(base),
    baselineEvaluation,
    baselineTrace,
    cases: reports,
    accepted: reports.every((report) => report.accepted),
  };
}

function authoredEventSignature(
  events: readonly SimEvent[],
  actorIds: ReadonlySet<string>,
  interactionIds: ReadonlySet<string>,
): unknown[] {
  const selected: unknown[] = [];
  for (const event of events) {
    const { t: _time, ...orderedIdentity } = event;
    if ('interactionId' in event && interactionIds.has(event.interactionId)) selected.push(orderedIdentity);
    else if ('actorId' in event && actorIds.has(event.actorId)) selected.push(orderedIdentity);
    else if (event.kind === 'collision' && actorIds.has(event.a) && actorIds.has(event.b)) selected.push(orderedIdentity);
  }
  return selected;
}
