import type {
  TopologyGate,
  TopologyLane,
  TurnRelation,
} from "../map-topology/types";
import type { TravelAwareTopologyIndex } from "../map-topology/lane-travel";
import { turnRelationForHeadingChangeDeg } from "../map-topology/build-topology-index";
import {
  SEMANTIC_MAP_COMPILER_VERSION,
  SEMANTIC_MAP_SCHEMA_VERSION,
  BuildSemanticMapGraphInputSchema,
  SemanticMapGraphSchema,
  type BuildSemanticMapGraphInput,
  type CorridorEndpoint,
  type CorridorSeam,
  type JunctionApproach,
  type JunctionMovement,
  type JunctionMovementVariant,
  type LaneCorridor,
  type RuntimeBoundLaneGeometry,
  type SemanticMapAuthoringStatus,
  type SemanticMapBuildConfig,
  type SemanticMapDiagnostic,
  type SemanticMapDiagnosticCode,
  type SemanticMapGraph,
  type SemanticMapPoint,
} from "./types";
import {
  angleDelta,
  appendPolyline,
  orientToJoin,
  distance2d,
  elevationDelta,
  headingAtEnd,
  headingAtStart,
  headingAtStation,
  normalizeAngle,
  pointAtMean,
  polylineLength,
  quantize,
} from "./geometry";
import { buildConflictZones } from "./build-conflict-zones";
import { diagnostic, digest24, semanticId, sortDiagnostics } from "./internal";
import { DEFAULT_SEMANTIC_MAP_BUILD_CONFIG } from "./config";
import { lanePolyline, laneWidth, withLinkAttestedGeometry } from "./runtime-lane-geometry";
const VEHICLE_LANE_TYPES = new Set(["driving", "bidirectional"]);
type SeamEvaluation = CorridorSeam & { codes: SemanticMapDiagnosticCode[] };

function evaluateSeam(
  left: TopologyLane,
  right: TopologyLane,
  leftPoints: readonly SemanticMapPoint[],
  rightPoints: readonly SemanticMapPoint[],
  leftWidth: number | null,
  rightWidth: number | null,
  reciprocal: boolean,
  config: SemanticMapBuildConfig,
): SeamEvaluation {
  const leftEnd = leftPoints[leftPoints.length - 1]!;
  const rightStart = rightPoints[0]!;
  const endpointGapM = distance2d(leftEnd, rightStart);
  const headingDeltaRad = angleDelta(headingAtEnd(leftPoints), headingAtStart(rightPoints));
  const widthRatio = leftWidth && rightWidth
    ? Math.max(leftWidth, rightWidth) / Math.min(leftWidth, rightWidth)
    : null;
  const elevation = elevationDelta(leftEnd, rightStart);
  const adaptiveGap = leftWidth && rightWidth
    ? Math.min(config.maximumSeamGapM, Math.max(0.75, (leftWidth + rightWidth) / 2))
    : config.maximumSeamGapM;
  const codes: SemanticMapDiagnosticCode[] = [];
  if (!reciprocal) codes.push("CORRIDOR_LINK_NONRECIPROCAL");
  if (endpointGapM > adaptiveGap) codes.push("CORRIDOR_SEAM_GAP");
  if (headingDeltaRad > config.maximumSeamHeadingDeltaRad) {
    codes.push("CORRIDOR_SEAM_HEADING");
  }
  if (elevation != null && elevation > config.maximumSeamElevationDeltaM) {
    codes.push("CORRIDOR_ELEVATION_DISCONTINUITY");
  }
  // Everything above says the two lanes do not MEET; width says they meet and
  // are shaped differently, which is a normal road: a 2.9 m connector into an
  // 8.5 m lot aisle, a 4.8 m lane into a 2.7 m turn pocket. It reports, and it
  // does not decide.
  //
  // It used to decide, and it was the last systematic blocker after the crawl
  // truncation: of the 198 seams still failing across the eight corpus maps,
  // 2026-07-29, 151 failed on width ALONE with a 0 m gap and under a degree of
  // heading change. It also cannot be the drivability test it looks like — a
  // 1.05 m sliver lane is already an authorable corridor on its own, so
  // refusing only the movement INTO it protected nothing.
  const continuous = codes.length === 0;
  if (widthRatio != null && widthRatio > config.maximumSeamWidthRatio) {
    codes.push("CORRIDOR_WIDTH_DISCONTINUITY");
  }
  return {
    fromRsl: left.rsl,
    toRsl: right.rsl,
    reciprocal,
    endpointGapM: quantize(endpointGapM),
    headingDeltaRad: quantize(headingDeltaRad),
    widthRatio: widthRatio == null ? null : quantize(widthRatio),
    elevationDeltaM: elevation == null ? null : quantize(elevation),
    accepted: continuous,
    codes,
  };
}

function boundaryEndpoint(
  topology: TravelAwareTopologyIndex,
  lane: TopologyLane,
  point: SemanticMapPoint,
  headingRad: number,
  side: "start" | "end",
  cycle: boolean,
): CorridorEndpoint {
  if (cycle) {
    return { point, headingRad: quantize(headingRad), kind: "cycle", junctionId: null };
  }
  const linked = side === "start" ? lane.predecessors : lane.successors;
  const junctionIds = linked.flatMap((rsl) => {
    const adjacent = topology.lanes[rsl];
    return adjacent?.isJunction && adjacent.junctionId ? [adjacent.junctionId] : [];
  }).sort();
  if (junctionIds[0]) {
    return {
      point,
      headingRad: quantize(headingRad),
      kind: "junction",
      junctionId: junctionIds[0],
    };
  }
  if (linked.length > 1) {
    return { point, headingRad: quantize(headingRad), kind: "branch", junctionId: null };
  }
  return {
    point,
    headingRad: quantize(headingRad),
    kind: linked.length === 0 ? "dead_end" : "map_boundary",
    junctionId: null,
  };
}

type CorridorBuildResult = {
  corridors: LaneCorridor[];
  corridorByRsl: Map<string, LaneCorridor>;
  diagnostics: SemanticMapDiagnostic[];
  eligibleArcM: number;
  /**
   * Per corridor, the arc its member lanes contribute to `eligibleArcM`.
   *
   * The corridor's own `lengthM` is NOT that number: a corridor's polyline is
   * its lanes joined end to end, so any seam it stitches across adds length that
   * was never in the eligible pool. Dividing one by the other reported 100.4%
   * coverage once link-attested lanes started joining crawl-sampled ones. Kept as
   * a separate measure so the coverage stat stays a fraction of the same whole.
   */
  laneArcByCorridorId: Map<string, number>;
};

function buildCorridors(
  topology: TravelAwareTopologyIndex,
  runtimeLaneGeometry: Record<string, RuntimeBoundLaneGeometry>,
  runtimeRsls: ReadonlySet<string>,
  linkAttestedRsls: ReadonlySet<string>,
  parityOk: boolean,
  scope: string,
  config: SemanticMapBuildConfig,
): CorridorBuildResult {
  const diagnostics: SemanticMapDiagnostic[] = [];
  const eligible = Object.values(topology.lanes)
    .filter((lane) => !lane.isJunction && VEHICLE_LANE_TYPES.has(lane.laneType.toLowerCase()))
    .sort((left, right) => left.rsl.localeCompare(right.rsl));
  const eligibleByRsl = new Map(eligible.map((lane) => [lane.rsl, lane]));
  const geometry = new Map<string, SemanticMapPoint[]>();
  let eligibleArcM = 0;
  const laneArcByCorridorId = new Map<string, number>();
  for (const lane of eligible) {
    const points = lanePolyline(lane, runtimeLaneGeometry, topology.laneTravelIncreasesS);
    if (points.length < 2) {
      diagnostics.push(diagnostic(
        "LANE_GEOMETRY_MISSING",
        "error",
        "corridor",
        "The runtime lane does not have enough centerline geometry to form a corridor.",
        { laneRsls: [lane.rsl] },
      ));
      continue;
    }
    geometry.set(lane.rsl, points);
    eligibleArcM += polylineLength(points);
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const lane of eligible) {
    const next = lane.successors.filter((rsl) => eligibleByRsl.has(rsl)).sort();
    const prior = lane.predecessors.filter((rsl) => eligibleByRsl.has(rsl)).sort();
    outgoing.set(lane.rsl, next);
    incoming.set(lane.rsl, prior);
    if (next.length > 1 || prior.length > 1) {
      diagnostics.push(diagnostic(
        "CORRIDOR_BRANCH_BOUNDARY",
        "info",
        "corridor",
        "A branch or merge terminates the continuous semantic corridor.",
        { laneRsls: [lane.rsl, ...next, ...prior] },
      ));
    }
  }

  const nextByRsl = new Map<string, string>();
  const previousByRsl = new Map<string, string>();
  for (const lane of eligible) {
    const next = outgoing.get(lane.rsl) ?? [];
    if (next.length !== 1) continue;
    const targetRsl = next[0]!;
    const target = eligibleByRsl.get(targetRsl)!;
    const reciprocal = target.predecessors.includes(lane.rsl);
    if (runtimeRsls.has(lane.rsl) !== runtimeRsls.has(targetRsl)) continue;
    if ((incoming.get(targetRsl) ?? []).length !== 1 || !reciprocal) {
      if (!reciprocal) {
        diagnostics.push(diagnostic(
          "CORRIDOR_LINK_NONRECIPROCAL",
          "warning",
          "corridor",
          "A one-way topology reference was not used to stitch semantic lanes.",
          { laneRsls: [lane.rsl, targetRsl] },
        ));
      }
      continue;
    }
    const leftPoints = geometry.get(lane.rsl);
    const rightPoints = geometry.get(targetRsl);
    if (!leftPoints || !rightPoints) continue;
    const seam = evaluateSeam(
      lane,
      target,
      leftPoints,
      rightPoints,
      laneWidth(lane, runtimeLaneGeometry[lane.rsl]),
      laneWidth(target, runtimeLaneGeometry[targetRsl]),
      reciprocal,
      config,
    );
    for (const code of seam.codes) {
      diagnostics.push(diagnostic(
        code,
        "warning",
        "corridor",
        seam.accepted
          ? "A topology-linked lane seam was stitched despite a reported geometry anomaly."
          : "A topology-linked lane seam failed conservative geometry validation.",
        { laneRsls: [lane.rsl, targetRsl], details: seam },
      ));
    }
    if (!seam.accepted) continue;
    nextByRsl.set(lane.rsl, targetRsl);
    previousByRsl.set(targetRsl, lane.rsl);
  }

  const chains: Array<{ rsls: string[]; cycle: boolean }> = [];
  const visited = new Set<string>();
  const walk = (seed: string, cycle: boolean) => {
    const rsls: string[] = [];
    let current: string | undefined = seed;
    while (current && !visited.has(current)) {
      visited.add(current);
      rsls.push(current);
      current = nextByRsl.get(current);
    }
    if (rsls.length > 0) chains.push({ rsls, cycle });
  };
  for (const lane of eligible) {
    if (!geometry.has(lane.rsl) || previousByRsl.has(lane.rsl)) continue;
    walk(lane.rsl, false);
  }
  for (const lane of eligible) {
    if (!geometry.has(lane.rsl) || visited.has(lane.rsl)) continue;
    diagnostics.push(diagnostic(
      "CORRIDOR_CYCLE",
      "warning",
      "corridor",
      "A closed lane cycle was rooted deterministically at its lexical-minimum fragment.",
      { laneRsls: [lane.rsl] },
    ));
    walk(lane.rsl, true);
  }

  const corridors: LaneCorridor[] = [];
  const corridorByRsl = new Map<string, LaneCorridor>();
  for (const chain of chains) {
    const id = semanticId("cor", scope, chain.rsls);
    const points: SemanticMapPoint[] = [];
    const seams: CorridorSeam[] = [];
    const widths: number[] = [];
    const speeds: number[] = [];
    const fragments: LaneCorridor["runtimeFragments"] = [];
    const codes = new Set<SemanticMapDiagnosticCode>();
    let accumulated = 0;
    let laneArc = 0;
    for (let index = 0; index < chain.rsls.length; index += 1) {
      const rsl = chain.rsls[index]!;
      const lane = eligibleByRsl.get(rsl)!;
      const lanePoints = geometry.get(rsl)!;
      const length = polylineLength(lanePoints);
      fragments.push({
        rsl,
        startArcM: quantize(accumulated),
        endArcM: quantize(accumulated + length),
      });
      accumulated += length;
      laneArc += length;
      appendPolyline(points, lanePoints);
      const width = laneWidth(lane, runtimeLaneGeometry[rsl]);
      if (width) widths.push(width);
      if (lane.speedLimitKph != null) speeds.push(lane.speedLimitKph);
      if (!runtimeRsls.has(rsl)) codes.add("RUNTIME_LANE_UNBOUND");
      // A link-attested lane has no crawl geometry by definition, and its
      // OpenDRIVE polyline is what `lanePolyline` already fell back to. Flagging
      // that as missing geometry would demote every movement through it to
      // `diagnostic_only` and undo the binding one stage later.
      if (!runtimeLaneGeometry[rsl] && !linkAttestedRsls.has(rsl)) {
        codes.add("RUNTIME_LANE_GEOMETRY_MISSING");
      }
      if (index > 0) {
        const priorRsl = chain.rsls[index - 1]!;
        const prior = eligibleByRsl.get(priorRsl)!;
        const seam = evaluateSeam(
          prior,
          lane,
          geometry.get(priorRsl)!,
          lanePoints,
          laneWidth(prior, runtimeLaneGeometry[priorRsl]),
          width,
          true,
          config,
        );
        seams.push(seam);
      }
    }
    if (!parityOk && codes.size === 0) codes.add("RUNTIME_PARITY_MISSING");
    const firstLane = eligibleByRsl.get(chain.rsls[0]!)!;
    const lastLane = eligibleByRsl.get(chain.rsls[chain.rsls.length - 1]!)!;
    const status: SemanticMapAuthoringStatus = codes.has("RUNTIME_LANE_UNBOUND")
      ? "unbound"
      : codes.size > 0 || !parityOk
        ? "diagnostic_only"
        : "authorable";
    const corridor: LaneCorridor = {
      id,
      laneType: firstLane.laneType.toLowerCase(),
      runtimeFragments: fragments,
      polyline: points,
      lengthM: quantize(polylineLength(points)),
      representativeWidthM: widths.length
        ? quantize(widths.reduce((sum, width) => sum + width, 0) / widths.length)
        : null,
      minWidthM: widths.length ? quantize(Math.min(...widths)) : null,
      maxWidthM: widths.length ? quantize(Math.max(...widths)) : null,
      speedLimitKph: speeds.length
        ? quantize(Math.min(...speeds))
        : null,
      start: boundaryEndpoint(
        topology,
        firstLane,
        points[0]!,
        headingAtStart(points),
        "start",
        chain.cycle,
      ),
      end: boundaryEndpoint(
        topology,
        lastLane,
        points[points.length - 1]!,
        headingAtEnd(points),
        "end",
        chain.cycle,
      ),
      predecessorCorridorIds: [],
      successorCorridorIds: [],
      lateralAdjacencies: [],
      seams,
      authoringStatus: status,
      diagnosticCodes: [...codes].sort(),
    };
    corridors.push(corridor);
    laneArcByCorridorId.set(id, laneArc);
    for (const rsl of chain.rsls) corridorByRsl.set(rsl, corridor);
  }

  for (const corridor of corridors) {
    const first = topology.lanes[corridor.runtimeFragments[0]!.rsl]!;
    const last = topology.lanes[corridor.runtimeFragments[corridor.runtimeFragments.length - 1]!.rsl]!;
    corridor.predecessorCorridorIds = [...new Set(first.predecessors.flatMap((rsl) => {
      const adjacent = corridorByRsl.get(rsl);
      return adjacent && adjacent.id !== corridor.id ? [adjacent.id] : [];
    }))].sort();
    corridor.successorCorridorIds = [...new Set(last.successors.flatMap((rsl) => {
      const adjacent = corridorByRsl.get(rsl);
      return adjacent && adjacent.id !== corridor.id ? [adjacent.id] : [];
    }))].sort();

    const lateral = new Map<string, LaneCorridor["lateralAdjacencies"][number]>();
    for (const fragment of corridor.runtimeFragments) {
      const lane = topology.lanes[fragment.rsl];
      if (!lane?.adjacentLanes) continue;
      const fragmentLengthM = Math.max(0, fragment.endArcM - fragment.startArcM);
      for (const side of ["left", "right"] as const) {
        const adjacency = lane.adjacentLanes[side];
        if (!adjacency?.laneRsl) continue;
        const target = corridorByRsl.get(adjacency.laneRsl);
        if (!target || target.id === corridor.id) continue;
        const key = `${side}:${target.id}`;
        const row = lateral.get(key) ?? {
          side,
          targetCorridorId: target.id,
          sameDirection: adjacency.sameDirection,
          permissionIntervals: [],
        };
        const permissionIds = new Set(adjacency.permissionIds);
        for (const permission of lane.laneChangePermissions ?? []) {
          if (!permissionIds.has(permission.id) || permission.side !== side) continue;
          const startM = fragment.startArcM + Math.min(fragmentLengthM, Math.max(0, permission.startS));
          const endM = fragment.startArcM + Math.min(fragmentLengthM, Math.max(0, permission.endS));
          if (endM < startM) continue;
          row.permissionIntervals.push({
            startM: quantize(startM),
            endM: quantize(endM),
            allowed: permission.allowed,
            marking: permission.marking,
            source: permission.source,
          });
        }
        lateral.set(key, row);
      }
    }
    corridor.lateralAdjacencies = [...lateral.values()]
      .map((row) => ({
        ...row,
        permissionIntervals: row.permissionIntervals.sort((left, right) =>
          left.startM - right.startM || left.endM - right.endM),
      }))
      .sort((left, right) =>
        left.side.localeCompare(right.side) || left.targetCorridorId.localeCompare(right.targetCorridorId),
      );
  }
  corridors.sort((left, right) => left.id.localeCompare(right.id));
  return { corridors, corridorByRsl, diagnostics, eligibleArcM, laneArcByCorridorId };
}

type GatePath = {
  gate: TopologyGate;
  incomingCorridor: LaneCorridor;
  outgoingCorridor: LaneCorridor;
  runtimeLaneRsls: string[];
};

function enumerateGatePaths(
  topology: TravelAwareTopologyIndex,
  corridorByRsl: Map<string, LaneCorridor>,
  boundLaneRsls: ReadonlySet<string>,
  boundGateIds: ReadonlySet<string>,
  config: SemanticMapBuildConfig,
): { paths: GatePath[]; diagnostics: SemanticMapDiagnostic[] } {
  const paths: GatePath[] = [];
  const diagnostics: SemanticMapDiagnostic[] = [];
  for (const gate of [...topology.gates].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!boundGateIds.has(gate.id)) {
      diagnostics.push(diagnostic(
        "GATE_RUNTIME_UNBOUND",
        "warning",
        "variant",
        "The gate is absent from the exact runtime-bound gate set and cannot produce semantic movements.",
        {
          laneRsls: [
            gate.approachLaneRsl,
            gate.connectingLaneRsl,
            ...gate.exitLaneRsls,
          ],
          gateIds: [gate.id],
        },
      ));
      continue;
    }
    const incomingCorridor = corridorByRsl.get(gate.approachLaneRsl);
    const connecting = topology.lanes[gate.connectingLaneRsl];
    if (!incomingCorridor || !connecting) {
      diagnostics.push(diagnostic(
        incomingCorridor ? "GATE_LANE_MISSING" : "GATE_APPROACH_UNBOUND",
        "error",
        "variant",
        "A topology gate cannot be bound to its semantic approach and connector.",
        { laneRsls: [gate.approachLaneRsl, gate.connectingLaneRsl], gateIds: [gate.id] },
      ));
      continue;
    }
    const completed: string[][] = [];
    let hitLimit = false;
    const walk = (rsl: string, path: string[], seen: Set<string>) => {
      if (completed.length >= config.maximumVariantsPerGate) {
        hitLimit = true;
        return;
      }
      if (path.length >= config.maximumInternalFragments) {
        hitLimit = true;
        return;
      }
      if (seen.has(rsl)) return;
      if (!boundLaneRsls.has(rsl)) return;
      const lane = topology.lanes[rsl];
      if (!lane) return;
      const nextPath = [...path, rsl];
      if (!lane.isJunction) {
        if (
          gate.exitLaneRsls.length === 0 ||
          gate.exitLaneRsls.includes(rsl) ||
          gate.exitLaneRsls.some((exitRsl) => corridorByRsl.get(exitRsl)?.id === corridorByRsl.get(rsl)?.id)
        ) {
          completed.push(nextPath);
        }
        return;
      }
      const nextSeen = new Set(seen).add(rsl);
      for (const successor of [...lane.successors].sort()) {
        walk(successor, nextPath, nextSeen);
      }
    };
    walk(gate.connectingLaneRsl, [], new Set());
    if (hitLimit) {
      diagnostics.push(diagnostic(
        "GATE_INTERNAL_PATH_LIMIT",
        "error",
        "variant",
        "The bounded junction-internal path search reached its safety limit.",
        { gateIds: [gate.id] },
      ));
    }
    if (completed.length === 0) {
      diagnostics.push(diagnostic(
        "GATE_INTERNAL_PATH_MISSING",
        "error",
        "variant",
        "No directed connector chain reaches a declared non-junction exit.",
        { laneRsls: [gate.connectingLaneRsl, ...gate.exitLaneRsls], gateIds: [gate.id] },
      ));
      continue;
    }
    if (completed.length > 1) {
      diagnostics.push(diagnostic(
        "GATE_INTERNAL_PATH_AMBIGUOUS",
        "warning",
        "variant",
        "The gate has multiple explicit runtime connector paths; each is preserved as a variant.",
        { gateIds: [gate.id], details: { variantCount: completed.length } },
      ));
    }
    for (const path of completed.sort((left, right) => left.join("|").localeCompare(right.join("|")))) {
      const outgoingCorridor = corridorByRsl.get(path[path.length - 1]!);
      if (!outgoingCorridor) {
        diagnostics.push(diagnostic(
          "GATE_EXIT_UNBOUND",
          "error",
          "variant",
          "A gate connector reaches a runtime lane without a semantic exit corridor.",
          { laneRsls: path, gateIds: [gate.id] },
        ));
        continue;
      }
      paths.push({
        gate,
        incomingCorridor,
        outgoingCorridor,
        runtimeLaneRsls: [gate.approachLaneRsl, ...path],
      });
    }
  }
  return { paths, diagnostics };
}

type ApproachCandidate = {
  junctionId: string;
  direction: "incoming" | "outgoing";
  corridor: LaneCorridor;
  point: SemanticMapPoint;
  headingRad: number;
};

function approachesCompatible(
  left: ApproachCandidate,
  right: ApproachCandidate,
  config: SemanticMapBuildConfig,
): boolean {
  if (left.junctionId !== right.junctionId || left.direction !== right.direction) return false;
  if (distance2d(left.point, right.point) > config.maximumApproachBoundaryDistanceM) return false;
  if (angleDelta(left.headingRad, right.headingRad) > config.maximumApproachHeadingDeltaRad) {
    return false;
  }
  const elevation = elevationDelta(left.point, right.point);
  return elevation == null || elevation <= config.maximumApproachElevationDeltaM;
}

function buildApproaches(
  gatePaths: readonly GatePath[],
  scope: string,
  parityOk: boolean,
  config: SemanticMapBuildConfig,
): { approaches: JunctionApproach[]; byKey: Map<string, JunctionApproach>; diagnostics: SemanticMapDiagnostic[] } {
  const candidatesByKey = new Map<string, Map<string, ApproachCandidate>>();
  const add = (candidate: ApproachCandidate) => {
    const key = `${candidate.junctionId}:${candidate.direction}`;
    const rows = candidatesByKey.get(key) ?? new Map<string, ApproachCandidate>();
    rows.set(candidate.corridor.id, candidate);
    candidatesByKey.set(key, rows);
  };
  for (const path of gatePaths) {
    add({
      junctionId: path.gate.junctionId,
      direction: "incoming",
      corridor: path.incomingCorridor,
      point: path.incomingCorridor.end.point,
      headingRad: path.incomingCorridor.end.headingRad,
    });
    add({
      junctionId: path.gate.junctionId,
      direction: "outgoing",
      corridor: path.outgoingCorridor,
      point: path.outgoingCorridor.start.point,
      headingRad: path.outgoingCorridor.start.headingRad,
    });
  }

  const approaches: JunctionApproach[] = [];
  const byKey = new Map<string, JunctionApproach>();
  const diagnostics: SemanticMapDiagnostic[] = [];
  for (const [key, byCorridor] of [...candidatesByKey.entries()].sort()) {
    let clusters = [...byCorridor.values()]
      .sort((left, right) => left.corridor.id.localeCompare(right.corridor.id))
      .map((candidate) => [candidate]);
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let leftIndex = 0; leftIndex < clusters.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < clusters.length; rightIndex += 1) {
          const left = clusters[leftIndex]!;
          const right = clusters[rightIndex]!;
          if (left.every((a) => right.every((b) => approachesCompatible(a, b, config)))) {
            clusters = [
              ...clusters.slice(0, leftIndex),
              [...left, ...right].sort((a, b) => a.corridor.id.localeCompare(b.corridor.id)),
              ...clusters.slice(leftIndex + 1, rightIndex),
              ...clusters.slice(rightIndex + 1),
            ];
            merged = true;
            break outer;
          }
        }
      }
    }
    for (const cluster of clusters) {
      const sample = cluster[0]!;
      const id = semanticId(
        "app",
        scope,
        [sample.junctionId, sample.direction, ...cluster.map((row) => row.corridor.id)],
      );
      const boundaryCenter = pointAtMean(cluster.map((row) => row.point));
      const meanSin = cluster.reduce((sum, row) => sum + Math.sin(row.headingRad), 0);
      const meanCos = cluster.reduce((sum, row) => sum + Math.cos(row.headingRad), 0);
      const headingRad = Math.atan2(meanSin, meanCos);
      const withUnknownElevation = cluster.length > 1 && cluster.some((row) => row.point.z == null);
      const corridorStatus = cluster.some((row) => row.corridor.authoringStatus === "unbound")
        ? "unbound"
        : cluster.some((row) => row.corridor.authoringStatus !== "authorable") || !parityOk || withUnknownElevation
          ? "diagnostic_only"
          : "authorable";
      const lateralRows = cluster.map((row) => ({
        row,
        offset: -(row.point.x - boundaryCenter.x) * Math.sin(headingRad) +
          (row.point.y - boundaryCenter.y) * Math.cos(headingRad),
      })).sort((left, right) => right.offset - left.offset || left.row.corridor.id.localeCompare(right.row.corridor.id));
      const laneSlots = lateralRows.map(({ row, offset }, index) => ({
        corridorId: row.corridor.id,
        ordinalFromLeft: index,
        role: lateralRows.length === 1
          ? "single" as const
          : index === 0
            ? "leftmost" as const
            : index === lateralRows.length - 1
              ? "rightmost" as const
              : "inner" as const,
        lateralOffsetM: quantize(offset),
      }));
      const codes = withUnknownElevation
        ? ["APPROACH_ELEVATION_AMBIGUOUS" as const]
        : [];
      if (withUnknownElevation) {
        diagnostics.push(diagnostic(
          "APPROACH_ELEVATION_AMBIGUOUS",
          "warning",
          "approach",
          "Parallel approach lanes lack runtime elevation and cannot be safely distinguished from stacked geometry.",
          { entityId: id, laneRsls: cluster.flatMap((row) => row.corridor.runtimeFragments.map((fragment) => fragment.rsl)) },
        ));
      }
      const approach: JunctionApproach = {
        id,
        junctionId: sample.junctionId,
        direction: sample.direction,
        boundaryCenter,
        headingRad: quantize(headingRad),
        corridorIds: cluster.map((row) => row.corridor.id).sort(),
        laneSlots,
        movementIds: [],
        authoringStatus: corridorStatus,
        diagnosticCodes: codes,
      };
      approaches.push(approach);
      for (const row of cluster) byKey.set(`${key}:${row.corridor.id}`, approach);
    }
  }
  approaches.sort((left, right) => left.id.localeCompare(right.id));
  return { approaches, byKey, diagnostics };
}

function buildMovements(
  topology: TravelAwareTopologyIndex,
  runtimeLaneGeometry: Record<string, RuntimeBoundLaneGeometry>,
  runtimeRsls: ReadonlySet<string>,
  linkAttestedRsls: ReadonlySet<string>,
  gatePaths: readonly GatePath[],
  approaches: JunctionApproach[],
  approachByKey: Map<string, JunctionApproach>,
  scope: string,
  parityOk: boolean,
  config: SemanticMapBuildConfig,
): { variants: JunctionMovementVariant[]; movements: JunctionMovement[]; diagnostics: SemanticMapDiagnostic[] } {
  type DraftVariant = Omit<JunctionMovementVariant, "movementId"> & { movementId?: string };
  const drafts: Array<{ draft: DraftVariant; groupKey: string }> = [];
  const diagnostics: SemanticMapDiagnostic[] = [];
  for (const path of gatePaths) {
    const incoming = approachByKey.get(`${path.gate.junctionId}:incoming:${path.incomingCorridor.id}`);
    const outgoing = approachByKey.get(`${path.gate.junctionId}:outgoing:${path.outgoingCorridor.id}`);
    if (!incoming || !outgoing) continue;
    const id = semanticId("mvr", scope, [path.gate.id, ...path.runtimeLaneRsls]);
    const points: SemanticMapPoint[] = [];
    const codes = new Set<SemanticMapDiagnosticCode>();
    let entryStationM = 0;
    let exitStationM = 0;
    for (let index = 0; index < path.runtimeLaneRsls.length; index += 1) {
      const rsl = path.runtimeLaneRsls[index]!;
      const lane = topology.lanes[rsl];
      if (!lane) {
        codes.add("GATE_LANE_MISSING");
        continue;
      }
      const rawLanePoints = lanePolyline(lane, runtimeLaneGeometry, topology.laneTravelIncreasesS);
      if (rawLanePoints.length < 2) {
        codes.add("LANE_GEOMETRY_MISSING");
        continue;
      }
      // Orientation belongs to the TRAVERSAL, and the gate path is what defines
      // it, so each lane is oriented to JOIN the one before it and the seam is
      // evaluated on the oriented pair — the same polyline the composition will
      // use. Judging one orientation and composing another is how a seam verdict
      // and its own geometry come to disagree.
      //
      // Small: 4 of 51 remaining failing seams across the eight corpus maps,
      // 2026-07-29. The demotions this was first written to explain were the
      // crawl truncation instead (`runtime-lane-geometry.ts`).
      const lanePoints =
        index > 0 && points.length > 0
          ? orientToJoin(points[points.length - 1]!, rawLanePoints)
          : rawLanePoints;
      if (index > 0) {
        const priorRsl = path.runtimeLaneRsls[index - 1]!;
        const prior = topology.lanes[priorRsl]!;
        const seam = evaluateSeam(
          prior,
          lane,
          // The composed path so far IS the prior lane's driven geometry, already
          // oriented by this same rule. Re-deriving it from `lanePolyline` would
          // re-introduce the orientation the join just corrected.
          points,
          lanePoints,
          laneWidth(prior, runtimeLaneGeometry[priorRsl]),
          laneWidth(lane, runtimeLaneGeometry[rsl]),
          prior.successors.includes(rsl) && lane.predecessors.includes(priorRsl),
          config,
        );
        if (!seam.accepted) codes.add("GATE_GEOMETRY_DISCONTINUITY");
      }
      appendPolyline(points, lanePoints);
      if (index === 0) entryStationM = polylineLength(points);
      if (index === path.runtimeLaneRsls.length - 2) exitStationM = polylineLength(points);
      if (!runtimeRsls.has(rsl)) codes.add("RUNTIME_LANE_UNBOUND");
      // A link-attested lane has no crawl geometry by definition, and its
      // OpenDRIVE polyline is what `lanePolyline` already fell back to. Flagging
      // that as missing geometry would demote every movement through it to
      // `diagnostic_only` and undo the binding one stage later.
      if (!runtimeLaneGeometry[rsl] && !linkAttestedRsls.has(rsl)) {
        codes.add("RUNTIME_LANE_GEOMETRY_MISSING");
      }
    }
    if (points.length < 2) continue;
    // The turn is what happens BETWEEN the approach and the exit, so it is
    // measured at the two stations the composition just recorded rather than
    // from the composed path's own first and last edge. Those edges sit at the
    // far ends of the approach and exit lanes, and a curving approach lane bends
    // the whole-path heading change enough to reclassify the turn: measured over
    // the eight corpus maps, 2026-07-29, whole-path measurement disagrees with
    // the topology gate on 243 variants and takes away the only authorable way
    // out of 125 corridors, for curvature that is not part of the turn at all.
    const derivedTurn = turnRelationForHeadingChangeDeg(
      (normalizeAngle(
        headingAtStation(points, exitStationM, "after")
          - headingAtStation(points, entryStationM, "before"),
      ) * 180) / Math.PI,
    );
    // A movement is labelled by what a car actually drives through it.
    //
    // The gate's relation comes from the OpenDRIVE junction record and the
    // derived one from the composed runtime geometry. When they disagree the
    // GEOMETRY wins, because it is the path the car takes: Di Rosa has a gate
    // labelled `Straight` whose runtime heading change is 58 degrees, and
    // calling that straight would send a car told to go straight around a bend.
    //
    // The disagreement is still reported, but it no longer DELETES the movement.
    // It used to land in `codes`, which demotes to `diagnostic_only` and takes
    // the path out of the drivable graph entirely — 106 variants across the nine
    // dev maps, and for 36 corridors it removed the only way out, manufacturing
    // dead ends on roads that are perfectly connected. A label nobody agrees on
    // is a reason to trust the geometry, not a reason to close the road.
    if (derivedTurn !== path.gate.turnRelation) {
      diagnostics.push(diagnostic(
        "MOVEMENT_TURN_MISMATCH",
        "warning",
        "variant",
        "The composed runtime path turn does not match the topology gate classification; the runtime geometry is authoritative.",
        {
          entityId: id,
          laneRsls: path.runtimeLaneRsls,
          gateIds: [path.gate.id],
          details: { expected: path.gate.turnRelation, derived: derivedTurn },
        },
      ));
    }
    if (!parityOk && codes.size === 0) codes.add("RUNTIME_PARITY_MISSING");
    const status: SemanticMapAuthoringStatus = codes.has("RUNTIME_LANE_UNBOUND")
      ? "unbound"
      : codes.size > 0 || !parityOk || incoming.authoringStatus !== "authorable" || outgoing.authoringStatus !== "authorable"
        ? "diagnostic_only"
        : "authorable";
    const widths = path.runtimeLaneRsls.flatMap((rsl) => {
      const lane = topology.lanes[rsl];
      const width = lane ? laneWidth(lane, runtimeLaneGeometry[rsl]) : null;
      return width ? [width] : [];
    });
    const groupKey = [
      path.gate.junctionId,
      incoming.id,
      outgoing.id,
      // `derivedTurn`, so the movement a car sees is named after the path it
      // drives. `deriveRunway` ranks `Straight` first and matches authored turn
      // intents on this field, so a wrong label here is a wrong manoeuvre.
      derivedTurn,
    ].join("|");
    drafts.push({
      groupKey,
      draft: {
        id,
        gateId: path.gate.id,
        incomingCorridorId: path.incomingCorridor.id,
        outgoingCorridorId: path.outgoingCorridor.id,
        runtimeLaneRsls: path.runtimeLaneRsls,
        polyline: points,
        lengthM: quantize(polylineLength(points)),
        entryStationM: quantize(entryStationM),
        exitStationM: quantize(exitStationM),
        representativeWidthM: widths.length
          ? quantize(widths.reduce((sum, width) => sum + width, 0) / widths.length)
          : null,
        authoringStatus: status,
        diagnosticCodes: [...codes].sort(),
      },
    });
  }

  const grouped = new Map<string, typeof drafts>();
  for (const row of drafts) grouped.set(row.groupKey, [...(grouped.get(row.groupKey) ?? []), row]);
  const variants: JunctionMovementVariant[] = [];
  const movements: JunctionMovement[] = [];
  for (const [groupKey, rows] of [...grouped.entries()].sort()) {
    rows.sort((left, right) => left.draft.id.localeCompare(right.draft.id));
    const [junctionId, incomingApproachId, outgoingApproachId, turnRelation] = groupKey.split("|") as [string, string, string, TurnRelation];
    const movementId = semanticId("mov", scope, [groupKey, ...rows.map((row) => row.draft.id)]);
    const concrete = rows.map(({ draft }) => ({ ...draft, movementId } as JunctionMovementVariant));
    variants.push(...concrete);
    const representative = concrete.find((variant) => variant.authoringStatus === "authorable") ?? concrete[0]!;
    const status: SemanticMapAuthoringStatus = concrete.some((variant) => variant.authoringStatus === "authorable")
      ? "authorable"
      : concrete.some((variant) => variant.authoringStatus === "diagnostic_only")
        ? "diagnostic_only"
        : "unbound";
    movements.push({
      id: movementId,
      junctionId,
      incomingApproachId,
      outgoingApproachId,
      turnRelation,
      variantIds: concrete.map((variant) => variant.id).sort(),
      representativeVariantId: representative.id,
      conflictZoneIds: [],
      authoringStatus: status,
      diagnosticCodes: [...new Set(concrete.flatMap((variant) => variant.diagnosticCodes))].sort(),
    });
  }
  variants.sort((left, right) => left.id.localeCompare(right.id));
  movements.sort((left, right) => left.id.localeCompare(right.id));
  const movementIdsByApproach = new Map<string, string[]>();
  for (const movement of movements) {
    for (const approachId of [movement.incomingApproachId, movement.outgoingApproachId]) {
      movementIdsByApproach.set(approachId, [...(movementIdsByApproach.get(approachId) ?? []), movement.id]);
    }
  }
  for (const approach of approaches) {
    approach.movementIds = [...new Set(movementIdsByApproach.get(approach.id) ?? [])].sort();
  }
  return { variants, movements, diagnostics };
}

/**
 * Build the deterministic semantic authoring graph above exact runtime lane
 * fragments. Missing runtime parity never triggers geometry repair: the graph
 * remains inspectable but all authoring is fail-closed.
 */
export function buildSemanticMapGraph(rawInput: BuildSemanticMapGraphInput): SemanticMapGraph {
  const input = BuildSemanticMapGraphInputSchema.parse(rawInput);
  const topology = input.topology;
  const runtime = topology.runtimeProvenance;
  const runtimeRsls = new Set(topology.runtimeParity.boundLaneRsls);
  // Bound on the strength of CARLA's own links rather than a sampled waypoint,
  // so their geometry is the OpenDRIVE's. Tracked because "no crawl geometry" is
  // a defect for every other lane and expected for these.
  const linkAttestedRsls = new Set(topology.runtimeParity.linkAttestedLaneRsls ?? []);
  // Give those lanes an elevation before anything reads their geometry, or the
  // approach clustering demotes every movement through them for ambiguity it
  // could have resolved. See `withLinkAttestedGeometry`.
  const runtimeLaneGeometry = withLinkAttestedGeometry(
    topology.lanes,
    input.runtimeLaneGeometry,
    linkAttestedRsls,
  );
  const config: SemanticMapBuildConfig = {
    ...DEFAULT_SEMANTIC_MAP_BUILD_CONFIG,
    ...(input.config ?? {}),
  };
  const diagnostics: SemanticMapDiagnostic[] = [];
  const topologyHash = topology.source.xodrSha256?.trim() ?? "";
  if (!topologyHash) {
    diagnostics.push(diagnostic(
      "SOURCE_XODR_HASH_MISSING",
      "error",
      "graph",
      "The topology has no content-pinned OpenDRIVE hash.",
    ));
  }
  if (topologyHash !== runtime.xodrSha256) {
    diagnostics.push(diagnostic(
      "RUNTIME_XODR_HASH_MISMATCH",
      "error",
      "graph",
      "The semantic topology and CARLA runtime crawl come from different OpenDRIVE revisions.",
      { details: { topologyHash, runtimeHash: runtime.xodrSha256 } },
    ));
  }
  if (!runtime.runtimeRoadGraphSha256) {
    diagnostics.push(diagnostic(
      "RUNTIME_GRAPH_HASH_MISSING",
      "error",
      "graph",
      "The runtime road graph is not content-addressed.",
    ));
  }
  if (!runtime.projectionIdentitySha256) {
    diagnostics.push(diagnostic(
      "PROJECTION_IDENTITY_MISSING",
      "error",
      "graph",
      "The runtime coordinate projection is not pinned.",
    ));
  }
  if (
    topology.runtimeParity.status === "incompatible" ||
    topology.runtimeParity.duplicateRuntimeRsls.length > 0
  ) {
    diagnostics.push(diagnostic(
      "RUNTIME_PARITY_INCOMPATIBLE",
      "error",
      "graph",
      "The runtime-bound topology contains incompatible or duplicate runtime lane identities.",
      {
        laneRsls: topology.runtimeParity.duplicateRuntimeRsls,
        details: { parityStatus: topology.runtimeParity.status },
      },
    ));
  } else if (topology.runtimeParity.status === "partial") {
    diagnostics.push(diagnostic(
      "RUNTIME_PARITY_PARTIAL",
      "warning",
      "graph",
      "Map parity is partial; only the exact bound-lane and bound-gate subset is authorable.",
      {
        laneRsls: [
          ...topology.runtimeParity.topologyOnlyLaneRsls,
          ...topology.runtimeParity.runtimeOnlyLaneRsls,
          ...topology.runtimeParity.laneTypeMismatchRsls,
          ...topology.runtimeParity.junctionFlagMismatchRsls,
        ],
        gateIds: topology.runtimeParity.unboundGateIds,
        details: { parityStatus: topology.runtimeParity.status },
      },
    ));
  }
  const parityOk = diagnostics.every((row) => row.severity !== "error");
  const scope = [
    runtime.mapAssetId,
    topologyHash,
    runtime.runtimeRoadGraphSha256,
    SEMANTIC_MAP_COMPILER_VERSION,
  ].join("|");
  const corridorResult = buildCorridors(
    topology,
    runtimeLaneGeometry,
    runtimeRsls,
    linkAttestedRsls,
    parityOk,
    scope,
    config,
  );
  diagnostics.push(...corridorResult.diagnostics);
  const gateResult = enumerateGatePaths(
    topology,
    corridorResult.corridorByRsl,
    runtimeRsls,
    new Set(topology.runtimeParity.boundGateIds),
    config,
  );
  diagnostics.push(...gateResult.diagnostics);
  const approachResult = buildApproaches(gateResult.paths, scope, parityOk, config);
  diagnostics.push(...approachResult.diagnostics);
  const movementResult = buildMovements(
    topology,
    runtimeLaneGeometry,
    runtimeRsls,
    linkAttestedRsls,
    gateResult.paths,
    approachResult.approaches,
    approachResult.byKey,
    scope,
    parityOk,
    config,
  );
  diagnostics.push(...movementResult.diagnostics);
  const conflictResult = buildConflictZones(
    movementResult.movements,
    movementResult.variants,
    scope,
    parityOk,
    config,
  );
  diagnostics.push(...conflictResult.diagnostics);

  const referencedRsls = new Set([
    ...corridorResult.corridors.flatMap((corridor) => corridor.runtimeFragments.map((fragment) => fragment.rsl)),
    ...movementResult.variants.flatMap((variant) => variant.runtimeLaneRsls),
  ]);
  const unboundRsls = [...referencedRsls].filter((rsl) => !runtimeRsls.has(rsl)).sort();
  if (unboundRsls.length > 0) {
    diagnostics.push(diagnostic(
      "RUNTIME_LANE_UNBOUND",
      "warning",
      "graph",
      "Unbound lane fragments remain diagnostic-only and are excluded from authorable movements.",
      { laneRsls: unboundRsls },
    ));
  }
  const finalParityOk = parityOk;
  const representedArcM = corridorResult.corridors
    .filter((corridor) => corridor.authoringStatus === "authorable")
    .reduce((sum, corridor) => sum + (corridorResult.laneArcByCorridorId.get(corridor.id) ?? 0), 0);
  const generatedAt = input.generatedAt ?? topology.generatedAt;
  const graphRevision = `sem_${digest24(`${scope}|${JSON.stringify(config)}`)}`;
  const graph: SemanticMapGraph = {
    schemaVersion: SEMANTIC_MAP_SCHEMA_VERSION,
    compilerVersion: SEMANTIC_MAP_COMPILER_VERSION,
    graphRevision,
    generatedAt,
    source: {
      mapName: topology.mapName,
      topologySchemaVersion: 3,
      runtimeProvenance: runtime,
    },
    authority: finalParityOk ? "runtime_verified" : "diagnostic_only",
    authoringReady:
      finalParityOk &&
      corridorResult.corridors.some((corridor) => corridor.authoringStatus === "authorable") &&
      movementResult.movements.some((movement) => movement.authoringStatus === "authorable"),
    buildConfig: Object.fromEntries(
      Object.entries(config).map(([key, value]) => [key, quantize(value)]),
    ) as SemanticMapBuildConfig,
    corridors: corridorResult.corridors,
    approaches: approachResult.approaches,
    movementVariants: movementResult.variants,
    movements: movementResult.movements,
    conflictZones: conflictResult.zones,
    diagnostics: sortDiagnostics(diagnostics),
    stats: {
      eligibleRuntimeLanes: Object.values(topology.lanes).filter(
        (lane) => !lane.isJunction && VEHICLE_LANE_TYPES.has(lane.laneType.toLowerCase()),
      ).length,
      boundRuntimeLanes: [...referencedRsls].filter((rsl) => runtimeRsls.has(rsl)).length,
      corridors: corridorResult.corridors.length,
      authorableCorridors: corridorResult.corridors.filter(
        (corridor) => corridor.authoringStatus === "authorable",
      ).length,
      approaches: approachResult.approaches.length,
      movements: movementResult.movements.length,
      movementVariants: movementResult.variants.length,
      conflictZones: conflictResult.zones.length,
      representedNonJunctionArcM: quantize(representedArcM),
      eligibleNonJunctionArcM: quantize(corridorResult.eligibleArcM),
      representedArcPct: corridorResult.eligibleArcM > 0
        ? quantize((representedArcM / corridorResult.eligibleArcM) * 100)
        : 0,
    },
  };
  return SemanticMapGraphSchema.parse(graph);
}
