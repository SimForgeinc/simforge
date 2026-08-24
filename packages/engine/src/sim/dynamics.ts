/**
 * The uniform `dynamics = {shape, constraint, value}` descriptor, turned into a
 * scalar transition profile.
 *
 * A transition is fully described by its duration and a normalised shape:
 *
 * | shape | `f(p)` for `p ∈ [0,1]` |
 * |---|---|
 * | `step` | `p > 0 ? 1 : 0` |
 * | `linear` | `p` |
 * | `sinusoidal` | `(1 - cos(πp)) / 2` |
 * | `cubic` | `3p² − 2p³` (smoothstep: zero rate at both ends) |
 *
 * The duration comes from the constraint:
 *
 * - `rate` — `|Δ| / value` (m/s² for longitudinal, m/s for lateral).
 *   `sinusoidal` and `cubic` peak above their mean rate, so the duration is
 *   scaled by the shape's peak factor (π/2 and 3/2) to make `rate` mean *peak*
 *   rate. That is the reading R157 uses for lateral velocity, and it keeps
 *   `rate` an honest bound rather than an average.
 * - `time` — `value` directly.
 * - `distance` — `value / max(referenceSpeed, 0.1)` seconds of travel.
 */

import { clamp } from '../core/math.js';
import type { Dynamics } from '../schema/input.js';

export function shapeValue(shape: Dynamics['shape'], p: number): number {
  const q = clamp(p, 0, 1);
  switch (shape) {
    case 'step':
      return q > 0 ? 1 : 0;
    case 'linear':
      return q;
    case 'sinusoidal':
      return (1 - Math.cos(Math.PI * q)) / 2;
    case 'cubic':
      return q * q * (3 - 2 * q);
  }
}

/** Peak of `df/dp` over `[0,1]` — 1 for linear, π/2 sinusoidal, 3/2 cubic. */
export function shapePeakFactor(shape: Dynamics['shape']): number {
  switch (shape) {
    case 'step':
      return 1;
    case 'linear':
      return 1;
    case 'sinusoidal':
      return Math.PI / 2;
    case 'cubic':
      return 1.5;
  }
}

/** Minimum transition duration, seconds. Below this a transition is a step. */
export const MIN_TRANSITION_S = 1e-6;

/**
 * Duration of a transition of magnitude `delta` under `dyn`.
 *
 * @param delta Signed change (m/s for speed, m for lateral offset).
 * @param referenceSpeedMps Speed used to convert a `distance` constraint.
 */
export function transitionDuration(
  dyn: Dynamics,
  delta: number,
  referenceSpeedMps: number,
): number {
  const mag = Math.abs(delta);
  if (dyn.shape === 'step') return MIN_TRANSITION_S;
  switch (dyn.constraint) {
    case 'rate': {
      if (mag < 1e-9) return MIN_TRANSITION_S;
      return (mag / dyn.value) * shapePeakFactor(dyn.shape);
    }
    case 'time':
      return Math.max(dyn.value, MIN_TRANSITION_S);
    case 'distance':
      return Math.max(dyn.value / Math.max(referenceSpeedMps, 0.1), MIN_TRANSITION_S);
  }
}

/** Value of a transition from `from` to `to` at elapsed time `elapsed`. */
export function transitionValue(
  dyn: Dynamics,
  from: number,
  to: number,
  elapsed: number,
  durationS: number,
): number {
  const p = durationS <= MIN_TRANSITION_S ? 1 : clamp(elapsed / durationS, 0, 1);
  return from + (to - from) * shapeValue(dyn.shape, p);
}
