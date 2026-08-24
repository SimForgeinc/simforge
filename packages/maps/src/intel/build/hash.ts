/**
 * Content hashing. Everything identity-bearing in this package routes through
 * here, so the "rebuild ⇒ identical ids" property has exactly one implementation
 * to keep honest.
 */

import { createHash } from 'node:crypto';

/** Full sha256 hex of a string or buffer. */
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Content-derived location id.
 *
 * `identityKey` must be something the *source data* owns — an xodr junction id,
 * a RoadRunner GUID, an Overture id, `rsl@s`. Never an array index, never a
 * detector's enumeration order: positional ids renumber on any threshold tweak
 * and silently orphan every scenario bound to them.
 */
export function makeLocationIdString(mapId: string, type: string, identityKey: string): string {
  return `loc_${sha256(`${mapId}:${type}:${identityKey}`).slice(0, 24)}`;
}

/** Content-derived segment id. */
export function makeSegmentIdString(mapId: string, laneRefs: readonly string[]): string {
  // The chain is already ordered; hashing it directly means a chain rebuilt
  // from a different starting lane still lands on the same id.
  return `seg_${sha256(`${mapId}:segment:${laneRefs.join('|')}`).slice(0, 16)}`;
}

/** Stable JSON: object keys sorted recursively, so hashes do not depend on key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortValue(src[key]);
    return out;
  }
  return value;
}

/** Revision hash over a `{artifact → sha256}` map. */
export function revisionOf(sourceHashes: Record<string, string>): string {
  const parts = Object.keys(sourceHashes)
    .sort()
    .map((k) => `${k}=${sourceHashes[k]}`);
  return sha256(parts.join('\n')).slice(0, 32);
}
