/**
 * The per-tick perception pass, and the episode summary it accumulates.
 *
 * The engine calls `observe()` once per recorded tick, from the same frozen
 * snapshot the controllers plan against, and reads the result back through
 * `detects()` while evaluating triggers. Fan-out is over *sorted* id lists at
 * every level — sensors by `(observer, sensorId)`, targets by actor id — so the
 * channel is independent of actor declaration order, exactly like the rest of
 * the engine.
 *
 * ## What is closed loop and what is not
 *
 * Object detection *is* closed loop: `detected(...)` is a trigger condition, so
 * an ego that cannot see a pedestrian genuinely brakes late.
 *
 * Map/percept divergence is deliberately **not** closed loop. It is recorded as
 * exposure — which observer was inside which divergent extent, and for how long
 * — so a scenario can require it. The engine has no lane-keeping perception
 * controller to mislead, and manufacturing a steering error from a faded line
 * would be a fiction dressed as a measurement.
 */

import type { Vec2 } from '../core/math.js';
import {
  DETECTION_STATUS,
  detectionReasonCode,
  observeTarget,
  sensorPose,
  type DetectionObservation,
  type DetectionReason,
  type DetectionStatusCode,
  type GlareSource,
} from './model.js';
import type { MapDivergence, PerceptionConfig, SimSensor } from './schema.js';
import type {
  DetectionGap,
  MapDivergenceMetric,
  MapDivergenceTrack,
  PerceptionMetrics,
  SensorPerceptionMetric,
  SensorTargetTrack,
  SensorTrack,
} from '../trace/sensor-track.js';
import { sensorChannelKey } from '../trace/sensor-track.js';

/** Bounded evidence: an author needs the worst dropouts, not all of them. */
const MAX_RECORDED_GAPS = 16;

/**
 * The structural subset of `ActorRuntime` the perception pass reads. Declaring
 * it structurally keeps this module independent of the simulation's mutable
 * state type — it can be exercised from a test with a plain object literal.
 */
export interface PerceptionActorView {
  readonly id: string;
  readonly position: Vec2;
  readonly headingRad: number;
  /** Full silhouette height, metres. */
  readonly heightM: number;
  readonly present: boolean;
  readonly stateKeys: ReadonlyMap<string, boolean | number | string>;
  /** Current lane, for lane-scoped map divergences. */
  readonly laneRsl: string | null;
  readonly laneS: number;
}

/** An actor's declared sensor suite. */
export interface PerceptionObserverSpec {
  readonly actorId: string;
  readonly sensors: readonly SimSensor[];
}

/**
 * Geometric line of sight, supplied by the engine's occluder layer.
 *
 * The endpoint ids are part of the contract: the engine treats a static actor
 * as an occluder, so without them a parked car — or the very pedestrian being
 * looked for — would occlude the sight line to itself and no sensor could ever
 * report anything. Neither endpoint may occlude the segment between them.
 */
export type LineOfSightFn = (from: Vec2, to: Vec2, observerId: string, targetId: string) => boolean;

interface PairAccumulator {
  readonly observer: string;
  readonly sensorId: string;
  readonly target: string;
  readonly track: SensorTargetTrack;
  firstLineOfSightT: number | null;
  firstDetectionT: number | null;
  detectedTicks: number;
  degradedTicks: number;
  missedTicks: number;
  /** Debounce state: the status awaiting confirmation and how long it has held. */
  reportedStatus: DetectionStatusCode;
  pendingStatus: DetectionStatusCode;
  pendingTicks: number;
  /** Open gap, if any. */
  gapStartT: number | null;
  gapReasonTicks: Map<DetectionReason, number>;
  gaps: DetectionGap[];
  lastT: number;
}

interface DivergenceAccumulator {
  readonly divergence: MapDivergence;
  readonly observer: string;
  readonly track: MapDivergenceTrack;
  firstActiveT: number | null;
  activeTicks: number;
}

export class PerceptionRuntime {
  private readonly config: PerceptionConfig;
  private readonly dt: number;
  private readonly observers: PerceptionObserverSpec[];
  private readonly sensorById = new Map<string, { observer: string; sensor: SimSensor }>();
  private readonly tracks = new Map<string, SensorTrack>();
  private readonly pairs: PairAccumulator[] = [];
  private readonly pairIndex = new Map<string, PairAccumulator>();
  private readonly divergences: DivergenceAccumulator[] = [];
  /** Latest reported status, read back by the `detected` trigger condition. */
  private readonly current = new Map<string, DetectionStatusCode>();
  private tickCount = 0;

  constructor(
    config: PerceptionConfig,
    observers: readonly PerceptionObserverSpec[],
    targetIds: readonly string[],
    dt: number,
  ) {
    this.config = config;
    this.dt = dt;
    this.observers = [...observers]
      .map((o) => ({ actorId: o.actorId, sensors: [...o.sensors].sort((a, b) => cmp(a.id, b.id)) }))
      .sort((a, b) => cmp(a.actorId, b.actorId));

    const targets = [...targetIds].sort(cmp);
    for (const observer of this.observers) {
      for (const sensor of observer.sensors) {
        const key = sensorChannelKey(observer.actorId, sensor.id);
        this.sensorById.set(key, { observer: observer.actorId, sensor });
        const perTarget: Record<string, SensorTargetTrack> = {};
        for (const target of targets) {
          if (target === observer.actorId) continue;
          const track: SensorTargetTrack = {
            status: [],
            reason: [],
            confidence: [],
            rangeM: [],
            lineOfSight: [],
          };
          perTarget[target] = track;
          const acc: PairAccumulator = {
            observer: observer.actorId,
            sensorId: sensor.id,
            target,
            track,
            firstLineOfSightT: null,
            firstDetectionT: null,
            detectedTicks: 0,
            degradedTicks: 0,
            missedTicks: 0,
            reportedStatus: DETECTION_STATUS.absent,
            pendingStatus: DETECTION_STATUS.absent,
            pendingTicks: 0,
            gapStartT: null,
            gapReasonTicks: new Map(),
            gaps: [],
            lastT: 0,
          };
          this.pairs.push(acc);
          this.pairIndex.set(pairKey(observer.actorId, sensor.id, target), acc);
          this.current.set(pairKey(observer.actorId, sensor.id, target), DETECTION_STATUS.absent);
        }
        this.tracks.set(key, {
          observer: observer.actorId,
          sensorId: sensor.id,
          type: sensor.type,
          targets: perTarget,
        });
      }
    }

    for (const divergence of [...config.mapDivergences].sort((a, b) => cmp(a.id, b.id))) {
      // Empty `observers` means *every* actor, not merely the ones carrying a
      // sensor: a car with no camera still drives over the repainted lane, and
      // its exposure is the fact the author wants to require.
      const scoped = divergence.observers.length > 0
        ? [...divergence.observers].sort(cmp)
        : [...targetIds].sort(cmp);
      for (const observer of scoped) {
        this.divergences.push({
          divergence,
          observer,
          track: { id: divergence.id, kind: divergence.kind, observer, active: [] },
          firstActiveT: null,
          activeTicks: 0,
        });
      }
    }
  }

  /** `true` when any sensor is declared, i.e. when the pass has work to do. */
  get active(): boolean {
    return this.sensorById.size > 0 || this.divergences.length > 0;
  }

  /** Every declared sensor id, for validation and for author-facing errors. */
  get sensorKeys(): string[] {
    return [...this.sensorById.keys()].sort(cmp);
  }

  /**
   * Record one tick. `actors` is the frozen snapshot; `lineOfSight` is the
   * engine's occluder test, already scoped to this tick's occluder set.
   */
  observe(t: number, actors: readonly PerceptionActorView[], lineOfSight: LineOfSightFn): void {
    const byId = new Map<string, PerceptionActorView>();
    for (const actor of actors) byId.set(actor.id, actor);
    const glareEmitters = this.glareEmitters(actors);

    for (const acc of this.pairs) {
      const observer = byId.get(acc.observer);
      const target = byId.get(acc.target);
      const entry = this.sensorById.get(sensorChannelKey(acc.observer, acc.sensorId))!;
      const sensor = entry.sensor;

      let observation: DetectionObservation;
      if (!observer || !observer.present) {
        observation = {
          status: DETECTION_STATUS.absent,
          reason: 'absent',
          confidence: 0,
          rangeM: 0,
          bearingRad: 0,
          inAperture: false,
          observable: false,
        };
      } else {
        const pose = sensorPose(sensor, observer);
        const view = target
          ? { present: target.present, position: target.position, heightM: target.heightM }
          : { present: false, position: pose.position, heightM: 0 };
        const los = view.present
          ? lineOfSight(pose.position, view.position, acc.observer, acc.target)
          : false;
        observation = observeTarget({
          sensor,
          pose,
          target: view,
          lineOfSight: los,
          atmosphere: this.config.atmosphere,
          glareSources: this.glareSources(pose, glareEmitters),
        });
      }

      this.accumulate(acc, t, observation);
    }

    for (const acc of this.divergences) {
      const observer = byId.get(acc.observer);
      const active = observer !== undefined && observer.present && inExtent(acc.divergence, observer);
      acc.track.active.push(active ? 1 : 0);
      if (active) {
        acc.activeTicks += 1;
        if (acc.firstActiveT === null) acc.firstActiveT = t;
      }
    }

    this.tickCount += 1;
  }

  /**
   * The reported status of `target` for `observer`, optionally narrowed to one
   * sensor. Without `sensorId` the suite's best opinion wins, which is what a
   * fused stack does and what an author means by "the car has seen it".
   */
  statusOf(observer: string, target: string, sensorId?: string): DetectionStatusCode {
    if (sensorId !== undefined) {
      return this.current.get(pairKey(observer, sensorId, target)) ?? DETECTION_STATUS.absent;
    }
    let best: DetectionStatusCode = DETECTION_STATUS.absent;
    for (const acc of this.pairs) {
      if (acc.observer !== observer || acc.target !== target) continue;
      if (acc.reportedStatus > best) best = acc.reportedStatus;
    }
    return best;
  }

  /** `true` when the observer's suite currently reports the target. */
  detects(observer: string, target: string, sensorId?: string): boolean {
    return this.statusOf(observer, target, sensorId) >= DETECTION_STATUS.detected;
  }

  /** `true` when the pair is even monitored — an unknown sensor is an author bug. */
  hasSensor(observer: string, sensorId?: string): boolean {
    if (sensorId !== undefined) return this.sensorById.has(sensorChannelKey(observer, sensorId));
    return this.observers.some((o) => o.actorId === observer && o.sensors.length > 0);
  }

  /** The trace channel, keyed `observer/sensorId`. */
  sensorTracks(): Record<string, SensorTrack> {
    const out: Record<string, SensorTrack> = {};
    for (const key of [...this.tracks.keys()].sort(cmp)) out[key] = this.tracks.get(key)!;
    return out;
  }

  /** The map-divergence exposure channel, keyed `divergenceId/observer`. */
  divergenceTracks(): Record<string, MapDivergenceTrack> {
    const out: Record<string, MapDivergenceTrack> = {};
    for (const acc of this.divergences) out[`${acc.divergence.id}/${acc.observer}`] = acc.track;
    return out;
  }

  /** The episode summary written to `metrics.perception`. */
  metrics(): PerceptionMetrics {
    const clipEndT = this.tickCount === 0 ? 0 : this.pairs[0]?.lastT ?? 0;
    const sensors: SensorPerceptionMetric[] = this.pairs.map((acc) => {
      const gaps = [...acc.gaps];
      if (acc.gapStartT !== null) {
        gaps.push(this.closeGap(acc, clipEndT + this.dt, true));
      }
      const ranked = [...gaps].sort((a, b) => b.durationS - a.durationS).slice(0, MAX_RECORDED_GAPS);
      ranked.sort((a, b) => a.startS - b.startS);
      const longestGapS = gaps.reduce((max, gap) => Math.max(max, gap.durationS), 0);
      const totalGapS = gaps.reduce((sum, gap) => sum + gap.durationS, 0);
      return {
        observer: acc.observer,
        sensorId: acc.sensorId,
        target: acc.target,
        firstLineOfSightT: acc.firstLineOfSightT,
        firstDetectionT: acc.firstDetectionT,
        timeToFirstDetectionS: acc.firstDetectionT,
        perceptionLagS:
          acc.firstLineOfSightT === null
            ? null
            : acc.firstDetectionT === null
              ? null
              : acc.firstDetectionT - acc.firstLineOfSightT,
        detectedS: acc.detectedTicks * this.dt,
        degradedS: acc.degradedTicks * this.dt,
        missedS: acc.missedTicks * this.dt,
        longestGapS,
        totalGapS,
        gaps: ranked,
      };
    });

    const mapDivergence: MapDivergenceMetric[] = this.divergences.map((acc) => ({
      id: acc.divergence.id,
      kind: acc.divergence.kind,
      observer: acc.observer,
      severity: acc.divergence.severity,
      lateralErrorM: acc.divergence.lateralErrorM ?? null,
      firstActiveT: acc.firstActiveT,
      activeS: acc.activeTicks * this.dt,
    }));

    return { sensors, mapDivergence };
  }

  /* ------------------------------------------------------------- internals */

  private accumulate(acc: PairAccumulator, t: number, observation: DetectionObservation): void {
    acc.lastT = t;
    const sensor = this.sensorById.get(sensorChannelKey(acc.observer, acc.sensorId))!.sensor;

    // Debounce in whole ticks. Counting ticks rather than accumulating seconds
    // keeps the latch exact under replay.
    const latchTicks = Math.round(sensor.detection.latchS / this.dt);
    if (observation.status === acc.pendingStatus) {
      acc.pendingTicks += 1;
    } else {
      acc.pendingStatus = observation.status;
      acc.pendingTicks = 1;
    }
    if (acc.pendingTicks > latchTicks) acc.reportedStatus = acc.pendingStatus;
    const reported = acc.reportedStatus;
    this.current.set(pairKey(acc.observer, acc.sensorId, acc.target), reported);

    acc.track.status.push(reported);
    acc.track.reason.push(detectionReasonCode(reported >= DETECTION_STATUS.detected ? 'detected' : observation.reason));
    acc.track.confidence.push(observation.confidence);
    acc.track.rangeM.push(observation.rangeM);
    acc.track.lineOfSight.push(observation.observable ? 1 : 0);

    if (observation.observable && acc.firstLineOfSightT === null) acc.firstLineOfSightT = t;
    if (reported >= DETECTION_STATUS.detected) {
      acc.detectedTicks += 1;
      if (acc.firstDetectionT === null) acc.firstDetectionT = t;
    } else if (reported === DETECTION_STATUS.degraded) {
      acc.degradedTicks += 1;
    } else if (reported === DETECTION_STATUS.missed) {
      acc.missedTicks += 1;
    }

    // A gap is a run in which the target was geometrically available to this
    // sensor and the sensor still failed to report it. Occlusion counts: the
    // recorded reason is what lets an author require a *fog* gap specifically.
    const inGap = observation.inAperture && reported < DETECTION_STATUS.detected;
    if (inGap) {
      if (acc.gapStartT === null) {
        acc.gapStartT = t;
        acc.gapReasonTicks = new Map();
      }
      acc.gapReasonTicks.set(observation.reason, (acc.gapReasonTicks.get(observation.reason) ?? 0) + 1);
    } else if (acc.gapStartT !== null) {
      acc.gaps.push(this.closeGap(acc, t, false));
    }
  }

  private closeGap(acc: PairAccumulator, endT: number, openAtClipEnd: boolean): DetectionGap {
    const startS = acc.gapStartT ?? endT;
    let reason: DetectionReason = 'occluded';
    let best = -1;
    for (const [name, ticks] of [...acc.gapReasonTicks.entries()].sort((a, b) => cmp(a[0], b[0]))) {
      if (ticks > best) {
        best = ticks;
        reason = name;
      }
    }
    const gap: DetectionGap = {
      startS,
      endS: endT,
      durationS: Math.max(0, endT - startS),
      reason,
      openAtClipEnd,
    };
    acc.gapStartT = null;
    acc.gapReasonTicks = new Map();
    return gap;
  }

  /** Actors currently asserting one of the configured emissive state keys. */
  private glareEmitters(actors: readonly PerceptionActorView[]): PerceptionActorView[] {
    const keys = this.config.emissiveGlare.stateKeys;
    if (keys.length === 0) return [];
    return [...actors]
      .filter((actor) => actor.present && keys.some((key) => truthy(actor.stateKeys.get(key))))
      .sort((a, b) => cmp(a.id, b.id));
  }

  private glareSources(
    pose: { position: Vec2; boresightRad: number; heightM: number },
    emitters: readonly PerceptionActorView[],
  ): GlareSource[] {
    const sources: GlareSource[] = [];
    const sun = this.config.atmosphere.sun;
    if (sun && sun.elevationRad > 0) {
      sources.push({
        // Bearings are expressed off boresight, exactly like the target's.
        azimuthRad: wrapPi(sun.azimuthRad - pose.boresightRad),
        elevationRad: sun.elevationRad,
        halfAngleRad: sun.halfAngleRad,
        intensity: sun.intensity,
      });
    }
    const glare = this.config.emissiveGlare;
    for (const emitter of emitters) {
      const dx = emitter.position.x - pose.position.x;
      const dy = emitter.position.y - pose.position.y;
      const rangeM = Math.hypot(dx, dy);
      if (rangeM > glare.rangeM || rangeM < 1e-6) continue;
      sources.push({
        azimuthRad: wrapPi(Math.atan2(dy, dx) - pose.boresightRad),
        elevationRad: Math.atan2(glare.heightM - pose.heightM, rangeM),
        halfAngleRad: glare.halfAngleRad,
        // A beacon saturates less as it recedes; the falloff is linear in range
        // so that `rangeM` means exactly "no longer blinding beyond here".
        intensity: glare.intensity * (1 - rangeM / glare.rangeM),
      });
    }
    return sources;
  }
}

function pairKey(observer: string, sensorId: string, target: string): string {
  return `${observer}/${sensorId}/${target}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function truthy(value: boolean | number | string | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value !== '' && value !== 'false' && value !== 'off';
}

function wrapPi(angle: number): number {
  const wrapped = (angle + Math.PI) % (2 * Math.PI);
  return (wrapped < 0 ? wrapped + 2 * Math.PI : wrapped) - Math.PI;
}

/** Is the observer inside the divergent extent? */
export function inExtent(divergence: MapDivergence, observer: PerceptionActorView): boolean {
  const extent = divergence.extent;
  if (extent.kind === 'lane') {
    if (observer.laneRsl !== extent.rsl) return false;
    if (extent.sMin !== undefined && observer.laneS < extent.sMin) return false;
    if (extent.sMax !== undefined && observer.laneS > extent.sMax) return false;
    return true;
  }
  // Scene frame is `{x, z}` with `z = -y`; the engine plane is `(x, y)`.
  const dx = observer.position.x - extent.center.x;
  const dy = observer.position.y - -extent.center.z;
  return Math.hypot(dx, dy) <= extent.radiusM;
}
