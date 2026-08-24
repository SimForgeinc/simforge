import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows, withTransaction } from "@/app/lib/db/data-api";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedGetUrl,
  getPresignedPutUrl,
  headS3Object,
  MEDIA_URL_TTL_SECONDS,
} from "@/app/lib/s3/s3-presign";
import { deleteS3Keys } from "@/app/lib/s3/s3-delete";
import {
  getS3ObjectUtf8Bounded,
  sha256S3RawObjectBounded,
} from "@/app/lib/s3/s3-get-object";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import {
  OPENSCENARIO_NATIVE_PROFILE,
  UNISCENARIO_RENDER_CONTRACT_VERSION,
  type UniScenarioExportDto,
  type UniScenarioArtifactDto,
  type UniScenarioJobMode,
  type UniScenarioRenderJobDto,
  type UniScenarioJobProvenanceDto,
  UniScenarioRenderSpecSchema,
  type UniScenarioAmbientProvenance,
} from "./contracts";
import { canonicalJsonSha256, sha256, uniscenarioId } from "./core";
import type {
  ExecutionPackageMemberDto,
  ExecutionPackageMemberRole,
  ExecutionPackageMembersDto,
} from "./execution-package-contracts";
import { cancelOperationalJobWithResult } from "./jobs/store";
import {
  claimFirstEligibleUniScenarioJob,
  settlePipelineJob,
  withUniScenarioJobTransaction,
  type JobTransaction,
} from "./jobs/lifecycle-lock";
import type { z } from "zod";
import {
  isUniScenarioParityEvidenceAccepted,
  UNISCENARIO_PARITY_EVIDENCE_VERSION,
  UNISCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
  UNISCENARIO_RENDER_RESOURCE_REQUEST_VERSION,
  UNISCENARIO_LOCAL_RTX5080_HARDWARE_PROFILE,
  UNISCENARIO_RTX3080_HARDWARE_PROFILE,
  UniScenarioParityEvidenceV1Schema,
  UniScenarioRenderResourceRequestSchema,
  type UniScenarioParityEvidenceV1,
  type UniScenarioRenderResourceRequest,
  type UniScenarioRenderWorkerIdentity,
} from "@simcloud/shared";

type RenderSpec = z.infer<typeof UniScenarioRenderSpecSchema>;
const INTERACTION_RENDER_SPEC = {
  schema: "uniscenario.interaction-spec/v1",
  width: 64,
  height: 64,
  fps: 50,
  sensors: [],
  outputs: ["trace", "manifest"],
  executionMode: "native-physics",
} as const;
type StoredRenderSpec = RenderSpec | typeof INTERACTION_RENDER_SPEC;

type ExecutionPackageControlSource = {
  execution_package_id: string;
  revision_id: string;
  source_input_digest: string;
  xosc_sha256: string;
  xosc_size: number;
  xsd_sha256: string;
  xodr_sha256: string;
  xodr_size: number;
  map_name: string;
  map_version_id: string;
  map_asset_id: string;
  asset_catalog_version_id: string;
  asset_catalog_contract_version: "uniscenario.asset-catalog/v1";
  asset_catalog_sha256: string;
  asset_catalog_size: number;
  manifest_sha256: string;
  manifest_size: number;
  capability_profile: string;
  ambient_mode: "disabled" | "native" | "sumo";
  ambient_runtime_version: string | null;
  ambient_sumo_version: string | null;
  ambient_network_sha256: string | null;
  ambient_seed: string | null;
  ambient_config: Record<string, unknown>;
  ambient_config_sha256: string;
  ambient_result_sha256: string;
  materialized_traffic_sha256: string;
  traffic_size: number;
};

type RawExecutionPackageControlSource = Omit<
  ExecutionPackageControlSource,
  "ambient_config" | "map_name"
> & {
  ambient_config: string | Record<string, unknown>;
  map_name: string | null;
  scenario_duration_s: number;
};

function requireCookedCarlaMapName(mapName: string | null): string {
  const normalized = mapName?.trim();
  if (!normalized) throw new Error("uniscenario_carla_map_binding_missing");
  return normalized;
}

export function parseStoredRenderSpec(
  value: string | Record<string, unknown>,
  mode: UniScenarioJobMode,
): StoredRenderSpec {
  const parsed = parseJsonObject(value);
  if (mode === "interaction_2d") {
    if (canonicalJsonSha256(parsed) !== canonicalJsonSha256(INTERACTION_RENDER_SPEC)) {
      throw new Error("invalid_interaction_render_spec");
    }
    return INTERACTION_RENDER_SPEC;
  }
  return UniScenarioRenderSpecSchema.parse(parsed);
}

function artifactBucket() {
  return process.env.UNISCENARIO_ARTIFACT_BUCKET?.trim() || "local-artifacts";
}

function apiBaseUrl() {
  return (process.env.UNISCENARIO_API_BASE_URL?.trim() || "http://127.0.0.1:5199")
    .replace(/\/$/, "");
}

export function authorizeUniScenarioWorker(request: Request) {
  const expected =
    process.env.UNISCENARIO_RENDER_WORKER_TOKEN?.trim() || "uniscenarios-local-worker";
  const provided = request.headers
    .get("authorization")
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  if (!provided) return false;
  const left = Buffer.from(sha256(expected), "hex");
  const right = Buffer.from(sha256(provided), "hex");
  return timingSafeEqual(left, right);
}

export function renderWorkerNodeId(request: Request) {
  const workerNodeId = request.headers.get("x-uniscenario-worker-node-id")?.trim();
  return workerNodeId && workerNodeId.length <= 200 ? workerNodeId : null;
}

export async function authorizeUniScenarioRenderWorker(request: Request) {
  if (!renderWorkerNodeId(request)) return false;
  return authorizeUniScenarioWorker(request);
}

const LOCAL_RENDER_WORKER_NODE_ID = "uniscenario-render-local-path-pc";
const REQUIRED_WORKER_MODES = ["interaction_2d", "full_render"] as const;
const REQUIRED_TRAFFIC_MODES = ["disabled", "native", "sumo"] as const;
const REQUIRED_EXECUTION_MODES = ["native-physics"] as const;
const REQUIRED_SENSOR_KINDS = [
  "rgb",
  "depth",
  "semantic",
  "instance",
  "normals",
  "lidar",
  "semantic_lidar",
  "radar",
] as const;
const REQUIRED_OUTPUTS = ["video", "trace", "manifest", "annotations"] as const;
const REQUIRED_WORKER_LIMITS = {
  maxDurationS: 120,
  maxSensors: 4,
  maxCaptureFrames: 14_400,
  maxActors: 256,
  maxActorFrameStates: 2_000_000,
  maxSensorPixels: 450_000_000,
  maxOutputBytes: 2 * 1024 * 1024 * 1024,
  maxCameraWidth: 1920,
  maxCameraHeight: 1080,
  maxPixelsPerFrame: 8_294_400,
} as const;

function rfc3339Timestamp(value: string): string {
  const normalized = value
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00")
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Invalid control-plane timestamp: ${value}`);
  }
  return new Date(timestamp).toISOString();
}

function runtimeEnvironment(): "dev" | "staging" | "prod" {
  const value = process.env.SIMFORGE_ENV?.trim();
  if (value !== "dev" && value !== "staging" && value !== "prod") {
    throw new Error("SIMFORGE_ENV must identify the UniScenario control-plane environment.");
  }
  return value;
}

export function workerRegistrationCompatibilityError(
  input: {
    workerNodeId: string;
    environment: "dev" | "staging" | "prod";
    workerVersion: string;
    imageDigest: string;
    capabilities: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
  expectedEnvironment = runtimeEnvironment(),
): string | null {
  const requiredCapabilityKeys = [
    "xosc",
    "fixedTimestepS",
    "capabilityProfile",
    "hardwareProfile",
    "modes",
    "trafficModes",
    "executionModes",
    "sensorKinds",
    "outputs",
    "limits",
  ].sort();
  const exactStringSet = (value: unknown, expected: readonly string[]) =>
    Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
  if (input.environment !== expectedEnvironment) return "worker_environment_mismatch";
  if (!/^[a-f0-9]{40}$/.test(input.workerVersion)) return "worker_version_invalid";
  if (!/^sha256:[a-f0-9]{64}$/.test(input.imageDigest)) return "worker_image_digest_invalid";
  if (Object.keys(input.capabilities).sort().join("\0") !== requiredCapabilityKeys.join("\0")) {
    return "worker_capability_schema_invalid";
  }
  if (
    input.capabilities.xosc !== "1.4" ||
    input.capabilities.fixedTimestepS !== 0.02 ||
    input.capabilities.capabilityProfile !== "xml-1.4-trajectory-replay"
  ) {
    return "worker_xosc_profile_incompatible";
  }
  const hardwareProfile = input.capabilities.hardwareProfile;
  if (
    hardwareProfile !== UNISCENARIO_RTX3080_HARDWARE_PROFILE &&
    hardwareProfile !== UNISCENARIO_LOCAL_RTX5080_HARDWARE_PROFILE
  ) {
    return "worker_hardware_profile_incompatible";
  }
  const localProfile = hardwareProfile === UNISCENARIO_LOCAL_RTX5080_HARDWARE_PROFILE;
  if (localProfile !== (input.workerNodeId === LOCAL_RENDER_WORKER_NODE_ID)) {
    return "worker_local_node_identity_mismatch";
  }
  if (localProfile && input.environment !== "dev") {
    return "worker_local_profile_environment_incompatible";
  }
  if (!exactStringSet(input.capabilities.modes, REQUIRED_WORKER_MODES)) return "worker_mode_incompatible";
  if (!exactStringSet(input.capabilities.trafficModes, REQUIRED_TRAFFIC_MODES))
    return "worker_traffic_mode_incompatible";
  if (!exactStringSet(input.capabilities.executionModes, REQUIRED_EXECUTION_MODES))
    return "worker_execution_mode_incompatible";
  if (!exactStringSet(input.capabilities.sensorKinds, REQUIRED_SENSOR_KINDS)) return "worker_sensor_kind_incompatible";
  if (!exactStringSet(input.capabilities.outputs, REQUIRED_OUTPUTS)) return "worker_output_incompatible";
  const limits = input.capabilities.limits;
  if (
    !limits ||
    typeof limits !== "object" ||
    Object.keys(limits).sort().join("\0") !== Object.keys(REQUIRED_WORKER_LIMITS).sort().join("\0") ||
    Object.entries(REQUIRED_WORKER_LIMITS).some(
      ([key, expected]) => (limits as Record<string, unknown>)[key] !== expected,
    )
  )
    return "worker_limits_incompatible";
  return null;
}

export async function getUniScenarioControlPlaneHealth(workerNodeId?: string | null) {
  const environment = runtimeEnvironment();
  const apiUrl =
    process.env.UNISCENARIO_API_BASE_URL?.trim() || "http://127.0.0.1:5199";
  const bucket =
    process.env.UNISCENARIO_ARTIFACT_BUCKET?.trim() || "local-artifacts";
  const compilerVersion =
    process.env.UNISCENARIO_COMPILER_VERSION?.trim() || "uniscenario-compiler@2.0.0";
  const configurationReady = Boolean(apiUrl && bucket && compilerVersion);
  const rows = await queryRows<{
    worker_nodes_ready: boolean;
    render_jobs_ready: boolean;
    exports_ready: boolean;
    worker_registered: boolean;
  }>(
    `SELECT
       to_regclass('uniscenario.worker_nodes') IS NOT NULL AS worker_nodes_ready,
       to_regclass('uniscenario.render_jobs') IS NOT NULL AS render_jobs_ready,
       to_regclass('uniscenario.exports') IS NOT NULL AS exports_ready,
       CASE WHEN :worker_node_id = '' THEN true ELSE EXISTS (
         SELECT 1 FROM uniscenario.worker_nodes w
         WHERE w.id = :worker_node_id AND w.environment = :environment
           AND w.registration_state = 'active'
           AND w.last_heartbeat_at >= NOW() - INTERVAL '90 seconds'
           AND w.worker_version ~ '^[a-f0-9]{40}$'
           AND w.image_digest ~ '^sha256:[a-f0-9]{64}$'
           AND (
             (w.hardware_profile = 'rtx3080-10gb-v1'
               AND w.id <> 'uniscenario-render-local-path-pc')
             OR (
               :environment = 'dev'
               AND w.id = 'uniscenario-render-local-path-pc'
               AND w.hardware_profile = 'rtx5080-16gb-local-v1'
             )
           )
           AND w.approved_worker_version = w.worker_version
           AND w.approved_image_digest = w.image_digest
           AND w.approved_hardware_profile = w.hardware_profile
           AND w.approved_at IS NOT NULL
           AND w.capabilities->>'xosc' = '1.4'
           AND w.capabilities->'fixedTimestepS' = '0.02'::jsonb
           AND w.capabilities->>'capabilityProfile' = 'xml-1.4-trajectory-replay'
           AND w.capabilities->>'hardwareProfile' = w.hardware_profile
           AND w.capabilities->'modes' = '["interaction_2d","full_render"]'::jsonb
           AND w.capabilities->'trafficModes' = '["disabled","native","sumo"]'::jsonb
           AND w.capabilities->'executionModes' = '["native-physics"]'::jsonb
           AND w.capabilities->'sensorKinds' = '["rgb","depth","semantic","instance","normals","lidar","semantic_lidar","radar"]'::jsonb
           AND w.capabilities->'outputs' = '["video","trace","manifest","annotations"]'::jsonb
           AND w.capabilities->'limits' = '{"maxDurationS":120,"maxSensors":4,"maxCaptureFrames":14400,"maxActors":256,"maxActorFrameStates":2000000,"maxSensorPixels":450000000,"maxOutputBytes":2147483648,"maxCameraWidth":1920,"maxCameraHeight":1080,"maxPixelsPerFrame":8294400}'::jsonb
       ) END AS worker_registered`,
    { worker_node_id: workerNodeId ?? "", environment },
  );
  const database = rows[0];
  const databaseReady = Boolean(database?.worker_nodes_ready && database.render_jobs_ready && database.exports_ready);
  const workerRegistered = Boolean(database?.worker_registered);
  return {
    schema: "uniscenario.control-plane-health/v1" as const,
    status: configurationReady && databaseReady && workerRegistered ? ("ready" as const) : ("degraded" as const),
    environment,
    renderContractVersion: UNISCENARIO_RENDER_CONTRACT_VERSION,
    compilerVersion,
    checks: { configurationReady, databaseReady, workerRegistered },
  };
}

type ExportRow = {
  id: string;
  revision_id: string;
  export_format: "openscenario_xml_1_4";
  export_state: string;
  artifact_id: string | null;
  execution_package_id: string | null;
  compiler_version: string;
  error_code: string | null;
  error_detail: unknown;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

function exportDto(row: ExportRow): UniScenarioExportDto {
  return {
    id: row.id,
    revisionId: row.revision_id,
    format: row.export_format,
    status: row.export_state as UniScenarioExportDto["status"],
    artifactId: row.artifact_id,
    executionPackageId: row.execution_package_id,
    compilerVersion: row.compiler_version,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export async function listExports(context: AppContext, revisionId?: string | null) {
  const rows = await queryRows<ExportRow>(
    `SELECT id, revision_id, export_format, export_state, artifact_id, execution_package_id, compiler_version,
       error_code, error_detail, created_at::text AS created_at,
       started_at::text AS started_at, completed_at::text AS completed_at
     FROM uniscenario.exports
     WHERE workspace_id = :workspace_id
       ${revisionId ? "AND revision_id = :revision_id" : ""}
     ORDER BY created_at DESC, id LIMIT 100`,
    {
      workspace_id: context.workspaceId,
      ...(revisionId ? { revision_id: revisionId } : {}),
    },
  );
  return rows.map(exportDto);
}

export async function createExport(
  context: AppContext,
  input: {
    revisionId: string;
    idempotencyKey: string;
    ambient: UniScenarioAmbientProvenance;
  },
) {
  const id = uniscenarioId("usexp");
  const compilerVersion = process.env.UNISCENARIO_COMPILER_VERSION?.trim() || "uniscenario-compiler@2.0.0";
  const rows = await queryRows<ExportRow>(
    `INSERT INTO uniscenario.exports (
       id, workspace_id, revision_id, export_format, compiler_version, idempotency_key,
       requested_by_user_id,
       ambient_mode, ambient_runtime_version, ambient_sumo_version, ambient_network_sha256,
       ambient_seed, ambient_config, ambient_config_sha256, ambient_result_sha256,
       materialized_traffic_artifact_id, materialized_traffic_sha256,
       materialized_traffic_size_bytes, materialized_traffic_source_input_digest
     )
     SELECT :id, r.workspace_id, r.id, 'openscenario_xml_1_4', :compiler_version, :idempotency_key,
       :requested_by_user_id,
       r.ambient_mode, r.ambient_runtime_version, r.ambient_sumo_version, r.ambient_network_sha256,
       r.ambient_seed, r.ambient_config, r.ambient_config_sha256, r.ambient_result_sha256,
       r.materialized_traffic_artifact_id, r.materialized_traffic_sha256,
       r.materialized_traffic_size_bytes, r.materialized_traffic_source_input_digest
     FROM uniscenario.revisions r
     JOIN uniscenario.artifacts traffic
       ON traffic.id = r.materialized_traffic_artifact_id
      AND traffic.workspace_id = r.workspace_id
      AND traffic.artifact_kind = 'materialized-traffic'
      AND traffic.artifact_state = 'available'
      AND traffic.sha256 = r.materialized_traffic_sha256
      AND traffic.byte_length = r.materialized_traffic_size_bytes
     WHERE r.workspace_id = :workspace_id AND r.id = :revision_id
       AND r.materialized_traffic_sha256 = r.ambient_result_sha256
       AND r.materialized_traffic_source_input_digest ~ '^[a-f0-9]{64}$'
     ON CONFLICT (workspace_id, revision_id, export_format, idempotency_key)
     DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id, revision_id, export_format, export_state, artifact_id, execution_package_id, compiler_version,
       error_code, error_detail, created_at::text AS created_at,
       started_at::text AS started_at, completed_at::text AS completed_at`,
    {
      id,
      workspace_id: context.workspaceId,
      revision_id: input.revisionId,
      compiler_version: compilerVersion,
      idempotency_key: input.idempotencyKey,
      requested_by_user_id: context.userId,
    },
  );
  return rows[0] ? exportDto(rows[0]) : null;
}

export async function getExport(context: AppContext, exportId: string) {
  const rows = await queryRows<ExportRow>(
    `SELECT id, revision_id, export_format, export_state, artifact_id,
       execution_package_id, compiler_version, error_code, error_detail,
       created_at::text AS created_at, started_at::text AS started_at,
       completed_at::text AS completed_at
     FROM uniscenario.exports
     WHERE workspace_id = :workspace_id AND id = :export_id
     LIMIT 1`,
    { workspace_id: context.workspaceId, export_id: exportId },
  );
  return rows[0] ? exportDto(rows[0]) : null;
}

type ValidationRow = {
  id: string;
  revision_id: string;
  validator_kind: string;
  validator_version: string;
  validation_state: string;
  report_artifact_id: string | null;
  trace_artifact_id: string | null;
  summary: unknown;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export async function listValidationRuns(context: AppContext, revisionId?: string | null) {
  return queryRows<ValidationRow>(
    `SELECT v.id, v.revision_id, v.validator_kind, v.validator_version, v.validation_state,
       v.report_artifact_id,
       (SELECT l.artifact_id
          FROM uniscenario.operational_job_artifact_links l
          JOIN uniscenario.artifacts ta
            ON ta.id = l.artifact_id AND ta.artifact_kind = 'state-trace'
           AND ta.artifact_state = 'available'
         WHERE l.job_id = v.id AND l.job_family = 'openscenario_validate'
         ORDER BY l.id DESC LIMIT 1) AS trace_artifact_id,
       v.summary, v.created_at::text AS created_at,
       v.started_at::text AS started_at, v.completed_at::text AS completed_at
     FROM uniscenario.validation_runs v
     WHERE v.workspace_id = :workspace_id
       ${revisionId ? "AND v.revision_id = :revision_id" : ""}
     ORDER BY v.created_at DESC, v.id LIMIT 100`,
    {
      workspace_id: context.workspaceId,
      ...(revisionId ? { revision_id: revisionId } : {}),
    },
  );
}

export async function createValidationRun(
  context: AppContext,
  input: {
    revisionId: string;
    validatorKind: string;
    validatorVersion: string;
    idempotencyKey: string;
  },
) {
  const rows = await queryRows<ValidationRow>(
    `INSERT INTO uniscenario.validation_runs (
       id, workspace_id, revision_id, validator_kind, validator_version, idempotency_key,
       requested_by_user_id
     )
     SELECT :id, r.workspace_id, r.id, :validator_kind, :validator_version, :idempotency_key,
       :requested_by_user_id
     FROM uniscenario.revisions r
     WHERE r.workspace_id = :workspace_id AND r.id = :revision_id
     ON CONFLICT (workspace_id, revision_id, validator_kind, idempotency_key)
     DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id, revision_id, validator_kind, validator_version, validation_state,
       report_artifact_id, summary, created_at::text AS created_at,
       started_at::text AS started_at, completed_at::text AS completed_at`,
    {
      id: uniscenarioId("usval"),
      workspace_id: context.workspaceId,
      revision_id: input.revisionId,
      validator_kind: input.validatorKind,
      validator_version: input.validatorVersion,
      idempotency_key: input.idempotencyKey,
      requested_by_user_id: context.userId,
    },
  );
  return rows[0] ?? null;
}

type RenderJobRow = {
  id: string;
  workspace_id: string;
  revision_id: string;
  execution_package_id: string;
  origin_recording_job_id: string | null;
  render_profile_id: string | null;
  render_spec: unknown;
  parity_thresholds: unknown;
  request_contract_version: string;
  job_state: string;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_code: string | null;
  failure_detail: unknown;
  job_mode: UniScenarioJobMode;
  billing_mode: "free";
  estimated_cost_cents: number;
  telemetry: string | Record<string, unknown>;
  parity_result: string | Record<string, unknown> | null;
  parity_evidence: string | Record<string, unknown> | null;
  resource_request: string | Record<string, unknown> | null;
  worker_attestation: string | Record<string, unknown> | null;
  progress: number;
};

const RENDER_JOB_COLUMNS = `id, workspace_id, revision_id, execution_package_id,
  origin_recording_job_id,
  render_profile_id, render_spec, parity_thresholds, request_contract_version,
  job_mode, billing_mode, estimated_cost_cents, telemetry, parity_result, parity_evidence,
  resource_request, worker_attestation, progress,
  job_state, priority, attempt_count, max_attempts, idempotency_key,
  created_at::text AS created_at, updated_at::text AS updated_at,
  started_at::text AS started_at, completed_at::text AS completed_at,
  failure_code, failure_detail`;

function renderJobDto(row: RenderJobRow): UniScenarioRenderJobDto {
  const telemetry = parseJsonObject(row.telemetry);
  const parsedParityEvidence = row.parity_evidence
    ? UniScenarioParityEvidenceV1Schema.safeParse(parseJsonObject(row.parity_evidence))
    : null;
  const parityEvidence = parsedParityEvidence?.success ? parsedParityEvidence.data : null;
  const parsedResourceRequest = row.resource_request
    ? UniScenarioRenderResourceRequestSchema.safeParse(parseJsonObject(row.resource_request))
    : null;
  const resourceRequest = parsedResourceRequest?.success ? parsedResourceRequest.data : null;
  return {
    id: row.id,
    revisionId: row.revision_id,
    executionPackageId: row.execution_package_id,
    originRecordingJobId: row.origin_recording_job_id ?? null,
    mode: row.job_mode,
    status: row.job_state as UniScenarioRenderJobDto["status"],
    progress: Number(row.progress),
    billingMode: "free",
    estimatedCost: 0,
    renderSpec: row.job_mode === "full_render" ? (row.render_spec as RenderSpec) : null,
    telemetry: {
      ...(typeof telemetry.gpuSeconds === "number" ? { gpuSeconds: telemetry.gpuSeconds } : {}),
      ...(typeof telemetry.wallSeconds === "number" ? { wallSeconds: telemetry.wallSeconds } : {}),
      ...(typeof telemetry.storageBytes === "number" ? { storageBytes: telemetry.storageBytes } : {}),
      ...(typeof telemetry.outputBytes === "number" ? { outputBytes: telemetry.outputBytes } : {}),
    },
    parityResult: row.parity_result ? parseJsonObject(row.parity_result) : null,
    parityEvidence,
    resourceRequest,
    workerAttestation: row.worker_attestation
      ? { schema: "uniscenario.worker-attestation-status/v1", accepted: true }
      : null,
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function executionPackageControlValue(
  row: ExecutionPackageControlSource,
  jobMode: UniScenarioJobMode,
  renderSpec: StoredRenderSpec,
  resourceRequest: UniScenarioRenderResourceRequest,
): Record<string, unknown> {
  const runtimeRequirements = {
    schema: "uniscenario.runtime-requirements/v1" as const,
    xoscVersion: "1.4" as const,
    capabilityProfile: row.capability_profile,
    fixedTimestepS: 0.02 as const,
    jobMode,
    trafficMode: row.ambient_mode,
    executionMode: renderSpec.executionMode,
    sensorKinds: [...new Set(renderSpec.sensors.map((sensor) => sensor.kind))].sort(),
    outputs: [...new Set(renderSpec.outputs)].sort(),
    resources: resourceRequest,
  };
  return {
    schema: "uniscenario.execution-package/v1",
    id: row.execution_package_id,
    revisionId: row.revision_id,
    sourceInputDigest: row.source_input_digest,
    materializedTrafficDigest: row.materialized_traffic_sha256,
    mapAssetId: row.map_asset_id,
    mapVersionId: row.map_version_id,
    manifest: {
      sha256: row.manifest_sha256,
      sizeBytes: Number(row.manifest_size),
    },
    xosc: {
      sha256: row.xosc_sha256,
      sizeBytes: Number(row.xosc_size),
      xsdSha256: row.xsd_sha256,
    },
    xodr: {
      sha256: row.xodr_sha256,
      sizeBytes: Number(row.xodr_size),
      mapName: row.map_name,
    },
    assetCatalog: {
      contractVersion: row.asset_catalog_contract_version,
      catalogVersionId: row.asset_catalog_version_id,
      sha256: row.asset_catalog_sha256,
      sizeBytes: Number(row.asset_catalog_size),
    },
    ambient: {
      ambientMode: row.ambient_mode,
      ambientConfig: row.ambient_config,
      configSha256: row.ambient_config_sha256,
      resultSha256: row.ambient_result_sha256,
      materializedTraffic: {
        sha256: row.materialized_traffic_sha256,
        sizeBytes: Number(row.traffic_size),
      },
      ...(row.ambient_mode === "native"
        ? {
            runtimeVersion: row.ambient_runtime_version,
            seed: row.ambient_seed,
          }
        : {}),
      ...(row.ambient_mode === "sumo"
        ? {
            sumoVersion: row.ambient_sumo_version,
            networkSha256: row.ambient_network_sha256,
            seed: row.ambient_seed,
          }
        : {}),
    },
    runtimeRequirements,
  };
}

export function deriveRenderResourceRequest(
  jobMode: UniScenarioJobMode,
  renderSpec: StoredRenderSpec,
  scenarioDurationS: number,
): UniScenarioRenderResourceRequest {
  if (!Number.isFinite(scenarioDurationS) || scenarioDurationS <= 0) {
    throw new Error("uniscenario_render_duration_missing");
  }
  const sensors = jobMode === "full_render" ? renderSpec.sensors.length : 0;
  const capturedFramesPerSensor = jobMode === "full_render"
    ? Math.ceil(scenarioDurationS * renderSpec.fps)
    : 0;
  let pixelsPerFrame = 0;
  let maxCameraWidth = 0;
  let maxCameraHeight = 0;
  if (jobMode === "full_render") {
    for (const sensor of renderSpec.sensors) {
      if (!("width" in sensor.attributes)) continue;
      pixelsPerFrame += sensor.attributes.width * sensor.attributes.height;
      maxCameraWidth = Math.max(maxCameraWidth, sensor.attributes.width);
      maxCameraHeight = Math.max(maxCameraHeight, sensor.attributes.height);
    }
  }
  // Actor count is deliberately reserved at the protocol ceiling. The
  // materialized-traffic payload is immutable but is not a scheduling API, so
  // admission must not undercount actors by interpreting its contents here.
  const actors = REQUIRED_WORKER_LIMITS.maxActors;
  return UniScenarioRenderResourceRequestSchema.parse({
    schema: UNISCENARIO_RENDER_RESOURCE_REQUEST_VERSION,
    durationS: scenarioDurationS,
    sensors,
    captureFrames: capturedFramesPerSensor * sensors,
    actors,
    actorFrameStates: Math.ceil(scenarioDurationS / 0.02) * actors,
    sensorPixels: pixelsPerFrame * capturedFramesPerSensor,
    outputBytes: REQUIRED_WORKER_LIMITS.maxOutputBytes,
    maxCameraWidth,
    maxCameraHeight,
    pixelsPerFrame,
  });
}

export function renderResourceAdmissionError(
  request: UniScenarioRenderResourceRequest,
): string | null {
  const comparisons: Array<[keyof typeof REQUIRED_WORKER_LIMITS, number]> = [
    ["maxDurationS", request.durationS],
    ["maxSensors", request.sensors],
    ["maxCaptureFrames", request.captureFrames],
    ["maxActors", request.actors],
    ["maxActorFrameStates", request.actorFrameStates],
    ["maxSensorPixels", request.sensorPixels],
    ["maxOutputBytes", request.outputBytes],
    ["maxCameraWidth", request.maxCameraWidth],
    ["maxCameraHeight", request.maxCameraHeight],
    ["maxPixelsPerFrame", request.pixelsPerFrame],
  ];
  const exceeded = comparisons.find(([limit, value]) => value > REQUIRED_WORKER_LIMITS[limit]);
  return exceeded ? `uniscenario_render_resource_${exceeded[0]}_exceeded` : null;
}

export async function createRenderJob(
  context: Pick<AppContext, "workspaceId" | "userId">,
  input: {
    revisionId: string;
    executionPackageId: string;
    originRecordingJobId?: string | null;
    renderProfileId?: string | null;
    mode?: UniScenarioJobMode;
    renderSpec?: RenderSpec;
    parityThresholds?: Record<string, unknown>;
    idempotencyKey: string;
    priority?: number;
  },
) {
  const jobMode = input.mode ?? "full_render";
  const storedSpec: StoredRenderSpec = jobMode === "interaction_2d"
    ? INTERACTION_RENDER_SPEC
    : UniScenarioRenderSpecSchema.parse(input.renderSpec);
  const rows = await withTransaction(async (tx) => {
    await tx.queryOne(`SELECT pg_advisory_xact_lock(hashtext(:workspace_id)) AS locked`, {
      workspace_id: context.workspaceId,
    });
    const existing = await tx.queryOne<RenderJobRow>(
      `SELECT ${RENDER_JOB_COLUMNS} FROM uniscenario.render_jobs
       WHERE workspace_id = :workspace_id AND idempotency_key = :idempotency_key LIMIT 1`,
      {
        workspace_id: context.workspaceId,
        idempotency_key: input.idempotencyKey,
      },
    );
    if (existing) {
      if ((input.originRecordingJobId ?? null) !== (existing.origin_recording_job_id ?? null)) {
        throw new Error("uniscenario_render_origin_mismatch");
      }
      return [existing];
    }
    if (input.originRecordingJobId) {
      const recording = await tx.queryOne<{ id: string }>(
        `SELECT id
           FROM uniscenario.artifact_postprocess_jobs
          WHERE id = :origin_recording_job_id
            AND workspace_id = :workspace_id
            AND revision_id = :revision_id
            AND postprocess_kind = 'browser_threejs_recording'
            AND state = 'succeeded'
          LIMIT 1`,
        {
          origin_recording_job_id: input.originRecordingJobId,
          workspace_id: context.workspaceId,
          revision_id: input.revisionId,
        },
      );
      if (!recording) throw new Error("uniscenario_render_origin_not_eligible");
    }
    if (input.renderProfileId) {
      // A render profile is referenceable when it belongs to this workspace OR is platform-global
      // (workspace_id IS NULL). Anything else is another tenant's, and until now nothing checked:
      // render_profile_id went into the INSERT as a bare bind parameter while the revision and the
      // execution package were join-validated on workspace_id. This is checked explicitly here so the
      // caller gets a named error instead of the silent `null` a non-matching INSERT ... SELECT
      // returns, and it is enforced twice more below -- by the LEFT JOIN in that statement, and by
      // uniscenario_render_jobs_render_profile_scope_fence in the database -- so this check being
      // skipped or raced cannot let a cross-tenant reference through.
      const profile = await tx.queryOne<{ id: string }>(
        `SELECT id FROM uniscenario.render_profiles
          WHERE id = :render_profile_id
            AND (workspace_id IS NULL OR workspace_id = :workspace_id)
          LIMIT 1`,
        {
          render_profile_id: input.renderProfileId,
          workspace_id: context.workspaceId,
        },
      );
      if (!profile) throw new Error("uniscenario_render_profile_not_in_workspace");
    }
    const active = await tx.queryOne<{
      active_count: number;
      queued_count: number;
    }>(
      `SELECT COUNT(*) FILTER (WHERE job_state IN ('leased', 'running'))::int AS active_count,
         COUNT(*) FILTER (WHERE job_state = 'queued')::int AS queued_count
       FROM uniscenario.render_jobs WHERE workspace_id = :workspace_id`,
      { workspace_id: context.workspaceId },
    );
    const activeLimit = Math.max(1, Number(process.env.UNISCENARIO_WORKSPACE_CONCURRENCY_LIMIT ?? 2));
    const queueLimit = Math.max(activeLimit, Number(process.env.UNISCENARIO_WORKSPACE_QUEUE_LIMIT ?? 20));
    if (Number(active?.active_count ?? 0) >= activeLimit || Number(active?.queued_count ?? 0) >= queueLimit) {
      throw new Error("uniscenario_workspace_limit_reached");
    }
    const rawPackage = await tx.queryOne<RawExecutionPackageControlSource>(
      `SELECT ep.id AS execution_package_id, r.id AS revision_id, ep.source_input_digest,
         xa.sha256 AS xosc_sha256, xa.byte_length AS xosc_size, ep.xsd_sha256,
         da.sha256 AS xodr_sha256, da.byte_length AS xodr_size,
         COALESCE(
           NULLIF(BTRIM(ma.ue5_carla_map_name), ''),
           NULLIF(BTRIM(ma.carla_map_name), '')
         ) AS map_name,
         mv.id AS map_version_id, mv.source_map_asset_id AS map_asset_id,
         ep.asset_catalog_version_id, acv.contract_version AS asset_catalog_contract_version,
         ca.sha256 AS asset_catalog_sha256, ca.byte_length AS asset_catalog_size,
         pa.sha256 AS manifest_sha256, pa.byte_length AS manifest_size,
         ep.capability_profile,
         ep.ambient_mode, ep.ambient_runtime_version, ep.ambient_sumo_version,
         ep.ambient_network_sha256, ep.ambient_seed, ep.ambient_config::text AS ambient_config,
         ep.ambient_config_sha256, ep.ambient_result_sha256, ep.materialized_traffic_sha256,
         ta.byte_length AS traffic_size,
         (r.canonical_content #>> '{choreography,clipSeconds}')::double precision AS scenario_duration_s
       FROM uniscenario.revisions r
       JOIN uniscenario.execution_packages ep
         ON ep.revision_id = r.id AND ep.workspace_id = r.workspace_id
       LEFT JOIN uniscenario.map_versions mv ON mv.id = r.map_version_id
       LEFT JOIN public.map_assets ma ON ma.id = mv.source_map_asset_id
       JOIN uniscenario.artifacts xa
         ON xa.id = ep.xosc_artifact_id AND xa.workspace_id = ep.workspace_id
        AND xa.artifact_state = 'available'
       -- The revision's pinned map version may live in the platform maps workspace; its xodr
       -- (and the catalog that workspace owns) are shared infrastructure, so accept exactly
       -- that artifact across the boundary. Anything else stays workspace-fenced.
       JOIN uniscenario.artifacts da
         ON da.id = ep.xodr_artifact_id AND da.artifact_state = 'available'
        AND (da.workspace_id = ep.workspace_id
          OR (da.id = mv.xodr_artifact_id AND da.workspace_id = mv.workspace_id))
       JOIN uniscenario.asset_catalog_versions acv
         ON acv.id = ep.asset_catalog_version_id AND acv.status = 'active'
        AND (acv.workspace_id IS NULL OR acv.workspace_id = ep.workspace_id
          OR acv.workspace_id = mv.workspace_id)
       JOIN uniscenario.artifacts ca
         ON ca.id = acv.manifest_artifact_id AND ca.artifact_state = 'available'
       JOIN uniscenario.artifacts pa
         ON pa.id = ep.package_artifact_id AND pa.workspace_id = ep.workspace_id
        AND pa.artifact_state = 'available' AND pa.sha256 = ep.manifest_sha256
       JOIN uniscenario.artifacts ta
         ON ta.id = ep.materialized_traffic_artifact_id AND ta.workspace_id = ep.workspace_id
        AND ta.artifact_state = 'available' AND ta.sha256 = ep.materialized_traffic_sha256
       WHERE r.workspace_id = :workspace_id AND r.id = :revision_id
         AND ep.id = :execution_package_id
         AND ep.source_input_digest ~ '^[a-f0-9]{64}$'
         AND ep.materialized_traffic_sha256 = ep.ambient_result_sha256
         AND ep.materialized_traffic_source_input_digest = ep.source_input_digest
       LIMIT 1
       FOR SHARE OF ep`,
      {
        workspace_id: context.workspaceId,
        revision_id: input.revisionId,
        execution_package_id: input.executionPackageId,
      },
    );
    if (!rawPackage) return [];
    const packageSource: ExecutionPackageControlSource = {
      ...rawPackage,
      map_name: requireCookedCarlaMapName(rawPackage.map_name),
      ambient_config: parseJsonObject(rawPackage.ambient_config),
    };
    const resourceRequest = deriveRenderResourceRequest(
      jobMode,
      storedSpec,
      Number(rawPackage.scenario_duration_s),
    );
    const admissionError = renderResourceAdmissionError(resourceRequest);
    if (admissionError) throw new Error(admissionError);
    const packageControlSha256 = executionPackageControlSha256(
      executionPackageControlValue(packageSource, jobMode, storedSpec, resourceRequest),
    );
    return tx.queryRows<RenderJobRow>(
      `INSERT INTO uniscenario.render_jobs (
       id, workspace_id, revision_id, execution_package_id, execution_package_control_sha256,
       origin_recording_job_id, render_profile_id,
       render_spec, render_spec_sha256, parity_thresholds, resource_request, request_contract_version,
       job_mode, billing_mode, estimated_cost_cents,
       priority, idempotency_key, requested_by_user_id
     )
     SELECT :id, r.workspace_id, r.id, ep.id, :execution_package_control_sha256,
       recording.id, rp.id,
       CAST(:render_spec AS jsonb), :render_spec_sha256, CAST(:parity_thresholds AS jsonb),
       CAST(:resource_request AS jsonb),
       :contract_version, :job_mode, 'free', 0, :priority, :idempotency_key, :user_id
     FROM uniscenario.revisions r
     JOIN uniscenario.execution_packages ep
       ON ep.revision_id = r.id AND ep.workspace_id = r.workspace_id
     LEFT JOIN uniscenario.render_profiles rp
       ON rp.id = :render_profile_id
      AND (rp.workspace_id IS NULL OR rp.workspace_id = r.workspace_id)
     LEFT JOIN uniscenario.artifact_postprocess_jobs recording
       ON recording.id = :origin_recording_job_id
      AND recording.workspace_id = r.workspace_id
      AND recording.revision_id = r.id
      AND recording.postprocess_kind = 'browser_threejs_recording'
      AND recording.state = 'succeeded'
     WHERE r.workspace_id = :workspace_id AND r.id = :revision_id
       AND ep.id = :execution_package_id
       AND ep.source_input_digest ~ '^[a-f0-9]{64}$'
       AND ep.materialized_traffic_artifact_id IS NOT NULL
       AND ep.materialized_traffic_sha256 = ep.ambient_result_sha256
       AND ep.materialized_traffic_source_input_digest = ep.source_input_digest
       AND (CAST(:render_profile_id AS text) IS NULL OR rp.id IS NOT NULL)
       AND (CAST(:origin_recording_job_id AS text) IS NULL OR recording.id IS NOT NULL)
     ON CONFLICT (workspace_id, idempotency_key)
     DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING ${RENDER_JOB_COLUMNS}`,
      {
        id: uniscenarioId("usrj"),
        workspace_id: context.workspaceId,
        revision_id: input.revisionId,
        execution_package_id: input.executionPackageId,
        execution_package_control_sha256: packageControlSha256,
        origin_recording_job_id: input.originRecordingJobId ?? null,
        render_profile_id: input.renderProfileId ?? null,
        render_spec: storedSpec,
        render_spec_sha256: canonicalJsonSha256(storedSpec),
        // Stamp the platform acceptance limits when the caller does not pick
        // tighter thresholds: the worker's baked-in defaults are stricter than
        // the platform contract and would fail-close every unannotated job.
        parity_thresholds: input.parityThresholds ?? UNISCENARIO_NATIVE_PHYSICS_ACCEPTANCE_LIMITS,
        resource_request: resourceRequest,
        contract_version: UNISCENARIO_RENDER_CONTRACT_VERSION,
        job_mode: jobMode,
        priority: input.priority ?? 0,
        idempotency_key: input.idempotencyKey,
        user_id: context.userId,
      },
    );
  });
  return rows[0] ? renderJobDto(rows[0]) : null;
}

type ExecutionPackageMemberLocation = Omit<ExecutionPackageMemberDto, "url"> & {
  bucket: string;
  key: string;
};

type ExecutionPackageMemberClosureRow = {
  execution_package_id: string;
  xosc_bucket: string | null;
  xosc_key: string | null;
  xosc_sha256: string | null;
  xosc_byte_length: number | string | null;
  xosc_media_type: string | null;
  manifest_bucket: string | null;
  manifest_key: string | null;
  manifest_sha256: string | null;
  manifest_byte_length: number | string | null;
  manifest_media_type: string | null;
  xodr_bucket: string | null;
  xodr_key: string | null;
  xodr_sha256: string | null;
  xodr_byte_length: number | string | null;
  xodr_media_type: string | null;
  topology_bucket: string | null;
  topology_key: string | null;
  topology_sha256: string | null;
  topology_byte_length: number | string | null;
  topology_media_type: string | null;
  derived_topology_bucket: string | null;
  derived_topology_key: string | null;
  derived_topology_sha256: string | null;
  derived_topology_byte_length: number | string | null;
  derived_topology_media_type: string | null;
  locations_bucket: string | null;
  locations_key: string | null;
  locations_sha256: string | null;
  locations_byte_length: number | string | null;
  locations_media_type: string | null;
  signals_bucket: string | null;
  signals_key: string | null;
  signals_sha256: string | null;
  signals_byte_length: number | string | null;
  signals_media_type: string | null;
  catalog_bucket: string | null;
  catalog_key: string | null;
  catalog_sha256: string | null;
  catalog_byte_length: number | string | null;
  catalog_media_type: string | null;
};

function packageMemberLocation(
  row: ExecutionPackageMemberClosureRow,
  role: ExecutionPackageMemberRole,
  prefix: "xosc" | "manifest" | "xodr" | "topology" | "derived_topology" | "locations" | "signals" | "catalog",
): ExecutionPackageMemberLocation | null {
  const values = row as unknown as Record<string, number | string | null>;
  const bucket = values[`${prefix}_bucket`];
  const key = values[`${prefix}_key`];
  const sha256Value = values[`${prefix}_sha256`];
  const byteLengthValue = values[`${prefix}_byte_length`];
  const mediaType = values[`${prefix}_media_type`];
  if (
    typeof bucket !== "string"
    || typeof key !== "string"
    || typeof sha256Value !== "string"
    || !/^[a-f0-9]{64}$/.test(sha256Value)
    || typeof mediaType !== "string"
  ) {
    return null;
  }
  const byteLength = Number(byteLengthValue);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) return null;
  return { role, sha256: sha256Value, byteLength, mediaType, bucket, key };
}

export async function getExecutionPackageMembers(
  context: Pick<AppContext, "workspaceId">,
  executionPackageId: string,
): Promise<ExecutionPackageMembersDto | null> {
  const rows = await queryRows<ExecutionPackageMemberClosureRow>(
    `SELECT ep.id AS execution_package_id,
       xa.storage_bucket AS xosc_bucket, xa.storage_key AS xosc_key,
       xa.sha256 AS xosc_sha256, xa.byte_length AS xosc_byte_length, xa.media_type AS xosc_media_type,
       pa.storage_bucket AS manifest_bucket, pa.storage_key AS manifest_key,
       pa.sha256 AS manifest_sha256, pa.byte_length AS manifest_byte_length,
       pa.media_type AS manifest_media_type,
       da.storage_bucket AS xodr_bucket, da.storage_key AS xodr_key,
       da.sha256 AS xodr_sha256, da.byte_length AS xodr_byte_length, da.media_type AS xodr_media_type,
       t.storage_bucket AS topology_bucket, t.storage_key AS topology_key,
       t.sha256 AS topology_sha256, t.byte_length AS topology_byte_length, t.media_type AS topology_media_type,
       dt.storage_bucket AS derived_topology_bucket, dt.storage_key AS derived_topology_key,
       dt.sha256 AS derived_topology_sha256, dt.byte_length AS derived_topology_byte_length,
       dt.media_type AS derived_topology_media_type,
       l.storage_bucket AS locations_bucket, l.storage_key AS locations_key,
       l.sha256 AS locations_sha256, l.byte_length AS locations_byte_length, l.media_type AS locations_media_type,
       s.storage_bucket AS signals_bucket, s.storage_key AS signals_key,
       s.sha256 AS signals_sha256, s.byte_length AS signals_byte_length, s.media_type AS signals_media_type,
       ca.storage_bucket AS catalog_bucket, ca.storage_key AS catalog_key,
       ca.sha256 AS catalog_sha256, ca.byte_length AS catalog_byte_length, ca.media_type AS catalog_media_type
     FROM uniscenario.execution_packages ep
     JOIN uniscenario.revisions r
       ON r.id = ep.revision_id AND r.workspace_id = ep.workspace_id
     LEFT JOIN uniscenario.map_versions mv ON mv.id = r.map_version_id
     LEFT JOIN uniscenario.artifacts xa
       ON xa.id = ep.xosc_artifact_id AND xa.workspace_id = ep.workspace_id
      AND xa.artifact_state = 'available'
     LEFT JOIN uniscenario.artifacts pa
       ON pa.id = ep.package_artifact_id AND pa.workspace_id = ep.workspace_id
      AND pa.artifact_state = 'available' AND pa.sha256 = ep.manifest_sha256
     LEFT JOIN uniscenario.artifacts da
       ON da.id = ep.xodr_artifact_id AND da.artifact_state = 'available'
      AND (da.workspace_id = ep.workspace_id
        OR (da.id = mv.xodr_artifact_id AND da.workspace_id = mv.workspace_id))
     LEFT JOIN uniscenario.asset_catalog_versions acv
       ON acv.id = ep.asset_catalog_version_id AND acv.status = 'active'
      AND (acv.workspace_id IS NULL OR acv.workspace_id = ep.workspace_id
        OR acv.workspace_id = mv.workspace_id)
     LEFT JOIN uniscenario.artifacts ca
       ON ca.id = acv.manifest_artifact_id AND ca.artifact_state = 'available'
     LEFT JOIN uniscenario.artifacts t
       ON t.id = mv.topology_artifact_id AND t.workspace_id = mv.workspace_id
      AND t.artifact_state = 'available'
     LEFT JOIN uniscenario.artifacts dt
       ON dt.id = mv.derived_topology_artifact_id AND dt.workspace_id = mv.workspace_id
      AND dt.artifact_state = 'available'
     LEFT JOIN uniscenario.artifacts l
       ON l.id = mv.locations_artifact_id AND l.workspace_id = mv.workspace_id
      AND l.artifact_state = 'available'
     LEFT JOIN uniscenario.artifacts s
       ON s.id = mv.signals_artifact_id AND s.workspace_id = mv.workspace_id
      AND s.artifact_state = 'available'
     WHERE ep.id = :execution_package_id AND ep.workspace_id = :workspace_id
     LIMIT 1`,
    {
      execution_package_id: executionPackageId,
      workspace_id: context.workspaceId,
    },
  );
  const row = rows[0];
  if (!row) return null;

  const xosc = packageMemberLocation(row, "xosc", "xosc");
  const manifest = packageMemberLocation(row, "execution-manifest", "manifest");
  const xodr = packageMemberLocation(row, "map-xodr", "xodr");
  const catalog = packageMemberLocation(row, "asset-catalog", "catalog");
  if (!xosc || !manifest || !xodr || !catalog) {
    throw new Error("uniscenario_execution_package_required_member_missing");
  }
  const locations = [
    xosc,
    manifest,
    xodr,
    packageMemberLocation(row, "map-topology", "topology"),
    packageMemberLocation(row, "map-derived-topology", "derived_topology"),
    packageMemberLocation(row, "map-locations", "locations"),
    packageMemberLocation(row, "map-signals", "signals"),
    catalog,
  ].filter((member): member is ExecutionPackageMemberLocation => member !== null);
  const members = await Promise.all(
    locations.map(async ({ bucket, key, ...member }) => ({
      ...member,
      url: await getPresignedGetUrl(key, bucket, MEDIA_URL_TTL_SECONDS),
    })),
  );
  return { members };
}

export async function listRenderJobs(context: AppContext, limit = 50) {
  const rows = await queryRows<RenderJobRow>(
    `SELECT ${RENDER_JOB_COLUMNS} FROM uniscenario.render_jobs
     WHERE workspace_id = :workspace_id ORDER BY created_at DESC, id LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      row_limit: Math.max(1, Math.min(limit, 100)),
    },
  );
  return rows.map(renderJobDto);
}

export async function getRenderJob(context: AppContext, jobId: string) {
  const rows = await queryRows<RenderJobRow>(
    `SELECT ${RENDER_JOB_COLUMNS} FROM uniscenario.render_jobs
     WHERE workspace_id = :workspace_id AND id = :job_id LIMIT 1`,
    { workspace_id: context.workspaceId, job_id: jobId },
  );
  return rows[0] ? renderJobDto(rows[0]) : null;
}

export async function getRenderJobProvenance(
  context: AppContext,
  jobId: string,
): Promise<UniScenarioJobProvenanceDto | null> {
  const rows = await queryRows<{
    document_id: string;
    revision_id: string;
    revision_number: number;
    source_sha256: string;
    source_input_digest: string | null;
    openscenario_profile: string;
    compiler_version: string;
    validation_state: string | null;
    xosc_artifact_id: string;
    xosc_sha256: string;
    execution_package_id: string;
    package_sha256: string;
    map_version_id: string;
    xodr_sha256: string;
    asset_catalog_version_id: string;
    asset_catalog_sha256: string;
    coordinate_system_id: string;
    coordinate_system_sha256: string;
    ambient_mode: string;
    ambient_runtime_version: string | null;
    ambient_sumo_version: string | null;
    ambient_network_sha256: string | null;
    ambient_seed: string | null;
    ambient_config: string | Record<string, unknown>;
    ambient_config_sha256: string;
    ambient_result_sha256: string;
    materialized_traffic_sha256: string | null;
    capability_report: string | Record<string, unknown>;
  }>(
    `SELECT r.document_id, r.id AS revision_id, r.revision_number,
       r.content_sha256 AS source_sha256, ep.source_input_digest, r.openscenario_profile, ep.compiler_version,
       vr.validation_state, ep.xosc_artifact_id, xa.sha256 AS xosc_sha256,
       ep.id AS execution_package_id, ep.manifest_sha256 AS package_sha256,
       mv.id AS map_version_id, da.sha256 AS xodr_sha256,
       ep.asset_catalog_version_id, ca.sha256 AS asset_catalog_sha256, mv.coordinate_system_id,
       mv.coordinate_system_sha256, ep.ambient_mode, ep.ambient_runtime_version,
       ep.ambient_sumo_version, ep.ambient_network_sha256, ep.ambient_seed,
       ep.ambient_config, ep.ambient_config_sha256, ep.ambient_result_sha256,
       ep.materialized_traffic_sha256, r.capability_report
     FROM uniscenario.render_jobs j
     JOIN uniscenario.revisions r ON r.id = j.revision_id AND r.workspace_id = j.workspace_id
     JOIN uniscenario.execution_packages ep ON ep.id = j.execution_package_id AND ep.workspace_id = j.workspace_id
     JOIN uniscenario.map_versions mv ON mv.id = r.map_version_id
     JOIN uniscenario.artifacts xa ON xa.id = ep.xosc_artifact_id
     JOIN uniscenario.artifacts da ON da.id = ep.xodr_artifact_id
     JOIN uniscenario.asset_catalog_versions acv
       ON acv.id = ep.asset_catalog_version_id
      AND acv.status = 'active'
      AND (acv.workspace_id IS NULL OR acv.workspace_id = j.workspace_id)
     JOIN uniscenario.artifacts ca ON ca.id = acv.manifest_artifact_id
     LEFT JOIN LATERAL (
       SELECT validation_state FROM uniscenario.validation_runs
       WHERE workspace_id = j.workspace_id AND revision_id = j.revision_id
       ORDER BY created_at DESC LIMIT 1
     ) vr ON TRUE
     WHERE j.workspace_id = :workspace_id AND j.id = :job_id LIMIT 1`,
    { workspace_id: context.workspaceId, job_id: jobId },
  );
  const row = rows[0];
  if (!row) return null;
  const [artifacts, events] = await Promise.all([
    queryRows<{
      id: string;
      artifact_kind: string;
      sha256: string;
      byte_length: number;
      media_type: string;
      metadata: string | Record<string, unknown>;
    }>(
      `SELECT a.id, a.artifact_kind, a.sha256, a.byte_length, a.media_type,
         a.metadata::text AS metadata
       FROM uniscenario.artifact_links l JOIN uniscenario.artifacts a ON a.id = l.artifact_id
       WHERE l.workspace_id = :workspace_id AND l.render_job_id = :job_id AND a.artifact_state = 'available'
       ORDER BY a.created_at, a.id`,
      { workspace_id: context.workspaceId, job_id: jobId },
    ),
    queryRows<{
      event_ordinal: number;
      event_type: string;
      occurred_at: string;
      event_payload: string | Record<string, unknown>;
    }>(
      `SELECT event_ordinal, event_type, occurred_at::text AS occurred_at, event_payload
       FROM uniscenario.job_events WHERE workspace_id = :workspace_id AND render_job_id = :job_id
       ORDER BY event_ordinal LIMIT 500`,
      { workspace_id: context.workspaceId, job_id: jobId },
    ),
  ]);
  const capability = parseJsonObject(row.capability_report);
  return {
    documentId: row.document_id,
    revisionId: row.revision_id,
    revisionNumber: Number(row.revision_number),
    sourceRevisionSha256: row.source_sha256,
    sourceInputDigest: row.source_input_digest,
    openScenarioProfile: OPENSCENARIO_NATIVE_PROFILE,
    compilerVersion: row.compiler_version,
    validationStatus: row.validation_state,
    xoscArtifactId: row.xosc_artifact_id,
    xoscSha256: row.xosc_sha256,
    executionPackageId: row.execution_package_id,
    executionPackageSha256: row.package_sha256,
    mapVersionId: row.map_version_id,
    xodrSha256: row.xodr_sha256,
    assetCatalogSha256: row.asset_catalog_sha256,
    coordinateSystemId: row.coordinate_system_id,
    coordinateSystemSha256: row.coordinate_system_sha256,
    ambient: {
      ambientMode: row.ambient_mode,
      ambientConfig: parseJsonObject(row.ambient_config),
      configSha256: row.ambient_config_sha256,
      resultSha256: row.ambient_result_sha256,
      ...(row.ambient_mode === "native"
        ? {
            runtimeVersion: row.ambient_runtime_version,
            seed: row.ambient_seed,
          }
        : {}),
      ...(row.ambient_mode === "sumo"
        ? {
            sumoVersion: row.ambient_sumo_version,
            networkSha256: row.ambient_network_sha256,
            seed: row.ambient_seed,
            materializedTrafficSha256: row.materialized_traffic_sha256,
          }
        : {}),
    },
    traffic: { mode: row.ambient_mode },
    capabilityWarnings: Array.isArray(capability.warnings) ? capability.warnings : [],
    artifacts: artifacts.map((item) => ({
      id: item.id,
      kind: item.artifact_kind,
      sha256: item.sha256,
      sizeBytes: Number(item.byte_length),
      mediaType: item.media_type,
      metadata: parseJsonObject(item.metadata ?? {}),
    })),
    events: events.map((item) => ({
      sequence: Number(item.event_ordinal),
      type: item.event_type,
      occurredAt: item.occurred_at,
      payload: parseJsonObject(item.event_payload),
    })),
  };
}

export async function cancelRenderJob(context: AppContext, jobId: string) {
  const cancellation = await cancelOperationalJobWithResult(context, jobId, {
    family: "openscenario_render",
  });
  if (!cancellation.mutated && cancellation.job?.status !== "cancelled") return null;
  return getRenderJob(context, jobId);
}

export async function registerWorker(input: {
  workerNodeId: string;
  environment: "dev" | "staging" | "prod";
  workerVersion: string;
  imageDigest: string;
  capabilities: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  const compatibilityError = workerRegistrationCompatibilityError(input);
  if (compatibilityError) throw new Error(compatibilityError);
  const rows = await queryRows<{ id: string; registration_state: "active" | "draining" | "disabled" }>(
    `INSERT INTO uniscenario.worker_nodes (
       id, environment, worker_version, image_digest, hardware_profile, capabilities, metadata,
       registration_state
     ) VALUES (
       :id, :environment, :worker_version, :image_digest, :hardware_profile,
       CAST(:capabilities AS jsonb), CAST(:metadata AS jsonb), 'disabled'
     )
     ON CONFLICT (id) DO UPDATE SET
       environment = EXCLUDED.environment,
       worker_version = EXCLUDED.worker_version,
       image_digest = EXCLUDED.image_digest,
       hardware_profile = EXCLUDED.hardware_profile,
       capabilities = EXCLUDED.capabilities,
       metadata = EXCLUDED.metadata,
       registration_state = CASE
         WHEN uniscenario.worker_nodes.registration_state IN ('active', 'draining')
          AND uniscenario.worker_nodes.approved_worker_version = EXCLUDED.worker_version
          AND uniscenario.worker_nodes.approved_image_digest = EXCLUDED.image_digest
          AND uniscenario.worker_nodes.approved_hardware_profile = EXCLUDED.hardware_profile
         THEN uniscenario.worker_nodes.registration_state
         ELSE 'disabled'
       END,
       last_heartbeat_at = NOW()
     RETURNING id, registration_state`,
    {
      id: input.workerNodeId,
      environment: input.environment,
      worker_version: input.workerVersion,
      image_digest: input.imageDigest,
      hardware_profile: input.capabilities.hardwareProfile as string,
      capabilities: input.capabilities,
      metadata: input.metadata ?? {},
    },
  );
  const state = rows[0]?.registration_state ?? "disabled";
  return { workerNodeId: input.workerNodeId, registered: true as const, state, eligible: state === "active" };
}

export async function heartbeatIdleRenderWorker(
  workerNodeId: string,
  identity: UniScenarioRenderWorkerIdentity,
) {
  const rows = await queryRows<{ registration_state: "active" | "draining" }>(
    `UPDATE uniscenario.worker_nodes
        SET last_heartbeat_at = NOW(), last_idle_heartbeat_at = NOW()
      WHERE id = :worker_node_id AND environment = :environment
        AND registration_state IN ('active', 'draining')
        AND worker_version = :worker_version
        AND image_digest = :image_digest
        AND hardware_profile = :hardware_profile
        AND approved_worker_version = worker_version
        AND approved_image_digest = image_digest
        AND approved_hardware_profile = hardware_profile
      RETURNING registration_state`,
    {
      worker_node_id: workerNodeId,
      environment: runtimeEnvironment(),
      worker_version: identity.workerVersion,
      image_digest: identity.imageDigest,
      hardware_profile: identity.hardwareProfile,
    },
  );
  return rows[0]
    ? { workerNodeId, state: rows[0].registration_state, heartbeatAccepted: true as const }
    : null;
}

export async function setRenderWorkerState(
  workerNodeId: string,
  input: { state: "active" | "draining" | "disabled"; reason: string },
) {
  return withTransaction(async (tx) => {
    const worker = await tx.queryOne<{
      id: string;
      environment: string;
      worker_version: string;
      image_digest: string;
      hardware_profile: string | null;
      capabilities: string | Record<string, unknown>;
    }>(
      `SELECT id, environment, worker_version, image_digest, hardware_profile, capabilities
         FROM uniscenario.worker_nodes WHERE id = :worker_node_id FOR UPDATE`,
      { worker_node_id: workerNodeId },
    );
    if (!worker || worker.environment !== runtimeEnvironment()) return null;
    if (input.state === "active") {
      const compatibilityError = workerRegistrationCompatibilityError({
        workerNodeId: worker.id,
        environment: worker.environment as "dev" | "staging" | "prod",
        workerVersion: worker.worker_version,
        imageDigest: worker.image_digest,
        capabilities: parseJsonObject(worker.capabilities),
      });
      if (compatibilityError) throw new Error(compatibilityError);
      const activated = await tx.queryOne<{ id: string }>(
        `UPDATE uniscenario.worker_nodes
            SET registration_state = 'active',
                approved_worker_version = worker_version,
                approved_image_digest = image_digest,
                approved_hardware_profile = hardware_profile,
                approved_at = NOW(), state_changed_at = NOW(),
                metadata = metadata || jsonb_build_object(
                  'lastStateReason', :reason,
                  'lastStateChangedAt', NOW()
                )
          WHERE id = :worker_node_id
            AND (
              (hardware_profile = 'rtx3080-10gb-v1'
                AND id <> 'uniscenario-render-local-path-pc')
              OR (
                :environment = 'dev'
                AND id = 'uniscenario-render-local-path-pc'
                AND hardware_profile = 'rtx5080-16gb-local-v1'
              )
            )
            AND worker_version ~ '^[a-f0-9]{40}$'
            AND image_digest ~ '^sha256:[a-f0-9]{64}$'
          RETURNING id`,
        {
          worker_node_id: workerNodeId,
          environment: runtimeEnvironment(),
          reason: input.reason,
        },
      );
      return activated ? { workerNodeId, state: input.state } : null;
    }
    if (input.state === "disabled") {
      const activeLease = await tx.queryOne<{ id: string }>(
        `SELECT id FROM uniscenario.worker_leases
          WHERE worker_node_id = :worker_node_id AND lease_state = 'active'
          LIMIT 1 FOR SHARE`,
        { worker_node_id: workerNodeId },
      );
      if (activeLease) throw new Error("worker_has_active_lease");
    }
    await tx.execute(
      `UPDATE uniscenario.worker_nodes
          SET registration_state = :registration_state, state_changed_at = NOW(),
              metadata = metadata || jsonb_build_object(
                'lastStateReason', :reason,
                'lastStateChangedAt', NOW()
              )
        WHERE id = :worker_node_id`,
      { worker_node_id: workerNodeId, registration_state: input.state, reason: input.reason },
    );
    return { workerNodeId, state: input.state };
  });
}

export async function provisionRenderWorkerCredential(
  workerNodeId: string,
  input: { token: string; reason: string },
) {
  return withTransaction(async (tx) => {
    const worker = await tx.queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.worker_nodes
        WHERE id = :worker_node_id AND environment = :environment
          AND (
            (hardware_profile = 'rtx3080-10gb-v1'
              AND id <> 'uniscenario-render-local-path-pc')
            OR (
              :environment = 'dev'
              AND id = 'uniscenario-render-local-path-pc'
              AND hardware_profile = 'rtx5080-16gb-local-v1'
            )
          )
        FOR UPDATE`,
      { worker_node_id: workerNodeId, environment: runtimeEnvironment() },
    );
    if (!worker) return null;
    const activeLease = await tx.queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.worker_leases
        WHERE worker_node_id = :worker_node_id AND lease_state = 'active'
        LIMIT 1 FOR SHARE`,
      { worker_node_id: workerNodeId },
    );
    if (activeLease) throw new Error("worker_has_active_lease");
    await tx.execute(
      `UPDATE uniscenario.render_worker_credentials
          SET credential_state = 'revoked', revoked_at = NOW()
        WHERE worker_node_id = :worker_node_id AND credential_state = 'active'`,
      { worker_node_id: workerNodeId },
    );
    await tx.execute(
      `INSERT INTO uniscenario.render_worker_credentials (
         id, worker_node_id, token_sha256, reason
       ) VALUES (:id, :worker_node_id, :token_sha256, :reason)`,
      {
        id: uniscenarioId("usrwc"),
        worker_node_id: workerNodeId,
        token_sha256: sha256(input.token),
        reason: input.reason,
      },
    );
    return { workerNodeId, credentialProvisioned: true as const };
  });
}

export async function revokeRenderWorkerCredential(
  workerNodeId: string,
  reason: string,
) {
  return withTransaction(async (tx) => {
    const activeLease = await tx.queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.worker_leases
        WHERE worker_node_id = :worker_node_id AND lease_state = 'active'
        LIMIT 1 FOR SHARE`,
      { worker_node_id: workerNodeId },
    );
    if (activeLease) throw new Error("worker_has_active_lease");
    const rows = await tx.queryRows<{ id: string }>(
      `UPDATE uniscenario.render_worker_credentials
          SET credential_state = 'revoked', revoked_at = NOW(), reason = :reason
        WHERE worker_node_id = :worker_node_id AND credential_state = 'active'
        RETURNING id`,
      { worker_node_id: workerNodeId, reason },
    );
    return rows.length ? { workerNodeId, credentialRevoked: true as const } : null;
  });
}

type LeaseSourceRow = {
  id: string;
  workspace_id: string;
  revision_id: string;
  execution_package_id: string;
  job_execution_package_control_sha256: string;
  source_input_digest: string;
  attempt_count: number;
  job_mode: UniScenarioJobMode;
  render_spec: StoredRenderSpec;
  resource_request: UniScenarioRenderResourceRequest;
  parity_thresholds: Record<string, unknown> | null;
  xosc_artifact_id: string;
  xosc_bucket: string;
  xosc_key: string;
  xosc_sha256: string;
  xosc_size: number;
  xsd_sha256: string;
  xodr_artifact_id: string;
  xodr_bucket: string;
  xodr_key: string;
  xodr_sha256: string;
  xodr_size: number;
  map_name: string;
  map_version_id: string;
  map_asset_id: string;
  asset_catalog_version_id: string;
  asset_catalog_contract_version: "uniscenario.asset-catalog/v1";
  asset_catalog_bucket: string;
  asset_catalog_key: string;
  asset_catalog_sha256: string;
  asset_catalog_size: number;
  manifest_bucket: string;
  manifest_key: string;
  manifest_sha256: string;
  manifest_size: number;
  capability_profile: string;
  ambient_mode: "disabled" | "native" | "sumo";
  ambient_runtime_version: string | null;
  ambient_sumo_version: string | null;
  ambient_network_sha256: string | null;
  ambient_seed: string | null;
  ambient_config: Record<string, unknown>;
  ambient_config_sha256: string;
  ambient_result_sha256: string;
  materialized_traffic_sha256: string;
  traffic_bucket: string;
  traffic_key: string;
  traffic_size: number;
};
type RawLeaseSourceRow = Omit<
  LeaseSourceRow,
  "render_spec" | "resource_request" | "parity_thresholds" | "ambient_config" | "map_name"
> & {
  render_spec: string | Record<string, unknown>;
  resource_request: string | Record<string, unknown>;
  parity_thresholds: string | Record<string, unknown> | null;
  ambient_config: string | Record<string, unknown>;
  map_name: string | null;
};

type UploadReservation = {
  id: string;
  artifactKind: string;
  mediaType: string;
  bucket: string;
  key: string;
  expiresAt: string;
};

function stripPackageUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPackageUrls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "url" && key !== "controlSha256")
      .map(([key, item]) => [key, stripPackageUrls(item)]),
  );
}

export function executionPackageControlSha256(value: Record<string, unknown>): string {
  return canonicalJsonSha256(stripPackageUrls(value));
}

/**
 * The stable artifact name the CARLA bridge derives for a sensor
 * (`Sensor.artifact_name` = `role:actor:sensorId:modality`). The legacy
 * render-spec/v1 sensor carries one `id` for both the role and the sensor id.
 */
function bridgeSensorArtifactName(sensor: RenderSpec["sensors"][number]): string {
  const modality = sensor.kind === "semantic_lidar" ? "semantic-lidar" : sensor.kind;
  return `${sensor.id}:${sensor.attachTo}:${sensor.id}:${modality}`;
}

function outputReservations(row: LeaseSourceRow, attemptId: string, expiresAt: string): UploadReservation[] {
  const outputs = new Set(row.render_spec.outputs);
  const specs: Array<[string, string]> = [
    ["trace", "application/gzip"],
    ["parity-report", "application/json"],
  ];
  if (row.job_mode === "interaction_2d") {
    specs.push(["manifest", "application/json"]);
    return specs.map(([artifactKind, mediaType]) => {
      const id = uniscenarioId("usup");
      return {
        id,
        artifactKind,
        mediaType,
        bucket: artifactBucket(),
        key: `${row.workspace_id}/interactions/${row.id}/${attemptId}/${id}`,
        expiresAt,
      };
    });
  }
  specs.push(["manifest", "application/json"]);
  const sensors = row.render_spec.sensors;
  if (outputs.has("video")) {
    specs.push(["video", "video/mp4"]);
    // Every sensor gets its own encoded video: cameras stream their pixels,
    // lidar/radar get visualizations. The primary RGB camera's stream IS the
    // review "video" upload, so it is not reserved twice.
    const primaryRgb = sensors.find((sensor) => sensor.kind === "rgb");
    for (const sensor of sensors) {
      if (sensor === primaryRgb) continue;
      specs.push([`sensorVideo:${bridgeSensorArtifactName(sensor)}`, "video/mp4"]);
    }
  }
  // Lidar/radar measurement data always uploads; camera frame archives were
  // removed outright (cameras are video-only).
  for (const sensor of sensors) {
    if (sensor.kind === "lidar" || sensor.kind === "semantic_lidar" || sensor.kind === "radar") {
      specs.push([`sensorData:${bridgeSensorArtifactName(sensor)}`, "application/zip"]);
    }
  }
  if (outputs.has("annotations")) specs.push(["annotations", "application/x-ndjson"]);
  const bucket = artifactBucket();
  return specs.map(([artifactKind, mediaType]) => {
    const id = uniscenarioId("usup");
    return {
      id,
      artifactKind,
      mediaType,
      bucket,
      key: `${row.workspace_id}/renders/${row.id}/${attemptId}/${id}`,
      expiresAt,
    };
  });
}

async function reapExpiredRenderJobs() {
  const candidates = await queryRows<{ id: string }>(
    `SELECT job.id FROM uniscenario.render_jobs job
      WHERE job.job_state IN ('leased', 'running')
        AND job.job_mode IN ('interaction_2d', 'full_render') AND (
          EXISTS (SELECT 1 FROM uniscenario.worker_leases lease
                   WHERE lease.render_job_id = job.id AND lease.lease_state = 'active'
                     AND lease.expires_at <= NOW())
          OR NOT EXISTS (SELECT 1 FROM uniscenario.worker_leases lease
                         WHERE lease.render_job_id = job.id AND lease.lease_state = 'active')
        )
      ORDER BY job.updated_at, job.id LIMIT 100`,
  );
  for (const candidate of candidates) {
    await withUniScenarioJobTransaction(candidate.id, async (tx) => {
      await tx.execute(
        `UPDATE uniscenario.worker_leases lease
            SET lease_state = CASE WHEN job.cancel_requested_at IS NOT NULL THEN 'revoked' ELSE 'expired' END,
                released_at = NOW()
           FROM uniscenario.render_jobs job
          WHERE job.id = :job_id AND lease.render_job_id = job.id
            AND lease.lease_state = 'active' AND lease.expires_at <= NOW()`,
        { job_id: candidate.id },
      );
      const expiredAttempt = await tx.queryOne<{ id: string }>(
        `UPDATE uniscenario.render_attempts attempt
            SET attempt_state = CASE WHEN job.cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'expired' END,
                completed_at = NOW()
           FROM uniscenario.render_jobs job
          WHERE job.id = :job_id AND attempt.render_job_id = job.id
            AND attempt.attempt_state IN ('leased', 'running')
            AND NOT EXISTS (
              SELECT 1 FROM uniscenario.worker_leases lease
               WHERE lease.render_attempt_id = attempt.id AND lease.lease_state = 'active'
            )
          RETURNING attempt.id`,
        { job_id: candidate.id },
      );
      await tx.execute(
        `UPDATE uniscenario.artifact_uploads upload
            SET upload_state = 'cancelled'
           FROM uniscenario.render_jobs job
          WHERE job.id = :job_id AND upload.render_job_id = job.id
            AND upload.upload_state = 'reserved'`,
        { job_id: candidate.id },
      );
      const terminalized = await tx.queryOne<{
        id: string;
        workspace_id: string;
        state: "queued" | "failed" | "cancelled";
      }>(
        `UPDATE uniscenario.render_jobs job
              SET job_state = CASE
                    WHEN job.cancel_requested_at IS NOT NULL THEN 'cancelled'
                    WHEN job.attempt_count < job.max_attempts THEN 'queued'
                    ELSE 'failed'
                  END,
                  failure_code = CASE
                    WHEN job.cancel_requested_at IS NOT NULL THEN COALESCE(job.failure_code, 'cancelled')
                    WHEN job.attempt_count < job.max_attempts THEN NULL
                    ELSE 'lease_attempts_exhausted'
                  END,
                  completed_at = CASE
                    WHEN job.cancel_requested_at IS NOT NULL OR job.attempt_count >= job.max_attempts
                      THEN COALESCE(job.completed_at, NOW()) ELSE NULL END,
                  updated_at = NOW()
            WHERE job.id = :job_id AND job.job_state IN ('leased', 'running')
              AND job.job_mode IN ('interaction_2d', 'full_render')
              AND NOT EXISTS (
                SELECT 1 FROM uniscenario.worker_leases lease
                 WHERE lease.render_job_id = job.id AND lease.lease_state = 'active'
              )
          RETURNING job.id, job.workspace_id, job.job_state AS state`,
        { job_id: candidate.id },
      );
      if (!terminalized) return;
      await insertRenderLifecycleEvent(tx, {
        workspaceId: terminalized.workspace_id,
        jobId: terminalized.id,
        attemptId: expiredAttempt?.id ?? null,
        type: terminalized.state === "queued" ? "retry_queued" : terminalized.state,
        payload: {
          reason: terminalized.state === "queued"
            ? "expired_lease"
            : terminalized.state === "failed"
              ? "attempts_exhausted"
              : "expired_cancel_requested_lease",
          requestedBy: "control_plane_reaper",
          acknowledgedByWorker: false,
        },
      });
      if (terminalized.state !== "queued") {
        await settlePipelineJob(tx, {
          workspaceId: terminalized.workspace_id,
          jobFamily: "openscenario_render",
          jobId: terminalized.id,
          outcome: terminalized.state,
        });
      }
    });
  }
}

export async function leaseRenderJob(input: { workerNodeId: string; leaseSeconds: number }) {
  const leaseSeconds = Math.max(30, Math.min(input.leaseSeconds, 180));
  await reapExpiredRenderJobs();
  // A lease poll is also the worker's idle heartbeat. Previously only an
  // acquired lease refreshed the node, so a healthy empty worker became
  // unhealthy after ninety seconds.
  await queryRows(
    `UPDATE uniscenario.worker_nodes
        SET last_heartbeat_at = NOW(), last_idle_heartbeat_at = NOW()
      WHERE id = :worker_node_id AND environment = :environment
        AND registration_state = 'active'
        AND approved_worker_version = worker_version
        AND approved_image_digest = image_digest
        AND approved_hardware_profile = hardware_profile
      RETURNING id`,
    { worker_node_id: input.workerNodeId, environment: runtimeEnvironment() },
  );
  const candidates = await queryRows<{ id: string }>(
    `SELECT job.id
       FROM uniscenario.render_jobs job
       JOIN uniscenario.revisions revision
         ON revision.id = job.revision_id AND revision.workspace_id = job.workspace_id
       JOIN uniscenario.execution_packages ep
         ON ep.id = job.execution_package_id AND ep.workspace_id = job.workspace_id
       LEFT JOIN uniscenario.map_versions mv ON mv.id = revision.map_version_id
       JOIN uniscenario.artifacts xosc
         ON xosc.id = ep.xosc_artifact_id AND xosc.workspace_id = ep.workspace_id
        AND xosc.artifact_state = 'available'
       -- Same cross-workspace allowance as createRenderJob: only the pinned map version's
       -- own xodr/catalog may come from the platform maps workspace.
       JOIN uniscenario.artifacts xodr
         ON xodr.id = ep.xodr_artifact_id AND xodr.artifact_state = 'available'
        AND (xodr.workspace_id = ep.workspace_id
          OR (xodr.id = mv.xodr_artifact_id AND xodr.workspace_id = mv.workspace_id))
       JOIN uniscenario.asset_catalog_versions catalog
         ON catalog.id = ep.asset_catalog_version_id AND catalog.status = 'active'
        AND (catalog.workspace_id IS NULL OR catalog.workspace_id = job.workspace_id
          OR catalog.workspace_id = mv.workspace_id)
       JOIN uniscenario.artifacts catalog_artifact
         ON catalog_artifact.id = catalog.manifest_artifact_id
        AND catalog_artifact.artifact_state = 'available'
       JOIN uniscenario.artifacts package_artifact
         ON package_artifact.id = ep.package_artifact_id
        AND package_artifact.workspace_id = job.workspace_id
        AND package_artifact.artifact_state = 'available'
        AND package_artifact.sha256 = ep.manifest_sha256
       JOIN uniscenario.artifacts traffic
         ON traffic.id = ep.materialized_traffic_artifact_id
        AND traffic.workspace_id = ep.workspace_id
        AND traffic.artifact_state = 'available'
       JOIN uniscenario.worker_nodes worker ON worker.id = :worker_node_id
      WHERE job.job_state = 'queued' AND job.cancel_requested_at IS NULL
        AND job.job_mode IN ('interaction_2d', 'full_render')
        AND job.attempt_count < job.max_attempts
        AND job.request_contract_version = :request_contract_version
        AND ep.source_input_digest ~ '^[a-f0-9]{64}$'
        AND ep.materialized_traffic_source_input_digest = ep.source_input_digest
        AND ep.materialized_traffic_sha256 = ep.ambient_result_sha256
        AND worker.registration_state = 'active' AND worker.environment = :environment
        AND worker.worker_version ~ '^[a-f0-9]{40}$'
        AND worker.image_digest ~ '^sha256:[a-f0-9]{64}$'
        AND (
          (worker.hardware_profile = 'rtx3080-10gb-v1'
            AND worker.id <> 'uniscenario-render-local-path-pc')
          OR (
            :environment = 'dev'
            AND worker.id = 'uniscenario-render-local-path-pc'
            AND worker.hardware_profile = 'rtx5080-16gb-local-v1'
          )
        )
        AND worker.approved_worker_version = worker.worker_version
        AND worker.approved_image_digest = worker.image_digest
        AND worker.approved_hardware_profile = worker.hardware_profile
        AND worker.approved_at IS NOT NULL
        AND worker.capabilities->>'xosc' = '1.4'
        AND worker.capabilities->'fixedTimestepS' = '0.02'::jsonb
        AND worker.capabilities->>'capabilityProfile' = 'xml-1.4-trajectory-replay'
        AND worker.capabilities->>'hardwareProfile' = worker.hardware_profile
        AND job.resource_request->>'schema' = 'uniscenario.render-resource-request/v1'
        AND worker.capabilities->'modes' ? job.job_mode
        AND worker.capabilities->'trafficModes' ? ep.ambient_mode
        AND worker.capabilities->'executionModes' ? COALESCE(job.render_spec->>'executionMode', 'native-physics')
        AND jsonb_typeof(job.render_spec->'sensors') = 'array'
        AND jsonb_typeof(worker.capabilities->'sensorKinds') = 'array'
        AND jsonb_array_length(COALESCE(job.render_spec->'sensors', '[]'::jsonb))
          <= (worker.capabilities->'limits'->>'maxSensors')::integer
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(job.render_spec->'sensors', '[]'::jsonb)) sensor
           WHERE NOT (worker.capabilities->'sensorKinds' ? (sensor->>'kind'))
        )
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(job.render_spec->'outputs', '[]'::jsonb)) output
           WHERE NOT (worker.capabilities->'outputs' ? output)
        )
        AND (job.resource_request->>'durationS')::double precision
          <= (worker.capabilities->'limits'->>'maxDurationS')::double precision
        AND (job.resource_request->>'sensors')::bigint
          <= (worker.capabilities->'limits'->>'maxSensors')::bigint
        AND (job.resource_request->>'captureFrames')::bigint
          <= (worker.capabilities->'limits'->>'maxCaptureFrames')::bigint
        AND (job.resource_request->>'actors')::bigint
          <= (worker.capabilities->'limits'->>'maxActors')::bigint
        AND (job.resource_request->>'actorFrameStates')::bigint
          <= (worker.capabilities->'limits'->>'maxActorFrameStates')::bigint
        AND (job.resource_request->>'sensorPixels')::bigint
          <= (worker.capabilities->'limits'->>'maxSensorPixels')::bigint
        AND (job.resource_request->>'outputBytes')::bigint
          <= (worker.capabilities->'limits'->>'maxOutputBytes')::bigint
        AND (job.resource_request->>'maxCameraWidth')::bigint
          <= (worker.capabilities->'limits'->>'maxCameraWidth')::bigint
        AND (job.resource_request->>'maxCameraHeight')::bigint
          <= (worker.capabilities->'limits'->>'maxCameraHeight')::bigint
        AND (job.resource_request->>'pixelsPerFrame')::bigint
          <= (worker.capabilities->'limits'->>'maxPixelsPerFrame')::bigint
        AND NOT EXISTS (
          SELECT 1 FROM uniscenario.worker_leases node_lease
           WHERE node_lease.worker_node_id = worker.id AND node_lease.lease_state = 'active'
        )
      ORDER BY job.priority DESC, job.created_at, job.id LIMIT 16`,
    {
      worker_node_id: input.workerNodeId,
      environment: runtimeEnvironment(),
      request_contract_version: UNISCENARIO_RENDER_CONTRACT_VERSION,
    },
  );
  const transactionResult = await claimFirstEligibleUniScenarioJob(
    candidates,
    (candidate) => candidate.id,
    async (tx, candidate) => {
      const leaseToken = randomBytes(32).toString("hex");
      const attemptId = uniscenarioId("usat");
      const leaseId = uniscenarioId("uslease");
    const worker = await tx.queryOne<{
      id: string;
      worker_class: string;
      runtime_version: string;
      image_digest: string;
    }>(
      `UPDATE uniscenario.worker_nodes SET last_heartbeat_at = NOW()
       WHERE id = :worker_node_id AND registration_state = 'active'
         AND environment = :environment
         AND worker_version ~ '^[a-f0-9]{40}$'
         AND image_digest ~ '^sha256:[a-f0-9]{64}$'
         AND (
           (hardware_profile = 'rtx3080-10gb-v1'
             AND id <> 'uniscenario-render-local-path-pc')
           OR (
             :environment = 'dev'
             AND id = 'uniscenario-render-local-path-pc'
             AND hardware_profile = 'rtx5080-16gb-local-v1'
           )
         )
         AND approved_worker_version = worker_version
         AND approved_image_digest = image_digest
         AND approved_hardware_profile = hardware_profile
         AND approved_at IS NOT NULL
         AND capabilities->>'xosc' = '1.4'
         AND capabilities->'fixedTimestepS' = '0.02'::jsonb
         AND capabilities->>'capabilityProfile' = 'xml-1.4-trajectory-replay'
         AND capabilities->>'hardwareProfile' = hardware_profile
         AND capabilities->'modes' = '["interaction_2d","full_render"]'::jsonb
         AND capabilities->'trafficModes' = '["disabled","native","sumo"]'::jsonb
         AND capabilities->'executionModes' = '["native-physics"]'::jsonb
         AND capabilities->'sensorKinds' = '["rgb","depth","semantic","instance","normals","lidar","semantic_lidar","radar"]'::jsonb
         AND capabilities->'outputs' = '["video","trace","manifest","annotations"]'::jsonb
         AND capabilities->'limits' = '{"maxDurationS":120,"maxSensors":4,"maxCaptureFrames":14400,"maxActors":256,"maxActorFrameStates":2000000,"maxSensorPixels":450000000,"maxOutputBytes":2147483648,"maxCameraWidth":1920,"maxCameraHeight":1080,"maxPixelsPerFrame":8294400}'::jsonb
         AND NOT EXISTS (
           SELECT 1 FROM uniscenario.worker_leases active
            WHERE active.worker_node_id = uniscenario.worker_nodes.id
              AND active.lease_state = 'active'
         )
       RETURNING id, capabilities->>'capabilityProfile' AS worker_class,
         worker_version AS runtime_version, image_digest`,
      { worker_node_id: input.workerNodeId, environment: runtimeEnvironment() },
    );
    if (!worker) return null;

    const rawRow = await tx.queryOne<RawLeaseSourceRow>(
      `SELECT j.id, j.workspace_id, j.revision_id, j.execution_package_id,
         j.execution_package_control_sha256 AS job_execution_package_control_sha256,
         ep.source_input_digest,
         j.attempt_count, j.job_mode, j.render_spec::text AS render_spec,
         j.resource_request::text AS resource_request,
         j.parity_thresholds::text AS parity_thresholds,
         ep.xosc_artifact_id, xa.storage_bucket AS xosc_bucket, xa.storage_key AS xosc_key,
         xa.sha256 AS xosc_sha256, xa.byte_length AS xosc_size, ep.xsd_sha256,
         ep.xodr_artifact_id, da.storage_bucket AS xodr_bucket, da.storage_key AS xodr_key,
         da.sha256 AS xodr_sha256, da.byte_length AS xodr_size,
         COALESCE(
           NULLIF(BTRIM(ma.ue5_carla_map_name), ''),
           NULLIF(BTRIM(ma.carla_map_name), '')
         ) AS map_name,
         mv.id AS map_version_id, mv.source_map_asset_id AS map_asset_id,
         ep.asset_catalog_version_id, acv.contract_version AS asset_catalog_contract_version,
         ca.storage_bucket AS asset_catalog_bucket,
         ca.storage_key AS asset_catalog_key, ca.sha256 AS asset_catalog_sha256,
         ca.byte_length AS asset_catalog_size,
         pa.storage_bucket AS manifest_bucket, pa.storage_key AS manifest_key,
         pa.sha256 AS manifest_sha256, pa.byte_length AS manifest_size,
         ep.capability_profile,
         ep.ambient_mode, ep.ambient_runtime_version, ep.ambient_sumo_version,
         ep.ambient_network_sha256, ep.ambient_seed, ep.ambient_config::text AS ambient_config,
         ep.ambient_config_sha256, ep.ambient_result_sha256, ep.materialized_traffic_sha256,
         ta.storage_bucket AS traffic_bucket, ta.storage_key AS traffic_key,
         ta.byte_length AS traffic_size
       FROM uniscenario.render_jobs j
       JOIN uniscenario.revisions r ON r.id = j.revision_id AND r.workspace_id = j.workspace_id
       JOIN uniscenario.execution_packages ep
         ON ep.id = j.execution_package_id AND ep.workspace_id = j.workspace_id
       LEFT JOIN uniscenario.map_versions mv ON mv.id = r.map_version_id
       LEFT JOIN public.map_assets ma ON ma.id = mv.source_map_asset_id
       JOIN uniscenario.artifacts xa
         ON xa.id = ep.xosc_artifact_id AND xa.workspace_id = ep.workspace_id
        AND xa.artifact_state = 'available'
       -- Same cross-workspace allowance as createRenderJob: only the pinned map version's
       -- own xodr/catalog may come from the platform maps workspace.
       JOIN uniscenario.artifacts da
         ON da.id = ep.xodr_artifact_id AND da.artifact_state = 'available'
        AND (da.workspace_id = ep.workspace_id
          OR (da.id = mv.xodr_artifact_id AND da.workspace_id = mv.workspace_id))
       JOIN uniscenario.asset_catalog_versions acv
         ON acv.id = ep.asset_catalog_version_id
        AND acv.status = 'active'
        AND (acv.workspace_id IS NULL OR acv.workspace_id = j.workspace_id
          OR acv.workspace_id = mv.workspace_id)
       JOIN uniscenario.artifacts ca
         ON ca.id = acv.manifest_artifact_id AND ca.artifact_state = 'available'
       JOIN uniscenario.artifacts pa
         ON pa.id = ep.package_artifact_id AND pa.workspace_id = j.workspace_id
        AND pa.artifact_state = 'available' AND pa.sha256 = ep.manifest_sha256
       JOIN uniscenario.artifacts ta
         ON ta.id = ep.materialized_traffic_artifact_id AND ta.workspace_id = ep.workspace_id
        AND ta.artifact_state = 'available'
       WHERE j.id = :job_id AND j.job_state = 'queued' AND j.cancel_requested_at IS NULL
         AND j.job_mode IN ('interaction_2d', 'full_render')
         AND ep.source_input_digest ~ '^[a-f0-9]{64}$'
         AND ep.materialized_traffic_source_input_digest = ep.source_input_digest
         AND ep.materialized_traffic_sha256 = ep.ambient_result_sha256
         AND j.attempt_count < j.max_attempts
         AND j.request_contract_version = :request_contract_version
         AND EXISTS (
           SELECT 1 FROM uniscenario.worker_nodes w
           WHERE w.id = :worker_node_id
             AND w.capabilities->'modes' ? j.job_mode
             AND w.capabilities->'trafficModes' ? ep.ambient_mode
             AND w.capabilities->'executionModes' ? COALESCE(j.render_spec->>'executionMode', 'native-physics')
             AND w.registration_state = 'active'
             AND w.environment = :environment
             AND (
               (w.hardware_profile = 'rtx3080-10gb-v1'
                 AND w.id <> 'uniscenario-render-local-path-pc')
               OR (
                 :environment = 'dev'
                 AND w.id = 'uniscenario-render-local-path-pc'
                 AND w.hardware_profile = 'rtx5080-16gb-local-v1'
               )
             )
             AND w.approved_worker_version = w.worker_version
             AND w.approved_image_digest = w.image_digest
             AND w.approved_hardware_profile = w.hardware_profile
             AND w.approved_at IS NOT NULL
             AND j.resource_request->>'schema' = 'uniscenario.render-resource-request/v1'
             AND jsonb_typeof(j.render_spec->'sensors') = 'array'
             AND jsonb_typeof(w.capabilities->'sensorKinds') = 'array'
             AND jsonb_array_length(COALESCE(j.render_spec->'sensors', '[]'::jsonb))
               <= (w.capabilities->'limits'->>'maxSensors')::integer
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(j.render_spec->'sensors', '[]'::jsonb)) sensor
               WHERE NOT (w.capabilities->'sensorKinds' ? (sensor->>'kind'))
             )
             AND NOT EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(COALESCE(j.render_spec->'outputs', '[]'::jsonb)) requested_output
               WHERE NOT (w.capabilities->'outputs' ? requested_output)
             )
             AND (j.resource_request->>'durationS')::double precision
               <= (w.capabilities->'limits'->>'maxDurationS')::double precision
             AND (j.resource_request->>'sensors')::bigint <= (w.capabilities->'limits'->>'maxSensors')::bigint
             AND (j.resource_request->>'captureFrames')::bigint <= (w.capabilities->'limits'->>'maxCaptureFrames')::bigint
             AND (j.resource_request->>'actors')::bigint <= (w.capabilities->'limits'->>'maxActors')::bigint
             AND (j.resource_request->>'actorFrameStates')::bigint <= (w.capabilities->'limits'->>'maxActorFrameStates')::bigint
             AND (j.resource_request->>'sensorPixels')::bigint <= (w.capabilities->'limits'->>'maxSensorPixels')::bigint
             AND (j.resource_request->>'outputBytes')::bigint <= (w.capabilities->'limits'->>'maxOutputBytes')::bigint
             AND (j.resource_request->>'maxCameraWidth')::bigint <= (w.capabilities->'limits'->>'maxCameraWidth')::bigint
             AND (j.resource_request->>'maxCameraHeight')::bigint <= (w.capabilities->'limits'->>'maxCameraHeight')::bigint
             AND (j.resource_request->>'pixelsPerFrame')::bigint <= (w.capabilities->'limits'->>'maxPixelsPerFrame')::bigint
             AND NOT EXISTS (
               SELECT 1 FROM uniscenario.worker_leases active
                WHERE active.worker_node_id = w.id AND active.lease_state = 'active'
             )
         )
       FOR UPDATE OF j`,
      {
        job_id: candidate.id,
        worker_node_id: input.workerNodeId,
        environment: runtimeEnvironment(),
        request_contract_version: UNISCENARIO_RENDER_CONTRACT_VERSION,
      },
    );
    if (!rawRow) return null;
    const row: LeaseSourceRow = {
      ...rawRow,
      map_name: requireCookedCarlaMapName(rawRow.map_name),
      render_spec: parseStoredRenderSpec(rawRow.render_spec, rawRow.job_mode),
      resource_request: UniScenarioRenderResourceRequestSchema.parse(parseJsonObject(rawRow.resource_request)),
      parity_thresholds: rawRow.parity_thresholds ? parseJsonObject(rawRow.parity_thresholds) : null,
      ambient_config: parseJsonObject(rawRow.ambient_config),
    };
    const controlDigest = executionPackageControlSha256(
      executionPackageControlValue(row, row.job_mode, row.render_spec, row.resource_request),
    );
    if (row.job_execution_package_control_sha256 !== controlDigest) {
      throw new Error("uniscenario_render_lineage_mismatch");
    }
    const nextAttempt = Number(row.attempt_count) + 1;
    const expiry = await tx.queryOne<{ expires_at: string }>(
      `SELECT (NOW() + (:lease_seconds * INTERVAL '1 second'))::text AS expires_at`,
      { lease_seconds: leaseSeconds },
    );
    if (!expiry) throw new Error("Unable to compute lease expiration.");
    await tx.execute(
      `INSERT INTO uniscenario.render_attempts (
         id, workspace_id, render_job_id, attempt_number, worker_node_id,
         execution_package_id, execution_package_control_sha256,
         worker_class, runtime_version, image_digest
       ) VALUES (
         :id, :workspace_id, :job_id, :attempt_number, :worker_node_id,
         :execution_package_id, :execution_package_control_sha256,
         :worker_class, :runtime_version, :image_digest
       )`,
      {
        id: attemptId,
        workspace_id: row.workspace_id,
        job_id: row.id,
        attempt_number: nextAttempt,
        worker_node_id: input.workerNodeId,
        execution_package_id: row.execution_package_id,
        execution_package_control_sha256: controlDigest,
        worker_class: worker.worker_class,
        runtime_version: worker.runtime_version,
        image_digest: worker.image_digest,
      },
    );
    await tx.execute(
      `INSERT INTO uniscenario.worker_leases (
         id, render_job_id, render_attempt_id, worker_node_id,
         lease_token_sha256, expires_at
       ) VALUES (
         :id, :job_id, :attempt_id, :worker_node_id,
         :lease_token_sha256, CAST(:expires_at AS timestamptz)
       )`,
      {
        id: leaseId,
        job_id: row.id,
        attempt_id: attemptId,
        worker_node_id: input.workerNodeId,
        lease_token_sha256: sha256(leaseToken),
        expires_at: expiry.expires_at,
      },
    );
    const advancedJob = await tx.queryOne<{ id: string }>(
      `UPDATE uniscenario.render_jobs
       SET job_state = 'leased', attempt_count = :attempt_number, updated_at = NOW()
       WHERE id = :job_id AND workspace_id = :workspace_id
         AND execution_package_id = :execution_package_id
         AND execution_package_control_sha256 = :execution_package_control_sha256
         AND job_state = 'queued' AND cancel_requested_at IS NULL
         AND attempt_count < max_attempts
       RETURNING id`,
      {
        job_id: row.id,
        workspace_id: row.workspace_id,
        execution_package_id: row.execution_package_id,
        attempt_number: nextAttempt,
        execution_package_control_sha256: controlDigest,
      },
    );
    if (!advancedJob) throw new Error("uniscenario_render_lineage_mismatch");
    const reservations = outputReservations(row, attemptId, expiry.expires_at);
    for (const reservation of reservations) {
      await tx.execute(
        `INSERT INTO uniscenario.artifact_uploads (
           id, workspace_id, revision_id, render_job_id, render_attempt_id,
           artifact_kind, media_type, storage_bucket, storage_key, expires_at
         ) VALUES (
           :id, :workspace_id, :revision_id, :job_id, :attempt_id,
           :artifact_kind, :media_type, :storage_bucket, :storage_key,
           CAST(:expires_at AS timestamptz)
         )`,
        {
          id: reservation.id,
          workspace_id: row.workspace_id,
          revision_id: row.revision_id,
          job_id: row.id,
          attempt_id: attemptId,
          artifact_kind: reservation.artifactKind,
          media_type: reservation.mediaType,
          storage_bucket: reservation.bucket,
          storage_key: reservation.key,
          expires_at: reservation.expiresAt,
        },
      );
    }
    return {
      row,
      nextAttempt,
      expiresAt: expiry.expires_at,
      reservations,
      controlDigest,
      leaseToken,
    };
    },
  );
  if (!transactionResult) return null;
  const { row, nextAttempt, expiresAt, reservations, controlDigest, leaseToken } = transactionResult;
  const expiresIn = leaseSeconds;
  const xoscUrl = await getPresignedGetUrl(row.xosc_key, row.xosc_bucket, expiresIn);
  const xodrUrl = await getPresignedGetUrl(row.xodr_key, row.xodr_bucket, expiresIn);
  const assetCatalog = {
    contractVersion: row.asset_catalog_contract_version,
    catalogVersionId: row.asset_catalog_version_id,
    url: await getPresignedGetUrl(row.asset_catalog_key, row.asset_catalog_bucket, expiresIn),
    sha256: row.asset_catalog_sha256,
    sizeBytes: Number(row.asset_catalog_size),
  };
  const manifest = {
    url: await getPresignedGetUrl(row.manifest_key, row.manifest_bucket, expiresIn),
    sha256: row.manifest_sha256,
    sizeBytes: Number(row.manifest_size),
  };
  const materializedTraffic =
    row.traffic_key && row.traffic_bucket
      ? {
          url: await getPresignedGetUrl(row.traffic_key, row.traffic_bucket, expiresIn),
          sha256: row.materialized_traffic_sha256!,
          sizeBytes: Number(row.traffic_size),
        }
      : undefined;
  const artifactUploads = Object.fromEntries(
    await Promise.all(
      reservations.map(async (reservation) => [
        reservation.artifactKind,
        {
          uploadId: reservation.id,
          uploadUrl: await getPresignedPutUrl(reservation.key, reservation.mediaType, reservation.bucket, expiresIn),
          artifactUrl: `${apiBaseUrl()}/api/uniscenario/artifact-uploads/${reservation.id}`,
          headers: { "content-type": reservation.mediaType },
        },
      ]),
    ),
  );
  const runtimeRequirements = {
    schema: "uniscenario.runtime-requirements/v1" as const,
    xoscVersion: "1.4" as const,
    capabilityProfile: row.capability_profile,
    fixedTimestepS: 0.02 as const,
    jobMode: row.job_mode,
    trafficMode: row.ambient_mode,
    executionMode: row.render_spec.executionMode,
    sensorKinds: [...new Set(row.render_spec.sensors.map((sensor) => sensor.kind))].sort(),
    outputs: [...new Set(row.render_spec.outputs)].sort(),
    resources: row.resource_request,
  };
  const executionPackage = {
    schema: "uniscenario.execution-package/v1" as const,
    id: row.execution_package_id,
    revisionId: row.revision_id,
    sourceInputDigest: row.source_input_digest,
    materializedTrafficDigest: row.materialized_traffic_sha256,
    mapAssetId: row.map_asset_id,
    mapVersionId: row.map_version_id,
    manifest,
    xosc: {
      url: xoscUrl,
      sha256: row.xosc_sha256,
      sizeBytes: Number(row.xosc_size),
      xsdSha256: row.xsd_sha256,
    },
    xodr: {
      url: xodrUrl,
      sha256: row.xodr_sha256,
      sizeBytes: Number(row.xodr_size),
      mapName: row.map_name,
    },
    assetCatalog,
    ambient: {
      ambientMode: row.ambient_mode,
      ambientConfig: row.ambient_config,
      configSha256: row.ambient_config_sha256,
      resultSha256: row.ambient_result_sha256,
      materializedTraffic,
      ...(row.ambient_mode === "native"
        ? {
            runtimeVersion: row.ambient_runtime_version,
            seed: row.ambient_seed,
          }
        : {}),
      ...(row.ambient_mode === "sumo"
        ? {
            sumoVersion: row.ambient_sumo_version,
            networkSha256: row.ambient_network_sha256,
            seed: row.ambient_seed,
          }
        : {}),
    },
    runtimeRequirements,
  };
  return {
    leaseToken,
    leaseExpiresAt: rfc3339Timestamp(expiresAt),
    job: {
      id: row.id,
      attempt: nextAttempt,
      mode: row.job_mode,
      executionPackage: {
        ...executionPackage,
        controlSha256: controlDigest,
      },
      renderSpec: row.render_spec,
      ...(row.parity_thresholds ? { parityThresholds: row.parity_thresholds } : {}),
      artifactUploads,
    },
  };
}

async function activeLease(
  jobId: string,
  attempt: number,
  leaseToken: string,
  workerNodeId: string,
) {
  const rows = await queryRows<{
    lease_id: string;
    render_attempt_id: string;
    workspace_id: string;
    revision_id: string;
    execution_package_id: string;
    job_mode: UniScenarioJobMode;
    render_spec: string | Record<string, unknown>;
    execution_package_control_sha256: string;
    source_input_digest: string;
    worker_node_id: string;
    worker_version: string;
    image_digest: string;
    hardware_profile: string;
    resource_request: string | Record<string, unknown>;
    job_state: string;
    attempt_count: number;
    max_attempts: number;
    cancel_requested_at: string | null;
  }>(
    `SELECT l.id AS lease_id, l.render_attempt_id, j.workspace_id, j.revision_id,
       j.execution_package_id, j.execution_package_control_sha256,
       j.job_mode, j.render_spec::text AS render_spec, ep.source_input_digest,
       l.worker_node_id, a.runtime_version AS worker_version, a.image_digest,
       worker.hardware_profile, j.resource_request,
       j.job_state, j.attempt_count, j.max_attempts,
       j.cancel_requested_at::text AS cancel_requested_at
     FROM uniscenario.worker_leases l
     JOIN uniscenario.render_attempts a ON a.id = l.render_attempt_id
     JOIN uniscenario.render_jobs j ON j.id = l.render_job_id
     JOIN uniscenario.worker_nodes worker ON worker.id = l.worker_node_id
     JOIN uniscenario.execution_packages ep
       ON ep.id = j.execution_package_id AND ep.workspace_id = j.workspace_id
     WHERE l.render_job_id = :job_id AND a.attempt_number = :attempt
       AND l.worker_node_id = :worker_node_id
       AND l.lease_token_sha256 = :lease_token_sha256
       AND l.lease_state = 'active' AND l.expires_at > NOW()
       AND ep.source_input_digest ~ '^[a-f0-9]{64}$'
     LIMIT 1`,
    {
      job_id: jobId,
      attempt,
      worker_node_id: workerNodeId,
      lease_token_sha256: sha256(leaseToken),
    },
  );
  return rows[0] ?? null;
}

export async function heartbeatLease(
  jobId: string,
  input: { workerNodeId: string; leaseToken: string; attempt: number; progress?: number },
) {
  const lease = await activeLease(jobId, input.attempt, input.leaseToken, input.workerNodeId);
  if (!lease) return null;
  return withUniScenarioJobTransaction(jobId, async (tx) => {
    const rows = await tx.queryRows<{ expires_at: string }>(
      `UPDATE uniscenario.worker_leases lease
       SET heartbeat_at = NOW(), expires_at = GREATEST(expires_at, NOW() + INTERVAL '60 seconds')
       FROM uniscenario.render_jobs job
       WHERE lease.id = :lease_id AND lease.render_job_id = job.id
         AND lease.lease_state = 'active' AND lease.expires_at > NOW()
         AND job.id = :job_id AND job.cancel_requested_at IS NULL
         AND job.job_state IN ('leased', 'running')
       RETURNING lease.expires_at::text AS expires_at`,
      { lease_id: lease.lease_id, job_id: jobId },
    );
    if (!rows[0]) return null;
    await tx.execute(
      `UPDATE uniscenario.worker_nodes SET last_heartbeat_at = NOW() WHERE id = :worker_node_id`,
      { worker_node_id: lease.worker_node_id },
    );
    await tx.execute(
      `UPDATE uniscenario.artifact_uploads
       SET expires_at = CAST(:expires_at AS timestamptz)
       WHERE render_attempt_id = :attempt_id AND upload_state = 'reserved'`,
      { attempt_id: lease.render_attempt_id, expires_at: rows[0].expires_at },
    );
    if (input.progress !== undefined) {
      await tx.execute(
        `UPDATE uniscenario.render_jobs SET progress = GREATEST(progress, :progress), updated_at = NOW()
         WHERE id = :job_id AND cancel_requested_at IS NULL
           AND job_state IN ('leased', 'running')`,
        { job_id: jobId, progress: input.progress },
      );
    }
    return {
      leaseExpiresAt: rfc3339Timestamp(rows[0].expires_at),
      progress: input.progress ?? null,
      cancelRequested: false,
    };
  });
}

export async function bindArtifactUpload(
  jobId: string,
  uploadId: string,
  input: {
    workerNodeId: string;
    leaseToken: string;
    attempt: number;
    kind: string;
    mediaType: string;
    sha256: string;
    sizeBytes: number;
  },
) {
  const lease = await activeLease(jobId, input.attempt, input.leaseToken, input.workerNodeId);
  if (!lease || lease.cancel_requested_at) return null;
  const reservation = await withUniScenarioJobTransaction(jobId, async (tx) => {
    const locked = await tx.queryOne<{ id: string }>(
      `SELECT l.id FROM uniscenario.worker_leases l
       JOIN uniscenario.render_attempts a ON a.id = l.render_attempt_id
       JOIN uniscenario.render_jobs job ON job.id = l.render_job_id
       WHERE l.id = :lease_id AND a.attempt_number = :attempt
         AND l.lease_token_sha256 = :lease_token_sha256
         AND l.lease_state = 'active' AND l.expires_at > NOW()
         AND job.id = :job_id AND job.cancel_requested_at IS NULL
         AND job.job_state IN ('leased', 'running')
       FOR UPDATE OF l, job`,
      {
        lease_id: lease.lease_id,
        attempt: input.attempt,
        job_id: jobId,
        lease_token_sha256: sha256(input.leaseToken),
      },
    );
    if (!locked) return null;
    const row = await tx.queryOne<{
      id: string;
      artifact_kind: string;
      media_type: string;
      storage_bucket: string;
      storage_key: string;
      expected_sha256: string | null;
      expected_byte_length: number | null;
    }>(
      `SELECT u.id, u.artifact_kind, u.media_type, u.storage_bucket, u.storage_key,
         u.expected_sha256, u.expected_byte_length
       FROM uniscenario.artifact_uploads u
       JOIN uniscenario.render_jobs j ON j.id = u.render_job_id
       WHERE u.id = :upload_id AND u.workspace_id = :workspace_id
         AND u.render_job_id = :job_id AND u.render_attempt_id = :attempt_id
         AND u.upload_state = 'reserved' AND u.expires_at > NOW()
         AND j.cancel_requested_at IS NULL
       FOR UPDATE OF u`,
      {
        upload_id: uploadId,
        workspace_id: lease.workspace_id,
        job_id: jobId,
        attempt_id: lease.render_attempt_id,
      },
    );
    if (!row || row.artifact_kind !== input.kind || row.media_type !== input.mediaType) {
      throw new Error("artifact_binding_reservation_mismatch");
    }
    if (
      row.expected_sha256 &&
      (row.expected_sha256 !== input.sha256 || Number(row.expected_byte_length) !== input.sizeBytes)
    ) {
      throw new Error("artifact_binding_conflict");
    }
    await tx.execute(
      `UPDATE uniscenario.artifact_uploads
       SET expected_sha256 = :sha256, expected_byte_length = :size_bytes,
         bound_at = COALESCE(bound_at, NOW())
       WHERE id = :upload_id`,
      {
        upload_id: uploadId,
        sha256: input.sha256,
        size_bytes: input.sizeBytes,
      },
    );
    return row;
  });
  if (!reservation) return null;
  return {
    uploadUrl: await getPresignedPutUrl(
      reservation.storage_key,
      input.mediaType,
      reservation.storage_bucket,
      900,
      input.sha256,
    ),
    requiredHeaders: checksumBoundPutRequiredHeaders(input.mediaType, input.sha256),
    artifactUrl: `${apiBaseUrl()}/api/uniscenario/artifact-uploads/${uploadId}`,
  };
}

export async function appendJobEvent(
  jobId: string,
  input: {
    workerNodeId: string;
    leaseToken: string;
    attempt: number;
    sequence: number;
    type: string;
    timestamp: string;
    payload?: Record<string, unknown>;
  },
) {
  const lease = await activeLease(jobId, input.attempt, input.leaseToken, input.workerNodeId);
  if (!lease) return null;
  const accepted = await withUniScenarioJobTransaction(jobId, async (tx) => {
    const recorded = await tx.queryOne<{ id: string }>(
      `INSERT INTO uniscenario.job_events (
         id, workspace_id, render_job_id, render_attempt_id,
         event_ordinal, worker_sequence, event_type, event_payload, occurred_at
       )
       SELECT :id, :workspace_id, :job_id, :attempt_id,
              (SELECT COALESCE(MAX(event_ordinal), 0) + 1
                 FROM uniscenario.job_events WHERE render_job_id = :job_id),
              :sequence, :event_type, CAST(:payload AS jsonb), CAST(:occurred_at AS timestamptz)
         FROM uniscenario.worker_leases active
         JOIN uniscenario.render_jobs job ON job.id = active.render_job_id
        WHERE active.id = :lease_id AND active.render_job_id = :job_id
          AND active.lease_state = 'active' AND active.expires_at > NOW()
          AND job.cancel_requested_at IS NULL AND job.job_state IN ('leased', 'running')
       ON CONFLICT (render_attempt_id, worker_sequence)
         WHERE render_attempt_id IS NOT NULL AND worker_sequence IS NOT NULL
       DO UPDATE SET id = uniscenario.job_events.id
         WHERE uniscenario.job_events.event_type = EXCLUDED.event_type
           AND uniscenario.job_events.event_payload = EXCLUDED.event_payload
           AND uniscenario.job_events.occurred_at = EXCLUDED.occurred_at
       RETURNING id`,
      {
        id: uniscenarioId("usevt"),
        workspace_id: lease.workspace_id,
        job_id: jobId,
        attempt_id: lease.render_attempt_id,
        sequence: input.sequence,
        event_type: input.type,
        payload: input.payload ?? {},
        occurred_at: input.timestamp,
        lease_id: lease.lease_id,
      },
    );
    if (!recorded) return false;
    if (input.type === "render_started" || input.type === "interaction_started") {
      await tx.execute(
        `UPDATE uniscenario.render_jobs SET job_state = 'running',
           started_at = COALESCE(started_at, NOW()), updated_at = NOW()
         WHERE id = :job_id AND job_state = 'leased'`,
        { job_id: jobId },
      );
      await tx.execute(
        `UPDATE uniscenario.render_attempts SET attempt_state = 'running',
           started_at = COALESCE(started_at, NOW()) WHERE id = :attempt_id`,
        { attempt_id: lease.render_attempt_id },
      );
    }
    return true;
  });
  return accepted ? { accepted: true as const } : null;
}

async function insertRenderLifecycleEvent(
  tx: JobTransaction,
  input: {
    workspaceId: string;
    jobId: string;
    attemptId: string | null;
    type: string;
    payload?: Record<string, unknown>;
  },
) {
  await tx.execute(
    `INSERT INTO uniscenario.job_events (
       id, workspace_id, render_job_id, render_attempt_id,
       event_ordinal, worker_sequence, event_type, event_payload, occurred_at
     ) VALUES (
       :id, :workspace_id, :job_id, :attempt_id,
       (SELECT COALESCE(MAX(event_ordinal), 0) + 1
          FROM uniscenario.job_events WHERE render_job_id = :job_id),
       NULL, :event_type, CAST(:payload AS jsonb), NOW()
     )`,
    {
      id: uniscenarioId("usevt"),
      workspace_id: input.workspaceId,
      job_id: input.jobId,
      attempt_id: input.attemptId,
      event_type: input.type,
      payload: input.payload ?? {},
    },
  );
}

type CompletionArtifact = {
  kind: string;
  artifactUrl: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  metadata?: Record<string, unknown>;
};
export function renderSensorArtifactMetadataError(
  renderSpec: RenderSpec,
  artifact: Pick<CompletionArtifact, "kind" | "metadata">,
): string | null {
  const sensorScoped = artifact.kind.startsWith("sensorData:") || artifact.kind.startsWith("sensorVideo:");
  if (!sensorScoped) return null;
  const artifactName = artifact.kind.slice(artifact.kind.indexOf(":") + 1);
  const sensor = renderSpec.sensors.find(
    (candidate) => bridgeSensorArtifactName(candidate) === artifactName,
  );
  if (!sensor) return "artifact_sensor_identity_unknown";
  if (
    artifact.kind.startsWith("sensorData:")
    && sensor.kind !== "lidar" && sensor.kind !== "semantic_lidar" && sensor.kind !== "radar"
  ) {
    return "artifact_sensor_metadata_mismatch";
  }
  const modality = sensor.kind === "semantic_lidar" ? "semantic-lidar" : sensor.kind;
  if (
    artifact.metadata?.sensorId !== sensor.id ||
    artifact.metadata.modality !== modality
  ) {
    return "artifact_sensor_metadata_mismatch";
  }
  return null;
}


type VerifiedCompletionArtifact = CompletionArtifact & {
  uploadId: string;
  bucket: string;
  key: string;
  canonical?: StoredArtifact;
};

type StoredArtifact = {
  id: string;
  artifact_state: string;
  media_type: string;
  storage_bucket: string;
  storage_key: string;
  sha256: string;
  byte_length: number;
  verified_at?: string | null;
  verification_method?: string | null;
  verification_sha256?: string | null;
};
const DEFAULT_LEGACY_CHECKSUM_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_LEGACY_CHECKSUM_TIMEOUT_MS = 60_000;

function boundedPositiveEnv(name: string, fallback: number, ceiling: number) {
  const parsed = Number(process.env[name] ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= ceiling ? parsed : fallback;
}

function legacyChecksumBackfillRequired(artifact: StoredArtifact) {
  const error = new Error("legacy_checksum_backfill_required") as Error & {
    verificationDetails: { artifactId: string; sizeBytes: number };
  };
  error.verificationDetails = {
    artifactId: artifact.id,
    sizeBytes: Number(artifact.byte_length),
  };
  return error;
}

function uploadIdFromArtifactUrl(artifactUrl: string) {
  const prefix = `${apiBaseUrl()}/api/uniscenario/artifact-uploads/`;
  if (!artifactUrl.startsWith(prefix)) return null;
  const id = artifactUrl.slice(prefix.length);
  return /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

async function verifyCompletionArtifacts(
  lease: Awaited<ReturnType<typeof activeLease>> & {},
  artifacts: CompletionArtifact[],
) {
  const verified: VerifiedCompletionArtifact[] = [];
  const renderSpec = lease.job_mode === "full_render"
    ? UniScenarioRenderSpecSchema.parse(parseJsonObject(lease.render_spec))
    : null;
  for (const artifact of artifacts) {
    const sensorMetadataError = renderSpec
      ? renderSensorArtifactMetadataError(renderSpec, artifact)
      : null;
    if (sensorMetadataError) throw new Error(sensorMetadataError);
    const uploadId = uploadIdFromArtifactUrl(artifact.artifactUrl);
    if (!uploadId) throw new Error("invalid_artifact_url");
    const rows = await queryRows<{
      id: string;
      artifact_kind: string;
      media_type: string;
      storage_bucket: string;
      storage_key: string;
      expected_sha256: string | null;
      expected_byte_length: number | null;
      canonical_id?: string | null;
      canonical_artifact_state?: string | null;
      canonical_media_type?: string | null;
      canonical_storage_bucket?: string | null;
      canonical_storage_key?: string | null;
      canonical_sha256?: string | null;
      canonical_byte_length?: number | null;
      canonical_verified_at?: string | null;
      canonical_verification_method?: string | null;
      canonical_verification_sha256?: string | null;
    }>(
      `SELECT u.id, u.artifact_kind, u.media_type, u.storage_bucket, u.storage_key,
         u.expected_sha256, u.expected_byte_length,
         c.id AS canonical_id, c.artifact_state AS canonical_artifact_state,
         c.media_type AS canonical_media_type, c.storage_bucket AS canonical_storage_bucket,
         c.storage_key AS canonical_storage_key, c.sha256 AS canonical_sha256,
         c.byte_length AS canonical_byte_length, c.verified_at::text AS canonical_verified_at,
         c.verification_method AS canonical_verification_method,
         c.verification_sha256 AS canonical_verification_sha256
       FROM uniscenario.artifact_uploads u
       LEFT JOIN uniscenario.artifacts c
         ON c.workspace_id = u.workspace_id AND c.sha256 = u.expected_sha256
        AND c.artifact_kind = u.artifact_kind AND c.deleted_at IS NULL
       WHERE u.id = :id AND u.workspace_id = :workspace_id AND u.render_attempt_id = :attempt_id
         AND u.upload_state = 'reserved' AND u.expires_at > NOW()
       LIMIT 1`,
      {
        id: uploadId,
        workspace_id: lease.workspace_id,
        attempt_id: lease.render_attempt_id,
      },
    );
    const reservation = rows[0];
    if (!reservation || reservation.artifact_kind !== artifact.kind || reservation.media_type !== artifact.mediaType) {
      throw new Error("artifact_reservation_mismatch");
    }
    if (
      reservation.expected_sha256 !== artifact.sha256 ||
      Number(reservation.expected_byte_length) !== artifact.sizeBytes
    )
      throw new Error("artifact_binding_mismatch");
    const head = await headS3Object(reservation.storage_key, reservation.storage_bucket);
    if (Number(head.contentLength) !== artifact.sizeBytes) throw new Error("artifact_size_mismatch");
    if (head.contentType && head.contentType !== artifact.mediaType) throw new Error("artifact_media_type_mismatch");
    const expected = Buffer.from(artifact.sha256, "hex").toString("base64");
    if (!head.checksumSha256) throw new Error("artifact_checksum_unavailable");
    if (head.checksumSha256 !== expected) throw new Error("artifact_checksum_mismatch");
    verified.push({
      ...artifact,
      uploadId,
      bucket: reservation.storage_bucket,
      key: reservation.storage_key,
      ...(reservation.canonical_id
        ? {
            canonical: {
              id: reservation.canonical_id,
              artifact_state: reservation.canonical_artifact_state ?? "",
              media_type: reservation.canonical_media_type ?? "",
              storage_bucket: reservation.canonical_storage_bucket ?? "",
              storage_key: reservation.canonical_storage_key ?? "",
              sha256: reservation.canonical_sha256 ?? "",
              byte_length: Number(reservation.canonical_byte_length),
              verified_at: reservation.canonical_verified_at,
              verification_method: reservation.canonical_verification_method,
              verification_sha256: reservation.canonical_verification_sha256,
            },
          }
        : {}),
    });
  }
  return verified;
}

async function verifyCanonicalArtifact(
  artifact: StoredArtifact,
  declared: CompletionArtifact,
): Promise<"s3_checksum_sha256" | "stream_sha256"> {
  if (
    artifact.artifact_state !== "available" ||
    artifact.sha256 !== declared.sha256 ||
    artifact.media_type !== declared.mediaType ||
    Number(artifact.byte_length) !== declared.sizeBytes
  ) {
    throw new Error("canonical_artifact_metadata_mismatch");
  }
  const head = await headS3Object(artifact.storage_key, artifact.storage_bucket);
  if (Number(head.contentLength) !== declared.sizeBytes) {
    throw new Error("canonical_artifact_size_mismatch");
  }
  if (head.contentType && head.contentType !== declared.mediaType) {
    throw new Error("canonical_artifact_media_type_mismatch");
  }
  if (head.checksumSha256) {
    const expected = Buffer.from(declared.sha256, "hex").toString("base64");
    if (head.checksumSha256 !== expected) {
      throw new Error("canonical_artifact_checksum_mismatch");
    }
    return "s3_checksum_sha256";
  } else {
    const maximumBytes = boundedPositiveEnv(
      "UNISCENARIO_LEGACY_CHECKSUM_MAX_BYTES",
      DEFAULT_LEGACY_CHECKSUM_MAX_BYTES,
      1024 * 1024 * 1024,
    );
    if (declared.sizeBytes > maximumBytes) throw legacyChecksumBackfillRequired(artifact);
    let streamed: Awaited<ReturnType<typeof sha256S3RawObjectBounded>>;
    try {
      streamed = await sha256S3RawObjectBounded(artifact.storage_bucket, artifact.storage_key, {
        declaredSizeBytes: declared.sizeBytes,
        maximumBytes,
        maximumDurationMs: boundedPositiveEnv(
          "UNISCENARIO_LEGACY_CHECKSUM_TIMEOUT_MS",
          DEFAULT_LEGACY_CHECKSUM_TIMEOUT_MS,
          120_000,
        ),
      });
    } catch {
      throw legacyChecksumBackfillRequired(artifact);
    }
    if (streamed.sha256 !== declared.sha256) {
      throw new Error("canonical_artifact_checksum_mismatch");
    }
    return "stream_sha256";
  }
}

function canonicalVerificationKey(artifact: StoredArtifact) {
  return [
    artifact.id,
    artifact.artifact_state,
    artifact.media_type,
    artifact.storage_bucket,
    artifact.storage_key,
    artifact.sha256,
    Number(artifact.byte_length),
  ].join("\u0000");
}

async function preverifyCanonicalArtifacts(artifacts: VerifiedCompletionArtifact[]) {
  const verified = new Set<string>();
  for (const declared of artifacts) {
    const canonical = declared.canonical;
    if (!canonical || (canonical.storage_bucket === declared.bucket && canonical.storage_key === declared.key)) {
      continue;
    }
    if (canonical.verification_sha256 !== declared.sha256 || !canonical.verification_method || !canonical.verified_at) {
      const method = await verifyCanonicalArtifact(canonical, declared);
      await queryRows(
        `UPDATE uniscenario.artifacts
         SET verification_method = :verification_method,
           verification_sha256 = :verification_sha256,
           verified_at = COALESCE(verified_at, NOW())
         WHERE id = :id AND storage_bucket = :storage_bucket
           AND storage_key = :storage_key AND sha256 = :sha256
         RETURNING id`,
        {
          id: canonical.id,
          storage_bucket: canonical.storage_bucket,
          storage_key: canonical.storage_key,
          sha256: canonical.sha256,
          verification_method: method,
          verification_sha256: declared.sha256,
        },
      );
    }
    verified.add(canonicalVerificationKey(canonical));
  }
  return verified;
}

type CleanupRow = { id: string; storage_bucket: string; storage_key: string };

export async function drainArtifactCleanupOutbox(ids?: string[], excludeIds: string[] = []) {
  const rows =
    (await queryRows<CleanupRow>(
      `SELECT o.id, o.storage_bucket, o.storage_key
     FROM uniscenario.artifact_cleanup_outbox o
     JOIN uniscenario.artifact_uploads u
       ON u.id = o.artifact_upload_id AND u.workspace_id = o.workspace_id
      AND u.render_job_id = o.render_job_id AND u.render_attempt_id = o.render_attempt_id
      AND u.storage_bucket = o.storage_bucket AND u.storage_key = o.storage_key
      AND u.upload_state = 'uploaded' AND u.completed_artifact_id IS NOT NULL
     JOIN uniscenario.artifacts canonical ON canonical.id = u.completed_artifact_id
      AND canonical.workspace_id = o.workspace_id
      AND (canonical.storage_bucket <> o.storage_bucket OR canonical.storage_key <> o.storage_key)
     WHERE o.cleanup_state = 'pending'
       AND NOT EXISTS (
         SELECT 1 FROM uniscenario.artifacts referenced
         WHERE referenced.storage_bucket = o.storage_bucket
           AND referenced.storage_key = o.storage_key
           AND referenced.deleted_at IS NULL
       )
       ${ids?.length ? "AND o.id IN (" + ids.map((_, index) => `:id_${index}`).join(", ") + ")" : ""}
       ${excludeIds.length ? "AND o.id NOT IN (" + excludeIds.map((_, index) => `:exclude_id_${index}`).join(", ") + ")" : ""}
     ORDER BY o.created_at ASC LIMIT 25`,
      Object.fromEntries([
        ...(ids ?? []).map((id, index) => [`id_${index}`, id]),
        ...excludeIds.map((id, index) => [`exclude_id_${index}`, id]),
      ]),
    )) ?? [];
  let deleted = 0;
  for (const row of rows) {
    const stillSafe = await queryRows<{ id: string }>(
      `SELECT o.id /* cleanup_revalidation */
       FROM uniscenario.artifact_cleanup_outbox o
       JOIN uniscenario.artifact_uploads u
         ON u.id = o.artifact_upload_id AND u.workspace_id = o.workspace_id
        AND u.render_job_id = o.render_job_id AND u.render_attempt_id = o.render_attempt_id
        AND u.storage_bucket = o.storage_bucket AND u.storage_key = o.storage_key
        AND u.upload_state = 'uploaded' AND u.completed_artifact_id IS NOT NULL
       JOIN uniscenario.artifacts canonical ON canonical.id = u.completed_artifact_id
        AND canonical.workspace_id = o.workspace_id
        AND (canonical.storage_bucket <> o.storage_bucket OR canonical.storage_key <> o.storage_key)
       WHERE o.id = :id AND o.cleanup_state = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM uniscenario.artifacts referenced
           WHERE referenced.storage_bucket = o.storage_bucket
             AND referenced.storage_key = o.storage_key
             AND referenced.deleted_at IS NULL
         ) LIMIT 1`,
      { id: row.id },
    );
    if (!stillSafe[0]) continue;
    try {
      deleted += await deleteS3Keys([row.storage_key], row.storage_bucket);
      await queryRows(
        `UPDATE uniscenario.artifact_cleanup_outbox
         SET cleanup_state = 'deleted', completed_at = NOW(), last_error_code = NULL
         WHERE id = :id AND cleanup_state = 'pending' RETURNING id`,
        { id: row.id },
      );
    } catch (error) {
      await queryRows(
        `UPDATE uniscenario.artifact_cleanup_outbox
         SET attempts = attempts + 1, last_attempt_at = NOW(),
           last_error_code = :error_code
         WHERE id = :id AND cleanup_state = 'pending' RETURNING id`,
        {
          id: row.id,
          error_code: error instanceof Error ? error.name : "UnknownError",
        },
      );
    }
  }
  return deleted;
}

export async function completeRenderJob(
  jobId: string,
  input: {
    workerNodeId: string;
    leaseToken: string;
    attempt: number;
    result: {
      planSha256: string;
      sourceInputDigest: string;
      attestation: Record<string, unknown>;
      parityEvidence: UniScenarioParityEvidenceV1;
      artifacts: CompletionArtifact[];
    };
  },
) {
  const lease = await activeLease(jobId, input.attempt, input.leaseToken, input.workerNodeId);
  if (!lease) return null;
  if (!/^[a-f0-9]{64}$/.test(lease.source_input_digest)) {
    throw new Error("source_input_digest_missing");
  }
  if (!/^[a-f0-9]{64}$/.test(input.result.sourceInputDigest)) {
    throw new Error("source_input_digest_missing");
  }
  if (input.result.sourceInputDigest !== lease.source_input_digest) {
    throw new Error("source_input_digest_mismatch");
  }
  const evidence = UniScenarioParityEvidenceV1Schema.parse(input.result.parityEvidence);
  if (
    evidence.identity.revisionId !== lease.revision_id ||
    evidence.identity.executionPackageId !== lease.execution_package_id ||
    evidence.identity.executionPackageControlSha256 !== lease.execution_package_control_sha256 ||
    evidence.identity.sourceInputDigest !== lease.source_input_digest ||
    evidence.identity.planSha256 !== input.result.planSha256
  ) {
    throw new Error("parity_evidence_identity_mismatch");
  }
  if (
    input.result.attestation.schema !== "uniscenario.worker-attestation/v1" ||
    input.result.attestation.workerRevision !== lease.worker_version ||
    input.result.attestation.workerImageDigest !== lease.image_digest
  ) {
    throw new Error("worker_attestation_identity_mismatch");
  }
  const artifacts = await verifyCompletionArtifacts(lease, input.result.artifacts);
  const parityReportArtifact = artifacts.find((artifact) => artifact.kind === "parity-report");
  if (!parityReportArtifact || parityReportArtifact.mediaType !== "application/json") {
    throw new Error("parity_report_artifact_missing");
  }
  const parityReportText = await getS3ObjectUtf8Bounded(
    parityReportArtifact.bucket,
    parityReportArtifact.key,
    { maximumStoredBytes: 5 * 1024 * 1024, maximumRawBytes: 5 * 1024 * 1024 },
  );
  let parityReport: UniScenarioParityEvidenceV1;
  try {
    parityReport = UniScenarioParityEvidenceV1Schema.parse(JSON.parse(parityReportText));
  } catch {
    throw new Error("parity_report_artifact_invalid");
  }
  if (canonicalJsonSha256(parityReport) !== canonicalJsonSha256(evidence)) {
    throw new Error("parity_report_artifact_mismatch");
  }
  const resourceRequest = UniScenarioRenderResourceRequestSchema.parse(
    parseJsonObject(lease.resource_request),
  );
  if (artifacts.reduce((total, artifact) => total + artifact.sizeBytes, 0) > resourceRequest.outputBytes) {
    throw new Error("render_output_resource_limit_exceeded");
  }
  const reservedKinds = await queryRows<{ artifact_kind: string }>(
    `SELECT artifact_kind FROM uniscenario.artifact_uploads
      WHERE render_attempt_id = :attempt_id ORDER BY artifact_kind`,
    { attempt_id: lease.render_attempt_id },
  );
  const expectedKinds = reservedKinds.map((row) => row.artifact_kind);
  const completedKinds = artifacts.map((artifact) => artifact.kind).sort();
  const evidenceKinds = [...evidence.artifacts.verifiedKinds].sort();
  if (
    new Set(completedKinds).size !== completedKinds.length ||
    expectedKinds.join("\0") !== completedKinds.join("\0") ||
    completedKinds.join("\0") !== evidenceKinds.join("\0")
  ) {
    throw new Error("render_artifact_closure_mismatch");
  }
  const preverifiedCanonicalArtifacts = await preverifyCanonicalArtifacts(artifacts);
  const committed = await withUniScenarioJobTransaction(jobId, async (tx) => {
    const locked = await tx.queryOne<{ id: string }>(
      `SELECT l.id FROM uniscenario.worker_leases l
       JOIN uniscenario.render_attempts a ON a.id = l.render_attempt_id
       WHERE l.id = :lease_id AND a.attempt_number = :attempt
         AND l.lease_token_sha256 = :lease_token_sha256
         AND l.lease_state = 'active' AND l.expires_at > NOW()
       FOR UPDATE OF l`,
      {
        lease_id: lease.lease_id,
        attempt: input.attempt,
        lease_token_sha256: sha256(input.leaseToken),
      },
    );
    if (!locked) return null;
    const artifactIds: string[] = [];
    const reusedArtifactIds: string[] = [];
    const redundantUploads = new Map<string, string[]>();
    for (const artifact of artifacts) {
      const artifactId = uniscenarioId("usart");
      // The workspace/kind/digest tuple is the content address. ON CONFLICT
      // takes the unique-index row lock, so simultaneous completions converge
      // on one canonical artifact instead of turning a valid retry into a 409.
      const row = await tx.queryOne<StoredArtifact>(
        `INSERT INTO uniscenario.artifacts (
           id, workspace_id, revision_id, artifact_kind, media_type,
           storage_bucket, storage_key, sha256, byte_length, artifact_state,
           metadata, verified_at, verification_method, verification_sha256,
           producer_job_family, producer_job_id, producer_attempt_id, provenance
         ) VALUES (
           :id, :workspace_id, :revision_id, :artifact_kind, :media_type,
           :storage_bucket, :storage_key, :sha256, :byte_length, 'available',
           CAST(:metadata AS jsonb), NOW(), 's3_checksum_sha256', :sha256,
           'openscenario_render', :job_id, :attempt_id, CAST(:provenance AS jsonb)
         )
         ON CONFLICT (workspace_id, sha256, artifact_kind) DO UPDATE SET
           sha256 = EXCLUDED.sha256
         RETURNING id, artifact_state, media_type, storage_bucket, storage_key,
           sha256, byte_length, verified_at::text AS verified_at,
           verification_method, verification_sha256`,
        {
          id: artifactId,
          workspace_id: lease.workspace_id,
          revision_id: lease.revision_id,
          artifact_kind: artifact.kind,
          media_type: artifact.mediaType,
          storage_bucket: artifact.bucket,
          storage_key: artifact.key,
          sha256: artifact.sha256,
          byte_length: artifact.sizeBytes,
          metadata: artifact.metadata ?? {},
          job_id: jobId,
          attempt_id: lease.render_attempt_id,
          provenance: {
            contract: "uniscenario.artifact-provenance/v1",
            producerJobFamily: "openscenario_render",
            producerJobId: jobId,
            producerAttemptId: lease.render_attempt_id,
            revisionId: lease.revision_id,
            sourceInputDigest: lease.source_input_digest,
            executionPlanSha256: input.result.planSha256,
          },
        },
      );
      if (!row) throw new Error("Unable to register completed artifact.");
      const reused = row.storage_bucket !== artifact.bucket || row.storage_key !== artifact.key;
      if (reused) {
        const durableVerification =
          row.verified_at && row.verification_method && row.verification_sha256 === artifact.sha256;
        if (!durableVerification && !preverifiedCanonicalArtifacts.has(canonicalVerificationKey(row))) {
          throw new Error("canonical_artifact_verification_missing");
        }
        reusedArtifactIds.push(row.id);
        const keys = redundantUploads.get(artifact.bucket) ?? [];
        keys.push(artifact.key);
        redundantUploads.set(artifact.bucket, keys);
        await tx.execute(
          `INSERT INTO uniscenario.artifact_cleanup_outbox (
             id, workspace_id, render_job_id, render_attempt_id,
             artifact_upload_id, storage_bucket, storage_key
           ) VALUES (
             :id, :workspace_id, :job_id, :attempt_id,
             :upload_id, :storage_bucket, :storage_key
           )
           ON CONFLICT (storage_bucket, storage_key) DO NOTHING`,
          {
            id: uniscenarioId("usclean"),
            workspace_id: lease.workspace_id,
            job_id: jobId,
            attempt_id: lease.render_attempt_id,
            upload_id: artifact.uploadId,
            storage_bucket: artifact.bucket,
            storage_key: artifact.key,
          },
        );
      }
      artifactIds.push(row.id);
      await tx.execute(
        `UPDATE uniscenario.artifact_uploads
         SET upload_state = 'uploaded', completed_artifact_id = :artifact_id, completed_at = NOW()
         WHERE id = :upload_id AND upload_state = 'reserved'`,
        { upload_id: artifact.uploadId, artifact_id: row.id },
      );
      await tx.execute(
        `INSERT INTO uniscenario.artifact_links (
           id, workspace_id, artifact_id, render_job_id, render_attempt_id, relationship
         ) VALUES (
           :id, :workspace_id, :artifact_id, :job_id, :attempt_id, 'render_output'
         ) ON CONFLICT (artifact_id, render_job_id, render_attempt_id, relationship) DO NOTHING`,
        {
          id: uniscenarioId("usalink"),
          workspace_id: lease.workspace_id,
          artifact_id: row.id,
          job_id: jobId,
          attempt_id: lease.render_attempt_id,
        },
      );
    }
    const parityPassed = isUniScenarioParityEvidenceAccepted(evidence);
    const paritySummary = {
      schema: "uniscenario.parity-summary/v1",
      verdict: evidence.verdict,
      semantics: evidence.semantics,
      trajectory: evidence.trajectory,
      collisions: evidence.collisions,
      divergences: evidence.divergences,
    };
    await tx.execute(
      `UPDATE uniscenario.render_attempts
       SET attempt_state = :attempt_state, completed_at = NOW(),
         metrics = CAST(:metrics AS jsonb),
         parity_evidence_schema = :parity_evidence_schema,
         parity_evidence = CAST(:parity_evidence AS jsonb),
         parity_accepted = :parity_accepted
       WHERE id = :attempt_id`,
      {
        attempt_id: lease.render_attempt_id,
        attempt_state: parityPassed ? "succeeded" : "failed",
        metrics: {
          planSha256: input.result.planSha256,
          attestation: input.result.attestation,
          parity: paritySummary,
          artifactDeduplication: {
            reusedArtifactIds,
            // Redundant object deletion is deliberately post-commit so a slow
            // object store cannot extend the lease-row lock duration.
            redundantUploadsDeleted: 0,
          },
        },
        parity_evidence_schema: UNISCENARIO_PARITY_EVIDENCE_VERSION,
        parity_evidence: evidence,
        parity_accepted: parityPassed,
      },
    );
    await tx.execute(
      `UPDATE uniscenario.worker_leases
       SET lease_state = 'released', released_at = NOW() WHERE id = :lease_id`,
      { lease_id: lease.lease_id },
    );
    await tx.execute(
      `UPDATE uniscenario.render_jobs
       SET job_state = :job_state, progress = 1, completed_at = NOW(), updated_at = NOW(),
         failure_code = :failure_code, failure_detail = CAST(:failure_detail AS jsonb),
         parity_result = CAST(:parity AS jsonb), worker_attestation = CAST(:attestation AS jsonb),
         parity_evidence_schema = :parity_evidence_schema,
         parity_evidence = CAST(:parity_evidence AS jsonb), parity_accepted = :parity_accepted,
         telemetry = jsonb_build_object(
           'wallSeconds', EXTRACT(EPOCH FROM (NOW() - COALESCE(started_at, created_at))),
           'outputBytes', :output_bytes
         )
       WHERE id = :job_id`,
      {
        job_id: jobId,
        job_state: parityPassed ? "succeeded" : "failed",
        failure_code: parityPassed ? null : "parity_evidence_rejected",
        failure_detail: parityPassed ? null : { parityEvidence: evidence },
        parity: paritySummary,
        parity_evidence_schema: UNISCENARIO_PARITY_EVIDENCE_VERSION,
        parity_evidence: evidence,
        parity_accepted: parityPassed,
        attestation: input.result.attestation,
        output_bytes: artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
      },
    );
    await insertRenderLifecycleEvent(tx, {
      workspaceId: lease.workspace_id,
      jobId,
      attemptId: lease.render_attempt_id,
      type: parityPassed ? "completed" : "failed",
      payload: parityPassed
        ? { artifactIds }
        : { code: "parity_evidence_rejected", parityEvidence: evidence },
    });
    await settlePipelineJob(tx, {
      workspaceId: lease.workspace_id,
      jobFamily: "openscenario_render",
      jobId,
      outcome: parityPassed ? "completed" : "failed",
    });
    return {
      completed: true as const,
      parityPassed,
      artifactIds,
      reusedArtifactIds,
      redundantUploads,
    };
  });
  if (!committed) return null;
  const cleanupIds = [...committed.redundantUploads.values()].flatMap((keys, bucketIndex) =>
    keys.map((key) => `${[...committed.redundantUploads.keys()][bucketIndex]}\u0000${key}`),
  );
  // Query by storage identity because the generated outbox ids remain inside
  // the committed transaction result only indirectly through the cleanup plan.
  const cleanupRows =
    (cleanupIds.length
      ? await queryRows<CleanupRow>(
          `SELECT id, storage_bucket, storage_key FROM uniscenario.artifact_cleanup_outbox
       WHERE cleanup_state = 'pending' AND workspace_id = :workspace_id`,
          { workspace_id: lease.workspace_id },
        )
      : []) ?? [];
  const intended = new Set(cleanupIds);
  const currentCleanupIds = cleanupRows
    .filter((row) => intended.has(`${row.storage_bucket}\u0000${row.storage_key}`))
    .map((row) => row.id);
  const redundantUploadsDeleted = currentCleanupIds.length ? await drainArtifactCleanupOutbox(currentCleanupIds) : 0;
  // Also recover a bounded batch left pending after an earlier request died
  // between commit and cleanup. Current rows are excluded so failures remain
  // durably pending instead of spinning within the same callback.
  await drainArtifactCleanupOutbox(undefined, currentCleanupIds);
  return {
    completed: committed.completed,
    parityPassed: committed.parityPassed,
    artifactIds: committed.artifactIds,
    artifactDeduplication: {
      reusedArtifactIds: committed.reusedArtifactIds,
      redundantUploadsDeleted,
    },
  };
}

export async function failRenderJob(
  jobId: string,
  input: {
    workerNodeId: string;
    leaseToken: string;
    attempt: number;
    error: {
      code: string;
      message: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    };
  },
) {
  const lease = await activeLease(jobId, input.attempt, input.leaseToken, input.workerNodeId);
  if (!lease) return null;
  return withUniScenarioJobTransaction(jobId, async (tx) => {
    const locked = await tx.queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.worker_leases
       WHERE id = :lease_id AND lease_token_sha256 = :lease_token_sha256
         AND lease_state = 'active' AND expires_at > NOW()
       FOR UPDATE`,
      {
        lease_id: lease.lease_id,
        lease_token_sha256: sha256(input.leaseToken),
      },
    );
    if (!locked) return null;
    const cancelled = input.error.code === "CancellationRequested" && Boolean(lease.cancel_requested_at);
    const retry = !cancelled && input.error.retryable && Number(lease.attempt_count) < Number(lease.max_attempts);
    await tx.execute(
      `UPDATE uniscenario.render_attempts
       SET attempt_state = :attempt_state, completed_at = NOW(),
         metrics = CAST(:metrics AS jsonb)
       WHERE id = :attempt_id`,
      {
        attempt_id: lease.render_attempt_id,
        attempt_state: cancelled ? "cancelled" : "failed",
        metrics: { error: input.error },
      },
    );
    await tx.execute(
      `UPDATE uniscenario.worker_leases
       SET lease_state = 'released', released_at = NOW() WHERE id = :lease_id`,
      { lease_id: lease.lease_id },
    );
    await tx.execute(
      `UPDATE uniscenario.artifact_uploads SET upload_state = 'cancelled'
       WHERE render_attempt_id = :attempt_id AND upload_state = 'reserved'`,
      { attempt_id: lease.render_attempt_id },
    );
    await tx.execute(
      `UPDATE uniscenario.render_jobs
       SET job_state = :job_state, completed_at = CASE WHEN :retry THEN NULL ELSE NOW() END,
         updated_at = NOW(), failure_code = :failure_code,
         failure_detail = CAST(:failure_detail AS jsonb)
       WHERE id = :job_id`,
      {
        job_id: jobId,
        job_state: cancelled ? "cancelled" : retry ? "queued" : "failed",
        retry,
        failure_code: cancelled ? "cancelled_by_request" : input.error.code,
        failure_detail: {
          message: input.error.message,
          details: input.error.details ?? {},
        },
      },
    );
    await insertRenderLifecycleEvent(tx, {
      workspaceId: lease.workspace_id,
      jobId,
      attemptId: lease.render_attempt_id,
      type: cancelled ? "cancelled" : retry ? "retry_queued" : "failed",
      payload: {
        code: cancelled ? "cancelled_by_request" : input.error.code,
        retryQueued: retry,
      },
    });
    if (!retry) {
      await settlePipelineJob(tx, {
        workspaceId: lease.workspace_id,
        jobFamily: "openscenario_render",
        jobId,
        outcome: cancelled ? "cancelled" : "failed",
      });
    }
    return cancelled
      ? {
          accepted: true as const,
          retryQueued: false,
          cancelled: true as const,
        }
      : { accepted: true as const, retryQueued: retry };
  });
}

export async function getArtifactUpload(context: AppContext, uploadId: string) {
  const rows = await queryRows<{
    id: string;
    artifact_kind: string;
    media_type: string;
    upload_state: string;
    completed_artifact_id: string | null;
    expires_at: string;
  }>(
    `SELECT id, artifact_kind, media_type, upload_state, completed_artifact_id,
       expires_at::text AS expires_at
     FROM uniscenario.artifact_uploads
     WHERE id = :id AND workspace_id = :workspace_id LIMIT 1`,
    { id: uploadId, workspace_id: context.workspaceId },
  );
  return rows[0] ?? null;
}

export async function getFinalizedArtifact(
  context: AppContext,
  artifactId: string,
  disposition: "inline" | "attachment" = "inline",
): Promise<UniScenarioArtifactDto | null> {
  const rows = await queryRows<{
    id: string;
    revision_id: string | null;
    artifact_kind: string;
    media_type: string;
    storage_bucket: string;
    storage_key: string;
    sha256: string;
    byte_length: number;
    metadata: string | Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, revision_id, artifact_kind, media_type, storage_bucket, storage_key,
       sha256, byte_length, metadata::text AS metadata, created_at::text AS created_at
     FROM uniscenario.artifacts
     WHERE workspace_id = :workspace_id AND id = :artifact_id
       AND artifact_state = 'available' AND deleted_at IS NULL
     LIMIT 1`,
    { workspace_id: context.workspaceId, artifact_id: artifactId },
  );
  const row = rows[0];
  if (!row) return null;
  const downloadUrl = await getPresignedGetUrl(
    row.storage_key,
    row.storage_bucket,
    MEDIA_URL_TTL_SECONDS,
    disposition === "attachment"
      ? `attachment; filename="${row.artifact_kind === "compiled-xosc" ? "uniscenario.xosc" : row.id}"`
      : undefined,
  );
  return {
    id: row.id,
    revisionId: row.revision_id,
    kind: row.artifact_kind,
    mediaType: row.media_type,
    sha256: row.sha256,
    sizeBytes: Number(row.byte_length),
    metadata: parseJsonObject(row.metadata),
    downloadUrl,
    downloadExpiresAt: new Date(Date.now() + MEDIA_URL_TTL_SECONDS * 1000).toISOString(),
    createdAt: row.created_at,
  };
}
