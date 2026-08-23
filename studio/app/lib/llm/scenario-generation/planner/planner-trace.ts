import type { PedSiteSelectionTrace } from "./pedestrian-crossing-site-selector";
import type { PedTopoResult } from "./pedestrian-crossing-topology-planner";

export interface PlannerTrace {
  family: "pedestrian_crossing";
  site: PedSiteSelectionTrace;
  subject: { lanes: string[]; speedKph: number; backWalkM: number; etaToConflictS: number };
  walker: { conflict: { x: number; y: number }; holdS: number; tToConflictS: number; speedMps: number };
  verdict: { result: "pass" | "fail"; contactS: number | null; window: [number, number] };
  /** Topological-reachability re-pick bookkeeping: how many ranked sites were
   *  probed (each probed exactly once) before one passed kinematic validation,
   *  and how many of those probes passed. The accepted site is the one whose
   *  trace this is. Absent on the heuristic / single-site (gated-wrapper) path. */
  repick?: { sitesTried: number; sitesPassed: number };
}

export function logPlannerTrace(t: PlannerTrace): void {
  console.log(`[ped-planner] trace ${JSON.stringify(t)}`);
}

/**
 * Compose a `PlannerTrace` from the deterministic planner's own trace plus the
 * validator's verdict on the assembled draft. Pure — no I/O — so the
 * trace-assembly contract can be unit-tested without the DB/S3-bound builder.
 *
 * `verdict.result` is the authoritative draft verdict; `verdict.contactS` is
 * the kinematic-sim contact time when a collision occurred (else null);
 * `window` is the family's absolute accept window `[min, max]`.
 *
 * `repick` (optional) carries the topological-reachability re-pick bookkeeping
 * — how many ranked sites were probed before one validated, and how many
 * passed — so the debug log shows the gate the accepted site survived.
 */
export function buildPedPlannerTrace(
  pedTopo: PedTopoResult,
  verdict: { result: "pass" | "fail"; contactS: number | null },
  window: { min: number; max: number },
  repick?: { sitesTried: number; sitesPassed: number },
): PlannerTrace {
  return {
    family: "pedestrian_crossing",
    site: pedTopo.trace.site,
    subject: { ...pedTopo.trace.subject },
    walker: { ...pedTopo.trace.walker },
    verdict: {
      result: verdict.result,
      contactS: verdict.contactS,
      window: [window.min, window.max],
    },
    ...(repick ? { repick } : {}),
  };
}
