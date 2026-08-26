/**
 * The editor's signalized-junction index (plan 2026-07-24, section 4.3).
 *
 * The intersection panel authors on MOVEMENTS, and `scenario-signals.ts` derives
 * movements from junction lane topology — but `MapTopologyIndex` is a
 * server-side artifact (lanes with sampled polylines for a whole map is tens of
 * megabytes, and nothing in the editor loads it). This module is the reduction:
 * per junction, only what the canvas and the panel need — a centre to draw a
 * glyph at, a radius, whether it is signalized, and the derived movement table
 * that a new plan caches verbatim.
 *
 * Pure and side-effect free: the route feeds it a topology index and the map's
 * control bindings, and the same functions run in tests without S3 or React.
 *
 * ## Coordinates
 *
 * Every point here is in RUNTIME-WORLD METERS, CARLA basis (+y south) — the
 * basis `TopologyLane.polyline` is sampled in, and the same basis the editor's
 * runtime traffic lights and actor spawn points use. Conversion to lng/lat
 * happens at the layer boundary, not here.
 */

import {
  attachSignalIdsToGates,
  deriveJunctionMovementTable,
  junctionGatesFromTopology,
  refineMovementSignalIds,
  type JunctionMovementBinding,
  type TopologyIndexLike,
  type XodrJunctionSignalGroup,
} from "@simforge-oss/studio-shared";

export const SIGNAL_JUNCTION_INDEX_SCHEMA_VERSION =
  "simforge.signal-junction-index.v1";

export type SignalJunctionPoint = { x: number; y: number };

export type SignalJunctionSummary = {
  junction_id: string;
  /** Centroid of the junction's internal lanes — where the glyph sits. */
  center: SignalJunctionPoint;
  /** Centre to the farthest internal lane point; the click/label footprint. */
  radius_m: number;
  /** A traffic-light control device governs at least one of its approaches. */
  signalized: boolean;
  /** The derived movement table, cached onto a plan on first open. */
  movements: JunctionMovementBinding[];
};

/**
 * How `signalized` was decided.
 *
 * `control_bindings` is exact: the map's compiled semantic execution index says
 * which lanes a traffic-light device governs. `topology_only` means the map has
 * no compiled semantic graph, so signalization is UNKNOWN — every junction
 * reports `signalized: false` and the client falls back to matching the runtime
 * traffic lights it already holds (`signalizedJunctionIdsFromLights`).
 */
export type SignalizationSource = "control_bindings" | "topology_only";

export type SignalJunctionIndex = {
  schema_version: typeof SIGNAL_JUNCTION_INDEX_SCHEMA_VERSION;
  map_asset_id: string;
  signalization_source: SignalizationSource;
  junctions: SignalJunctionSummary[];
};

/** The `controlBindings` slice of a `SemanticExecutionIndex`, kept structural. */
export interface ControlBindingLike {
  runtimeIds?: readonly string[];
  laneRsls?: readonly string[];
  kind?: string;
}

interface TopologyJunctionLike {
  junctionId?: string;
  internalLaneRsls?: readonly string[];
  approachLaneRsls?: readonly string[];
}

export interface SignalTopologyIndexLike extends TopologyIndexLike {
  junctions?: Record<string, TopologyJunctionLike>;
}

/** `"opendrive:123"` → `"123"`. Anything else is not a resolvable head. */
function openDriveSignalId(runtimeId: string): string | null {
  const trimmed = runtimeId.trim();
  const prefix = "opendrive:";
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  const id = trimmed.slice(prefix.length).trim();
  return id.length > 0 ? id : null;
}

/**
 * Lane rsl → the OpenDRIVE signal ids of the traffic-light devices governing it.
 *
 * Only `traffic_light` bindings participate: a stop or yield sign has no state
 * to command, and letting one bind to a movement would make the panel offer
 * colours for a piece of metal.
 */
export function trafficLightIdsByLane(
  bindings: readonly ControlBindingLike[],
): Map<string, string[]> {
  const byLane = new Map<string, Set<string>>();
  for (const binding of bindings) {
    if (binding.kind !== "traffic_light") continue;
    const signalIds = (binding.runtimeIds ?? [])
      .map((runtimeId) => openDriveSignalId(String(runtimeId)))
      .filter((id): id is string => id != null);
    if (signalIds.length === 0) continue;
    for (const rsl of binding.laneRsls ?? []) {
      const key = String(rsl).trim();
      if (!key) continue;
      const existing = byLane.get(key) ?? new Set<string>();
      for (const id of signalIds) existing.add(id);
      byLane.set(key, existing);
    }
  }
  return new Map(
    [...byLane].map(([rsl, ids]) => [rsl, [...ids].sort()] as const),
  );
}

function centroidOf(points: readonly SignalJunctionPoint[]): SignalJunctionPoint | null {
  let x = 0;
  let y = 0;
  let count = 0;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    x += point.x;
    y += point.y;
    count += 1;
  }
  return count === 0 ? null : { x: x / count, y: y / count };
}

/**
 * Junction footprint from the lanes that run THROUGH it.
 *
 * Internal (connecting) lanes span the junction box by construction, so their
 * sampled points are the tightest description of the junction the topology
 * carries. Approach lanes are the fallback for a junction whose internal lanes
 * failed to sample — their last point is the stop line, which still brackets
 * the box, just more loosely.
 */
function junctionFootprint(
  topology: SignalTopologyIndexLike,
  junction: TopologyJunctionLike,
): { center: SignalJunctionPoint; radius_m: number } | null {
  const lanes = topology.lanes ?? {};
  const internal = (junction.internalLaneRsls ?? []).flatMap(
    (rsl) => lanes[String(rsl)]?.polyline ?? [],
  );
  const points =
    internal.length > 0
      ? internal
      : (junction.approachLaneRsls ?? []).flatMap((rsl) => {
          const polyline = lanes[String(rsl)]?.polyline ?? [];
          const last = polyline[polyline.length - 1];
          return last ? [last] : [];
        });
  const center = centroidOf(points);
  if (!center) return null;
  const radius = points.reduce(
    (max, point) => Math.max(max, Math.hypot(point.x - center.x, point.y - center.y)),
    0,
  );
  return { center, radius_m: Math.round(radius * 100) / 100 };
}

/**
 * Reduce a map's topology to its authorable junctions.
 *
 * A junction with no derivable movements is dropped: `deriveJunctionMovements`
 * only keeps gates whose approach lane and turn relation both parse, and a
 * junction that survives none of them has nothing an author could point at.
 */
export function deriveSignalJunctionIndex(input: {
  mapAssetId: string;
  topology: SignalTopologyIndexLike;
  /** `null` when the map has no compiled semantic graph. */
  controlBindings: readonly ControlBindingLike[] | null;
  /**
   * XODR-derived signal groups per junction, when the map asset's XODR could be
   * identity-checked against the topology's own source. Empty is normal and
   * costs only per-movement head narrowing.
   */
  signalGroups?: ReadonlyMap<string, XodrJunctionSignalGroup>;
}): SignalJunctionIndex {
  const signalIdsByLane = input.controlBindings
    ? trafficLightIdsByLane(input.controlBindings)
    : new Map<string, string[]>();
  const junctions: SignalJunctionSummary[] = [];

  for (const junction of Object.values(input.topology.junctions ?? {})) {
    const junctionId = String(junction.junctionId ?? "").trim();
    if (!junctionId) continue;
    const group = input.signalGroups?.get(junctionId);
    // The derivation chain, in the order the XODR lane specified:
    // gates → attach approach-level heads → derive movements + conflicts →
    // narrow to per-movement heads. The semantic execution index seeds the
    // gates first, so a map whose XODR carries no `<signal>` still resolves
    // through `controlBindings`; `attachSignalIdsToGates` unions rather than
    // overwrites, so the two sources compose.
    // Deliberately un-annotated: `attachSignalIdsToGates` is generic over a type
    // with an index signature, which an `interface` (JunctionGateInput) cannot
    // satisfy but an inferred object-literal type can. Inference also carries
    // the gate's own fields through, so the result stays a valid gate list.
    const seeded = junctionGatesFromTopology(
      input.topology,
      junctionId,
    ).map((gate) => ({
      ...gate,
      signal_ids: signalIdsByLane.get(gate.approach_lane_rsl) ?? [],
    }));
    const gates = attachSignalIdsToGates(seeded, group);
    // `refineMovementSignalIds` only ever narrows or fills an empty set, and
    // matches on exact movement ids, so it is safe to append unconditionally.
    const movements = refineMovementSignalIds(
      deriveJunctionMovementTable(gates),
      group,
    );
    if (movements.length === 0) continue;
    const footprint = junctionFootprint(input.topology, junction);
    if (!footprint) continue;
    junctions.push({
      junction_id: junctionId,
      center: {
        x: Math.round(footprint.center.x * 1000) / 1000,
        y: Math.round(footprint.center.y * 1000) / 1000,
      },
      radius_m: footprint.radius_m,
      signalized: movements.some((movement) => movement.signal_ids.length > 0),
      movements,
    });
  }

  return {
    schema_version: SIGNAL_JUNCTION_INDEX_SCHEMA_VERSION,
    map_asset_id: input.mapAssetId,
    signalization_source: input.controlBindings ? "control_bindings" : "topology_only",
    junctions: junctions.sort((left, right) =>
      left.junction_id.localeCompare(right.junction_id, undefined, { numeric: true }),
    ),
  };
}

/** Which junction a clicked head belongs to, and everything it drives there. */
export type SignalHeadBinding = {
  junction_id: string;
  /** EVERY movement this head commands — the paintable unit, not one of them. */
  movement_ids: string[];
};

/**
 * OpenDRIVE `<signal>` id → the junction and movements that head drives.
 *
 * The resolver behind clicking a light. It differs from
 * `signalIdToMovementIndex` (`map-3d/signal-head-model.ts`) on the two points
 * that matter for a click, and both were defects in that one for this purpose:
 *
 * 1. **It reads the INDEX, not the plans.** The plan-based index only knows a
 *    head once a plan exists for its junction — and an unplanned junction is
 *    exactly the one an author is about to click. The index carries a movement
 *    table for every junction, planned or not, so a first click resolves.
 * 2. **It returns every movement, not the first.** A ball lens on a through
 *    approach commands through AND right; first-binding-wins picks one of them
 *    arbitrarily. The authoring unit is the conflict-free GROUP, and
 *    `deriveConflictFreeGroups(..., { unionSharedHeads: true })` fuses exactly
 *    the movements that share a head — so handing back the whole set is what
 *    makes a click land on one row by construction rather than by luck.
 *
 * Junction attribution is still first-binding-wins, matching
 * `junctionIdBySignalId`: an id claimed by two junctions is a map defect, and
 * choosing deterministically beats a light that changes junction between
 * renders. Movements from a second junction claiming the same head are dropped
 * rather than merged, because a group spanning two junctions is not paintable.
 */
export function movementsBySignalId(
  junctions: readonly SignalJunctionSummary[],
): Map<string, SignalHeadBinding> {
  const index = new Map<string, SignalHeadBinding>();
  for (const junction of junctions) {
    for (const movement of junction.movements ?? []) {
      for (const signalId of movement.signal_ids ?? []) {
        const key = String(signalId).trim();
        if (!key) continue;
        const existing = index.get(key);
        if (!existing) {
          index.set(key, {
            junction_id: junction.junction_id,
            movement_ids: [movement.movement_id],
          });
          continue;
        }
        if (existing.junction_id !== junction.junction_id) continue;
        if (!existing.movement_ids.includes(movement.movement_id)) {
          existing.movement_ids.push(movement.movement_id);
        }
      }
    }
  }
  for (const binding of index.values()) binding.movement_ids.sort();
  return index;
}

/**
 * Positional attribution for a map with no compiled semantic graph: which
 * junction each traffic light belongs to.
 *
 * The runtime bundle's traffic lights are ground truth — they are the actors the
 * worker will command — but the editor's slim shape carries only their pose, so
 * the match is geometric. A light is attributed to the nearest junction whose
 * footprint it falls inside, widened by `marginM` because a light stands at the
 * kerb, outside the box its lanes sweep.
 *
 * Each light lands in EXACTLY ONE junction. Six physical intersections on our
 * maps span two OpenDRIVE junction ids (the 2026-07-25 box probe), and letting
 * one of the pair swallow the other's lights would hide that rather than fix it
 * — merging them is a controller-level change this index does not attempt.
 */
export function attributeLightsToJunctions<T extends { x: number; y: number }>(
  junctions: readonly SignalJunctionSummary[],
  lights: readonly T[],
  marginM = 25,
): Map<string, T[]> {
  const byJunction = new Map<string, T[]>();
  for (const light of lights) {
    if (!Number.isFinite(light.x) || !Number.isFinite(light.y)) continue;
    let bestId: string | null = null;
    let bestSlack = Number.POSITIVE_INFINITY;
    for (const junction of junctions) {
      const distance = Math.hypot(
        light.x - junction.center.x,
        light.y - junction.center.y,
      );
      const slack = distance - (junction.radius_m + marginM);
      if (slack <= 0 && slack < bestSlack) {
        bestSlack = slack;
        bestId = junction.junction_id;
      }
    }
    if (!bestId) continue;
    const existing = byJunction.get(bestId);
    if (existing) existing.push(light);
    else byJunction.set(bestId, [light]);
  }
  return byJunction;
}

/**
 * A junction is signalized when CARLA has a traffic light standing in it — the
 * `Set` projection of {@link attributeLightsToJunctions}, kept because it is
 * what `withRuntimeSignalization` and the index route ask for.
 */
export function signalizedJunctionIdsFromLights(
  junctions: readonly SignalJunctionSummary[],
  lights: readonly { x: number; y: number }[],
  marginM = 25,
): Set<string> {
  return new Set(attributeLightsToJunctions(junctions, lights, marginM).keys());
}

/**
 * What a click on one physical head resolves to.
 *
 * `attribution` is how it was found, and it is reported rather than hidden
 * because the two tiers do not carry the same authority: `signal_id` is exact
 * (both sides are the same XODR's `<signal>` ids) and resolves 99–100% of heads
 * on every lit map; `footprint` is the 25 m geometric fallback and can only ever
 * name a junction, never a movement. A `footprint` hit therefore opens the
 * junction with NO lead row pinned, which is honest degradation — the author
 * still gets the intersection they clicked, they just have to pick the approach
 * themselves.
 */
export type ResolvedSignalHead = {
  junction_id: string;
  movement_ids: string[];
  attribution: "signal_id" | "footprint";
};

/**
 * Resolve a clicked head to its junction and the movements it drives.
 *
 * `bySignalId` is hoisted out rather than rebuilt per call because a click
 * handler runs on every pointer event and the index is a whole-map scan.
 */
export function resolveSignalHead(input: {
  bySignalId: ReadonlyMap<string, SignalHeadBinding>;
  junctions: readonly SignalJunctionSummary[];
  openDriveId: string | null | undefined;
  /** Runtime-frame position, for the geometric fallback. */
  point?: { x: number; y: number } | null;
  marginM?: number;
}): ResolvedSignalHead | null {
  const key = input.openDriveId != null ? String(input.openDriveId).trim() : "";
  const exact = key ? input.bySignalId.get(key) : undefined;
  if (exact) {
    return {
      junction_id: exact.junction_id,
      movement_ids: [...exact.movement_ids],
      attribution: "signal_id",
    };
  }
  if (!input.point) return null;
  const [junctionId] = attributeLightsToJunctions(
    input.junctions,
    [input.point],
    input.marginM ?? 25,
  ).keys();
  if (!junctionId) return null;
  return { junction_id: junctionId, movement_ids: [], attribution: "footprint" };
}

/** Apply the positional fallback, leaving an exactly-sourced index untouched. */
export function withRuntimeSignalization(
  index: SignalJunctionIndex,
  lights: readonly { x: number; y: number }[],
): SignalJunctionIndex {
  if (index.signalization_source === "control_bindings" || lights.length === 0) {
    return index;
  }
  const signalized = signalizedJunctionIdsFromLights(index.junctions, lights);
  if (signalized.size === 0) return index;
  return {
    ...index,
    junctions: index.junctions.map((junction) =>
      signalized.has(junction.junction_id)
        ? { ...junction, signalized: true }
        : junction,
    ),
  };
}
