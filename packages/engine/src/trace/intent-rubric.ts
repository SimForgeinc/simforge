/**
 * Deterministic, trace-evidence evaluation of a scenario's authored intent.
 *
 * This deliberately complements (and does not replace) the generic criticality
 * evaluator.  A compliant yield or stationary episode can be a successful
 * scenario even though it has no finite TTC.  Criteria are closed and typed:
 * anything outside this vocabulary is reported as unsupported rather than
 * inferred from prose.
 */

import { z } from 'zod';

import { criticalityMetricsInWindow } from './evaluate.js';
import type { ActorTrack, SimEvent, SimTrace } from './trace.js';

const windowSchema = z.tuple([z.number().finite().nonnegative(), z.number().finite().nonnegative()])
  .refine(([a, b]) => a <= b, 'window start must be <= end');
const refSchema = z.string().min(1).max(128);
const pairSchema = z.tuple([refSchema, refSchema]);
const requiredSchema = z.boolean().default(true);

const criterionSchemas = [
  z.object({ id: refSchema, kind: z.literal('event_order'), required: requiredSchema, mode: z.enum(['required', 'forbidden']).default('required'), interactionIds: z.array(refSchema).min(1).max(64) }),
  z.object({ id: refSchema, kind: z.literal('trigger'), required: requiredSchema, interactionId: refSchema, outcome: z.enum(['fired', 'skipped']) }),
  z.object({ id: refSchema, kind: z.literal('speed_band'), required: requiredSchema, actorId: refSchema, window: windowSchema.optional(), minMps: z.number().finite().nonnegative().optional(), maxMps: z.number().finite().nonnegative().optional() }),
  z.object({ id: refSchema, kind: z.literal('stationary_success'), required: requiredSchema, actorId: refSchema, window: windowSchema.optional(), maxSpeedMps: z.number().finite().nonnegative().default(0.1), minPresentSeconds: z.number().finite().nonnegative().optional() }),
  z.object({ id: refSchema, kind: z.literal('stop_hold_resume'), required: requiredSchema, actorId: refSchema, window: windowSchema.optional(), stopSpeedMps: z.number().finite().nonnegative().default(0.1), minHoldSeconds: z.number().finite().nonnegative(), mustResume: z.boolean().default(true), resumeMinSpeedMps: z.number().finite().positive().default(0.5), resumeByS: z.number().finite().nonnegative().optional() }),
  z.object({ id: refSchema, kind: z.literal('clearance'), required: requiredSchema, pair: pairSchema, window: windowSchema.optional(), measure: z.enum(['metric_gap', 'centre_distance']).default('metric_gap'), minM: z.number().finite().nonnegative() }),
  z.object({ id: refSchema, kind: z.literal('criticality'), required: requiredSchema, metric: z.enum(['ttc', 'path_ttc', 'pet']), pair: pairSchema.optional(), window: windowSchema.optional(), minS: z.number().finite().nonnegative().optional(), maxS: z.number().finite().nonnegative().optional() }),
  z.object({ id: refSchema, kind: z.literal('occlusion'), required: requiredSchema, observer: refSchema, target: refSchema, occluderId: refSchema.optional(), outcome: z.enum(['blocked_then_revealed', 'blocked_at_conflict', 'never_blocked']) }),
  z.object({ id: refSchema, kind: z.literal('lane_occupancy'), required: requiredSchema, actorId: refSchema, laneRsl: refSchema, mode: z.enum(['required', 'forbidden']).default('required'), window: windowSchema.optional() }),
  z.object({ id: refSchema, kind: z.literal('zone_occupancy'), required: requiredSchema, actorId: refSchema, mode: z.enum(['required', 'forbidden']).default('required'), window: windowSchema.optional(), zone: z.discriminatedUnion('shape', [z.object({ shape: z.literal('circle'), x: z.number().finite(), y: z.number().finite(), radiusM: z.number().finite().positive() }), z.object({ shape: z.literal('box'), minX: z.number().finite(), maxX: z.number().finite(), minY: z.number().finite(), maxY: z.number().finite() }).refine((v) => v.minX <= v.maxX && v.minY <= v.maxY, 'invalid box bounds')]) }),
  z.object({ id: refSchema, kind: z.literal('collision'), required: requiredSchema, pair: pairSchema.optional(), maxCount: z.number().int().nonnegative().default(0) }),
  z.object({ id: refSchema, kind: z.literal('control_indication'), required: requiredSchema, signalId: refSchema, window: windowSchema.optional(), mode: z.enum(['required', 'forbidden']).default('required'), indications: z.array(z.string().min(1).max(32)).min(1).max(32) }),
  z.object({ id: refSchema, kind: z.literal('unsupported'), required: requiredSchema, description: z.string().min(1).max(1_000), reason: z.string().min(1).max(1_000) }),
] as const;

export const intentCriterionSchema = z.discriminatedUnion('kind', criterionSchemas);
export const intentRubricSchema = z.object({
  version: z.literal(1),
  intentId: z.string().min(1),
  title: z.string().min(1),
  originalIntent: z.string().min(1).max(8_000).optional(),
  criteria: z.array(intentCriterionSchema).min(1).max(256),
}).superRefine((rubric, ctx) => {
  const seen = new Set<string>();
  rubric.criteria.forEach((criterion, index) => {
    if (seen.has(criterion.id)) ctx.addIssue({ code: 'custom', path: ['criteria', index, 'id'], message: 'criterion id must be unique' });
    seen.add(criterion.id);
  });
});

export type IntentCriterion = z.infer<typeof intentCriterionSchema>;
export type IntentRubric = z.infer<typeof intentRubricSchema>;
export type IntentCriterionInput = z.input<typeof intentCriterionSchema>;
export type IntentRubricInput = z.input<typeof intentRubricSchema>;
export type CriterionStatus = 'pass' | 'fail' | 'unchecked' | 'unsupported';

export interface TraceEvidence {
  readonly source: 'trace_event' | 'actor_track' | 'metric' | 'signal_track' | 'rubric';
  readonly summary: string;
  readonly values: Readonly<Record<string, string | number | boolean | null | readonly string[] | readonly number[]>>;
}

export interface CriterionVerdict {
  readonly id: string;
  readonly kind: IntentCriterion['kind'];
  readonly required: boolean;
  readonly status: CriterionStatus;
  readonly reason: string;
  readonly evidence: readonly TraceEvidence[];
}

export interface BehaviorSummary {
  readonly version: 1;
  readonly trace: { readonly inputHash: string; readonly mapId: string; readonly clipSeconds: number; readonly dt: number; readonly actorCount: number };
  readonly actors: ReadonlyArray<{ readonly actorId: string; readonly presentFromS: number | null; readonly presentToS: number | null; readonly minSpeedMps: number | null; readonly maxSpeedMps: number | null; readonly finalSpeedMps: number | null; readonly distanceTravelledM: number; readonly stationaryIntervals: ReadonlyArray<readonly [number, number]>; readonly lanes: readonly string[] }>;
  readonly events: ReadonlyArray<{ readonly t: number; readonly kind: SimEvent['kind']; readonly actorId?: string; readonly interactionId?: string; readonly detail?: string }>;
  readonly metrics: { readonly collisions: number; readonly minTTC: number | null; readonly minPathTTC: number | null; readonly minPET: number | null; readonly triggerNeverFired: readonly string[]; readonly declaredOcclusion: ReadonlyArray<{ readonly observer: string; readonly target: string; readonly status: string; readonly firstBlockedT: number | null; readonly losOpenT: number | null }> };
  readonly truncated: { readonly actors: boolean; readonly events: boolean; readonly occlusions: boolean };
}

export interface IntentEvaluation {
  readonly version: 1;
  readonly intentId: string;
  readonly verdict: 'accept' | 'reject';
  readonly counts: Readonly<Record<CriterionStatus, number>>;
  readonly criteria: readonly CriterionVerdict[];
  readonly behaviorSummary: BehaviorSummary;
}

export interface BlindReviewPacket {
  readonly version: 1;
  readonly intentId: string;
  readonly title: string;
  readonly originalIntent: string | null;
  readonly rubric: IntentRubric;
  readonly behaviorSummary: BehaviorSummary;
  readonly machineEvaluation: Omit<IntentEvaluation, 'behaviorSummary'>;
}

const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;
const clipWindow = (trace: SimTrace, window?: readonly [number, number]): [number, number] => [window?.[0] ?? 0, window?.[1] ?? trace.header.clipSeconds];
const inWindow = (t: number, w: readonly [number, number]): boolean => t >= w[0] && t <= w[1];

function indices(trace: SimTrace, track: ActorTrack, window?: readonly [number, number]): number[] {
  const w = clipWindow(trace, window);
  const out: number[] = [];
  for (let i = 0; i < trace.ticks.t.length; i += 1) if (track.present[i] === 1 && inWindow(trace.ticks.t[i]!, w)) out.push(i);
  return out;
}

function stationaryIntervals(trace: SimTrace, track: ActorTrack, threshold: number, window?: readonly [number, number]): [number, number][] {
  const ii = indices(trace, track, window);
  const out: [number, number][] = [];
  let start: number | null = null;
  let end: number | null = null;
  let previousIndex: number | null = null;
  for (const i of ii) {
    const t = trace.ticks.t[i]!;
    if (previousIndex !== null && i !== previousIndex + 1 && start !== null && end !== null) {
      out.push([round(start), round(end)]);
      start = end = null;
    }
    if (track.speedMps[i]! <= threshold) {
      if (start === null) start = t;
      end = t;
    } else if (start !== null && end !== null) {
      out.push([round(start), round(end)]);
      start = end = null;
    }
    previousIndex = i;
  }
  if (start !== null && end !== null) out.push([round(start), round(end)]);
  return out;
}

function eventIdentity(e: SimEvent): string | undefined {
  return 'interactionId' in e ? e.interactionId : undefined;
}

function summarizeEvent(e: SimEvent): BehaviorSummary['events'][number] {
  const actorId = 'actorId' in e ? e.actorId : e.kind === 'collision' ? `${e.a}/${e.b}` : undefined;
  const interactionId = eventIdentity(e);
  const detail = e.kind === 'state_set' ? `${e.key}=${String(e.value)}`
    : e.kind === 'trigger_skipped' || e.kind === 'lane_change_rejected' || e.kind === 'route_change_rejected' ? e.reason
      : e.kind === 'lane_change' ? `${e.fromRsl ?? 'none'}→${e.toRsl ?? 'none'}`
        : undefined;
  return { t: round(e.t), kind: e.kind, ...(actorId ? { actorId } : {}), ...(interactionId ? { interactionId } : {}), ...(detail ? { detail } : {}) };
}

export function summarizeBehavior(trace: SimTrace, limits: { maxActors?: number; maxEvents?: number; maxOcclusions?: number } = {}): BehaviorSummary {
  const maxActors = Math.max(1, limits.maxActors ?? 64);
  const maxEvents = Math.max(1, limits.maxEvents ?? 128);
  const maxOcclusions = Math.max(1, limits.maxOcclusions ?? 64);
  const actorIds = Object.keys(trace.ticks.actors).sort();
  const actors = actorIds.slice(0, maxActors).map((actorId) => {
    const track = trace.ticks.actors[actorId]!;
    const ii = indices(trace, track);
    let distance = 0;
    for (let j = 1; j < ii.length; j += 1) {
      const a = ii[j - 1]!; const b = ii[j]!;
      distance += Math.hypot(track.x[b]! - track.x[a]!, track.y[b]! - track.y[a]!);
    }
    const speeds = ii.map((i) => track.speedMps[i]!);
    return {
      actorId,
      presentFromS: ii.length ? round(trace.ticks.t[ii[0]!]!) : null,
      presentToS: ii.length ? round(trace.ticks.t[ii[ii.length - 1]!]!) : null,
      minSpeedMps: speeds.length ? round(Math.min(...speeds)) : null,
      maxSpeedMps: speeds.length ? round(Math.max(...speeds)) : null,
      finalSpeedMps: speeds.length ? round(speeds[speeds.length - 1]!) : null,
      distanceTravelledM: round(distance),
      stationaryIntervals: stationaryIntervals(trace, track, 0.1).slice(0, 16),
      lanes: [...new Set(ii.map((i) => track.laneRsl[i]).filter((v): v is string => v !== null))].sort().slice(0, 32),
    };
  });
  const events = [...trace.events].sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind) || (eventIdentity(a) ?? '').localeCompare(eventIdentity(b) ?? '')).slice(0, maxEvents).map(summarizeEvent);
  const occlusions = [...(trace.metrics.declaredOcclusion ?? [])].sort((a, b) => a.observer.localeCompare(b.observer) || a.target.localeCompare(b.target) || (a.occluderId ?? '').localeCompare(b.occluderId ?? '')).slice(0, maxOcclusions).map((o) => ({ observer: o.observer, target: o.target, status: o.status, firstBlockedT: o.firstBlockedT, losOpenT: o.losOpenT }));
  return {
    version: 1,
    trace: { inputHash: trace.header.inputHash, mapId: trace.header.mapId, clipSeconds: trace.header.clipSeconds, dt: trace.header.dt, actorCount: actorIds.length },
    actors,
    events,
    metrics: { collisions: trace.metrics.collisions.length, minTTC: trace.metrics.minTTC?.value ?? null, minPathTTC: trace.metrics.minPathTTC?.value ?? null, minPET: trace.metrics.minPET?.value ?? null, triggerNeverFired: [...trace.metrics.triggerNeverFired].sort().slice(0, 128), declaredOcclusion: occlusions },
    truncated: { actors: actorIds.length > maxActors, events: trace.events.length > maxEvents, occlusions: (trace.metrics.declaredOcclusion?.length ?? 0) > maxOcclusions },
  };
}

const evidence = (source: TraceEvidence['source'], summary: string, values: TraceEvidence['values']): TraceEvidence => ({ source, summary, values });
const result = (criterion: IntentCriterion, status: CriterionStatus, reason: string, entries: TraceEvidence[]): CriterionVerdict => ({ id: criterion.id, kind: criterion.kind, required: criterion.required, status, reason, evidence: entries.slice(0, 8) });
const missingActor = (criterion: IntentCriterion, actorId: string): CriterionVerdict => result(criterion, 'unchecked', `actor ${actorId} has no trace track`, [evidence('actor_track', 'actor track missing', { actorId })]);

function evaluateCriterion(trace: SimTrace, c: IntentCriterion): CriterionVerdict {
  if (c.kind === 'unsupported') return result(c, 'unsupported', c.reason, [evidence('rubric', 'criterion is outside the deterministic evaluator vocabulary', { description: c.description, reason: c.reason })]);
  if (c.kind === 'event_order') {
    const fired = trace.events.filter((e): e is Extract<SimEvent, { kind: 'trigger_fired' }> => e.kind === 'trigger_fired');
    let cursor = 0; const times: number[] = []; let complete = true;
    for (const id of c.interactionIds) {
      const offset = fired.slice(cursor).findIndex((e) => e.interactionId === id);
      if (offset < 0) { complete = false; break; }
      cursor += offset + 1; times.push(round(fired[cursor - 1]!.t));
    }
    const pass = c.mode === 'required' ? complete : !complete;
    return result(c, pass ? 'pass' : 'fail', pass ? `${c.mode} event-order condition held` : `${c.mode} event-order condition did not hold`, [evidence('trace_event', 'ordered trigger evidence', { interactionIds: c.interactionIds, matchedTimesS: times, complete })]);
  }
  if (c.kind === 'trigger') {
    const matches = trace.events.filter((e) => e.kind === `trigger_${c.outcome}` && 'interactionId' in e && e.interactionId === c.interactionId);
    return result(c, matches.length ? 'pass' : 'fail', matches.length ? `trigger ${c.outcome}` : `trigger did not ${c.outcome}`, [evidence('trace_event', 'trigger outcome evidence', { interactionId: c.interactionId, outcome: c.outcome, timesS: matches.map((e) => round(e.t)).slice(0, 16) })]);
  }
  if (c.kind === 'speed_band' || c.kind === 'stationary_success' || c.kind === 'stop_hold_resume' || c.kind === 'lane_occupancy' || c.kind === 'zone_occupancy') {
    const track = trace.ticks.actors[c.actorId]; if (!track) return missingActor(c, c.actorId);
    const ii = indices(trace, track, c.window); if (!ii.length) return result(c, 'unchecked', 'actor has no present samples in the requested window', [evidence('actor_track', 'empty actor window', { actorId: c.actorId, window: clipWindow(trace, c.window) })]);
    if (c.kind === 'speed_band') {
      const speeds = ii.map((i) => track.speedMps[i]!); const min = Math.min(...speeds); const max = Math.max(...speeds);
      const pass = (c.minMps === undefined || min >= c.minMps) && (c.maxMps === undefined || max <= c.maxMps);
      return result(c, pass ? 'pass' : 'fail', pass ? 'speed remained inside the authored band' : 'speed left the authored band', [evidence('actor_track', 'speed extrema in window', { actorId: c.actorId, window: clipWindow(trace, c.window), minSpeedMps: round(min), maxSpeedMps: round(max), requiredMinMps: c.minMps ?? null, requiredMaxMps: c.maxMps ?? null })]);
    }
    if (c.kind === 'stationary_success') {
      const speeds = ii.map((i) => track.speedMps[i]!); const max = Math.max(...speeds); const duration = trace.ticks.t[ii[ii.length - 1]!]! - trace.ticks.t[ii[0]!]!;
      const pass = max <= c.maxSpeedMps && (c.minPresentSeconds === undefined || duration >= c.minPresentSeconds);
      return result(c, pass ? 'pass' : 'fail', pass ? 'stationary compliance succeeded' : 'stationary compliance was not maintained', [evidence('actor_track', 'stationary actor evidence', { actorId: c.actorId, window: clipWindow(trace, c.window), observedMaxSpeedMps: round(max), allowedMaxSpeedMps: c.maxSpeedMps, presentSeconds: round(duration), requiredPresentSeconds: c.minPresentSeconds ?? null })]);
    }
    if (c.kind === 'stop_hold_resume') {
      const intervals = stationaryIntervals(trace, track, c.stopSpeedMps, c.window); const best = intervals.reduce<[number, number] | null>((a, v) => !a || v[1] - v[0] > a[1] - a[0] ? v : a, null); const held = best !== null && best[1] - best[0] >= c.minHoldSeconds;
      const resumedAt = best ? ii.map((i) => ({ i, t: trace.ticks.t[i]! })).find(({ i, t }) => t > best[1] && track.speedMps[i]! >= c.resumeMinSpeedMps)?.t ?? null : null;
      const resumed = !c.mustResume || (resumedAt !== null && (c.resumeByS === undefined || resumedAt <= c.resumeByS)); const pass = held && resumed;
      return result(c, pass ? 'pass' : 'fail', pass ? 'stop/hold/resume behavior held' : !held ? 'minimum stop hold was not observed' : 'required resume was not observed in time', [evidence('actor_track', 'stop interval and resume evidence', { actorId: c.actorId, longestStop: best ?? [], longestStopSeconds: best ? round(best[1] - best[0]) : 0, requiredHoldSeconds: c.minHoldSeconds, resumedAtS: resumedAt === null ? null : round(resumedAt), resumeByS: c.resumeByS ?? null })]);
    }
    if (c.kind === 'lane_occupancy') {
      const times = ii.filter((i) => track.laneRsl[i] === c.laneRsl).map((i) => round(trace.ticks.t[i]!)); const occupied = times.length > 0; const pass = c.mode === 'required' ? occupied : !occupied;
      return result(c, pass ? 'pass' : 'fail', `${c.mode} lane occupancy ${pass ? 'held' : 'failed'}`, [evidence('actor_track', 'lane occupancy samples', { actorId: c.actorId, laneRsl: c.laneRsl, sampleCount: times.length, firstTimeS: times[0] ?? null, lastTimeS: times[times.length - 1] ?? null })]);
    }
    const inside = (i: number): boolean => c.zone.shape === 'circle' ? Math.hypot(track.x[i]! - c.zone.x, track.y[i]! - c.zone.y) <= c.zone.radiusM : track.x[i]! >= c.zone.minX && track.x[i]! <= c.zone.maxX && track.y[i]! >= c.zone.minY && track.y[i]! <= c.zone.maxY;
    const times = ii.filter(inside).map((i) => round(trace.ticks.t[i]!)); const occupied = times.length > 0; const pass = c.mode === 'required' ? occupied : !occupied;
    return result(c, pass ? 'pass' : 'fail', `${c.mode} zone occupancy ${pass ? 'held' : 'failed'}`, [evidence('actor_track', 'zone occupancy samples', { actorId: c.actorId, sampleCount: times.length, firstTimeS: times[0] ?? null, lastTimeS: times[times.length - 1] ?? null })]);
  }
  if (c.kind === 'clearance') {
    const [a, b] = c.pair; const ta = trace.ticks.actors[a]; const tb = trace.ticks.actors[b]; if (!ta) return missingActor(c, a); if (!tb) return missingActor(c, b);
    const w = clipWindow(trace, c.window); let min = Infinity; let at = 0;
    if (c.measure === 'metric_gap') {
      const entry = trace.metrics.minDistance.find((d) => (d.pair[0] === a && d.pair[1] === b) || (d.pair[0] === b && d.pair[1] === a));
      if (!entry) return result(c, 'unchecked', 'no engine clearance metric exists for the requested pair', [evidence('metric', 'pair clearance missing', { pair: c.pair })]);
      if (!inWindow(entry.t, w)) return result(c, 'unchecked', 'episode-wide clearance minimum falls outside the requested window and no clearance series is retained', [evidence('metric', 'windowed clearance cannot be established', { pair: c.pair, episodeMinimumM: entry.minDistanceM, episodeMinimumAtS: entry.t, window: w })]);
      min = entry.minDistanceM; at = entry.t;
    } else {
      for (let i = 0; i < trace.ticks.t.length; i += 1) if (ta.present[i] === 1 && tb.present[i] === 1 && inWindow(trace.ticks.t[i]!, w)) { const d = Math.hypot(ta.x[i]! - tb.x[i]!, ta.y[i]! - tb.y[i]!); if (d < min) { min = d; at = trace.ticks.t[i]!; } }
    }
    if (!Number.isFinite(min)) return result(c, 'unchecked', 'pair was never simultaneously present in the requested window', [evidence('actor_track', 'no simultaneous samples', { pair: c.pair, window: w })]);
    return result(c, min >= c.minM ? 'pass' : 'fail', min >= c.minM ? 'minimum clearance held' : 'minimum clearance was violated', [evidence(c.measure === 'metric_gap' ? 'metric' : 'actor_track', c.measure === 'metric_gap' ? 'engine minimum shape clearance' : 'minimum centre distance', { pair: c.pair, measure: c.measure, minDistanceM: round(min), atS: round(at), requiredMinM: c.minM, window: w })]);
  }
  if (c.kind === 'criticality') {
    const w = clipWindow(trace, c.window); const selected = criticalityMetricsInWindow(trace.metrics, w, c.pair);
    const global = c.metric === 'ttc' ? trace.metrics.minTTC : c.metric === 'path_ttc' ? trace.metrics.minPathTTC ?? null : trace.metrics.minPET ?? null;
    const pairMatches = (pair: readonly string[]): boolean => !c.pair || (pair[0] === c.pair[0] && pair[1] === c.pair[1]) || (pair[0] === c.pair[1] && pair[1] === c.pair[0]);
    const sampled = c.metric === 'ttc' ? selected.minTTC : c.metric === 'path_ttc' ? selected.minPathTTC : selected.minPET;
    const record = trace.metrics.criticalitySamples !== undefined ? sampled : global && pairMatches(global.pair) && inWindow(global.t, w) ? global : null;
    if (!record) return result(c, 'unchecked', `no finite ${c.metric} evidence exists for the requested pair/window`, [evidence('metric', 'criticality observation missing', { metric: c.metric, pair: c.pair ?? [], window: w })]);
    const pass = (c.minS === undefined || record.value >= c.minS) && (c.maxS === undefined || record.value <= c.maxS);
    return result(c, pass ? 'pass' : 'fail', pass ? `${c.metric} remained inside the authored band` : `${c.metric} was outside the authored band`, [evidence('metric', 'criticality minimum', { metric: c.metric, valueS: round(record.value), atS: round(record.t), pair: record.pair, requiredMinS: c.minS ?? null, requiredMaxS: c.maxS ?? null })]);
  }
  if (c.kind === 'occlusion') {
    const matches = (trace.metrics.declaredOcclusion ?? []).filter((o) => o.observer === c.observer && o.target === c.target && (c.occluderId === undefined || o.occluderId === c.occluderId));
    if (!matches.length) return result(c, 'unchecked', 'no declared occlusion metric matched the requested relation', [evidence('metric', 'occlusion declaration missing', { observer: c.observer, target: c.target, occluderId: c.occluderId ?? null })]);
    const wanted = c.outcome === 'blocked_then_revealed' ? 'revealed_before_conflict' : c.outcome === 'blocked_at_conflict' ? 'blocked_at_conflict' : 'never_blocked_before_conflict'; const hit = matches.find((o) => o.status === wanted);
    return result(c, hit ? 'pass' : 'fail', hit ? 'occlusion outcome held' : 'occlusion outcome differed', [evidence('metric', 'declared occlusion result', { observer: c.observer, target: c.target, expectedStatus: wanted, observedStatuses: matches.map((o) => o.status), firstBlockedT: hit?.firstBlockedT ?? null, losOpenT: hit?.losOpenT ?? null })]);
  }
  if (c.kind === 'collision') {
    const collisions = trace.metrics.collisions.filter((x) => !c.pair || ((x.a === c.pair[0] && x.b === c.pair[1]) || (x.a === c.pair[1] && x.b === c.pair[0]))); const pass = collisions.length <= c.maxCount;
    return result(c, pass ? 'pass' : 'fail', pass ? 'collision budget held' : 'collision budget exceeded', [evidence('metric', 'collision evidence', { pair: c.pair ?? [], observedCount: collisions.length, maxCount: c.maxCount, timesS: collisions.map((x) => round(x.t)).slice(0, 16) })]);
  }
  const signal = trace.ticks.signals?.[c.signalId]; if (!signal) return result(c, 'unchecked', `signal ${c.signalId} has no trace channel`, [evidence('signal_track', 'signal track missing', { signalId: c.signalId })]);
  const w = clipWindow(trace, c.window); const observed = [...new Set(trace.ticks.t.flatMap((t, i) => inWindow(t, w) ? [signal.phase[i]!] : []))].sort(); const allPresent = c.indications.every((x) => observed.includes(x as never)); const anyPresent = c.indications.some((x) => observed.includes(x as never)); const pass = c.mode === 'required' ? allPresent : !anyPresent;
  return result(c, pass ? 'pass' : 'fail', `${c.mode} control indication condition ${pass ? 'held' : 'failed'}`, [evidence('signal_track', 'control indications in window', { signalId: c.signalId, expected: c.indications, observed, window: w })]);
}

export function evaluateIntentRubric(trace: SimTrace, input: IntentRubricInput): IntentEvaluation {
  const rubric = intentRubricSchema.parse(input);
  const criteria = rubric.criteria.map((c) => evaluateCriterion(trace, c));
  const counts: Record<CriterionStatus, number> = { pass: 0, fail: 0, unchecked: 0, unsupported: 0 };
  for (const criterion of criteria) counts[criterion.status] += 1;
  const rejected = criteria.some((c) => c.required && c.status !== 'pass');
  return { version: 1, intentId: rubric.intentId, verdict: rejected ? 'reject' : 'accept', counts, criteria, behaviorSummary: summarizeBehavior(trace) };
}

/** A bounded packet suitable for a context-blind Codex reviewer. */
export function createBlindReviewPacket(rubricInput: IntentRubricInput, evaluation: IntentEvaluation): BlindReviewPacket {
  const rubric = intentRubricSchema.parse(rubricInput);
  const { behaviorSummary: _omitted, ...machineEvaluation } = evaluation;
  return { version: 1, intentId: rubric.intentId, title: rubric.title, originalIntent: rubric.originalIntent ?? null, rubric, behaviorSummary: evaluation.behaviorSummary, machineEvaluation };
}
