/**
 * Tier-2 invariant residuals.
 *
 * `sim-engine` types `metrics.invariantResiduals` and deliberately leaves it
 * empty: invariants live in the template layer, so only something that has read
 * the template can populate it. That is this module.
 *
 * The rule it follows is the one from the research doc — *absolute values are
 * re-derived, relations are preserved* — so every check here is a relation
 * between two actors or between an actor and the posted limit, and every
 * residual is reported in the invariant's own units with the sign that says
 * which way it missed.
 *
 * Where a check is an approximation it says so in `method`, because a residual
 * whose provenance is unclear is a number nobody can act on:
 *
 * | invariant | source |
 * |---|---|
 * | `ttc` | `metrics.minTTC` (engine, closing-speed form) |
 * | `path_ttc` | `metrics.minPathTTC` (route/conflict-zone occupancy) |
 * | `pet` | `metrics.minPET` (route-intersection occupancy separation) |
 * | `gap` (distance) | `metrics.minDistance` for the pair |
 * | `gap` (time), `headway` | per-tick centre distance ÷ follower speed — Euclidean, not along-lane |
 * | `closing_speed` | per-tick range rate at the criticality peak |
 * | `speed_rel_limit` | per-tick speed ÷ the entry lane's posted limit |
 * | `event_order` | `trigger_fired` events |
 * | `decel_budget` | `metrics.requiredDecelMax` |
 * | `arrival` | the arrival solver's achieved Δt |
 */

import {
  evaluateExpr,
  type ExprScope,
  type Invariant,
  type Range,
  type ScenarioTemplateV2,
} from '@simforge/scenario';
import {
  criticalityMetricsInWindow,
  verifyNearMissOutcome,
  type ArrivalSolution,
  type SensorPerceptionMetric,
  type SimTrace,
} from '@simforge/engine';

export interface InvariantResidualReport {
  readonly id: string;
  readonly kind: string;
  readonly essentiality: string;
  readonly status: 'held' | 'violated' | 'unchecked';
  readonly range: [number | null, number | null] | null;
  readonly achieved: number | null;
  /** Signed distance outside the range, in the invariant's own units. */
  readonly residual: number;
  readonly method: string;
  readonly reason: string;
}

function outside(range: Range, value: number): number {
  const [lo, hi] = range;
  if (lo !== null && value < lo) return value - lo;
  if (hi !== null && value > hi) return value - hi;
  return 0;
}

function fmtRange(range: Range): string {
  return `[${range[0] ?? '−∞'}, ${range[1] ?? '∞'}]`;
}

interface TrackPair {
  readonly t: number[];
  readonly distance: number[];
  readonly speedOf: number[];
  readonly closing: number[];
}

function pairSeries(trace: SimTrace, a: string, b: string): TrackPair | null {
  const ta = trace.ticks.actors[a];
  const tb = trace.ticks.actors[b];
  if (!ta || !tb) return null;
  const t: number[] = [];
  const distance: number[] = [];
  const speedOf: number[] = [];
  const closing: number[] = [];
  let prevD: number | null = null;
  let prevT = 0;
  for (let i = 0; i < trace.ticks.t.length; i += 1) {
    if (ta.present[i] !== 1 || tb.present[i] !== 1) {
      prevD = null;
      continue;
    }
    const d = Math.hypot((ta.x[i] as number) - (tb.x[i] as number), (ta.y[i] as number) - (tb.y[i] as number));
    const now = trace.ticks.t[i] as number;
    t.push(now);
    distance.push(d);
    speedOf.push(ta.speedMps[i] as number);
    closing.push(prevD === null || now === prevT ? 0 : (prevD - d) / (now - prevT));
    prevD = d;
    prevT = now;
  }
  return t.length > 0 ? { t, distance, speedOf, closing } : null;
}

/**
 * Per-sensor summaries for one observer/target pair, or `null` when the pair is
 * not in the channel at all. Omitting `sensorId` returns the whole suite, which
 * the callers reduce over — a suite detects when its earliest sensor does.
 */
function perceptionEntries(
  trace: SimTrace,
  observer: string,
  target: string,
  sensorId: string | undefined,
): SensorPerceptionMetric[] | null {
  const all = trace.metrics.perception?.sensors;
  if (all === undefined) return null;
  const entries = all.filter(
    (entry) => entry.observer === observer
      && entry.target === target
      && (sensorId === undefined || entry.sensorId === sensorId),
  );
  return entries.length > 0 ? entries : null;
}

/** Why a perception invariant could not be checked, in the author's terms. */
function perceptionMissingReason(
  trace: SimTrace,
  observer: string,
  target: string,
  sensorId: string | undefined,
): string {
  if (trace.metrics.perception === undefined) {
    return 'the trace carries no perception channel: no actor declared a sensor';
  }
  const forObserver = trace.metrics.perception.sensors.filter((entry) => entry.observer === observer);
  if (forObserver.length === 0) return `${observer} declares no sensors`;
  if (sensorId !== undefined && !forObserver.some((entry) => entry.sensorId === sensorId)) {
    return `${observer} has no sensor "${sensorId}"`;
  }
  return `${observer} never observed ${target}`;
}

function windowOf(inv: Invariant, scope: ExprScope, clipSeconds: number): [number, number] {
  if (!inv.window) return [0, clipSeconds];
  try {
    return [evaluateExpr(inv.window[0], scope), evaluateExpr(inv.window[1], scope)];
  } catch {
    return [0, clipSeconds];
  }
}

export interface InvariantContext {
  readonly template: ScenarioTemplateV2;
  readonly trace: SimTrace;
  readonly scope: ExprScope;
  readonly arrival: readonly ArrivalSolution[];
  /** Posted limit of the reference lane, kph — what `speed_rel_limit` divides by. */
  readonly speedLimitKph: number | null;
}

export function checkInvariants(ctx: InvariantContext): InvariantResidualReport[] {
  const { template, trace, scope } = ctx;
  const clip = trace.header.clipSeconds;
  const out: InvariantResidualReport[] = [];

  const unchecked = (inv: Invariant, reason: string): InvariantResidualReport => ({
    id: inv.id,
    kind: inv.kind,
    essentiality: inv.essentiality,
    status: 'unchecked',
    range: null,
    achieved: null,
    residual: 0,
    method: 'none',
    reason,
  });

  const report = (
    inv: Invariant,
    range: Range,
    achieved: number,
    method: string,
    reason: string,
  ): InvariantResidualReport => {
    const residual = outside(range, achieved);
    return {
      id: inv.id,
      kind: inv.kind,
      essentiality: inv.essentiality,
      status: residual === 0 ? 'held' : 'violated',
      range,
      achieved: Math.round(achieved * 1000) / 1000,
      residual: Math.round(residual * 1000) / 1000,
      method,
      reason,
    };
  };

  for (const inv of template.invariants) {
    const [lo, hi] = windowOf(inv, scope, clip);
    const inWindow = (t: number): boolean => t >= lo && t <= hi;

    switch (inv.kind) {
      case 'ttc': {
        const min = trace.metrics.criticalitySamples === undefined
          ? trace.metrics.minTTC
          : criticalityMetricsInWindow(trace.metrics, [lo, hi], [inv.of, inv.to]).minTTC;
        const pairMatches = min !== null && ((min.pair[0] === inv.of && min.pair[1] === inv.to) || (min.pair[0] === inv.to && min.pair[1] === inv.of));
        if (min === null || !pairMatches) {
          out.push(unchecked(inv, `no TTC was recorded for ${inv.of}/${inv.to}`));
          break;
        }
        if (trace.metrics.criticalitySamples === undefined && !inWindow(min.t)) {
          out.push(unchecked(inv, `the TTC minimum at t=${min.t.toFixed(2)} s is outside the window ${lo}–${hi} s`));
          break;
        }
        out.push(
          report(
            inv,
            inv.range,
            min.value,
            'metrics.minTTC',
            `min TTC ${min.value.toFixed(2)} s at t=${min.t.toFixed(2)} s, wanted ${fmtRange(inv.range)}`,
          ),
        );
        break;
      }
      case 'path_ttc': {
        const min = trace.metrics.criticalitySamples === undefined
          ? (trace.metrics.minPathTTC ?? null)
          : criticalityMetricsInWindow(trace.metrics, [lo, hi], [inv.of, inv.to]).minPathTTC;
        const pairMatches =
          min !== null && ((min.pair[0] === inv.of && min.pair[1] === inv.to) || (min.pair[0] === inv.to && min.pair[1] === inv.of));
        if (min === null || !pairMatches) {
          out.push(unchecked(inv, `no path TTC was recorded for ${inv.of}/${inv.to}`));
          break;
        }
        if (trace.metrics.criticalitySamples === undefined && !inWindow(min.t)) {
          out.push(unchecked(inv, `the path-TTC minimum at t=${min.t.toFixed(2)} s is outside the window ${lo}–${hi} s`));
          break;
        }
        out.push(
          report(
            inv,
            inv.range,
            min.value,
            'metrics.minPathTTC',
            `min path TTC ${min.value.toFixed(2)} s at t=${min.t.toFixed(2)} s, wanted ${fmtRange(inv.range)}`,
          ),
        );
        break;
      }
      case 'pet': {
        const min = trace.metrics.criticalitySamples === undefined
          ? (trace.metrics.minPET ?? null)
          : criticalityMetricsInWindow(trace.metrics, [lo, hi], [inv.of, inv.to]).minPET;
        const pairMatches =
          min !== null && ((min.pair[0] === inv.of && min.pair[1] === inv.to) || (min.pair[0] === inv.to && min.pair[1] === inv.of));
        if (min === null || !pairMatches) {
          out.push(unchecked(inv, `no PET was recorded for ${inv.of}/${inv.to}`));
          break;
        }
        if (trace.metrics.criticalitySamples === undefined && !inWindow(min.t)) {
          out.push(unchecked(inv, `the PET prediction at t=${min.t.toFixed(2)} s is outside the window ${lo}–${hi} s`));
          break;
        }
        out.push(
          report(
            inv,
            inv.range,
            min.value,
            'metrics.minPET',
            `min PET ${min.value.toFixed(2)} s at t=${min.t.toFixed(2)} s, wanted ${fmtRange(inv.range)}`,
          ),
        );
        break;
      }
      case 'near_miss': {
        const verification = verifyNearMissOutcome(trace, {
          pedestrianId: inv.pedestrian,
          targetId: inv.target,
          requestedClearanceM: 0,
          toleranceM: Number.MAX_SAFE_INTEGER,
        });
        if (verification.realizedClearanceM === null) {
          out.push(unchecked(inv, verification.reason));
          break;
        }
        const result = report(
          inv,
          inv.clearanceRangeM,
          verification.realizedClearanceM,
          'exact-sampled-obb-clearance',
          `closest footprint clearance ${verification.realizedClearanceM.toFixed(3)} m at t=${verification.closestApproachTimeS?.toFixed(2) ?? '?'} s`,
        );
        out.push(verification.collision ? {
          ...result,
          status: 'violated',
          residual: result.residual === 0 ? -Math.max(0.001, inv.clearanceRangeM[0] ?? 0.001) : result.residual,
          reason: 'collision occurred; near-miss intent requires strictly positive contact-free clearance',
        } : result);
        break;
      }
      case 'gap': {
        if (inv.unit === 'distance') {
          const series = pairSeries(trace, inv.of, inv.to);
          if (series && inv.window !== undefined) {
            let minDistance = Infinity;
            let minT = 0;
            for (let i = 0; i < series.t.length; i += 1) {
              const t = series.t[i] as number;
              if (!inWindow(t)) continue;
              const distance = series.distance[i] as number;
              if (distance < minDistance) {
                minDistance = distance;
                minT = t;
              }
            }
            if (!Number.isFinite(minDistance)) {
              out.push(unchecked(inv, 'no tick fell inside the window'));
              break;
            }
            out.push(
              report(
                inv,
                inv.range,
                minDistance,
                'pair-series-distance',
                `closest approach ${minDistance.toFixed(2)} m at t=${minT.toFixed(2)} s within the required window`,
              ),
            );
            break;
          }
          const entry = trace.metrics.minDistance.find(
            (d) => (d.pair[0] === inv.of && d.pair[1] === inv.to) || (d.pair[0] === inv.to && d.pair[1] === inv.of),
          );
          if (!entry) {
            out.push(unchecked(inv, `no distance series for ${inv.of}/${inv.to}`));
            break;
          }
          out.push(
            report(
              inv,
              inv.range,
              entry.minDistanceM,
              'metrics.minDistance',
              `closest approach ${entry.minDistanceM.toFixed(2)} m at t=${entry.t.toFixed(2)} s`,
            ),
          );
          break;
        }
        const series = pairSeries(trace, inv.of, inv.to);
        if (!series) {
          out.push(unchecked(inv, `no shared ticks for ${inv.of}/${inv.to}`));
          break;
        }
        let best = Infinity;
        let bestT = 0;
        for (let i = 0; i < series.t.length; i += 1) {
          if (!inWindow(series.t[i] as number)) continue;
          const speed = Math.max(0.5, series.speedOf[i] as number);
          const value = (series.distance[i] as number) / speed;
          if (value < best) {
            best = value;
            bestT = series.t[i] as number;
          }
        }
        if (!Number.isFinite(best)) {
          out.push(unchecked(inv, 'no tick fell inside the window'));
          break;
        }
        out.push(
          report(inv, inv.range, best, 'euclidean-gap/speed', `min time gap ${best.toFixed(2)} s at t=${bestT.toFixed(2)} s`),
        );
        break;
      }
      case 'headway': {
        const series = pairSeries(trace, inv.of, inv.to);
        if (!series) {
          out.push(unchecked(inv, `no shared ticks for ${inv.of}/${inv.to}`));
          break;
        }
        let best = Infinity;
        let bestT = 0;
        for (let i = 0; i < series.t.length; i += 1) {
          if (!inWindow(series.t[i] as number)) continue;
          const speed = Math.max(0.5, series.speedOf[i] as number);
          const value = (series.distance[i] as number) / speed;
          if (value < best) {
            best = value;
            bestT = series.t[i] as number;
          }
        }
        if (!Number.isFinite(best)) {
          out.push(unchecked(inv, 'no tick fell inside the window'));
          break;
        }
        out.push(
          report(inv, inv.range, best, 'euclidean-headway', `min headway ${best.toFixed(2)} s at t=${bestT.toFixed(2)} s`),
        );
        break;
      }
      case 'closing_speed': {
        const series = pairSeries(trace, inv.of, inv.to);
        if (!series) {
          out.push(unchecked(inv, `no shared ticks for ${inv.of}/${inv.to}`));
          break;
        }
        let peak = -Infinity;
        let peakT = 0;
        for (let i = 0; i < series.t.length; i += 1) {
          if (!inWindow(series.t[i] as number)) continue;
          if ((series.closing[i] as number) > peak) {
            peak = series.closing[i] as number;
            peakT = series.t[i] as number;
          }
        }
        if (!Number.isFinite(peak)) {
          out.push(unchecked(inv, 'no tick fell inside the window'));
          break;
        }
        out.push(
          report(
            inv,
            inv.rangeKph,
            peak * 3.6,
            'range-rate',
            `peak closing speed ${(peak * 3.6).toFixed(1)} kph at t=${peakT.toFixed(2)} s`,
          ),
        );
        break;
      }
      case 'speed_rel_limit': {
        const track = trace.ticks.actors[inv.of];
        if (!track || ctx.speedLimitKph === null || ctx.speedLimitKph <= 0) {
          out.push(unchecked(inv, 'no posted speed limit on the reference lane'));
          break;
        }
        let peak = 0;
        for (let i = 0; i < trace.ticks.t.length; i += 1) {
          if (track.present[i] !== 1) continue;
          if (!inWindow(trace.ticks.t[i] as number)) continue;
          peak = Math.max(peak, (track.speedMps[i] as number) * 3.6);
        }
        const frac = peak / ctx.speedLimitKph;
        out.push(
          report(
            inv,
            inv.rangeFrac,
            frac,
            'peak-speed/limit',
            `peak ${peak.toFixed(1)} kph against a ${ctx.speedLimitKph} kph limit`,
          ),
        );
        break;
      }
      case 'event_order': {
        const fired = new Map<string, number>();
        for (const event of trace.events) {
          if (event.kind === 'trigger_fired' && !fired.has(event.interactionId)) {
            fired.set(event.interactionId, event.t);
          }
        }
        const missing = inv.events.filter((id) => !fired.has(id));
        if (missing.length > 0) {
          out.push(unchecked(inv, `interaction(s) never fired: ${missing.join(', ')}`));
          break;
        }
        const minSep = inv.minSeparationS === undefined ? 0 : evaluateExpr(inv.minSeparationS, scope);
        let worst = 0;
        const times = inv.events.map((id) => fired.get(id) as number);
        for (let i = 1; i < times.length; i += 1) {
          const delta = (times[i] as number) - (times[i - 1] as number);
          const need = inv.strict ? Math.max(minSep, 1e-9) : minSep;
          if (delta < need) worst = Math.min(worst, delta - need);
        }
        out.push({
          id: inv.id,
          kind: inv.kind,
          essentiality: inv.essentiality,
          status: worst === 0 ? 'held' : 'violated',
          range: null,
          achieved: Math.round(Math.min(...times.slice(1).map((t, i) => t - (times[i] as number))) * 1000) / 1000,
          residual: Math.round(worst * 1000) / 1000,
          method: 'trigger_fired',
          reason: `fired at ${times.map((t) => t.toFixed(2)).join(' → ')} s`,
        });
        break;
      }
      case 'decel_budget': {
        const achieved = trace.metrics.requiredDecelMax[inv.of];
        if (achieved === undefined) {
          out.push(unchecked(inv, `${inv.of} is not in the trace`));
          break;
        }
        const max = evaluateExpr(inv.maxMps2, scope);
        out.push(
          report(
            inv,
            [null, max],
            achieved,
            'metrics.requiredDecelMax',
            `peak required decel ${achieved.toFixed(2)} m/s² against a ${max} m/s² budget`,
          ),
        );
        break;
      }
      /* ------------------------------------------------------- perception --
       * These read `metrics.perception`, the per-sensor channel's episode
       * summary. An invariant that silently grades nothing is the failure this
       * layer exists to prevent, so a missing summary is reported `unchecked`
       * with the reason rather than passing by default.
       */
      case 'detection_gap': {
        const entries = perceptionEntries(trace, inv.of, inv.to, inv.sensor);
        if (entries === null) {
          out.push(unchecked(inv, perceptionMissingReason(trace, inv.of, inv.to, inv.sensor)));
          break;
        }
        const gaps = entries.flatMap((entry) => entry.gaps)
          .filter((gap) => inv.reason === undefined || gap.reason === inv.reason)
          .filter((gap) => inWindow(gap.startS) || inWindow(gap.endS));
        const achieved = inv.metric === 'total'
          ? gaps.reduce((sum, gap) => sum + gap.durationS, 0)
          : gaps.reduce((max, gap) => Math.max(max, gap.durationS), 0);
        const qualifier = inv.reason === undefined ? '' : ` caused by ${inv.reason}`;
        out.push(
          report(
            inv,
            inv.range,
            achieved,
            'metrics.perception.gaps',
            `${inv.metric} detection gap${qualifier} ${achieved.toFixed(2)} s over ${gaps.length} dropout(s), wanted ${fmtRange(inv.range)}`,
          ),
        );
        break;
      }
      case 'time_to_first_detection': {
        const entries = perceptionEntries(trace, inv.of, inv.to, inv.sensor);
        if (entries === null) {
          out.push(unchecked(inv, perceptionMissingReason(trace, inv.of, inv.to, inv.sensor)));
          break;
        }
        // A suite detects when its *earliest* sensor does.
        const times = entries.map((entry) => entry.timeToFirstDetectionS).filter((t): t is number => t !== null);
        if (times.length === 0) {
          out.push(unchecked(inv, `${inv.of} never detected ${inv.to} at all`));
          break;
        }
        const achieved = Math.min(...times);
        out.push(
          report(
            inv,
            inv.range,
            achieved,
            'metrics.perception.timeToFirstDetectionS',
            `${inv.of} first detected ${inv.to} at t=${achieved.toFixed(2)} s, wanted ${fmtRange(inv.range)}`,
          ),
        );
        break;
      }
      case 'perception_lag': {
        const entries = perceptionEntries(trace, inv.of, inv.to, inv.sensor);
        if (entries === null) {
          out.push(unchecked(inv, perceptionMissingReason(trace, inv.of, inv.to, inv.sensor)));
          break;
        }
        const lags = entries.map((entry) => entry.perceptionLagS).filter((v): v is number => v !== null);
        if (lags.length === 0) {
          const sawLos = entries.some((entry) => entry.firstLineOfSightT !== null);
          out.push(unchecked(
            inv,
            sawLos
              ? `${inv.of} had line of sight to ${inv.to} but never detected it, so the lag is unbounded`
              : `${inv.of} never had line of sight to ${inv.to}, so there is no lag to measure`,
          ));
          break;
        }
        const achieved = Math.min(...lags);
        out.push(
          report(
            inv,
            inv.range,
            achieved,
            'metrics.perception.perceptionLagS',
            `line of sight opened ${achieved.toFixed(2)} s before ${inv.of} reported ${inv.to}, wanted ${fmtRange(inv.range)}`,
          ),
        );
        break;
      }
      case 'map_divergence': {
        const entries = (trace.metrics.perception?.mapDivergence ?? []).filter(
          (entry) => entry.observer === inv.of
            && (entry.id === inv.divergence || entry.id.startsWith(`${inv.divergence}:`)),
        );
        if (entries.length === 0) {
          out.push(unchecked(
            inv,
            trace.metrics.perception === undefined
              ? 'the trace carries no perception channel'
              : `divergence "${inv.divergence}" was not materialized for observer ${inv.of}`,
          ));
          break;
        }
        // Segmented extents are one divergence to the author; sum the exposure.
        const achieved = entries.reduce((sum, entry) => sum + entry.activeS, 0);
        out.push(
          report(
            inv,
            inv.range,
            achieved,
            'metrics.perception.mapDivergence',
            `${inv.of} spent ${achieved.toFixed(2)} s inside "${inv.divergence}" (${entries[0]!.kind}), wanted ${fmtRange(inv.range)}`,
          ),
        );
        break;
      }
      case 'arrival': {
        const solution = ctx.arrival.find(
          (s) => s.actorId === inv.of && s.referenceActorId === inv.syncWith,
        );
        if (!solution) {
          out.push(unchecked(inv, `no arrival solve for ${inv.of} against ${inv.syncWith}`));
          break;
        }
        out.push(
          report(
            inv,
            inv.deltaTRange,
            solution.achievedDeltaT,
            'arrival-solver',
            `achieved Δt ${solution.achievedDeltaT.toFixed(3)} s (requested ${solution.targetDeltaT.toFixed(3)} s)`,
          ),
        );
        break;
      }
    }
  }
  return out;
}
