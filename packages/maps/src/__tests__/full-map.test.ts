/**
 * End-to-end smoke over the *full* Yale Street map.
 *
 * Skipped automatically when `dev-assets/` (gitignored, multi-GB) is absent, so
 * CI and fresh clones stay green while local runs exercise the real 1144-lane /
 * 164-signal dataset and the 6 MB `.xodr`.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CoordinateFrame, type SceneManifestLike } from '../coordinate-frame.js';
import { decodeMaybeGzippedJson } from '../gzip.js';
import type { FeatureCollection } from '../geojson.js';
import { lanePolygonsFromGeoJson, type LanePolygonProperties } from '../lanes.js';
import { signalsFromGeoJson, type SignalProperties } from '../signals.js';
import { buildLaneOverlay, type LaneOverlayUserData } from '../overlays/lanes.js';
import { buildSignalOverlay, type SignalOverlayUserData } from '../overlays/signals.js';

const MAP = fileURLToPath(new URL('../../../../dev-assets/yale-street/', import.meta.url));
const available = existsSync(`${MAP}map.xodr`);

/** Read only a prefix, the way `fetchXodrHeader` Range-requests one. */
function readPrefix(path: string, bytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

describe.skipIf(!available)('full Yale Street map', () => {
  it('georeferences, loads and builds both overlays', async () => {
    const manifest = JSON.parse(readFileSync(`${MAP}3d/manifest.json`, 'utf8')) as SceneManifestLike;
    // 16 KB of a 6 MB file is enough to georeference the whole map.
    const frame = CoordinateFrame.fromMapAssets(readPrefix(`${MAP}map.xodr`, 16384), manifest);
    expect(frame.calibrationReport().contained).toBe(true);

    const laneJson = await decodeMaybeGzippedJson<FeatureCollection<LanePolygonProperties>>(
      new Uint8Array(readFileSync(`${MAP}lane-polygons.geojson.gz`)),
    );
    const lanes = lanePolygonsFromGeoJson(laneJson, frame);
    expect(lanes).toHaveLength(1144);

    const laneGroup = buildLaneOverlay(lanes, { defaultHeight: 12 });
    const laneData = laneGroup.userData as LaneOverlayUserData;
    expect(laneData.laneCount).toBe(1144);
    expect(laneData.triangleCount).toBeGreaterThan(50_000);
    // Sliver culling stays a rounding error, not a hole in the road.
    expect(laneData.degenerateTriangles / laneData.triangleCount).toBeLessThan(0.05);

    const mesh = laneGroup.getObjectByName('lane-surfaces') as unknown as {
      geometry: { attributes: { position: { array: Float32Array } }; boundingSphere: { radius: number } };
    };
    const pos = mesh.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i++) expect(Number.isFinite(pos[i] as number)).toBe(true);
    // The whole network fits in a ~360 m radius sphere, i.e. it is not scattered.
    expect(mesh.geometry.boundingSphere.radius).toBeLessThan(500);

    // Every lane sits inside the manifest scene box.
    const b = frame.sceneBounds!;
    for (const lane of lanes) {
      expect(lane.bounds.minX).toBeGreaterThanOrEqual(b.min[0] as number);
      expect(lane.bounds.maxX).toBeLessThanOrEqual(b.max[0] as number);
      expect(lane.bounds.minZ).toBeGreaterThanOrEqual(b.min[2] as number);
      expect(lane.bounds.maxZ).toBeLessThanOrEqual(b.max[2] as number);
    }

    const sigJson = await decodeMaybeGzippedJson<FeatureCollection<SignalProperties>>(
      new Uint8Array(readFileSync(`${MAP}signals.geojson.gz`)),
    );
    const signals = signalsFromGeoJson(sigJson, frame);
    expect(signals).toHaveLength(164);
    expect(signals.filter((s) => s.withinExtents)).toHaveLength(160);
    expect(signals.filter((s) => s.category === 'traffic_light')).toHaveLength(59);

    const sigGroup = buildSignalOverlay(signals, { heightSampler: () => 12 });
    const sigData = sigGroup.userData as SignalOverlayUserData;
    expect(sigData.signalCount).toBe(160);
    // The whole signal layer is a handful of draws, not one per feature.
    expect(sigData.drawCalls).toBeLessThan(15);
  }, 60_000);
});
