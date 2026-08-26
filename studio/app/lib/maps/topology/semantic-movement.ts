import type {
  JunctionApproach,
  JunctionMovement,
  JunctionMovementVariant,
  MapTopologyIndex,
  SemanticMapGraph,
  TopologyGate,
  Vec2,
} from "@simforge-oss/studio-shared";
import {
  dist,
  projectOnPolyline,
} from "@/app/lib/maps/topology/relocation-geometry";

export type SemanticRuntimeChain = {
  chain: Array<{ rsl: string; oriented: Vec2[] }>;
  flat: Vec2[];
};

export type SemanticMovementSelection = {
  movement: JunctionMovement;
  variant: JunctionMovementVariant;
  approach: JunctionApproach;
  gate: TopologyGate;
  gateBuild: SemanticRuntimeChain;
  approachHeadingRad: number;
};

/** Runtime lanes that a movement proof can authorize, including every
 * authorable upstream corridor connected without crossing another junction. */
export function semanticMovementRuntimeLaneSet(
  graph: SemanticMapGraph,
  variant: JunctionMovementVariant,
): Set<string> {
  const byId = new Map(graph.corridors.map((corridor) => [corridor.id, corridor]));
  const pending = [variant.incomingCorridorId];
  const visited = new Set<string>();
  const runtimeRsls = new Set(variant.runtimeLaneRsls);
  while (pending.length > 0) {
    const corridorId = pending.shift()!;
    if (visited.has(corridorId)) continue;
    visited.add(corridorId);
    const corridor = byId.get(corridorId);
    if (!corridor || corridor.authoringStatus !== "authorable") continue;
    for (const fragment of corridor.runtimeFragments) {
      runtimeRsls.add(fragment.rsl);
    }
    pending.push(...corridor.predecessorCorridorIds);
  }
  const outgoing = byId.get(variant.outgoingCorridorId);
  if (outgoing?.authoringStatus === "authorable") {
    for (const fragment of outgoing.runtimeFragments) {
      runtimeRsls.add(fragment.rsl);
    }
  }
  return runtimeRsls;
}

function runtimeChain(
  topology: MapTopologyIndex,
  variant: JunctionMovementVariant,
): SemanticRuntimeChain | null {
  const chain: SemanticRuntimeChain["chain"] = [];
  let priorEnd: Vec2 | null = null;
  const semanticStart = variant.polyline[0];
  for (const rsl of variant.runtimeLaneRsls) {
    const lane = topology.lanes[rsl];
    if (!lane || lane.polyline.length < 2) return null;
    const points = lane.polyline.map(({ x, y }) => ({ x, y }));
    const reference: Vec2 | undefined = priorEnd ?? semanticStart;
    if (!reference) return null;
    const oriented: Vec2[] = dist(points[0]!, reference) <= dist(points[points.length - 1]!, reference)
      ? points
      : [...points].reverse();
    chain.push({ rsl, oriented });
    priorEnd = oriented[oriented.length - 1]!;
  }
  return {
    chain,
    flat: variant.polyline.map(({ x, y }) => ({ x, y })),
  };
}

/** Semantic entities are the only authoring candidates; topology is consulted
 * here solely to recover the exact runtime lane chain selected by a variant. */
export function semanticMovementSelections(input: {
  graph: SemanticMapGraph;
  topology: MapTopologyIndex;
  junctionId?: string;
}): SemanticMovementSelection[] {
  const { graph, topology, junctionId } = input;
  if (graph.authority !== "runtime_verified") return [];
  const gates = new Map(topology.gates.map((gate) => [gate.id, gate]));
  const variants = new Map(graph.movementVariants.map((variant) => [variant.id, variant]));
  const approaches = new Map(graph.approaches.map((approach) => [approach.id, approach]));
  return graph.movements
    .filter(
      (movement) =>
        movement.authoringStatus === "authorable" &&
        !movement.turnRelation.startsWith("UTurn") &&
        (!junctionId || movement.junctionId === junctionId),
    )
    .flatMap((movement) => {
      const approach = approaches.get(movement.incomingApproachId);
      if (!approach || approach.authoringStatus !== "authorable") return [];
      return movement.variantIds.flatMap((variantId) => {
        const variant = variants.get(variantId);
        if (!variant || variant.authoringStatus !== "authorable") return [];
        const gate = gates.get(variant.gateId);
        const gateBuild = gate ? runtimeChain(topology, variant) : null;
        if (!gate || !gateBuild) return [];
        return [{
          movement,
          variant,
          approach,
          gate,
          gateBuild,
          approachHeadingRad: approach.headingRad,
        } satisfies SemanticMovementSelection];
      });
    })
    .sort((left, right) =>
      left.movement.id.localeCompare(right.movement.id) ||
      left.variant.id.localeCompare(right.variant.id));
}

function zoneSupportsVariants(
  zone: SemanticMapGraph["conflictZones"][number],
  leftVariantId: string,
  rightVariantId: string,
): boolean {
  return zone.encounters.some(
    (encounter) =>
      (encounter.leftVariantId === leftVariantId &&
        encounter.rightVariantId === rightVariantId) ||
      (encounter.leftVariantId === rightVariantId &&
        encounter.rightVariantId === leftVariantId),
  );
}

export function boundedCartesian<T>(choices: readonly T[][], limit = 512): T[][] {
  let rows: T[][] = [[]];
  for (const options of choices) {
    const next: T[][] = [];
    for (const row of rows) {
      for (const option of options) {
        next.push([...row, option]);
        if (next.length >= limit) break;
      }
      if (next.length >= limit) break;
    }
    rows = next;
  }
  return rows;
}

/** Resolve the authored conflict shared by the primary movement and every
 * other selected movement. Raw polyline intersection is deliberately absent. */
export function semanticConflictPoint(
  graph: SemanticMapGraph,
  selections: readonly SemanticMovementSelection[],
  maximumSpreadM: number,
): Vec2 | null {
  const primary = selections[0];
  if (!primary || selections.length < 2) return null;
  const zoneChoices = selections.slice(1).map((selection) =>
    graph.conflictZones
      .filter(
        (zone) =>
          zone.authoringStatus === "authorable" &&
          zone.movementIds.includes(primary.movement.id) &&
          zone.movementIds.includes(selection.movement.id) &&
          zoneSupportsVariants(zone, primary.variant.id, selection.variant.id),
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
  if (zoneChoices.some((choices) => choices.length === 0)) return null;
  let best: { spread: number; center: Vec2; key: string } | null = null;
  for (const zones of boundedCartesian(zoneChoices)) {
    const center = {
      x: zones.reduce((sum, zone) => sum + zone.center.x, 0) / zones.length,
      y: zones.reduce((sum, zone) => sum + zone.center.y, 0) / zones.length,
    };
    const spread = Math.max(...zones.map((zone) => dist(center, zone.center)));
    const key = zones.map((zone) => zone.id).join("|");
    if (
      spread <= maximumSpreadM &&
      (!best || spread < best.spread || (spread === best.spread && key < best.key))
    ) {
      best = { spread, center, key };
    }
  }
  return best?.center ?? null;
}

export function topologyCanReach(
  topology: MapTopologyIndex,
  fromRsl: string,
  targetRsl: string,
): boolean {
  const queue: Array<{ rsl: string; depth: number }> = [{ rsl: fromRsl, depth: 0 }];
  const seen = new Set([fromRsl]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.rsl === targetRsl) return true;
    if (current.depth >= 8) continue;
    for (const successor of topology.lanes[current.rsl]?.successors ?? []) {
      if (seen.has(successor)) continue;
      seen.add(successor);
      queue.push({ rsl: successor, depth: current.depth + 1 });
    }
  }
  return false;
}

export function nearestSemanticJunction(
  graph: SemanticMapGraph,
  target: Vec2,
): { junctionId: string; distance: number } | null {
  const authorableMovementIds = new Set(
    graph.movements
      .filter((movement) => movement.authoringStatus === "authorable")
      .map((movement) => movement.id),
  );
  const candidates = new Map<string, number>();
  for (const variant of graph.movementVariants) {
    if (
      variant.authoringStatus !== "authorable" ||
      !authorableMovementIds.has(variant.movementId)
    ) continue;
    const movement = graph.movements.find((row) => row.id === variant.movementId);
    const projected = projectOnPolyline(variant.polyline, target);
    if (!movement || !projected) continue;
    candidates.set(
      movement.junctionId,
      Math.min(candidates.get(movement.junctionId) ?? Number.POSITIVE_INFINITY, projected.distance),
    );
  }
  return [...candidates.entries()]
    .map(([junctionId, distance]) => ({ junctionId, distance }))
    .sort((left, right) =>
      left.distance - right.distance || left.junctionId.localeCompare(right.junctionId))[0] ?? null;
}
