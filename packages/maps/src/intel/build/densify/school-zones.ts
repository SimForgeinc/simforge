/**
 * Densification: school zones projected from MUTCD school signage.
 *
 * MUTCD series-S codes (`S1-1` school crossing, `S3-1` school bus stop ahead,
 * `S4-*P` speed-limit plaques, `S5-2` end-school-zone) are the only *legal*
 * evidence of a school zone in this data — the Overture `schools` layer tells
 * you a school building exists, not where the reduced-speed zone starts.
 *
 * **Data reality check:** only one of the five dev maps
 * (`easterbrook-discovery-school`, 15 S-series signs) actually has school
 * signage. The research doc reads as though this is a general derivation; it is
 * in practice map-specific, which is why the fact keys it produces are declared
 * `conditional`. On maps with a `school_frontage` in the search index but no
 * signs (Yale, El Camino Road) no school_zone is emitted — a frontage is not a
 * zone and pretending otherwise would fabricate a speed limit.
 *
 * Signs are grouped into zones by road and along-road proximity, then the zone
 * is projected onto the driving lanes of that road.
 */

import { asLocationId } from '../../types/ids.js';
import type { Affordance, FactValue, LocationType } from '../../types/location.js';
import { anchorFacts, liftAnchor } from '../anchor-lift.js';
import { type BuildContext, roadNameFor } from '../context.js';
import type { LocationDraft } from '../draft.js';
import { makeLocationIdString, sha256 } from '../hash.js';
import { centroid, dist, type Point2 } from '../../geometry/vec.js';
import { slugify } from '../slug.js';
import { compareStrings } from '../compare.js';

const TYPE: LocationType = 'school_zone';

/** MUTCD codes that establish a school zone. */
export const SCHOOL_ZONE_MUTCD = /^S(1-1|3-1|4-\d+P?|5-2|2-1)$/;

/** Signs within this distance of each other belong to the same zone. */
const CLUSTER_RADIUS_M = 160;

/** Half-length of the projected zone when only one sign is present. */
const SINGLE_SIGN_HALF_LENGTH_M = 90;

interface SchoolSign {
  id: string;
  code: string;
  point: Point2;
  roadId: string;
}

/** One draft per clustered school-signage group. */
export function densifySchoolZones(ctx: BuildContext): LocationDraft[] {
  const mapId = ctx.sources.mapId as string;
  const signs: SchoolSign[] = [];
  for (const f of ctx.sources.signals?.features ?? []) {
    const p = f.properties;
    const code = (p.mutcd_code ?? '').trim();
    const isSchool = SCHOOL_ZONE_MUTCD.test(code) || p.signal_category === 'school_sign';
    if (!isSchool) continue;
    const coords = f.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lng, lat] = coords as number[];
    if (typeof lng !== 'number' || typeof lat !== 'number') continue;
    signs.push({
      id: p.id ?? p.source_name ?? `${lng},${lat}`,
      code: code || 'S-UNCODED',
      point: ctx.toLocal(lng, lat),
      roadId: p.road_id ?? '',
    });
  }
  if (signs.length === 0) return [];

  // Deterministic single-link clustering: sorted input, sorted output.
  signs.sort((a, b) => compareStrings(a.id, b.id));
  const clusters = cluster(signs);

  const out: LocationDraft[] = [];
  for (const group of clusters) {
    const centre = centroid(group.map((s) => s.point));
    const lift = liftAnchor(ctx, centre, { laneTypes: ['driving'], maxDistanceM: 80 });
    const extentM =
      group.length === 1
        ? SINGLE_SIGN_HALF_LENGTH_M * 2
        : Math.max(
            ...group.flatMap((a) => group.map((b) => dist(a.point, b.point))),
            SINGLE_SIGN_HALF_LENGTH_M,
          );

    const codes = [...new Set(group.map((s) => s.code))].sort();
    const roadName = lift.anchor.road ? roadNameFor(ctx, lift.anchor.road.rsl as string) : '';

    const facts: Record<string, FactValue> = {
      school_sign_count: group.length,
      school_sign_codes: codes,
      zone_length_m: Math.round(extentM),
      speed_limit_kph: lift.anchor.road?.speedLimitKph ?? 0,
      road_name: roadName,
      ...anchorFacts(lift.anchor),
    };

    const affordances: Affordance[] = ['pedestrianSpawn', 'route'];
    if (lift.anchor.road?.laneType === 'driving') affordances.push('vehicleSpawn');

    // Identity is the sign set, not the cluster ordinal.
    const identityKey = `signs:${sha256(group.map((s) => s.id).sort().join(',')).slice(0, 16)}`;

    out.push({
      id: asLocationId(makeLocationIdString(mapId, TYPE, identityKey)),
      name: roadName ? `School zone on ${roadName}` : 'School zone',
      type: TYPE,
      tags: ['SCHOOL_ZONE', 'VRU_SENSITIVE'].sort(),
      anchor: lift.anchor,
      affordances: affordances.sort(),
      facts,
      provenance: group.map((s) => ({
        source: 'signals-geojson',
        ref: s.id,
        confidence: 0.95,
      })),
      quality: { anchor: lift.quality, confidence: 0.9 },
      naming: {
        stems: [slugify(roadName ? `${roadName}-school-zone` : 'school-zone')],
        roadNames: roadName ? [roadName] : [],
      },
      identityKey,
    });
  }
  return out;
}

function cluster(signs: readonly SchoolSign[]): SchoolSign[][] {
  const groups: SchoolSign[][] = [];
  const used = new Set<number>();
  for (let i = 0; i < signs.length; i++) {
    if (used.has(i)) continue;
    const group = [signs[i] as SchoolSign];
    used.add(i);
    // Breadth-first over the proximity graph, in index order for determinism.
    for (let cursor = 0; cursor < group.length; cursor++) {
      const seed = group[cursor] as SchoolSign;
      for (let j = 0; j < signs.length; j++) {
        if (used.has(j)) continue;
        const other = signs[j] as SchoolSign;
        if (dist(seed.point, other.point) > CLUSTER_RADIUS_M) continue;
        used.add(j);
        group.push(other);
      }
    }
    groups.push(group);
  }
  return groups;
}
