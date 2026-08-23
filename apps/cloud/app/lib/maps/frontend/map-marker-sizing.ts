export type MapMarkerSizingMode = "screen" | "map";

const EARTH_CIRCUMFERENCE_METERS = 40075016.68557849;
const MAPLIBRE_TILE_SIZE_PX = 512;
const MAX_WEB_MERCATOR_LATITUDE = 85.05112878;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function finiteOr(value: number | null | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function metersPerScreenPixelAtZoom({
  latitude,
  zoom,
}: {
  latitude: number;
  zoom: number;
}) {
  const safeLatitude = clamp(
    finiteOr(latitude, 0),
    -MAX_WEB_MERCATOR_LATITUDE,
    MAX_WEB_MERCATOR_LATITUDE,
  );
  const safeZoom = clamp(finiteOr(zoom, 0), 0, 24);
  return (
    (Math.cos((safeLatitude * Math.PI) / 180) *
      EARTH_CIRCUMFERENCE_METERS) /
    (MAPLIBRE_TILE_SIZE_PX * 2 ** safeZoom)
  );
}

export function resolveMapMarkerScale({
  mode,
  basePixelSize,
  worldSizeMeters,
  latitude,
  zoom,
  userScale = 1,
  minPixelSize,
  maxPixelSize,
}: {
  mode: MapMarkerSizingMode;
  basePixelSize: number;
  worldSizeMeters: number;
  latitude: number;
  zoom: number | null | undefined;
  userScale?: number;
  minPixelSize: number;
  maxPixelSize: number;
}) {
  const safeUserScale = clamp(finiteOr(userScale, 1), 0.05, 6);
  const safeBasePixelSize = Math.max(finiteOr(basePixelSize, 1), 1);

  if (mode === "screen" || zoom == null || !Number.isFinite(zoom)) {
    return safeUserScale;
  }

  const metersPerPixel = metersPerScreenPixelAtZoom({
    latitude,
    zoom,
  });
  const unclampedPixelSize = Math.max(worldSizeMeters / metersPerPixel, 0);
  const pixelSize = clamp(unclampedPixelSize, minPixelSize, maxPixelSize);

  return (pixelSize / safeBasePixelSize) * safeUserScale;
}
