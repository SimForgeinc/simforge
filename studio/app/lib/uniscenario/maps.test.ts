import { describe, expect, it } from 'vitest';
import type { UniScenarioMapEntry } from '@simforge/editor';
import { playbackMapEntry } from './maps';

function descriptor(overrides: Partial<UniScenarioMapEntry> = {}): UniScenarioMapEntry {
  const root = '/api/uniscenario/maps/usmv_1/browser-assets';
  return {
    id: 'usmv_1', versionId: 'usmv_1', mapVersionId: 'usmv_1',
    sourceMapId: 'easterbrook-discovery-school_20260410-191436',
    label: 'Easterbrook', locality: 'San Jose, CA',
    browserAssetRootUrl: root, browserManifestUrl: `${root}/3d/manifest.json`,
    browserClosureSha256: 'a'.repeat(64),
    artifacts: {
      xodrSha256: '1'.repeat(64), topologySha256: '2'.repeat(64),
      derivedTopologySha256: '3'.repeat(64), locationsSha256: '4'.repeat(64),
      signalsSha256: '5'.repeat(64), lanePolygonsSha256: '6'.repeat(64),
    },
    sumoNetworkSha256: '7'.repeat(64),
    manifestUrl: `${root}/3d/manifest.json`, topologyUrl: `${root}/topology-index.json.gz`,
    ...overrides,
  };
}

describe('SimCloud playback map adapter', () => {
  it('resolves the complete runtime closure from the explicit browser root', () => {
    const map = playbackMapEntry(descriptor());
    expect(map).toMatchObject({
      id: 'usmv_1', mapVersionId: 'usmv_1',
      sourceMapId: 'easterbrook-discovery-school_20260410-191436',
      manifest: '/api/uniscenario/maps/usmv_1/browser-assets/3d/manifest.json',
      xodr: '/api/uniscenario/maps/usmv_1/browser-assets/map.xodr',
      topology: '/api/uniscenario/maps/usmv_1/browser-assets/topology-index.json.gz',
      derivedTopology: '/api/uniscenario/maps/usmv_1/browser-assets/derived/topology-derived.json.gz',
      locations: '/api/uniscenario/maps/usmv_1/browser-assets/derived/locations.json.gz',
      signals: '/api/uniscenario/maps/usmv_1/browser-assets/signals.geojson.gz',
      sumoManifest: '/api/uniscenario/maps/usmv_1/browser-assets/derived/sumo/sumo-network-manifest.json',
    });
    expect(map.id).not.toBe(map.sourceMapId);
  });

  it('rejects an inferred or mismatched manifest/root contract', () => {
    expect(() => playbackMapEntry(descriptor({
      browserManifestUrl: '/api/uniscenario/maps/usmv_1/browser-assets/manifest.json',
    }))).toThrow('browser manifest outside its declared asset root');
    expect(() => playbackMapEntry(descriptor({ id: 'source-slug' })))
      .toThrow('inconsistent runtime identity');
  });

  it('does not advertise SUMO without an authoritative network digest', () => {
    expect(playbackMapEntry(descriptor({ sumoNetworkSha256: null })).sumoManifest).toBeNull();
  });
});
