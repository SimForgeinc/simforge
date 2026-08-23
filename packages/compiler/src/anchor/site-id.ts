/**
 * Deterministic site identity.
 *
 * ```
 * siteId = sha256(anchorId + matchSemanticsVersion + mapId + topologyDigest +
 *                 originFeatureId + entryLaneRsl + quantize(s, 0.5m))[0..16]
 * ```
 *
 * The tuple is deliberately **narrow**: it excludes soft clauses and weights so
 * that tuning preferences never orphans a stored `SiteBinding`
 * (`docs/research/retargeting.md` § Determinism rules). It includes
 * `topologyDigest`, so a map rebuild forces a visible re-match instead of a
 * silent re-bind.
 */

import { sha256Hex } from './sha256.js';
import { MATCH_SEMANTICS_VERSION } from './version.js';

/** Quantization of the origin arc length, in metres. */
export const S_QUANTUM_M = 0.5;

export function quantizeS(s: number, quantum = S_QUANTUM_M): string {
  const q = Math.round(s / quantum) * quantum;
  // Avoid `-0` producing a different string than `0`.
  return (Object.is(q, -0) ? 0 : q).toFixed(1);
}

export interface SiteIdInput {
  anchorId: string;
  mapId: string;
  topologyDigest: string;
  /** Concrete map feature that establishes the frame origin, e.g. `junction:115`. */
  originFeatureId: string;
  entryLaneRsl: string;
  /** Arc length of the origin along the entry lane. */
  originS: number;
}

export function computeSiteId(input: SiteIdInput): string {
  const tuple = [
    input.anchorId,
    MATCH_SEMANTICS_VERSION,
    input.mapId,
    input.topologyDigest,
    input.originFeatureId,
    input.entryLaneRsl,
    quantizeS(input.originS),
  ].join('|');
  return sha256Hex(tuple).slice(0, 16);
}
