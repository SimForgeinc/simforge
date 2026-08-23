/**
 * Deterministic row-ID helpers for the Overture addresses + buildings
 * tables. These run in both Lambda (Node) and browser bundles via the
 * shared barrel, so we deliberately avoid `node:crypto` and use FNV-1a
 * 32-bit run thrice with different seeds to produce a 24-hex-char digest.
 *
 * Hash strength is irrelevant here: the IDs aren't security-sensitive, and
 * the input `mapAssetId:overtureId` pair is already unique by construction.
 * FNV-1a is purely a length/format normalizer (matches the `_<24 hex>`
 * shape used by the Lambda's crypto-based `candidateLocationRowId`).
 */

function fnv1a32(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function digest24(input: string): string {
  return [
    fnv1a32(input, 0x811c9dc5),
    fnv1a32(input, 0x9e3779b1),
    fnv1a32(input, 0xa3b8e1c7),
  ]
    .map((n) => n.toString(16).padStart(8, "0"))
    .join("");
}

export function mapAssetAddressRowId(mapAssetId: string, overtureId: string): string {
  return `addr_${digest24(`${mapAssetId}:${overtureId}`)}`;
}

export function mapAssetBuildingRowId(mapAssetId: string, overtureId: string): string {
  return `bldg_${digest24(`${mapAssetId}:${overtureId}`)}`;
}
