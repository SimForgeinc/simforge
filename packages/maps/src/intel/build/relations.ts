/**
 * Relations, with direction.
 *
 * The prior system's relation vocabulary was decorative: `upstream_of` was
 * emitted by the same code path as `connected_to` with no directional
 * information at all, so "the junction upstream of here" could not be answered.
 * Every edge here carries a real compass bearing and a distance, computed from
 * the two subjects' own anchors.
 *
 * Sources:
 *
 * - adopted search-index edges (`approaches`, `anchors_to`, `accesses`),
 * - `part_of` / `contains` for movements inside junctions and bays inside lots,
 * - `crosses` for crosswalks at junctions,
 * - `conflicts_with` between conflicting junction movements — the catalog-level
 *   projection of `conflictPairs`.
 */

import type { LocationId } from '../types/ids.js';
import type { LocationRelation, RelationKind } from '../types/location.js';
import type { JunctionDescriptor } from '../types/topology.js';
import { bearingDegBetween, dist, type Point2 } from '../geometry/vec.js';
import { round } from './anchor-lift.js';
import type { BuildContext } from './context.js';
import type { LocationDraft } from './draft.js';
import { compareStrings } from './compare.js';

const ADOPTED_RELATIONS: Record<string, RelationKind> = {
  approaches: 'approaches',
  anchors_to: 'anchors_to',
  accesses: 'accesses',
};

/** Build every relation edge for the map. */
export function buildRelations(
  ctx: BuildContext,
  drafts: readonly LocationDraft[],
  idBySourceObject: ReadonlyMap<string, string>,
  descriptors: readonly JunctionDescriptor[],
): LocationRelation[] {
  const points = new Map<string, Point2>();
  const byId = new Map<string, LocationDraft>();
  for (const d of drafts) {
    byId.set(d.id as string, d);
    points.set(d.id as string, ctx.toLocal(d.anchor.geo.lng, d.anchor.geo.lat));
  }

  const edges = new Map<string, LocationRelation>();
  const add = (from: string, to: string, kind: RelationKind): void => {
    if (from === to) return;
    const a = points.get(from);
    const b = points.get(to);
    if (!a || !b) return;
    const key = `${from}|${to}|${kind}`;
    if (edges.has(key)) return;
    edges.set(key, {
      from: from as LocationId,
      to: to as LocationId,
      kind,
      bearingDeg: round(bearingDegBetween(a, b), 1),
      distanceM: round(dist(a, b), 2),
    });
  };

  // --- adopted search-index edges ----------------------------------------
  for (const edge of ctx.sources.searchIndex?.graph.edges ?? []) {
    const kind = ADOPTED_RELATIONS[edge.relation];
    if (!kind) continue;
    const from = idBySourceObject.get(edge.from);
    const to = idBySourceObject.get(edge.to);
    if (!from || !to) continue;
    add(from, to, kind);
    if (edge.direction === 'both') add(to, from, kind);
  }

  // --- `anchor` back-references the search index records inline ----------
  for (const obj of Object.values(ctx.sources.searchIndex?.objects ?? {})) {
    if (!obj.anchor?.object_id) continue;
    const from = idBySourceObject.get(obj.id);
    const to = idBySourceObject.get(obj.anchor.object_id);
    if (from && to) add(from, to, 'anchors_to');
  }

  // --- movements are part of their junction -------------------------------
  const junctionLocationByJunctionId = new Map<string, string>();
  for (const d of descriptors) junctionLocationByJunctionId.set(d.junctionId as string, d.locationId as string);
  for (const d of drafts) {
    if (d.type !== 'junction_movement') continue;
    const junctionId = d.anchor.road?.junctionId as string | undefined;
    if (!junctionId) continue;
    const parent = junctionLocationByJunctionId.get(junctionId);
    if (!parent || !byId.has(parent)) continue;
    add(d.id as string, parent, 'part_of');
    add(parent, d.id as string, 'contains');
  }

  // --- conflicting movements ---------------------------------------------
  const movementByGate = new Map<string, string>();
  for (const d of drafts) {
    if (d.type !== 'junction_movement') continue;
    const gateId = d.anchor.road?.gateId as string | undefined;
    if (gateId) movementByGate.set(gateId, d.id as string);
  }
  for (const descriptor of descriptors) {
    for (const pair of descriptor.conflictPairs) {
      const a = movementByGate.get(pair.gateA as string);
      const b = movementByGate.get(pair.gateB as string);
      if (!a || !b) continue;
      add(a, b, 'conflicts_with');
      add(b, a, 'conflicts_with');
    }
  }

  // --- crosswalks cross their junction ------------------------------------
  for (const descriptor of descriptors) {
    for (const crossing of descriptor.crossingLocationIds) {
      if (!byId.has(crossing as string)) continue;
      add(crossing as string, descriptor.locationId as string, 'crosses');
    }
  }

  // --- parking bays sit inside parking areas / lanes ----------------------
  const containers = drafts.filter((d) => d.type === 'parking_area' || d.type === 'parking_lane');
  for (const bay of drafts) {
    if (bay.type !== 'parking_space') continue;
    const p = points.get(bay.id as string);
    if (!p) continue;
    let best: { id: string; d: number } | null = null;
    for (const container of containers) {
      const c = points.get(container.id as string);
      if (!c) continue;
      const radius = container.extent?.radiusM ?? 25;
      const d = dist(p, c);
      if (d > radius + 10) continue;
      if (!best || d < best.d) best = { id: container.id as string, d };
    }
    if (best) {
      add(bay.id as string, best.id, 'part_of');
      add(best.id, bay.id as string, 'contains');
    }
  }

  return [...edges.values()].sort(
    (a, b) =>
      compareStrings(a.from as string, b.from as string) ||
      compareStrings(a.kind as string, b.kind as string) ||
      compareStrings(a.to as string, b.to as string),
  );
}
