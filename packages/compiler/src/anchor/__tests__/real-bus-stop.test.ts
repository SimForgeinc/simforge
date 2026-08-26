/** Real-map bus-stop binding regressions.
 *
 * The important bit is that these tests deliberately remove adjacency data and
 * detach the bus-stop point feature from its source lane id. A passing match can
 * therefore only come from projecting the real feature world point onto the
 * candidate reference polyline, not from synthetic "adjacent lane" bookkeeping.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeMaybeGzippedJson } from '@simforge-oss/maps/opendrive';
import { describe, expect, it } from 'vitest';

import { matchAnchor } from '../matcher.js';
import { normalizeDerivedMapIndex } from '../normalize.js';
import { parseLogicalAnchor } from '../types/anchor.js';
import type { DerivedMapIndex } from '../types/map-index.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../..');

const maps = ['yale-st-palo-alto-ca', 'el-camino-rd-palo-alto-ca'] as const;

function haveMap(mapId: string): boolean {
  const dir = resolve(REPO_ROOT, 'dev-assets', mapId);
  return (
    existsSync(resolve(dir, 'topology-index.json.gz')) &&
    existsSync(resolve(dir, 'derived/topology-derived.json.gz')) &&
    existsSync(resolve(dir, 'derived/locations.json.gz'))
  );
}

async function loadIndex(mapId: string): Promise<DerivedMapIndex> {
  const dir = resolve(REPO_ROOT, 'dev-assets', mapId);
  const [topology, derived, locations] = await Promise.all([
    decodeMaybeGzippedJson<Record<string, unknown>>(readFileSync(resolve(dir, 'topology-index.json.gz'))),
    decodeMaybeGzippedJson<Record<string, unknown>>(readFileSync(resolve(dir, 'derived/topology-derived.json.gz'))),
    decodeMaybeGzippedJson<unknown>(readFileSync(resolve(dir, 'derived/locations.json.gz'))),
  ]);
  return normalizeDerivedMapIndex(derived, { mapId, topology: topology as never, locations });
}

function withoutAdjacency(index: DerivedMapIndex): DerivedMapIndex {
  return {
    ...index,
    lanes: Object.fromEntries(
      Object.entries(index.lanes).map(([rsl, lane]) => [
        rsl,
        {
          ...lane,
          adjacentLanes: {
            left: { laneRsl: null, sameDirection: false },
            right: { laneRsl: null, sameDirection: false },
          },
        },
      ]),
    ),
    pointFeatures: index.pointFeatures.map((feature) =>
      feature.kind === 'bus_stop' && feature.point
        ? { ...feature, laneRsl: `detached:${feature.id}`, s: 0 }
        : feature,
    ),
  };
}

function busStopAnchor(mapId: string) {
  return parseLogicalAnchor({
    id: `${mapId}-real-bus-stop-point`,
    corridor: {
      throughLanesSameDir: { value: [1, 4], essentiality: 'required' },
      curvatureDegPer10m: { value: [0, 10], essentiality: 'preferred' },
      runwayDownstreamM: { value: 30, essentiality: 'required' },
    },
    features: [
      {
        id: 'stop',
        kind: 'bus_stop',
        atM: { value: [-1000, 1000], essentiality: 'required' },
      },
    ],
    policy: { allowMirror: false, maxSitesPerMap: 20, diversity: 'none', minScore: 0.1 },
  });
}

describe('real bus-stop point matching without adjacency', () => {
  for (const mapId of maps) {
    it.skipIf(!haveMap(mapId))(`${mapId} binds a bus_stop from its real feature point`, async () => {
      const index = withoutAdjacency(await loadIndex(mapId));
      const busStopIds = new Set(index.pointFeatures.filter((p) => p.kind === 'bus_stop' && p.point).map((p) => p.id));
      expect(busStopIds.size).toBeGreaterThan(0);

      const [site] = matchAnchor(busStopAnchor(mapId), index, { maxFrames: 6000 });
      expect(site).toBeDefined();
      expect(busStopIds.has(site!.featureMatches.stop!.mapFeatureId)).toBe(true);
      expect(site!.clauses.find((c) => c.path === 'features.stop.atM')!.reason).toContain('projected');
    });
  }
});
