/**
 * The inverted index used for selectivity-ordered candidate generation.
 *
 * Deliberately boring: plain records of sorted id arrays. At ~700–4,000
 * locations and ~70 junctions per map a linear scan is already sub-millisecond,
 * so the index buys clause *ordering* (evaluate the rarest clause first), not
 * raw speed. A test asserts index and linear scan return byte-identical
 * results, which is the only thing that keeps a second query path honest.
 *
 * Numeric facts are indexed only when their cardinality is low enough to be
 * useful as an equality bucket; everything else is listed in
 * `unindexedFactKeys` so the query layer knows to scan rather than silently
 * returning nothing.
 */

import type { JunctionId, LocationId, SegmentId } from '../types/ids.js';
import type { FactValue, StudioLocation } from '../types/location.js';
import type { FactIndex, JunctionDescriptor, Segment } from '../types/topology.js';

/** Above this many distinct values a fact is not worth bucketing. */
export const MAX_INDEXED_CARDINALITY = 64;

/** Canonical string form of a fact value, for index keys and equality tests. */
export function factKeyOf(value: FactValue): string {
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

/** Build the inverted index. */
export function buildFactIndex(
  locations: readonly StudioLocation[],
  segments: readonly Segment[],
  junctions: readonly JunctionDescriptor[],
): FactIndex {
  const locationsByType: Record<string, LocationId[]> = {};
  const locationsBySubtype: Record<string, LocationId[]> = {};
  const locationsByTag: Record<string, LocationId[]> = {};
  const locationsByAffordance: Record<string, LocationId[]> = {};

  // Two passes over facts: gather cardinality, then index the survivors.
  const factValues = new Map<string, Map<string, LocationId[]>>();

  for (const loc of locations) {
    push(locationsByType, loc.type, loc.id);
    if (loc.subtype) push(locationsBySubtype, loc.subtype, loc.id);
    for (const tag of loc.tags) push(locationsByTag, tag, loc.id);
    for (const aff of loc.affordances) push(locationsByAffordance, aff, loc.id);
    for (const [key, value] of Object.entries(loc.facts)) {
      let bucket = factValues.get(key);
      if (!bucket) {
        bucket = new Map();
        factValues.set(key, bucket);
      }
      const vk = factKeyOf(value);
      const ids = bucket.get(vk);
      if (ids) ids.push(loc.id);
      else bucket.set(vk, [loc.id]);
    }
  }

  const locationsByFact: Record<string, Record<string, LocationId[]>> = {};
  const unindexedFactKeys: string[] = [];
  for (const key of [...factValues.keys()].sort()) {
    const bucket = factValues.get(key) as Map<string, LocationId[]>;
    if (bucket.size > MAX_INDEXED_CARDINALITY) {
      unindexedFactKeys.push(key);
      continue;
    }
    const record: Record<string, LocationId[]> = {};
    for (const vk of [...bucket.keys()].sort()) {
      record[vk] = (bucket.get(vk) as LocationId[]).slice().sort();
    }
    locationsByFact[key] = record;
  }

  const segmentsByLaneCount: Record<string, SegmentId[]> = {};
  const segmentsBySpeedLimitKph: Record<string, SegmentId[]> = {};
  const segmentByLaneRef: Record<string, SegmentId> = {};
  for (const seg of segments) {
    push(segmentsByLaneCount, String(seg.minLanesSameDir), seg.id);
    push(segmentsBySpeedLimitKph, String(seg.maxSpeedLimitKph), seg.id);
    for (const lane of seg.laneRefs) segmentByLaneRef[lane as string] = seg.id;
  }

  const junctionsByControl: Record<string, JunctionId[]> = {};
  const junctionsByArmCount: Record<string, JunctionId[]> = {};
  for (const j of junctions) {
    push(junctionsByControl, j.control, j.junctionId);
    push(junctionsByArmCount, String(j.armCount), j.junctionId);
  }

  return {
    locationsByType: sortRecord(locationsByType),
    locationsBySubtype: sortRecord(locationsBySubtype),
    locationsByTag: sortRecord(locationsByTag),
    locationsByAffordance: sortRecord(locationsByAffordance),
    locationsByFact,
    unindexedFactKeys,
    segmentsByLaneCount: sortRecord(segmentsByLaneCount),
    segmentsBySpeedLimitKph: sortRecord(segmentsBySpeedLimitKph),
    junctionsByControl: sortRecord(junctionsByControl),
    junctionsByArmCount: sortRecord(junctionsByArmCount),
    segmentByLaneRef: Object.fromEntries(Object.entries(segmentByLaneRef).sort()),
  };
}

function push<T extends string>(target: Record<string, T[]>, key: string, value: T): void {
  const bucket = target[key];
  if (bucket) bucket.push(value);
  else target[key] = [value];
}

function sortRecord<T extends string>(record: Record<string, T[]>): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = (record[key] as T[]).slice().sort();
  }
  return out;
}
