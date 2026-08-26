import type { ScenarioMapEntry } from '@simforge-oss/editor';

export interface MapArtifactDigests {
  readonly xodrSha256: string;
  readonly topologySha256: string;
  readonly derivedTopologySha256: string;
  readonly locationsSha256: string;
  readonly signalsSha256: string;
  readonly lanePolygonsSha256: string;
}

/** Exact immutable map closure consumed by browser authoring and playback. */
export interface MapEntry {
  /** Database identity of the immutable Scenario map version. */
  readonly id: string;
  readonly mapVersionId: string;
  /** Timestamped upstream `public.map_assets.id`, never a display slug. */
  readonly sourceMapId: string;
  readonly label: string;
  readonly locality: string;
  readonly browserAssetRootUrl: string;
  readonly browserManifestUrl: string;
  readonly browserClosureSha256: string;
  readonly artifacts: MapArtifactDigests;
  readonly sumoNetworkSha256: string | null;
  /** Compatibility aliases consumed by the vendored studio runtime. */
  readonly manifest: string;
  readonly xodr: string;
  readonly lanePolygons: string;
  readonly signals: string;
  readonly topology: string;
  readonly derivedTopology: string;
  readonly locations: string;
  readonly sumoManifest: string | null;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Adapt SimCloud's database-backed descriptor without inferring roots from a manifest URL. */
export function playbackMapEntry(map: ScenarioMapEntry): MapEntry {
  const assetRoot = withoutTrailingSlash(map.browserAssetRootUrl);
  const expectedManifest = `${assetRoot}/3d/manifest.json`;
  if (map.browserManifestUrl !== expectedManifest) {
    throw new Error(`Map ${map.mapVersionId} has a browser manifest outside its declared asset root`);
  }
  if (map.id !== map.mapVersionId || map.versionId !== map.mapVersionId) {
    throw new Error(`Map ${map.mapVersionId} has inconsistent runtime identity`);
  }
  const assetUrl = (path: string) => `${assetRoot}/${path}`;
  return {
    id: map.mapVersionId,
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    label: map.label,
    locality: map.locality,
    browserAssetRootUrl: assetRoot,
    browserManifestUrl: map.browserManifestUrl,
    browserClosureSha256: map.browserClosureSha256,
    artifacts: map.artifacts,
    sumoNetworkSha256: map.sumoNetworkSha256,
    manifest: map.browserManifestUrl,
    xodr: assetUrl('map.xodr'),
    lanePolygons: assetUrl('lane-polygons.geojson.gz'),
    signals: assetUrl('signals.geojson.gz'),
    topology: assetUrl('topology-index.json.gz'),
    derivedTopology: assetUrl('derived/topology-derived.json.gz'),
    locations: assetUrl('derived/locations.json.gz'),
    sumoManifest: map.sumoNetworkSha256
      ? assetUrl('derived/sumo/sumo-network-manifest.json')
      : null,
  };
}
