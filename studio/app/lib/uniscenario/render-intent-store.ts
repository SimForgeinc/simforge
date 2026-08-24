import type { AppContext } from "@/app/lib/db/app-context";
import { withTransaction } from "@/app/lib/db/data-api";
import type { RenderSpecV3 } from "@simforge/scenario";
import { canonicalJsonSha256, uniscenarioId } from "./core";
import type { UniScenarioRenderJobDto } from "./contracts";
import {
  UniScenarioRenderIntentSchema,
  type SubmitUniScenarioRenderIntent,
  type UniScenarioRenderIntent,
} from "./render-wire-contracts";

const RTX5080_MAX_SIMULTANEOUS_SOURCES = 18;
const RTX5080_USABLE_GPU_BYTES = 15_000 * 1024 * 1024;
const RENDER_INTENT_CONTRACT = "uniscenario.render-intent/v1";
const PRONTO_SENSOR_HOST_ASSET_ID = "vehicle.kia.carnival";

type ImmutableLineageRow = {
  revision_id: string;
  scenario_sha256: string;
  canonical_content: string | Record<string, unknown>;
  execution_package_id: string;
  source_input_digest: string;
  xosc_sha256: string;
  xosc_size: number;
  map_id: string;
  map_revision_id: string;
  map_sha256: string;
  map_artifact_id: string;
  map_size: number;
  catalog_artifact_id: string;
  catalog_sha256: string;
  catalog_size: number;
};

type InsertedJob = {
  id: string;
  revision_id: string;
  execution_package_id: string;
  job_mode: "browser_render" | "full_render";
  job_state: UniScenarioRenderJobDto["status"];
  progress: number;
  created_at: string;
  updated_at: string;
};

export type RenderResourceRequestV2 = {
  schema: "uniscenario.render-resource-request/v2";
  durationSeconds: number;
  simultaneousSources: number;
  modalities: Record<string, number>;
  cameraPixelsPerFrame: number;
  maxWidth: number;
  maxHeight: number;
  framesPerSecond: number;
  estimatedGpuBytes: number;
  estimatedOutputBytes: number;
};

function cameraAttributes(source: RenderSpecV3["sources"][number]) {
  return source.modality === "rgb"
    || source.modality === "depth"
    || source.modality === "semantic"
    || source.modality === "instance"
    ? source.attributes
    : null;
}

export function deriveRenderIntentResources(spec: RenderSpecV3): RenderResourceRequestV2 {
  const durationSeconds = spec.clip.endSeconds - spec.clip.startSeconds;
  const modalities: Record<string, number> = {};
  const physicalSensors = new Set(spec.sources.map((source) => `${source.actorId}\0${source.sensorId}`));
  let cameraPixelsPerFrame = 0;
  let maxWidth = 0;
  let maxHeight = 0;
  let framesPerSecond = spec.video?.fps ?? 1;
  let estimatedGpuBytes = 0;
  let estimatedOutputBytes = 0;
  for (const source of spec.sources) {
    modalities[source.modality] = (modalities[source.modality] ?? 0) + 1;
    const camera = cameraAttributes(source);
    if (camera) {
      const pixels = camera.width * camera.height;
      const bytesPerPixel = source.modality === "rgb" ? 4 : 8;
      cameraPixelsPerFrame += pixels;
      maxWidth = Math.max(maxWidth, camera.width);
      maxHeight = Math.max(maxHeight, camera.height);
      framesPerSecond = Math.max(framesPerSecond, camera.fps);
      estimatedGpuBytes += pixels * bytesPerPixel * 3;
      estimatedOutputBytes += pixels * bytesPerPixel * camera.fps * durationSeconds;
    } else if (source.modality === "lidar") {
      estimatedGpuBytes += 256 * 1024 * 1024;
      estimatedOutputBytes += source.attributes.pointsPerSecond * 24 * durationSeconds;
    } else if (source.modality === "radar") {
      estimatedGpuBytes += 64 * 1024 * 1024;
      estimatedOutputBytes += source.attributes.pointsPerSecond * 32 * durationSeconds;
    }
  }
  return {
    schema: "uniscenario.render-resource-request/v2",
    durationSeconds,
    simultaneousSources: physicalSensors.size,
    modalities,
    cameraPixelsPerFrame,
    maxWidth,
    maxHeight,
    framesPerSecond,
    estimatedGpuBytes,
    estimatedOutputBytes: Math.ceil(estimatedOutputBytes),
  };
}

function enforceRtx5080Admission(resources: RenderResourceRequestV2) {
  if (resources.simultaneousSources > RTX5080_MAX_SIMULTANEOUS_SOURCES) {
    throw new Error("uniscenario_render_resource_maxSimultaneousSensors_exceeded");
  }
  if (resources.estimatedGpuBytes > RTX5080_USABLE_GPU_BYTES) {
    throw new Error("uniscenario_render_resource_gpuMemory_exceeded");
  }
}

function selectedSensorHost(input: SubmitUniScenarioRenderIntent, lineage: ImmutableLineageRow) {
  const content = typeof lineage.canonical_content === "string"
    ? JSON.parse(lineage.canonical_content) as Record<string, unknown>
    : lineage.canonical_content;
  const roles = Array.isArray(content.roles) ? content.roles : [];
  const selectedActorIds = new Set(input.renderSpec.sources.map((source) => source.actorId));
  const selectedSourceKeys = new Set(
    input.renderSpec.sources.map((source) => `${source.actorId}\0${source.sensorId}\0${source.modality}`),
  );
  const foundActorIds = new Set<string>();
  const foundSourceKeys = new Set<string>();
  const catalogIds = new Set<string>();
  const cameraIds = new Set<string>();
  const lidarIds = new Set<string>();
  const radarIds = new Set<string>();
  for (const role of roles) {
    if (!role || typeof role !== "object") continue;
    const value = role as {
      id?: unknown;
      actor?: { catalogId?: unknown; sensors?: unknown[] };
    };
    if (typeof value.id !== "string" || !selectedActorIds.has(value.id)) continue;
    if (typeof value.actor?.catalogId !== "string" || !value.actor.catalogId.trim()) {
      throw new Error(`render_sensor_host_asset_missing:${value.id}`);
    }
    foundActorIds.add(value.id);
    catalogIds.add(value.actor.catalogId);
    for (const authoredSensor of value.actor.sensors ?? []) {
      if (!authoredSensor || typeof authoredSensor !== "object") continue;
      const sensor = authoredSensor as {
        id?: unknown;
        type?: unknown;
        mount?: unknown;
      };
      if (typeof sensor.id !== "string") continue;
      const selectedSources = input.renderSpec.sources.filter(
        (source) => source.actorId === value.id && source.sensorId === sensor.id,
      );
      for (const selected of selectedSources) {
        const modalityMatches = sensor.type === "dash_camera"
          ? ["rgb", "depth", "semantic", "instance"].includes(selected.modality)
          : sensor.type === "lidar"
            ? selected.modality === "lidar"
            : sensor.type === "radar" && selected.modality === "radar";
        if (!modalityMatches || canonicalJsonSha256(sensor.mount) !== canonicalJsonSha256(selected.transform)) {
          throw new Error(`render_sensor_source_mismatch:${value.id}:${sensor.id}`);
        }
        foundSourceKeys.add(`${value.id}\0${sensor.id}\0${selected.modality}`);
        if (sensor.type === "dash_camera") cameraIds.add(sensor.id);
        else if (sensor.type === "lidar") lidarIds.add(sensor.id);
        else if (sensor.type === "radar") radarIds.add(sensor.id);
      }
    }
  }
  if (foundActorIds.size !== selectedActorIds.size || foundSourceKeys.size !== selectedSourceKeys.size) {
    throw new Error("render_sensor_host_asset_lineage_incomplete");
  }
  if (foundActorIds.size !== 1 || catalogIds.size !== 1) {
    throw new Error("render_sensor_host_must_be_one_catalog_vehicle");
  }
  const actorId = [...foundActorIds][0]!;
  const catalogAssetId = [...catalogIds][0]!;
  if (input.engine === "carla" && catalogAssetId !== PRONTO_SENSOR_HOST_ASSET_ID) {
    throw new Error("pronto_sensor_host_must_be_kia_carnival");
  }
  return {
    actorId,
    catalogAssetId,
    cameras: cameraIds.size,
    lidars: lidarIds.size,
    radars: radarIds.size,
  };
}

function buildIntent(input: SubmitUniScenarioRenderIntent, lineage: ImmutableLineageRow): UniScenarioRenderIntent {
  const content = typeof lineage.canonical_content === "string"
    ? JSON.parse(lineage.canonical_content) as Record<string, unknown>
    : lineage.canonical_content;
  const clipSeconds = (content.choreography as { clipSeconds?: unknown } | undefined)?.clipSeconds;
  if (
    typeof clipSeconds !== "number"
    || input.renderSpec.clip.startSeconds !== 0
    || input.renderSpec.clip.endSeconds !== clipSeconds
  ) {
    throw new Error("pronto_render_must_cover_full_clip");
  }
  const sensorHost = selectedSensorHost(input, lineage);
  const intentId = uniscenarioId("usri");
  return UniScenarioRenderIntentSchema.parse({
    schema: RENDER_INTENT_CONTRACT,
    intentId,
    executionPackage: {
      id: lineage.execution_package_id,
      sourceInputDigest: lineage.source_input_digest,
    },
    scenarioRevision: {
      revisionId: lineage.revision_id,
      scenarioSha256: lineage.scenario_sha256,
      openScenario: { sha256: lineage.xosc_sha256, sizeBytes: Number(lineage.xosc_size) },
      map: {
        mapId: lineage.map_id,
        revisionId: lineage.map_revision_id,
        sha256: lineage.map_sha256,
      },
    },
    sensorHost: input.engine === "carla"
      ? {
        actorId: sensorHost.actorId,
        vehicleAsset: {
          catalogAssetId: "vehicle.kia.carnival",
          carlaBlueprintId: "vehicle.kia.carnival",
          carlaClassPath: "/Game/Carla/Blueprints/Vehicles/KiaCarnival2025/BP_KiaCarnival2025.BP_KiaCarnival2025_C",
          make: "Kia",
          model: "Carnival",
          baseType: "van",
          sourceImage: {
            repository: "ghcr.io/simforgeinc/carla-rfs-munich-belmont",
            indexSha256: "f17c639e5f86fd7458fe1d02d3be1d481deeaa714f3cac30e465187d04ec90e5",
            linuxAmd64ManifestSha256: "baed0d038437c55efe0abe52a762d352aeb21acdeeff5b11a15f6bd8a648de64",
          },
        },
        sensorRig: {
          rigId: "pronto.8-camera-6-lidar-4-radar",
          cameras: 8,
          lidars: 6,
          radars: 4,
        },
      }
      : {
        actorId: sensorHost.actorId,
        vehicleAsset: { catalogAssetId: sensorHost.catalogAssetId },
        sensorRig: {
          rigId: "authored",
          cameras: sensorHost.cameras,
          lidars: sensorHost.lidars,
          radars: sensorHost.radars,
        },
      },
    renderSpec: input.renderSpec,
    assets: [
      {
        assetId: lineage.map_artifact_id,
        kind: "map",
        sha256: lineage.map_sha256,
        sizeBytes: Number(lineage.map_size),
      },
      {
        assetId: lineage.catalog_artifact_id,
        kind: "catalog",
        sha256: lineage.catalog_sha256,
        sizeBytes: Number(lineage.catalog_size),
      },
    ],
    seed: Number.parseInt(lineage.scenario_sha256.slice(0, 8), 16),
  });
}

export async function createRenderIntentJob(
  context: Pick<AppContext, "workspaceId" | "userId">,
  input: SubmitUniScenarioRenderIntent,
): Promise<UniScenarioRenderJobDto | null> {
  const renderSpec = input.renderSpec;
  const resources = deriveRenderIntentResources(renderSpec);
  enforceRtx5080Admission(resources);
  const inserted = await withTransaction(async (tx) => {
    await tx.queryOne(`SELECT pg_advisory_xact_lock(hashtext(:workspace_id)) AS locked`, {
      workspace_id: context.workspaceId,
    });
    const existing = await tx.queryOne<InsertedJob & { intent_sha256: string; renderer_engine: string; render_spec_sha256: string }>(
      `SELECT id, revision_id, execution_package_id, job_mode, job_state, progress,
              intent_sha256, renderer_engine, render_spec_sha256,
              created_at::text AS created_at, updated_at::text AS updated_at
         FROM uniscenario.render_jobs
        WHERE workspace_id = :workspace_id AND idempotency_key = :idempotency_key
        LIMIT 1`,
      { workspace_id: context.workspaceId, idempotency_key: input.idempotencyKey },
    );
    if (existing) {
      if (existing.revision_id !== input.revisionId
        || existing.execution_package_id !== input.executionPackageId
        || existing.renderer_engine !== input.engine
        || existing.render_spec_sha256 !== canonicalJsonSha256(renderSpec)) {
        throw new Error("uniscenario_render_intent_idempotency_conflict");
      }
      return existing;
    }
    const counts = await tx.queryOne<{ active_count: number; queued_count: number }>(
      `SELECT COUNT(*) FILTER (WHERE job_state IN ('leased', 'running'))::int AS active_count,
              COUNT(*) FILTER (WHERE job_state = 'queued')::int AS queued_count
         FROM uniscenario.render_jobs WHERE workspace_id = :workspace_id`,
      { workspace_id: context.workspaceId },
    );
    const activeLimit = Math.max(1, Number(process.env.UNISCENARIO_WORKSPACE_CONCURRENCY_LIMIT ?? 2));
    const queueLimit = Math.max(activeLimit, Number(process.env.UNISCENARIO_WORKSPACE_QUEUE_LIMIT ?? 20));
    if (Number(counts?.active_count ?? 0) >= activeLimit || Number(counts?.queued_count ?? 0) >= queueLimit) {
      throw new Error("uniscenario_workspace_limit_reached");
    }
    const lineage = await tx.queryOne<ImmutableLineageRow>(
      `SELECT r.id AS revision_id, r.content_sha256 AS scenario_sha256,
              r.canonical_content::text AS canonical_content,
              ep.id AS execution_package_id, ep.source_input_digest,
              xosc.sha256 AS xosc_sha256, xosc.byte_length AS xosc_size,
              COALESCE(NULLIF(mv.source_map_id, ''), mv.id) AS map_id,
              mv.id AS map_revision_id, xodr.sha256 AS map_sha256,
              xodr.id AS map_artifact_id, xodr.byte_length AS map_size,
              catalog_artifact.id AS catalog_artifact_id,
              catalog_artifact.sha256 AS catalog_sha256,
              catalog_artifact.byte_length AS catalog_size
         FROM uniscenario.revisions r
         JOIN uniscenario.execution_packages ep
           ON ep.revision_id = r.id AND ep.workspace_id = r.workspace_id
         JOIN uniscenario.map_versions mv ON mv.id = r.map_version_id
         JOIN uniscenario.artifacts xosc
           ON xosc.id = ep.xosc_artifact_id AND xosc.workspace_id = ep.workspace_id
          AND xosc.artifact_state = 'available'
         JOIN uniscenario.artifacts xodr
           ON xodr.id = ep.xodr_artifact_id AND xodr.artifact_state = 'available'
         JOIN uniscenario.asset_catalog_versions catalog
           ON catalog.id = ep.asset_catalog_version_id
         JOIN uniscenario.artifacts catalog_artifact
           ON catalog_artifact.id = catalog.manifest_artifact_id
          AND catalog_artifact.artifact_state = 'available'
        WHERE r.workspace_id = :workspace_id AND r.id = :revision_id
          AND ep.id = :execution_package_id
          AND ep.source_input_digest ~ '^[a-f0-9]{64}$'
          AND ep.materialized_traffic_source_input_digest = ep.source_input_digest
          AND ep.materialized_traffic_sha256 = ep.ambient_result_sha256
        LIMIT 1 FOR SHARE OF ep`,
      {
        workspace_id: context.workspaceId,
        revision_id: input.revisionId,
        execution_package_id: input.executionPackageId,
      },
    );
    if (!lineage) return null;
    const intent = buildIntent(input, lineage);
    const intentSha256 = canonicalJsonSha256(intent);
    const controlSha256 = canonicalJsonSha256({
      schema: "uniscenario.render-control-lineage/v1",
      intentSha256,
      executionPackageId: lineage.execution_package_id,
      sourceInputDigest: lineage.source_input_digest,
    });
    const rows = await tx.queryRows<InsertedJob>(
      `INSERT INTO uniscenario.render_jobs (
         id, workspace_id, revision_id, execution_package_id, execution_package_control_sha256,
         render_spec, render_spec_sha256, render_intent, intent_sha256, renderer_engine,
         parity_thresholds, resource_request, request_contract_version,
         job_mode, billing_mode, estimated_cost_cents, priority, idempotency_key, requested_by_user_id
       ) VALUES (
         :id, :workspace_id, :revision_id, :execution_package_id, :control_sha256,
         CAST(:render_spec AS jsonb), :render_spec_sha256, CAST(:render_intent AS jsonb), :intent_sha256, :renderer_engine,
         CAST(:parity_thresholds AS jsonb), CAST(:resource_request AS jsonb), :request_contract_version,
         :job_mode, 'free', 0, :priority, :idempotency_key, :user_id
       )
       RETURNING id, revision_id, execution_package_id, job_mode, job_state, progress,
                 created_at::text AS created_at, updated_at::text AS updated_at`,
      {
        id: uniscenarioId("usrj"),
        workspace_id: context.workspaceId,
        revision_id: input.revisionId,
        execution_package_id: input.executionPackageId,
        control_sha256: controlSha256,
        render_spec: renderSpec,
        render_spec_sha256: canonicalJsonSha256(renderSpec),
        render_intent: intent,
        intent_sha256: intentSha256,
        renderer_engine: input.engine,
        parity_thresholds: input.engine === "carla"
          ? { positionM: 0.5, headingDeg: 2, speedMps: 0.5 }
          : null,
        resource_request: resources,
        request_contract_version: RENDER_INTENT_CONTRACT,
        job_mode: input.engine === "browser" ? "browser_render" : "full_render",
        priority: input.priority ?? 0,
        idempotency_key: input.idempotencyKey,
        user_id: context.userId,
      },
    );
    return rows[0] ?? null;
  });
  if (!inserted) return null;
  return {
    id: inserted.id,
    revisionId: inserted.revision_id,
    executionPackageId: inserted.execution_package_id,
    originRecordingJobId: null,
    mode: inserted.job_mode,
    status: inserted.job_state,
    progress: Number(inserted.progress),
    billingMode: "free",
    estimatedCost: 0,
    renderSpec,
    telemetry: {},
    parityResult: null,
    parityEvidence: null,
    resourceRequest: resources,
    workerAttestation: null,
    failureCode: null,
    failureDetail: null,
    createdAt: inserted.created_at,
    updatedAt: inserted.updated_at,
  };
}
