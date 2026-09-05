/** `simforge maps list` — what is on disk, and whether it is derived yet. */

import { availableMaps, artifactPresence, loadMap, DEV_ASSETS, type MapArtifactPresence } from '@simforge-oss/compiler/node';
import { emit, emitLines, pad } from '../output.js';
import { EXIT } from '../errors.js';

export interface MapsListOptions {
  readonly pretty: boolean;
}

export async function mapsList(options: MapsListOptions): Promise<number> {
  const maps: Array<Record<string, unknown>> = [];
  for (const mapId of availableMaps(DEV_ASSETS)) {
    const artifacts = artifactPresence(mapId, DEV_ASSETS);
    const entry: Record<string, unknown> = {
      mapId,
      present: true,
      artifacts,
      catalogRevision: null,
      matcherIndexDigest: null,
      engineGraphDigest: null,
      stats: null,
    };
    if (artifacts.derivedTopology && artifacts.locations) {
      const bundle = await loadMap(mapId, DEV_ASSETS);
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
    const a = m['artifacts'] as MapArtifactPresence;
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
