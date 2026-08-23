/**
 * Handles and the disambiguation ladder.
 *
 * The prior system conflated *name* with *identity*: 653 of its junctions share
 * the literal label "Junction with 3 approaches: T-yield, uncontrolled", which
 * makes every one of them unaddressable in conversation. A handle is the fix —
 * unique per map, typeable, and stable in the only way that matters (derived
 * from the same content the id is).
 *
 * The ladder, applied only to the records that actually collide:
 *
 * | rung | qualifier | example |
 * |---|---|---|
 * | 0 base | the stem itself | `junction/college-ave-at-yale-st` |
 * | 1 cross-street | another connected road | `...-at-oxford-ave` |
 * | 2 nearest address | the highest-leverage unused disambiguator | `...-near-550-oxford-ave` |
 * | 3 cardinal | octant from the colliding group's centre | `...-nw` |
 * | 4 content suffix | 5 hex of the record's identity key | `...-a3f91` |
 * | 5 ordinal | last resort, indexed by sorted id | `...-3-of-8` |
 *
 * Ordering is derived from sorted ids at every step, so permuting the input
 * order cannot change which record gets which handle.
 *
 * The content-suffix rung sits before the ordinal one deliberately. Ordinals
 * are stable *given a fixed record set*, but adding one parking bay renumbers
 * its neighbours; with 639 bays on one map that is a lot of silently-moving
 * references. The content suffix is derived from the same identity key as the
 * id, so it is invariant under insertion — the ordinal rung then only ever
 * fires for genuine identity-key collisions, which should be none.
 */

import { asHandle, type Handle } from '../types/ids.js';
import { bearingDegBetween, centroid, dist, type Point2 } from '../geometry/vec.js';
import type { BuildContext } from './context.js';
import type { LocationDraft } from './draft.js';
import { compass8, slugify } from './slug.js';
import { compareStrings } from './compare.js';

/** Ladder rungs, in application order. */
export const LADDER_RUNGS = [
  'base',
  'cross_street',
  'nearest_address',
  'cardinal',
  'content_suffix',
  'ordinal',
] as const;

/** A rung of {@link LADDER_RUNGS}. */
export type LadderRung = (typeof LADDER_RUNGS)[number];

/** Result of handle assignment. */
export interface HandleAssignment {
  handles: Map<string, Handle>;
  /** How many records needed each rung. `base` = no disambiguation needed. */
  ladderUsage: Record<string, number>;
  /** Records that required any rung beyond `base`. */
  collisionsResolved: number;
}

/** Assign a unique handle to every draft. */
export function assignHandles(ctx: BuildContext, drafts: readonly LocationDraft[]): HandleAssignment {
  const points = new Map<string, Point2>();
  for (const d of drafts) points.set(d.id as string, ctx.toLocal(d.anchor.geo.lng, d.anchor.geo.lat));

  const addressPoints = drafts
    .filter((d) => d.type === 'building_entrance' || d.type === 'address')
    .map((d) => ({
      slug: addressSlug(d),
      point: points.get(d.id as string) as Point2,
    }))
    .filter((a) => a.slug.length > 0 && a.point !== undefined)
    .sort((a, b) => compareStrings(a.slug, b.slug));

  const byId = new Map(drafts.map((d) => [d.id as string, d]));
  const bases = new Map<string, string>();
  for (const d of drafts) bases.set(d.id as string, baseHandle(d));

  const handles = new Map<string, Handle>();
  const taken = new Set<string>();
  const ladderUsage: Record<string, number> = Object.fromEntries(
    LADDER_RUNGS.map((r) => [r, 0]),
  );

  let pending = drafts.map((d) => d.id as string).sort();

  for (const rung of LADDER_RUNGS) {
    if (pending.length === 0) break;

    if (rung === 'ordinal') {
      // Terminal rung: guaranteed to produce a unique handle.
      const groups = groupBy(pending, (id) => bases.get(id) as string);
      for (const base of [...groups.keys()].sort()) {
        const ids = (groups.get(base) as string[]).slice().sort();
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i] as string;
          let candidate = `${base}-${i + 1}-of-${ids.length}`;
          let bump = 1;
          while (taken.has(candidate)) candidate = `${base}-${i + 1}-of-${ids.length}-${++bump}`;
          taken.add(candidate);
          handles.set(id, asHandle(candidate));
          ladderUsage[rung] = (ladderUsage[rung] ?? 0) + 1;
        }
      }
      pending = [];
      break;
    }

    const candidates = new Map<string, string[]>();
    for (const id of pending) {
      const draft = byId.get(id) as LocationDraft;
      const base = bases.get(id) as string;
      const candidate =
        rung === 'base'
          ? base
          : qualify(base, rung, draft, points, pending, byId, addressPoints);
      const bucket = candidates.get(candidate);
      if (bucket) bucket.push(id);
      else candidates.set(candidate, [id]);
    }

    const next: string[] = [];
    for (const candidate of [...candidates.keys()].sort()) {
      const ids = (candidates.get(candidate) as string[]).slice().sort();
      if (ids.length === 1 && !taken.has(candidate)) {
        const id = ids[0] as string;
        taken.add(candidate);
        handles.set(id, asHandle(candidate));
        ladderUsage[rung] = (ladderUsage[rung] ?? 0) + 1;
      } else {
        // Everyone in a colliding bucket advances together, and the qualifier
        // they just failed on becomes part of their base so the next rung
        // refines rather than replaces it.
        for (const id of ids) {
          if (rung !== 'base') bases.set(id, candidate);
          next.push(id);
        }
      }
    }
    pending = next.sort();
  }

  return {
    handles,
    ladderUsage,
    collisionsResolved: drafts.length - (ladderUsage['base'] ?? 0),
  };
}

function baseHandle(draft: LocationDraft): string {
  const stem = draft.naming.stems.find((s) => s.length > 0) ?? slugify(draft.type);
  const prefix = draft.type;
  return `${prefix}/${stem || slugify(draft.type)}`;
}

function qualify(
  base: string,
  rung: LadderRung,
  draft: LocationDraft,
  points: Map<string, Point2>,
  pending: readonly string[],
  byId: Map<string, LocationDraft>,
  addressPoints: readonly { slug: string; point: Point2 }[],
): string {
  const self = points.get(draft.id as string);
  switch (rung) {
    case 'cross_street': {
      const stem = base.slice(base.indexOf('/') + 1);
      const cross = draft.naming.roadNames
        .map((n) => slugify(n))
        .filter((n) => n.length > 0 && !stem.includes(n))
        .sort()[0];
      return cross ? `${base}-at-${cross}` : base;
    }
    case 'nearest_address': {
      if (!self || addressPoints.length === 0) return base;
      let best: { slug: string; d: number } | null = null;
      for (const a of addressPoints) {
        const d = dist(self, a.point);
        if (!best || d < best.d || (d === best.d && a.slug < best.slug)) best = { slug: a.slug, d };
      }
      return best && best.d <= 200 ? `${base}-near-${best.slug}` : base;
    }
    case 'cardinal': {
      if (!self) return base;
      const groupPoints = pending
        .map((id) => points.get(id))
        .filter((p): p is Point2 => p !== undefined);
      const centre = centroid(groupPoints);
      const bearing = bearingDegBetween(centre, self);
      void byId;
      return `${base}-${compass8(bearing)}`;
    }
    case 'content_suffix': {
      // Same input the id is derived from ⇒ invariant under insertion.
      return `${base}-${(draft.id as string).slice(4, 9)}`;
    }
    default:
      return base;
  }
}

function addressSlug(draft: LocationDraft): string {
  const number = draft.facts['address_number'];
  const street = draft.facts['street_name'] ?? draft.facts['road_name'];
  if (typeof number === 'string' && typeof street === 'string' && street) {
    return slugify(`${number}-${street}`);
  }
  const formatted = draft.facts['address_formatted'] ?? draft.name;
  return typeof formatted === 'string' ? slugify(formatted.split(',')[0] ?? formatted) : '';
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}
