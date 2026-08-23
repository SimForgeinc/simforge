import type { MapAsset } from "@simcloud/shared";
import { getMapAssetDescriptorTag } from "@simcloud/shared";

// ---------------------------------------------------------------------------
// Shared, pure derivation logic for the map-asset cards (catalog grid card and
// the map-view list rail) and the map-asset detail page. Kept free of React so
// it can be unit-tested and reused across surfaces without drift.
// ---------------------------------------------------------------------------

/** A deployable CARLA runtime bundle artifact exists for this map. */
export function hasRuntimeBundle(asset: MapAsset): boolean {
  return (asset.artifacts ?? []).some((a) => a.artifact_type === "runtime_bundle");
}

/**
 * Map is simulation-ready: it has a generated runtime bundle AND a CARLA map
 * name. Both are required — the bundle is the deployable artifact and the
 * carla_map_name names the map inside CARLA. This is the single gate for
 * activating the scenarios tab on the detail page and the "Sim" card hint.
 */
export function isSimulationReady(asset: MapAsset): boolean {
  return hasRuntimeBundle(asset) && !!asset.carla_map_name?.trim();
}

/** Capability hints surfaced as always-present (highlighted/dimmed) icons. */
export interface MapCapabilities {
  /** A renderable 3D model bundle exists for this map. */
  has3d: boolean;
  /** Map is simulation-ready (runtime bundle + CARLA map name). See isSimulationReady. */
  simReady: boolean;
}

export function getMapCapabilities(asset: MapAsset): MapCapabilities {
  const has3d = (asset.artifacts ?? []).some((a) => a.artifact_type === "3d_manifest");
  return { has3d, simReady: isSimulationReady(asset) };
}

// ---------------------------------------------------------------------------
// Quick stats
// ---------------------------------------------------------------------------

export type CardStatIconKey =
  | "route"
  | "junction"
  | "signal"
  | "stop"
  | "bike"
  | "sidewalk"
  | "crosswalk"
  | "bus";

export interface CardStat {
  /** Stable key for React lists. */
  key: string;
  icon: CardStatIconKey;
  /** Pre-formatted display value (e.g. "12.3 km" or "40"). */
  value: string;
  /** Full label for a hover tooltip. */
  tooltip: string;
}

function km(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Ordered quick-stats for a card. The original three (mileage, junctions,
 * signal/stop junctions) come first, followed by VRU (vulnerable-road-user)
 * stats. Any stat that is null or non-positive is omitted so each card only
 * shows what the map actually has.
 */
export function getCardStats(asset: MapAsset): CardStat[] {
  const rn = asset.map_stats?.road_network;
  const fi = asset.map_stats?.feature_inventory;
  const stats: CardStat[] = [];

  const centerlineLengthM = rn?.total_centerline_length_m;
  if (centerlineLengthM != null && centerlineLengthM > 0) {
    stats.push({ key: "mileage", icon: "route", value: km(centerlineLengthM), tooltip: "Road network length" });
  }

  const junctions = fi?.junctions?.total ?? rn?.total_junctions;
  if (junctions != null && junctions > 0) {
    stats.push({ key: "junctions", icon: "junction", value: `${junctions} jct`, tooltip: "Junctions" });
  }

  // Prefer signalized junctions, fall back to stop-sign-controlled junctions.
  const signalized = fi?.junctions?.signalized;
  const stopControlled = fi?.junctions?.stop_sign_controlled;
  if (signalized != null && signalized > 0) {
    stats.push({ key: "signal", icon: "signal", value: `${signalized} signal jct`, tooltip: "Signalized junctions" });
  } else if (stopControlled != null && stopControlled > 0) {
    stats.push({ key: "stop", icon: "stop", value: `${stopControlled} stop jct`, tooltip: "Stop-controlled junctions" });
  }

  // ── VRU infrastructure ───────────────────────────────────────────────────
  const bikeLaneM = rn?.bike_lane_length_m;
  if (bikeLaneM != null && bikeLaneM > 0) {
    stats.push({ key: "bike", icon: "bike", value: km(bikeLaneM), tooltip: "Bike-lane coverage" });
  }

  const sidewalkM = rn?.sidewalk_length_m;
  if (sidewalkM != null && sidewalkM > 0) {
    stats.push({ key: "sidewalk", icon: "sidewalk", value: km(sidewalkM), tooltip: "Sidewalk coverage" });
  }

  const crosswalks = fi?.crosswalks?.total ?? rn?.crosswalk_count;
  if (crosswalks != null && crosswalks > 0) {
    stats.push({ key: "crosswalk", icon: "crosswalk", value: `${crosswalks}`, tooltip: "Crosswalks" });
  }

  const busStops =
    fi?.bus_stops ?? rn?.signal_breakdown?.bus_stops ?? asset.enrichment_summary?.feature_counts?.bus_stops;
  if (busStops != null && busStops > 0) {
    stats.push({ key: "bus", icon: "bus", value: `${busStops}`, tooltip: "Bus stops" });
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Dominant tag ranking (hybrid: within-map feature share, priority fallback)
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<string, number> = { High: 3, Medium: 2, Low: 1 };

/**
 * Within-map prevalence share [0..1] for a tag whose presence is backed by a
 * countable stat (e.g. signalized junctions / total junctions). Returns
 * `undefined` when the tag has no countable backing stat or the backing
 * feature is absent (count 0) — those fall back to taxonomy priority.
 */
function tagShare(tagId: string, asset: MapAsset): number | undefined {
  const rn = asset.map_stats?.road_network;
  const fi = asset.map_stats?.feature_inventory;
  const totalJunctions = fi?.junctions?.total ?? rn?.total_junctions;
  const totalLengthM = rn?.total_centerline_length_m;

  const share = (num: number | undefined, den: number | undefined): number | undefined => {
    if (num == null || num <= 0 || den == null || den <= 0) return undefined;
    return Math.min(num / den, 1);
  };

  switch (tagId) {
    case "INTERSECTION_SIGNALIZED":
      return share(fi?.junctions?.signalized, totalJunctions);
    case "INTERSECTION_ALL_WAY_STOP":
      return share(fi?.junctions?.allway_stop, totalJunctions);
    case "INTERSECTION_TWO_WAY_STOP": {
      // stop_sign_controlled is a superset that also counts all-way stops; use
      // the exclusive two-way count so all-way-stop-heavy maps don't inflate it.
      const stopControlled = fi?.junctions?.stop_sign_controlled;
      const twoWayOnly =
        stopControlled != null ? Math.max(stopControlled - (fi?.junctions?.allway_stop ?? 0), 0) : undefined;
      return share(twoWayOnly, totalJunctions);
    }
    case "INTERSECTION_COMPLEX_MULTI_LEG":
      return share(rn?.junction_road_degree_counts?.["5_plus"], totalJunctions);
    case "INTERSECTION_T_YIELD":
      return share(rn?.junction_road_degree_counts?.["3"], totalJunctions);
    case "INTERSECTION_UNCONTROLLED": {
      if (totalJunctions == null || totalJunctions <= 0) return undefined;
      const controlled = (fi?.junctions?.signalized ?? 0) + (fi?.junctions?.stop_sign_controlled ?? 0);
      return share(Math.max(totalJunctions - controlled, 0), totalJunctions);
    }
    case "BIKE_LANE_SHARED_ROADWAY":
      return share(rn?.shared_bike_lane_length_m, totalLengthM);
    case "BIKE_LANE_PROTECTED":
    case "BIKE_LANE_STANDARD":
      return share(rn?.bike_lane_length_m, totalLengthM);
    case "SIDEWALK_PEDESTRIAN_NETWORK":
      return share(rn?.sidewalk_length_m, totalLengthM);
    case "NARROW_RESIDENTIAL_STREET_WITH_PARKING":
      return share(rn?.parking_lane_length_m, totalLengthM);
    case "ROAD_GRADE_CREST_ELEVATION_CHANGE":
      return share(rn?.length_above_4pct_grade_m, totalLengthM);
    case "CROSSWALK_MARKED_SIGNALIZED":
      return share(fi?.crosswalks?.signalized, fi?.crosswalks?.total);
    case "CROSSWALK_MARKED_UNSIGNALIZED":
      return share(fi?.crosswalks?.unsignalized, fi?.crosswalks?.total);
    default:
      return undefined;
  }
}

/**
 * Rank a map's tags by how dominant they are in *this* map. Two tiers:
 *   1. Tags backed by a countable stat, ordered by within-map share (desc),
 *      taxonomy priority breaking ties.
 *   2. Tags with no countable backing, ordered by taxonomy priority (desc).
 * Ties within a tier are broken alphabetically for stable output.
 */
export function rankDominantTags(asset: MapAsset): string[] {
  const tags = asset.tags ?? [];
  return [...tags]
    .map((id) => ({
      id,
      share: tagShare(id, asset),
      priority: PRIORITY_RANK[getMapAssetDescriptorTag(id)?.priority ?? "Low"] ?? 1,
    }))
    .sort((a, b) => {
      const aMapped = a.share != null;
      const bMapped = b.share != null;
      if (aMapped !== bMapped) return aMapped ? -1 : 1;
      if (aMapped && bMapped && a.share !== b.share) return b.share! - a.share!;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.id.localeCompare(b.id);
    })
    .map((t) => t.id);
}

/** Human-friendly tag label, e.g. "INTERSECTION_SIGNALIZED" -> "Intersection Signalized". */
export function humanizeTag(tagId: string): string {
  return tagId
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
