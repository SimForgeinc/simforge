/**
 * The per-sensor trace channel and the perception episode metrics.
 *
 * Columnar, like every other channel: one array per quantity, index-aligned
 * with `ticks.t`. Statuses and reasons are small integers with an exported
 * legend rather than strings, because a 30 s clip at 50 Hz is 1500 samples per
 * target and a run of identical integers is what gzip is good at.
 *
 * This is a *first-class* channel, not a derived report: a scenario can be
 * graded on it, and `metrics.perception` is what the tier-2 invariant checker
 * reads. Precision is fixed here so two runs of the same input hash serialise
 * bit-identically — a raw floating-point confidence product would not.
 */

import { quantize } from '../core/math.js';
import { DETECTION_REASONS, DETECTION_STATUS } from '../perception/model.js';
import type { MapDivergenceKind } from '../perception/schema.js';

/** Decimal places for the perception channels. */
export const SENSOR_TRACE_PRECISION = {
  confidence: 4,
  range: 3,
} as const;

/** `{ absent: 0, missed: 1, degraded: 2, detected: 3 }`. */
export const SENSOR_TRACE_STATUS_LEGEND = DETECTION_STATUS;
/** Reason names indexed by the integer stored in the `reason` channel. */
export const SENSOR_TRACE_REASON_LEGEND = DETECTION_REASONS;

/** One sensor's opinion about one other actor, over the whole clip. */
export interface SensorTargetTrack {
  /** `SENSOR_TRACE_STATUS_LEGEND` codes. */
  readonly status: number[];
  /** Index into `SENSOR_TRACE_REASON_LEGEND`. */
  readonly reason: number[];
  readonly confidence: number[];
  readonly rangeM: number[];
  /** 1 while geometric line of sight to the target is clear. */
  readonly lineOfSight: number[];
}

/** One declared sensor's whole channel. */
export interface SensorTrack {
  readonly observer: string;
  readonly sensorId: string;
  readonly type: string;
  /** Keyed by target actor id, in sorted order. */
  readonly targets: Record<string, SensorTargetTrack>;
}

/** Per-tick exposure of one observer to one declared map/percept divergence. */
export interface MapDivergenceTrack {
  readonly id: string;
  readonly kind: MapDivergenceKind;
  readonly observer: string;
  /** 1 while the observer is inside the divergent extent. */
  readonly active: number[];
}

/** A maximal run in which an observable target was not reported. */
export interface DetectionGap {
  readonly startS: number;
  readonly endS: number;
  readonly durationS: number;
  /** The reason that dominated the run. */
  readonly reason: string;
  /** `true` when the gap was still open at the end of the clip. */
  readonly openAtClipEnd: boolean;
}

/** Everything the perception layer concluded about one sensor/target pair. */
export interface SensorPerceptionMetric {
  readonly observer: string;
  readonly sensorId: string;
  readonly target: string;
  /** First tick at which the geometric line of sight was clear and in aperture. */
  readonly firstLineOfSightT: number | null;
  /** First tick at which the sensor reported the target. */
  readonly firstDetectionT: number | null;
  /** Clip time of first detection; `null` when it was never detected. */
  readonly timeToFirstDetectionS: number | null;
  /**
   * Seconds between the world making the target available and the sensor
   * admitting it exists. This is the number that says "the danger was the
   * perception failure, not the dynamics".
   */
  readonly perceptionLagS: number | null;
  readonly detectedS: number;
  readonly degradedS: number;
  readonly missedS: number;
  /** Longest dropout while the target was geometrically available. */
  readonly longestGapS: number;
  readonly totalGapS: number;
  /** Bounded evidence; the longest gaps first, then in time order. */
  readonly gaps: DetectionGap[];
}

export interface MapDivergenceMetric {
  readonly id: string;
  readonly kind: MapDivergenceKind;
  readonly observer: string;
  readonly severity: number;
  readonly lateralErrorM: number | null;
  readonly firstActiveT: number | null;
  readonly activeS: number;
}

/**
 * The perception episode summary.
 *
 * `mapDivergence` records *exposure* only. The engine has no lane-keeping
 * perception controller, so a declared divergence deliberately does NOT feed
 * back into control — pretending a faded line steers the car would be a
 * fiction. It is recorded so a scenario can require it; it is not a closed loop.
 */
export interface PerceptionMetrics {
  readonly sensors: SensorPerceptionMetric[];
  readonly mapDivergence: MapDivergenceMetric[];
}

/** Quantise the sensor channels, in sorted key order, before serialisation. */
export function quantizeSensorTracks(
  tracks: Readonly<Record<string, SensorTrack>>,
): Record<string, SensorTrack> {
  const out: Record<string, SensorTrack> = {};
  for (const key of Object.keys(tracks).sort()) {
    const track = tracks[key]!;
    const targets: Record<string, SensorTargetTrack> = {};
    for (const targetId of Object.keys(track.targets).sort()) {
      const t = track.targets[targetId]!;
      targets[targetId] = {
        status: [...t.status],
        reason: [...t.reason],
        confidence: t.confidence.map((v) => quantize(v, SENSOR_TRACE_PRECISION.confidence)),
        rangeM: t.rangeM.map((v) => quantize(v, SENSOR_TRACE_PRECISION.range)),
        lineOfSight: [...t.lineOfSight],
      };
    }
    out[key] = { observer: track.observer, sensorId: track.sensorId, type: track.type, targets };
  }
  return out;
}

/** Stable channel key. `observer/sensorId` is unique by construction. */
export function sensorChannelKey(observerId: string, sensorId: string): string {
  return `${observerId}/${sensorId}`;
}
