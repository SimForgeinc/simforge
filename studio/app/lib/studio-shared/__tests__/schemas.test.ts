import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DatasetSchema, CreateDatasetInputSchema, VariationConfigSchema } from "../dataset";
import { CanonicalArtifactSchema, ArtifactManifestSchema } from "../artifact";
import { BaseJobContractSchema, CanonicalJobStatusSchema, JobFamilySchema } from "../job-family";
import { EntityObjectSchema, RenderOutputSpecSchema, SensorSchema, ManeuverActionSchema } from "../simulation-run";
import { SimulationStatus, ScenarioStatus } from "../run-status";
import { DatasetExportTaskInputSchema } from "../dataset-export-task-input";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadInvalidPublicationFinalizeCases() {
  return JSON.parse(
    readFileSync(resolve(__dirname, "./fixtures/dataset-export-task-input-publication-finalize-invalid.json"), "utf8"),
  ) as Array<{ name: string; payload: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------
// 1. DatasetSchema
// ---------------------------------------------------------------------------
describe("DatasetSchema", () => {
  const validDataset = {
    id: "ds-1",
    workspaceId: "ws-1",
    name: "My Dataset",
    status: "pending",
    totalVariations: 10,
    completedVariations: 0,
    failedVariations: 0,
    stats: {
      scenarioCount: 0,
      renderSubmittedCount: 0,
      renderCompletedCount: 0,
      cosmosSubmittedCount: 0,
      cosmosCompletedCount: 0,
      modelSubmittedCount: 0,
      modelCompletedCount: 0,
      exportCompletedCount: 0,
      updatedAt: null,
      repairState: "healthy",
      version: 1,
    },
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("parses a valid dataset", () => {
    const result = DatasetSchema.parse(validDataset);
    expect(result.id).toBe("ds-1");
    expect(result.scope).toBe("workspace"); // default
    expect(result.isSystem).toBe(false); // default
  });

  it("rejects empty name", () => {
    const bad = { ...validDataset, name: "" };
    expect(DatasetSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects invalid status", () => {
    const bad = { ...validDataset, status: "unknown" };
    expect(DatasetSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. CreateDatasetInputSchema
// ---------------------------------------------------------------------------
describe("CreateDatasetInputSchema", () => {
  it("parses minimal input", () => {
    const result = CreateDatasetInputSchema.parse({ name: "Test" });
    expect(result.name).toBe("Test");
  });

  it("rejects missing name", () => {
    expect(CreateDatasetInputSchema.safeParse({}).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. VariationConfigSchema
// ---------------------------------------------------------------------------
describe("VariationConfigSchema", () => {
  it("parses valid config", () => {
    const result = VariationConfigSchema.parse({ count: 5, seed: 42 });
    expect(result.count).toBe(5);
    expect(result.seed).toBe(42);
  });

  it("rejects count < 1", () => {
    expect(VariationConfigSchema.safeParse({ count: 0 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. CanonicalArtifactSchema
// ---------------------------------------------------------------------------
describe("CanonicalArtifactSchema", () => {
  const validArtifact = {
    id: "art-1",
    workspaceId: "ws-1",
    artifactFamily: "carla",
    artifactType: "recording",
    s3Bucket: "simforge-assets-dev",
    createdAt: "2024-01-01T00:00:00Z",
  };

  it("parses a valid artifact", () => {
    const result = CanonicalArtifactSchema.parse(validArtifact);
    expect(result.id).toBe("art-1");
    expect(result.isRaw).toBe(true); // default
    expect(result.status).toBe("ready"); // default
    expect(result.retentionClass).toBe("raw_source"); // default
  });

  it("accepts model service output artifact families", () => {
    expect(
      CanonicalArtifactSchema.parse({
        ...validArtifact,
        artifactFamily: "evaluation",
        artifactType: "vlm_evaluation_report",
      }).artifactFamily,
    ).toBe("evaluation");
    expect(
      CanonicalArtifactSchema.parse({
        ...validArtifact,
        artifactFamily: "model_output",
        artifactType: "cosmos_reason2_output",
      }).artifactFamily,
    ).toBe("model_output");
  });

  it("rejects empty workspaceId", () => {
    const bad = { ...validArtifact, workspaceId: "" };
    expect(CanonicalArtifactSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects invalid artifactFamily", () => {
    const bad = { ...validArtifact, artifactFamily: "unknown_family" };
    expect(CanonicalArtifactSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. ArtifactManifestSchema
// ---------------------------------------------------------------------------
describe("ArtifactManifestSchema", () => {
  const validManifest = {
    contractVersion: "simforge.artifact-manifest.v1",
    workspaceId: "ws-1",
    producerJobFamily: "openscenario_render",
    producerJobId: "job-1",
    generatedAt: "2024-01-01T00:00:00Z",
    artifacts: [],
  };

  it("parses a valid manifest", () => {
    const result = ArtifactManifestSchema.parse(validManifest);
    expect(result.contractVersion).toBe("simforge.artifact-manifest.v1");
    expect(result.artifacts).toHaveLength(0);
  });

  it("rejects wrong contractVersion literal", () => {
    const bad = { ...validManifest, contractVersion: "wrong.version" };
    expect(ArtifactManifestSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. BaseJobContractSchema
// ---------------------------------------------------------------------------
describe("BaseJobContractSchema", () => {
  const validJob = {
    id: "job-1",
    workspaceId: "ws-1",
    status: "queued",
    phase: "queued",
    jobType: "render",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
  };

  it("parses a valid job contract", () => {
    const result = BaseJobContractSchema.parse(validJob);
    expect(result.id).toBe("job-1");
    expect(result.priority).toBe(0); // default
    expect(result.retryCount).toBe(0); // default
  });

  it("rejects invalid status", () => {
    const bad = { ...validJob, status: "paused" };
    expect(BaseJobContractSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects empty id", () => {
    const bad = { ...validJob, id: "" };
    expect(BaseJobContractSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. CanonicalJobStatusSchema + JobFamilySchema (enum coverage)
// ---------------------------------------------------------------------------
describe("CanonicalJobStatusSchema", () => {
  it("accepts all valid statuses", () => {
    for (const s of ["queued", "running", "succeeded", "failed", "cancelled"]) {
      expect(CanonicalJobStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects unknown status", () => {
    expect(CanonicalJobStatusSchema.safeParse("paused").success).toBe(false);
  });
});

describe("JobFamilySchema", () => {
  it("accepts the unified OpenSCENARIO job families", () => {
    for (const family of [
      "openscenario_compile",
      "openscenario_validate",
      "openscenario_render",
      "artifact_postprocess",
    ]) {
      expect(JobFamilySchema.safeParse(family).success).toBe(true);
    }
  });

  it("rejects retired and implementation-specific family names", () => {
    for (const family of [
      "carla_jobs",
      "cosmos_jobs",
      "dataset_export_jobs",
      "dataset_curation_jobs",
      "model_services",
      "model_training_jobs",
      "model_evaluation_jobs",
    ]) {
      expect(JobFamilySchema.safeParse(family).success).toBe(false);
    }
  });

  it("rejects unknown family", () => {
    expect(JobFamilySchema.safeParse("banana_jobs").success).toBe(false);
  });
});

describe("DatasetExportTaskInputSchema", () => {
  it("rejects invalid publication_finalize combinations", () => {
    for (const testCase of loadInvalidPublicationFinalizeCases()) {
      expect(DatasetExportTaskInputSchema.safeParse(testCase.payload).success, testCase.name).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. EntityObjectSchema — discriminated union (vehicle | pedestrian | miscObject)
// ---------------------------------------------------------------------------
describe("EntityObjectSchema (discriminated union)", () => {
  it("parses a vehicle entity", () => {
    const result = EntityObjectSchema.parse({
      type: "vehicle",
      name: "ego",
      vehicleCategory: "car",
    });
    expect(result.type).toBe("vehicle");
  });

  it("parses a pedestrian entity", () => {
    const result = EntityObjectSchema.parse({
      type: "pedestrian",
      name: "ped-1",
      pedestrianCategory: "pedestrian",
    });
    expect(result.type).toBe("pedestrian");
  });

  it("parses a miscObject entity", () => {
    const result = EntityObjectSchema.parse({
      type: "miscObject",
      name: "cone-1",
      miscObjectCategory: "obstacle",
    });
    expect(result.type).toBe("miscObject");
  });

  it("rejects unknown type discriminant", () => {
    expect(EntityObjectSchema.safeParse({ type: "robot", name: "r1" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. ManeuverActionSchema — discriminated union (acquirePosition | stationary | speedAction)
// ---------------------------------------------------------------------------
describe("ManeuverActionSchema (discriminated union)", () => {
  it("parses acquirePosition", () => {
    const result = ManeuverActionSchema.parse({
      type: "acquirePosition",
      position: { x: 1, y: 2, z: 0, h: 0, p: 0, r: 0 },
      speed: 10,
    });
    expect(result.type).toBe("acquirePosition");
  });

  it("parses stationary", () => {
    const result = ManeuverActionSchema.parse({
      type: "stationary",
      duration: 5,
    });
    expect(result.type).toBe("stationary");
  });

  it("parses speedAction", () => {
    const result = ManeuverActionSchema.parse({
      type: "speedAction",
      value: 30,
    });
    expect(result.type).toBe("speedAction");
  });

  it("rejects unknown action type", () => {
    expect(ManeuverActionSchema.safeParse({ type: "flyAway" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. SensorSchema
// ---------------------------------------------------------------------------
describe("SensorSchema", () => {
  const validSensor = {
    id: "sensor-1",
    sensorCategory: "camera",
    outputModality: "rgb",
    attachTo: "ego",
    pose: { x: 0, y: 0, z: 1.5, roll: 0, pitch: 0, yaw: 0 },
  };

  it("parses a valid sensor", () => {
    const result = SensorSchema.parse(validSensor);
    expect(result.id).toBe("sensor-1");
    expect(result.label).toBe(""); // default
    expect(result.attachmentType).toBe("rigid"); // default
  });

  it("rejects invalid sensorCategory", () => {
    const bad = { ...validSensor, sensorCategory: "sonar" };
    expect(SensorSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects empty attachTo", () => {
    const bad = { ...validSensor, attachTo: "" };
    expect(SensorSchema.safeParse(bad).success).toBe(false);
  });
});

describe("RenderOutputSpecSchema", () => {
  it("accepts optional save_artifacts while preserving absent default behavior", () => {
    const absent = RenderOutputSpecSchema.parse({ version: 1 });
    expect(absent.save_artifacts).toBeUndefined();

    const enabled = RenderOutputSpecSchema.parse({
      version: 1,
      save_artifacts: true,
    });
    expect(enabled.save_artifacts).toBe(true);
  });

  it("does not model SDG bbox field policy on the legacy output spec", () => {
    const parsed = RenderOutputSpecSchema.parse({
      version: 1,
      profile: "sdg",
      bbox_policy: {
        emit_2d_visible_pixel: false,
        emit_3d_camera: true,
        emit_3d_world: false,
        emit_3d_projection: true,
      },
    });

    expect(parsed).not.toHaveProperty("bbox_policy");
  });
});

// ---------------------------------------------------------------------------
// 11. SimulationStatus / ScenarioStatus enums
// ---------------------------------------------------------------------------
describe("SimulationStatus", () => {
  it("accepts QUEUED", () => {
    expect(SimulationStatus.safeParse("QUEUED").success).toBe(true);
  });

  it("rejects lowercase queued", () => {
    expect(SimulationStatus.safeParse("queued").success).toBe(false);
  });
});

describe("ScenarioStatus", () => {
  it("accepts DRAFT and FINALIZED", () => {
    expect(ScenarioStatus.safeParse("DRAFT").success).toBe(true);
    expect(ScenarioStatus.safeParse("FINALIZED").success).toBe(true);
  });

  it("rejects invalid value", () => {
    expect(ScenarioStatus.safeParse("ARCHIVED").success).toBe(false);
  });
});
