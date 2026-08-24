/** Deterministic uniform-grid broadphase used by dense ambient simulations. */

export interface SpatialBounds {
  readonly id: string;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface SpatialPair {
  readonly a: string;
  readonly b: string;
}

/**
 * Return all pairs whose axis-aligned bounds share at least one grid cell.
 * False positives are intentional; narrow-phase geometry remains authoritative.
 * Inputs and output are sorted so actor declaration order cannot affect results.
 */
export function spatialCandidatePairs(
  rawItems: readonly SpatialBounds[],
  cellSizeM = 20,
): SpatialPair[] {
  if (!(cellSizeM > 0) || !Number.isFinite(cellSizeM)) {
    throw new Error(`cellSizeM must be finite and positive; received ${cellSizeM}`);
  }
  const items = [...rawItems].sort((a, b) => a.id.localeCompare(b.id));
  const cells = new Map<string, string[]>();
  for (const item of items) {
    if (![item.minX, item.minY, item.maxX, item.maxY].every(Number.isFinite)) continue;
    const x0 = Math.floor(Math.min(item.minX, item.maxX) / cellSizeM);
    const x1 = Math.floor(Math.max(item.minX, item.maxX) / cellSizeM);
    const y0 = Math.floor(Math.min(item.minY, item.maxY) / cellSizeM);
    const y1 = Math.floor(Math.max(item.minY, item.maxY) / cellSizeM);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x}:${y}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(item.id);
        else cells.set(key, [item.id]);
      }
    }
  }

  const pairKeys = new Set<string>();
  for (const cellKey of [...cells.keys()].sort()) {
    const ids = cells.get(cellKey)!;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        pairKeys.add(`${ids[i]!}\u0000${ids[j]!}`);
      }
    }
  }
  return [...pairKeys]
    .sort()
    .map((key) => {
      const split = key.indexOf('\u0000');
      return { a: key.slice(0, split), b: key.slice(split + 1) };
    });
}
