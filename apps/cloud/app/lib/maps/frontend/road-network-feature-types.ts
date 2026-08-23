/**
 * Registry of toggleable road-network feature types derived from RoadRunner/OpenDRIVE GeoJSON exports.
 *
 * Each entry defines a MapLibre filter expression used for GPU-side feature filtering,
 * a ColorBrewer-safe colour for the map + panel dot, and a render hint (line vs fill).
 *
 * The array is ordered bottom-to-top for map layer rendering (first = lowest z-order).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All known road-network feature type identifiers, ordered by map z-order. */
// Crosswalks intentionally aren't here. The default RoadRunner GeoJSON export
// only emits Type="Crosswalk" features for ~2 of our 7 maps, so the toggle
// looked broken everywhere else. Crosswalks are now mined from the XODR (via
// xodr-signals.ts) and rendered from the intersection-elements overlay
// alongside signals — see road-network-feature-types.ts § Crosswalks moved.
export const ROAD_NETWORK_FEATURE_TYPE_IDS = [
  "junctions",
  "surfaces",
  "parking_spaces",
  "lanes_driving",
  "lanes_sidewalk",
  "lanes_biking",
  "lanes_parking",
  "lanes_curb",
  "lanes_shoulder",
  "lanes_restricted",
  "lanes_center_turn",
  "lanes_median",
  "lanes_tram",
  "lanes_other",
  "lane_boundaries",
  "gates",
] as const;

/** Union type of valid road-network feature type identifiers. */
export type RoadNetworkFeatureTypeId = (typeof ROAD_NETWORK_FEATURE_TYPE_IDS)[number];

/** Mutable array copy of all feature type IDs for use in toggle-all operations. */
export const ALL_FEATURE_TYPE_IDS: RoadNetworkFeatureTypeId[] = [...ROAD_NETWORK_FEATURE_TYPE_IDS];


/** Describes a toggleable road-network feature type with rendering and filter metadata. */
export interface RoadNetworkFeatureType {
  id: RoadNetworkFeatureTypeId;
  label: string;
  /** ColorBrewer-safe colour used on the map and as the panel dot. */
  color: string;
  /** MapLibre expression-filter that selects features of this type. */
  filter: unknown[];
  /** Primary geometry rendering mode. "fill" types also get a thin outline layer. */
  geometryRendering: "line" | "fill";
  /** Whether this layer is enabled by default when a map is selected. Default true. */
  defaultEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Registry (ordered bottom → top for map z-order)
// ---------------------------------------------------------------------------

/**
 * Well-known LaneType values that get their own toggle. Everything else falls into "lanes_other".
 * RoadRunner exports use both lowercase and PascalCase, so we match both. The values here are the
 * exhaustive set seen across our current map corpus; "lanes_other" remains a catch-all for any
 * future/unknown type.
 */
const KNOWN_LANE_TYPES = [
  "driving", "Driving",
  "sidewalk", "Sidewalk",
  "biking", "Biking",
  "parking", "Parking",
  "curb", "Curb",
  "shoulder", "Shoulder",
  "restricted", "Restricted",
  "center turn", "Center Turn",
  "median", "Median",
  "tram", "Tram",
];

/** Ordered registry of road-network feature types for map rendering and panel display. */
export const ROAD_NETWORK_FEATURE_TYPES: RoadNetworkFeatureType[] = [
  {
    id: "junctions",
    label: "Junctions",
    color: "#e31a1c",
    filter: ["==", ["get", "Type"], "Junction"],
    geometryRendering: "fill",
    defaultEnabled: false,
  },
  {
    id: "surfaces",
    label: "Surfaces",
    color: "#a3a3a3",
    filter: ["==", ["get", "Type"], "Surface"],
    geometryRendering: "fill",
    defaultEnabled: false,
  },
  {
    id: "parking_spaces",
    label: "Parking Spaces",
    color: "#ff7f00",
    filter: ["==", ["get", "Type"], "ParkingSpace"],
    geometryRendering: "fill",
  },
  {
    id: "lanes_driving",
    label: "Driving Lanes",
    color: "#1f78b4",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["driving", "Driving"]]],
    ],
    geometryRendering: "line",
  },
  {
    id: "lanes_sidewalk",
    label: "Sidewalks",
    color: "#a6cee3",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["sidewalk", "Sidewalk"]]],
    ],
    geometryRendering: "line",
  },
  {
    id: "lanes_biking",
    label: "Bike Lanes",
    color: "#33a02c",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["biking", "Biking"]]],
    ],
    geometryRendering: "line",
  },
  {
    id: "lanes_parking",
    label: "Parking Lanes",
    color: "#fdbf6f",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["parking", "Parking"]]],
    ],
    geometryRendering: "line",
  },
  {
    id: "lanes_curb",
    label: "Curbs",
    color: "#b15928",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["curb", "Curb"]]],
    ],
    geometryRendering: "line",
    defaultEnabled: false,
  },
  {
    id: "lanes_shoulder",
    label: "Shoulders",
    color: "#fb9a99",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["shoulder", "Shoulder"]]],
    ],
    geometryRendering: "line",
    defaultEnabled: false,
  },
  {
    id: "lanes_restricted",
    label: "Restricted Lanes",
    color: "#6a3d9a",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["restricted", "Restricted"]]],
    ],
    geometryRendering: "line",
    defaultEnabled: false,
  },
  {
    id: "lanes_center_turn",
    label: "Center Turn Lanes",
    color: "#e6ab02",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["center turn", "Center Turn"]]],
    ],
    geometryRendering: "line",
    defaultEnabled: false,
  },
  {
    id: "lanes_median",
    label: "Medians",
    color: "#e7298a",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["median", "Median"]]],
    ],
    geometryRendering: "line",
    defaultEnabled: false,
  },
  {
    id: "lanes_tram",
    label: "Tram Lanes",
    color: "#66c2a5",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["in", ["get", "LaneType"], ["literal", ["tram", "Tram"]]],
    ],
    geometryRendering: "line",
    defaultEnabled: false,
  },
  {
    id: "lanes_other",
    label: "Other Lanes",
    color: "#b2df8a",
    filter: [
      "all",
      ["==", ["get", "Type"], "Lane"],
      ["!", ["in", ["get", "LaneType"], ["literal", KNOWN_LANE_TYPES]]],
    ],
    geometryRendering: "line",
    defaultEnabled: false,
  },
  {
    id: "lane_boundaries",
    label: "Lane Boundaries",
    color: "#636363",
    filter: ["==", ["get", "Type"], "LaneBoundary"],
    geometryRendering: "line",
    defaultEnabled: false,
  },
  {
    id: "gates",
    label: "Gates (Turns)",
    color: "#cab2d6",
    filter: ["==", ["get", "Type"], "Gate"],
    geometryRendering: "line",
    defaultEnabled: false,
  },
];

/** Feature types enabled by default when a map is first selected. */
export const DEFAULT_ENABLED_FEATURE_TYPE_IDS: RoadNetworkFeatureTypeId[] =
  ROAD_NETWORK_FEATURE_TYPES
    .filter((ft) => ft.defaultEnabled !== false)
    .map((ft) => ft.id);

// Lookup map for fast access by id
const BY_ID = new Map(ROAD_NETWORK_FEATURE_TYPES.map((ft) => [ft.id, ft]));
/** Look up a road-network feature type definition by its ID. */
export function getFeatureType(id: RoadNetworkFeatureTypeId): RoadNetworkFeatureType | undefined {
  return BY_ID.get(id);
}

// ---------------------------------------------------------------------------
// Count helper – iterates the FeatureCollection once
// ---------------------------------------------------------------------------

export function classifyRoadNetworkFeatureType(
  props: Record<string, unknown>,
): RoadNetworkFeatureTypeId | null {
  const type = String(props.Type ?? props.type ?? "");
  switch (type) {
    case "Junction":
      return "junctions";
    case "Surface":
      return "surfaces";
    case "ParkingSpace":
      return "parking_spaces";
    case "LaneBoundary":
      return "lane_boundaries";
    case "Gate":
      return "gates";
    case "Lane": {
      const lt = String(props.LaneType ?? "").toLowerCase();
      if (lt === "driving") return "lanes_driving";
      if (lt === "sidewalk") return "lanes_sidewalk";
      if (lt === "biking") return "lanes_biking";
      if (lt === "parking") return "lanes_parking";
      if (lt === "curb") return "lanes_curb";
      if (lt === "shoulder") return "lanes_shoulder";
      if (lt === "restricted") return "lanes_restricted";
      if (lt === "center turn") return "lanes_center_turn";
      if (lt === "median") return "lanes_median";
      if (lt === "tram") return "lanes_tram";
      return "lanes_other";
    }
    default:
      return null;
  }
}

/** Count features per road-network type in a GeoJSON FeatureCollection. */
export function computeFeatureTypeCounts(
  geojson: object,
): Record<RoadNetworkFeatureTypeId, number> {
  const counts = Object.fromEntries(
    ROAD_NETWORK_FEATURE_TYPE_IDS.map((id) => [id, 0]),
  ) as Record<RoadNetworkFeatureTypeId, number>;

  const fc = geojson as { features?: unknown[] };
  if (!Array.isArray(fc.features)) return counts;

  for (const f of fc.features) {
    const feature = f as { properties?: Record<string, unknown> };
    if (!feature.properties) continue;
    const id = classifyRoadNetworkFeatureType(feature.properties);
    if (id) counts[id] += 1;
  }

  return counts;
}
