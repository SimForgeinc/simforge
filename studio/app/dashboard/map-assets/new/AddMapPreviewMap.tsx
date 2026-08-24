"use client";

import { useEffect, useRef, useCallback } from "react";
import Map, { Source, Layer, type MapRef } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  ROAD_NETWORK_FEATURE_TYPES,
  DEFAULT_ENABLED_FEATURE_TYPE_IDS,
} from "@/app/lib/maps/frontend/road-network-feature-types";

const DARK_BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

type Bbox = { min_lat: number; min_lng: number; max_lat: number; max_lng: number };

type Props = {
  geojson: object | null;
  bbox: Bbox | null;
  onThumbnailReady?: (blob: Blob) => void;
};

function fitToBbox(map: MapRef, bbox: Bbox) {
  map.fitBounds(
    [
      [bbox.min_lng, bbox.min_lat],
      [bbox.max_lng, bbox.max_lat],
    ],
    { padding: 60, duration: 600 }
  );
}

export default function AddMapPreviewMap({ geojson, bbox, onThumbnailReady }: Props) {
  const mapRef = useRef<MapRef>(null);
  const bboxRef = useRef<Bbox | null>(bbox);
  bboxRef.current = bbox;

  const onThumbnailReadyRef = useRef(onThumbnailReady);
  onThumbnailReadyRef.current = onThumbnailReady;

  // Track whether we've already captured for the current geojson+bbox combo.
  const capturedForRef = useRef<string | null>(null);

  // Build a stable key from the bbox to detect when we need a new capture.
  const bboxKey = bbox
    ? `${bbox.min_lat},${bbox.min_lng},${bbox.max_lat},${bbox.max_lng}`
    : null;

  // When bbox changes, mark capture as stale so the next idle fires a new capture.
  useEffect(() => {
    if (!bbox || !mapRef.current) return;
    capturedForRef.current = null;
    fitToBbox(mapRef.current, bbox);
  }, [bbox]);

  // Capture the canvas and call the callback.
  const captureThumbnail = useCallback(() => {
    const map = mapRef.current;
    const cb = onThumbnailReadyRef.current;
    if (!map || !cb || !bboxKey) return;
    if (capturedForRef.current === bboxKey) return; // Already captured for this bbox
    capturedForRef.current = bboxKey;

    const canvas = map.getCanvas();
    canvas.toBlob(
      (blob) => {
        if (blob) {
          console.log("[AddMapPreviewMap] Thumbnail captured:", blob.size, "bytes");
          onThumbnailReadyRef.current?.(blob);
        }
      },
      "image/png",
    );
  }, [bboxKey]);

  // Use react-map-gl's onIdle prop callback — this fires reliably every time
  // the map finishes rendering (including after source/layer changes).
  const handleIdle = useCallback(() => {
    if (!geojson || !bboxKey) return;
    // Delay slightly to ensure all layers are painted after the idle event.
    setTimeout(captureThumbnail, 600);
  }, [geojson, bboxKey, captureThumbnail]);

  function handleMapLoad() {
    if (bboxRef.current && mapRef.current) {
      fitToBbox(mapRef.current, bboxRef.current);
    }
  }

  const enabledTypes = ROAD_NETWORK_FEATURE_TYPES.filter((ft) =>
    DEFAULT_ENABLED_FEATURE_TYPE_IDS.includes(ft.id),
  );

  return (
    <Map
      ref={mapRef}
      mapStyle={DARK_BASEMAP}
      initialViewState={{ longitude: 0, latitude: 20, zoom: 1 }}
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      attributionControl={false}
      preserveDrawingBuffer
      onLoad={handleMapLoad}
      onIdle={handleIdle}
    >
      {geojson && (
        <Source id="preview-geojson" type="geojson" data={geojson as GeoJSON.FeatureCollection}>
          {enabledTypes.flatMap((ft) =>
            ft.geometryRendering === "fill"
              ? [
                  <Layer
                    key={`fill-${ft.id}`}
                    id={`preview-fill-${ft.id}`}
                    type="fill"
                    filter={ft.filter as never}
                    paint={{
                      "fill-color": ft.color,
                      "fill-opacity": 0.3,
                    }}
                  />,
                  <Layer
                    key={`outline-${ft.id}`}
                    id={`preview-outline-${ft.id}`}
                    type="line"
                    filter={ft.filter as never}
                    paint={{
                      "line-color": ft.color,
                      "line-width": 1.5,
                      "line-opacity": 0.8,
                    }}
                  />,
                ]
              : [
                  <Layer
                    key={ft.id}
                    id={`preview-line-${ft.id}`}
                    type="line"
                    filter={ft.filter as never}
                    paint={{
                      "line-color": ft.color,
                      "line-width": ft.id === "lane_boundaries" ? 1 : 2,
                      "line-opacity": ft.id === "lane_boundaries" ? 0.4 : 0.85,
                    }}
                  />,
                ],
          )}
        </Source>
      )}
    </Map>
  );
}
