"use client";

import { useState, useRef, useCallback, useEffect, useImperativeHandle } from "react";
import { Camera, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { toast } from "sonner";
import type { MapAsset } from "@simcloud/shared";

type Props = {
  asset: MapAsset;
  hasThumbnail: boolean;
  /** Called after a thumbnail is successfully generated + registered so the parent can refresh. */
  onGenerated: () => void;
  /** When true, hide the button UI (used when trigger comes from an external menu). */
  hidden?: boolean;
  /** Called when busy state changes (for external UI indicators). */
  onBusyChange?: (busy: boolean) => void;
  /** Ref to imperatively trigger generation from outside. */
  triggerRef?: React.RefObject<{ generate: () => void } | null>;
};

type Status = "idle" | "loading-geojson" | "rendering" | "uploading" | "registering" | "done" | "error";

const STATUS_LABELS: Record<Status, string> = {
  idle: "",
  "loading-geojson": "Loading GeoJSON…",
  rendering: "Rendering map…",
  uploading: "Uploading thumbnail…",
  registering: "Registering artifact…",
  done: "Thumbnail generated",
  error: "Failed",
};

/** Compute SHA-256 hash of a blob in the browser; returns hex string. */
async function sha256HexBlob(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Button + offscreen renderer that generates a map thumbnail for an existing map asset.
 * Fetches the GeoJSON, renders via a hidden MapLibre canvas, captures a PNG, uploads to S3,
 * and registers it as a thumbnail artifact via PATCH.
 */
export function ThumbnailGenerator({ asset, hasThumbnail, onGenerated, hidden, onBusyChange, triggerRef }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset status when switching to a different map
  useEffect(() => {
    setStatus("idle");
    setError(null);
  }, [asset.map_asset_id]);

  const generate = useCallback(async () => {
    setStatus("loading-geojson");
    setError(null);

    try {
      // 1. Fetch GeoJSON
      const geojsonRes = await fetch(`/api/map-assets/${asset.map_asset_id}/geojson`, {
        redirect: "follow",
      });
      if (!geojsonRes.ok) throw new Error("Failed to load GeoJSON");
      const geojson = await geojsonRes.json();

      // 2. Render offscreen via MapLibre GL
      setStatus("rendering");
      const blob = await renderThumbnailOffscreen(geojson, asset.bbox, containerRef.current!);

      // 3. Upload to S3 via presigned URL
      setStatus("uploading");
      const sha256 = await sha256HexBlob(blob);

      const urlRes = await fetch("/api/map-assets/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mapAssetId: asset.map_asset_id,
          fileId: "thumbnail",
          filename: "thumbnail.png",
          contentType: "image/png",
        }),
      });
      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { url, key } = (await urlRes.json()) as { url: string; key: string };

      const putRes = await fetch(url, {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": "image/png" },
      });
      if (!putRes.ok) throw new Error(`S3 upload failed: ${putRes.status}`);

      // 4. Register the artifact via PATCH (remove old thumbnail first if exists)
      setStatus("registering");
      const oldThumbnailUri = asset.artifacts?.find((a) => a.artifact_type === "thumbnail")?.uri;
      const patchRes = await fetch(`/api/map-assets/${asset.map_asset_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(oldThumbnailUri ? { deleteArtifactUris: [oldThumbnailUri] } : {}),
          newArtifacts: [{ key, artifact_type: "thumbnail", sha256, size_bytes: blob.size }],
        }),
      });
      if (!patchRes.ok) throw new Error("Failed to register thumbnail artifact");

      setStatus("idle");
      toast.success("Thumbnail generated");
      onGenerated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
    }
  }, [asset, onGenerated]);

  const busy = status !== "idle" && status !== "error";

  // Expose generate function via ref for external triggers
  useImperativeHandle(triggerRef, () => ({ generate: () => void generate() }), [generate]);

  // Notify parent of busy state changes
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  if (hidden) {
    // Still need the offscreen container for rendering
    return (
      <div
        ref={containerRef}
        className="pointer-events-none fixed -left-[9999px] -top-[9999px]"
        style={{ width: 512, height: 512 }}
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={generate}
          className="gap-1.5 text-xs"
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Camera className="size-3" />
          )}
          {hasThumbnail ? "Regenerate thumbnail" : "Generate thumbnail"}
        </Button>
        {busy && (
          <span className="text-[10px] text-muted-foreground">{STATUS_LABELS[status]}</span>
        )}
        {status === "error" && (
          <span className="flex items-center gap-1 text-[10px] text-destructive">
            <AlertCircle className="size-3" />
            {error}
          </span>
        )}
      </div>
      {/* Hidden container for offscreen MapLibre rendering (square for card thumbnails) */}
      <div
        ref={containerRef}
        className="pointer-events-none fixed -left-[9999px] -top-[9999px]"
        style={{ width: 512, height: 512 }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Offscreen MapLibre rendering
// ---------------------------------------------------------------------------

type Bbox = { min_lat: number; min_lng: number; max_lat: number; max_lng: number };

async function renderThumbnailOffscreen(
  geojson: object,
  bbox: Bbox,
  container: HTMLElement,
): Promise<Blob> {
  // Dynamic import to avoid SSR issues
  const maplibregl = await import("maplibre-gl");
  const { ROAD_NETWORK_FEATURE_TYPES, DEFAULT_ENABLED_FEATURE_TYPE_IDS } = await import(
    "@/app/lib/maps/frontend/road-network-feature-types"
  );

  return new Promise<Blob>((resolve, reject) => {
    const map = new maplibregl.Map({
      container,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      bounds: [
        [bbox.min_lng, bbox.min_lat],
        [bbox.max_lng, bbox.max_lat],
      ],
      fitBoundsOptions: { padding: 60 },
      attributionControl: false,
      preserveDrawingBuffer: true,
      interactive: false,
    });

    const timeout = setTimeout(() => {
      map.remove();
      reject(new Error("Map render timed out"));
    }, 30_000);

    map.on("load", () => {
      map.addSource("thumb-geojson", {
        type: "geojson",
        data: geojson as GeoJSON.FeatureCollection,
      });

      const enabledTypes = ROAD_NETWORK_FEATURE_TYPES.filter((ft) =>
        DEFAULT_ENABLED_FEATURE_TYPE_IDS.includes(ft.id),
      );

      for (const ft of enabledTypes) {
        if (ft.geometryRendering === "fill") {
          map.addLayer({
            id: `thumb-fill-${ft.id}`,
            source: "thumb-geojson",
            type: "fill",
            filter: ft.filter as never,
            paint: { "fill-color": ft.color, "fill-opacity": 0.3 },
          });
          map.addLayer({
            id: `thumb-outline-${ft.id}`,
            source: "thumb-geojson",
            type: "line",
            filter: ft.filter as never,
            paint: { "line-color": ft.color, "line-width": 1.5, "line-opacity": 0.8 },
          });
        } else {
          map.addLayer({
            id: `thumb-line-${ft.id}`,
            source: "thumb-geojson",
            type: "line",
            filter: ft.filter as never,
            paint: {
              "line-color": ft.color,
              "line-width": ft.id === "lane_boundaries" ? 1 : 2,
              "line-opacity": ft.id === "lane_boundaries" ? 0.4 : 0.85,
            },
          });
        }
      }

      // Wait for idle (all tiles + layers painted)
      map.once("idle", () => {
        setTimeout(() => {
          const canvas = map.getCanvas();
          canvas.toBlob(
            (blob) => {
              clearTimeout(timeout);
              map.remove();
              if (blob) {
                resolve(blob);
              } else {
                reject(new Error("Canvas toBlob returned null"));
              }
            },
            "image/png",
          );
        }, 300);
      });
    });

    map.on("error", (e) => {
      clearTimeout(timeout);
      map.remove();
      reject(new Error(`Map error: ${e.error?.message ?? "unknown"}`));
    });
  });
}
