/**
 * Episode metrics — the block that reject filters and evaluators consume.
 *
 * Accumulated online during the recorded window (`t ≥ 0`) so a long clip never
 * needs a second pass over the tick arrays.
 *
 * **reveal-to-conflict**: when occluders are present, we track for each pair
 * the last time line of sight *opened* before the criticality peak. The metric
 * is `conflictT − losOpenT` — the research doc's single derived occlusion
 * number, whose critical band is 0.4–1.5 s.
 */

import { pairKey, readPair, readPathConflict, readStaticObbPathConflict, readStaticPathConflict } from '../sim/pairs.js';
import type { OcclusionPair } from '../schema/input.js';
import type { ActorRuntime } from '../sim/state.js';
import { hasLineOfSight, type OccluderShape } from '../sim/visibility.js';
import type { Obb } from '../core/math.js';
import type {
  DeclaredOcclusionMetric,
  EpisodeMetrics,
  MinPetRecord,
  MinPathTtcRecord,
  MinTtcRecord,
  OccluderIneffective,
  PairMinDistance,
  RevealToConflict,
} from './trace.js';
import { MONITORED_PAIR_POLICY_VERSION, selectMetricPair } from './monitored-pairs.js';

interface PairAccumulator {
  readonly a: string;
  readonly b: string;
  minDistance: number;
  minDistanceT: number;
  minTtc: number;
  minTtcT: number;
  minPathTtc: number;
  minPathTtcT: number;
  minPathTtcPoint: { x: number; y: number } | null;
  minPet: number;
  minPetT: number;
  minPetPoint: { x: number; y: number } | null;
  minPetFirstActor: string | null;
  minPetSecondActor: string | null;
  readonly ttcSamples: { t: number[]; value: number[] };
  readonly pathTtcSamples: { t: number[]; value: number[]; x: number[]; y: number[] };
  readonly petSamples: {
    t: number[]; value: number[]; x: number[]; y: number[]; firstActor: string[]; secondActor: string[];
  };
}

interface BlockedInterval {
  readonly startT: number;
  endT: number | null;
}

interface OcclusionMonitor {
  readonly key: string;
  readonly pair: [string, string];
  readonly occluderId?: string;
  /** Concrete ids observed for this declared ref; proves a non-vacuous relevant set. */
  readonly relevantOccluderIds: Set<string>;
  /** Blocked intervals observed after t=0, transition-compressed. */
  readonly blockedIntervals: BlockedInterval[];
  /** First sample at or after t=0 where this declared ref blocked the pair. */
  firstBlockedT: number | null;
  /** Most recent transition from blocked to clear line of sight. */
  losOpenT: number | null;
  losBlocked: boolean;
  sawOccluder: boolean;
  sawBlocked: boolean;
}

export interface MetricAccumulator {
  /** When set, only pairs containing this actor enter episode criticality. */
  readonly metricSubject: string | null;
  /**
   * Generated background road users. Any pair touching one of these is not
   * scored, so ambient traffic can never take `minTTC`/`minPET`/`minDistance`
   * away from the authored pair. Collisions remain global.
   */
  readonly ambientActorIds: ReadonlySet<string>;
  readonly pairs: Map<string, PairAccumulator>;
  readonly occlusionMonitors: OcclusionMonitor[];
  readonly requiredDecelMax: Record<string, number>;
  readonly collisions: Array<{
    t: number;
    a: string;
    b: string;
    colliderA?: string;
    colliderB?: string;
  }>;
  readonly triggerNeverFired: string[];
  ticks: number;
}

export function newMetricAccumulator(
  actorIds: readonly string[],
  occlusionPairs: readonly OcclusionPair[] = [],
  metricSubject: string | null = null,
  ambientActorIds: readonly string[] = [],
): MetricAccumulator {
  const requiredDecelMax: Record<string, number> = {};
  for (const id of [...actorIds].sort()) requiredDecelMax[id] = 0;
  return {
    metricSubject,
    ambientActorIds: new Set(ambientActorIds),
    pairs: new Map(),
    occlusionMonitors: occlusionPairs
      .map((p) => ({
        key: pairKey(p.observer, p.target),
        pair: [p.observer, p.target] as [string, string],
        ...(p.occluderId === undefined ? {} : { occluderId: p.occluderId }),
        relevantOccluderIds: new Set<string>(),
        blockedIntervals: [],
        firstBlockedT: null,
        losOpenT: null,
        losBlocked: false,
        sawOccluder: false,
        sawBlocked: false,
      }))
      .sort((a, b) => a.key.localeCompare(b.key) || (a.occluderId ?? '').localeCompare(b.occluderId ?? '')),
    requiredDecelMax,
    collisions: [],
    triggerNeverFired: [],
    ticks: 0,
  };
}

function pairAcc(acc: MetricAccumulator, a: string, b: string): PairAccumulator {
  const key = pairKey(a, b);
  let p = acc.pairs.get(key);
  if (!p) {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    p = {
      a: lo,
      b: hi,
      minDistance: Infinity,
      minDistanceT: 0,
      minTtc: Infinity,
      minTtcT: 0,
      minPathTtc: Infinity,
      minPathTtcT: 0,
      minPathTtcPoint: null,
      minPet: Infinity,
      minPetT: 0,
      minPetPoint: null,
      minPetFirstActor: null,
      minPetSecondActor: null,
      ttcSamples: { t: [], value: [] },
      pathTtcSamples: { t: [], value: [], x: [], y: [] },
      petSamples: { t: [], value: [], x: [], y: [], firstActor: [], secondActor: [] },
    };
    acc.pairs.set(key, p);
  }
  return p;
}

/** Fold one recorded tick into the accumulator. */
export function observeTick(
  acc: MetricAccumulator,
  t: number,
  actors: readonly ActorRuntime[],
  _collisions: ReadonlySet<string>,
  occluders: readonly OccluderShape[],
  visibilityRangeM = Infinity,
  staticCollisionShapes: ReadonlyMap<string, ReadonlyMap<string, Obb>> = new Map(),
): void {
  acc.ticks++;
  const live = actors.filter((a) => a.present && !a.retired);
  const explicitPairs = new Set(acc.occlusionMonitors.map((monitor) => monitor.key));
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i]!;
      const b = live[j]!;
      const bothStatic = a.static && b.static;
      const key = pairKey(a.id, b.id);
      const staticActor = a.static ? a : b.static ? b : null;
      const movingActor = a.static ? b : b.static ? a : null;
      const staticShapes = staticActor ? staticCollisionShapes.get(staticActor.id) : undefined;
      const hasArticulatedShape = [...(staticShapes?.keys() ?? [])].some((name) => name.startsWith('door:'));
      const selection = selectMetricPair({
        version: MONITORED_PAIR_POLICY_VERSION,
        metricSubject: acc.metricSubject,
        explicitPairs,
        ambientActorIds: acc.ambientActorIds,
      }, a.id, b.id, hasArticulatedShape);
      const { monitored, scored } = selection;
      // Hard stop: an ambient pair is never scored, not even through the
      // articulated-static escape hatch below.
      if (selection.reason === 'ambient-excluded') continue;
      if (!scored && !monitored && !hasArticulatedShape) continue;
      const staticPaths = staticActor && movingActor
        ? [...(staticShapes?.values() ?? [])]
          .map((shape) => readStaticObbPathConflict(movingActor, shape, undefined, t))
          .filter((path): path is NonNullable<typeof path> => path !== null)
        : [];
      const staticPath = staticActor && movingActor
        ? staticPaths.reduce<ReturnType<typeof readStaticPathConflict>>(
          (best, path) => best === null || path.pathTtcS < best.pathTtcS ? path : best,
          readStaticPathConflict(movingActor, staticActor, undefined, t),
        )
        : null;
      // Static actors are physical collidables, unlike visual `occluders`, but
      // only a dynamic-static collision course enters criticality metrics. This
      // keeps an adjacent parked/occluding actor from stealing the incident.
      // A non-collision-course static actor is still allowed to participate in
      // a declared LOS monitor, but it must not become a scored critical pair.
      const scorePair = bothStatic
        ? scored
        : (scored || hasArticulatedShape) && (!(a.static || b.static) || staticPath !== null);
      let p: PairAccumulator | null = null;
      if (scorePair) {
        p = pairAcc(acc, a.id, b.id);
        const r = readPair(a, b);
        if (r.gapM < p.minDistance) {
          p.minDistance = r.gapM;
          p.minDistanceT = t;
        }
        const ttc = staticPath?.pathTtcS ?? r.ttcS;
        if (Number.isFinite(ttc)) {
          p.ttcSamples.t.push(t);
          p.ttcSamples.value.push(ttc);
        }
        if (ttc < p.minTtc) {
          p.minTtc = ttc;
          p.minTtcT = t;
        }
        const path = staticPath
          ? { ...staticPath, petS: Infinity, arrivalAS: 0, arrivalBS: 0 }
          : readPathConflict(a, b, undefined, t);
        if (path && path.pathTtcS < p.minPathTtc) {
          p.minPathTtc = path.pathTtcS;
          p.minPathTtcT = t;
          p.minPathTtcPoint = path.conflictPoint;
        }
        if (path && Number.isFinite(path.pathTtcS)) {
          p.pathTtcSamples.t.push(t);
          p.pathTtcSamples.value.push(path.pathTtcS);
          p.pathTtcSamples.x.push(path.conflictPoint.x);
          p.pathTtcSamples.y.push(path.conflictPoint.y);
        }
        // PET is defined only after one participant has cleared the conflict
        // zone. A zero value means simultaneous occupancy; collision/path-TTC
        // metrics own that state and it must not pin the PET minimum forever.
        if (path && Number.isFinite(path.petS) && path.petS > 0 && path.petS < p.minPet) {
          p.minPet = path.petS;
          p.minPetT = t;
          p.minPetPoint = path.conflictPoint;
          if (path.arrivalAS <= path.arrivalBS) {
            p.minPetFirstActor = a.id;
            p.minPetSecondActor = b.id;
          } else {
            p.minPetFirstActor = b.id;
            p.minPetSecondActor = a.id;
          }
        }
        if (path && Number.isFinite(path.petS) && path.petS > 0) {
          const firstActor = path.arrivalAS <= path.arrivalBS ? a.id : b.id;
          const secondActor = firstActor === a.id ? b.id : a.id;
          p.petSamples.t.push(t);
          p.petSamples.value.push(path.petS);
          p.petSamples.x.push(path.conflictPoint.x);
          p.petSamples.y.push(path.conflictPoint.y);
          p.petSamples.firstActor.push(firstActor);
          p.petSamples.secondActor.push(secondActor);
        }
      }
      for (const monitor of acc.occlusionMonitors) {
        if (monitor.key !== key) continue;
        const relevant = monitor.occluderId
          ? occluders.filter((o) => o.id === monitor.occluderId || o.groupId === monitor.occluderId)
          : occluders;
        if (relevant.length === 0) continue;
        monitor.sawOccluder = true;
        for (const o of relevant) monitor.relevantOccluderIds.add(o.id);
        const clear = hasLineOfSight(a.position, b.position, relevant, visibilityRangeM);
        if (!clear) {
          if (!monitor.losBlocked) monitor.blockedIntervals.push({ startT: t, endT: null });
          if (monitor.firstBlockedT === null) monitor.firstBlockedT = t;
          monitor.losBlocked = true;
          monitor.sawBlocked = true;
        } else if (monitor.losBlocked) {
          monitor.losBlocked = false;
          monitor.losOpenT = t;
          const latest = monitor.blockedIntervals[monitor.blockedIntervals.length - 1];
          if (latest) latest.endT = t;
        }
      }
    }
  }
}

/**
 * Keep criticality away from the recorded edges without imposing a long-clip
 * assumption. The historic 20 s contract reserves four seconds at each end;
 * compact, mechanism-faithful clips reserve the same 20% proportion instead.
 * This remains an evidence gate: a three-second clip needs its critical event
 * inside [0.6, 2.4], proving setup and aftermath rather than bypassing review.
 */
export function criticalityWindow(clipSeconds: number): [number, number] {
  const edgeGuard = Math.min(4, clipSeconds * 0.2);
  return [edgeGuard, Math.max(edgeGuard, clipSeconds - edgeGuard)];
}

function revealOpenTAtConflict(monitor: OcclusionMonitor, conflictT: number): number | null {
  let latest: BlockedInterval | null = null;
  for (const interval of monitor.blockedIntervals) {
    if (interval.startT <= conflictT) latest = interval;
    else break;
  }
  // If the latest blocked interval before conflict has no closing clear sample,
  // or clears only after conflict, the actor is still hidden at conflict. Do not
  // reuse an older open transition from a previous interval.
  if (!latest || latest.endT === null || latest.endT > conflictT) return null;
  return latest.endT;
}

export function computeMetrics(acc: MetricAccumulator, clipSeconds: number): EpisodeMetrics {
  const keys = [...acc.pairs.keys()].sort();

  const minDistance: PairMinDistance[] = [];
  let minTTC: MinTtcRecord | null = null;
  let minPathTTC: MinPathTtcRecord | null = null;
  let minPET: MinPetRecord | null = null;
  for (const key of keys) {
    const p = acc.pairs.get(key)!;
    if (Number.isFinite(p.minDistance)) {
      minDistance.push({ pair: [p.a, p.b], minDistanceM: p.minDistance, t: p.minDistanceT });
    }
    if (Number.isFinite(p.minTtc) && (minTTC === null || p.minTtc < minTTC.value)) {
      minTTC = { value: p.minTtc, t: p.minTtcT, pair: [p.a, p.b] };
    }
    if (
      Number.isFinite(p.minPathTtc) &&
      p.minPathTtcPoint !== null &&
      (minPathTTC === null || p.minPathTtc < minPathTTC.value)
    ) {
      minPathTTC = {
        value: p.minPathTtc,
        t: p.minPathTtcT,
        pair: [p.a, p.b],
        conflictPoint: p.minPathTtcPoint,
      };
    }
    if (
      Number.isFinite(p.minPet) &&
      p.minPetPoint !== null &&
      p.minPetFirstActor !== null &&
      p.minPetSecondActor !== null &&
      (minPET === null || p.minPet < minPET.value)
    ) {
      minPET = {
        value: p.minPet,
        t: p.minPetT,
        pair: [p.a, p.b],
        conflictPoint: p.minPetPoint,
        firstActor: p.minPetFirstActor,
        secondActor: p.minPetSecondActor,
      };
    }
  }

  const declaredOcclusion: DeclaredOcclusionMetric[] = acc.occlusionMonitors.map((monitor) => {
    const p = acc.pairs.get(monitor.key);
    const pair = p ? [p.a, p.b] as [string, string] : [...monitor.pair].sort() as [string, string];
    const common = {
      observer: monitor.pair[0],
      target: monitor.pair[1],
      pair,
      ...(monitor.occluderId === undefined ? {} : { occluderId: monitor.occluderId }),
      relevantOccluderIds: [...monitor.relevantOccluderIds].sort(),
    };
    if (!p || !Number.isFinite(p.minDistance)) {
      return {
        ...common,
        status: 'pair_unobserved' as const,
        firstBlockedT: monitor.firstBlockedT,
        losOpenT: null,
        conflictT: null,
        revealToConflictS: null,
      };
    }
    // Reveal evidence is bound to the predicted physical conflict instant,
    // not the earlier sample at which TTC happened to reach its minimum. A
    // long-range first TTC sample can precede an actual reveal by seconds.
    const conflictT = p.minPathTtc < p.minTtc
      ? p.minPathTtcT + p.minPathTtc
      : p.minTtc === Infinity
        ? p.minDistanceT
        : p.minTtcT + p.minTtc;
    if (!monitor.sawOccluder) {
      return {
        ...common,
        status: 'occluder_unobserved' as const,
        firstBlockedT: monitor.firstBlockedT,
        losOpenT: null,
        conflictT,
        revealToConflictS: null,
      };
    }
    const losOpenT = revealOpenTAtConflict(monitor, conflictT);
    if (losOpenT !== null) {
      return {
        ...common,
        status: 'revealed_before_conflict' as const,
        firstBlockedT: monitor.firstBlockedT,
        losOpenT,
        conflictT,
        revealToConflictS: conflictT - losOpenT,
      };
    }
    if (monitor.firstBlockedT === null || monitor.firstBlockedT > conflictT) {
      return {
        ...common,
        status: 'never_blocked_before_conflict' as const,
        firstBlockedT: monitor.firstBlockedT,
        losOpenT: null,
        conflictT,
        revealToConflictS: null,
      };
    }
    return {
      ...common,
      status: 'blocked_at_conflict' as const,
      firstBlockedT: monitor.firstBlockedT,
      losOpenT: null,
      conflictT,
      revealToConflictS: null,
    };
  });

  let revealToConflict: RevealToConflict | null = null;
  const occluderIneffective: OccluderIneffective[] = [];
  const ttcCriticality = minPathTTC !== null && (
    minTTC === null ||
    minPathTTC.value < minTTC.value ||
    (minPathTTC.value === minTTC.value && minPathTTC.t < minTTC.t)
  ) ? minPathTTC : minTTC;
  const effectiveCriticality = minPET !== null && minPET.value > 0 &&
    (ttcCriticality === null || ttcCriticality.value > 3)
    ? minPET
    : ttcCriticality;
  if (effectiveCriticality) {
    const candidates = declaredOcclusion
      .filter((metric) =>
        metric.status === 'revealed_before_conflict' &&
        pairKey(metric.pair[0], metric.pair[1]) === pairKey(effectiveCriticality.pair[0], effectiveCriticality.pair[1]) &&
        metric.losOpenT !== null,
      )
      .sort((a, b) => (b.losOpenT as number) - (a.losOpenT as number));
    const best = candidates[0];
    if (best) {
      const conflictT = best.conflictT ?? (effectiveCriticality.t + effectiveCriticality.value);
      revealToConflict = {
        observer: best.observer,
        target: best.target,
        value: conflictT - (best.losOpenT as number),
        firstBlockedT: best.firstBlockedT ?? (best.losOpenT as number),
        losOpenT: best.losOpenT as number,
        conflictT,
        pair: effectiveCriticality.pair,
        ...(best.occluderId === undefined ? {} : { occluderId: best.occluderId }),
        relevantOccluderIds: best.relevantOccluderIds,
      };
    }
  }
  for (const metric of declaredOcclusion) {
    if (metric.status === 'never_blocked_before_conflict' && metric.conflictT !== null) {
      occluderIneffective.push({
        observer: metric.observer,
        target: metric.target,
        pair: metric.pair,
        conflictT: metric.conflictT,
        ...(metric.firstBlockedT === null ? {} : { firstBlockedT: metric.firstBlockedT }),
        ...(metric.occluderId === undefined ? {} : { occluderId: metric.occluderId }),
        relevantOccluderIds: metric.relevantOccluderIds,
        reason: 'never_blocked_before_conflict',
      });
    }
  }

  const [lo, hi] = criticalityWindow(clipSeconds);
  const windowMinimum = (kind: 'ttcSamples' | 'pathTtcSamples' | 'petSamples'): number => {
    let value = Infinity;
    for (const key of keys) {
      const series = acc.pairs.get(key)![kind];
      for (let i = 0; i < series.t.length; i++) {
        if (series.t[i]! >= lo && series.t[i]! <= hi && series.value[i]! < value) value = series.value[i]!;
      }
    }
    return value;
  };
  const windowTtc = windowMinimum('ttcSamples');
  const windowPathTtc = windowMinimum('pathTtcSamples');
  const windowTtcCriticality = Math.min(windowTtc, windowPathTtc);
  const windowPet = windowMinimum('petSamples');
  const windowHasCriticality = Number.isFinite(windowTtcCriticality) ||
    (Number.isFinite(windowPet) && windowPet > 0 && (!Number.isFinite(windowTtcCriticality) || windowTtcCriticality > 3));
  const clipped = effectiveCriticality !== null && !windowHasCriticality;

  const requiredDecelMax: Record<string, number> = {};
  for (const id of Object.keys(acc.requiredDecelMax).sort()) {
    requiredDecelMax[id] = acc.requiredDecelMax[id]!;
  }

  return {
    minTTC,
    minPathTTC,
    minPET,
    criticalitySamples: {
      ttc: keys.flatMap((key) => {
        const p = acc.pairs.get(key)!;
        return p.ttcSamples.t.length === 0 ? [] : [{ pair: [p.a, p.b] as [string, string], ...p.ttcSamples }];
      }),
      pathTTC: keys.flatMap((key) => {
        const p = acc.pairs.get(key)!;
        return p.pathTtcSamples.t.length === 0 ? [] : [{
          pair: [p.a, p.b] as [string, string], t: p.pathTtcSamples.t, value: p.pathTtcSamples.value,
          conflictX: p.pathTtcSamples.x, conflictY: p.pathTtcSamples.y,
        }];
      }),
      pet: keys.flatMap((key) => {
        const p = acc.pairs.get(key)!;
        return p.petSamples.t.length === 0 ? [] : [{
          pair: [p.a, p.b] as [string, string], t: p.petSamples.t, value: p.petSamples.value,
          conflictX: p.petSamples.x, conflictY: p.petSamples.y,
          firstActor: p.petSamples.firstActor, secondActor: p.petSamples.secondActor,
        }];
      }),
    },
    minDistance,
    requiredDecelMax,
    revealToConflict,
    declaredOcclusion,
    occluderIneffective,
    collisions: [...acc.collisions].sort((a, b) => a.t - b.t || (a.a < b.a ? -1 : 1)),
    triggerNeverFired: [...new Set(acc.triggerNeverFired)].sort(),
    clippedCriticality: clipped,
    ticksSimulated: acc.ticks,
  };
}
