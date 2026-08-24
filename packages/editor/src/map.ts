/** Immutable map artifact closure consumed by Scenario authoring. */
export interface ScenarioMapEntry {
  /** Immutable published map-version identity used for editor selection. */
  readonly id: string;
  /** Immutable published map-version identity used by APIs and persistence. */
  readonly versionId: string;
  readonly mapVersionId: string;
  /** FK-backed timestamped upstream `public.map_assets.id`. */
  readonly sourceMapId: string;
  readonly label: string;
  readonly locality: string;
  readonly browserAssetRootUrl: string;
  readonly browserManifestUrl: string;
  readonly browserClosureSha256: string;
  readonly artifacts: {
    readonly xodrSha256: string;
    readonly topologySha256: string;
    readonly derivedTopologySha256: string;
    readonly locationsSha256: string;
    readonly signalsSha256: string;
    readonly lanePolygonsSha256: string;
  };
  readonly sumoNetworkSha256: string | null;
  /** Compatibility aliases retained for existing editor consumers. */
  readonly manifestUrl: string;
  readonly topologyUrl: string;
  readonly derivedTopologyUrl?: string | null;
  readonly locationsUrl?: string | null;
  readonly signalsUrl?: string | null;
  readonly sumoNetworkUrl?: string | null;
  readonly xodrArtifactId?: string;
  readonly coordinateSystemId?: string;
}

/**
 * Lightweight local-studio descriptor supported by the framework-neutral
 * editor. Immutable product catalogs should use {@link ScenarioMapEntry};
 * local assets derive both persisted identities from `id`.
 */
export interface LocalEditorMapEntry {
  readonly id: string;
  readonly label: string;
  readonly locality: string;
  readonly manifest: string;
  readonly xodr: string;
  readonly lanePolygons: string;
  readonly signals: string;
  readonly topology: string;
  readonly derivedTopology: string;
  readonly locations: string;
  readonly sumoManifest: string;
}

export type MapEntry = ScenarioMapEntry | LocalEditorMapEntry;

export function editorMapVersionId(map: MapEntry): string {
  return 'versionId' in map ? map.versionId : map.id;
}

export function editorSourceMapId(map: MapEntry): string {
  return 'sourceMapId' in map ? map.sourceMapId : map.id;
}

export const TEST_MAP: ScenarioMapEntry = {
  id: "test-map-v1",
  versionId: "test-map-v1",
  mapVersionId: "test-map-v1",
  sourceMapId: "test-map_19700101-000000",
  label: "Test map",
  locality: "Deterministic fixture",
  browserAssetRootUrl: "/fixtures/test-map",
  browserManifestUrl: "/fixtures/test-map/3d/manifest.json",
  browserClosureSha256: "0".repeat(64),
  artifacts: {
    xodrSha256: "1".repeat(64),
    topologySha256: "2".repeat(64),
    derivedTopologySha256: "3".repeat(64),
    locationsSha256: "4".repeat(64),
    signalsSha256: "5".repeat(64),
    lanePolygonsSha256: "6".repeat(64),
  },
  sumoNetworkSha256: null,
  manifestUrl: "/fixtures/test-map/3d/manifest.json",
  topologyUrl: "/fixtures/test-map/topology-index.json.gz",
};

export const MAPS: readonly ScenarioMapEntry[] = [TEST_MAP];
