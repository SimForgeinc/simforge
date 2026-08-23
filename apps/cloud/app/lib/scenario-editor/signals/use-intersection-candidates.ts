"use client";

import { useMemo } from "react";
import {
  buildIntersectionCandidates,
  junctionApproachSignature,
  type IntersectionCandidate,
} from "@/app/lib/scenario-editor/signals/intersection-candidates";
import { useActorsStore } from "@/app/lib/scenario-editor/stores";
import { useSignalJunctionStore } from "./signal-junction-store";

/**
 * The editor's intersection-control candidates, memoized off the three stores
 * that feed them.
 *
 * The seam every armed-mode surface shares: the toolbar's enabled state, the 2D
 * candidate layer, the 3D ghost heads and the hover card all read the SAME list,
 * so they cannot disagree about which junctions exist or what they are called.
 *
 * Lights come from the map's traffic-light index, loaded into the same store as
 * the junctions by the same hook — see `useSignalJunctionIndex` for why they are
 * no longer read off `bundle.runtime.traffic_lights`.
 */
export function useIntersectionCandidates(): IntersectionCandidate[] {
  const index = useSignalJunctionStore((state) => state.index);
  const runtimeLights = useSignalJunctionStore((state) => state.trafficLights);
  const signalPlans = useActorsStore((state) => state.signalPlans);

  return useMemo(
    () =>
      buildIntersectionCandidates({
        index,
        runtimeLights,
        plans: signalPlans,
      }),
    [index, runtimeLights, signalPlans],
  );
}

/**
 * Every junction's identity string, keyed by junction id.
 *
 * Covers the WHOLE index rather than just the candidates, because the SCENE
 * lane and the junction list name junctions that carry no lights at all. One
 * name in four places is the fix, and a surface that fell back to the raw
 * integer for half its rows would only half-fix it.
 */
export function useJunctionIdentityLabels(): ReadonlyMap<string, string> {
  const index = useSignalJunctionStore((state) => state.index);
  return useMemo(
    () =>
      new Map(
        (index?.junctions ?? []).map((junction) => [
          junction.junction_id,
          junctionApproachSignature(junction).identity,
        ]),
      ),
    [index],
  );
}
