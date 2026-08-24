"use client";

import type { LucideIcon } from "lucide-react";
import type { ScenarioEditorActorDraft } from "@simcloud/shared";
import type { BridgedMapBundle, MapLocation } from "@/app/lib/editor-map/types";
import type { EditorToolId as SharedEditorToolId } from "@/app/lib/editor-tools/types";
import type {
  RuntimeJobRecord,
  RecordingInfo,
  ScenarioSimulationStreamMessage,
} from "@/app/lib/runtime/runtime-types";
import type { NormalizedScenarioDraft } from "@/app/lib/scenario-editor/draft-normalization";
import type { HistoricalGalleryPreview as ScenarioRuntimeGalleryPreview } from "@/app/lib/scenario/render/gallery-preview-compat";

export type WorkspaceTab = "datasets" | "editor" | "render";
export type SidebarMode = "manual" | "assistant" | "tools";
export type EditorToolId = SharedEditorToolId;
export type SlidePanelMode = "json" | "settings" | "templates" | null;
export type SceneObjectType = "actor" | "prop" | "camera";
export type CameraPlacementMode = "overhead" | "street";

export type SemanticEditorBootstrapSummary = {
  contract: "simforge.semantic-editor-bootstrap.v1";
  publicationRevision: string;
  semanticMapGraphRevision: string;
  semanticFeatureGraphRevision: string;
  semanticExecutionIndexRevision: string;
  runtimeMapName: string;
  runtimeCatalogVersion: string;
  capabilities: {
    road_authoring: boolean;
    timed_instructions: boolean;
    semantic_instruction_program: boolean;
    lane_change: boolean;
    runtime_debug: boolean;
  };
};

export type MapBundleResponse = Pick<
  BridgedMapBundle,
  | "asset"
  | "bundle_version"
  | "runtime_bundle_key"
  | "locations"
  | "bridge_summary"
  | "carla_status"
  | "map_match"
  | "generated"
  | "runtime"
  | "street_furniture"
  | "enrichment"
  | "candidate_locations"
  | "signals_geojson"
  | "geojson_url"
> & {
  /** Present on the semantic-first boot path. Runtime geometry is deliberately
   * absent; exact CARLA bindings remain server/worker execution artifacts. */
  semantic_bootstrap?: SemanticEditorBootstrapSummary;
};

export type LocationSummary = {
  id: string;
  label: string;
  kind: string;
  classification: string;
  tags: string[];
  feature_flags: MapLocation["feature_flags"];
  road_count: number;
  related_road_names?: string[];
  description?: string;
  bridge?: MapLocation["bridge"] | null;
};

export type AssistantMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type ActorPaletteCategory =
  | "Traffic Safety"
  | "Debris"
  | "Containers & Storage"
  | "Street Furniture"
  | "Vegetation";

export type ActorPaletteItem = {
  id: string;
  label: string;
  description: string;
  kind: ScenarioEditorActorDraft["kind"];
  role: ScenarioEditorActorDraft["role"];
  objectType: SceneObjectType;
  /**
   * How a drop resolves to a spawn — the ONLY placement decision the palette
   * still makes. `lane_or_free` snaps onto the OpenDRIVE lane under the pointer
   * and falls back to a freeform world point when the drop lands off-road;
   * `free` never snaps. Everything else about the actor (Drive, Walk, Parked,
   * or a freeform point path) is its BASE CLIP — editable for the actor's whole
   * life — not a palette fork. See `behavior-base-clip.ts`.
   */
  placement: "lane_or_free" | "free";
  isStatic?: boolean;
  blueprint: string;
  color: string;
  icon: LucideIcon;
  category?: ActorPaletteCategory;
};

export type EditorActorRecord = {
  draft: ScenarioEditorActorDraft;
  lng: number;
  lat: number;
  placementLabel: string;
};

export type PaletteDragState = {
  item: ActorPaletteItem;
  pointerId: number;
  originX: number;
  originY: number;
  clientX: number;
  clientY: number;
  dragActive: boolean;
};

export type ActorDragState = {
  actorId: string;
  originX: number;
  originY: number;
  clientX: number;
  clientY: number;
  dragActive: boolean;
};

export type CameraPaletteDragState = {
  mode: CameraPlacementMode;
  pointerId: number;
  originX: number;
  originY: number;
  clientX: number;
  clientY: number;
  dragActive: boolean;
};

export type WorldSensorRecord = NormalizedScenarioDraft["worldSensors"][number];

export type LocalTemplateRecord = {
  id: string;
  name: string;
  createdAt: string;
  mapName: string;
  actors: ScenarioEditorActorDraft[];
  worldSensors: NormalizedScenarioDraft["worldSensors"];
};

export type ScenarioSimulationArtifact = {
  id: string;
  kind: string;
  label: string | null;
  s3Url: string | null;
  posterUrl?: string | null;
  contentType: string | null;
  sizeBytes: number | null;
};

export type RenderFeedFilter = "camera" | "lidar";

export type CosmosPresetOption = {
  id: string;
  label: string;
  prompt: string;
  guidance: number;
};

export type RenderArtifactSummaryItem = {
  id?: string | null;
  kind: string;
  label?: string | null;
  artifactType?: string | null;
  recipeStage?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  s3Key?: string | null;
  sensorLabel?: string | null;
  sensorCategory?: string | null;
  outputModality?: string | null;
};

export type RenderHistoryItem = {
  jobId: string;
  queueTier?: "normal" | "priority" | null;
  queuePosition?: number | null;
  executorProfile?: string | null;
  chargedCostCents?: number | null;
  simulationId?: string | null;
  createdAt: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  state: RuntimeJobRecord["state"];
  gpuClass?: string | null;
  renderProfile?: string | null;
  renderConfigSnapshot?: Record<string, unknown> | null;
  workerHardwareSnapshot?: Record<string, unknown> | null;
  plannedCameraCount?: number | null;
  plannedOutputCount?: number | null;
  errorMessage?: string | null;
  artifactCount: number;
  galleryPreview?: ScenarioRuntimeGalleryPreview | null;
  recordings: RecordingInfo[];
  uploadedArtifacts?: RenderArtifactSummaryItem[];
};

export type RenderRunMutationState = {
  stopping: boolean;
  deleting: boolean;
  error: string | null;
};

export type DatasetScenarioSummary = {
  id: string;
  display_name: string | null;
  description?: string | null;
  map_asset_id: string | null;
  map_name: string | null;
  backend_map_name: string | null;
  actor_count: number | null;
  dataset_id: string | null;
  dataset_role?: string | null;
  mutability?: string | null;
  copy_policy?: string | null;
  source_scenario_id?: string | null;
  variation_source_scenario_id?: string | null;
  source_kind?: string | null;
  runtime?: string | null;
  created_by_user_id?: string | null;
  created_by_user_name?: string | null;
  created_by_user_email?: string | null;
  updated_by_user_id?: string | null;
  updated_by_user_name?: string | null;
  updated_by_user_email?: string | null;
  created_at: string;
  updated_at?: string | null;
};

export type CosmosJobRecord = {
  id: string;
  scenario_id: string;
  simulation_id: string | null;
  job_type: string;
  preset_name: string;
  camera_label: string | null;
  prompt: string;
  guidance: number;
  max_frames: number;
  resolution: number;
  num_steps: number;
  status: string;
  input_s3_key: string | null;
  output_s3_key: string | null;
  bboxed_output_s3_key?: string | null;
  runpod_job_id: string | null;
  execution_time_s: number | null;
  cost_cents: number | null;
  error_message: string | null;
  runpod_execution_time?: number | null;
  runpod_delay_time?: number | null;
  progress_phase?: string | null;
  progress_pct?: number | null;
  completed_steps?: number | null;
  total_steps?: number | null;
  gpu_memory_used_mb?: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type PostprocessArtifactRecord = {
  id: string;
  artifact_family?: string | null;
  artifact_type: string;
  modality?: string | null;
  content_type: string | null;
  s3_key: string | null;
  label: string | null;
  answer: string | null;
  metadata_json?: Record<string, unknown> | null;
};

export type PostprocessJobRecord = {
  id: string;
  scenario_id: string;
  simulation_id: string | null;
  source_artifact_id: string | null;
  source_artifact_ids?: string[];
  source_artifact_label: string | null;
  source_artifact_type: string | null;
  source_s3_key: string | null;
  source_input_s3_key?: string | null;
  render_association_id?: string | null;
  service: string;
  prompt: string;
  status: string;
  runpod_job_id: string | null;
  error_message: string | null;
  progress_phase?: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  artifacts: PostprocessArtifactRecord[];
};

export type PostprocessSourceArtifact = {
  id: string;
  simulationId: string | null;
  artifactType: string;
  contentType: string | null;
  s3Key: string | null;
  producerJobId: string | null;
  label: string;
  sourceKind: "render" | "cosmos" | "other";
  createdAt: string;
  mediaUrl: string | null;
};

export type PreviewFrame = {
  frame: number;
  timestamp: number;
  actors: ScenarioSimulationStreamMessage["actors"];
};

export type SavedPreviewTimeline = {
  version: 1;
  jobId?: string | null;
  savedAt: string;
  frameCount: number;
  durationSeconds: number;
  fixedDeltaSeconds: number;
  frames: PreviewFrame[];
};

export type PageLogEntryCategory =
  | "command_error"
  | "terminal_job_error"
  | "config_blocker"
  | "background_stale"
  | "background_degraded"
  | "material_outage"
  | "activity";

export type PageLogEntry = {
  id: string;
  timestamp: string;
  scope: "app" | "simulate" | "render" | "cosmos" | "system";
  level: "info" | "warn" | "error";
  category: PageLogEntryCategory;
  surface?: string | null;
  scopeKey?: string | null;
  message: string;
};
