/**
 * `getLocation` and `describeLocation`.
 *
 * `describeLocation` produces the paragraph an agent reads *before* authoring
 * against a place. It deliberately states the road anchor in plain terms
 * ("lane 27:0:4, 18 m along") alongside the prose, because the alternative —
 * prose only — is what makes models invent road ids.
 */

import type { LocationCatalog, StudioLocation, LocationRelation } from '../types/location.js';
import { compassLong } from '../build/slug.js';
import { idIndex } from './find.js';
import { MapIntelQueryError } from './types.js';

/** Fetch by id or handle. Returns `undefined` when absent. */
export function getLocation(catalog: LocationCatalog, ref: string): StudioLocation | undefined {
  return idIndex(catalog).get(ref);
}

/** Fetch by id or handle, throwing a structured error when absent. */
export function requireLocation(catalog: LocationCatalog, ref: string): StudioLocation {
  const loc = getLocation(catalog, ref);
  if (!loc) {
    throw new MapIntelQueryError(
      'unknown_reference',
      'ref',
      `no location with id or handle ${JSON.stringify(ref)} on map ${catalog.mapId}`,
    );
  }
  return loc;
}

/** Options for {@link describeLocation}. */
export interface DescribeOptions {
  /** Include up to this many relations in the paragraph. Default 4. */
  maxRelations?: number;
}

/** A natural-language paragraph describing one location. */
export function describeLocation(
  catalog: LocationCatalog,
  ref: string,
  options: DescribeOptions = {},
): string {
  const loc = requireLocation(catalog, ref);
  const sentences: string[] = [];

  const typeWord = loc.type.replace(/_/g, ' ');
  sentences.push(`${loc.name} (${loc.handle}) is a ${typeWord}${loc.subtype ? ` of subtype ${loc.subtype}` : ''} on ${catalog.mapId}.`);

  if (loc.anchor.road) {
    const r = loc.anchor.road;
    const offset =
      Math.abs(r.offsetM) < 0.2
        ? 'on the lane centreline'
        : `${Math.abs(r.offsetM).toFixed(1)} m to the ${r.offsetM > 0 ? 'left' : 'right'} of the centreline`;
    sentences.push(
      `It anchors to ${r.laneType} lane ${r.rsl} at s=${r.s.toFixed(1)} m, ${offset}, heading ${
        loc.facts['anchor_heading_deg'] ?? '?'
      }°${r.speedLimitKph ? ` on a ${r.speedLimitKph} kph lane` : ''} (anchor quality: ${loc.quality.anchor}).`,
    );
  } else {
    sentences.push(
      'It has no road anchor, so it can be searched and described but not used as a placement target.',
    );
  }

  const factLine = describeFacts(loc);
  if (factLine) sentences.push(factLine);

  if (loc.affordances.length > 0) {
    sentences.push(`It supports ${listOf(loc.affordances)}.`);
  }
  if (loc.tags.length > 0) {
    sentences.push(`Tagged ${listOf(loc.tags)}.`);
  }

  const relations = relationsFrom(catalog, loc).slice(0, options.maxRelations ?? 4);
  if (relations.length > 0) {
    const byId = idIndex(catalog);
    const parts = relations.map((rel) => {
      const other = byId.get(rel.to as string);
      const name = other ? other.handle : rel.to;
      return `${rel.kind.replace(/_/g, ' ')} ${name}, ${Math.round(rel.distanceM)} m to the ${compassLong(rel.bearingDeg)}`;
    });
    sentences.push(`Related: ${parts.join('; ')}.`);
  }

  sentences.push(
    `Sources: ${loc.provenance.map((p) => `${p.source}(${p.ref})`).join(', ')}; confidence ${loc.quality.confidence}.`,
  );

  return sentences.join(' ');
}

/** Outgoing relations for a location, in catalog order. */
export function relationsFrom(catalog: LocationCatalog, loc: StudioLocation): LocationRelation[] {
  return catalog.relations.filter((r) => r.from === loc.id);
}

/** Incoming relations for a location. */
export function relationsTo(catalog: LocationCatalog, loc: StudioLocation): LocationRelation[] {
  return catalog.relations.filter((r) => r.to === loc.id);
}

const HIGHLIGHT_FACTS: readonly string[] = [
  'derived_control',
  'arm_count',
  'conflict_pair_count',
  'turn_relation',
  'is_protected',
  'lanes_same_dir',
  'lanes_opposing',
  'speed_limit_kph',
  'curvature_deg_per_10m',
  'has_parking_adjacent',
  'has_bike_adjacent',
  'has_sidewalk_adjacent',
  'distance_to_junction_m',
  'usable_length_m',
  'school_sign_count',
  'address_formatted',
  'road_name',
];

function describeFacts(loc: StudioLocation): string {
  const parts: string[] = [];
  for (const key of HIGHLIGHT_FACTS) {
    const value = loc.facts[key];
    if (value === undefined || value === '' ) continue;
    parts.push(`${key.replace(/_/g, ' ')} ${Array.isArray(value) ? value.join('/') : value}`);
  }
  return parts.length === 0 ? '' : `Key facts: ${parts.join(', ')}.`;
}

function listOf(values: readonly string[]): string {
  if (values.length === 1) return values[0] as string;
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}
