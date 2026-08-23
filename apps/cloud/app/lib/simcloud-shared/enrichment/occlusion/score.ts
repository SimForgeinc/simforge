/**
 * Severity bucketing + supporting-feature aggregation for occlusion candidates.
 *
 * Confidence is a 0–1 score combining detector primitives + surrounding
 * context. The buckets here are deliberately wide so a small confidence
 * tweak doesn't bounce a candidate between severity tiers.
 */

import type { OcclusionSeverity } from "../../map-candidate-location";

export function severityFromConfidence(c: number): OcclusionSeverity {
  if (c >= 0.8) return "high";
  if (c >= 0.6) return "medium";
  return "low";
}

/** Clamp a score into the inclusive [0, 1] range. */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Round a confidence to two decimals so JSON round-trips stay stable. */
export function roundConfidence(c: number): number {
  return Math.round(clamp01(c) * 100) / 100;
}
