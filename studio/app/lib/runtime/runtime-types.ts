import type {
  RenderOutputSpec,
} from "@simforge-oss/scenario/contracts";
import type { HistoricalGalleryPreview as ScenarioRuntimeGalleryPreview } from "@/app/lib/scenario/render/gallery-preview-compat";

/** Health-check response from the CARLA backend. */
export type CarlaBackendHealth = {
  ok: boolean;
  status?: string;
  total_slots?: number;
  busy_slots?: number;
  queued_jobs?: number;
  queue_accepting?: boolean;
  capacity_available?: boolean;
  carla_connected: boolean;
  metadata_connected?: boolean;
  metadata_slot_index?: number | null;
  running: boolean;
  langchain_available: boolean;
  langsmith_available: boolean;
  langsmith_tracing: boolean;
};

/** Editor-facing capability flags derived from the runtime provider surface. */
export type RuntimeCapabilities = {
  pause_resume: boolean;
  cosmos_stream: boolean;
  bootstrap_cache: boolean;
};

/** Metadata for a single CARLA map. */
export type CarlaMapInfo = {
  name: string;
  normalized_name: string;
  supported_in_dataset?: boolean;
};

/** Current CARLA session connection status and available maps. */
export type CarlaSessionStatus = {
  connected: boolean;
  current_map: string | null;
  normalized_map_name: string | null;
  server_version: string | null;
  client_version: string | null;
  available_maps: CarlaMapInfo[];
  supported_dataset_maps?: string[];
  warnings: string[];
};

/** Aggregated runtime status returned by the dashboard proxy route. */
export type CarlaRuntimeStatusResponse = {
  reachable: boolean;
  baseUrl: string;
  health?: CarlaBackendHealth;
  maps?: CarlaSessionStatus;
  capabilities: RuntimeCapabilities;
  /** Number of simulation jobs created today for this workspace on this runtime provider. */
  jobs_today?: number;
  error?: string;
};

/** Metadata for a single actor blueprint from the CARLA library. */
export type ActorBlueprintMetadata = {
  id: string;
  label?: string;
  preview_image?: string;
  tags?: string[];
  attributes?: Record<string, unknown>;
};

/** Available vehicle and walker blueprints from the CARLA library. */
export type ActorBlueprintLibrary = {
  vehicles: string[];
  walkers: string[];
  metadata?: Record<string, ActorBlueprintMetadata>;
};

/** @deprecated Kept for backward compat with old diagnostics. Roads are now auto-derived from actor placements. */
export type SelectedRoadPayload = {
  id: string;
  name: string;
  length: number;
  tags: string[];
  section_labels: string[];
};

/** Runtime lane-section summary returned by the CARLA runtime provider. */
export type RuntimeRoadSectionSummary = {
  index: number;
  label: string;
  s: number;
  driving_left: number;
  driving_right: number;
  parking_left: number;
  parking_right: number;
  total_driving: number;
  total_width: number;
  lane_types: string[];
  tags: string[];
};

/** Runtime road summary with lane types and infrastructure flags. */
export type RuntimeRoadSummary = {
  id: string;
  name: string;
  is_intersection: boolean;
  tags: string[];
  lane_types: string[];
  has_parking: boolean;
  has_shoulder: boolean;
  has_sidewalk: boolean;
  section_summaries: RuntimeRoadSectionSummary[];
};

export type RuntimeLaneMarking = {
  type?: string | null;
  color?: string | null;
  lane_change?: string | null;
  width?: number | null;
  attributes?: Record<string, unknown>;
};

export type RuntimeWaypointTransform = {
  location: { x: number; y: number; z: number };
  rotation: { pitch: number; yaw: number; roll: number };
  frontend?: { x: number; y: number; z: number; yaw: number };
  forward_vector?: { x: number; y: number; z: number };
  right_vector?: { x: number; y: number; z: number };
  up_vector?: { x: number; y: number; z: number };
  matrix?: number[][];
  inverse_matrix?: number[][];
};

export type RuntimeWaypointRef = {
  id?: number | null;
  rsl?: string | null;
  road_id?: number | null;
  section_id?: number | null;
  lane_id?: number | null;
  s?: number | null;
  lane_type?: string | null;
  lane_change?: string | null;
  lane_width?: number | null;
  is_junction?: boolean;
  is_intersection?: boolean;
  is_rht?: boolean;
  junction_id?: number | null;
  attributes?: Record<string, unknown>;
  transform?: RuntimeWaypointTransform;
};

export type RuntimeTurnOption = {
  relation: "Left" | "Right" | "Straight" | string;
  branch_waypoint?: RuntimeWaypointRef | null;
  entry_waypoint?: RuntimeWaypointRef | null;
  lookahead_waypoint?: RuntimeWaypointRef | null;
  junction_exit_waypoint?: RuntimeWaypointRef | null;
  post_junction_waypoint?: RuntimeWaypointRef | null;
  heading_delta_degrees?: number | null;
  junction_waypoint_count?: number | null;
  classification_source?: string | null;
};

export type RuntimeLandmark = {
  id?: string;
  name?: string;
  road_id?: number | null;
  distance?: number | null;
  s?: number | null;
  t?: number | null;
  is_dynamic?: boolean;
  orientation?: string | null;
  z_offset?: number | null;
  country?: string;
  type?: string;
  sub_type?: string;
  value?: number | null;
  unit?: string;
  height?: number | null;
  width?: number | null;
  text?: string;
  h_offset?: number | null;
  pitch?: number | null;
  roll?: number | null;
  lane_validities?: Array<{ from_lane_id: number; to_lane_id: number }>;
  waypoint?: RuntimeWaypointRef | null;
  transform?: RuntimeWaypointTransform;
  attributes?: Record<string, unknown>;
};

export type RuntimeTopologyEdge = {
  id: string;
  entry_waypoint?: RuntimeWaypointRef | null;
  exit_waypoint?: RuntimeWaypointRef | null;
};

export type RuntimeBoundingBox = {
  actor_id?: number | null;
  location?: { x: number; y: number; z: number };
  extent?: { x: number; y: number; z: number };
  rotation?: { pitch: number; yaw: number; roll: number };
  local_vertices?: Array<{ x: number; y: number; z: number }>;
  world_vertices?: Array<{ x: number; y: number; z: number }>;
  attributes?: Record<string, unknown>;
};

export type RuntimeJunction = {
  id?: number | null;
  bounding_box?: RuntimeBoundingBox | null;
  waypoint_pairs?: Array<{
    entry_waypoint?: RuntimeWaypointRef | null;
    exit_waypoint?: RuntimeWaypointRef | null;
  }>;
  attributes?: Record<string, unknown>;
};

export type RuntimeEnvironmentObject = {
  id?: number | string | null;
  name?: string;
  type?: string;
  bounding_box?: RuntimeBoundingBox | null;
  transform?: RuntimeWaypointTransform;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  attributes?: Record<string, unknown>;
};

export type RuntimeTrafficLight = {
  actor_id?: number | null;
  type_id?: string;
  is_alive?: boolean;
  is_active?: boolean;
  is_dormant?: boolean;
  pole_index?: number | null;
  opendrive_id?: string | number | null;
  state?: string | null;
  elapsed_time?: number | null;
  red_time?: number | null;
  yellow_time?: number | null;
  green_time?: number | null;
  is_frozen?: boolean;
  group_traffic_lights?: Array<number | null>;
  affected_lane_waypoints?: RuntimeWaypointRef[];
  stop_waypoints?: RuntimeWaypointRef[];
  bounding_box?: RuntimeBoundingBox | null;
  trigger_volume?: RuntimeBoundingBox | null;
  light_boxes?: RuntimeBoundingBox[];
  location?: { x: number; y: number; z: number } | null;
  velocity?: { x: number; y: number; z: number } | null;
  angular_velocity?: { x: number; y: number; z: number } | null;
  acceleration?: { x: number; y: number; z: number } | null;
  semantic_tags?: unknown[];
  actor_state?: string | null;
  transform?: RuntimeWaypointTransform;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  attributes?: Record<string, unknown>;
};

export type RuntimeRoadSegment = {
  /**
   * Whether CARLA's waypoint crawl bound this lane, i.e. whether an actor may be
   * PLACED on it. Absent means "assume yes", which keeps every producer that
   * predates the road-surface change emitting placeable lanes as before.
   *
   * A lane can be perfectly real, drawn, and unplaceable: the crawl is
   * driving-only, so sidewalks, shoulders, parking and bike lanes are never
   * bound, and they are exactly the lanes the road surface is made of.
   */
  runtime_bound?: boolean;
  id: string;
  road_id: number;
  section_id: number;
  lane_id: number;
  lane_type?: string | null;
  is_junction: boolean;
  lane_change?: string | null;
  lane_width?: number | null;
  left_lane_marking?: RuntimeLaneMarking | null;
  right_lane_marking?: RuntimeLaneMarking | null;
  left_lane_id?: number | null;
  right_lane_id?: number | null;
  left_lane?: RuntimeWaypointRef | null;
  right_lane?: RuntimeWaypointRef | null;
  successors?: RuntimeWaypointRef[];
  predecessors?: RuntimeWaypointRef[];
  turn_options?: RuntimeTurnOption[];
  lane_start_waypoint?: RuntimeWaypointRef | null;
  lane_end_waypoint?: RuntimeWaypointRef | null;
  start_waypoint?: RuntimeWaypointRef | null;
  mid_waypoint?: RuntimeWaypointRef | null;
  end_waypoint?: RuntimeWaypointRef | null;
  landmarks?: RuntimeLandmark[];
  centerline: Array<{
    x: number;
    y: number;
    z: number;
    yaw: number;
    s: number;
    waypoint?: RuntimeWaypointRef | null;
    lane_change?: string | null;
    lane_width?: number | null;
    left_lane_marking?: RuntimeLaneMarking | null;
    right_lane_marking?: RuntimeLaneMarking | null;
    left_lane?: RuntimeWaypointRef | null;
    right_lane?: RuntimeWaypointRef | null;
    next?: RuntimeWaypointRef[];
    previous?: RuntimeWaypointRef[];
  }>;
};

export type RuntimeRoadMark = {
  id?: string;
  name?: string;
  road_id?: number | null;
  distance?: number | null;
  s?: number | null;
  t?: number | null;
  type?: string;
  width?: number | null;
  length?: number | null;
  heading?: number | null;
  orientation?: string | null;
  z_offset?: number | null;
  pitch?: number | null;
  roll?: number | null;
  waypoint?: RuntimeWaypointRef | null;
  transform?: RuntimeWaypointTransform;
  attributes?: Record<string, unknown>;
};

export type RuntimeCrosswalks = {
  points?: Array<{ x: number; y: number; z: number }>;
  polygons?: Array<Array<{ x: number; y: number; z: number }>>;
};

export type RuntimeMapInfo = {
  name?: string;
  georeference?: string;
  geoprojection?: string;
  opendrive_sha256?: string | null;
  opendrive_size_bytes?: number;
  attributes?: Record<string, unknown>;
};

export type RuntimeCarlaApiInventory = Record<
  string,
  { attributes?: string[]; methods?: string[] }
>;

/** Response from the runtime provider describing a loaded CARLA map at runtime. */
export type RuntimeMapResponse = {
  schema_version?: number;
  schema?: {
    source?: string;
    waypoint_distance_m?: number;
    coordinates?: string;
  };
  map_name: string;
  normalized_map_name: string;
  map_info?: RuntimeMapInfo;
  road_segments?: RuntimeRoadSegment[];
  topology_edges?: RuntimeTopologyEdge[];
  junctions?: RuntimeJunction[];
  spawn_points?: RuntimeWaypointTransform[];
  crosswalks?: RuntimeCrosswalks;
  landmarks?: RuntimeLandmark[];
  landmark_type_counts?: Record<string, number>;
  road_marks?: RuntimeRoadMark[];
  road_mark_type_counts?: Record<string, number>;
  environment_objects?: RuntimeEnvironmentObject[];
  traffic_lights?: RuntimeTrafficLight[];
  carla_api_inventory?: RuntimeCarlaApiInventory;
  /** Counts derived from the live CARLA waypoint crawl grouped by lane type. */
  lane_type_counts?: Record<string, number>;
  /** Counts derived from the generated dataset map record grouped by lane type. */
  dataset_lane_type_counts?: Record<string, number>;
  road_summaries?: RuntimeRoadSummary[];
  /** True when runtime data has been augmented with dataset-derived road summaries. */
  dataset_augmented?: boolean;
};

export type RuntimeStreetFurniturePoint = {
  x: number;
  y: number;
  z: number;
  yaw: number;
};

export type RuntimeStreetFurnitureResponse = {
  poles: Array<RuntimeStreetFurniturePoint & {
    id?: number | string;
    name?: string;
  }>;
  traffic_lights: Array<RuntimeStreetFurniturePoint & {
    actor_id?: number;
    type_id?: string;
    pole_index?: number;
    opendrive_id?: string;
    stop_waypoints?: RuntimeStreetFurniturePoint[];
  }>;
};

/** Metadata for a simulation recording (video or frame sequence). */
export type RecordingInfo = {
  run_id: string;
  label: string;
  mp4_path: string | null;
  frames_path: string | null;
  s3_key?: string | null;
  poster_path?: string | null;
  poster_s3_key?: string | null;
  created_at: string;
};

/** Alias for RecordingInfo used in scenario simulation contexts. */
export type ScenarioSimulationRecording = RecordingInfo;

/** Diagnostic details for a completed or failed simulation run. */
export type ScenarioSimulationDiagnostics = {
  run_id: string;
  map_name: string;
  created_at: string;
  selected_roads: SelectedRoadPayload[];
  actors: Array<Record<string, unknown>>;
  recording_path?: string | null;
  scenario_log_path?: string | null;
  debug_log_path?: string | null;
  worker_error?: string | null;
  saved_frame_count: number;
  sensor_timeout_count: number;
  last_sensor_frame?: number | null;
  skipped_actors: Array<Record<string, unknown>>;
  log_excerpt: string;
};

/** Possible lifecycle states of an runtime provider job as exposed to the web app. */
export type RuntimeJobState =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";
/** Alias for RuntimeJobState used in simulation UI contexts. */
export type ScenarioSimulationState = RuntimeJobState;

/** Supported simulation-family job types. */
export type RuntimeJobType = "simulate" | "preview" | "render";

/** Full record for an runtime provider job including state, GPU allocation, and artifacts. */
export type RuntimeJobRecord = {
  job_id: string;
  queue_tier?: "normal" | "priority" | null;
  executor_profile?: "simulate_gpu" | "render_gpu" | string | null;
  base_cost_cents?: number | null;
  cost_multiplier_bps?: number | null;
  charged_cost_cents?: number | null;
  state: RuntimeJobState;
  job_type?: RuntimeJobType | string | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  queue_position: number;
  error?: string | null;
  run_id?: string | null;
  scenario_id?: string | null;
  dataset_id?: string | null;
  gpu_class?: string | null;
  request?: {
    scenario_id?: string | null;
    map_name: string;
    output_spec?: RenderOutputSpec | null;
    [key: string]: unknown;
  };
  events?: Array<{
    created_at: string;
    sequence_number?: number;
    payload: ScenarioSimulationStreamMessage;
    /** Internal persistence fields; scenario-runtime sanitizers must remove. */
    event_type?: string;
    slot_lease_id?: string | null;
  }>;
  render_config_snapshot?: Record<string, unknown> | null;
  worker_hardware_snapshot?: Record<string, unknown> | null;
  gallery_preview?: ScenarioRuntimeGalleryPreview | null;
  gpu?: {
    slot_index: number;
    device_id: string;
    carla_rpc_port: number;
    traffic_manager_port: number;
  } | null;
  artifacts?: {
    output_dir?: string;
    request_file?: string;
    runtime_settings_file?: string;
    manifest_path?: string | null;
    recording_path?: string | null;
    scenario_log_path?: string | null;
    debug_log_path?: string | null;
    uploaded_artifacts?: Array<{
      kind: string;
      label?: string | null;
      local_path?: string | null;
      content_type?: string | null;
      file_ext?: string | null;
      size_bytes?: number | null;
      checksum_sha256?: string | null;
      s3_bucket?: string | null;
      s3_key?: string | null;
      s3_uri?: string | null;
      artifact_class?: string | null;
      sensor_id?: string | null;
      sensor_label?: string | null;
      sensor_category?: string | null;
      output_modality?: string | null;
      artifact_type?: string | null;
      artifact_format?: string | null;
      recipe_stage?: string | null;
      frame_index?: number | null;
      sequence_id?: string | null;
      is_raw?: boolean | null;
      metadata?: Record<string, unknown> | null;
    }>;
  };
};

/** Alias for RuntimeJobRecord used in scenario simulation contexts. */
export type ScenarioSimulationRecord = RuntimeJobRecord;

/** Response returned when a new simulation job is enqueued. */
export type ScenarioSimulationStartResponse = {
  status: string;
  job_id: string;
  state: RuntimeJobState;
  queue_position: number;
};

/** Real-time streaming message with actor positions during a simulation tick. */
export type ScenarioSimulationStreamMessage = {
  frame: number;
  timestamp: number;
  event_kind?: string | null;
  actors: Array<{
    id: number | string;
    actor_spec_id?: string | null;
    carla_actor_id?: number | null;
    label: string;
    kind: string;
    role: string;
    x: number;
    y: number;
    z: number;
    yaw: number;
    speed_mps: number;
    road_id?: number | null;
    section_id?: number | null;
    lane_id?: number | null;
  }>;
  simulation_ended?: boolean;
  error?: string | null;
  warning?: string | null;
  skipped_actor?: Record<string, unknown> | null;
  skipped_actors?: Array<Record<string, unknown>>;
  spawn_positions?: Array<{
    actor_id: string;
    label: string;
    kind: string;
    role: string;
    placement_mode: string;
    handle_id: number;
    frontend: {
      x: number;
      y: number;
      z: number;
      yaw: number;
    };
    carla: {
      x: number;
      y: number;
      z: number;
      yaw: number;
    };
  }>;
  spawn_attempts?: Array<{
    actor_id: string;
    label: string;
    kind: string;
    role: string;
    placement_mode: string;
    authored_spawn_point?: { x: number; y: number } | null;
    success: boolean;
    attempts: Array<{
      index: number;
      success: boolean;
      x: number;
      y: number;
      z: number;
      yaw: number;
    }>;
  }>;
  recording?: RecordingInfo | null;
  phase?: string | null;
  phase_detail?: string | null;
  line?: string | null;
  worker_id?: string | null;
  worker_metadata?: Record<string, unknown> | null;
  gpu_id?: string | null;
  gpu_class?: string | null;
  sensor_count?: number | null;
  step?: number | null;
  total_steps?: number | null;
  timeline_frames?: Array<{
    frame: number;
    timestamp: number;
    actors: Array<{
      id: number | string;
      actor_spec_id?: string | null;
      carla_actor_id?: number | null;
      label: string;
      kind: string;
      role: string;
      x: number;
      y: number;
      z: number;
      yaw: number;
      speed_mps: number;
      road_id?: number | null;
      section_id?: number | null;
      lane_id?: number | null;
    }>;
  }>;
};

/** Chat message in the scene-assistant conversation history. */
export type SceneAssistantMessage = {
  role: "user" | "assistant";
  content: string;
};

/** Trace of a tool invocation made by the scene assistant. */
export type SceneAssistantToolTrace = {
  name: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
};

/** Structured response from the scene assistant including actors and tool traces. */
export type SceneAssistantResponse = {
  model: string;
  reply: string;
  map_name: string;
  normalized_map_name: string;
  actors: Array<Record<string, unknown>>;
  selected_roads: SelectedRoadPayload[];
  selected_actor_id?: string | null;
  tool_trace: SceneAssistantToolTrace[];
  raw_response?: Record<string, unknown>;
};
