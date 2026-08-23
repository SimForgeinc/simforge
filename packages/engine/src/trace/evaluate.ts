/**
 * `evaluateTrace` — the reject filters every generated concrete passes through.
 *
 * From `docs/research/interactions-and-edge-cases.md` §Parameterization:
 *
 * | filter | rejects when |
 * |---|---|
 * | `trivially_safe` | `minTTC > 3 s` (tag as negative control instead of dropping) |
 * | `physically_unavoidable` | required decel exceeds `μg` — RSS-style |
 * | `never_fired` | any trigger never fired |
 * | `out_of_window` | the criticality peak falls inside the proportional edge guard |
 * | `collision` | opt-in; off by default because some archetypes want contact |
 *
 * A scenario tagged `negative-control` keeps its `trivially_safe` finding but
 * is *accepted* — the taxonomy deliberately includes curb-standing pedestrians
 * and phantom-brake bait whose whole point is that nothing happens.
 */

import type { CriticalitySamples, EpisodeMetrics, MinPetRecord, MinPathTtcRecord, MinTtcRecord, SimTrace } from './trace.js';
import { criticalityWindow } from './metrics.js';

export interface EvaluateFilters {
  /** `minTTC` above this is trivially safe. Default 3 s. */
  readonly trivialTtcS?: number;
  /** PET above this is a trivially separated crossing. Default 1.5 s. */
  readonly trivialPetS?: number;
  /** Road-friction decel ceiling, m/s². Default `0.8 × 9.81 = 7.85`. */
  readonly maxAchievableDecelMps2?: number;
  /** Criticality window. Defaults to the proportional, edge-safe clip window. */
  readonly window?: [number, number];
  /** Treat any collision as a rejection. Default `false`. */
  readonly rejectCollisions?: boolean;
  /** Skip `trivially_safe`; the scenario is a deliberate negative control. */
  readonly negativeControl?: boolean;
  /** Only apply the never-fired filter to these interaction ids. */
  readonly requiredTriggers?: readonly string[];
  /**
   * Generated background road users, excluded from the `physically_unavoidable`
   * scan.
   *
   * WHY. That filter takes a maximum of `requiredDecelMax` over EVERY actor and
   * rejects the whole clip when it exceeds the friction ceiling. Left alone, one
   * background car braking hard for another background car — an event with no
   * relation whatsoever to the authored conflict — rejects the scenario.
   * Measured on `c3-allway-stop`: 3 of 4 accepted cells flipped
   * `critical -> unavoidable` for exactly this reason before the exclusion.
   * `evaluateTrace` fills this in from `trace.header.ambientActorIds`, so the
   * default stays empty and authored-only evaluation is unchanged.
   */
  readonly ambientActorIds?: readonly string[];
}

export type RejectCode =
  | 'trivially_safe'
  | 'physically_unavoidable'
  | 'never_fired'
  | 'out_of_window'
  | 'collision'
  | 'occlusion_unproven'
  | 'no_interaction';

export interface RejectFinding {
  readonly code: RejectCode;
  readonly reason: string;
  readonly detail?: Record<string, unknown>;
}

export interface TraceEvaluation {
  readonly verdict: 'accept' | 'reject';
  readonly findings: RejectFinding[];
  readonly tags: string[];
  /** Convenience copy of the numbers the verdict was based on. */
  readonly summary: {
    readonly minTTC: number | null;
    readonly minTTCt: number | null;
    /** Mechanism-aware minimum selected from circle TTC and crossing path-TTC. */
    readonly criticalityKind: 'ttc' | 'path-ttc' | 'pet' | null;
    readonly criticality: number | null;
    readonly criticalityT: number | null;
    readonly requiredDecelMax: number;
    readonly collisions: number;
    readonly neverFired: number;
    readonly occlusionUnproven: number;
  };
}

export const DEFAULT_TRIVIAL_TTC_S = 3;
export const DEFAULT_TRIVIAL_PET_S = 1.5;
export const DEFAULT_MAX_DECEL_MPS2 = 0.8 * 9.81;

function seriesPairMatches(actual: readonly string[], expected?: readonly [string, string]): boolean {
  return expected === undefined || (actual[0] === expected[0] && actual[1] === expected[1]) ||
    (actual[0] === expected[1] && actual[1] === expected[0]);
}

function minimumTtcInWindow(
  series: CriticalitySamples['ttc'] | undefined,
  window: readonly [number, number],
  pair?: readonly [string, string],
): MinTtcRecord | null {
  let best: MinTtcRecord | null = null;
  for (const item of series ?? []) {
    if (!seriesPairMatches(item.pair, pair)) continue;
    for (let i = 0; i < item.t.length; i++) {
      const t = item.t[i]!;
      const value = item.value[i]!;
      if (t < window[0] || t > window[1]) continue;
      if (best === null || value < best.value || (value === best.value && t < best.t)) best = { value, t, pair: item.pair };
    }
  }
  return best;
}

/** Select metric minima from retained samples without changing global summaries. */
export function criticalityMetricsInWindow(
  metrics: EpisodeMetrics,
  window: readonly [number, number],
  pair?: readonly [string, string],
): { minTTC: MinTtcRecord | null; minPathTTC: MinPathTtcRecord | null; minPET: MinPetRecord | null } {
  const samples = metrics.criticalitySamples;
  const minTTC = minimumTtcInWindow(samples?.ttc, window, pair);
  let minPathTTC: MinPathTtcRecord | null = null;
  for (const item of samples?.pathTTC ?? []) {
    if (!seriesPairMatches(item.pair, pair)) continue;
    for (let i = 0; i < item.t.length; i++) {
      const t = item.t[i]!;
      const value = item.value[i]!;
      if (t < window[0] || t > window[1]) continue;
      if (minPathTTC === null || value < minPathTTC.value || (value === minPathTTC.value && t < minPathTTC.t)) {
        minPathTTC = { value, t, pair: item.pair, conflictPoint: { x: item.conflictX[i]!, y: item.conflictY[i]! } };
      }
    }
  }
  let minPET: MinPetRecord | null = null;
  for (const item of samples?.pet ?? []) {
    if (!seriesPairMatches(item.pair, pair)) continue;
    for (let i = 0; i < item.t.length; i++) {
      const t = item.t[i]!;
      const value = item.value[i]!;
      if (t < window[0] || t > window[1]) continue;
      // PET is only defined for separated conflict-zone occupancy. Legacy or
      // externally supplied traces can still contain the overlap sentinel 0;
      // leave that state to path-TTC rather than treating it as a PET minimum.
      if (!Number.isFinite(value) || value <= 0) continue;
      if (minPET === null || value < minPET.value || (value === minPET.value && t < minPET.t)) {
        minPET = {
          value, t, pair: item.pair, conflictPoint: { x: item.conflictX[i]!, y: item.conflictY[i]! },
          firstActor: item.firstActor[i]!, secondActor: item.secondActor[i]!,
        };
      }
    }
  }
  return {
    minTTC,
    minPathTTC,
    minPET,
  };
}

export function evaluateMetrics(
  metrics: EpisodeMetrics,
  clipSeconds: number,
  filters: EvaluateFilters = {},
): TraceEvaluation {
  const findings: RejectFinding[] = [];
  const tags: string[] = [];
  const trivialTtc = filters.trivialTtcS ?? DEFAULT_TRIVIAL_TTC_S;
  const trivialPet = filters.trivialPetS ?? DEFAULT_TRIVIAL_PET_S;
  const maxDecel = filters.maxAchievableDecelMps2 ?? DEFAULT_MAX_DECEL_MPS2;
  const [lo, hi] = filters.window ?? criticalityWindow(clipSeconds);

  const windowMetrics = criticalityMetricsInWindow(metrics, [lo, hi]);
  const hasWindowSamples = metrics.criticalitySamples !== undefined;
  const minTtc = hasWindowSamples ? windowMetrics.minTTC : metrics.minTTC;
  const minPathTtc = hasWindowSamples ? windowMetrics.minPathTTC : (metrics.minPathTTC ?? null);
  const pathWins = minPathTtc !== null && (
    minTtc === null ||
    minPathTtc.value < minTtc.value ||
    (minPathTtc.value === minTtc.value && minPathTtc.t < minTtc.t)
  );
  const ttcCriticality = pathWins ? minPathTtc : minTtc;
  const minPet = hasWindowSamples ? windowMetrics.minPET : (metrics.minPET ?? null);
  // PET is the faithful severity measure for a separated crossing. PET=0 is
  // overlapping occupancy and remains owned by finite path-TTC; do not let a
  // zero PET move the criticality timestamp to an earlier prediction sample.
  const petWins = minPet !== null && minPet.value > 0 &&
    (ttcCriticality === null || ttcCriticality.value > trivialTtc);
  const criticality = petWins ? minPet : ttcCriticality;
  const criticalityKind = criticality === null
    ? null
    : petWins
      ? 'pet' as const
      : pathWins
        ? 'path-ttc' as const
        : 'ttc' as const;
  const trivialThreshold = criticalityKind === 'pet' ? trivialPet : trivialTtc;
  const globalHasInteraction = metrics.minTTC !== null || (metrics.minPathTTC ?? null) !== null || (metrics.minPET ?? null) !== null;
  if (criticality === null && globalHasInteraction && hasWindowSamples) {
    findings.push({
      code: 'out_of_window',
      reason: `no finite criticality observation falls inside [${lo}, ${hi}] s`,
      detail: { window: [lo, hi] },
    });
  } else if (criticality === null) {
    findings.push({
      code: 'no_interaction',
      reason: 'no pair produced finite TTC or crossing path-TTC — the episode has no interaction at all',
    });
  } else if (criticality.value > trivialThreshold) {
    tags.push('negative-control');
    findings.push({
      code: 'trivially_safe',
      reason: `min ${criticalityKind} ${criticality.value.toFixed(2)} s exceeds the ${trivialThreshold} s triviality threshold`,
      detail: { criticality: criticality.value, kind: criticalityKind, pair: criticality.pair },
    });
  }

  let worstDecel = 0;
  let worstActor = '';
  const ambientActorIds = new Set(filters.ambientActorIds ?? []);
  for (const id of Object.keys(metrics.requiredDecelMax).sort()) {
    if (ambientActorIds.has(id)) continue;
    const v = metrics.requiredDecelMax[id]!;
    if (v > worstDecel) {
      worstDecel = v;
      worstActor = id;
    }
  }
  if (worstDecel > maxDecel) {
    findings.push({
      code: 'physically_unavoidable',
      reason: `${worstActor} needed ${worstDecel.toFixed(2)} m/s², above the ${maxDecel.toFixed(2)} m/s² friction ceiling`,
      detail: { actorId: worstActor, requiredDecel: worstDecel, ceiling: maxDecel },
    });
  }

  const required = filters.requiredTriggers;
  const neverFired = required
    ? metrics.triggerNeverFired.filter((id) => required.includes(id))
    : metrics.triggerNeverFired;
  if (neverFired.length > 0) {
    findings.push({
      code: 'never_fired',
      reason: `trigger(s) never fired: ${neverFired.join(', ')}`,
      detail: { interactionIds: neverFired },
    });
  }

  if (!hasWindowSamples && criticality !== null && (criticality.t < lo || criticality.t > hi)) {
    findings.push({
      code: 'out_of_window',
      reason: `criticality peak at t=${criticality.t.toFixed(2)} s falls outside [${lo}, ${hi}] s`,
      detail: { t: criticality.t, kind: criticalityKind, window: [lo, hi] },
    });
  }

  if (metrics.collisions.length > 0) {
    tags.push('collision');
    if (filters.rejectCollisions) {
      findings.push({
        code: 'collision',
        reason: `${metrics.collisions.length} collision(s) occurred`,
        detail: { collisions: metrics.collisions },
      });
    }
  }

  const occlusionUnproven = (metrics.declaredOcclusion ?? []).filter(
    (entry) => entry.status !== 'revealed_before_conflict',
  );
  if (occlusionUnproven.length > 0) {
    findings.push({
      code: 'occlusion_unproven',
      reason: `${occlusionUnproven.length} declared occlusion relation(s) did not produce a blocked-to-clear reveal before conflict`,
      detail: {
        declarations: occlusionUnproven.map((entry) => ({
          observer: entry.observer,
          target: entry.target,
          occluderId: entry.occluderId ?? null,
          status: entry.status,
        })),
      },
    });
  }

  const blocking = findings.filter(
    (f) => !(f.code === 'trivially_safe' && filters.negativeControl),
  );

  return {
    verdict: blocking.length === 0 ? 'accept' : 'reject',
    findings,
    tags,
    summary: {
      minTTC: minTtc?.value ?? null,
      minTTCt: minTtc?.t ?? null,
      criticalityKind,
      criticality: criticality?.value ?? null,
      criticalityT: criticality?.t ?? null,
      requiredDecelMax: worstDecel,
      collisions: metrics.collisions.length,
      neverFired: neverFired.length,
      occlusionUnproven: occlusionUnproven.length,
    },
  };
}

/** Apply the reject filters to a trace. */
export function evaluateTrace(trace: SimTrace, filters: EvaluateFilters = {}): TraceEvaluation {
  const frictionScale = trace.header.operationalConditions?.effects.frictionScale ?? 1;
  return evaluateMetrics(trace.metrics, trace.header.clipSeconds, {
    ...filters,
    ambientActorIds: filters.ambientActorIds ?? trace.header.ambientActorIds ?? [],
    maxAchievableDecelMps2:
      filters.maxAchievableDecelMps2 ?? DEFAULT_MAX_DECEL_MPS2 * frictionScale,
  });
}
