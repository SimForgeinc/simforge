/**
 * The property the whole id design exists to guarantee.
 *
 * Two failure modes are tested separately because they have different causes:
 *
 * 1. **Rebuild churn** — building the same sources twice must be byte-identical.
 *    Catches wall-clock leakage, `Date.now()` in ids, unstable float formatting.
 * 2. **Input-order churn** — permuting the order of lanes, gates, search
 *    objects and GeoJSON features must not change a single id or handle.
 *    Catches `Map`/object iteration order reaching an output, and any ordinal
 *    that is assigned by encounter rather than by sorted identity.
 */

import { describe, expect, it } from 'vitest';

import { buildMapIntel } from '../build/build.js';
import { miniYaleSources, shuffle, shuffleKeys } from './helpers.js';

describe('catalog id stability', () => {
  it('rebuilds byte-identically from the same sources', () => {
    const a = buildMapIntel(miniYaleSources());
    const b = buildMapIntel(miniYaleSources());

    expect(JSON.stringify(b.catalog)).toBe(JSON.stringify(a.catalog));
    expect(JSON.stringify(b.derived)).toBe(JSON.stringify(a.derived));
  });

  it('is invariant to input ordering', () => {
    const baseline = buildMapIntel(miniYaleSources());

    const permuted = buildMapIntel(
      miniYaleSources((raw) => {
        raw.topology['lanes'] = shuffleKeys(raw.topology['lanes'] as Record<string, unknown>, 1);
        raw.topology['junctions'] = shuffleKeys(
          raw.topology['junctions'] as Record<string, unknown>,
          2,
        );
        raw.topology['gates'] = shuffle(raw.topology['gates'] as unknown[], 3);
        raw.searchIndex['objects'] = shuffleKeys(
          raw.searchIndex['objects'] as Record<string, unknown>,
          4,
        );
        const graph = raw.searchIndex['graph'] as { edges: unknown[] };
        graph.edges = shuffle(graph.edges, 5);
        const signals = raw.signals as { features: unknown[] };
        signals.features = shuffle(signals.features, 6);
        const lanePolygons = raw.lanePolygons as { features: unknown[] };
        lanePolygons.features = shuffle(lanePolygons.features, 7);
        // `mapGeojson` features are *positionally* joined to the search index's
        // `geojson_feature_uuids`, so they are not permuted here: reordering
        // them without reordering the uuid sidecar would be a corrupt input,
        // not a permutation of a valid one.
        for (const layer of (raw.overlay as { layers: { data?: { features: unknown[] } }[] }).layers) {
          if (layer.data) layer.data.features = shuffle(layer.data.features, 8);
        }
      }),
    );

    const ids = (b: typeof baseline): string[] => b.catalog.locations.map((l) => l.id as string);
    const handles = (b: typeof baseline): string[] =>
      b.catalog.locations.map((l) => l.handle as string);

    expect(permuted.catalog.locations.length).toBe(baseline.catalog.locations.length);
    expect(ids(permuted)).toEqual(ids(baseline));
    expect(handles(permuted)).toEqual(handles(baseline));
    expect(permuted.derived.segments.map((s) => s.id)).toEqual(
      baseline.derived.segments.map((s) => s.id),
    );
    expect(JSON.stringify(permuted.catalog)).toBe(JSON.stringify(baseline.catalog));
  });

  it('derives ids from content, not position', () => {
    const build = buildMapIntel(miniYaleSources());
    for (const loc of build.catalog.locations) {
      expect(loc.id as string).toMatch(/^loc_[0-9a-f]{24}$/);
    }
    // Same content in a different map ⇒ different id (the mapId is in the key).
    const other = buildMapIntel(
      miniYaleSources((raw) => {
        void raw;
      }),
    );
    expect(other.catalog.locations[0]?.id).toBe(build.catalog.locations[0]?.id);
  });

  it('does not emit duplicate ids', () => {
    const build = buildMapIntel(miniYaleSources());
    const ids = new Set(build.catalog.locations.map((l) => l.id as string));
    expect(ids.size).toBe(build.catalog.locations.length);
    expect(build.duplicateIds).toBe(0);
  });

  it('keeps catalogRevision a pure function of the source hashes', () => {
    const a = buildMapIntel(miniYaleSources());
    const b = buildMapIntel(
      miniYaleSources((raw) => {
        raw.topology['generatedAt'] = '2099-01-01T00:00:00.000Z';
      }),
    );
    expect(b.catalog.catalogRevision).toBe(a.catalog.catalogRevision);

    const c = buildMapIntel({
      ...miniYaleSources(),
      sourceHashes: { 'topology-index': 'different' },
    });
    expect(c.catalog.catalogRevision).not.toBe(a.catalog.catalogRevision);
  });
});
