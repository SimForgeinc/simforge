import type { MapOverlayLayerId } from "@simforge-oss/studio-shared";

/** Theme color tokens used across map layers. */
export const C = {
  bg: "#0a0a0a",
  fg: "#fafafa",
  card: "#171717",
  border: "#262626",
  muted: "#a3a3a3",
  selected: "#facc15",
  selectedBg: "#0a0a0a",
  highlighted: "#38bdf8",
  /**
   * Secondary highlight for objects that are spatially *related* to the
   * currently-focused search result (e.g. the POI that a "near" query
   * matched against). Same hue as `highlighted` but dimmer so the primary
   * subject stays visually dominant.
   */
  related: "#60a5fa",
  highlightPrimary: "hsl(221.2, 83.2%, 53.3%)",
  font: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
} as const;

/**
 * Enrichment overlay layers that are enabled by default the first time
 * enrichment lands for an asset (only those that actually carry features).
 * Other layers stay off until the user toggles them on.
 */
export const DEFAULT_ENABLED_OVERLAY_LAYER_IDS: MapOverlayLayerId[] = [
  "bus_stops",
  "schools",
  "gas_stations",
  "hospitals",
  "transit_stop",
  // Pedestrian-infrastructure overlays. Their visualization was recently
  // improved, so they ship on by default alongside the in-house road-network
  // sidewalk/bike/parking lanes and the in-house crosswalk signal overlay.
  "sidewalks",
  "crosswalks",
];

/** Visual styles for each enrichment overlay layer type. */
export const OVERLAY_STYLES: Record<
  MapOverlayLayerId,
  { color: string; fill: string; radius: number; opacity: number }
> = {
  bus_stops:      { color: "#60a5fa", fill: "#60a5fa", radius: 5, opacity: 0.9 },
  schools:        { color: "#34d399", fill: "#34d399", radius: 6, opacity: 0.85 },
  hospitals:      { color: "#f87171", fill: "#f87171", radius: 6, opacity: 0.85 },
  gas_stations:   { color: "#fbbf24", fill: "#fbbf24", radius: 5, opacity: 0.85 },
  parking_lots:   { color: "#c084fc", fill: "#c084fc", radius: 5, opacity: 0.85 },
  retail:         { color: "#f472b6", fill: "#f472b6", radius: 5, opacity: 0.8 },
  restaurant:     { color: "#fb923c", fill: "#fb923c", radius: 5, opacity: 0.8 },
  hotel:          { color: "#a78bfa", fill: "#a78bfa", radius: 5, opacity: 0.8 },
  airport:        { color: "#22d3ee", fill: "#22d3ee", radius: 7, opacity: 0.9 },
  shopping_mall:  { color: "#ec4899", fill: "#ec4899", radius: 6, opacity: 0.85 },
  transit_stop:   { color: "#3b82f6", fill: "#3b82f6", radius: 5, opacity: 0.9 },
  crosswalks:     { color: "#06d6a0", fill: "#06d6a0", radius: 4, opacity: 0.65 },
  // Sidewalks render as a softer, lighter green than crosswalks so the two
  // pedestrian layers are visually distinct when both are toggled on.
  // Radius is unused for LineString but kept consistent with crosswalks.
  sidewalks:      { color: "#4ade80", fill: "#4ade80", radius: 4, opacity: 0.55 },
  // Address points are dense and informational — render small + faint so
  // they don't dominate the visual when a user toggles the layer on.
  addresses:      { color: "#94a3b8", fill: "#94a3b8", radius: 2, opacity: 0.55 },
  // Building footprints are large polygons — outline-heavy with a low
  // fill alpha so underlying road geometry stays legible. Radius is
  // unused for Polygon layers but kept positive to satisfy the shared
  // OVERLAY_STYLES invariant (matches parking_lots, also a Polygon).
  buildings:      { color: "#737373", fill: "#737373", radius: 1, opacity: 0.18 },
};
