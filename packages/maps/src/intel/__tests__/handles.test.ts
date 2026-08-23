/**
 * Handle uniqueness and ladder behaviour.
 *
 * Uniqueness is checked on the fixture *and* — when the artifact tree is
 * present — on all five real maps, because handle collisions are a function of
 * how repetitive the real names are (639 parking bays on one street), not of
 * anything a small fixture exercises.
 */

import { describe, expect, it } from 'vitest';

import { buildMapIntel } from '../build/build.js';
import { buildMapIntelFromDir } from '../build/build.js';
import { LADDER_RUNGS } from '../build/handles.js';
import { compass8, slugify } from '../build/slug.js';
import { ALL_MAPS, DEV_ASSETS, devAssetsAvailable, miniYaleSources } from './helpers.js';
import path from 'node:path';

describe('handles', () => {
  const build = buildMapIntel(miniYaleSources());

  it('are unique across the map', () => {
    const handles = build.catalog.locations.map((l) => l.handle as string);
    expect(new Set(handles).size).toBe(handles.length);
  });

  it('are well-formed and typeable', () => {
    for (const loc of build.catalog.locations) {
      expect(loc.handle as string).toMatch(/^[a-z0-9_]+\/[a-z0-9][a-z0-9-]*$/);
      expect((loc.handle as string).split('/')[0]).toBe(loc.type);
    }
  });

  it('never reach the ordinal rung on real data', () => {
    // Ordinals renumber their neighbours on insertion; the content-suffix rung
    // exists so they should never be needed.
    expect(build.catalog.stats.handleLadderUsage['ordinal']).toBe(0);
  });

  it('accounts every location to exactly one ladder rung', () => {
    const usage = build.catalog.stats.handleLadderUsage;
    const total = LADDER_RUNGS.reduce((sum, rung) => sum + (usage[rung] ?? 0), 0);
    expect(total).toBe(build.catalog.locations.length);
  });

  it('separates display names from handles', () => {
    // Names are allowed to collide; handles are not. This is the exact defect
    // the prior system had (653 junctions sharing one label).
    const names = build.catalog.locations.map((l) => l.name);
    expect(new Set(names).size).toBeLessThan(names.length);
  });
});

describe('slugify', () => {
  it('abbreviates street types and normalises separators', () => {
    expect(slugify('West El Camino Real')).toBe('west-el-camino-real');
    expect(slugify('Oxford Avenue')).toBe('oxford-ave');
    expect(slugify('Cambridge Ave @ Yale Street')).toBe('cambridge-ave-at-yale-st');
    expect(slugify('  Grant  Boulevard!! ')).toBe('grant-blvd');
  });

  it('maps bearings onto eight compass points', () => {
    expect(compass8(0)).toBe('n');
    expect(compass8(90)).toBe('e');
    expect(compass8(181)).toBe('s');
    expect(compass8(359)).toBe('n');
  });
});

describe.skipIf(!devAssetsAvailable())('handles on every real map', () => {
  it.each(ALL_MAPS)('%s has unique handles', async (mapId) => {
    const built = await buildMapIntelFromDir(path.join(DEV_ASSETS, mapId));
    const handles = built.catalog.locations.map((l) => l.handle as string);
    expect(new Set(handles).size).toBe(handles.length);
    expect(built.catalog.stats.handleLadderUsage['ordinal']).toBe(0);
    expect(built.duplicateIds).toBe(0);
  });
});
