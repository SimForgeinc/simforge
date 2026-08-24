/**
 * Densification: building entrances from Overture address road-snaps.
 *
 * Every address in the enrichment overlay carries `road_access_lat/lng` — the
 * point on the drivable network the address was snapped to (326/326 coverage on
 * Yale). That snapped point *is* the pedestrian entrance in road terms: it is
 * where someone walking out of that building meets traffic.
 *
 * These are also the highest-leverage disambiguators in the whole catalog —
 * "the junction behind 550 Oxford Ave" is only expressible because the address
 * layer exists — so the handle ladder reads from these records.
 */

import { asLocationId } from '../../types/ids.js';
import type { Affordance, FactValue, LocationType } from '../../types/location.js';
import { anchorFacts, liftAnchor } from '../anchor-lift.js';
import { type BuildContext, roadNameFor } from '../context.js';
import type { LocationDraft } from '../draft.js';
import { makeLocationIdString } from '../hash.js';
import { slugify } from '../slug.js';
import { compareStrings } from '../compare.js';

const TYPE: LocationType = 'building_entrance';

/** Beyond this the snap is not describing an entrance any more. */
const MAX_ROAD_ACCESS_M = 120;

/** One draft per road-snapped address. */
export function densifyBuildingEntrances(ctx: BuildContext): LocationDraft[] {
  const mapId = ctx.sources.mapId as string;
  const layer = ctx.sources.overlay?.layers.find((l) => l.layer_id === 'addresses');
  const features = layer?.data?.features ?? [];
  const out: LocationDraft[] = [];

  const sorted = [...features].sort((a, b) =>
    compareStrings(String(a.properties.id ?? ''), String(b.properties.id ?? '')),
  );

  for (const f of sorted) {
    const p = f.properties;
    const addressId = p.id ?? p.overture_id;
    if (!addressId) continue;
    if (typeof p.road_access_lat !== 'number' || typeof p.road_access_lng !== 'number') continue;
    if ((p.road_access_distance_m ?? 0) > MAX_ROAD_ACCESS_M) continue;

    const local = ctx.toLocal(p.road_access_lng, p.road_access_lat);
    const lift = liftAnchor(ctx, local, { maxDistanceM: 60 });

    const roadName = p.road_access_road_name ?? p.street_name ?? (lift.anchor.road ? roadNameFor(ctx, lift.anchor.road.rsl as string) : '');
    const formatted = p.formatted ?? [p.number, p.street].filter(Boolean).join(' ');

    const facts: Record<string, FactValue> = {
      address_formatted: formatted,
      street_name: roadName ?? '',
      road_access_distance_m: Math.round((p.road_access_distance_m ?? 0) * 10) / 10,
      ...anchorFacts(lift.anchor),
    };
    if (p.building_id) facts['building_id'] = p.building_id;
    if (p.number) facts['address_number'] = p.number;
    if (p.postcode) facts['postcode'] = p.postcode;

    const affordances: Affordance[] = ['pedestrianSpawn'];
    if (lift.anchor.road?.laneType === 'sidewalk') affordances.push('route');

    const identityKey = `overture:${addressId}`;
    out.push({
      id: asLocationId(makeLocationIdString(mapId, TYPE, identityKey)),
      name: formatted ? `Entrance at ${formatted}` : 'Building entrance',
      type: TYPE,
      tags: ['BUILDING_ENTRANCE', 'PEDESTRIAN_ORIGIN'].sort(),
      anchor: lift.anchor,
      affordances: affordances.sort(),
      facts,
      provenance: [{ source: 'overlay-payload', ref: String(addressId), confidence: 0.9 }],
      quality: { anchor: lift.quality, confidence: 0.85 },
      naming: {
        stems: [slugify(p.number && roadName ? `${p.number}-${roadName}` : formatted || 'entrance')],
        roadNames: roadName ? [roadName] : [],
      },
      identityKey,
    });
  }
  return out;
}
