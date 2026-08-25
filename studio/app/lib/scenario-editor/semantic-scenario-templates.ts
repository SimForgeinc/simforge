import {
  SEMANTIC_SCENARIO_TEMPLATE_SCHEMA_VERSION,
  SEMANTIC_SITE_QUERY_SCHEMA_VERSION,
  SemanticScenarioTemplateSchema,
  type SemanticScenarioTemplate,
  type SemanticSiteQuery,
} from "@simforge/studio-shared";

const baseCorridorQuery: SemanticSiteQuery = {
  schemaVersion: SEMANTIC_SITE_QUERY_SCHEMA_VERSION,
  anchor: { kind: "corridor" },
  authoringStatuses: ["authorable"],
  corridor: {
    minimumLengthM: 40,
    minimumDistanceFromBoundaryM: 15,
    progressRange: [0.2, 0.8],
  },
  nearby: [],
  diversityRadiusM: 75,
  limit: 50,
};

function template(
  value: Omit<SemanticScenarioTemplate, "schemaVersion" | "version" | "status"> &
    Partial<Pick<SemanticScenarioTemplate, "version" | "status">>,
) {
  return SemanticScenarioTemplateSchema.parse({
    schemaVersion: SEMANTIC_SCENARIO_TEMPLATE_SCHEMA_VERSION,
    version: value.version ?? 1,
    status: value.status ?? "experimental",
    ...value,
  });
}

export const BUILTIN_SEMANTIC_SCENARIO_TEMPLATES: SemanticScenarioTemplate[] = [
  template({
    id: "construction-right-lane-closure", family: "lane_construction_closure",
    displayName: "Right-lane construction closure", description: "Cones and work-zone objects close the rightmost lane between junction boundaries.",
    status: "qualified", formationKind: "construction_zone",
    siteQuery: { ...baseCorridorQuery, corridor: { ...baseCorridorQuery.corridor!, minimumLengthM: 60, minimumApproachLaneCount: 2, laneRoles: ["rightmost"] } },
    requiredFeatureKinds: ["driving_corridor"],
    hardConstraintKinds: ["occupies_lane", "pattern_spacing", "pattern_extent", "formation_boundary"], softConstraintKinds: [],
    parameters: [{ id: "taper_length_m", label: "Taper length", unit: "meters", minimum: 20, maximum: 120, default: 60 }],
    runtimeVerification: { required: true, visibilityRequired: false, measurements: ["spawn_pose", "clearance"] },
  }),
  template({
    id: "pedestrian-between-parked-cars", family: "pedestrian_emergence_between_parked_vehicles",
    displayName: "Pedestrian emergence between parked vehicles", description: "A pedestrian emerges through a preserved gap between two parked vehicles.",
    formationKind: "pedestrian_occlusion",
    siteQuery: { ...baseCorridorQuery, nearby: [
      { featureKinds: ["parking_area", "parking_lane"], minCount: 2, maximumDistanceM: 15, bindingStatuses: ["exact", "projected"] },
      { featureKinds: ["walking_corridor", "crosswalk"], minCount: 1, maximumDistanceM: 30, bindingStatuses: ["exact", "projected"] },
    ] },
    requiredFeatureKinds: ["parking_area", "walking_corridor"],
    hardConstraintKinds: ["emerges_between", "occluded_by", "relative_pose", "minimum_clearance"], softConstraintKinds: ["visibility_transition"],
    parameters: [{ id: "emergence_gap_m", label: "Emergence gap", unit: "meters", minimum: 1, maximum: 4, default: 2 }],
    runtimeVerification: { required: true, visibilityRequired: true, measurements: ["spawn_pose", "trajectory", "clearance", "visibility", "event_timing"] },
  }),
  template({
    id: "large-vehicle-occlusion", family: "large_vehicle_occlusion", displayName: "Bus or truck occlusion",
    description: "A large vehicle blocks line of sight to a crossing actor.", formationKind: "pedestrian_occlusion",
    siteQuery: baseCorridorQuery, requiredFeatureKinds: ["driving_corridor", "walking_corridor"],
    hardConstraintKinds: ["occluded_by", "crosses_path_of", "relative_pose"], softConstraintKinds: ["visibility_transition"],
    parameters: [{ id: "crossing_delay_s", label: "Crossing delay", unit: "seconds", minimum: 0, maximum: 5, default: 1.5 }],
    runtimeVerification: { required: true, visibilityRequired: true, measurements: ["spawn_pose", "visibility", "event_timing"] },
  }),
  template({
    id: "cut-in-merge", family: "cut_in_merge_lane_change", displayName: "Cut-in and merge", description: "Two vehicles interact under bounded headway and time-to-conflict.",
    formationKind: "vehicle_interaction", siteQuery: { ...baseCorridorQuery, corridor: { ...baseCorridorQuery.corridor!, minimumApproachLaneCount: 2 } },
    requiredFeatureKinds: ["driving_corridor"], hardConstraintKinds: ["keeps_headway", "time_to_conflict", "occupies_lane"], softConstraintKinds: ["relative_pose_at_event"],
    parameters: [{ id: "headway_s", label: "Headway", unit: "seconds", minimum: 0.5, maximum: 4, default: 1.5 }],
    runtimeVerification: { required: true, visibilityRequired: false, measurements: ["trajectory", "clearance", "collision", "event_timing"] },
  }),
  template({ id: "double-parked-delivery", family: "double_parked_delivery", displayName: "Double-parked delivery and dooring", description: "A delivery vehicle and cyclist preserve curb-relative interaction geometry.", formationKind: "parking_interaction", siteQuery: { ...baseCorridorQuery, nearby: [{ featureKinds: ["parking_lane", "parking_area"], minCount: 1, maximumDistanceM: 15, bindingStatuses: ["exact", "projected"] }] }, requiredFeatureKinds: ["parking_lane", "bicycle_corridor"], hardConstraintKinds: ["parked_along", "minimum_clearance", "crosses_path_of"], softConstraintKinds: ["time_to_conflict"], parameters: [], runtimeVerification: { required: true, visibilityRequired: false, measurements: ["spawn_pose", "trajectory", "clearance", "collision"] } }),
  template({ id: "queue-stop-and-go", family: "queue_stop_and_go", displayName: "Queue and stop-and-go wave", description: "A vehicle platoon preserves ordering, spacing, and wave timing.", formationKind: "queue_or_convoy", siteQuery: { ...baseCorridorQuery, corridor: { ...baseCorridorQuery.corridor!, minimumLengthM: 100 } }, requiredFeatureKinds: ["driving_corridor"], hardConstraintKinds: ["ordered_along_feature", "longitudinal_gap", "keeps_headway"], softConstraintKinds: ["event_time"], parameters: [{ id: "vehicle_count", label: "Vehicle count", unit: "count", minimum: 3, maximum: 12, default: 6 }], runtimeVerification: { required: true, visibilityRequired: false, measurements: ["spawn_pose", "trajectory", "event_timing"] } }),
  template({ id: "emergency-crash-perimeter", family: "emergency_crash_perimeter", displayName: "Emergency or crash perimeter", description: "Emergency vehicles, cones, and hazards retain a locked incident perimeter.", formationKind: "emergency_scene", siteQuery: baseCorridorQuery, requiredFeatureKinds: ["driving_corridor"], hardConstraintKinds: ["relative_pose", "minimum_clearance", "formation_boundary"], softConstraintKinds: [], parameters: [], runtimeVerification: { required: true, visibilityRequired: false, measurements: ["spawn_pose", "clearance"] } }),
  template({ id: "temporary-intersection-control", family: "temporary_intersection_control", displayName: "Temporary intersection control", description: "Temporary control devices are placed around a runtime-verified junction movement.", formationKind: "temporary_traffic_control", siteQuery: { ...baseCorridorQuery, anchor: { kind: "movement" }, corridor: undefined, movement: {} }, requiredFeatureKinds: ["junction_movement"], hardConstraintKinds: ["relative_pose", "formation_boundary", "interacts_at_conflict"], softConstraintKinds: [], parameters: [], runtimeVerification: { required: true, visibilityRequired: false, measurements: ["spawn_pose", "clearance"] } }),
  template({ id: "debris-cargo-field", family: "debris_cargo_field", displayName: "Debris or fallen cargo field", description: "A static hazard field preserves pattern extent and open-lane clearance.", formationKind: "static_hazard", siteQuery: baseCorridorQuery, requiredFeatureKinds: ["driving_corridor"], hardConstraintKinds: ["pattern_spacing", "pattern_extent", "occupies_lane"], softConstraintKinds: [], parameters: [{ id: "debris_count", label: "Debris count", unit: "count", minimum: 2, maximum: 20, default: 6 }], runtimeVerification: { required: true, visibilityRequired: false, measurements: ["spawn_pose", "clearance"] } }),
  template({ id: "parking-backing-conflict", family: "parking_lot_backing_conflict", displayName: "Parking-lot backing conflict", description: "A backing vehicle conflicts with a passing vehicle or pedestrian near parking context.", formationKind: "parking_interaction", siteQuery: { ...baseCorridorQuery, anchor: { kind: "environment_feature", featureKinds: ["parking_area"] }, corridor: undefined }, requiredFeatureKinds: ["parking_area", "access_connector"], hardConstraintKinds: ["interacts_at_conflict", "relative_pose", "time_to_conflict"], softConstraintKinds: [], parameters: [], runtimeVerification: { required: true, visibilityRequired: true, measurements: ["spawn_pose", "trajectory", "collision", "visibility"] } }),
  template({ id: "roadside-worker-intrusion", family: "roadside_worker_intrusion", displayName: "Roadside worker intrusion", description: "Workers and equipment intrude from a shoulder or construction boundary.", formationKind: "construction_zone", siteQuery: baseCorridorQuery, requiredFeatureKinds: ["driving_corridor", "walking_corridor"], hardConstraintKinds: ["occupies_shoulder", "crosses_path_of", "relative_pose"], softConstraintKinds: ["visibility_transition"], parameters: [], runtimeVerification: { required: true, visibilityRequired: true, measurements: ["spawn_pose", "trajectory", "clearance", "visibility"] } }),
];

export function getBuiltinSemanticScenarioTemplate(id: string) {
  return BUILTIN_SEMANTIC_SCENARIO_TEMPLATES.find((item) => item.id === id) ?? null;
}
