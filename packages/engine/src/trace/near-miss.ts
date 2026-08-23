import { obbSeparation } from '../core/math.js';
import type { SimTrace } from './trace.js';

export interface NearMissVerification {
  readonly status: 'verified' | 'failed';
  readonly pedestrianId: string;
  readonly targetId: string;
  readonly requestedClearanceM: number;
  readonly realizedClearanceM: number | null;
  readonly closestApproachTimeS: number | null;
  readonly collision: boolean;
  readonly reason: string;
}

/** Verify a near-miss goal from exact sampled actor footprints. Any collision fails. */
export function verifyNearMissOutcome(trace: SimTrace, options: {
  pedestrianId: string;
  targetId: string;
  requestedClearanceM: number;
  toleranceM?: number;
}): NearMissVerification {
  const { pedestrianId, targetId, requestedClearanceM } = options;
  const ped = trace.ticks.actors[pedestrianId];
  const target = trace.ticks.actors[targetId];
  const pedMeta = trace.header.actorMetadata?.[pedestrianId];
  const targetMeta = trace.header.actorMetadata?.[targetId];
  const collision = trace.metrics.collisions.some((c) => (c.a === pedestrianId && c.b === targetId) || (c.a === targetId && c.b === pedestrianId));
  if (!ped || !target || !pedMeta || !targetMeta) return { status: 'failed', pedestrianId, targetId, requestedClearanceM, realizedClearanceM: null, closestApproachTimeS: null, collision, reason: 'near-miss actors or footprint metadata are missing from the trace' };
  let minimum = Infinity;
  let minimumT: number | null = null;
  for (let i = 0; i < trace.ticks.t.length; i++) {
    if (!ped.present[i] || !target.present[i]) continue;
    const separation = obbSeparation(
      { center: { x: ped.x[i]!, y: ped.y[i]! }, lengthM: pedMeta.dims.l, widthM: pedMeta.dims.w, headingRad: ped.headingRad[i]! },
      { center: { x: target.x[i]!, y: target.y[i]! }, lengthM: targetMeta.dims.l, widthM: targetMeta.dims.w, headingRad: target.headingRad[i]! },
    );
    if (separation < minimum) { minimum = separation; minimumT = trace.ticks.t[i]!; }
  }
  const realized = Number.isFinite(minimum) ? minimum : null;
  const within = realized !== null && Math.abs(realized - requestedClearanceM) <= (options.toleranceM ?? 0.15);
  return {
    status: !collision && within && realized! > 0 ? 'verified' : 'failed', pedestrianId, targetId,
    requestedClearanceM, realizedClearanceM: realized, closestApproachTimeS: minimumT, collision,
    reason: collision ? 'collision occurred; a near miss must remain contact-free' : within ? 'realized footprint clearance matches the requested near miss' : 'realized footprint clearance is outside tolerance',
  };
}

