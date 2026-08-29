/**
 * Largest path-to-path separation still treated as an inferred encounter.
 * This is an authoring diagnostic tolerance, not evidence of simulated contact.
 */
export const COLLISION_INFERENCE_MAX_CLOSEST_APPROACH_M = 8;

export function isCollisionInferenceCandidate(
  closestApproachM: number,
  thresholdM: number = COLLISION_INFERENCE_MAX_CLOSEST_APPROACH_M,
): boolean {
  return Number.isFinite(closestApproachM)
    && closestApproachM >= 0
    && closestApproachM <= thresholdM;
}
