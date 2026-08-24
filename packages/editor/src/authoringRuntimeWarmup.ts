import { LaneIndex } from './laneIndex';
import type { UniScenarioMapEntry } from './map';

type Warmup = {
  readonly promise: Promise<LaneIndex>;
  ready: boolean;
};

const warmups = new Map<string, Warmup>();
const simulationWarms = new Set<string>();

function assetRoot(map: UniScenarioMapEntry): string {
  const root = map.browserAssetRootUrl.replace(/\/+$/, '');
  if (map.browserManifestUrl !== `${root}/3d/manifest.json`) {
    throw new Error(`Map ${map.mapVersionId} has a browser manifest outside its declared asset root`);
  }
  return root;
}

/** Browser assets consumed by the scenario worker, excluding visual tiles. */
export function simulationRuntimeAssetUrls(map: UniScenarioMapEntry): readonly string[] {
  const root = assetRoot(map);
  return [
    `${root}/map.xodr`,
    `${root}/lane-polygons.geojson.gz`,
    `${root}/signals.geojson.gz`,
    `${root}/derived/topology-derived.json.gz`,
    `${root}/derived/locations.json.gz`,
    ...(map.sumoNetworkSha256 ? [`${root}/derived/sumo/sumo-network-manifest.json`] : []),
  ];
}

async function prefetch(url: string): Promise<void> {
  try {
    const response = await fetch(url, { priority: 'low' } as RequestInit);
    if (response.ok) await response.arrayBuffer();
  } catch {
    // Warming is best-effort. The real consumer owns error reporting.
  }
}

/** Begin loading the lane index, keyed by the immutable map version. */
export function warmAuthoringRuntime(map: UniScenarioMapEntry): Promise<LaneIndex> {
  const existing = warmups.get(map.mapVersionId);
  if (existing) return existing.promise;

  assetRoot(map);
  const promise = LaneIndex.load(map.topologyUrl).then((laneIndex) => {
    const record = warmups.get(map.mapVersionId);
    if (record) record.ready = true;
    return laneIndex;
  });
  promise.catch(() => warmups.delete(map.mapVersionId));
  warmups.set(map.mapVersionId, { promise, ready: false });
  return promise;
}

/** Whether a requested map's authoring lane index has finished loading. */
export function authoringRuntimeReady(mapVersionId: string | null | undefined): boolean {
  if (!mapVersionId) return true;
  const warmup = warmups.get(mapVersionId);
  return warmup ? warmup.ready : true;
}

/** Warm scenario-worker map assets after visual scene loading has completed. */
export function warmSimulationAssets(map: UniScenarioMapEntry): void {
  if (simulationWarms.has(map.mapVersionId)) return;
  const urls = simulationRuntimeAssetUrls(map);
  simulationWarms.add(map.mapVersionId);
  void Promise.all(urls.map(prefetch));
}

/** Clear module caches between deterministic tests. */
export function resetAuthoringRuntimeWarmupForTests(): void {
  warmups.clear();
  simulationWarms.clear();
}
