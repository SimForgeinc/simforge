"use client";

import { useCallback } from "react";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import { getExistingLayerIds, SELECTED_GEOJSON_LAYER_IDS } from "@/app/lib/maps/frontend/map-assets-map-utils";
import {
  featureByMapId,
  featurePropertiesForPanel,
  getFeatureMapId,
  getFeatureSummaryLine,
  getGeometryType,
} from "@/app/lib/maps/frontend/map-assets-map-utils";
import type { SelectedGeoJSONFeaturePayload } from "@/app/lib/maps/frontend/feature-inspection-types";
import { classifyRoadNetworkFeatureType } from "@/app/lib/maps/frontend/road-network-feature-types";
import { userGeoJsonPropertiesForPanel } from "@/app/lib/maps/frontend/user-geojson-layers";

/**
 * A driving lane says nothing worth a tooltip.
 *
 * Most of the map IS driving lanes, so a label that reads "Driving Lanes"
 * follows the cursor almost everywhere and covers the road it is naming. The
 * kinds that are genuinely ambiguous at a glance — a sidewalk, a parking lane,
 * a shoulder — keep theirs.
 */
function isDrivingLane(feature: { properties?: Record<string, unknown> | null }) {
  const props = feature.properties;
  if (!props || typeof props !== "object") return false;
  return classifyRoadNetworkFeatureType(props) === "lanes_driving";
}

type HoverInfo = {
  items: { id: number; summary: string }[];
  x: number;
  y: number;
} | null;

// When a click hits the filled lane polygons (`lane-polygon-fill-*`), return the
// clicked polygon's unique `lane_poly_id` (the source promoteId, surfaced as
// `feature.id`). The map highlights that id so only the clicked lane area lights
// up — junction connectors share a lane `__mapId`, so highlighting by __mapId
// would light them all.
function lanePolygonIdFor(
  features: Array<{ layer?: { id?: string }; id?: string | number; properties?: Record<string, unknown> }>,
  mapId: number,
): number | undefined {
  for (const f of features) {
    if (
      f.layer?.id?.startsWith("lane-polygon-fill-") &&
      getFeatureMapId(f.properties) === mapId &&
      typeof f.id === "number"
    ) {
      return f.id;
    }
  }
  return undefined;
}

// Crosswalks ride on the signal overlay (feature_kind="crosswalk") but render
// as polygons on signal-overlay-crosswalk-fill, so the circle-based layer-id
// convention for signs doesn't apply.
function signalLayerIdsFor(category: string): string[] {
  if (category === "traffic_light") return [];
  if (category === "crosswalk") return ["signal-overlay-crosswalk-fill"];
  return [`signal-overlay-circle-${category}`];
}

// Crosswalk features carry Polygon geometry; everyone else is a Point. To keep
// the existing point-anchored highlight ring working we project a polygon to
// its first-vertex coords (close enough — crosswalks are small rectangles).
function representativeCoords(
  geom: unknown,
): [number, number] | undefined {
  const g = geom as { type?: string; coordinates?: unknown } | null | undefined;
  if (!g) return undefined;
  if (g.type === "Point") return g.coordinates as [number, number];
  if (g.type === "Polygon") {
    const rings = g.coordinates as [number, number][][] | undefined;
    const ring = rings?.[0];
    if (!ring || ring.length === 0) return undefined;
    let sx = 0;
    let sy = 0;
    // Skip the closing vertex (same as the first) so it doesn't double-weight.
    const last = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0]
      && ring[0]![1] === ring[ring.length - 1]![1] ? ring.length - 1 : ring.length;
    for (let i = 0; i < last; i++) {
      sx += ring[i]![0];
      sy += ring[i]![1];
    }
    return [sx / last, sy / last];
  }
  return undefined;
}

// Non-road-network selections (enrichment / signals / crosswalks) get ids offset
// far above any geojson `__mapId` (a feature's array index, ≤ a few thousand) so
// that a COMBINED multi-selection has globally-unique ids — the inspector and the
// overlay-highlight both look features up by id.
const OVERLAY_SELECT_ID_BASE = 1_000_000;

type OverlayQueryFeature = {
  layer?: { id?: string };
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
};

/**
 * Append the overlay features under the cursor (enrichment, signals,
 * crosswalks) to a shared selection list, de-duplicated by feature id and given
 * collision-free ids. Used so the inspector lists EVERYTHING overlapping the
 * click — e.g. a crosswalk on top of a driving lane — instead of only the first
 * source that happens to be hit.
 */
function collectOverlaySelections(
  out: SelectedGeoJSONFeaturePayload[],
  features: OverlayQueryFeature[],
  summaryOf: (f: OverlayQueryFeature) => string,
  nextId: () => number,
) {
  const seen = new Set<string>();
  for (const f of features) {
    const fid = String(f.properties?.id ?? f.id ?? "");
    if (!fid || seen.has(fid)) continue;
    seen.add(fid);
    out.push({
      id: nextId(),
      summary: summaryOf(f),
      geometryType: f.geometry?.type ?? "Point",
      properties: featurePropertiesForPanel(f.properties as Record<string, unknown>),
      coordinates: representativeCoords(f.geometry),
      geometry: f.geometry as unknown as Record<string, unknown>,
    });
  }
}

/** One-line summary for an uploaded GeoJSON feature — prefer a name-ish prop. */
function userGeoJsonSummary(props: Record<string, unknown> | null | undefined, geomType?: string): string {
  if (props && typeof props === "object") {
    for (const key of ["name", "Name", "NAME", "title", "Title", "label", "Label"]) {
      const v = props[key];
      if (v != null && v !== "") return String(v);
    }
    const t = props.type ?? props.Type;
    if (t != null && t !== "") return String(t);
  }
  return geomType ?? "GeoJSON feature";
}

/**
 * Append user-uploaded GeoJSON features under the cursor to the shared
 * selection list. Deduped by `source:__mapId` because each feature can surface
 * from several stacked sublayers (a polygon hits both `-fill` and
 * `-polygon-outline`) and `__mapId` restarts at 0 per uploaded layer.
 */
function collectUserGeoJsonSelections(
  out: SelectedGeoJSONFeaturePayload[],
  features: Array<OverlayQueryFeature & { source?: string }>,
  nextId: () => number,
) {
  const seen = new Set<string>();
  for (const f of features) {
    const mapId = getFeatureMapId(f.properties as Record<string, unknown>);
    const key = `${f.source ?? ""}:${mapId ?? "?"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: nextId(),
      summary: userGeoJsonSummary(f.properties as Record<string, unknown>, f.geometry?.type),
      geometryType: f.geometry?.type ?? "Feature",
      properties: userGeoJsonPropertiesForPanel(f.properties as Record<string, unknown>),
      coordinates: representativeCoords(f.geometry),
      geometry: f.geometry as unknown as Record<string, unknown>,
    });
  }
}

type UseGeoJsonHoverArgs = {
  selectedGeoJSON: object | null | undefined;
  enrichmentLayerIds: string[];
  /** Query-target layer ids for the visible user-uploaded GeoJSON overlays. */
  userGeoJsonLayerIds?: string[];
  scenarioCandidateLayerIds?: string[];
  enabledSignalCategories: Set<string>;
  setGeojsonHoverInfo: (value: HoverInfo) => void;
  setHoverInfo: (value: { count: number; name?: string } | null) => void;
  setTooltipPosition: (value: { x: number; y: number } | null) => void;
};

export function useGeoJsonHover({
  selectedGeoJSON,
  enrichmentLayerIds,
  userGeoJsonLayerIds = [],
  scenarioCandidateLayerIds = [],
  enabledSignalCategories,
  setGeojsonHoverInfo,
  setHoverInfo,
  setTooltipPosition,
}: UseGeoJsonHoverArgs) {
  return useCallback(
    (evt: MapLayerMouseEvent) => {
      const map = evt.target;

      // Scenario-candidate family layers take hover priority: they are
      // explicitly-enabled overlays whose polygons sit atop the road network,
      // so the user clearly wants to inspect the candidate, not the lane under
      // it. No-op when no family layer is enabled.
      if (scenarioCandidateLayerIds.length > 0) {
        const candIds = getExistingLayerIds(map, scenarioCandidateLayerIds);
        if (candIds.length > 0) {
          try {
            const features = map.queryRenderedFeatures(evt.point, { layers: candIds });
            if (features.length > 0) {
              setGeojsonHoverInfo({
                items: [{ id: 0, summary: String(features[0]!.properties?.label ?? "Scenario candidate") }],
                x: evt.point.x,
                y: evt.point.y,
              });
              setHoverInfo(null);
              setTooltipPosition(null);
              return true;
            }
          } catch {
            // continue
          }
        }
      }
      const signalLayerIds = [...enabledSignalCategories].flatMap(signalLayerIdsFor);

      if (selectedGeoJSON) {
        const geojsonLayerIds = getExistingLayerIds(map, SELECTED_GEOJSON_LAYER_IDS);
        if (geojsonLayerIds.length > 0) {
          try {
            const features = map.queryRenderedFeatures(evt.point, { layers: geojsonLayerIds });
            const seen = new Set<number>();
            const items: { id: number; summary: string }[] = [];
            let hit = false;
            for (const feature of features) {
              const id = getFeatureMapId(feature.properties as Record<string, unknown>);
              if (id === undefined || seen.has(id)) continue;
              seen.add(id);
              hit = true;
              // A filled lane polygon only carries the matched __mapId, so
              // resolve to the authored centerline for the summary text.
              const canonical = featureByMapId(selectedGeoJSON, id) ?? feature;
              if (isDrivingLane(canonical)) continue;
              items.push({ id, summary: getFeatureSummaryLine(canonical) });
            }
            // `hit`, not `items.length`: a driving lane still CLAIMS the hover,
            // so the cursor and the hover priority over layers below are what
            // they always were. Only the label is gone. Falling through would
            // hand the road to the asset-hover handler underneath.
            if (hit) {
              setGeojsonHoverInfo({ items, x: evt.point.x, y: evt.point.y });
              setHoverInfo(null);
              setTooltipPosition(null);
              return true;
            }
          } catch {
            // continue
          }
        }
      }

      if (userGeoJsonLayerIds.length > 0) {
        const ugIds = getExistingLayerIds(map, userGeoJsonLayerIds);
        if (ugIds.length > 0) {
          try {
            const features = map.queryRenderedFeatures(evt.point, { layers: ugIds });
            if (features.length > 0) {
              setGeojsonHoverInfo({
                items: [
                  {
                    id: 0,
                    summary: userGeoJsonSummary(
                      features[0]!.properties as Record<string, unknown>,
                      features[0]!.geometry?.type,
                    ),
                  },
                ],
                x: evt.point.x,
                y: evt.point.y,
              });
              setHoverInfo(null);
              setTooltipPosition(null);
              return true;
            }
          } catch {
            // continue
          }
        }
      }

      if (enrichmentLayerIds.length > 0) {
        const enrichIds = getExistingLayerIds(map, enrichmentLayerIds);
        if (enrichIds.length > 0) {
          try {
            const features = map.queryRenderedFeatures(evt.point, { layers: enrichIds });
            if (features.length > 0) {
              const name = String(features[0]!.properties?.name ?? features[0]!.properties?.layer_id ?? "");
              setGeojsonHoverInfo({
                items: [{ id: 0, summary: name || "Enrichment feature" }],
                x: evt.point.x,
                y: evt.point.y,
              });
              setHoverInfo(null);
              setTooltipPosition(null);
              return true;
            }
          } catch {
            // continue
          }
        }
      }

      if (enabledSignalCategories.size > 0) {
        const sigIds = getExistingLayerIds(map, [
          ...signalLayerIds,
          "signal-traffic-light-single",
          "signal-traffic-light-cluster",
        ]);
        if (sigIds.length > 0) {
          try {
            const features = map.queryRenderedFeatures(evt.point, { layers: sigIds });
            if (features.length > 0) {
              const props = features[0]!.properties ?? {};
              const pointCount = props.point_count as number | undefined;
              const name = pointCount
                ? `${pointCount} Traffic Lights${pointCount > 8 ? " — Zoom in for individual lights" : ""}`
                : String(props.name ?? props.signal_category ?? "Signal");
              setGeojsonHoverInfo({
                items: [{ id: 0, summary: name }],
                x: evt.point.x,
                y: evt.point.y,
              });
              setHoverInfo(null);
              setTooltipPosition(null);
              return true;
            }
          } catch {
            // continue
          }
        }
      }

      setGeojsonHoverInfo(null);
      return false;
    },
    [
      enabledSignalCategories,
      enrichmentLayerIds,
      userGeoJsonLayerIds,
      scenarioCandidateLayerIds,
      selectedGeoJSON,
      setGeojsonHoverInfo,
      setHoverInfo,
      setTooltipPosition,
    ],
  );
}

type UseGeoJsonSelectionArgs = {
  selectedGeoJSON: object | null | undefined;
  enrichmentLayerIds: string[];
  /** Query-target layer ids for the visible user-uploaded GeoJSON overlays. */
  userGeoJsonLayerIds?: string[];
  scenarioCandidateLayerIds?: string[];
  /** Enabled twin-fidelity sublayer ids (see TwinFidelityLayers). */
  twinFidelityLayerIds?: string[];
  enabledSignalCategories: Set<string>;
  onSelectFeature?: (payload: SelectedGeoJSONFeaturePayload[]) => void;
};

export function useGeoJsonSelection({
  selectedGeoJSON,
  enrichmentLayerIds,
  userGeoJsonLayerIds = [],
  scenarioCandidateLayerIds = [],
  twinFidelityLayerIds = [],
  enabledSignalCategories,
  onSelectFeature,
}: UseGeoJsonSelectionArgs) {
  return useCallback(
    async (evt: MapLayerMouseEvent) => {
      // Selection also runs for maps with no authored road network as long as
      // there are user-uploaded overlays to inspect.
      if ((!selectedGeoJSON && userGeoJsonLayerIds.length === 0) || !onSelectFeature) return false;
      const map = evt.target;
      const signalLayerIds = [...enabledSignalCategories].flatMap(signalLayerIdsFor);

      // Scenario-candidate family layers take click priority (see the hover
      // hook for rationale). Each feature carries the full candidate payload,
      // so it inspects + copies as GeoJSON like any other object, and the
      // generic selected-feature highlight emphasises the clicked one.
      if (scenarioCandidateLayerIds.length > 0) {
        const candIds = getExistingLayerIds(map, scenarioCandidateLayerIds);
        if (candIds.length > 0) {
          try {
            const features = map.queryRenderedFeatures(evt.point, { layers: candIds });
            if (features.length > 0) {
              const seen = new Set<string>();
              const payloads: SelectedGeoJSONFeaturePayload[] = [];
              for (const feature of features) {
                const fid = String(feature.properties?.id ?? feature.id ?? "");
                if (!fid || seen.has(fid)) continue;
                seen.add(fid);
                const coords = representativeCoords(feature.geometry);
                payloads.push({
                  id: payloads.length,
                  summary: String(feature.properties?.label ?? "Scenario candidate"),
                  geometryType: feature.geometry?.type ?? "Polygon",
                  properties: featurePropertiesForPanel(feature.properties as Record<string, unknown>),
                  coordinates: coords,
                  geometry: feature.geometry as unknown as Record<string, unknown>,
                });
              }
              if (payloads.length > 0) {
                onSelectFeature(payloads);
                return true;
              }
            }
          } catch {
            // continue
          }
        }
      }

      // Twin-fidelity cells: inspect the per-cell scorecard payload (fidelity
      // split, chamfer, inliers, counts). Runs after scenario candidates (which
      // keep priority) but before the aggregate path — a fidelity cell spans
      // whole blocks, so aggregating it with every lane under the cursor would
      // bury the lane attributes users usually want from the base map.
      if (twinFidelityLayerIds.length > 0) {
        const twinIds = getExistingLayerIds(map, twinFidelityLayerIds);
        if (twinIds.length > 0) {
          try {
            const features = map.queryRenderedFeatures(evt.point, { layers: twinIds });
            const f = features[0];
            if (f) {
              const props = (f.properties ?? {}) as Record<string, unknown>;
              const coverage = String(props["coverage"] ?? "scored");
              const fidelity = props["composite_fidelity"];
              onSelectFeature([
                {
                  // Overlay id space: road-network selection ids are normalized
                  // __mapIds starting at 0, so a fidelity cell must not reuse
                  // them or useGeoJsonFeatureState highlights an unrelated road
                  // feature with the same id.
                  id: OVERLAY_SELECT_ID_BASE,
                  summary:
                    coverage === "none"
                      ? "Twin fidelity — no twin coverage"
                      : `Twin fidelity ${typeof fidelity === "number" ? fidelity.toFixed(1) : String(fidelity ?? "?")}/100`,
                  geometryType: f.geometry?.type ?? "Polygon",
                  properties: featurePropertiesForPanel(props),
                  geometry: f.geometry as unknown as Record<string, unknown>,
                },
              ]);
              return true;
            }
          } catch {
            // continue
          }
        }
      }

      // Aggregate every feature under the cursor into ONE multi-selection so the
      // inspector lists all overlapping elements (e.g. a driving lane AND a
      // crosswalk), not just the first source that happens to be hit. Scenario
      // candidates keep their dedicated priority (handled + returned above).
      const combined: SelectedGeoJSONFeaturePayload[] = [];
      let overlayId = OVERLAY_SELECT_ID_BASE;

      // Authored road-network features (lanes, …), keyed by their real __mapId.
      const geojsonLayerIds = getExistingLayerIds(map, SELECTED_GEOJSON_LAYER_IDS);
      if (geojsonLayerIds.length > 0) {
        try {
          const features = map.queryRenderedFeatures(evt.point, { layers: geojsonLayerIds });
          const seen = new Set<number>();
          // The filled polygon under the cursor is what the user visually
          // clicked. Make it the primary selection so its highlight id
          // (lane_poly_id) and attribute id (__mapId) come from the SAME
          // feature — otherwise a topmost centerline hit (a different lane at a
          // junction) would set the selection and the polygon highlight wouldn't
          // line up. In centerline mode there is no polygon, so this is a no-op.
          const topPoly = features.find(
            (f) =>
              f.layer?.id?.startsWith("lane-polygon-fill-") &&
              getFeatureMapId(f.properties as Record<string, unknown>) !== undefined,
          );
          const ordered = topPoly ? [topPoly, ...features.filter((f) => f !== topPoly)] : features;
          for (const feature of ordered) {
            const id = getFeatureMapId(feature.properties as Record<string, unknown>);
            if (id === undefined || seen.has(id)) continue;
            seen.add(id);
            // Clicking the filled lane polygon yields a feature carrying only
            // the matched __mapId; resolve to the authored centerline so the
            // inspector shows the full lane attributes (TravelDir, boundaries,
            // speed limit, …) exactly as a centerline click would.
            const canonical = featureByMapId(selectedGeoJSON, id) ?? feature;
            // Highlight ONLY the clicked lane area (not every junction connector
            // sharing this lane's __mapId): the primary polygon contributes its
            // own id directly; stacked lanes fall back to a per-__mapId lookup.
            const lanePolygonId =
              feature === topPoly && typeof feature.id === "number"
                ? feature.id
                : lanePolygonIdFor(features, id);
            combined.push({
              id,
              summary: getFeatureSummaryLine(canonical),
              geometryType: getGeometryType(canonical),
              properties: featurePropertiesForPanel(canonical.properties as Record<string, unknown>),
              geometry: canonical.geometry as unknown as Record<string, unknown>,
              ...(lanePolygonId !== undefined ? { lanePolygonId } : {}),
            });
          }
        } catch {
          // continue
        }
      }

      // User-uploaded GeoJSON overlays (co-visualized scenario locations, …).
      const userIds =
        userGeoJsonLayerIds.length > 0 ? getExistingLayerIds(map, userGeoJsonLayerIds) : [];
      if (userIds.length > 0) {
        try {
          collectUserGeoJsonSelections(
            combined,
            map.queryRenderedFeatures(evt.point, { layers: userIds }),
            () => overlayId++,
          );
        } catch {
          // continue
        }
      }

      // Enrichment overlays (bus stops, schools, sidewalks, …).
      const enrichIds = enrichmentLayerIds.length > 0 ? getExistingLayerIds(map, enrichmentLayerIds) : [];
      if (enrichIds.length > 0) {
        try {
          collectOverlaySelections(
            combined,
            map.queryRenderedFeatures(evt.point, { layers: enrichIds }),
            (f) => String(f.properties?.name ?? f.properties?.layer_id ?? "Enrichment feature"),
            () => overlayId++,
          );
        } catch {
          // continue
        }
      }

      // Signals + crosswalks (crosswalks ride on the signal overlay).
      if (enabledSignalCategories.size > 0) {
        const sigIds = getExistingLayerIds(map, [...signalLayerIds, "signal-traffic-light-single"]);
        if (sigIds.length > 0) {
          try {
            collectOverlaySelections(
              combined,
              map.queryRenderedFeatures(evt.point, { layers: sigIds }),
              (f) => String(f.properties?.name ?? f.properties?.signal_category ?? "Signal"),
              () => overlayId++,
            );
          } catch {
            // continue
          }
        }
      }

      if (combined.length > 0) {
        onSelectFeature(combined);
        return true;
      }

      // Fallback: a clustered traffic-light pin (zoomed out) — expand or zoom in.
      if (enabledSignalCategories.size > 0) {
        const clusterIds = getExistingLayerIds(map, ["signal-traffic-light-cluster"]);
        if (clusterIds.length > 0) {
          try {
            const features = map.queryRenderedFeatures(evt.point, { layers: clusterIds });
            if (features.length > 0) {
              const pointCount = features[0]!.properties?.point_count as number | undefined;
              const clusterId = features[0]!.properties?.cluster_id as number | undefined;
              const source = map.getSource("signal-traffic-lights") as import("maplibre-gl").GeoJSONSource | undefined;
              if (source && clusterId != null) {
                if (pointCount != null && pointCount <= 8) {
                  source.getClusterLeaves(clusterId, pointCount, 0).then((leaves) => {
                    const payloads: SelectedGeoJSONFeaturePayload[] = [];
                    for (const leaf of leaves) {
                      const geom = leaf.geometry;
                      const coords = geom?.type === "Point" ? (geom.coordinates as [number, number]) : undefined;
                      payloads.push({
                        id: payloads.length,
                        summary: String(leaf.properties?.name ?? "Traffic Light"),
                        geometryType: geom?.type ?? "Point",
                        properties: featurePropertiesForPanel(leaf.properties as Record<string, unknown>),
                        coordinates: coords,
                        geometry: geom as unknown as Record<string, unknown>,
                      });
                    }
                    if (payloads.length > 0) {
                      onSelectFeature(payloads);
                    }
                  });
                } else {
                  const geom = features[0]!.geometry;
                  source.getClusterExpansionZoom(clusterId).then((zoom) => {
                    if (geom?.type === "Point") {
                      map.easeTo({
                        center: geom.coordinates as [number, number],
                        zoom: Math.min(zoom + 1, 20),
                      });
                    }
                  });
                }
                return true;
              }
            }
          } catch {
            // continue
          }
        }
      }

      onSelectFeature([]);
      return false;
    },
    [enabledSignalCategories, enrichmentLayerIds, userGeoJsonLayerIds, scenarioCandidateLayerIds, twinFidelityLayerIds, onSelectFeature, selectedGeoJSON],
  );
}
