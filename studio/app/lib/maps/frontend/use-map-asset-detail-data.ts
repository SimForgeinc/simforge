"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  MapAsset,
  MapAssetEnrichmentManifest,
  MapAssetEnrichmentSnapshot,
  MapOverlayLayerId,
  CandidateLocation,
} from "@simforge/studio-shared";
import type { MapBundleResponse } from "@/app/lib/scenario-editor/types";
import type { SelectedGeoJSONFeaturePayload } from "@/app/lib/maps/frontend/feature-inspection-types";
import { normalizeGeoJSONWithFeatureIds, buildFeatureIdIndex } from "@/app/lib/maps/frontend/geojson-utils";
import { useStreetFactsByFeatureId } from "@/app/lib/maps/frontend/use-street-facts-index";
import {
  buildSpeedLimitOverlayGeoJSON,
  buildXodrSpeedLimitOverlayGeoJSON,
  displayUnitForCountry,
  EMPTY_SPEED_LIMIT_OVERLAY,
  type GeoJsonFeatureCollection,
} from "@/app/lib/maps/frontend/speed-limit-overlay";
import {
  type UserGeoJsonLayer,
  defaultUserGeoJsonColor,
  DEFAULT_USER_GEOJSON_OPACITY,
  DEFAULT_USER_GEOJSON_THICKNESS,
  clampUserGeoJsonThickness,
} from "@/app/lib/maps/frontend/user-geojson-layers";
import { stampLanePolygonMapIds } from "@/app/lib/maps/frontend/lane-polygon-correlation";
import {
  type LaneRenderMode,
  loadLaneRenderMode,
  persistLaneRenderMode,
} from "@/app/lib/maps/frontend/lane-render-mode";
import {
  fetchGeoJSONArtifactWithCache,
  fetchGeoJSONWithCache,
} from "@/app/lib/maps/frontend/geojson-cache";
import {
  ALL_FEATURE_TYPE_IDS,
  DEFAULT_ENABLED_FEATURE_TYPE_IDS,
  computeFeatureTypeCounts,
  type RoadNetworkFeatureTypeId,
} from "@/app/lib/maps/frontend/road-network-feature-types";
import { DEFAULT_ENABLED_SIGNAL_CATEGORY_IDS } from "@/app/lib/maps/frontend/signal-overlay";
import { DEFAULT_ENABLED_OVERLAY_LAYER_IDS } from "@/app/components/map-assets-map/map-layer-constants";
import {
  fetchTwinFidelityScorecard,
  type TwinFidelityScorecard,
  type TwinFidelitySubLayerId,
} from "@/app/lib/maps/frontend/twin-fidelity-layers";
import {
  buildScenarioCandidateFamilyLayers,
  type ScenarioCandidateFamilyLayer,
} from "@/app/lib/maps/frontend/scenario-candidate-layers";

export interface MapDetailData {
  // GeoJSON
  selectedGeoJSON: object | null;
  geojsonLoading: boolean;
  geojsonHydrated: boolean;
  geojsonError: string | null;
  requestGeoJSON: () => void;

  // Enrichment
  selectedEnrichment: MapAssetEnrichmentSnapshot | null;
  enrichmentLoading: boolean;
  enrichmentHydrated: boolean;
  refreshEnrichment: () => void;
  /**
   * Monotonic counter bumped by `refreshEnrichment()`. Exposed so consumers
   * that hold their own server-derived state which also goes stale when
   * enrichment finishes (e.g. the search hook, whose results come from the
   * rebuilt `search_index.json` sidecar) can re-fetch in lockstep instead of
   * requiring a manual page reload.
   */
  enrichmentVersion: number;
  requestEnrichment: () => void;

  // Overlay layer toggles
  enabledOverlayLayerIds: MapOverlayLayerId[];
  toggleOverlayLayer: (layerId: MapOverlayLayerId) => void;
  setEnabledOverlayLayerIds: (layerIds: MapOverlayLayerId[]) => void;

  // Feature type toggles
  enabledFeatureTypeIds: RoadNetworkFeatureTypeId[];
  featureTypeCounts: Record<RoadNetworkFeatureTypeId, number> | null;
  toggleFeatureType: (id: RoadNetworkFeatureTypeId) => void;
  toggleAllFeatureTypes: () => void;

  // Candidate locations
  candidateLocations: CandidateLocation[];
  candidateLocationsLoading: boolean;
  candidateLocationsHydrated: boolean;
  selectedCandidateLocationId: string | null;
  setSelectedCandidateLocationId: (id: string | null) => void;
  requestCandidateLocations: () => void;

  // Scenario-candidate family layers (one toggleable map layer per family)
  candidateFamilyLayers: ScenarioCandidateFamilyLayer[];
  enabledCandidateFamilyIds: string[];
  twinFidelityScorecard: TwinFidelityScorecard | null;
  enabledTwinFidelityLayerIds: TwinFidelitySubLayerId[];
  toggleTwinFidelityLayer: (id: TwinFidelitySubLayerId) => void;
  twinFidelityRes: number;
  setTwinFidelityRes: (res: number) => void;
  requestTwinFidelity: () => void;
  /** Whether the Overture speed-limit lane labels are shown (off by default). */
  speedLimitsEnabled: boolean;
  toggleSpeedLimits: () => void;
  /** Joined line features carrying `speed_limit_mph` for the label layer. */
  speedLimitOverlayGeoJSON: GeoJsonFeatureCollection;
  /** Number of driving lanes with a posted Overture limit (0 until enabled). */
  speedLimitCount: number;
  /** Whether the in-house (XODR) speed-limit lane labels are shown (off by default). */
  inHouseSpeedLimitsEnabled: boolean;
  toggleInHouseSpeedLimits: () => void;
  /** Line features carrying the XODR `speed_limit_mph` for the label layer. */
  inHouseSpeedLimitOverlayGeoJSON: GeoJsonFeatureCollection;
  /** Number of driving lanes with an XODR speed limit (0 until enabled). */
  inHouseSpeedLimitCount: number;
  toggleCandidateFamily: (familyId: string) => void;
  setEnabledCandidateFamilyIds: (ids: string[]) => void;

  // Selected features (from map click)
  selectedFeatures: SelectedGeoJSONFeaturePayload[];
  setSelectedFeatures: (features: SelectedGeoJSONFeaturePayload[]) => void;
  selectedFeatureId: number | null;
  setSelectedFeatureId: (id: number | null) => void;
  selectedOverlayCoords: [number, number] | null;
  selectedOverlayGeometry: Record<string, unknown> | null;

  // Signal overlay
  signalOverlayGeoJSON: object | null;
  enabledSignalCategories: Set<string>;
  signalOverlayLoading: boolean;
  signalOverlayHydrated: boolean;
  signalOverlayError: string | null;
  toggleSignalCategory: (cat: string) => void;
  toggleAllSignalCategories: () => void;
  requestSignalOverlay: () => void;

  // Lane-polygon overlay (filled lane areas reconstructed from XODR widths)
  lanePolygonsGeoJSON: object | null;
  lanePolygonsLoading: boolean;
  lanePolygonsHydrated: boolean;
  lanePolygonsError: string | null;
  laneRenderMode: LaneRenderMode;
  setLaneRenderMode: (mode: LaneRenderMode) => void;
  requestLanePolygons: () => void;

  // Feature ID index (GUID → __mapId lookup)
  guidToMapId: Map<string, number>;
  knownGuids: Set<string>;

  // User-uploaded GeoJSON overlays (session-only, in-memory)
  userGeoJsonLayers: UserGeoJsonLayer[];
  addUserGeoJsonLayer: (name: string, data: object, featureCount: number) => void;
  removeUserGeoJsonLayer: (id: string) => void;
  toggleUserGeoJsonLayer: (id: string) => void;
  setUserGeoJsonLayerColor: (id: string, color: string) => void;
  setUserGeoJsonLayerOpacity: (id: string, opacity: number) => void;
  setUserGeoJsonLayerThickness: (id: string, thickness: number) => void;
}

export type PreloadedMapAssetDetailData = Pick<
  MapBundleResponse,
  "enrichment" | "candidate_locations" | "signals_geojson" | "geojson_url"
>;

export type MapAssetDetailLoadOptions = {
  /** Map detail remains eager. The semantic editor opts out and requests
   * legacy/context sidecars only when an operator enables their layer. */
  eagerNonSemanticLayers?: boolean;
  loadGeoJSON?: boolean;
  loadLanePolygons?: boolean;
};

/**
 * Fetch the enrichment manifest from the API, then fetch the two heavy
 * payloads (overlay GeoJSON + candidate locations) from S3 in parallel and
 * reassemble a `MapAssetEnrichmentSnapshot`. The two-step indirection exists
 * to keep the Aurora-backed API response well under the Data API's 1 MB cap
 * — the actual feature data is offloaded to S3 and the client fetches it
 * directly via presigned URLs.
 */
/**
 * StrictMode / concurrent-mount dedupe: the effect that calls this can run
 * twice back-to-back in development, and both invocations would otherwise
 * re-fetch the manifest plus two multi-hundred-KB payloads.
 */
const enrichmentSnapshotInFlight = new Map<
  string,
  Promise<MapAssetEnrichmentSnapshot>
>();

async function fetchEnrichmentSnapshot(
  mapAssetId: string,
): Promise<MapAssetEnrichmentSnapshot> {
  const running = enrichmentSnapshotInFlight.get(mapAssetId);
  if (running) return running;
  const request = (async () => {
    const manifestRes = await fetch(`/api/map-assets/${mapAssetId}/enrichment`);
    if (!manifestRes.ok) throw new Error(`enrichment manifest ${manifestRes.status}`);
    const manifest = (await manifestRes.json()) as MapAssetEnrichmentManifest;

    // The heavy payloads live on S3 behind volatile presigned URLs, so the
    // browser HTTP cache can never reuse them. Route them through the
    // two-tier GeoJSON cache keyed on `computed_at` — a re-enrichment stamps
    // a new timestamp, which flips the cache key and forces a clean miss.
    const [overlay_payload, candidate_locations] = await Promise.all([
      fetchGeoJSONArtifactWithCache(mapAssetId, {
        kind: "enrichment-overlay",
        geojsonSha256: manifest.computed_at,
        directUrl: manifest.overlay_payload_url,
      }) as Promise<MapAssetEnrichmentSnapshot["overlay_payload"]>,
      fetchGeoJSONArtifactWithCache(mapAssetId, {
        kind: "enrichment-candidates",
        geojsonSha256: manifest.computed_at,
        directUrl: manifest.candidate_locations_url,
      }) as Promise<MapAssetEnrichmentSnapshot["candidate_locations"]>,
    ]);

    return {
      map_asset_id: manifest.map_asset_id,
      provider: manifest.provider,
      provider_release: manifest.provider_release,
      computed_at: manifest.computed_at,
      summary: manifest.summary,
      overlay_payload,
      candidate_locations,
      warnings: manifest.warnings,
    };
  })();
  enrichmentSnapshotInFlight.set(mapAssetId, request);
  try {
    return await request;
  } finally {
    enrichmentSnapshotInFlight.delete(mapAssetId);
  }
}

/**
 * Same StrictMode dedupe as the snapshot above — this ~300 KB response was
 * measured downloading twice per page open in development.
 */
const candidateLocationsInFlight = new Map<
  string,
  Promise<{ locations: CandidateLocation[] }>
>();

function fetchCandidateLocationsDeduped(
  mapAssetId: string,
): Promise<{ locations: CandidateLocation[] }> {
  const running = candidateLocationsInFlight.get(mapAssetId);
  if (running) return running;
  const request = fetch(`/api/map-assets/${mapAssetId}/candidate-locations`)
    .then(async (r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json() as Promise<{ locations: CandidateLocation[] }>;
    })
    .finally(() => {
      candidateLocationsInFlight.delete(mapAssetId);
    });
  candidateLocationsInFlight.set(mapAssetId, request);
  return request;
}

function formatFetchError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

/**
 * Custom hook extracting all map detail data-fetching and state management
 * from the original MapAssetsPageClient. Used by MapDetailPageClient.
 */
export function useMapAssetDetailData(
  asset: MapAsset,
  preloaded?: PreloadedMapAssetDetailData | null,
  options: MapAssetDetailLoadOptions = {},
): MapDetailData {
  const eagerNonSemanticLayers = options.eagerNonSemanticLayers ?? true;
  const coreLanePolygonsRequested =
    eagerNonSemanticLayers || options.loadLanePolygons === true;
  const [geoJSONRequested, setGeoJSONRequested] = useState(
    eagerNonSemanticLayers || options.loadGeoJSON === true,
  );
  const [enrichmentRequested, setEnrichmentRequested] = useState(
    eagerNonSemanticLayers,
  );
  const [candidateLocationsRequested, setCandidateLocationsRequested] =
    useState(eagerNonSemanticLayers);
  const [signalOverlayRequested, setSignalOverlayRequested] = useState(
    eagerNonSemanticLayers,
  );
  const [lanePolygonsRequested, setLanePolygonsRequested] = useState(
    coreLanePolygonsRequested,
  );
  const [twinFidelityRequested, setTwinFidelityRequested] = useState(
    eagerNonSemanticLayers,
  );
  const mapAssetId = asset.map_asset_id;
  const geojsonArtifact = asset.artifacts.find(
    (artifact) => artifact.artifact_type === "geojson",
  );
  const preloadedGeojsonUrl = preloaded?.geojson_url ?? null;
  const hasGeoJsonArtifact = geojsonArtifact != null || Boolean(preloadedGeojsonUrl);
  // Threading the artifact's sha256 into the cache key invalidates persisted
  // cache entries whenever the underlying S3 bytes change. Without this,
  // any operator-driven re-upload silently serves stale GeoJSON to clients
  // that already cached the prior version.
  const geojsonSha256 = geojsonArtifact?.sha256 ?? null;
  const signalOverlayArtifact = asset.artifacts.find(
    (artifact) => artifact.artifact_type === "signals_geojson",
  );
  const hasSignalOverlayArtifact = signalOverlayArtifact != null;
  const signalOverlaySha256 = signalOverlayArtifact?.sha256 ?? null;
  const lanePolygonsArtifact = asset.artifacts.find(
    (artifact) => artifact.artifact_type === "lane_polygons_geojson",
  );
  const hasLanePolygonsArtifact = lanePolygonsArtifact != null;
  const lanePolygonsSha256 = lanePolygonsArtifact?.sha256 ?? null;

  useEffect(() => {
    setGeoJSONRequested(eagerNonSemanticLayers || options.loadGeoJSON === true);
    setEnrichmentRequested(eagerNonSemanticLayers);
    setCandidateLocationsRequested(eagerNonSemanticLayers);
    setSignalOverlayRequested(eagerNonSemanticLayers);
    setLanePolygonsRequested(coreLanePolygonsRequested);
    setTwinFidelityRequested(eagerNonSemanticLayers);
  }, [coreLanePolygonsRequested, eagerNonSemanticLayers, mapAssetId, options.loadGeoJSON]);

  // --- GeoJSON ---
  const [selectedGeoJSON, setSelectedGeoJSON] = useState<object | null>(null);
  const [geojsonLoading, setGeojsonLoading] = useState(false);
  const [geojsonHydrated, setGeojsonHydrated] = useState(false);
  const [geojsonError, setGeojsonError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapAssetId || !geoJSONRequested) {
      setSelectedGeoJSON(null);
      setGeojsonLoading(false);
      setGeojsonHydrated(true);
      setGeojsonError(null);
      return;
    }
    if (!hasGeoJsonArtifact) {
      setSelectedGeoJSON(null);
      setGeojsonLoading(false);
      setGeojsonHydrated(true);
      setGeojsonError(null);
      return;
    }

    const controller = new AbortController();
    setSelectedGeoJSON(null);
    setGeojsonLoading(true);
    setGeojsonHydrated(false);
    setGeojsonError(null);

    fetchGeoJSONWithCache(mapAssetId, geojsonSha256, controller.signal, preloadedGeojsonUrl)
      .then((data) => {
        if (!controller.signal.aborted) {
          setSelectedGeoJSON(normalizeGeoJSONWithFeatureIds(data));
          setGeojsonError(null);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setSelectedGeoJSON(null);
          setGeojsonError(formatFetchError(error, "GeoJSON fetch failed"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setGeojsonLoading(false);
          setGeojsonHydrated(true);
        }
      });

    return () => {
      controller.abort();
    };
  }, [geoJSONRequested, hasGeoJsonArtifact, mapAssetId, geojsonSha256, preloadedGeojsonUrl]);

  // --- Enrichment ---
  const [selectedEnrichment, setSelectedEnrichment] =
    useState<MapAssetEnrichmentSnapshot | null>(null);
  const [enrichmentLoading, setEnrichmentLoading] = useState(false);
  const [enrichmentHydrated, setEnrichmentHydrated] = useState(false);
  const [enrichmentVersion, setEnrichmentVersion] = useState(0);

  useEffect(() => {
    if (!mapAssetId || !enrichmentRequested) {
      setSelectedEnrichment(null);
      setEnrichmentLoading(false);
      setEnrichmentHydrated(true);
      return;
    }
    if (preloaded) {
      setSelectedEnrichment(preloaded.enrichment);
      setEnrichmentLoading(false);
      setEnrichmentHydrated(true);
      return;
    }
    let cancelled = false;
    setSelectedEnrichment(null);
    setEnrichmentLoading(true);
    setEnrichmentHydrated(false);

    fetchEnrichmentSnapshot(mapAssetId)
      .then((snapshot) => {
        if (!cancelled) {
          setSelectedEnrichment(snapshot);
        }
      })
      .catch(() => {
        if (!cancelled) setSelectedEnrichment(null);
      })
      .finally(() => {
        if (!cancelled) {
          setEnrichmentLoading(false);
          setEnrichmentHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enrichmentRequested, mapAssetId, enrichmentVersion, preloaded]);

  function refreshEnrichment() {
    setEnrichmentRequested(true);
    setEnrichmentVersion((v) => v + 1);
  }

  // --- Overlay layers ---
  const [enabledOverlayLayerIds, setEnabledOverlayLayerIds] = useState<MapOverlayLayerId[]>([]);

  function toggleOverlayLayer(layerId: MapOverlayLayerId) {
    setEnrichmentRequested(true);
    setEnabledOverlayLayerIds((current) =>
      current.includes(layerId)
        ? current.filter((existing) => existing !== layerId)
        : [...current, layerId],
    );
  }

  // Auto-enable the addresses overlay the first time enrichment lands for a
  // given asset that actually has address data. The processed-set is keyed
  // by asset id so revisiting an asset later in the session (A → B → A)
  // doesn't clobber a user-driven off-toggle, and we only mark an asset as
  // processed once we've actually seen address features — that way an early
  // partial snapshot without addresses doesn't poison the asset against a
  // later refresh that does carry addresses.
  const autoEnabledAddressesAssetsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedEnrichment) return;
    const assetId = selectedEnrichment.map_asset_id;
    if (autoEnabledAddressesAssetsRef.current.has(assetId)) return;
    const hasAddresses = selectedEnrichment.overlay_payload.layers.some(
      (l) => l.layer_id === "addresses" && l.feature_count > 0,
    );
    if (!hasAddresses) return;
    autoEnabledAddressesAssetsRef.current.add(assetId);
    setEnabledOverlayLayerIds((current) =>
      current.includes("addresses") ? current : [...current, "addresses"],
    );
  }, [selectedEnrichment]);

  // Default-on a curated set of high-signal POI layers the first time
  // enrichment lands for an asset, mirroring the addresses behavior above:
  // keyed per asset+layer so a user's off-toggle is never clobbered and a
  // partial first snapshot can't permanently suppress a layer that shows up in
  // a later refresh. Only layers that actually carry features are enabled.
  const autoEnabledDefaultOverlaysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!selectedEnrichment) return;
    const assetId = selectedEnrichment.map_asset_id;
    const toEnable: MapOverlayLayerId[] = [];
    for (const layerId of DEFAULT_ENABLED_OVERLAY_LAYER_IDS) {
      const key = `${assetId}:${layerId}`;
      if (autoEnabledDefaultOverlaysRef.current.has(key)) continue;
      const hasFeatures = selectedEnrichment.overlay_payload.layers.some(
        (l) => l.layer_id === layerId && l.feature_count > 0,
      );
      if (!hasFeatures) continue;
      autoEnabledDefaultOverlaysRef.current.add(key);
      toEnable.push(layerId);
    }
    if (toEnable.length === 0) return;
    setEnabledOverlayLayerIds((current) => {
      const next = [...current];
      for (const id of toEnable) if (!next.includes(id)) next.push(id);
      return next;
    });
  }, [selectedEnrichment]);

  // --- Feature type toggles ---
  const [enabledFeatureTypeIds, setEnabledFeatureTypeIds] = useState<RoadNetworkFeatureTypeId[]>(
    [...DEFAULT_ENABLED_FEATURE_TYPE_IDS],
  );

  useEffect(() => {
    setEnabledFeatureTypeIds([...DEFAULT_ENABLED_FEATURE_TYPE_IDS]);
  }, [mapAssetId]);

  function toggleFeatureType(id: RoadNetworkFeatureTypeId) {
    setEnabledFeatureTypeIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    );
  }

  function toggleAllFeatureTypes() {
    setEnabledFeatureTypeIds((current) =>
      current.length > 0 ? [] : [...ALL_FEATURE_TYPE_IDS],
    );
  }

  const featureTypeCounts = useMemo(
    () => (selectedGeoJSON ? computeFeatureTypeCounts(selectedGeoJSON) : null),
    [selectedGeoJSON],
  );

  // GUID → __mapId lookup index (for highlight/select by ID from inspector)
  const { guidToMapId, knownGuids } = useMemo(
    () => buildFeatureIdIndex(selectedGeoJSON),
    [selectedGeoJSON],
  );

  // --- Candidate locations ---
  const [candidateLocations, setCandidateLocations] = useState<CandidateLocation[]>([]);
  const [candidateLocationsLoading, setCandidateLocationsLoading] = useState(false);
  const [candidateLocationsHydrated, setCandidateLocationsHydrated] = useState(false);
  const [selectedCandidateLocationId, setSelectedCandidateLocationId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!mapAssetId || !candidateLocationsRequested) {
      setCandidateLocations([]);
      setCandidateLocationsLoading(false);
      setCandidateLocationsHydrated(true);
      return;
    }
    if (preloaded) {
      setCandidateLocations(preloaded.candidate_locations);
      setCandidateLocationsLoading(false);
      setCandidateLocationsHydrated(true);
      return;
    }
    let cancelled = false;
    setCandidateLocations([]);
    setCandidateLocationsLoading(true);
    setCandidateLocationsHydrated(false);

    fetchCandidateLocationsDeduped(mapAssetId)
      .then((data) => {
        if (!cancelled) setCandidateLocations(data.locations);
      })
      .catch(() => {
        if (!cancelled) setCandidateLocations([]);
      })
      .finally(() => {
        if (!cancelled) {
          setCandidateLocationsLoading(false);
          setCandidateLocationsHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [candidateLocationsRequested, mapAssetId, enrichmentVersion, preloaded]);

  // --- Scenario-candidate family layers ---
  // One toggleable map layer per scenario family, grouped exactly like the
  // Insights tab. All off by default (candidates can be numerous); the user
  // opts in via the Layers panel. Reset enabled ids when switching maps.
  const candidateFamilyLayers = useMemo(
    () => buildScenarioCandidateFamilyLayers(candidateLocations),
    [candidateLocations],
  );
  const [enabledCandidateFamilyIds, setEnabledCandidateFamilyIds] = useState<string[]>([]);

  useEffect(() => {
    setEnabledCandidateFamilyIds([]);
  }, [mapAssetId]);

  // --- Twin-fidelity scorecard (digital-twin-eval artifact) ---
  // Probe the presigned 3d-asset path once per asset; absence just means no
  // evaluation has been imported. All sub-layers start off — the user opts in
  // via the Layers panel "Twin Fidelity" group.
  const [twinFidelityScorecard, setTwinFidelityScorecard] =
    useState<TwinFidelityScorecard | null>(null);
  const [enabledTwinFidelityLayerIds, setEnabledTwinFidelityLayerIds] =
    useState<TwinFidelitySubLayerId[]>([]);
  const [twinFidelityRes, setTwinFidelityRes] = useState(11);

  useEffect(() => {
    setEnabledTwinFidelityLayerIds([]);
    setTwinFidelityRes(11);
  }, [mapAssetId]);

  useEffect(() => {
    if (!twinFidelityRequested) {
      setTwinFidelityScorecard(null);
      return;
    }
    let cancelled = false;
    fetchTwinFidelityScorecard(mapAssetId, twinFidelityRes).then((scorecard) => {
      if (cancelled) return;
      // A missing finer-grained artifact keeps the current one on screen —
      // the panel disables unavailable resolutions after the first miss.
      if (scorecard || twinFidelityRes === 11) setTwinFidelityScorecard(scorecard);
    });
    return () => {
      cancelled = true;
    };
  }, [mapAssetId, twinFidelityRequested, twinFidelityRes]);

  function toggleTwinFidelityLayer(id: TwinFidelitySubLayerId) {
    setTwinFidelityRequested(true);
    setEnabledTwinFidelityLayerIds((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id],
    );
  }

  // ── Speed-limit overlay (Overture posted limits labelled on driving lanes) ──
  // Off by default; the street-facts sidecar is fetched lazily on first enable
  // and joined onto the road-network geometry to place the labels.
  const [speedLimitsEnabled, setSpeedLimitsEnabled] = useState(false);
  useEffect(() => {
    setSpeedLimitsEnabled(false);
  }, [mapAssetId]);
  const speedLimitFacts = useStreetFactsByFeatureId(mapAssetId, speedLimitsEnabled);
  // The street-facts hook caches its fetch and keeps returning data after the
  // toggle goes off, so gate the built overlay on `speedLimitsEnabled` too —
  // otherwise the labels would linger once disabled.
  const speedDisplayUnit = displayUnitForCountry(asset.place_context?.country_code);
  const speedLimitOverlayGeoJSON: GeoJsonFeatureCollection = useMemo(
    () =>
      speedLimitsEnabled && speedLimitFacts
        ? buildSpeedLimitOverlayGeoJSON(selectedGeoJSON, speedLimitFacts, speedDisplayUnit)
        : EMPTY_SPEED_LIMIT_OVERLAY,
    [speedLimitsEnabled, selectedGeoJSON, speedLimitFacts, speedDisplayUnit],
  );
  const speedLimitCount = speedLimitOverlayGeoJSON.features.length;
  function toggleSpeedLimits() {
    setSpeedLimitsEnabled((on) => !on);
  }

  // In-house speed limits: the XODR-authored per-lane `SpeedLimit` that already
  // rides the road-network GeoJSON. No fetch — read straight off selectedGeoJSON.
  // Off by default; lives in the Road Network group for side-by-side comparison
  // with the (proximity-matched) Overture layer.
  const [inHouseSpeedLimitsEnabled, setInHouseSpeedLimitsEnabled] = useState(false);
  useEffect(() => {
    setInHouseSpeedLimitsEnabled(false);
  }, [mapAssetId]);
  const inHouseSpeedLimitOverlayGeoJSON: GeoJsonFeatureCollection = useMemo(
    () =>
      inHouseSpeedLimitsEnabled
        ? buildXodrSpeedLimitOverlayGeoJSON(selectedGeoJSON)
        : EMPTY_SPEED_LIMIT_OVERLAY,
    [inHouseSpeedLimitsEnabled, selectedGeoJSON],
  );
  const inHouseSpeedLimitCount = inHouseSpeedLimitOverlayGeoJSON.features.length;
  function toggleInHouseSpeedLimits() {
    setInHouseSpeedLimitsEnabled((on) => !on);
  }

  function toggleCandidateFamily(familyId: string) {
    setCandidateLocationsRequested(true);
    setEnabledCandidateFamilyIds((current) =>
      current.includes(familyId)
        ? current.filter((existing) => existing !== familyId)
        : [...current, familyId],
    );
  }

  // --- Selected features ---
  const [selectedFeatures, setSelectedFeatures] = useState<SelectedGeoJSONFeaturePayload[]>([]);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);

  const selectedOverlayCoords = useMemo(() => {
    if (selectedFeatureId == null || selectedFeatures.length === 0) return null;
    const feat = selectedFeatures.find((f) => f.id === selectedFeatureId);
    return feat?.coordinates ?? null;
  }, [selectedFeatureId, selectedFeatures]);

  // Full geometry of the selected feature, used by SelectedOverlayHighlight to
  // outline polygon/line selections (e.g. crosswalks). Points still rely on
  // selectedOverlayCoords and the existing circle-ring layer.
  const selectedOverlayGeometry = useMemo(() => {
    if (selectedFeatureId == null || selectedFeatures.length === 0) return null;
    const feat = selectedFeatures.find((f) => f.id === selectedFeatureId);
    return (feat?.geometry as Record<string, unknown> | undefined) ?? null;
  }, [selectedFeatureId, selectedFeatures]);

  // --- User-uploaded GeoJSON overlays (session-only) ---
  // Held in memory for co-visualization (e.g. scenario locations) and cleared
  // when switching maps, since the geometry is lng/lat placed against a
  // specific map's basemap. Newest layer is prepended so it lands at the top.
  const [userGeoJsonLayers, setUserGeoJsonLayers] = useState<UserGeoJsonLayer[]>([]);

  useEffect(() => {
    setUserGeoJsonLayers([]);
  }, [mapAssetId]);

  function addUserGeoJsonLayer(name: string, data: object, featureCount: number) {
    setUserGeoJsonLayers((current) => {
      const id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `ug-${current.length}-${name}`;
      const layer: UserGeoJsonLayer = {
        id,
        name,
        data,
        featureCount,
        visible: true,
        color: defaultUserGeoJsonColor(current.length),
        opacity: DEFAULT_USER_GEOJSON_OPACITY,
        thickness: DEFAULT_USER_GEOJSON_THICKNESS,
      };
      return [layer, ...current];
    });
  }

  function removeUserGeoJsonLayer(id: string) {
    setUserGeoJsonLayers((current) => current.filter((l) => l.id !== id));
  }

  function toggleUserGeoJsonLayer(id: string) {
    setUserGeoJsonLayers((current) =>
      current.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)),
    );
  }

  function setUserGeoJsonLayerColor(id: string, color: string) {
    setUserGeoJsonLayers((current) =>
      current.map((l) => (l.id === id ? { ...l, color } : l)),
    );
  }

  function setUserGeoJsonLayerOpacity(id: string, opacity: number) {
    setUserGeoJsonLayers((current) =>
      current.map((l) => (l.id === id ? { ...l, opacity } : l)),
    );
  }

  function setUserGeoJsonLayerThickness(id: string, thickness: number) {
    const next = clampUserGeoJsonThickness(thickness);
    setUserGeoJsonLayers((current) =>
      current.map((l) => (l.id === id ? { ...l, thickness: next } : l)),
    );
  }

  // --- Signal overlay ---
  const [signalOverlayGeoJSON, setSignalOverlayGeoJSON] = useState<object | null>(null);
  const [enabledSignalCategories, setEnabledSignalCategories] = useState<Set<string>>(
    () => new Set(eagerNonSemanticLayers ? DEFAULT_ENABLED_SIGNAL_CATEGORY_IDS : []),
  );
  const [signalOverlayLoading, setSignalOverlayLoading] = useState(false);
  const [signalOverlayHydrated, setSignalOverlayHydrated] = useState(false);
  const [signalOverlayError, setSignalOverlayError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapAssetId || !signalOverlayRequested) {
      setSignalOverlayGeoJSON(null);
      setSignalOverlayLoading(false);
      setSignalOverlayHydrated(true);
      setSignalOverlayError(null);
      return;
    }
    if (preloaded) {
      setSignalOverlayGeoJSON(preloaded.signals_geojson);
      setSignalOverlayLoading(false);
      setSignalOverlayHydrated(true);
      setSignalOverlayError(null);
      setEnabledSignalCategories(new Set(DEFAULT_ENABLED_SIGNAL_CATEGORY_IDS));
      return;
    }
    if (!hasSignalOverlayArtifact) {
      setSignalOverlayGeoJSON(null);
      setSignalOverlayLoading(false);
      setSignalOverlayHydrated(true);
      setSignalOverlayError(null);
      return;
    }

    let cancelled = false;
    setSignalOverlayGeoJSON(null);
    setSignalOverlayLoading(true);
    setSignalOverlayHydrated(false);
    setSignalOverlayError(null);
    setEnabledSignalCategories(new Set(DEFAULT_ENABLED_SIGNAL_CATEGORY_IDS));

    fetchGeoJSONArtifactWithCache(mapAssetId, {
      geojsonSha256: signalOverlaySha256,
      kind: "signals",
      endpoint: `/api/map-assets/${mapAssetId}/signals-geojson`,
    })
      .then((data: { features?: { properties?: { signal_category?: string } }[] }) => {
        if (cancelled) return;
        setSignalOverlayGeoJSON(data);
        setSignalOverlayError(null);
        setEnabledSignalCategories(new Set(DEFAULT_ENABLED_SIGNAL_CATEGORY_IDS));
      })
      .catch((error) => {
        if (!cancelled) {
          setSignalOverlayGeoJSON(null);
          setSignalOverlayError(formatFetchError(error, "Signals overlay fetch failed"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSignalOverlayLoading(false);
          setSignalOverlayHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasSignalOverlayArtifact, mapAssetId, preloaded, signalOverlayRequested, signalOverlaySha256]);

  // --- Lane-polygon overlay ---
  const [lanePolygonsGeoJSON, setLanePolygonsGeoJSON] = useState<object | null>(null);
  const [lanePolygonsLoading, setLanePolygonsLoading] = useState(false);
  const [lanePolygonsHydrated, setLanePolygonsHydrated] = useState(false);
  const [lanePolygonsError, setLanePolygonsError] = useState<string | null>(null);

  // Unlike signals, the lane-polygon sidecar can be multi-MB, so it is never
  // embedded in the editor map-bundle JSON (it would risk the Amplify response
  // cap). Both the map detail view and the editor fetch it on its own via the
  // 302 route whenever the artifact exists.
  useEffect(() => {
    if (!mapAssetId || !hasLanePolygonsArtifact || !lanePolygonsRequested) {
      setLanePolygonsGeoJSON(null);
      setLanePolygonsLoading(false);
      setLanePolygonsHydrated(true);
      setLanePolygonsError(null);
      return;
    }

    let cancelled = false;
    setLanePolygonsGeoJSON(null);
    setLanePolygonsLoading(true);
    setLanePolygonsHydrated(false);
    setLanePolygonsError(null);

    fetchGeoJSONArtifactWithCache(mapAssetId, {
      geojsonSha256: lanePolygonsSha256,
      kind: "lane-polygons",
      endpoint: `/api/map-assets/${mapAssetId}/lane-polygons-geojson`,
    })
      .then((data: object) => {
        if (cancelled) return;
        setLanePolygonsGeoJSON(data);
        setLanePolygonsError(null);
      })
      .catch((error) => {
        if (!cancelled) {
          setLanePolygonsGeoJSON(null);
          setLanePolygonsError(formatFetchError(error, "Lane polygons fetch failed"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLanePolygonsLoading(false);
          setLanePolygonsHydrated(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasLanePolygonsArtifact, lanePolygonsRequested, lanePolygonsSha256, mapAssetId]);

  // Lanes drawn as filled polygons vs. authored centerlines. Persisted across
  // sessions; initialized from storage after mount to stay SSR-safe.
  const [laneRenderMode, setLaneRenderModeState] = useState<LaneRenderMode>(
    coreLanePolygonsRequested ? "filled" : "centerlines",
  );
  useEffect(() => {
    setLaneRenderModeState(
      options.loadLanePolygons === true
        ? "filled"
        : eagerNonSemanticLayers
          ? loadLaneRenderMode()
          : "centerlines",
    );
  }, [eagerNonSemanticLayers, options.loadLanePolygons]);
  function setLaneRenderMode(mode: LaneRenderMode) {
    if (mode === "filled") setLanePolygonsRequested(true);
    setLaneRenderModeState(mode);
    persistLaneRenderMode(mode);
  }

  // Stamp each filled lane polygon with the __mapId of its authored centerline,
  // resolved EXACTLY by the lane GUID the sidecar carries (XODR vectorLane
  // laneId === GeoJSON lane Id). A click on the fill then resolves to the real
  // lane feature (full attributes + selection highlight).
  const lanePolygonsWithIds = useMemo(
    () => stampLanePolygonMapIds(lanePolygonsGeoJSON, guidToMapId),
    [lanePolygonsGeoJSON, guidToMapId],
  );

  function toggleSignalCategory(cat: string) {
    setSignalOverlayRequested(true);
    setEnabledSignalCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  function toggleAllSignalCategories() {
    setSignalOverlayRequested(true);
    setEnabledSignalCategories((prev) => {
      if (prev.size > 0) return new Set();
      const cats = new Set<string>();
      const data = signalOverlayGeoJSON as {
        features?: { properties?: { feature_kind?: string; signal_category?: string } }[];
      } | null;
      for (const f of data?.features ?? []) {
        const cat =
          f.properties?.feature_kind === "crosswalk"
            ? "crosswalk"
            : f.properties?.signal_category;
        if (cat) cats.add(cat);
      }
      return cats;
    });
  }

  return {
    selectedGeoJSON,
    geojsonLoading,
    geojsonHydrated,
    geojsonError,
    requestGeoJSON: () => setGeoJSONRequested(true),
    selectedEnrichment,
    enrichmentLoading,
    enrichmentHydrated,
    refreshEnrichment,
    enrichmentVersion,
    requestEnrichment: () => setEnrichmentRequested(true),
    enabledOverlayLayerIds,
    toggleOverlayLayer,
    setEnabledOverlayLayerIds,
    enabledFeatureTypeIds,
    featureTypeCounts,
    toggleFeatureType,
    toggleAllFeatureTypes,
    candidateLocations,
    candidateLocationsLoading,
    candidateLocationsHydrated,
    selectedCandidateLocationId,
    setSelectedCandidateLocationId,
    requestCandidateLocations: () => setCandidateLocationsRequested(true),
    candidateFamilyLayers,
    enabledCandidateFamilyIds,
    toggleCandidateFamily,
    setEnabledCandidateFamilyIds,
    twinFidelityScorecard,
    enabledTwinFidelityLayerIds,
    toggleTwinFidelityLayer,
    twinFidelityRes,
    setTwinFidelityRes,
    requestTwinFidelity: () => setTwinFidelityRequested(true),
    speedLimitsEnabled,
    toggleSpeedLimits,
    speedLimitOverlayGeoJSON,
    speedLimitCount,
    inHouseSpeedLimitsEnabled,
    toggleInHouseSpeedLimits,
    inHouseSpeedLimitOverlayGeoJSON,
    inHouseSpeedLimitCount,
    selectedFeatures,
    setSelectedFeatures,
    selectedFeatureId,
    setSelectedFeatureId,
    selectedOverlayCoords,
    selectedOverlayGeometry,
    signalOverlayGeoJSON,
    enabledSignalCategories,
    signalOverlayLoading,
    signalOverlayHydrated,
    signalOverlayError,
    toggleSignalCategory,
    toggleAllSignalCategories,
    requestSignalOverlay: () => setSignalOverlayRequested(true),
    lanePolygonsGeoJSON: lanePolygonsWithIds,
    lanePolygonsLoading,
    lanePolygonsHydrated,
    lanePolygonsError,
    laneRenderMode,
    setLaneRenderMode,
    requestLanePolygons: () => setLanePolygonsRequested(true),
    guidToMapId,
    knownGuids,
    userGeoJsonLayers,
    addUserGeoJsonLayer,
    removeUserGeoJsonLayer,
    toggleUserGeoJsonLayer,
    setUserGeoJsonLayerColor,
    setUserGeoJsonLayerOpacity,
    setUserGeoJsonLayerThickness,
  };
}
