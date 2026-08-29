/**
 * Shared test fixture factories for cross-repo contract tests.
 * Each factory validates output against its Zod schema and accepts partial overrides.
 */

import { SimulationArtifactSchema, SensorSchema } from "@simforge-oss/scenario/contracts";
import { ScenarioEditorDraftSchema } from "./scenario-editor";
import { SCENARIO_TIMING } from "@simforge-oss/scenario/contracts";
import type { SimulationArtifact, Sensor } from "@simforge-oss/scenario/contracts";
import type { ScenarioEditorDraft } from "./scenario-editor";

// ---------------------------------------------------------------------------
// SimulationJobPayload
// ---------------------------------------------------------------------------

export interface SimulationJobPayload {
  scenarioId: string;
  mapName: string;
  actors: Array<{
    id: string;
    blueprint: string;
    spawnRoadId: string;
    speedKph: number;
    role: "ego" | "traffic" | "pedestrian";
  }>;
  simulationConfig: {
    duration_seconds: number;
    fixed_delta_seconds: number;
  };
  sensors: Sensor[];
}

export function createSimulationJobPayload(
  overrides?: Partial<SimulationJobPayload>,
): SimulationJobPayload {
  const base: SimulationJobPayload = {
    scenarioId: crypto.randomUUID(),
    mapName: "Town10HD_Opt",
    actors: [
      {
        id: crypto.randomUUID(),
        blueprint: "vehicle.tesla.model3",
        spawnRoadId: "road_42",
        speedKph: 50,
        role: "ego",
      },
    ],
    simulationConfig: {
      duration_seconds: SCENARIO_TIMING.defaultDurationSeconds,
      fixed_delta_seconds: 0.05,
    },
    sensors: [createSensor()],
    ...overrides,
  };
  return base;
}

// ---------------------------------------------------------------------------
// WebhookCompletionPayload
// ---------------------------------------------------------------------------

export interface WebhookCompletionPayload {
  jobId: string;
  status: "COMPLETED";
  recordings: Array<{
    uri: string;
    sizeBytes: number;
    type: "MP4";
  }>;
}

export function createWebhookCompletionPayload(
  overrides?: Partial<WebhookCompletionPayload>,
): WebhookCompletionPayload {
  const jobId = crypto.randomUUID();
  const base: WebhookCompletionPayload = {
    jobId,
    status: "COMPLETED",
    recordings: [
      {
        uri: `file:///tmp/simforge/runs/${jobId}/recording.mp4`,
        sizeBytes: 52428800,
        type: "MP4",
      },
    ],
    ...overrides,
  };
  return base;
}

// ---------------------------------------------------------------------------
// ScenarioDraft
// ---------------------------------------------------------------------------

export function createScenarioDraft(
  overrides?: Partial<ScenarioEditorDraft>,
): ScenarioEditorDraft {
  const now = new Date().toISOString();
  const actorId = crypto.randomUUID();
  const sourceScenarioId = crypto.randomUUID();

  const base = {
    version: 2 as const,
    metadata: {
      sourceScenarioId,
      mapAssetId: "map-asset-town10hd",
      mapName: "Town10HD_Opt",
      backendMapName: "Town10HD_Opt",
      activeScenarioSimulationId: null,
      latestScenarioSimulationId: null,
      notes: "",
      createdAt: now,
      updatedAt: now,
    },
    simulationConfig: {
      duration_seconds: SCENARIO_TIMING.defaultDurationSeconds,
      fixed_delta_seconds: 0.05,
    },
    actors: [
      {
        id: actorId,
        label: "Ego Vehicle",
        kind: "vehicle" as const,
        role: "ego" as const,
        is_static: false,
        placement_mode: "road" as const,
        blueprint: "vehicle.tesla.model3",
        spawn: {
          road_id: "road_42",
          s_fraction: 0.5,
          lane_id: -1,
          section_id: 0,
        },
        spawn_point: null,
        route: [],
        route_direction: "forward" as const,
        lane_facing: "with_lane" as const,
        destination: null,
        destination_point: null,
        speed_kph: 50,
        autopilot: true,
        color: null,
        notes: null,
        timeline: [],
      },
    ],
    selectedActorId: null,
    worldSensors: [],
    ...overrides,
  };

  return ScenarioEditorDraftSchema.parse(base) as ScenarioEditorDraft;
}

// ---------------------------------------------------------------------------
// ArtifactRecord
// ---------------------------------------------------------------------------

export function createArtifactRecord(
  overrides?: Partial<SimulationArtifact>,
): SimulationArtifact {
  const id = crypto.randomUUID();
  const simulationId = crypto.randomUUID();
  const now = new Date().toISOString();

  const base = {
    id,
    simulationId,
    type: "MP4" as const,
    uri: `file:///tmp/simforge/runs/${simulationId}/recording.mp4`,
    sizeBytes: 52428800,
    createdAt: now,
    isAvailable: true,
    sensorId: undefined,
    environmentPresetRef: [],
    generatedBy: "CARLA Simulator" as const,
    sourceArtifactId: undefined,
    metadata: undefined,
    ...overrides,
  };

  return SimulationArtifactSchema.parse(base);
}

// ---------------------------------------------------------------------------
// Sensor
// ---------------------------------------------------------------------------

export function createSensor(overrides?: Partial<Sensor>): Sensor {
  const base = {
    id: crypto.randomUUID(),
    label: "Trailing",
    sensorCategory: "camera" as const,
    outputModality: "rgb" as const,
    attachTo: "ego",
    attachmentType: "spring_arm" as const,
    pose: {
      x: -6.0,
      y: 0.0,
      z: 2.5,
      roll: 0.0,
      pitch: -10.0,
      yaw: 0.0,
    },
    updateRate: 30,
    width: 1280,
    height: 720,
    fov: 90,
    ...overrides,
  };

  return SensorSchema.parse(base);
}
