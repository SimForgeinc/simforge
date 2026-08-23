/**
 * `uniscenarios simulate <instance> [--trace out.trace.json.gz]`.
 *
 * One engine pass. `guards: 'collect'` rather than `'throw'`: a scenario that
 * fails a feasibility guard is still worth simulating — the resulting metrics
 * are how you tell "the runway is 8 m short" from "the runway is 200 m short".
 */

import path from 'node:path';

import { runSimulation, traceDigest, type SimTrace } from '@uniscenarios/sim-engine';

import { EXIT } from '../errors.js';
import { loadMap } from '@uniscenarios/scenario-materializer';
import { emit, emitLines, fixed, pad } from '../output.js';
import { readInstance, writeTraceFile } from '@uniscenarios/scenario-materializer';

export interface SimulateOptions {
  readonly file: string;
  readonly trace?: string | undefined;
  readonly pretty: boolean;
}

/** The metrics block every command that runs the engine prints. */
export function metricsSummary(trace: SimTrace): Record<string, unknown> {
  const m = trace.metrics;
  return {
    minTTC: m.minTTC
      ? { value: round(m.minTTC.value), t: round(m.minTTC.t), pair: m.minTTC.pair }
      : null,
    minDistance: m.minDistance.map((d) => ({
      pair: d.pair,
      minDistanceM: round(d.minDistanceM),
      t: round(d.t),
    })),
    requiredDecelMax: Object.fromEntries(
      Object.entries(m.requiredDecelMax).map(([k, v]) => [k, round(v)]),
    ),
    revealToConflict: m.revealToConflict
      ? {
          observer: m.revealToConflict.observer,
          target: m.revealToConflict.target,
          value: round(m.revealToConflict.value),
          firstBlockedT: round(m.revealToConflict.firstBlockedT),
          losOpenT: round(m.revealToConflict.losOpenT),
          conflictT: round(m.revealToConflict.conflictT),
          pair: m.revealToConflict.pair,
          occluderId: m.revealToConflict.occluderId ?? null,
          relevantOccluderIds: m.revealToConflict.relevantOccluderIds,
        }
      : null,
    declaredOcclusion: (m.declaredOcclusion ?? []).map((entry) => ({
      observer: entry.observer,
      target: entry.target,
      pair: entry.pair,
      occluderId: entry.occluderId ?? null,
      relevantOccluderIds: entry.relevantOccluderIds,
      status: entry.status,
      firstBlockedT: entry.firstBlockedT === null ? null : round(entry.firstBlockedT),
      losOpenT: entry.losOpenT === null ? null : round(entry.losOpenT),
      conflictT: entry.conflictT === null ? null : round(entry.conflictT),
      revealToConflictS: entry.revealToConflictS === null ? null : round(entry.revealToConflictS),
    })),
    occluderIneffective: (m.occluderIneffective ?? []).map((entry) => ({
      observer: entry.observer,
      target: entry.target,
      pair: entry.pair,
      conflictT: round(entry.conflictT),
      firstBlockedT: entry.firstBlockedT === undefined ? null : round(entry.firstBlockedT),
      occluderId: entry.occluderId ?? null,
      relevantOccluderIds: entry.relevantOccluderIds,
      reason: entry.reason,
    })),
    collisions: m.collisions,
    triggerNeverFired: m.triggerNeverFired,
    clippedCriticality: m.clippedCriticality,
    ticksSimulated: m.ticksSimulated,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export async function simulate(options: SimulateOptions): Promise<number> {
  const instance = await readInstance(options.file);
  const bundle = await loadMap(instance.input.mapId);
  const result = runSimulation(instance.input, { graph: bundle.graph, guards: 'collect' });

  if (options.trace) {
    await writeTraceFile(options.trace, result.trace);
  }

  const payload = {
    file: options.file,
    mapId: instance.input.mapId,
    header: result.trace.header,
    traceDigest: traceDigest(result.trace),
    metrics: metricsSummary(result.trace),
    events: countEvents(result.trace),
    issues: result.issues,
    arrival: result.arrival,
    trace: options.trace ? path.resolve(options.trace) : null,
  };

  if (!options.pretty) {
    emit(payload, options);
  } else {
    const m = result.trace.metrics;
    const lines = [
      `${options.file} on ${instance.input.mapId} — ${result.trace.ticks.t.length} recorded ticks, engine ${result.trace.header.engineVersion}`,
      `inputHash ${result.trace.header.inputHash.slice(0, 16)}…  traceDigest ${traceDigest(result.trace).slice(0, 16)}…`,
      '',
      `minTTC              ${m.minTTC ? `${fixed(m.minTTC.value)} s at t=${fixed(m.minTTC.t)} s (${m.minTTC.pair.join(' / ')})` : '— (no pair ever closed)'}`,
      `minDistance         ${m.minDistance
        .map((d) => `${d.pair.join('/')}: ${fixed(d.minDistanceM)} m @ ${fixed(d.t)} s`)
        .join(', ') || '—'}`,
      `requiredDecelMax    ${Object.entries(m.requiredDecelMax)
        .map(([k, v]) => `${k}: ${fixed(v)}`)
        .join(', ')}`,
      `revealToConflict    ${m.revealToConflict ? `${fixed(m.revealToConflict.value)} s (${m.revealToConflict.occluderId ?? 'any'}: blocked ${fixed(m.revealToConflict.firstBlockedT)} s, LOS opened ${fixed(m.revealToConflict.losOpenT)} s, conflict ${fixed(m.revealToConflict.conflictT)} s; members ${m.revealToConflict.relevantOccluderIds.join(',') || '—'})` : '—'}`,
      `occluderIneffective ${(m.occluderIneffective ?? []).map((e) => `${e.pair.join(' / ')} via ${e.occluderId ?? 'any'} (${e.reason}; members ${e.relevantOccluderIds.join(',') || '—'})`).join(', ') || '—'}`,
      `collisions          ${m.collisions.length}`,
      `triggerNeverFired   ${m.triggerNeverFired.join(', ') || '—'}`,
      `clippedCriticality  ${m.clippedCriticality}`,
    ];
    if (result.issues.length > 0) {
      lines.push('', 'issues:');
      for (const i of result.issues) lines.push(`  ${pad(i.severity, 9)}${pad(i.code, 26)}${i.reason}`);
    }
    if (options.trace) lines.push('', `trace: ${path.resolve(options.trace)}`);
    emitLines(lines);
  }

  return result.issues.some((i) => i.severity === 'error') ? EXIT.validationFindings : EXIT.ok;
}

function countEvents(trace: SimTrace): Record<string, number> {
  const out: Record<string, number> = {};
  for (const event of trace.events) out[event.kind] = (out[event.kind] ?? 0) + 1;
  return out;
}
