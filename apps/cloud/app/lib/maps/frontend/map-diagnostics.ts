/**
 * Diagnostics for MapAssetsMap. Emits a single structured `[map-diagnostics]`
 * log per mount so we can capture WebGL/sizing/style state from devices where
 * the 2D map silently fails to render.
 */

import { probeWebGL } from "@/app/lib/diagnostics/gpu-probe";

const LOG_PREFIX = "[map-diagnostics]";

export type MapMountDiagnosticsContext = {
  containerRect: DOMRect | null;
  initialViewState: { longitude: number; latitude: number; zoom: number };
  basemapId: string;
  resolvedStyle: object | string;
};

export function logMapMountDiagnostics(ctx: MapMountDiagnosticsContext): void {
  const webgl = probeWebGL();
  const initialViewStateValid =
    Number.isFinite(ctx.initialViewState.longitude) &&
    Number.isFinite(ctx.initialViewState.latitude) &&
    Number.isFinite(ctx.initialViewState.zoom);

  console.info(LOG_PREFIX, "mount", {
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    viewport:
      typeof window !== "undefined" ? { w: window.innerWidth, h: window.innerHeight } : null,
    container: ctx.containerRect
      ? { w: Math.round(ctx.containerRect.width), h: Math.round(ctx.containerRect.height) }
      : "unmeasured",
    initialViewState: ctx.initialViewState,
    initialViewStateValid,
    basemapId: ctx.basemapId,
    basemapStyleType: typeof ctx.resolvedStyle === "string" ? "url" : "inline",
    basemapStyleUrl: typeof ctx.resolvedStyle === "string" ? ctx.resolvedStyle : null,
    webgl,
  });
}

export function logMapLoadDiagnostics(map: import("maplibre-gl").Map): void {
  let canvasSize: { w: number; h: number } | null = null;
  try {
    const canvas = map.getCanvas();
    canvasSize = { w: canvas.width, h: canvas.height };
  } catch {
    /* noop */
  }

  let containerSize: { w: number; h: number } | null = null;
  try {
    const container = map.getContainer();
    containerSize = { w: container.clientWidth, h: container.clientHeight };
  } catch {
    /* noop */
  }

  console.info(LOG_PREFIX, "loaded", {
    canvasSize,
    containerSize,
    pixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    styleLoaded: map.isStyleLoaded(),
  });
}

export function logMapLoadTimeout(): void {
  console.warn(
    LOG_PREFIX,
    "MapLibre did not fire onLoad within 8s — likely WebGL context creation, network, or sizing failure. Check `mount` log above for webgl.webgl2/false, container w/h of 0, or contextCreationError.",
  );
}

export function logMapError(message: string, raw?: unknown): void {
  console.error(LOG_PREFIX, "error", { message, raw });
}

// Matches an XYZ tile path: .../{z}/{x}/{y}.ext (optionally @2x, with a query).
const TILE_URL_RE = /\/\d+\/\d+\/\d+(@\d+x)?\.\w+(\?.*)?$/;

/**
 * MapLibre fires a map-level `error` event for individual tile fetch failures,
 * but those are NON-FATAL — the map renders fine without that tile. Satellite
 * tilesets in particular have sparse coverage within a map's bbox, so missing
 * tiles legitimately return 403 (not 404) under the CDN's OAC. Detect these
 * (an AJAXError carrying an HTTP status for a tile URL) so callers don't treat
 * them as a canvas failure. Style/glyph/sprite load errors don't match and stay
 * fatal.
 */
export function isNonFatalTileLoadError(raw: unknown): boolean {
  const err = raw as { status?: number; url?: string } | undefined;
  return (
    typeof err?.status === "number" &&
    typeof err?.url === "string" &&
    TILE_URL_RE.test(err.url)
  );
}
