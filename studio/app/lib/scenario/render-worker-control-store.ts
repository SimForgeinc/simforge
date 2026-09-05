import { randomBytes } from "node:crypto";
import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows, withTransaction } from "@/app/lib/db/data-api";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedGetUrl,
  getPresignedPutUrl,
  headS3Object,
} from "@/app/lib/s3/s3-presign";
import { canonicalJsonSha256, sha256, scenarioId } from "./core";
import {
  ScenarioRenderIntentSchema,
  ScenarioRendererCapabilitySchema,
  type RenderArtifactIdentity,
  type RenderProgressRecord,
  type ScenarioRenderIntent,
  type ScenarioRendererCapability,
} from "./render-wire-contracts";
import { simforgeEnv } from "@/lib/compat-env";

const REQUIRED_CARLA_BASE_IMAGE = "ghcr.io/simforgeinc/carla-rfs-munich-belmont:0.10.0-kia";
const REQUIRED_CARLA_BASE_IMAGE_INDEX_DIGEST = "sha256:f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5";
const REQUIRED_CARLA_BASE_IMAGE_AMD64_DIGEST = "sha256:baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64";
const CONTROL_SCHEMA = "simforge.render-worker-control/v2";
const INTENT_CONTRACT = "uniscenario.render-intent/v1";
const LEASE_SECONDS = 900;
function runtimeEnvironment(): "dev" | "staging" | "prod" {
  const value = process.env.SIMFORGE_ENV?.trim();
  if (value !== "dev" && value !== "staging" && value !== "prod") {
    throw new Error("SIMFORGE_ENV must identify the Scenario control-plane environment.");
  }
  return value;
}

function artifactBucket() { return simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts"; }

function label(input: Record<string, string>, key: string) {
  const value = input[key]?.trim();
  if (!value) throw new Error(`worker_label_${key}_required`);
  return value;
}

export async function registerRenderWorkerV2(input: {
  workerId: string;
  instanceId: string;
  engine: ScenarioRendererCapability;
  labels: Record<string, string>;
}) {
  const capability = ScenarioRendererCapabilitySchema.parse(input.engine);
  const imageDigest = label(input.labels, "imageDigest");
  const hardwareProfile = label(input.labels, "hardwareProfile");
  const gpuModel = label(input.labels, "gpuModel");
  const gpuMemoryMiB = Number(label(input.labels, "gpuMemoryMiB"));
  if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest)) throw new Error("worker_image_digest_invalid");
  const baseImage = input.labels.baseImage?.trim() ?? null;
  const baseImageDigest = input.labels.baseImageDigest?.trim() ?? null;
  const baseImagePlatformDigest = input.labels.baseImagePlatformDigest?.trim() ?? null;
  if (capability.backend === "carla" && (
    baseImage !== REQUIRED_CARLA_BASE_IMAGE
    || baseImageDigest !== REQUIRED_CARLA_BASE_IMAGE_INDEX_DIGEST
    || baseImagePlatformDigest !== REQUIRED_CARLA_BASE_IMAGE_AMD64_DIGEST
  )) {
    throw new Error("worker_carla_base_image_provenance_invalid");
  }
  if (!capability.requiresGpu || !Number.isInteger(gpuMemoryMiB) || gpuMemoryMiB < 10_000) {
    throw new Error("worker_gpu_capability_invalid");
  }
  if (!hardwareProfile.startsWith("rtx3080-") && !hardwareProfile.startsWith("rtx5080-")) {
    throw new Error("worker_hardware_profile_incompatible");
  }
  const registrationId = scenarioId("uswr");
  const rows = await queryRows<{ registration_id: string }>(
    `UPDATE simforge.worker_nodes
        SET registration_id = CASE WHEN instance_id = :instance_id THEN registration_id ELSE :registration_id END,
            instance_id = :instance_id,
            worker_version = :worker_version,
            image_digest = :image_digest,
            hardware_profile = :hardware_profile,
            renderer_engine = :renderer_engine,
            capabilities = CAST(:capabilities AS jsonb),
            metadata = CAST(:metadata AS jsonb),
            last_heartbeat_at = NOW(), last_idle_heartbeat_at = NOW()
      WHERE id = :worker_id AND environment = :environment
        AND registration_state IN ('active', 'draining')
        AND approved_worker_version = :worker_version
        AND approved_image_digest = :image_digest
        AND approved_hardware_profile = :hardware_profile
        AND approved_at IS NOT NULL
      RETURNING registration_id`,
    {
      registration_id: registrationId,
      instance_id: input.instanceId,
      worker_id: input.workerId,
      environment: runtimeEnvironment(),
      worker_version: capability.engineVersion,
      image_digest: imageDigest,
      hardware_profile: hardwareProfile,
      renderer_engine: capability.backend,
      capabilities: capability,
      metadata: {
        labels: input.labels,
        gpuModel,
        gpuMemoryMiB,
        baseImage,
        baseImageDigest,
        baseImagePlatformDigest,
      },
    },
  );
  if (!rows[0]) throw new Error("worker_registration_not_approved");
  return {
    schema: CONTROL_SCHEMA,
    type: "worker.registered" as const,
    registrationId: rows[0].registration_id,
    heartbeatIntervalMs: 30_000,
  };
}

type Candidate = {
  id: string;
  renderer_engine: "browser" | "carla" | "native";
  render_intent: unknown;
  intent_sha256: string;
  resource_request: unknown;
};

type WorkerRow = {
  id: string;
  registration_id: string;
  worker_version: string;
  image_digest: string;
  renderer_engine: "browser" | "carla" | "native";
  base_image_digest: string | null;
  capabilities: string | Record<string, unknown>;
  base_image_platform_digest: string | null;
  gpu_memory_mib: number;
  hardware_profile: string;
};

function parseObject(value: string | Record<string, unknown>) {
  return typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value;
}

function parseRenderIntent(value: unknown): ScenarioRenderIntent {
  return ScenarioRenderIntentSchema.parse(
    typeof value === "string" ? JSON.parse(value) : value,
  );
}

function workerCanRun(worker: WorkerRow, candidate: Candidate) {
  const capability = ScenarioRendererCapabilitySchema.safeParse(parseObject(worker.capabilities));
  const intentValue = typeof candidate.render_intent === "string"
    ? JSON.parse(candidate.render_intent) as Record<string, unknown>
    : candidate.render_intent;
  const intent = ScenarioRenderIntentSchema.safeParse(intentValue);
  if (!capability.success || !intent.success || capability.data.backend !== candidate.renderer_engine) return false;
  const sources = intent.data.renderSpec.sources;
  const resources = typeof candidate.resource_request === "string"
    ? JSON.parse(candidate.resource_request) as { estimatedGpuBytes?: unknown }
    : candidate.resource_request as { estimatedGpuBytes?: unknown };
  if (
    typeof resources.estimatedGpuBytes !== "number"
    || resources.estimatedGpuBytes > (Number(worker.gpu_memory_mib) - 1024) * 1024 * 1024
  ) return false;
  const physicalSensors = new Set(sources.map((source) => `${source.actorId}\0${source.sensorId}`));
  if (physicalSensors.size > capability.data.limits.maxSimultaneousSensors) return false;
  if (physicalSensors.size === 18 && !worker.hardware_profile.startsWith("rtx5080-")) return false;
  if (sources.some((source) => !capability.data.modalities.includes(source.modality))) return false;
  if (sources.some((source) => {
    const attributes = source.attributes;
    return "width" in attributes && (
      attributes.width > capability.data.limits.maxWidth
      || attributes.height > capability.data.limits.maxHeight
      || attributes.fps > capability.data.limits.maxFramesPerSecond
    );
  })) return false;
  const required = intent.data.renderSpec.capabilityIntent.required;
  return required.every((item) =>
    capability.data.capabilities.includes(item as typeof capability.data.capabilities[number])
  );
}

type Claimed = {
  jobId: string;
  attempt: number;
  attemptId: string;
  leaseId: string;
  fenceToken: string;
  expiresAt: string;
  intent: ScenarioRenderIntent;
  intentSha256: string;
  executionPackageControlSha256: string;
  inputs: Array<{
    inputId: string;
    relativePath?: string;
    sha256: string;
    sizeBytes: number;
    bucket: string;
    key: string;
  }>;
};

async function reapExpiredRenderIntentLeasesV2() {
  const expired = await queryRows<{ lease_id: string; attempt_id: string; job_id: string }>(
    `SELECT id AS lease_id, render_attempt_id AS attempt_id, render_job_id AS job_id
       FROM simforge.worker_leases
      WHERE lease_state = 'active' AND expires_at <= NOW()
      ORDER BY expires_at LIMIT 100`,
  );
  for (const item of expired) {
    await withTransaction(async (tx) => {
      const released = await tx.queryOne<{ id: string }>(
        `UPDATE simforge.worker_leases SET lease_state = 'expired', released_at = NOW()
          WHERE id = :lease_id AND lease_state = 'active' AND expires_at <= NOW()
          RETURNING id`,
        { lease_id: item.lease_id },
      );
      if (!released) return;
      await tx.execute(
        `UPDATE simforge.render_attempts SET attempt_state = 'expired', completed_at = NOW()
          WHERE id = :attempt_id AND attempt_state IN ('leased', 'running')`,
        { attempt_id: item.attempt_id },
      );
      await tx.execute(
        `UPDATE simforge.render_jobs
            SET job_state = CASE
                  WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                  WHEN attempt_count < max_attempts THEN 'queued'
                  ELSE 'failed'
                END,
                failure_code = CASE WHEN attempt_count < max_attempts THEN NULL ELSE 'lease_expired' END,
                progress = CASE WHEN cancel_requested_at IS NULL AND attempt_count < max_attempts THEN 0 ELSE progress END,
                progress_detail = CASE
                  WHEN cancel_requested_at IS NULL AND attempt_count < max_attempts THEN NULL
                  ELSE progress_detail
                END,
                updated_at = NOW(),
                completed_at = CASE
                  WHEN cancel_requested_at IS NOT NULL OR attempt_count >= max_attempts THEN NOW()
                  ELSE NULL
                END
          WHERE id = :job_id AND job_state IN ('leased', 'running')`,
        { job_id: item.job_id },
      );
    });
  }
}

export async function claimRenderJobV2(registrationId: string, workerNodeId: string): Promise<Claimed | null> {
  await reapExpiredRenderIntentLeasesV2();
  const candidates = await queryRows<Candidate>(
    `SELECT id, renderer_engine, render_intent, intent_sha256, resource_request
       FROM simforge.render_jobs
      WHERE job_state = 'queued' AND cancel_requested_at IS NULL
        AND request_contract_version = :contract
      ORDER BY priority DESC, created_at, id LIMIT 32`,
    { contract: INTENT_CONTRACT },
  );
  for (const candidate of candidates) {
    const claimed = await withTransaction(async (tx): Promise<Claimed | null> => {
      const worker = await tx.queryOne<WorkerRow>(
        `SELECT id, registration_id, worker_version, image_digest, renderer_engine, hardware_profile,
                metadata->>'baseImageDigest' AS base_image_digest,
                (metadata->>'gpuMemoryMiB')::integer AS gpu_memory_mib,
                metadata->>'baseImagePlatformDigest' AS base_image_platform_digest,
                capabilities::text AS capabilities
           FROM simforge.worker_nodes
          WHERE registration_id = :registration_id AND id = :worker_node_id AND environment = :environment
            AND registration_state = 'active'
            AND approved_worker_version = worker_version
            AND approved_image_digest = image_digest
            AND approved_hardware_profile = hardware_profile
            AND approved_at IS NOT NULL
          FOR UPDATE`,
        { registration_id: registrationId, worker_node_id: workerNodeId, environment: runtimeEnvironment() },
      );
      if (!worker || !workerCanRun(worker, candidate)) return null;
      const busy = await tx.queryOne<{ id: string }>(
        `SELECT id FROM simforge.worker_leases
          WHERE worker_node_id = :worker_id AND lease_state = 'active' LIMIT 1`,
        { worker_id: worker.id },
      );
      await tx.execute(
        `UPDATE simforge.worker_nodes SET last_heartbeat_at = NOW(), last_idle_heartbeat_at = NOW()
          WHERE id = :worker_id`,
        { worker_id: worker.id },
      );
      if (busy) return null;
      const row = await tx.queryOne<{
        id: string; workspace_id: string; revision_id: string; execution_package_id: string;
        execution_package_control_sha256: string; attempt_count: number;
        render_intent: string | Record<string, unknown>; intent_sha256: string;
      }>(
        `SELECT id, workspace_id, revision_id, execution_package_id,
                execution_package_control_sha256, attempt_count,
                render_intent::text AS render_intent, intent_sha256
           FROM simforge.render_jobs
          WHERE id = :job_id AND renderer_engine = :renderer_engine
            AND job_state = 'queued' AND cancel_requested_at IS NULL
            AND request_contract_version = :contract
          FOR UPDATE`,
        { job_id: candidate.id, renderer_engine: worker.renderer_engine, contract: INTENT_CONTRACT },
      );
      if (!row) return null;
      const intent = ScenarioRenderIntentSchema.parse(parseObject(row.render_intent));
      if (canonicalJsonSha256(intent) !== row.intent_sha256) throw new Error("render_intent_digest_mismatch");
      const attempt = Number(row.attempt_count) + 1;
      const attemptId = scenarioId("usat");
      const leaseId = scenarioId("uslease");
      const fenceToken = randomBytes(32).toString("hex");
      const expiry = await tx.queryOne<{ expires_at: string }>(
        `SELECT (NOW() + (:seconds * INTERVAL '1 second'))::text AS expires_at`,
        { seconds: LEASE_SECONDS },
      );
      if (!expiry) throw new Error("lease_expiry_missing");
      await tx.execute(
        `INSERT INTO simforge.render_attempts (
           id, workspace_id, render_job_id, attempt_number, worker_node_id,
           execution_package_id, execution_package_control_sha256,
           worker_class, runtime_version, image_digest,
           renderer_engine, base_image_digest, base_image_platform_digest, engine_capabilities_sha256
         ) SELECT :attempt_id, workspace_id, id, :attempt, :worker_id,
                  execution_package_id, execution_package_control_sha256,
                  :worker_class, :runtime_version, :image_digest,
                  :renderer_engine, :base_image_digest, :base_image_platform_digest, :engine_capabilities_sha256
             FROM simforge.render_jobs WHERE id = :job_id`,
        {
          attempt_id: attemptId,
          attempt,
          worker_id: worker.id,
          worker_class: worker.renderer_engine,
          runtime_version: worker.worker_version,
          image_digest: worker.image_digest,
          renderer_engine: worker.renderer_engine,
          base_image_digest: worker.base_image_digest,
          base_image_platform_digest: worker.base_image_platform_digest,
          engine_capabilities_sha256: canonicalJsonSha256(parseObject(worker.capabilities)),
          job_id: row.id,
        },
      );
      await tx.execute(
        `INSERT INTO simforge.worker_leases (
           id, render_job_id, render_attempt_id, worker_node_id, lease_token_sha256, expires_at
         ) VALUES (
           :lease_id, :job_id, :attempt_id, :worker_id, :token_sha256, CAST(:expires_at AS timestamptz)
         )`,
        {
          lease_id: leaseId,
          job_id: row.id,
          attempt_id: attemptId,
          worker_id: worker.id,
          token_sha256: sha256(fenceToken),
          expires_at: expiry.expires_at,
        },
      );
      await tx.execute(
        `UPDATE simforge.render_jobs
            SET job_state = 'leased', attempt_count = :attempt, started_at = COALESCE(started_at, NOW()),
                updated_at = NOW()
          WHERE id = :job_id`,
        { attempt, job_id: row.id },
      );
      let inputs: Claimed["inputs"];
      if (worker.renderer_engine === "native") {
        inputs = await tx.queryRows<Claimed["inputs"][number]>(
          `SELECT input_id AS "inputId", sha256, size_bytes AS "sizeBytes",
                  storage_bucket AS bucket, storage_key AS key
             FROM (
               SELECT 'scenario.xosc'::text AS input_id, a.sha256, a.byte_length AS size_bytes,
                      a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep
                 JOIN simforge.artifacts a ON a.id = ep.xosc_artifact_id
                WHERE ep.id = :package_id
               UNION ALL
               SELECT a.id::text, a.sha256, a.byte_length, a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep
                 JOIN simforge.artifacts a ON a.id = ep.xodr_artifact_id
                WHERE ep.id = :package_id
               UNION ALL
               SELECT a.id::text, a.sha256, a.byte_length, a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep
                 JOIN simforge.asset_catalog_versions c ON c.id = ep.asset_catalog_version_id
                 JOIN simforge.artifacts a ON a.id = c.manifest_artifact_id
                WHERE ep.id = :package_id
             ) input_rows`,
          { package_id: row.execution_package_id },
        );
        const nativeMembers = await tx.queryRows<{
          relative_path: string;
          sha256: string;
          byte_length: number | string;
          storage_bucket: string;
          storage_key: string;
          object_count: number | string;
        }>(
          `SELECT m.relative_path, b.sha256, b.byte_length, b.storage_bucket, b.storage_key,
                  s.object_count
             FROM simforge.revisions r
             JOIN simforge.map_versions mv
               ON mv.id = r.map_version_id AND mv.workspace_id = r.workspace_id
             JOIN simforge.native_map_asset_sets s
               ON s.id = mv.native_map_asset_set_id
              AND s.workspace_id = mv.workspace_id
              AND s.map_version_id = mv.id
              AND s.asset_set_state = 'available'
              AND s.contract_version = 'simforge.native-map-asset-set.v1'
              AND s.registry_release_digest = mv.descriptor->>'registryReleaseDigest'
             JOIN simforge.native_map_asset_members m ON m.asset_set_id = s.id
             JOIN simforge.native_map_asset_blobs b
               ON b.id = m.blob_id AND b.verification_state = 'verified'
            WHERE r.id = :revision_id AND r.workspace_id = :workspace_id
            ORDER BY m.relative_path`,
          { revision_id: row.revision_id, workspace_id: row.workspace_id },
        );
        const expectedCount = Number(nativeMembers[0]?.object_count ?? -1);
        if (expectedCount < 1 || nativeMembers.length !== expectedCount) {
          throw new Error("native_map_asset_set_incomplete");
        }
        const renderMembers = nativeMembers.filter((member) => member.relative_path !== ".map-release.json");
        if (!renderMembers.some((member) => member.relative_path === "master.gltf")) {
          throw new Error("native_map_master_unavailable");
        }
        if (renderMembers.length > 4093) throw new Error("native_map_asset_set_too_large");
        inputs.push(...renderMembers.map((member) => ({
          inputId: member.relative_path === "master.gltf"
            ? "map.tile.000000"
            : `map.resource.${sha256(member.relative_path)}`,
          relativePath: member.relative_path,
          sha256: member.sha256,
          sizeBytes: Number(member.byte_length),
          bucket: member.storage_bucket,
          key: member.storage_key,
        })));
        const byInputId = new Map(inputs.map((input) => [input.inputId, input]));
        if (byInputId.size !== inputs.length
          || inputs.length !== intent.assets.length + 1
          || intent.assets.some((asset) => {
            const declared = byInputId.get(asset.assetId);
            return !declared || declared.sha256 !== asset.sha256 || Number(declared.sizeBytes) !== asset.sizeBytes;
          })) {
          throw new Error("native_render_input_declaration_mismatch");
        }
      } else {
        inputs = await tx.queryRows<Claimed["inputs"][number]>(
          `SELECT input_id AS "inputId", sha256, size_bytes AS "sizeBytes",
                  storage_bucket AS bucket, storage_key AS key
             FROM (
               SELECT 'openscenario'::text AS input_id, a.sha256, a.byte_length AS size_bytes,
                      a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep JOIN simforge.artifacts a ON a.id = ep.xosc_artifact_id
                WHERE ep.id = :package_id
               UNION ALL
               SELECT 'map', a.sha256, a.byte_length, a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep JOIN simforge.artifacts a ON a.id = ep.xodr_artifact_id
                WHERE ep.id = :package_id
               UNION ALL
               SELECT 'catalog', a.sha256, a.byte_length, a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep
                 JOIN simforge.asset_catalog_versions c ON c.id = ep.asset_catalog_version_id
                 JOIN simforge.artifacts a ON a.id = c.manifest_artifact_id
                WHERE ep.id = :package_id
               UNION ALL
               SELECT 'execution-package', a.sha256, a.byte_length, a.storage_bucket, a.storage_key
                 FROM simforge.execution_packages ep JOIN simforge.artifacts a ON a.id = ep.package_artifact_id
                WHERE ep.id = :package_id
             ) input_rows`,
          { package_id: row.execution_package_id },
        );
      }
      return {
        jobId: row.id,
        attempt,
        attemptId,
        leaseId,
        fenceToken,
        expiresAt: expiry.expires_at,
        intent,
        intentSha256: row.intent_sha256,
        executionPackageControlSha256: row.execution_package_control_sha256,
        inputs,
      };
    });
    if (claimed) return claimed;
  }
  return null;
}

export async function claimResponseV2(registrationId: string, workerNodeId: string) {
  const claimed = await claimRenderJobV2(registrationId, workerNodeId);
  if (!claimed) {
    return { schema: CONTROL_SCHEMA, type: "job.none" as const, retryAfterMs: 2_000 };
  }
  return {
    schema: CONTROL_SCHEMA,
    type: "job.leased" as const,
    jobId: claimed.jobId,
    attempt: claimed.attempt,
    lease: {
      leaseId: claimed.leaseId,
      fenceToken: claimed.fenceToken,
      expiresAt: new Date(claimed.expiresAt).toISOString(),
    },
    intent: claimed.intent,
    intentSha256: claimed.intentSha256,
    executionPackageControlSha256: claimed.executionPackageControlSha256,
    inputs: await Promise.all(claimed.inputs.map(async (input) => ({
      inputId: input.inputId,
      ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
      sha256: input.sha256,
      sizeBytes: Number(input.sizeBytes),
      download: {
        url: await getPresignedGetUrl(input.key, input.bucket, LEASE_SECONDS),
        headers: {},
      },
    }))),
  };
}

type ActiveLease = {
  lease_id: string;
  job_id: string;
  workspace_id: string;
  attempt_id: string;
  attempt_number: number;
  worker_node_id: string;
  intent_sha256: string;
  render_intent: string | Record<string, unknown>;
  cancel_requested_at: string | null;
};

async function activeLease(
  leaseId: string,
  fenceToken: string,
  workerNodeId: string,
  jobId: string,
) {
  const rows = await queryRows<ActiveLease>(
    `SELECT l.id AS lease_id, j.id AS job_id, j.workspace_id, l.render_attempt_id AS attempt_id,
            a.attempt_number, l.worker_node_id, j.intent_sha256, j.render_intent,
            j.cancel_requested_at::text AS cancel_requested_at
       FROM simforge.worker_leases l
       JOIN simforge.render_jobs j ON j.id = l.render_job_id
       JOIN simforge.render_attempts a ON a.id = l.render_attempt_id
      WHERE l.id = :lease_id AND l.worker_node_id = :worker_node_id
        AND j.id = :job_id
        AND l.lease_token_sha256 = :token_sha256 AND l.lease_state = 'active'
        AND l.expires_at > NOW() AND j.job_state IN ('leased', 'running')
      LIMIT 1`,
    { lease_id: leaseId, job_id: jobId, worker_node_id: workerNodeId, token_sha256: sha256(fenceToken) },
  );
  return rows[0] ?? null;
}

export async function heartbeatRenderLeaseV2(input: {
  jobId: string; leaseId: string; fenceToken: string; progressSequence: number; workerNodeId: string;
}) {
  const rows = await queryRows<{ expires_at: string; cancel_requested_at: string | null; durable_sequence: number }>(
    `UPDATE simforge.worker_leases l
        SET heartbeat_at = NOW(), expires_at = NOW() + (:seconds * INTERVAL '1 second')
       FROM simforge.render_jobs j
      WHERE l.id = :lease_id AND l.render_job_id = j.id
        AND j.id = :job_id
        AND l.worker_node_id = :worker_node_id AND l.lease_token_sha256 = :token_sha256
        AND l.lease_state = 'active' AND l.expires_at > NOW()
        AND COALESCE((j.progress_detail->>'sequence')::bigint, 0) >= :progress_sequence
      RETURNING l.expires_at::text AS expires_at, j.cancel_requested_at::text AS cancel_requested_at,
                COALESCE((j.progress_detail->>'sequence')::bigint, 0)::bigint AS durable_sequence`,
    {
      job_id: input.jobId,
      lease_id: input.leaseId,
      worker_node_id: input.workerNodeId,
      token_sha256: sha256(input.fenceToken),
      progress_sequence: input.progressSequence,
      seconds: LEASE_SECONDS,
    },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    schema: CONTROL_SCHEMA,
    type: "lease.heartbeat-ack" as const,
    leaseExpiresAt: new Date(row.expires_at).toISOString(),
    cancelRequested: row.cancel_requested_at !== null,
    cancelReason: row.cancel_requested_at ? "user_requested" : null,
  };
}

function progressRatio(record: RenderProgressRecord) {
  if (record.event !== "stage.progress") return null;
  const stageOffset: Record<typeof record.stage, number> = {
    downloading: 0,
    preparing: 0.1,
    rendering: 0.2,
    encoding: 0.75,
    uploading: 0.85,
    finalizing: 0.95,
  };
  const stageSpan: Record<typeof record.stage, number> = {
    downloading: 0.1,
    preparing: 0.1,
    rendering: 0.55,
    encoding: 0.1,
    uploading: 0.1,
    finalizing: 0.05,
  };
  return Math.min(0.999, stageOffset[record.stage] + stageSpan[record.stage] * record.completed / record.total);
}

export async function appendRenderProgressV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; records: RenderProgressRecord[];
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease) return null;
  if (input.records.some((record) => record.jobId !== lease.job_id || record.attempt !== lease.attempt_number)) {
    throw new Error("render_progress_lineage_mismatch");
  }
  const ordered = [...input.records].sort((left, right) => left.sequence - right.sequence);
  if (ordered.some((record, index) => index > 0 && record.sequence !== ordered[index - 1]!.sequence + 1)) {
    throw new Error("render_progress_sequence_gap");
  }
  await withTransaction(async (tx) => {
    const current = await tx.queryOne<{ sequence: number }>(
      `SELECT COALESCE(MAX(sequence), -1)::bigint AS sequence
         FROM simforge.render_progress_records WHERE render_attempt_id = :attempt_id`,
      { attempt_id: lease.attempt_id },
    );
    const expected = Number(current?.sequence ?? -1) + 1;
    if (ordered[0]!.sequence > expected) throw new Error("render_progress_sequence_gap");
    for (const record of ordered) {
      await tx.execute(
        `INSERT INTO simforge.render_progress_records (
           render_job_id, render_attempt_id, sequence, record
         ) VALUES (:job_id, :attempt_id, :sequence, CAST(:record AS jsonb))
         ON CONFLICT (render_attempt_id, sequence) DO NOTHING`,
        { job_id: lease.job_id, attempt_id: lease.attempt_id, sequence: record.sequence, record },
      );
    }
    const latest = ordered.at(-1)!;
    const ratio = progressRatio(latest);
    await tx.execute(
      `UPDATE simforge.render_jobs
          SET job_state = CASE WHEN job_state = 'leased' THEN 'running' ELSE job_state END,
              progress_detail = CAST(:detail AS jsonb),
              progress = GREATEST(progress, COALESCE(:progress, progress)), updated_at = NOW()
        WHERE id = :job_id AND workspace_id = :workspace_id`,
      { detail: latest, progress: ratio, job_id: lease.job_id, workspace_id: lease.workspace_id },
    );
    await tx.execute(
      `UPDATE simforge.render_attempts SET attempt_state = 'running', started_at = COALESCE(started_at, NOW())
        WHERE id = :attempt_id`,
      { attempt_id: lease.attempt_id },
    );
  });
  return {
    schema: CONTROL_SCHEMA,
    type: "lease.progress-ack" as const,
    acceptedThroughSequence: ordered.at(-1)!.sequence,
  };
}

function identityKind(identity: RenderArtifactIdentity) {
  return identity.actorId
    ? `${identity.role}-${identity.actorId}-${identity.sensorId}-${identity.modality}`
    : identity.role;
}

function identityExpected(intentValue: unknown, identity: RenderArtifactIdentity) {
  const intent = parseRenderIntent(intentValue);
  if (identity.role === "diagnostics") return true;
  if (identity.actorId === null) return intent.renderSpec.artifacts.includes(identity.role);
  if (!intent.renderSpec.artifacts.includes(identity.role)) return false;
  return intent.renderSpec.sources.some((source) =>
    source.actorId === identity.actorId
    && source.sensorId === identity.sensorId
    && source.modality === identity.modality
  );
}

export async function reserveRenderArtifactV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; identity: RenderArtifactIdentity;
  sha256: string; sizeBytes: number; mediaType: string;
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease || !identityExpected(lease.render_intent, input.identity)) return null;
  const artifactId = scenarioId("usart");
  const bucket = artifactBucket();
  const key = `${lease.workspace_id}/renders/${lease.job_id}/${lease.attempt_id}/${artifactId}`;
  const rows = await queryRows<{ id: string }>(
    `INSERT INTO simforge.artifact_uploads (
       id, workspace_id, revision_id, render_job_id, render_attempt_id,
       artifact_kind, artifact_role, artifact_actor_id, artifact_sensor_id, artifact_modality,
       media_type, expected_sha256, expected_size_bytes,
       storage_bucket, storage_key, expires_at
     ) SELECT :id, j.workspace_id, j.revision_id, j.id, :attempt_id,
              :artifact_kind, :artifact_role, :actor_id, :sensor_id, :modality,
              :media_type, :sha256, :size_bytes,
              :bucket, :key, NOW() + INTERVAL '15 minutes'
         FROM simforge.render_jobs j
        WHERE j.id = :job_id AND j.cancel_requested_at IS NULL
          AND EXISTS (
            SELECT 1 FROM simforge.worker_leases l
             WHERE l.id = :lease_id AND l.render_attempt_id = :attempt_id
               AND l.worker_node_id = :worker_node_id
               AND l.lease_token_sha256 = :token_sha256
               AND l.lease_state = 'active' AND l.expires_at > NOW()
          )
     ON CONFLICT DO NOTHING RETURNING id`,
    {
      id: artifactId,
      artifact_kind: `${identityKind(input.identity)}-${lease.attempt_id}`,
      artifact_role: input.identity.role,
      actor_id: input.identity.actorId,
      sensor_id: input.identity.sensorId,
      modality: input.identity.modality,
      media_type: input.mediaType,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      bucket,
      key,
      job_id: lease.job_id,
      lease_id: input.leaseId,
      worker_node_id: input.workerNodeId,
      token_sha256: sha256(input.fenceToken),
    },
  );
  if (!rows[0]) return null;
  return {
    schema: CONTROL_SCHEMA,
    type: "artifact.reserved" as const,
    artifactId,
    upload: {
      url: await getPresignedPutUrl(key, input.mediaType, bucket, 900, input.sha256),
      method: "PUT" as const,
      headers: checksumBoundPutRequiredHeaders(input.mediaType, input.sha256),
    },
  };
}

function identityKey(identity: RenderArtifactIdentity) {
  return `${identity.role}\0${identity.actorId ?? ""}\0${identity.sensorId ?? ""}\0${identity.modality ?? ""}`;
}

function expectedClosure(intentValue: unknown) {
  const intent = parseRenderIntent(intentValue);
  const expected = new Set<string>();
  for (const role of ["manifest", "trace", "annotations"] as const) {
    if (intent.renderSpec.artifacts.includes(role)) {
      expected.add(identityKey({ role, actorId: null, sensorId: null, modality: null }));
    }
  }
  for (const role of ["video", "frames", "sensorArchive"] as const) {
    if (!intent.renderSpec.artifacts.includes(role)) continue;
    for (const source of intent.renderSpec.sources) {
      expected.add(identityKey({
        role,
        actorId: source.actorId,
        sensorId: source.sensorId,
        modality: source.modality,
      }));
    }
  }
  return expected;
}

type CompletionArtifact = {
  artifactId: string;
  identity: RenderArtifactIdentity;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
};

export async function completeRenderJobV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; intentSha256: string;
  manifest: { artifacts: CompletionArtifact[] };
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease || lease.intent_sha256 !== input.intentSha256) return null;
  const expected = expectedClosure(lease.render_intent);
  const actual = new Set(input.manifest.artifacts.filter((item) => item.identity.role !== "diagnostics").map((item) => identityKey(item.identity)));
  if (expected.size !== actual.size || [...expected].some((key) => !actual.has(key))) {
    throw new Error("render_artifact_closure_mismatch");
  }
  const reservations = await queryRows<{
    id: string; artifact_role: RenderArtifactIdentity["role"]; artifact_actor_id: string | null;
    artifact_sensor_id: string | null; artifact_modality: RenderArtifactIdentity["modality"];
    artifact_kind: string; media_type: string; expected_sha256: string; expected_size_bytes: number;
    storage_bucket: string; storage_key: string;
  }>(
    `SELECT id, artifact_role, artifact_actor_id, artifact_sensor_id, artifact_modality,
            artifact_kind, media_type, expected_sha256, expected_size_bytes,
            storage_bucket, storage_key
       FROM simforge.artifact_uploads
      WHERE render_attempt_id = :attempt_id AND upload_state = 'reserved'`,
    { attempt_id: lease.attempt_id },
  );
  if (reservations.length !== input.manifest.artifacts.length) throw new Error("render_artifact_closure_mismatch");
  const byId = new Map(reservations.map((row) => [row.id, row]));
  for (const declared of input.manifest.artifacts) {
    const reserved = byId.get(declared.artifactId);
    if (!reserved
      || reserved.expected_sha256 !== declared.sha256
      || Number(reserved.expected_size_bytes) !== declared.sizeBytes
      || reserved.media_type !== declared.mediaType
      || identityKey({
        role: reserved.artifact_role,
        actorId: reserved.artifact_actor_id,
        sensorId: reserved.artifact_sensor_id,
        modality: reserved.artifact_modality,
      } as RenderArtifactIdentity) !== identityKey(declared.identity)) {
      throw new Error("render_artifact_reservation_mismatch");
    }
    const object = await headS3Object(reserved.storage_key, reserved.storage_bucket);
    const checksum = object.checksumSha256
      ? Buffer.from(object.checksumSha256, "base64").toString("hex")
      : null;
    if (object.contentLength !== declared.sizeBytes || object.contentType !== declared.mediaType || checksum !== declared.sha256) {
      throw new Error("render_artifact_verification_failed");
    }
  }
  await withTransaction(async (tx) => {
    const fenced = await tx.queryOne<{ id: string }>(
      `SELECT l.id FROM simforge.worker_leases l
        JOIN simforge.render_jobs j ON j.id = l.render_job_id
       WHERE l.id = :lease_id AND l.render_attempt_id = :attempt_id
         AND l.worker_node_id = :worker_node_id AND l.lease_token_sha256 = :token_sha256
         AND l.lease_state = 'active' AND l.expires_at > NOW()
         AND j.intent_sha256 = :intent_sha256 AND j.job_state IN ('leased', 'running')
         AND j.cancel_requested_at IS NULL
       FOR UPDATE OF l, j`,
      {
        lease_id: input.leaseId,
        attempt_id: lease.attempt_id,
        worker_node_id: input.workerNodeId,
        token_sha256: sha256(input.fenceToken),
        intent_sha256: input.intentSha256,
      },
    );
    if (!fenced) throw new Error("render_lease_fence_rejected");
    for (const declared of input.manifest.artifacts) {
      await tx.execute(
        `INSERT INTO simforge.artifacts (
           id, workspace_id, revision_id, artifact_kind, media_type,
           storage_bucket, storage_key, sha256, byte_length, artifact_state, metadata, verified_at
         ) SELECT u.id, u.workspace_id, u.revision_id, u.artifact_kind, u.media_type,
                  u.storage_bucket, u.storage_key, u.expected_sha256, u.expected_size_bytes,
                  'available', jsonb_build_object('renderIdentity', jsonb_build_object(
                    'role', u.artifact_role, 'actorId', u.artifact_actor_id,
                    'sensorId', u.artifact_sensor_id, 'modality', u.artifact_modality
                  )), NOW()
             FROM simforge.artifact_uploads u WHERE u.id = :artifact_id
         ON CONFLICT (id) DO NOTHING`,
        { artifact_id: declared.artifactId },
      );
      await tx.execute(
        `UPDATE simforge.artifact_uploads
            SET upload_state = 'uploaded', completed_artifact_id = :artifact_id, completed_at = NOW()
          WHERE id = :artifact_id AND render_attempt_id = :attempt_id`,
        { artifact_id: declared.artifactId, attempt_id: lease.attempt_id },
      );
      await tx.execute(
        `INSERT INTO simforge.artifact_links (
           id, workspace_id, artifact_id, render_job_id, render_attempt_id, relationship,
           artifact_role, artifact_actor_id, artifact_sensor_id, artifact_modality
         ) VALUES (
           :id, :workspace_id, :artifact_id, :job_id, :attempt_id, 'render_output',
           :role, :actor_id, :sensor_id, :modality
         ) ON CONFLICT DO NOTHING`,
        {
          id: scenarioId("usal"),
          workspace_id: lease.workspace_id,
          artifact_id: declared.artifactId,
          job_id: lease.job_id,
          attempt_id: lease.attempt_id,
          role: declared.identity.role,
          actor_id: declared.identity.actorId,
          sensor_id: declared.identity.sensorId,
          modality: declared.identity.modality,
        },
      );
    }
    await tx.execute(
      `UPDATE simforge.render_attempts SET attempt_state = 'succeeded', completed_at = NOW()
        WHERE id = :attempt_id`,
      { attempt_id: lease.attempt_id },
    );
    await tx.execute(
      `UPDATE simforge.worker_leases SET lease_state = 'released', released_at = NOW()
        WHERE id = :lease_id`,
      { lease_id: input.leaseId },
    );
    await tx.execute(
      `UPDATE simforge.render_jobs
          SET job_state = 'succeeded', progress = 1, completed_at = NOW(), updated_at = NOW()
        WHERE id = :job_id AND intent_sha256 = :intent_sha256`,
      { job_id: lease.job_id, intent_sha256: input.intentSha256 },
    );
  });
  return { schema: CONTROL_SCHEMA, type: "mutation.accepted" as const };
}

export async function failRenderJobV2(input: {
  jobId: string; leaseId: string; fenceToken: string; workerNodeId: string; intentSha256: string;
  failure: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
}) {
  const lease = await activeLease(input.leaseId, input.fenceToken, input.workerNodeId, input.jobId);
  if (!lease || lease.intent_sha256 !== input.intentSha256) return null;
  await withTransaction(async (tx) => {
    const released = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.worker_leases SET lease_state = 'released', released_at = NOW()
        WHERE id = :lease_id AND worker_node_id = :worker_node_id
          AND lease_token_sha256 = :token_sha256 AND lease_state = 'active' AND expires_at > NOW()
        RETURNING id`,
      { lease_id: input.leaseId, worker_node_id: input.workerNodeId, token_sha256: sha256(input.fenceToken) },
    );
    if (!released) throw new Error("render_lease_fence_rejected");
    await tx.execute(
      `UPDATE simforge.render_attempts
          SET attempt_state = CASE WHEN :cancelled THEN 'cancelled' ELSE 'failed' END,
              completed_at = NOW(), metrics = jsonb_build_object('failureCode', :code)
        WHERE id = :attempt_id`,
      { attempt_id: lease.attempt_id, code: input.failure.code, cancelled: lease.cancel_requested_at !== null },
    );
    await tx.execute(
      `UPDATE simforge.render_jobs
          SET job_state = CASE
                WHEN cancel_requested_at IS NOT NULL THEN 'cancelled'
                WHEN :retryable AND attempt_count < max_attempts THEN 'queued'
                ELSE 'failed'
              END,
              failure_code = :code,
              failure_detail = CAST(:detail AS jsonb),
              progress = CASE WHEN :retryable AND attempt_count < max_attempts THEN 0 ELSE progress END,
              progress_detail = CASE WHEN :retryable AND attempt_count < max_attempts THEN NULL ELSE progress_detail END,
              updated_at = NOW(),
              completed_at = CASE
                WHEN cancel_requested_at IS NOT NULL THEN NOW()
                WHEN :retryable AND attempt_count < max_attempts THEN NULL
                ELSE NOW()
              END
        WHERE id = :job_id AND intent_sha256 = :intent_sha256
          AND job_state IN ('leased', 'running')`,
      {
        retryable: input.failure.retryable,
        code: input.failure.code,
        detail: { message: input.failure.message, details: input.failure.details ?? null },
        job_id: lease.job_id,
        intent_sha256: input.intentSha256,
      },
    );
  });
  return { schema: CONTROL_SCHEMA, type: "mutation.accepted" as const };
}

export async function drainRenderWorkerV2(registrationId: string, workerNodeId: string) {
  const rows = await queryRows<{ registration_id: string }>(
    `UPDATE simforge.worker_nodes SET registration_state = 'draining', last_heartbeat_at = NOW()
      WHERE id = :worker_node_id AND registration_id = :registration_id
        AND registration_state IN ('active', 'draining')
      RETURNING registration_id`,
    { worker_node_id: workerNodeId, registration_id: registrationId },
  );
  return rows[0] ? { schema: CONTROL_SCHEMA, type: "mutation.accepted" as const } : null;
}

export async function renderProgressForJob(context: Pick<AppContext, "workspaceId">, jobId: string) {
  return queryRows<{ sequence: number; record: unknown; recorded_at: string }>(
    `SELECT p.sequence, p.record, p.recorded_at::text AS recorded_at
       FROM simforge.render_progress_records p
       JOIN simforge.render_jobs j ON j.id = p.render_job_id
      WHERE j.workspace_id = :workspace_id AND p.render_job_id = :job_id
      ORDER BY p.render_attempt_id, p.sequence LIMIT 5000`,
    { workspace_id: context.workspaceId, job_id: jobId },
  );
}
