import type {
  MapTopologyIndex,
  RuntimeBoundMapTopologyIndex,
  RuntimeTopologyParity,
  RuntimeTopologyParityDiagnostic,
  RuntimeTopologyProvenance,
  RuntimeTopologySegment,
} from "./types";

const AUTHORABLE_LANE_TYPES = new Set(["driving", "bidirectional"]);

function normalizedLaneType(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function runtimeRsl(segment: RuntimeTopologySegment): string {
  return `${segment.road_id}:${segment.section_id}:${segment.lane_id}`;
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

/**
 * Return every lane whose exact runtime identity is required to execute a
 * gate. A CARLA junction movement can span more than the gate's first
 * connecting lane, so include the complete directed internal chain that lies
 * on a path from that connector to one of the declared exits.
 */
function gateRuntimeRsls(
  topology: MapTopologyIndex,
  gate: MapTopologyIndex["gates"][number],
): Set<string> {
  const exitRsls = new Set(gate.exitLaneRsls);
  const forward = new Set<string>();
  const queue = [gate.connectingLaneRsl];
  while (queue.length > 0) {
    const rsl = queue.shift()!;
    if (forward.has(rsl)) continue;
    forward.add(rsl);
    if (exitRsls.has(rsl)) continue;
    const lane = topology.lanes[rsl];
    if (!lane) continue;
    for (const successor of lane.successors) {
      const successorLane = topology.lanes[successor];
      if (exitRsls.has(successor) || successorLane?.isJunction) queue.push(successor);
    }
  }

  const backward = new Set<string>();
  const reverseQueue = [...exitRsls];
  while (reverseQueue.length > 0) {
    const rsl = reverseQueue.shift()!;
    if (backward.has(rsl)) continue;
    backward.add(rsl);
    if (rsl === gate.connectingLaneRsl) continue;
    const lane = topology.lanes[rsl];
    if (!lane) continue;
    for (const predecessor of lane.predecessors) {
      const predecessorLane = topology.lanes[predecessor];
      if (predecessor === gate.connectingLaneRsl || predecessorLane?.isJunction) {
        reverseQueue.push(predecessor);
      }
    }
  }

  return new Set([
    gate.approachLaneRsl,
    gate.connectingLaneRsl,
    ...gate.exitLaneRsls,
    ...[...forward].filter((rsl) => backward.has(rsl)),
  ]);
}

export function buildRuntimeTopologyParity(input: {
  topology: MapTopologyIndex;
  runtimeSegments: readonly RuntimeTopologySegment[];
}): RuntimeTopologyParity {
  const diagnostics: RuntimeTopologyParityDiagnostic[] = [];
  const topologyAuthorable = new Map(
    Object.values(input.topology.lanes)
      .filter((lane) => AUTHORABLE_LANE_TYPES.has(normalizedLaneType(lane.laneType)))
      .map((lane) => [lane.rsl, lane] as const),
  );
  const gateRequiredRslsById = new Map(
    input.topology.gates.map((gate) => [gate.id, gateRuntimeRsls(input.topology, gate)]),
  );
  const gateRequiredRsls = new Set(
    [...gateRequiredRslsById.values()].flatMap((rsls) => [...rsls]),
  );
  const topologyRuntimeRelevantRsls = new Set([
    ...topologyAuthorable.keys(),
    ...gateRequiredRsls,
  ]);
  const runtimeByRsl = new Map<string, RuntimeTopologySegment>();
  const duplicateRuntimeRsls = new Set<string>();

  for (const segment of input.runtimeSegments) {
    const rsl = runtimeRsl(segment);
    const existing = runtimeByRsl.get(rsl);
    if (existing) {
      if (topologyRuntimeRelevantRsls.has(rsl)) {
        duplicateRuntimeRsls.add(rsl);
      }
    } else runtimeByRsl.set(rsl, segment);
  }

  for (const rsl of sorted(duplicateRuntimeRsls)) {
    diagnostics.push({
      code: "DUPLICATE_RUNTIME_RSL",
      rsl,
      gateId: null,
      message: `Runtime waypoint crawl contains duplicate lane binding ${rsl}.`,
    });
  }

  const runtimeAuthorable = new Map(
    [...runtimeByRsl.entries()].filter(([, segment]) =>
      AUTHORABLE_LANE_TYPES.has(normalizedLaneType(segment.lane_type)),
    ),
  );

  // Every lane CARLA's own crawled segments name as reachable. The crawl samples
  // at a fixed step, so a lane-section shorter than that step gets no waypoints
  // and never appears in the segment list — while the segments either side of it
  // still link straight through it. Those links are the runtime's own assertion
  // that the lane is real and driveable, and they are the only evidence of it the
  // bundle carries.
  const runtimeLinkedRsls = new Set<string>();
  for (const segment of input.runtimeSegments) {
    for (const link of [...(segment.successors ?? []), ...(segment.predecessors ?? [])]) {
      const rsl = link?.rsl;
      if (rsl) runtimeLinkedRsls.add(rsl);
    }
  }

  // ...and every lane CARLA steps OVER without naming.
  //
  // Naming is not the only way the crawl attests a lane. Where a section is
  // shorter than the sampling step, CARLA does not merely skip its waypoints —
  // it skips the lane in its links too, and connects the segments on either side
  // directly. Di Rosa's ego is exactly this: the OpenDRIVE runs
  // `838:0:-1 -> 21:0:-2 -> 21:1:-3` and CARLA reports `838:0:-1 -> 21:1:-3`,
  // eliding a 1.6 m stub. Binding only NAMED lanes leaves that stub unbound, the
  // gate through it dropped, and the car stopped in the intersection.
  //
  // So a CARLA link A->C where the OpenDRIVE has no direct A->C, but does have a
  // short chain A->...->C whose intermediates the crawl never sampled, is read as
  // "those intermediates exist and CARLA drove straight through them".
  //
  // Deliberately narrow. The bridge must be SHORT, every intermediate must be
  // absent from the crawl (a present one means the elision theory is wrong), and
  // the shortest path must be UNIQUE at its length — an ambiguous bridge is a
  // guess about which way a car went, and this routine does not guess.
  const MAX_BRIDGE_HOPS = 3;
  const bridgedRsls = new Set<string>();
  const bridgeBetween = (from: string, to: string): string[] | null => {
    const fromLane = input.topology.lanes[from];
    if (!fromLane || fromLane.successors.includes(to)) return null;
    let frontier: Array<{ rsl: string; via: string[] }> = [{ rsl: from, via: [] }];
    for (let depth = 0; depth < MAX_BRIDGE_HOPS; depth += 1) {
      const next: Array<{ rsl: string; via: string[] }> = [];
      const arrivals: string[][] = [];
      for (const node of frontier) {
        for (const successor of input.topology.lanes[node.rsl]?.successors ?? []) {
          if (successor === to) {
            arrivals.push(node.via);
            continue;
          }
          // Only unsampled lanes may be bridged THROUGH. A sampled intermediate
          // would have shown up in the crawl's own link chain.
          if (runtimeByRsl.has(successor)) continue;
          if (!input.topology.lanes[successor]) continue;
          if (node.via.includes(successor)) continue;
          next.push({ rsl: successor, via: [...node.via, successor] });
        }
      }
      if (arrivals.length === 1) return arrivals[0]!;
      if (arrivals.length > 1) return null;
      frontier = next;
    }
    return null;
  };
  for (const segment of input.runtimeSegments) {
    const from = runtimeRsl(segment);
    for (const link of segment.successors ?? []) {
      const to = link?.rsl;
      if (!to || runtimeByRsl.has(to) === false) continue;
      const bridge = bridgeBetween(from, to);
      if (bridge) for (const rsl of bridge) bridgedRsls.add(rsl);
    }
  }

  const boundLaneRsls = new Set<string>();
  const linkAttestedLaneRsls = new Set<string>();
  const topologyOnlyLaneRsls = new Set<string>();
  const runtimeOnlyLaneRsls = new Set<string>();
  const laneTypeMismatchRsls = new Set<string>();
  const junctionFlagMismatchRsls = new Set<string>();

  for (const rsl of sorted(topologyRuntimeRelevantRsls)) {
    const lane = input.topology.lanes[rsl];
    if (!lane) continue;
    const runtimeLane = runtimeByRsl.get(rsl);
    if (!runtimeLane) {
      // Not sampled — but if a sampled lane links to it and the OpenDRIVE has
      // real geometry for it, the runtime has already told us it is there. Bind
      // it on that evidence rather than severing the junction behind it.
      //
      // The two conditions are both load-bearing. Without the link check this
      // would bind lanes CARLA excluded on purpose; without the geometry check it
      // would bind a lane nothing downstream can draw, and the compiler would
      // then reject the movement anyway, one stage later and less legibly.
      if ((runtimeLinkedRsls.has(rsl) || bridgedRsls.has(rsl)) && lane.polyline.length >= 2) {
        boundLaneRsls.add(rsl);
        linkAttestedLaneRsls.add(rsl);
        diagnostics.push({
          code: "TOPOLOGY_LANE_LINK_ATTESTED",
          rsl,
          gateId: null,
          message:
            `OpenDRIVE lane ${rsl} was not sampled by the runtime crawl but is named by its links; `
            + "bound with OpenDRIVE geometry.",
        });
        continue;
      }
      if (topologyAuthorable.has(rsl)) topologyOnlyLaneRsls.add(rsl);
      diagnostics.push({
        code: "TOPOLOGY_LANE_MISSING_AT_RUNTIME",
        rsl,
        gateId: null,
        message: `OpenDRIVE lane ${rsl} is not present in the runtime waypoint crawl.`,
      });
      continue;
    }
    if (normalizedLaneType(lane.laneType) !== normalizedLaneType(runtimeLane.lane_type)) {
      laneTypeMismatchRsls.add(rsl);
      diagnostics.push({
        code: "LANE_TYPE_MISMATCH",
        rsl,
        gateId: null,
        message: `Lane ${rsl} has different OpenDRIVE and runtime lane types.`,
      });
      continue;
    }
    if (lane.isJunction !== runtimeLane.is_junction) {
      junctionFlagMismatchRsls.add(rsl);
      diagnostics.push({
        code: "JUNCTION_FLAG_MISMATCH",
        rsl,
        gateId: null,
        message: `Lane ${rsl} has different OpenDRIVE and runtime junction membership.`,
      });
      continue;
    }
    boundLaneRsls.add(rsl);
  }

  for (const rsl of sorted(runtimeAuthorable.keys())) {
    if (topologyAuthorable.has(rsl)) continue;
    runtimeOnlyLaneRsls.add(rsl);
    diagnostics.push({
      code: "RUNTIME_LANE_MISSING_IN_TOPOLOGY",
      rsl,
      gateId: null,
      message: `Runtime lane ${rsl} is not present in the OpenDRIVE topology index.`,
    });
  }

  const boundGateIds: string[] = [];
  const unboundGateIds: string[] = [];
  for (const gate of [...input.topology.gates].sort((left, right) => left.id.localeCompare(right.id))) {
    const requiredRsls = [...(gateRequiredRslsById.get(gate.id) ?? [])];
    if (requiredRsls.every((rsl) => boundLaneRsls.has(rsl))) {
      boundGateIds.push(gate.id);
      continue;
    }
    unboundGateIds.push(gate.id);
    diagnostics.push({
      code: "GATE_RUNTIME_UNBOUND",
      rsl: null,
      gateId: gate.id,
      message: `Junction gate ${gate.id} references a lane that is not bound to the runtime crawl.`,
    });
  }

  const partial =
    topologyOnlyLaneRsls.size > 0 ||
    runtimeOnlyLaneRsls.size > 0 ||
    laneTypeMismatchRsls.size > 0 ||
    junctionFlagMismatchRsls.size > 0 ||
    unboundGateIds.length > 0 ||
    diagnostics.length > 0;

  return {
    status: duplicateRuntimeRsls.size > 0 ? "incompatible" : partial ? "partial" : "exact",
    topologyAuthorableLaneCount: topologyAuthorable.size,
    runtimeAuthorableLaneCount: runtimeAuthorable.size,
    boundLaneRsls: sorted(boundLaneRsls),
    linkAttestedLaneRsls: sorted(linkAttestedLaneRsls),
    topologyOnlyLaneRsls: sorted(topologyOnlyLaneRsls),
    runtimeOnlyLaneRsls: sorted(runtimeOnlyLaneRsls),
    laneTypeMismatchRsls: sorted(laneTypeMismatchRsls),
    junctionFlagMismatchRsls: sorted(junctionFlagMismatchRsls),
    duplicateRuntimeRsls: sorted(duplicateRuntimeRsls),
    boundGateIds: sorted(boundGateIds),
    unboundGateIds: sorted(unboundGateIds),
    diagnostics: diagnostics.sort((left, right) =>
      left.code.localeCompare(right.code) ||
      String(left.rsl ?? "").localeCompare(String(right.rsl ?? "")) ||
      String(left.gateId ?? "").localeCompare(String(right.gateId ?? "")) ||
      left.message.localeCompare(right.message)),
  };
}

export function bindRuntimeTopology(input: {
  topology: MapTopologyIndex;
  runtimeSegments: readonly RuntimeTopologySegment[];
  provenance: RuntimeTopologyProvenance;
  /**
   * Per-lane travel direction resolved from the CARLA crawl's waypoint yaw,
   * keyed by RSL. Supplied by the caller because it needs the crawl's
   * GEOMETRY, which `RuntimeTopologySegment` deliberately does not carry.
   *
   * Omitting it leaves consumers on the lane-sign convention — see
   * `lane-travel.ts` for why that is a guess worth eliminating.
   */
  laneTravelIncreasesS?: ReadonlyMap<string, boolean> | Record<string, boolean>;
}): RuntimeBoundMapTopologyIndex {
  const travel = input.laneTravelIncreasesS;
  const laneTravelIncreasesS = travel
    ? Object.fromEntries(travel instanceof Map ? travel : Object.entries(travel))
    : undefined;
  return {
    ...input.topology,
    runtimeProvenance: input.provenance,
    runtimeParity: buildRuntimeTopologyParity(input),
    ...(laneTravelIncreasesS ? { laneTravelIncreasesS } : {}),
  };
}
