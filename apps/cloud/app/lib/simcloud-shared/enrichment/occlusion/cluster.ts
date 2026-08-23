/**
 * Per-subtype dedupe so a long curved road doesn't emit 30 overlapping
 * curve-occlusion candidates.
 *
 * Greedy: walk candidates in descending confidence, keep one, suppress any
 * later candidate of the same subtype within `radiusMeters` of an already-
 * kept centroid. Stable across runs because confidence ties are broken by
 * input order (which detectors emit deterministically).
 */

import type { CandidateLocation } from "../../map-candidate-location";
import { distanceMeters } from "./geo";

function readSubtype(c: CandidateLocation): string {
  for (const ev of c.evidence) {
    const v = ev.primitives.occlusion_subtype;
    if (typeof v === "string") return v;
  }
  return "";
}

export function dedupeBySubtype(
  candidates: CandidateLocation[],
  radiusMeters: number,
): CandidateLocation[] {
  const sorted = [...candidates].sort(
    (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0),
  );
  const kept: CandidateLocation[] = [];
  const keptByType = new Map<string, CandidateLocation[]>();

  for (const c of sorted) {
    const subtype = readSubtype(c);
    const peers = keptByType.get(subtype) ?? [];
    let suppressed = false;
    for (const p of peers) {
      if (distanceMeters(c.center, p.center) < radiusMeters) {
        suppressed = true;
        break;
      }
    }
    if (suppressed) continue;
    peers.push(c);
    keptByType.set(subtype, peers);
    kept.push(c);
  }
  return kept;
}
