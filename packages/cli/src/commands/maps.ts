/** `uniscenarios maps list` — what is on disk, and whether it is derived yet. */

import { KNOWN_MAPS, artifactPresence, loadMap, mapDir, DEV_ASSETS } from '@simforge/compiler/node';
import { emit, emitLines, pad } from '../output.js';
import { EXIT } from '../errors.js';
import { existsSync } from 'node:fs';

export interface MapsListOptions {
  readonly pretty: boolean;
}

export async function mapsList(options: MapsListOptions): Promise<number> {
  const maps: Array<Record<string, unknown>> = [];
  for (const mapId of KNOWN_MAPS) {
    const present = existsSync(mapDir(mapId));
    const artifacts = artifactPresence(mapId);
    const entry: Record<string, unknown> = {
      mapId,
      present,
      artifacts,
      catalogRevision: null,
      matcherIndexDigest: null,
      engineGraphDigest: null,
      stats: null,
    };
    if (present && artifacts.derivedTopology && artifacts.locations) {
      const bundle = await loadMap(mapId);
      entry['catalogRevision'] = bundle.derived.catalogRevision;
      entry['matcherIndexDigest'] = bundle.index.topologyDigest;
      entry['engineGraphDigest'] = bundle.graph.topologyDigest;
      entry['stats'] = {
        locations: bundle.catalog.locations.length,
        segments: bundle.derived.segments.length,
        junctions: bundle.derived.junctions.length,
        conflictPairs: bundle.derived.stats.conflictPairCount,
        junctionsByControl: bundle.derived.stats.junctionsByControl,
        lanes: Object.keys(bundle.index.lanes).length,
        indexSource: bundle.index.provenance.source,
        capabilities: bundle.index.capabilities,
      };
    }
    maps.push(entry);
  }

  const payload = { devAssets: DEV_ASSETS, maps };
  if (!options.pretty) {
    emit(payload, options);
    return EXIT.ok;
  }

  const lines = [`dev-assets: ${DEV_ASSETS}`, ''];
  lines.push(
    `${pad('map', 30)}${pad('topo', 6)}${pad('derived', 9)}${pad('locs', 6)}${pad('catalogRevision', 34)}junctions/segments`,
  );
  for (const m of maps) {
    const a = m['artifacts'] as ReturnType<typeof artifactPresence>;
    const stats = m['stats'] as { junctions: number; segments: number } | null;
    lines.push(
      pad(String(m['mapId']), 30) +
        pad(a.topologyIndex ? 'yes' : 'no', 6) +
        pad(a.derivedTopology ? 'yes' : 'no', 9) +
        pad(a.locations ? 'yes' : 'no', 6) +
        pad(String(m['catalogRevision'] ?? '—'), 34) +
        (stats ? `${stats.junctions}/${stats.segments}` : '—'),
    );
  }
  emitLines(lines);
  return EXIT.ok;
}
