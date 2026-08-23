/**
 * The mirrored prop footprints must not drift from `prop-catalog`.
 *
 * `prop-dims.ts` copies a handful of numbers rather than importing the catalog,
 * because the catalog depends on three.js and this is a headless CLI. A copy
 * that nobody checks is a copy that goes wrong, and a wrong occluder footprint
 * silently changes the reveal-to-conflict metric — so the copy is checked here,
 * by reading the catalog *as text*.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROP_DIMS, propDims } from '../prop-dims.js';
import { REPO_ROOT } from '@uniscenarios/scenario-materializer';

const CATALOG = path.join(REPO_ROOT, 'packages', 'prop-catalog', 'src', 'catalog.ts');

describe.skipIf(!existsSync(CATALOG))('prop-dims mirrors prop-catalog', () => {
  it('agrees with every entry it claims to mirror', () => {
    const source = readFileSync(CATALOG, 'utf8');
    const entries = new Map<string, { l: number; w: number; h: number }>();
    const pattern =
      /id:\s*'([^']+)'[\s\S]{0,400}?dims:\s*\{\s*l:\s*([-\d.]+),\s*w:\s*([-\d.]+),\s*h:\s*([-\d.]+)\s*\}/g;
    for (const m of source.matchAll(pattern)) {
      entries.set(m[1] as string, {
        l: Number(m[2]),
        w: Number(m[3]),
        h: Number(m[4]),
      });
    }
    expect(entries.size).toBeGreaterThan(5);

    for (const [id, mirrored] of Object.entries(PROP_DIMS)) {
      const upstream = entries.get(id);
      expect(upstream, `${id} is no longer in the catalog`).toBeDefined();
      expect({ id, ...mirrored }).toEqual({ id, ...(upstream as object) });
    }
  });

  it('falls back by catalog-id family and honours an explicit override', () => {
    expect(propDims('vehicle.not_a_real_id').l).toBeCloseTo(4.7, 6);
    expect(propDims('barrier.jersey')).toEqual({ l: 1, w: 1, h: 1 });
    expect(propDims('vehicle.sedan', { h: 9 })).toEqual({ l: 4.7, w: 1.82, h: 9 });
  });
});
