/**
 * Pre-defined map-asset descriptor tags for scenario creation.
 * Labels describe the presence of elements in a map (intersections, crosswalks, etc.).
 * Initially hardcoded; will eventually be loaded from a database of map-asset descriptor tags.
 *
 * Source: prioritized table of map-asset labels (deep-research-report).
 */

export type MapAssetDescriptorPriority = "High" | "Medium" | "Low";

export interface MapAssetDescriptorTag {
  /** Tag id used in MapAsset.tags (e.g. INTERSECTION_SIGNALIZED). */
  id: string;
  /** Short definition (1 line). */
  shortDefinition: string;
  /** Simulation value priority for scenario generation. */
  priority: MapAssetDescriptorPriority;
}

/**
 * Hardcoded list of map-asset descriptor tags.
 * Tag ids are the canonical set of values allowed in MapAsset.tags.
 */
export const MAP_ASSET_DESCRIPTOR_TAGS: readonly MapAssetDescriptorTag[] = [
  // ── Intersections ────────────────────────────────────────────────────────
  { id: "INTERSECTION_SIGNALIZED",              shortDefinition: "Intersection controlled by traffic lights (vehicle/ped phases).", priority: "High" },
  { id: "INTERSECTION_ALL_WAY_STOP",            shortDefinition: "4-way stop-controlled intersection.", priority: "Medium" },
  { id: "INTERSECTION_TWO_WAY_STOP",            shortDefinition: "Minor-road stop control (major-road free flow).", priority: "Medium" },
  { id: "INTERSECTION_T_YIELD",                 shortDefinition: "T-intersection where the minor road terminates into a major road.", priority: "Medium" },
  { id: "INTERSECTION_UNCONTROLLED",            shortDefinition: "Junction without stop/yield/signal control (or ambiguous control).", priority: "Medium" },
  { id: "INTERSECTION_SKEWED_OR_OFFSET",        shortDefinition: "Intersection with skew angle or offset approaches reducing visibility.", priority: "Medium" },
  { id: "INTERSECTION_COMPLEX_MULTI_LEG",       shortDefinition: "Intersection with 5+ legs or closely coupled junctions.", priority: "High" },

  // ── Turns ────────────────────────────────────────────────────────────────
  { id: "TURN_UNPROTECTED_LEFT",                shortDefinition: "Left turn that yields to oncoming traffic (no protected phase).", priority: "High" },
  { id: "TURN_PROTECTED_LEFT_PHASE",            shortDefinition: "Intersection with a protected left-turn signal phase.", priority: "Medium" },
  { id: "TURN_RIGHT_ON_RED_ALLOWED",            shortDefinition: "Intersection where right on red is legally permitted (unless restricted).", priority: "Medium" },
  { id: "TURN_CHANNELIZED_RIGHT_SLIP",          shortDefinition: "Channelized free-right / slip lane bypassing the main stop line.", priority: "High" },

  // ── Road types ───────────────────────────────────────────────────────────
  { id: "FREEWAY_HIGHWAY_MAIN_CORRIDOR",        shortDefinition: "Multi-lane high-speed freeway or highway mainline segment (not just ramps).", priority: "High" },
  { id: "MULTI_LANE_URBAN_ARTERIAL",            shortDefinition: "Urban road with 2+ lanes per direction at city speeds (not freeway).", priority: "High" },
  { id: "NARROW_RESIDENTIAL_STREET_WITH_PARKING", shortDefinition: "Residential street ≤2 lanes with on-street parking on one or both sides.", priority: "High" },
  { id: "HIGH_SPEED_ARTERIAL_SEGMENT",          shortDefinition: "Segment with higher posted speeds and multi-lane exposure.", priority: "Medium" },
  { id: "SPEED_LIMIT_TRANSITION_ZONE",          shortDefinition: "Segment where posted speed limit changes (e.g., 25→35).", priority: "Low" },
  { id: "ROAD_GRADE_CREST_ELEVATION_CHANGE",    shortDefinition: "Segment with significant grade or crest that creates forward visibility occlusion.", priority: "High" },

  // ── Pedestrian infrastructure ────────────────────────────────────────────
  { id: "SIDEWALK_PEDESTRIAN_NETWORK",          shortDefinition: "Continuous sidewalk network suitable for pedestrian VRU scenarios.", priority: "High" },
  { id: "HIGH_PEDESTRIAN_DENSITY_BLOCK",        shortDefinition: "Block with consistently high pedestrian volumes (downtown/near transit).", priority: "High" },
  { id: "CROSSWALK_MIDBLOCK_BEACON",            shortDefinition: "Midblock marked crossing with RRFB/HAWK or flashers.", priority: "High" },
  { id: "CROSSWALK_MARKED_UNSIGNALIZED",        shortDefinition: "Marked crosswalk without signal control (yield compliance varies).", priority: "Medium" },
  { id: "CROSSWALK_MARKED_SIGNALIZED",          shortDefinition: "Marked crosswalk with pedestrian signal heads.", priority: "Low" },
  { id: "PEDESTRIAN_REFUGE_ISLAND",             shortDefinition: "Median island enabling two-stage pedestrian crossing.", priority: "Medium" },

  // ── Bike infrastructure ──────────────────────────────────────────────────
  { id: "BIKE_LANE_PROTECTED",                  shortDefinition: "Physically separated bike lane segment.", priority: "High" },
  { id: "BIKE_LANE_STANDARD",                   shortDefinition: "Painted bike lane without physical separation.", priority: "Low" },
  { id: "BIKE_LANE_SHARED_ROADWAY",             shortDefinition: "Narrow road where cyclists share the travel lane with cars (sharrow / shared lane markings).", priority: "High" },
  { id: "BIKE_INTERSECTION_MIXING_ZONE",        shortDefinition: "Intersection zone where bike lane merges into traffic (mixing).", priority: "High" },
  { id: "BIKE_BOX_ADVANCED_STOP_LINE",          shortDefinition: "Bike box / advance stop area at signalized intersections.", priority: "Low" },
  { id: "SHARED_USE_PATH_CROSSING",             shortDefinition: "Shared-use path crosses roadway (trail/greenway crossing).", priority: "High" },

  // ── School & zones ───────────────────────────────────────────────────────
  { id: "SCHOOL_ZONE_BOUNDARY",                 shortDefinition: "Segment within posted school-zone speed regulation area.", priority: "High" },
  { id: "SCHOOL_PICKUP_DROPOFF_ZONE",           shortDefinition: "Curb area used for school loading/queuing (often informal).", priority: "High" },
  { id: "CROSSING_GUARD_POST",                  shortDefinition: "Crossing supervised by an adult crossing guard.", priority: "High" },

  // ── Parking & loading ────────────────────────────────────────────────────
  { id: "PARKING_LANE_NEAR_INTERSECTION_OCCLUSION", shortDefinition: "On-street parking adjacent to intersection corners.", priority: "High" },
  { id: "PARKING_LOT_INTERNAL_CIRCULATION",     shortDefinition: "Internal parking lot area with unstructured vehicle and pedestrian movement.", priority: "Medium" },
  { id: "PARKING_LOT_ENTRANCE_EXIT",            shortDefinition: "Lot entry/exit conflict point with turning vehicles and pedestrians.", priority: "Low" },
  { id: "CURBSIDE_LOADING_ZONE",                shortDefinition: "Signed/used curb for deliveries, ride-share, or loading (commercial).", priority: "High" },
  { id: "DRIVEWAY_CURB_CUT_CLUSTER",            shortDefinition: "Road segment with many driveway accesses / curb cuts.", priority: "High" },

  // ── Occlusion & visibility ───────────────────────────────────────────────
  { id: "SIGHTLINE_OCCLUSION_HARD_CORNER",      shortDefinition: "Hard occluder corner (building/wall/fence/containers) near conflict point.", priority: "High" },
  { id: "LOW_LIGHTING_UNLIT_SEGMENT",           shortDefinition: "Road segment with limited lighting or frequent low-visibility conditions.", priority: "High" },

  // ── Highway / freeway features ───────────────────────────────────────────
  { id: "FREEWAY_ONRAMP_MERGE",                 shortDefinition: "On-ramp area where vehicles accelerate and merge into faster traffic.", priority: "Medium" },
  { id: "FREEWAY_OFFRAMP_QUEUE_SPILLBACK",      shortDefinition: "Off-ramp segment where queues spill onto mainline/arterial interface.", priority: "High" },
  { id: "LANE_DROP_MERGE_BOTTLENECK",           shortDefinition: "Segment where lanes end or merge (forced yield).", priority: "High" },
  { id: "EMERGENCY_STOPPING_SHOULDER_PULLOUT",  shortDefinition: "Shoulder/pullout suitable for traffic stops, breakdowns, or staging.", priority: "Medium" },
  { id: "HIGH_REAR_END_RISK_QUEUE_ZONE",        shortDefinition: "Segment prone to stop-and-go queues (spillback, sudden braking).", priority: "High" },

  // ── Special infrastructure ───────────────────────────────────────────────
  { id: "TRAFFIC_SIGNAL_FLASH_MODE_OUTAGE",     shortDefinition: "Signalized intersection that can operate in flashing mode / outage state.", priority: "High" },
  { id: "WORK_ZONE_LANE_CLOSURE_STAGING",       shortDefinition: "Designated/likely work-zone footprint (lane closure, taper, staging).", priority: "High" },
  { id: "TRANSIT_BUS_STOP",                     shortDefinition: "Bus stop area (curbside dwell, pull-in/out, pedestrian clustering).", priority: "Medium" },
  { id: "EMERGENCY_VEHICLE_PREEMPT_CORRIDOR",   shortDefinition: "Corridor/intersection chain where signal preemption can occur.", priority: "High" },
  { id: "HEAVY_VEHICLE_TRUCK_ROUTE",            shortDefinition: "Road segment designated/used for trucks and heavy vehicles.", priority: "High" },

  // ── Enrichment-derived (Overture / OSM) ──────────────────────────────────
  { id: "HOSPITAL_APPROACH",                    shortDefinition: "Hospital approach zone for emergency vehicle preemption and ambulance scenarios.", priority: "High" },
  { id: "GAS_STATION_APPROACH",                 shortDefinition: "Gas station entry/exit zone with turning and low-speed vehicle conflict potential.", priority: "Medium" },
  { id: "HAS_ROAD_NAMES",                       shortDefinition: "Map enrichment includes named road segments from Overture for street-level labeling.", priority: "Low" },
] as const;

/** All valid tag ids (for validation or dropdowns). */
export const MAP_ASSET_DESCRIPTOR_TAG_IDS: readonly string[] = MAP_ASSET_DESCRIPTOR_TAGS.map((t) => t.id);

/** Lookup by id. */
export function getMapAssetDescriptorTag(id: string): MapAssetDescriptorTag | undefined {
  return MAP_ASSET_DESCRIPTOR_TAGS.find((t) => t.id === id);
}
