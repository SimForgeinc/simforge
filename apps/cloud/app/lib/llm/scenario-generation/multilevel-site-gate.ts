/**
 * M-6 — tunnel / multi-level placement gate (dib 2026-07-27 Munich review).
 *
 * Munich_Phase_1A carries stacked road structure: surface streets over tunnel
 * carriageways (and multi-level interchange decks). A conflict site authored on
 * the LOWER level is the "tunnel-under-surface" signature — the reviewed
 * ped-midblock-1 had the subject drive INTO a tunnel while the authored interaction
 * played out on the surface street above (the 2D planner is z-blind, so the
 * XY-projected site looked perfect). Such sites cannot be repaired by timing —
 * the gate discards them outright.
 *
 * Signature: the site's own road z sits more than `TUNNEL_SITE_BELOW_M` BELOW
 * the z of any OTHER road's centerline within `TUNNEL_SITE_XY_RADIUS_M` of the
 * conflict point in XY. Runtime road segments carry per-vertex centerline z
 * (the same values spawn z / world anchors read), so the check is pure segment
 * geometry. Maps whose bundle omits z (all zeros) can never trip the gate —
 * naturally inert on flat/legacy bundles.
 */
import type { Vec2 } from "@simcloud/shared";
import type { RuntimeRoadSegment } from "@/app/lib/llm/scenario-generation/runtime-road-snap";

/** The site rejects when another road within radius is more than this far ABOVE it. */
export const TUNNEL_SITE_BELOW_M = 2.0;
/** XY radius (m) scanned for higher road decks around the conflict point. */
export const TUNNEL_SITE_XY_RADIUS_M = 15;
/** Countable gate-rejection reason for batch reporting. */
export const TUNNEL_MULTILEVEL_GATE_REASON = "tunnel_multilevel_site";

/**
 * True when `conflictPoint` sits on a road segment whose z is more than
 * `belowM` BELOW another road's centerline within `radiusM` XY distance — the
 * tunnel-under-surface signature. The site's own road is the one whose
 * centerline vertex is XY-nearest the conflict point; all segments sharing that
 * road_id (its other lanes) are exempt from the comparison, every other road's
 * vertices participate. Pure + deterministic.
 */
export function isTunnelMultilevelSite(
  conflictPoint: Vec2,
  segments: ReadonlyArray<RuntimeRoadSegment>,
  opts?: { belowM?: number; radiusM?: number },
): boolean {
  const belowM = opts?.belowM ?? TUNNEL_SITE_BELOW_M;
  const radiusM = opts?.radiusM ?? TUNNEL_SITE_XY_RADIUS_M;
  const radius2 = radiusM * radiusM;

  // The site's own road: nearest centerline vertex to the conflict point.
  let siteRoadId: number | null = null;
  let siteZ = 0;
  let bestD2 = Infinity;
  for (const seg of segments) {
    for (const p of seg.centerline ?? []) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const d2 = (p.x - conflictPoint.x) ** 2 + (p.y - conflictPoint.y) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        siteRoadId = seg.road_id;
        siteZ = Number.isFinite(p.z) ? p.z : 0;
      }
    }
  }
  if (siteRoadId === null) return false; // no geometry → cannot classify

  // Any OTHER road's vertex within the XY radius sitting > belowM ABOVE the
  // site z → the site is the tunnel level under that road.
  for (const seg of segments) {
    if (seg.road_id === siteRoadId) continue;
    for (const p of seg.centerline ?? []) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
      const d2 = (p.x - conflictPoint.x) ** 2 + (p.y - conflictPoint.y) ** 2;
      if (d2 > radius2) continue;
      if (p.z - siteZ > belowM) return true;
    }
  }
  return false;
}
