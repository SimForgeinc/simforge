"use client";

import Map from "react-map-gl/maplibre";
import type { MapLayerMouseEvent, MapRef } from "react-map-gl/maplibre";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import { BASEMAPS, type BasemapId } from "@/app/lib/maps/frontend/basemaps";
import {
  DEFAULT_BASEMAP_LAYER_VISIBILITY,
  resolveBasemapStyleWithImagery,
  type BasemapLayerVisibility,
} from "@/app/lib/maps/frontend/basemap-visibility";
import type { SatelliteImageryLayer } from "@/app/lib/maps/frontend/satellite-imagery";
import { unprojectGroundPoint } from "@/app/lib/maps/frontend/ground-unproject";
import {
  isNonFatalTileLoadError,
  logMapError,
  logMapLoadDiagnostics,
  logMapLoadTimeout,
  logMapMountDiagnostics,
} from "@/app/lib/maps/frontend/map-diagnostics";
import { C } from "./map-layer-constants";
import { AssetHoverTooltip, ClusterSelectionPopover, FeatureHoverTooltip } from "./overlays";
import SatelliteBasemapToggle from "./SatelliteBasemapToggle";
import MeasureToolButton from "./MeasureToolButton";
import { MapViewModeToggle } from "./MapViewModeToggle";

const MAP_LOAD_WATCHDOG_MS = 8000;
// Actor coordinates are marker centers. A 15% center inset leaves roughly 10%
// visible space at each edge after the marker body is included in the frame.
const SNAPSHOT_EDGE_PADDING_RATIO = 0.15;
const SNAPSHOT_MIN_EDGE_PADDING_PX = 48;
const SNAPSHOT_MAX_ZOOM = 20;
/**
 * How far in a surface may zoom unless it says otherwise.
 *
 * Two levels past the old 20, so the camera can get close enough to read a
 * single lane's geometry — checking that a car is where it should be within a
 * lane needs more than a road's worth of frame. Basemap raster tiles stop at
 * their own maximum and upscale from there; the road network and everything
 * authored on it are vector, and stay sharp all the way in.
 *
 * The scenario editor overrides it downward (`SCENARIO_EDITOR_MAX_ZOOM`), which
 * is worth knowing when reading the paragraph above: the surface that argument
 * was made for no longer takes the default.
 */
const MAX_MAP_ZOOM = 22;

type SnapshotCaptureContainer = HTMLDivElement & {
  prepareScenarioSnapshot?: () => Promise<() => Promise<void>>;
};

function waitForSnapshotMapSettle(map: import("maplibre-gl").Map) {
  return new Promise<void>((resolve) => {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      map.off("idle", finish);
      map.off("moveend", handleMoveEnd);
      window.clearTimeout(timeout);
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    };
    const handleMoveEnd = () => map.triggerRepaint();
    const timeout = window.setTimeout(finish, 1200);
    map.once("idle", finish);
    map.once("moveend", handleMoveEnd);
    map.triggerRepaint();
  });
}

type MapAssetsMapViewProps = {
  basemapId: BasemapId;
  basemapLayerVisibility: BasemapLayerVisibility;
  /** Satellite raster layers to drape over the basemap; null/empty renders the plain basemap. */
  satelliteImagery?: SatelliteImageryLayer[] | null;
  /** Render the Map/Satellite switch (only when the viewed asset has imagery). */
  showSatelliteToggle?: boolean;
  satelliteEnabled?: boolean;
  onSatelliteToggle?: (enabled: boolean) => void;
  /** Render the distance-measure toggle (map detail page only). */
  showMeasureTool?: boolean;
  measureActive?: boolean;
  onToggleMeasure?: () => void;
  /** Render the 2D/3D mode switch (scenario editor only). */
  showViewModeToggle?: boolean;
  /** True while the 3D renderer chunk is still downloading. */
  viewModeLoading?: boolean;
  /**
   * MSAA. Untriangulated car silhouettes 20 px across crawl badly without it.
   * MapLibre defaults this to `false` and only honours it at CONSTRUCTION time,
   * so it cannot be toggled with the mode — which is why it is opted into per
   * surface rather than turned on globally.
   */
  antialias?: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  initialViewState: { longitude: number; latitude: number; zoom: number };
  /**
   * Armed intersection placement: fade the basemap, the GL layers and every
   * non-candidate marker instead of hiding them. Street-camera mode hides the
   * authored AND runtime overlays, so you place a camera blind to what it will
   * watch; placing an intersection control while unable to see the traffic it
   * governs is the same mistake.
   */
  dimNonCandidateLayers?: boolean;
  interactionLocked: boolean;
  /**
   * This surface pans itself — keep MapLibre's cursor-anchored `dragPan` out of
   * the way. See `useHorizonSafeDragPan`: that handler is exact on a flat map and
   * degenerate under a pitched one, so a pitched surface replaces it rather than
   * layering on top of it. Both running at once doubles every delta.
   */
  horizonSafePan?: boolean;
  /**
   * Zoom floor, or undefined for MapLibre's own (0 — the whole world).
   *
   * MapLibre applies it to programmatic camera moves as well as gestures, so a
   * surface that sets it cannot be flown or fitted below it either.
   */
  minZoom?: number;
  /** Zoom ceiling, or undefined for this file's `MAX_MAP_ZOOM` default. */
  maxZoom?: number;
  onMapLoad: (evt: { target: import("maplibre-gl").Map }) => void;
  onMouseDown: (evt: MapLayerMouseEvent) => void;
  onMouseMove: (evt: MapLayerMouseEvent) => void;
  onMouseLeave: () => void;
  onClick: (evt: MapLayerMouseEvent) => void | Promise<void>;
  onContextMenu: (evt: MapLayerMouseEvent) => void;
  onZoomChange?: (zoom: number) => void;
  onUserViewportChange?: () => void;
  /** Fired with the visible WGS84 bounds on load and after EVERY move end
   *  (user or programmatic) — consumers that fetch per-viewport data key off
   *  what is actually visible, not off who moved the camera. */
  onViewportBoundsChange?: (bounds: {
    west: number;
    south: number;
    east: number;
    north: number;
  }) => void;
  /** Screen-space pointer feed used while MapLibre suppresses map mousemove
   *  events during an external palette/actor drag. */
  onLockedPointerPosition?: (
    point: {
      lng: number;
      lat: number;
      x: number;
      y: number;
      map: import("maplibre-gl").Map;
    } | null,
  ) => void;
  cursor: string;
  selectedAssetId: string | null | undefined;
  assetsLength: number;
  geojsonLoading?: boolean;
  onResetView: () => void;
  onMapError?: (message: string) => void;
  placementLayerAboveRuntimeRoad?: boolean;
  enableSnapshotCapture?: boolean;
  snapshotFocusPoints?: Array<{ longitude: number; latitude: number }>;
  hoverInfo: { count: number; name?: string } | null;
  hoverTooltipStyle?: CSSProperties;
  geojsonHoverInfo: { items: { id: number; summary: string }[] } | null;
  geojsonTooltipStyle?: CSSProperties;
  clusterAssets: MapAsset[] | null;
  clusterPosition: { x: number; y: number } | null;
  clusterPopoverStyle?: CSSProperties;
  onSelectAsset?: (id: string | null) => void;
  onCloseClusterPopover: () => void;
  children: ReactNode;
};

export function isUserInitiatedMapMove(event: {
  originalEvent?: unknown;
}): boolean {
  return event.originalEvent != null;
}

function visibleViewBounds(map: import("maplibre-gl").Map) {
  const bounds = map.getBounds();
  return {
    west: bounds.getWest(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    north: bounds.getNorth(),
  };
}

export function MapAssetsMapView({
  basemapId,
  basemapLayerVisibility = DEFAULT_BASEMAP_LAYER_VISIBILITY,
  satelliteImagery = null,
  showSatelliteToggle = false,
  satelliteEnabled = false,
  onSatelliteToggle,
  showMeasureTool = false,
  measureActive = false,
  onToggleMeasure,
  showViewModeToggle = false,
  viewModeLoading = false,
  antialias = false,
  containerRef,
  initialViewState,
  dimNonCandidateLayers = false,
  interactionLocked,
  horizonSafePan = false,
  minZoom,
  maxZoom,
  onMapLoad,
  onMouseDown,
  onMouseMove,
  onMouseLeave,
  onClick,
  onContextMenu,
  onZoomChange,
  onUserViewportChange,
  onViewportBoundsChange,
  onLockedPointerPosition,
  cursor,
  selectedAssetId,
  assetsLength,
  geojsonLoading,
  onResetView,
  onMapError,
  placementLayerAboveRuntimeRoad = false,
  enableSnapshotCapture = false,
  snapshotFocusPoints = [],
  hoverInfo,
  hoverTooltipStyle,
  geojsonHoverInfo,
  geojsonTooltipStyle,
  clusterAssets,
  clusterPosition,
  clusterPopoverStyle,
  onSelectAsset,
  onCloseClusterPopover,
  children,
}: MapAssetsMapViewProps) {
  const [resolvedMapStyle, setResolvedMapStyle] = useState<object | string>(
    BASEMAPS.find((entry) => entry.id === basemapId)!.url,
  );

  const mountLoggedRef = useRef(false);
  const mapLoadedRef = useRef(false);
  const mapRef = useRef<MapRef>(null);
  const interactionLockedRef = useRef(interactionLocked);
  interactionLockedRef.current = interactionLocked;

  useEffect(() => {
    const container = containerRef.current as SnapshotCaptureContainer | null;
    if (!container || !enableSnapshotCapture) return;
    container.prepareScenarioSnapshot = async () => {
      const map = mapRef.current?.getMap();
      if (!map || snapshotFocusPoints.length === 0) return async () => undefined;
      const original = {
        center: map.getCenter(),
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
      const lngs = snapshotFocusPoints.map((point) => point.longitude);
      const lats = snapshotFocusPoints.map((point) => point.latitude);
      const west = Math.min(...lngs);
      const east = Math.max(...lngs);
      const south = Math.min(...lats);
      const north = Math.max(...lats);
      const rect = container.getBoundingClientRect();
      const horizontalPadding = Math.max(
        SNAPSHOT_MIN_EDGE_PADDING_PX,
        Math.round(rect.width * SNAPSHOT_EDGE_PADDING_RATIO),
      );
      const verticalPadding = Math.max(
        SNAPSHOT_MIN_EDGE_PADDING_PX,
        Math.round(rect.height * SNAPSHOT_EDGE_PADDING_RATIO),
      );
      map.fitBounds([[west, south], [east, north]], {
        padding: {
          top: verticalPadding,
          right: horizontalPadding,
          bottom: verticalPadding,
          left: horizontalPadding,
        },
        duration: 0,
        maxZoom: SNAPSHOT_MAX_ZOOM,
      });
      await waitForSnapshotMapSettle(map);
      return async () => {
        map.jumpTo(original);
        await waitForSnapshotMapSettle(map);
      };
    };
    return () => {
      delete container.prepareScenarioSnapshot;
    };
  }, [containerRef, enableSnapshotCapture, snapshotFocusPoints]);

  useEffect(() => {
    if (!onLockedPointerPosition) return;
    const update = (event: PointerEvent | MouseEvent) => {
      if (!interactionLockedRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      const map = mapRef.current;
      if (
        !rect ||
        !map ||
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      ) {
        if (containerRef.current) {
          delete containerRef.current.dataset.lockedPointerLng;
          delete containerRef.current.dataset.lockedPointerLat;
        }
        onLockedPointerPosition(null);
        return;
      }
      // Guarded, not raw `unproject`: this feed is where a dragged actor's next
      // position comes from, and above the horizon MapLibre invents a coordinate
      // behind the camera rather than admitting there is no ground. Treat that
      // the same as the pointer leaving the canvas.
      const lngLat = unprojectGroundPoint(map, [
        event.clientX - rect.left,
        event.clientY - rect.top,
      ]);
      if (!lngLat) {
        if (containerRef.current) {
          delete containerRef.current.dataset.lockedPointerLng;
          delete containerRef.current.dataset.lockedPointerLat;
        }
        onLockedPointerPosition(null);
        return;
      }
      if (containerRef.current) {
        containerRef.current.dataset.lockedPointerLng = String(lngLat.lng);
        containerRef.current.dataset.lockedPointerLat = String(lngLat.lat);
      }
      onLockedPointerPosition({
        lng: lngLat.lng,
        lat: lngLat.lat,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        map: map.getMap(),
      });
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("mousemove", update);
    // Refresh the exact hit target during the capture phase so drag release
    // consumers cannot observe the previous mousemove's lane.
    window.addEventListener("pointerup", update, true);
    window.addEventListener("mouseup", update, true);
    return () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("mousemove", update);
      window.removeEventListener("pointerup", update, true);
      window.removeEventListener("mouseup", update, true);
    };
  }, [containerRef, onLockedPointerPosition]);

  useEffect(() => {
    let cancelled = false;

    resolveBasemapStyleWithImagery(basemapId, basemapLayerVisibility, satelliteImagery)
      .then((style) => {
        if (!cancelled) {
          setResolvedMapStyle(style);
        }
      })
      .catch((error) => {
        console.error("Failed to resolve basemap style:", error);
        if (!cancelled) {
          setResolvedMapStyle(BASEMAPS.find((entry) => entry.id === basemapId)!.url);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [basemapId, basemapLayerVisibility, satelliteImagery]);

  useEffect(() => {
    if (mountLoggedRef.current) return;
    mountLoggedRef.current = true;

    logMapMountDiagnostics({
      containerRect: containerRef.current?.getBoundingClientRect() ?? null,
      initialViewState,
      basemapId,
      resolvedStyle: resolvedMapStyle,
    });

    const watchdog = window.setTimeout(() => {
      if (!mapLoadedRef.current) logMapLoadTimeout();
    }, MAP_LOAD_WATCHDOG_MS);

    return () => window.clearTimeout(watchdog);
    // Intentionally one-shot on mount — captures the *initial* state for diagnostics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={containerRef}
      className={dimNonCandidateLayers ? "editor-map-dim-non-candidates" : undefined}
      data-map-interaction-locked={interactionLocked ? "true" : "false"}
      data-map-dim-non-candidates={dimNonCandidateLayers ? "true" : "false"}
      data-placement-layer-above-runtime-road={
        placementLayerAboveRuntimeRoad ? "true" : "false"
      }
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    >
      {selectedAssetId && assetsLength > 1 && (
        <button
          type="button"
          onClick={onResetView}
          style={{
            position: "absolute",
            top: "0.75rem",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
            padding: "0.3rem 0.85rem",
            background: `${C.bg}f2`,
            color: C.fg,
            border: `1px solid ${C.border}`,
            borderRadius: "999px",
            fontSize: "0.75rem",
            fontFamily: C.font,
            cursor: "pointer",
            boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            whiteSpace: "nowrap",
          }}
        >
          ← Show all maps
        </button>
      )}

      {geojsonLoading && (
        <div
          style={{
            position: "absolute",
            bottom: "0.75rem",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
            padding: "0.3rem 0.75rem",
            background: `${C.bg}e0`,
            color: C.muted,
            borderRadius: "999px",
            fontSize: "0.75rem",
            fontFamily: C.font,
            pointerEvents: "none",
            border: `1px solid ${C.border}`,
            whiteSpace: "nowrap",
          }}
        >
          Loading geometry…
        </div>
      )}

      {showSatelliteToggle && onSatelliteToggle && (
        <SatelliteBasemapToggle
          satelliteEnabled={satelliteEnabled}
          onChange={onSatelliteToggle}
        />
      )}

      {showMeasureTool && onToggleMeasure && (
        <MeasureToolButton active={measureActive} onToggle={onToggleMeasure} />
      )}

      {showViewModeToggle && <MapViewModeToggle loading={viewModeLoading} />}

      <Map
        ref={mapRef}
        mapStyle={resolvedMapStyle as never}
        dragPan={!interactionLocked && !horizonSafePan}
        doubleClickZoom={false}
        initialViewState={initialViewState}
        maxZoom={maxZoom ?? MAX_MAP_ZOOM}
        minZoom={minZoom}
        style={{ width: "100%", height: "100%" }}
        onLoad={(evt) => {
          mapLoadedRef.current = true;
          logMapLoadDiagnostics(evt.target);
          onMapLoad(evt);
          onViewportBoundsChange?.(visibleViewBounds(evt.target));
        }}
        onError={(event) => {
          // Missing tiles (e.g. sparse satellite coverage → 403 under the CDN's
          // OAC) are non-fatal: the canvas is healthy, only that tile is absent.
          // Don't log them as errors or flag the canvas as failed.
          if (isNonFatalTileLoadError(event.error)) return;
          const error = event.error as { message?: string } | undefined;
          const message = error?.message ?? "MapLibre failed to initialize the map canvas.";
          logMapError(message, event.error);
          onMapError?.(message);
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onMove={(event) => {
          onZoomChange?.(event.viewState.zoom);
          if (isUserInitiatedMapMove(event)) onUserViewportChange?.();
        }}
        onMoveEnd={(event) => {
          onViewportBoundsChange?.(visibleViewBounds(event.target));
        }}
        cursor={cursor}
        renderWorldCopies={false}
        preserveDrawingBuffer={enableSnapshotCapture}
        antialias={antialias}
      >
        {children}
      </Map>

      {hoverInfo != null && hoverTooltipStyle && (
        <AssetHoverTooltip style={hoverTooltipStyle} hoverInfo={hoverInfo} />
      )}

      {/* A hover with nothing to say draws nothing: hovering a driving lane
          still claims the hover (cursor, layer priority) but contributes no
          label, and an empty card is worse than no card. */}
      {geojsonHoverInfo != null &&
        geojsonHoverInfo.items.length > 0 &&
        geojsonTooltipStyle && (
          <FeatureHoverTooltip style={geojsonTooltipStyle} items={geojsonHoverInfo.items} />
        )}

      {clusterAssets != null && clusterPosition && clusterPopoverStyle && (
        <ClusterSelectionPopover
          style={clusterPopoverStyle}
          assets={clusterAssets}
          onSelectAsset={(id) => {
            onSelectAsset?.(id);
            onCloseClusterPopover();
          }}
          onClose={onCloseClusterPopover}
        />
      )}
    </div>
  );
}
