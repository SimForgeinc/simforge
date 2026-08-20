/**
 * The trace format — the engine's only output.
 *
 * Columnar per actor: one array per channel, index-aligned with `ticks.t`. That
 * keeps gzipped traces small (long runs of near-identical floats compress well)
 * and makes the editor's scrubber a pair of array lookups.
 *
 * **Frame:** `header.frame` is always `'xodr-local'` — `x` east, `y` north,
 * headings CCW from `+x`. Consumers that draw in the y-up scene frame apply
 * `scene = (x, 0, -y)` (see `src/frames.ts`), or call `traceToSceneFrame`.
 *
 * Only `t ∈ [0, clipSeconds]` is recorded. The warm-up prologue is excluded by
 * construction; the state at `t = 0` *is* the prologue's final state.
 */

import { quantize } from '../core/math.js';
import type { SemanticLedger } from '@uniscenarios/scenario-model';
import { toSceneXZ } from '../frames.js';
import type { ActorKind, ControlIndication, Dims, MotionPhysicsMode, OperationalConditions, StaticProp } from '../schema/input.js';
import {
  quantizeSensorTracks,
  type MapDivergenceTrack,
  type PerceptionMetrics,
  type SensorTrack,
} from './sensor-track.js';

/** v4 adds the mandatory lane-relative lateral-offset actor channel. */
export const TRACE_FORMAT_VERSION = 4;
export const LATERAL_OFFSET_TRACE_VERSION = 4;
/**
 * Read compatibility is explicit and append-only. v1 is the pre-physics
 * Gallery/evidence envelope; v2 adds physics provenance; v3 adds collision
 * impulses; v4 adds lateral offsets. Unknown versions must fail closed.
 */
export const READABLE_TRACE_FORMAT_VERSIONS = [1, 2, 3, TRACE_FORMAT_VERSION] as const;

export function isReadableTraceFormatVersion(value: unknown): value is typeof READABLE_TRACE_FORMAT_VERSIONS[number] {
  return typeof value === 'number'
    && (READABLE_TRACE_FORMAT_VERSIONS as readonly number[]).includes(value);
}

/** Decimal places each channel is quantised to before serialisation. */
export const TRACE_PRECISION = {
  t: 6,
  position: 4,
  heading: 6,
  speed: 4,
  s: 4,
  event: 6,
  metric: 6,
} as const;

export interface ActorTrack {
  readonly x: number[];
  readonly y: number[];
  readonly headingRad: number[];
  readonly speedMps: number[];
  /** Lane-relative lateral state, retained for maneuver/OSC conformance. */
  readonly lateralOffsetM: number[];
  /** `-1` for authored rear-first motion, `1` for forward motion. */
  readonly motionDirection?: Array<-1 | 1>;
  readonly laneRsl: Array<string | null>;
  /** Route arc length, metres. */
  readonly s: number[];
  /** 1 while the actor exists in the world, 0 before spawn / after despawn. */
  readonly present: number[];
  /** Optional force-based backend telemetry; absent for kinematic-v1. */
  readonly physics?: ActorPhysicsTrack;
  /**
   * Clip time at which this body was knocked off its feet, absent while it
   * stayed on them.
   *
   * A scalar rather than a per-tick lane: the state is monotonic — nothing in a
   * planar engine stands a body back up — so consumers derive "down at t" as
   * `t >= downSinceS`, and a renderer gets fall progress from the same number
   * without the trace carrying a boolean for every tick.
   */
  readonly downSinceS?: number;
}

export interface ActorPhysicsTrack {
  readonly vxBodyMps: number[];
  readonly vyBodyMps: number[];
  readonly yawRateRadps: number[];
  readonly steerRad: number[];
  readonly wheelAngularSpeedRadps: number[];
  /** Peak axle/tire force as a fraction of the friction-circle limit. */
  readonly tireUtilization: number[];
  readonly frontNormalForceN: number[];
  readonly rearNormalForceN: number[];
  /** Sum of normal collision impulses applied during the preceding tick. */
  readonly collisionImpulseNs: number[];
  readonly collisionCount: number[];
}

/** Export/render-ready phase channel for one concrete signal program. */
export interface SignalTrack {
  readonly phase: ControlIndication[];
}

export type SimEvent =
  | { t: number; kind: 'trigger_fired'; interactionId: string; actorId: string; verb: string; forced: boolean }
  | { t: number; kind: 'trigger_skipped'; interactionId: string; actorId: string; reason: string }
  | {
      t: number;
      kind: 'preemption';
      actorId: string;
      axis: string;
      byInteractionId: string;
      preemptedInteractionId: string;
    }
  | { t: number; kind: 'released'; actorId: string; axis: string; interactionId: string; reason: 'until' | 'complete' | 'window' }
  | { t: number; kind: 'interaction_completed'; actorId: string; interactionId: string; finalLateralOffsetM?: number }
  | { t: number; kind: 'interaction_aborted'; actorId: string; interactionId: string; reason: 'collision' | 'preempted' | 'until' | 'rejected' | 'tracking_error' | 'clip_end' }
  | { t: number; kind: 'lateral_maneuver_planned'; actorId: string; interactionId: string; requestedDurationS: number; effectiveDurationS: number; displacementM: number }
  | { t: number; kind: 'lane_change'; actorId: string; fromRsl: string | null; toRsl: string | null; legal: boolean }
  | { t: number; kind: 'lane_change_rejected'; actorId: string; interactionId: string; reason: string }
  | { t: number; kind: 'route_change_rejected'; actorId: string; interactionId: string; reason: string; requestedTurn?: string }
  | { t: number; kind: 'collision'; a: string; b: string; colliderA?: string; colliderB?: string }
  | {
      t: number;
      kind: 'road_departure_prevented';
      actorId: string;
      laneRsl: string | null;
      lateralErrorM: number;
      allowedCenterOffsetM: number;
    }
  | { t: number; kind: 'crash_disabled'; actorId: string; otherId: string; reason: 'material-collision' }
  /**
   * A vulnerable body was taken off its feet. `normalImpulseNs` is the solver's
   * own contact impulse — telemetry, never a crash-load or injury claim.
   */
  | { t: number; kind: 'knocked_down'; actorId: string; otherId: string; normalImpulseNs: number }
  | { t: number; kind: 'spawn'; actorId: string }
  | { t: number; kind: 'despawn'; actorId: string; reason: 'route_end' | 'interaction' | 'clip_end' }
  | { t: number; kind: 'state_set'; actorId: string; key: string; value: boolean | number | string };

export interface PairMinDistance {
  readonly pair: [string, string];
  readonly minDistanceM: number;
  readonly t: number;
}

export interface MinTtcRecord {
  readonly value: number;
  readonly t: number;
  readonly pair: [string, string];
}

/** Route-aware TTC for a crossing whose conflict-zone occupancies overlap. */
export interface MinPathTtcRecord extends MinTtcRecord {
  readonly conflictPoint: { readonly x: number; readonly y: number };
}

/** Minimum predicted post-encroachment time at a future route intersection. */
export interface MinPetRecord {
  readonly value: number;
  /** Simulation sample at which this prediction was made. */
  readonly t: number;
  readonly pair: [string, string];
  readonly conflictPoint: { readonly x: number; readonly y: number };
  /** Predicted order through the conflict zone. */
  readonly firstActor: string;
  readonly secondActor: string;
}

/**
 * Finite pair-metric observations retained so consumers can select a truthful
 * minimum inside an authored time window. Episode-wide `min*` records remain
 * the canonical global summaries and are not replaced by this evidence.
 */
export interface CriticalitySamples {
  readonly ttc: Array<{
    readonly pair: [string, string];
    readonly t: number[];
    readonly value: number[];
  }>;
  readonly pathTTC: Array<{
    readonly pair: [string, string];
    readonly t: number[];
    readonly value: number[];
    readonly conflictX: number[];
    readonly conflictY: number[];
  }>;
  readonly pet: Array<{
    readonly pair: [string, string];
    readonly t: number[];
    readonly value: number[];
    readonly conflictX: number[];
    readonly conflictY: number[];
    readonly firstActor: string[];
    readonly secondActor: string[];
  }>;
}

export interface RevealToConflict {
  /** Directional authored relation; unlike `pair`, these fields preserve roles. */
  readonly observer: string;
  readonly target: string;
  /** Seconds between line of sight opening and the conflict moment. */
  readonly value: number;
  /** First time the declared occluder ref actually blocked this pair. */
  readonly firstBlockedT: number;
  readonly losOpenT: number;
  readonly conflictT: number;
  readonly pair: [string, string];
  /** Concrete id or author-level group id from the declared occlusion pair. */
  readonly occluderId?: string;
  /** Concrete occluder members that resolved from the declaration. */
  readonly relevantOccluderIds: string[];
}

export interface OccluderIneffective {
  /** Directional authored relation; unlike `pair`, these fields preserve roles. */
  readonly observer: string;
  readonly target: string;
  /** Pair whose criticality was measured while the declared occluders never blocked LOS. */
  readonly pair: [string, string];
  readonly conflictT: number;
  /** Present when the first block happened only after `conflictT`, so it was too late. */
  readonly firstBlockedT?: number;
  /** Specific declared occluder or group that was ineffective; absent means the declaration allowed any occluder. */
  readonly occluderId?: string;
  readonly relevantOccluderIds: string[];
  readonly reason: 'never_blocked_before_conflict';
}

export type DeclaredOcclusionStatus =
  | 'revealed_before_conflict'
  | 'blocked_at_conflict'
  | 'never_blocked_before_conflict'
  | 'occluder_unobserved'
  | 'pair_unobserved';

/** One result for every authored observer/target/occluder declaration. */
export interface DeclaredOcclusionMetric {
  readonly observer: string;
  readonly target: string;
  /** Stable, unordered pair used by the distance/TTC metric tables. */
  readonly pair: [string, string];
  readonly occluderId?: string;
  readonly relevantOccluderIds: string[];
  readonly status: DeclaredOcclusionStatus;
  readonly firstBlockedT: number | null;
  readonly losOpenT: number | null;
  /** Predicted physical conflict instant (`observation t + TTC`), not TTC sample time. */
  readonly conflictT: number | null;
  readonly revealToConflictS: number | null;
}

export interface InvariantResidual {
  readonly id: string;
  readonly kind: string;
  readonly target: number;
  readonly achieved: number;
  readonly residual: number;
}

export interface EpisodeMetrics {
  readonly minTTC: MinTtcRecord | null;
  /** Crossing-route TTC; null when no future occupancy overlap was observed. */
  readonly minPathTTC?: MinPathTtcRecord | null;
  /** Predicted PET at the nearest crossing-route conflict. */
  readonly minPET?: MinPetRecord | null;
  /** Window-selectable observations; absent on legacy traces. */
  readonly criticalitySamples?: CriticalitySamples;
  readonly minDistance: PairMinDistance[];
  readonly requiredDecelMax: Record<string, number>;
  readonly invariantResiduals?: InvariantResidual[];
  readonly revealToConflict?: RevealToConflict | null;
  /** Complete directional evidence, one entry per authored occlusion pair. */
  readonly declaredOcclusion?: DeclaredOcclusionMetric[];
  /** Declared occlusion pairs that were never hidden before their closest criticality sample. */
  readonly occluderIneffective?: OccluderIneffective[];
  readonly collisions: Array<{
    t: number;
    a: string;
    b: string;
    /** `body` or `door:<left|right|rear>` when articulated geometry caused contact. */
    colliderA?: string;
    colliderB?: string;
  }>;
  readonly triggerNeverFired: string[];
  /**
   * `true` when the criticality peak falls outside the proportional edge-safe
   * recorded window — the clipped-criticality reject filter.
   */
  readonly clippedCriticality: boolean;
  /** Wall-clock-free performance counter: integration steps executed. */
  readonly ticksSimulated: number;
  /**
   * Per-sensor detection summary and declared map/percept divergence exposure.
   * Absent when no actor declares a sensor and no divergence is declared.
   */
  readonly perception?: PerceptionMetrics;
}

export interface TraceHeader {
  readonly traceVersion: number;
  readonly engineVersion: string;
  /** `sha256(canonicalJson(parsedInput))`. */
  readonly inputHash: string;
  /** Origin of an adapted immutable trace. Absent on native sim-engine traces for hash stability. */
  readonly source?: 'sim-engine' | 'openscenario-replay';
  /** Exact XOSC bytes decoded into this trace, when `source` is `openscenario-replay`. */
  readonly sourceXoscSha256?: string;
  /** Exact canonical materialized-traffic bytes merged into browser/worker evidence. */
  readonly materializedTrafficDigest?: string;
  readonly seed: number | string;
  readonly mapId: string;
  /** Engine graph digest (currently source XODR sha256). */
  readonly engineGraphDigest: string;
  /** @deprecated use engineGraphDigest; kept for older trace consumers. */
  readonly topologyDigest: string;
  readonly dt: number;
  readonly clipSeconds: number;
  readonly warmupSeconds: number;
  readonly frame: 'xodr-local';
  readonly actorIds: string[];
  /**
   * Render-facing identity keyed by actor id. Optional so v1 traces written by
   * older engines remain readable; current engines always emit it.
   */
  readonly actorMetadata?: Record<string, TraceActorMetadata>;
  /**
   * Complete fixed-prop closure copied from the parsed input. Prop poses remain
   * in the input's scene frame; unlike actor tracks they do not need sampling.
   */
  readonly propMetadata?: Record<string, StaticProp>;
  /**
   * Ids of generated background road users, sorted. Absent when the scenario
   * has none.
   *
   * These actors are ordinary physical bodies in `ticks.actors` — they are
   * followed, yielded to, collidable and rendered — but they are excluded from
   * every episode criticality metric, because the authored conflict is the
   * lesson and a passing background car is not. Any external consumer that
   * recomputes closest approach, TTC or a "who did the ego nearly hit" pair
   * MUST subtract this set first, or it will silently describe the wrong pair.
   */
  readonly ambientActorIds?: string[];
  /** Optional catalog-cell provenance attached by batch/materialization layers. */
  readonly catalogSlot?: unknown;
  readonly metricSubject: string | null;
  /** Exact hash-covered ambient conditions executed by this trace. */
  readonly operationalConditions?: OperationalConditions;
  /**
   * Executed motion semantics. This distinguishes route choreography from a
   * force-based vehicle solver; consumers must not infer fidelity from tracks.
   */
  readonly physics: PhysicsTraceProvenance;
}

export interface PhysicsTraceProvenance {
  readonly mode: MotionPhysicsMode;
  readonly solver: 'uniscenarios-sim-engine';
  readonly solverVersion: string;
  /** Actual integration/substep interval used by the selected solver. */
  readonly substepS: number;
  /** sha256 of vehicleProfiles, or null when no profiles were supplied. */
  readonly vehicleProfileDigest: string | null;
  /** Digest of the complete class defaults plus per-actor overrides. */
  readonly resolvedProfileDigest?: string;
  /** Executed backend per actor; dynamic-v1 fallbacks are explicit and reasoned. */
  readonly actorBackends?: Record<string, ActorPhysicsBackendProvenance>;
  /** First material impact per moving actor. Absent means no crash occurred. */
  readonly crashes?: Record<string, { readonly t: number; readonly otherId: string; readonly reason: 'material-collision' }>;
}

export interface ActorPhysicsBackendProvenance {
  readonly mode: MotionPhysicsMode | 'fixed-static-v1';
  readonly reason: 'selected' | 'static-actor';
  /** Exact class-native dynamics profile used by the moving solver. */
  readonly profile: ActorKind | 'fixed-static';
}

export interface TraceActorMetadata {
  readonly kind: ActorKind;
  readonly dims: Dims;
  readonly static: boolean;
  readonly tags: readonly string[];
}

export interface SimTrace {
  readonly header: TraceHeader;
  readonly ticks: {
    readonly t: number[];
    readonly actors: Record<string, ActorTrack>;
    /** Present on traces produced by signal-aware engines; empty on unsignalized maps. */
    readonly signals?: Record<string, SignalTrack>;
    /**
     * Per-sensor perception channel, keyed `observerId/sensorId`. Present only
     * when an actor declares a sensor, so older traces stay byte-identical.
     */
    readonly sensors?: Record<string, SensorTrack>;
    /** Declared map/percept divergence exposure, keyed `divergenceId/observerId`. */
    readonly mapDivergence?: Record<string, MapDivergenceTrack>;
  };
  readonly events: SimEvent[];
  readonly metrics: EpisodeMetrics;
  /**
   * Runtime-neutral behavioral evidence for browser/OpenSCENARIO/CARLA parity.
   * Optional only for read compatibility with traces written before ledger v1;
   * every trace produced by the current engine includes it.
   */
  readonly semanticLedger?: SemanticLedger;
}

function quantizeMetricValue(value: unknown): unknown {
  if (typeof value === 'number') return quantize(value, TRACE_PRECISION.metric);
  if (Array.isArray(value)) return value.map(quantizeMetricValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, quantizeMetricValue(entry)]),
    );
  }
  return value;
}

/** Quantise derived floats so trace digests do not encode insignificant ULPs. */
export function quantizeMetrics(metrics: EpisodeMetrics): EpisodeMetrics {
  return quantizeMetricValue(metrics) as EpisodeMetrics;
}

/** Quantise every channel — the last step before a trace is compared or hashed. */
export function quantizeTrace(trace: SimTrace): SimTrace {
  const actors: Record<string, ActorTrack> = {};
  for (const id of Object.keys(trace.ticks.actors).sort()) {
    const tr = trace.ticks.actors[id]!;
    actors[id] = {
      x: tr.x.map((v) => quantize(v, TRACE_PRECISION.position)),
      y: tr.y.map((v) => quantize(v, TRACE_PRECISION.position)),
      headingRad: tr.headingRad.map((v) => quantize(v, TRACE_PRECISION.heading)),
      speedMps: tr.speedMps.map((v) => quantize(v, TRACE_PRECISION.speed)),
      lateralOffsetM: lateralOffsetChannel(trace.header.traceVersion, id, tr, trace.ticks.t.length)
        .map((v) => quantize(v, TRACE_PRECISION.position)),
      ...(tr.motionDirection ? { motionDirection: [...tr.motionDirection] } : {}),
      laneRsl: [...tr.laneRsl],
      s: tr.s.map((v) => quantize(v, TRACE_PRECISION.s)),
      present: [...tr.present],
      ...(tr.physics ? {
        physics: Object.fromEntries(
          Object.entries(tr.physics).map(([key, values]: [string, number[]]) => [key, values.map((v: number) => quantize(v, TRACE_PRECISION.speed))]),
        ) as unknown as ActorPhysicsTrack,
      } : {}),
    };
  }
  return {
    ...trace,
    ticks: {
      t: trace.ticks.t.map((v) => quantize(v, TRACE_PRECISION.t)),
      actors,
      ...(trace.ticks.signals
        ? {
            signals: Object.fromEntries(
              Object.keys(trace.ticks.signals)
                .sort()
                .map((id) => [id, { phase: [...trace.ticks.signals![id]!.phase] }]),
            ),
          }
        : {}),
      // A raw floating-point confidence product is exactly the kind of thing
      // that breaks a bit-identical replay comparison, so it is quantised here
      // with the rest of the channels rather than at the producer.
      ...(trace.ticks.sensors ? { sensors: quantizeSensorTracks(trace.ticks.sensors) } : {}),
      ...(trace.ticks.mapDivergence
        ? {
            mapDivergence: Object.fromEntries(
              Object.keys(trace.ticks.mapDivergence)
                .sort()
                .map((id) => [id, { ...trace.ticks.mapDivergence![id]!, active: [...trace.ticks.mapDivergence![id]!.active] }]),
            ),
          }
        : {}),
    },
    events: trace.events.map((event) => ({ ...event, t: quantize(event.t, TRACE_PRECISION.event) })),
    metrics: quantizeMetrics(trace.metrics),
    ...(trace.semanticLedger
      ? { semanticLedger: quantizeMetricValue(trace.semanticLedger) as SemanticLedger }
      : {}),
  };
}

/** A trace whose tick channels are in the y-up scene frame. */
export interface SceneTrace {
  readonly header: Omit<TraceHeader, 'frame'> & { readonly frame: 'scene' };
  readonly ticks: {
    readonly t: number[];
    readonly actors: Record<string, Omit<ActorTrack, 'y'> & { z: number[] }>;
    readonly signals?: Record<string, SignalTrack>;
    /** Frame-independent: bearings are sensor-relative, ranges are scalars. */
    readonly sensors?: Record<string, SensorTrack>;
    readonly mapDivergence?: Record<string, MapDivergenceTrack>;
  };
  readonly events: SimEvent[];
  readonly metrics: EpisodeMetrics;
  /** Canonical ledger remains in its declared frame (`xodr-local`). */
  readonly semanticLedger?: SemanticLedger;
}

/** A copy with `ticks` rewritten into the y-up scene frame (`x`, `z`). */
export function traceToSceneFrame(trace: SimTrace): SceneTrace {
  const actors: Record<string, Omit<ActorTrack, 'y'> & { z: number[] }> = {};
  for (const id of Object.keys(trace.ticks.actors).sort()) {
    const tr = trace.ticks.actors[id]!;
    const x: number[] = [];
    const z: number[] = [];
    for (let i = 0; i < tr.x.length; i++) {
      const p = toSceneXZ({ x: tr.x[i]!, y: tr.y[i]! });
      x.push(p.x);
      z.push(p.z);
    }
    actors[id] = {
      x,
      z,
      headingRad: [...tr.headingRad],
      speedMps: [...tr.speedMps],
      lateralOffsetM: lateralOffsetChannel(trace.header.traceVersion, id, tr, trace.ticks.t.length),
      ...(tr.motionDirection ? { motionDirection: [...tr.motionDirection] } : {}),
      laneRsl: [...tr.laneRsl],
      s: [...tr.s],
      present: [...tr.present],
      ...(tr.physics ? {
        physics: Object.fromEntries(
          Object.entries(tr.physics).map(([key, values]: [string, number[]]) => [key, [...values]]),
        ) as unknown as ActorPhysicsTrack,
      } : {}),
    };
  }
  return {
    header: { ...trace.header, frame: 'scene' },
    ticks: {
      t: [...trace.ticks.t],
      actors,
      ...(trace.ticks.signals
        ? {
            signals: Object.fromEntries(
              Object.keys(trace.ticks.signals)
                .sort()
                .map((id) => [id, { phase: [...trace.ticks.signals![id]!.phase] }]),
            ),
          }
        : {}),
      ...(trace.ticks.sensors ? { sensors: trace.ticks.sensors } : {}),
      ...(trace.ticks.mapDivergence ? { mapDivergence: trace.ticks.mapDivergence } : {}),
    },
    events: trace.events,
    metrics: trace.metrics,
    ...(trace.semanticLedger ? { semanticLedger: trace.semanticLedger } : {}),
  };
}

/**
 * Resolve the lateral channel at the serialized trace boundary. Versions 1–3
 * predate the channel and deterministically mean lane-centred when it is
 * absent. A present channel is always validated; v4+ requires it.
 */
function lateralOffsetChannel(
  traceVersion: number,
  actorId: string,
  track: ActorTrack,
  tickCount: number,
): number[] {
  if (!isReadableTraceFormatVersion(traceVersion)) {
    throw new TypeError(`header.traceVersion ${traceVersion} is not readable`);
  }
  const value = (track as unknown as Record<string, unknown>)['lateralOffsetM'];
  if (value === undefined && traceVersion < LATERAL_OFFSET_TRACE_VERSION) {
    return Array.from({ length: tickCount }, () => 0);
  }
  if (!Array.isArray(value) || value.length !== tickCount) {
    throw new TypeError(
      `ticks.actors.${actorId}.lateralOffsetM length ${Array.isArray(value) ? value.length : 'missing'} does not match ticks.t length ${tickCount}`,
    );
  }
  if (value.some((entry) => !Number.isFinite(entry))) {
    throw new TypeError(`ticks.actors.${actorId}.lateralOffsetM contains a non-finite value`);
  }
  return [...value] as number[];
}
