import { randomBytes } from "node:crypto";
import {
  collectGalleryCatalogIds,
  galleryCatalogEntry,
} from "@/app/lib/asset-gallery/catalog-entry";
import { resolveGalleryCatalogIds } from "@/app/lib/asset-gallery/store";
import { queryRows } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { getPresignedGetUrl, getPresignedPutUrl, headS3Object } from "@/app/lib/s3/s3-presign";
import { sha256, scenarioId } from "./core";
import {
  claimFirstEligibleScenarioJob,
  settlePipelineJob,
  withScenarioJobTransaction,
  type JobTransaction,
} from "./jobs/lifecycle-lock";
import { simforgeEnv } from "@/lib/compat-env";

const OUTPUT_KIND = {
  xosc: "compiled-xosc",
  "capability-report": "compiler-capability-report",
  "compiler-provenance": "compiler-provenance",
  "execution-manifest": "execution-package-manifest",
} as const;

type ClaimRow = {
  export_id: string;
  attempt_id: string;
  fence_token: string;
  expires_at: string;
  compiler_version: string;
  workspace_id: string;
  revision_id: string;
  content_sha256: string;
  canonical_content: string;
  map_version_id: string;
  map_id: string;
  runtime_map_name: string;
  coordinate_system_id: string;
  coordinate_system_sha256: string;
  asset_catalog_version_id: string;
  asset_catalog_manifest_sha256: string;
  sumo_network_sha256: string | null;
  ambient_mode: "disabled" | "native" | "sumo";
  ambient_runtime_version: string | null;
  ambient_sumo_version: string | null;
  ambient_network_sha256: string | null;
  ambient_seed: string | null;
  ambient_config: string;
  ambient_config_sha256: string;
  ambient_result_sha256: string;
  materialized_traffic_artifact_id: string;
  materialized_traffic_sha256: string;
  materialized_traffic_size_bytes: number;
  materialized_traffic_source_input_digest: string;
  traffic_bucket: string;
  traffic_key: string;
};

type MapArtifactRow = {
  id: string;
  artifact_kind: string;
  media_type: string;
  storage_bucket: string;
  storage_key: string;
  sha256: string;
  byte_length: number;
};

type CompilerArtifactRow = {
  id: string;
  artifact_kind: string;
  storage_bucket: string;
  storage_key: string;
  sha256: string;
  byte_length: number;
};

type CompilerCompletionArtifact = {
  id: string;
  kind: keyof typeof OUTPUT_KIND;
  sha256: string;
  sizeBytes: number;
};

function validateCompilerArtifactClosure(rows: CompilerArtifactRow[], declaredArtifacts: CompilerCompletionArtifact[]) {
  const expectedKinds = new Set(Object.keys(OUTPUT_KIND) as Array<keyof typeof OUTPUT_KIND>);
  if (rows.length !== expectedKinds.size || declaredArtifacts.length !== expectedKinds.size || new Set(rows.map((row) => row.id)).size !== expectedKinds.size || new Set(declaredArtifacts.map((artifact) => artifact.id)).size !== expectedKinds.size || new Set(declaredArtifacts.map((artifact) => artifact.kind)).size !== expectedKinds.size) {
    throw new Error("compiler_artifact_closure_incomplete");
  }
  const byKind = new Map<keyof typeof OUTPUT_KIND, CompilerCompletionArtifact>();
  for (const declared of declaredArtifacts) {
    if (!expectedKinds.delete(declared.kind)) throw new Error("compiler_artifact_closure_incomplete");
    const row = rows.find((candidate) => candidate.id === declared.id);
    if (!row || row.artifact_kind !== OUTPUT_KIND[declared.kind] || row.sha256 !== declared.sha256 || Number(row.byte_length) !== declared.sizeBytes) {
      throw new Error("compiler_artifact_metadata_mismatch");
    }
    byKind.set(declared.kind, declared);
  }
  if (expectedKinds.size !== 0) throw new Error("compiler_artifact_closure_incomplete");
  return byKind;
}

function artifactBucket() { return simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts"; }

async function insertCompilerEvent(
  tx: JobTransaction,
  input: {
    workspaceId: string;
    jobId: string;
    attemptId?: string | null;
    type: string;
    payload?: Record<string, unknown>;
  },
) {
  await tx.execute(
    `INSERT INTO simforge.operational_job_events (
       id, workspace_id, job_family, job_id, attempt_id,
       event_ordinal, event_type, event_payload
     ) SELECT :id, :workspace_id, 'openscenario_compile', :job_id, :attempt_id,
              COALESCE(MAX(event_ordinal), 0) + 1, :event_type, CAST(:payload AS jsonb)
         FROM simforge.operational_job_events
        WHERE job_family = 'openscenario_compile' AND job_id = :job_id`,
    {
      id: scenarioId("usoe"),
      workspace_id: input.workspaceId,
      job_id: input.jobId,
      attempt_id: input.attemptId ?? null,
      event_type: input.type,
      payload: input.payload ?? {},
    },
  );
}

async function expireCompilerAttempts() {
  const candidates = await queryRows<{ id: string }>(
    `SELECT e.id FROM simforge.exports e
      WHERE e.export_state = 'running' AND (
        EXISTS (
          SELECT 1 FROM simforge.export_attempts attempt
           WHERE attempt.export_id = e.id AND attempt.attempt_state = 'active'
             AND attempt.expires_at <= NOW()
        ) OR NOT EXISTS (
          SELECT 1 FROM simforge.export_attempts attempt
           WHERE attempt.export_id = e.id AND attempt.attempt_state = 'active'
        )
      ) ORDER BY e.updated_at, e.id LIMIT 100`,
  );
  for (const candidate of candidates) {
    await withScenarioJobTransaction(candidate.id, async (tx) => {
      const expiredAttempt = await tx.queryOne<{ id: string }>(
        `UPDATE simforge.export_attempts attempt
         SET attempt_state = CASE WHEN job.cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'expired' END,
             completed_at = NOW(),
             failure_code = CASE WHEN job.cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE failure_code END
         FROM simforge.exports job
         WHERE job.id = :export_id AND attempt.export_id = job.id AND attempt.attempt_state = 'active'
           AND attempt.expires_at <= NOW()
         RETURNING attempt.id`,
        { export_id: candidate.id },
      );
      const terminalized = await tx.queryOne<{
        id: string;
        workspace_id: string;
        state: "queued" | "failed" | "cancelled";
      }>(
        `UPDATE simforge.exports e SET
           export_state = CASE
             WHEN e.cancel_requested_at IS NOT NULL THEN 'cancelled'
             WHEN e.attempt_count < e.max_attempts THEN 'queued'
             ELSE 'failed'
           END,
           error_code = CASE
             WHEN e.cancel_requested_at IS NOT NULL THEN COALESCE(e.error_code, 'cancelled')
             WHEN e.attempt_count < e.max_attempts THEN NULL
             ELSE 'compiler_attempts_exhausted'
           END,
           completed_at = CASE
             WHEN e.cancel_requested_at IS NOT NULL OR e.attempt_count >= e.max_attempts THEN COALESCE(e.completed_at, NOW())
             ELSE NULL
           END,
           updated_at = NOW()
         WHERE e.id = :export_id AND e.export_state = 'running' AND NOT EXISTS (
           SELECT 1 FROM simforge.export_attempts a
           WHERE a.export_id = e.id AND a.attempt_state = 'active'
         )
         RETURNING e.id, e.workspace_id, e.export_state AS state`,
        { export_id: candidate.id },
      );
      if (!terminalized) return;
      await insertCompilerEvent(tx, {
        workspaceId: terminalized.workspace_id,
        jobId: terminalized.id,
        attemptId: expiredAttempt?.id,
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
          jobFamily: "openscenario_compile",
          jobId: terminalized.id,
          outcome: terminalized.state,
        });
      }
    });
  }
}

export async function claimCompilerExport(input: { workerId: string; leaseSeconds: number }) {
  await expireCompilerAttempts();
  const candidates = await queryRows<{ id: string }>(
    `SELECT e.id
       FROM simforge.exports e
       JOIN simforge.revisions r ON r.id = e.revision_id AND r.workspace_id = e.workspace_id
       JOIN simforge.map_versions mv ON mv.id = r.map_version_id
       JOIN public.map_assets ma ON ma.id = mv.source_map_asset_id
       JOIN simforge.asset_catalog_versions acv
         ON acv.id = mv.asset_catalog_version_id
        AND (acv.workspace_id IS NULL OR acv.workspace_id = mv.workspace_id)
       JOIN simforge.artifacts ta ON ta.id = e.materialized_traffic_artifact_id
         AND ta.workspace_id = e.workspace_id AND ta.artifact_state = 'available'
      WHERE e.export_state = 'queued' AND e.cancel_requested_at IS NULL
        AND e.attempt_count < e.max_attempts
        AND mv.xodr_artifact_id IS NOT NULL AND mv.topology_artifact_id IS NOT NULL
        AND mv.derived_topology_artifact_id IS NOT NULL AND mv.locations_artifact_id IS NOT NULL
        AND mv.signals_artifact_id IS NOT NULL
        AND acv.contract_version = 'uniscenario.asset-catalog/v1'
        AND NULLIF(BTRIM(mv.source_map_asset_id), '') IS NOT NULL
        AND COALESCE(
          NULLIF(BTRIM(ma.ue5_carla_map_name), ''),
          NULLIF(BTRIM(ma.carla_map_name), '')
        ) IS NOT NULL
        AND e.ambient_mode IN ('disabled', 'native', 'sumo')
        AND e.ambient_config_sha256 IS NOT NULL AND e.ambient_result_sha256 IS NOT NULL
        AND e.materialized_traffic_sha256 = e.ambient_result_sha256
        AND e.materialized_traffic_source_input_digest ~ '^[a-f0-9]{64}$'
        AND (e.ambient_mode <> 'sumo' OR (
          e.ambient_sumo_version IS NOT NULL AND e.ambient_network_sha256 IS NOT NULL
          AND e.ambient_network_sha256 = mv.sumo_network_sha256 AND e.ambient_seed IS NOT NULL
        ))
      ORDER BY e.created_at, e.id LIMIT 16`,
  );
  const claimed = await claimFirstEligibleScenarioJob(
    candidates,
    (candidate) => candidate.id,
    async (tx, candidate) => {
      const fenceToken = randomBytes(32).toString("hex");
      const attemptId = scenarioId("uscexat");
    const source = await tx.queryOne<
      Omit<ClaimRow, "attempt_id" | "fence_token" | "expires_at"> & {
        attempt_count: number;
      }
    >(
      `SELECT e.id AS export_id, e.compiler_version, e.workspace_id, r.id AS revision_id,
         r.content_sha256, r.canonical_content::text AS canonical_content,
         r.map_version_id, mv.source_map_asset_id AS map_id,
         COALESCE(
           NULLIF(BTRIM(ma.ue5_carla_map_name), ''),
           NULLIF(BTRIM(ma.carla_map_name), '')
         ) AS runtime_map_name,
         mv.coordinate_system_id,
         mv.coordinate_system_sha256, mv.asset_catalog_version_id,
         acv.manifest_sha256 AS asset_catalog_manifest_sha256, mv.sumo_network_sha256,
         e.ambient_mode, e.ambient_runtime_version, e.ambient_sumo_version,
         e.ambient_network_sha256, e.ambient_seed, e.ambient_config::text AS ambient_config,
         e.ambient_config_sha256, e.ambient_result_sha256,
         e.materialized_traffic_artifact_id, e.materialized_traffic_sha256,
         e.materialized_traffic_size_bytes, e.materialized_traffic_source_input_digest,
         ta.storage_bucket AS traffic_bucket, ta.storage_key AS traffic_key, e.attempt_count
       FROM simforge.exports e
       JOIN simforge.revisions r ON r.id = e.revision_id AND r.workspace_id = e.workspace_id
       JOIN simforge.map_versions mv ON mv.id = r.map_version_id
       JOIN public.map_assets ma ON ma.id = mv.source_map_asset_id
       JOIN simforge.asset_catalog_versions acv
         ON acv.id = mv.asset_catalog_version_id
        AND (acv.workspace_id IS NULL OR acv.workspace_id = mv.workspace_id)
       JOIN simforge.artifacts ta ON ta.id = e.materialized_traffic_artifact_id
         AND ta.workspace_id = e.workspace_id AND ta.artifact_state = 'available'
       WHERE e.id = :export_id AND e.export_state = 'queued' AND e.cancel_requested_at IS NULL
         AND e.attempt_count < e.max_attempts
         AND mv.xodr_artifact_id IS NOT NULL AND mv.topology_artifact_id IS NOT NULL
         AND mv.derived_topology_artifact_id IS NOT NULL AND mv.locations_artifact_id IS NOT NULL
         AND mv.signals_artifact_id IS NOT NULL AND acv.contract_version = 'uniscenario.asset-catalog/v1'
         AND NULLIF(BTRIM(mv.source_map_asset_id), '') IS NOT NULL
         AND COALESCE(
           NULLIF(BTRIM(ma.ue5_carla_map_name), ''),
           NULLIF(BTRIM(ma.carla_map_name), '')
         ) IS NOT NULL
         AND e.ambient_mode IN ('disabled', 'native', 'sumo')
         AND e.ambient_config_sha256 IS NOT NULL AND e.ambient_result_sha256 IS NOT NULL
         AND e.materialized_traffic_sha256 = e.ambient_result_sha256
         AND e.materialized_traffic_source_input_digest ~ '^[a-f0-9]{64}$'
         AND (e.ambient_mode <> 'sumo' OR (
           e.ambient_sumo_version IS NOT NULL AND e.ambient_network_sha256 IS NOT NULL
           AND e.ambient_network_sha256 = mv.sumo_network_sha256 AND e.ambient_seed IS NOT NULL
         ))
       FOR UPDATE OF e`,
      { export_id: candidate.id },
    );
    if (!source) return null;
    const expiry = await tx.queryOne<{ expires_at: string }>(
      `SELECT to_char(
         (NOW() + (:lease_seconds * INTERVAL '1 second')) AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) AS expires_at`,
      { lease_seconds: input.leaseSeconds },
    );
    if (!expiry) throw new Error("Unable to compute compiler lease expiry.");
    await tx.execute(
      `INSERT INTO simforge.export_attempts (
         id, workspace_id, export_id, attempt_number, worker_id, fence_token_sha256, expires_at
       ) VALUES (
         :id, :workspace_id, :export_id, :attempt_number, :worker_id, :fence_token_sha256,
         CAST(:expires_at AS timestamptz)
       )`,
      {
        id: attemptId,
        workspace_id: source.workspace_id,
        export_id: source.export_id,
        attempt_number: Number(source.attempt_count) + 1,
        worker_id: input.workerId,
        fence_token_sha256: sha256(fenceToken),
        expires_at: expiry.expires_at,
      },
    );
    const advanced = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.exports SET export_state = 'running', attempt_count = attempt_count + 1,
         started_at = COALESCE(started_at, NOW()), updated_at = NOW(), error_code = NULL, error_detail = NULL
       WHERE id = :export_id AND export_state = 'queued' AND cancel_requested_at IS NULL
       RETURNING id`,
      { export_id: source.export_id },
    );
    if (!advanced) throw new Error("compiler_claim_fence_failed");
    await insertCompilerEvent(tx, {
      workspaceId: source.workspace_id,
      jobId: source.export_id,
      attemptId,
      type: "leased",
      payload: { workerId: input.workerId },
    });
    return {
      ...source,
      attempt_id: attemptId,
      fence_token: fenceToken,
      expires_at: expiry.expires_at,
    } satisfies ClaimRow;
    },
  );
  if (!claimed) return null;
  const attemptId = claimed.attempt_id;
  const fenceToken = claimed.fence_token;
  const artifacts = await queryRows<MapArtifactRow>(
    `SELECT a.id, a.artifact_kind, a.media_type, a.storage_bucket, a.storage_key,
       a.sha256, a.byte_length
     FROM simforge.map_versions mv
     JOIN simforge.asset_catalog_versions acv
       ON acv.id = mv.asset_catalog_version_id AND acv.workspace_id = mv.workspace_id
     CROSS JOIN LATERAL unnest(ARRAY[
       mv.xodr_artifact_id, mv.topology_artifact_id, mv.derived_topology_artifact_id,
       mv.locations_artifact_id, mv.signals_artifact_id, acv.manifest_artifact_id
     ]) WITH ORDINALITY AS ids(artifact_id, ordinal)
     JOIN simforge.artifacts a ON a.id = ids.artifact_id
       AND a.workspace_id = mv.workspace_id AND a.artifact_state = 'available'
     WHERE mv.id = :map_version_id
     ORDER BY ids.ordinal`,
    { map_version_id: claimed.map_version_id },
  );
  if (artifacts.length !== 6) {
    await failCompilerExport(claimed.export_id, {
      attemptId,
      fenceToken,
      code: "map_closure_incomplete",
      detail: {},
    });
    throw new Error("Scenario map compiler closure is incomplete.");
  }
  const kinds = ["map-xodr", "map-topology", "map-derived-topology", "map-locations", "map-signals", "asset-catalog"] as const;
  const canonicalContent = parseJsonObject(claimed.canonical_content);
  const gallery = await resolveGalleryCatalogIds(collectGalleryCatalogIds(canonicalContent));
  return {
    contract: "uniscenario.compiler-claim/v1" as const,
    exportId: claimed.export_id,
    attemptId,
    fenceToken,
    leaseExpiresAt: claimed.expires_at,
    compilerVersion: claimed.compiler_version,
    revision: {
      id: claimed.revision_id,
      contentSha256: claimed.content_sha256,
      canonicalContent,
      mapVersionId: claimed.map_version_id,
    },
    catalogEntries: gallery.entries.map(galleryCatalogEntry),
    map: {
      id: claimed.map_version_id,
      sourceMapId: claimed.map_id,
      runtimeMapName: claimed.runtime_map_name,
      coordinateSystemId: claimed.coordinate_system_id,
      coordinateSystemSha256: claimed.coordinate_system_sha256,
      assetCatalogVersionId: claimed.asset_catalog_version_id,
      assetCatalogManifestSha256: claimed.asset_catalog_manifest_sha256,
      sumoNetworkSha256: claimed.sumo_network_sha256,
      artifacts: await Promise.all(
        artifacts.map(async (artifact, index) => ({
          id: artifact.id,
          kind: kinds[index]!,
          mediaType: artifact.media_type,
          sha256: artifact.sha256,
          sizeBytes: Number(artifact.byte_length),
          downloadUrl: await getPresignedGetUrl(artifact.storage_key, artifact.storage_bucket),
        })),
      ),
    },
    ambient:
      claimed.ambient_mode === "disabled"
        ? {
            mode: "disabled" as const,
            ambientConfig: parseJsonObject(claimed.ambient_config),
            configSha256: claimed.ambient_config_sha256,
            resultSha256: claimed.ambient_result_sha256,
            materializedTraffic: {
              artifactId: claimed.materialized_traffic_artifact_id,
              sha256: claimed.materialized_traffic_sha256,
              sizeBytes: Number(claimed.materialized_traffic_size_bytes),
              sourceInputDigest: claimed.materialized_traffic_source_input_digest,
              mapAssetId: claimed.map_id,
              mapVersionId: claimed.map_version_id,
            },
          }
        : claimed.ambient_mode === "native"
          ? {
              mode: "native" as const,
              runtimeVersion: claimed.ambient_runtime_version!,
              seed: claimed.ambient_seed!,
              ambientConfig: parseJsonObject(claimed.ambient_config),
              configSha256: claimed.ambient_config_sha256,
              resultSha256: claimed.ambient_result_sha256,
              materializedTraffic: {
                artifactId: claimed.materialized_traffic_artifact_id,
                sha256: claimed.materialized_traffic_sha256,
                sizeBytes: Number(claimed.materialized_traffic_size_bytes),
                sourceInputDigest: claimed.materialized_traffic_source_input_digest,
                mapAssetId: claimed.map_id,
                mapVersionId: claimed.map_version_id,
              },
            }
          : {
              mode: "sumo" as const,
              sumoVersion: claimed.ambient_sumo_version!,
              networkSha256: claimed.ambient_network_sha256!,
              seed: claimed.ambient_seed!,
              ambientConfig: parseJsonObject(claimed.ambient_config),
              configSha256: claimed.ambient_config_sha256,
              resultSha256: claimed.ambient_result_sha256,
              materializedTraffic: {
                artifactId: claimed.materialized_traffic_artifact_id,
                sha256: claimed.materialized_traffic_sha256,
                sizeBytes: Number(claimed.materialized_traffic_size_bytes),
                sourceInputDigest: claimed.materialized_traffic_source_input_digest,
                mapAssetId: claimed.map_id,
                mapVersionId: claimed.map_version_id,
              },
            },
  };
}

async function activeAttempt(exportId: string, attemptId: string, fenceToken: string) {
  const rows = await queryRows<{ id: string }>(
    `SELECT attempt.id FROM simforge.export_attempts attempt
       JOIN simforge.exports job ON job.id = attempt.export_id
     WHERE attempt.id = :attempt_id AND attempt.export_id = :export_id
       AND attempt.attempt_state = 'active' AND attempt.expires_at > NOW()
       AND attempt.fence_token_sha256 = :fence_token_sha256
       AND job.export_state = 'running' AND job.cancel_requested_at IS NULL LIMIT 1`,
    {
      attempt_id: attemptId,
      export_id: exportId,
      fence_token_sha256: sha256(fenceToken),
    },
  );
  return rows.length > 0;
}

export async function heartbeatCompilerExport(exportId: string, input: { attemptId: string; fenceToken: string; leaseSeconds: number }) {
  return withScenarioJobTransaction(exportId, async (tx) => {
    const rows = await tx.queryRows<{ expires_at: string }>(
      `UPDATE simforge.export_attempts attempt SET heartbeat_at = NOW(),
         expires_at = NOW() + (:lease_seconds * INTERVAL '1 second')
       FROM simforge.exports job
       WHERE attempt.id = :attempt_id AND attempt.export_id = :export_id
         AND attempt.attempt_state = 'active' AND attempt.expires_at > NOW()
         AND attempt.fence_token_sha256 = :fence_token_sha256
         AND job.id = attempt.export_id AND job.export_state = 'running'
         AND job.cancel_requested_at IS NULL
       RETURNING to_char(
         attempt.expires_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) AS expires_at`,
      {
        attempt_id: input.attemptId,
        export_id: exportId,
        lease_seconds: input.leaseSeconds,
        fence_token_sha256: sha256(input.fenceToken),
      },
    );
    return rows[0] ?? null;
  });
}

export async function reserveCompilerOutputs(
  exportId: string,
  input: {
    attemptId: string;
    fenceToken: string;
    artifacts: Array<{
      kind: keyof typeof OUTPUT_KIND;
      mediaType: string;
      sha256: string;
      sizeBytes: number;
    }>;
  },
) {
  const bucket = artifactBucket();
  const reserved = await withScenarioJobTransaction(exportId, async (tx) => {
    const owner = await tx.queryOne<{ workspace_id: string; revision_id: string }>(
      `SELECT job.workspace_id, job.revision_id
         FROM simforge.exports job
         JOIN simforge.export_attempts attempt ON attempt.export_id = job.id
        WHERE job.id = :export_id AND job.export_state = 'running'
          AND job.cancel_requested_at IS NULL
          AND attempt.id = :attempt_id AND attempt.attempt_state = 'active'
          AND attempt.expires_at > NOW()
          AND attempt.fence_token_sha256 = :fence_token_sha256`,
      {
        export_id: exportId,
        attempt_id: input.attemptId,
        fence_token_sha256: sha256(input.fenceToken),
      },
    );
    if (!owner) return null;
    const reservations: Array<{
      row: { id: string; artifact_state: string; storage_bucket: string; storage_key: string };
      item: (typeof input.artifacts)[number];
    }> = [];
    for (const item of input.artifacts) {
      const artifactKind = OUTPUT_KIND[item.kind];
      const key = `${owner.workspace_id}/compiler/sha256/${item.sha256}/${artifactKind}`;
      const rows = await tx.queryRows<{
        id: string;
        artifact_state: string;
        storage_bucket: string;
        storage_key: string;
      }>(
        `INSERT INTO simforge.artifacts (
         id, workspace_id, revision_id, artifact_kind, media_type, storage_bucket,
         storage_key, sha256, byte_length, artifact_state, metadata,
         producer_job_family, producer_job_id, producer_attempt_id, provenance
       ) VALUES (
         :id, :workspace_id, :revision_id, :artifact_kind, :media_type, :bucket,
         :storage_key, :sha256, :byte_length, 'pending', CAST(:metadata AS jsonb),
         'openscenario_compile', :export_id, :attempt_id, CAST(:provenance AS jsonb)
       ) ON CONFLICT (workspace_id, sha256, artifact_kind)
         WHERE artifact_state IN ('pending', 'available') AND deleted_at IS NULL
       DO UPDATE SET sha256 = EXCLUDED.sha256
        RETURNING id, artifact_state, storage_bucket, storage_key`,
        {
          id: scenarioId("usart"),
          workspace_id: owner.workspace_id,
          revision_id: owner.revision_id,
          artifact_kind: artifactKind,
          media_type: item.mediaType,
          bucket,
          storage_key: key,
          sha256: item.sha256,
          byte_length: item.sizeBytes,
          metadata: { exportId, compilerAttemptId: input.attemptId },
          export_id: exportId,
          attempt_id: input.attemptId,
          provenance: {
            contract: "uniscenario.artifact-provenance/v1",
            producerJobFamily: "openscenario_compile",
            producerJobId: exportId,
            producerAttemptId: input.attemptId,
          },
        },
      );
      const row = rows[0];
      if (!row) throw new Error("Compiler artifact reservation failed.");
      await tx.execute(
        `INSERT INTO simforge.operational_job_artifact_links (
         id, workspace_id, artifact_id, job_family, job_id, attempt_id, relationship
       ) VALUES (
         :id, :workspace_id, :artifact_id, 'openscenario_compile', :job_id, :attempt_id,
         CASE WHEN :artifact_kind = 'compiler-provenance' THEN 'provenance' ELSE 'output' END
       ) ON CONFLICT DO NOTHING RETURNING id`,
        {
          id: scenarioId("usjal"),
          workspace_id: owner.workspace_id,
          artifact_id: row.id,
          job_id: exportId,
          attempt_id: input.attemptId,
          artifact_kind: artifactKind,
        },
      );
      reservations.push({ row, item });
    }
    return reservations;
  });
  if (!reserved) return null;
  return Promise.all(reserved.map(async ({ row, item }) => ({
    id: row.id,
    kind: item.kind,
    uploadRequired: row.artifact_state !== "available",
    uploadUrl: row.artifact_state === "available"
      ? null
      : await getPresignedPutUrl(row.storage_key, item.mediaType, row.storage_bucket, 900, item.sha256),
  })));
}

export async function completeCompilerExport(
  exportId: string,
  input: {
    attemptId: string;
    fenceToken: string;
    artifacts: CompilerCompletionArtifact[];
    manifestSha256: string;
    xsdSha256: string;
    sourceInputDigest: string;
  },
) {
  if (!(await activeAttempt(exportId, input.attemptId, input.fenceToken))) return null;
  const rows = await queryRows<CompilerArtifactRow>(
    `SELECT a.id, a.artifact_kind, a.storage_bucket, a.storage_key, a.sha256, a.byte_length
     FROM simforge.operational_job_artifact_links l
     JOIN simforge.artifacts a
       ON a.id = l.artifact_id AND a.workspace_id = l.workspace_id
     JOIN simforge.exports e
       ON e.id = l.job_id AND e.workspace_id = l.workspace_id
     WHERE l.job_family = 'openscenario_compile'
       AND l.job_id = :export_id
       AND l.attempt_id = :attempt_id
       AND a.id = ANY(string_to_array(:artifact_ids, ','))`,
    {
      export_id: exportId,
      attempt_id: input.attemptId,
      artifact_ids: input.artifacts.map((item) => item.id).join(","),
    },
  );
  validateCompilerArtifactClosure(rows, input.artifacts);
  const verifiedUploads = new Map<string, CompilerArtifactRow>();
  for (const row of rows) {
    const declared = input.artifacts.find((item) => item.id === row.id)!;
    const head = await headS3Object(row.storage_key, row.storage_bucket);
    const checksum = head.checksumSha256 ? Buffer.from(head.checksumSha256, "base64").toString("hex") : null;
    if (head.contentLength !== declared.sizeBytes || checksum !== declared.sha256) throw new Error("compiler_artifact_upload_mismatch");
    verifiedUploads.set(row.id, row);
  }
  return withScenarioJobTransaction(exportId, async (tx) => {
    const locked = await tx.queryOne<{
      workspace_id: string;
      revision_id: string;
      compiler_version: string;
      xodr_artifact_id: string;
      asset_catalog_version_id: string;
      ambient_mode: "disabled" | "native" | "sumo";
      ambient_runtime_version: string | null;
      ambient_sumo_version: string | null;
      ambient_network_sha256: string | null;
      ambient_seed: string | null;
      ambient_config: Record<string, unknown>;
      ambient_config_sha256: string;
      ambient_result_sha256: string;
      materialized_traffic_artifact_id: string;
      materialized_traffic_sha256: string;
      materialized_traffic_source_input_digest: string;
    }>(
      `SELECT e.workspace_id, e.revision_id, e.compiler_version, mv.xodr_artifact_id,
         mv.asset_catalog_version_id,
         e.ambient_mode, e.ambient_runtime_version, e.ambient_sumo_version,
         e.ambient_network_sha256, e.ambient_seed, e.ambient_config,
         e.ambient_config_sha256, e.ambient_result_sha256,
         e.materialized_traffic_artifact_id, e.materialized_traffic_sha256,
         e.materialized_traffic_source_input_digest
       FROM simforge.exports e JOIN simforge.revisions r
         ON r.id = e.revision_id AND r.workspace_id = e.workspace_id
       JOIN simforge.map_versions mv ON mv.id = r.map_version_id
       JOIN simforge.export_attempts a ON a.export_id = e.id
       WHERE e.id = :export_id AND e.export_state = 'running' AND a.id = :attempt_id
         AND a.attempt_state = 'active' AND a.expires_at > NOW()
         AND e.cancel_requested_at IS NULL
         AND a.fence_token_sha256 = :fence_token_sha256
       FOR UPDATE OF e, a`,
      {
        export_id: exportId,
        attempt_id: input.attemptId,
        fence_token_sha256: sha256(input.fenceToken),
      },
    );
    if (!locked) return null;
    const lockedArtifacts = await tx.queryRows<CompilerArtifactRow>(
      `SELECT a.id, a.artifact_kind, a.storage_bucket, a.storage_key, a.sha256, a.byte_length
       FROM simforge.operational_job_artifact_links l
       JOIN simforge.artifacts a
         ON a.id = l.artifact_id AND a.workspace_id = l.workspace_id
       WHERE l.job_family = 'openscenario_compile'
         AND l.job_id = :export_id
         AND l.attempt_id = :attempt_id
         AND a.id = ANY(string_to_array(:artifact_ids, ','))
       FOR UPDATE OF a, l`,
      {
        export_id: exportId,
        attempt_id: input.attemptId,
        artifact_ids: input.artifacts.map((item) => item.id).join(","),
      },
    );
    const byKind = validateCompilerArtifactClosure(lockedArtifacts, input.artifacts);
    for (const row of lockedArtifacts) {
      const verified = verifiedUploads.get(row.id);
      if (!verified || verified.storage_bucket !== row.storage_bucket || verified.storage_key !== row.storage_key || verified.sha256 !== row.sha256 || Number(verified.byte_length) !== Number(row.byte_length)) {
        throw new Error("compiler_artifact_metadata_mismatch");
      }
    }
    const xosc = byKind.get("xosc")!;
    const manifest = byKind.get("execution-manifest")!;
    if (manifest.sha256 !== input.manifestSha256) {
      throw new Error("execution_manifest_digest_mismatch");
    }
    if (locked.materialized_traffic_source_input_digest !== input.sourceInputDigest) {
      throw new Error("materialized_traffic_source_input_digest_mismatch");
    }
    await tx.execute(
      `UPDATE simforge.artifacts a SET artifact_state = 'available', verified_at = NOW()
       WHERE a.id = ANY(string_to_array(:artifact_ids, ','))
         AND EXISTS (
           SELECT 1 FROM simforge.operational_job_artifact_links l
           WHERE l.artifact_id = a.id AND l.workspace_id = a.workspace_id
             AND l.job_family = 'openscenario_compile'
             AND l.job_id = :export_id AND l.attempt_id = :attempt_id
         )`,
      {
        artifact_ids: input.artifacts.map((item) => item.id).join(","),
        export_id: exportId,
        attempt_id: input.attemptId,
      },
    );
    const insertedPackage = await tx.queryOne<{ id: string }>(
      `INSERT INTO simforge.execution_packages AS existing (
         id, workspace_id, revision_id, xosc_artifact_id, xodr_artifact_id,
         asset_catalog_version_id, package_artifact_id,
         manifest_sha256, xsd_sha256, ambient_mode, ambient_runtime_version,
         ambient_sumo_version, ambient_network_sha256, ambient_seed, ambient_config,
         ambient_config_sha256, ambient_result_sha256,
         materialized_traffic_artifact_id, materialized_traffic_sha256,
         materialized_traffic_source_input_digest,
         runtime_contract_version, compiler_version, capability_profile, source_input_digest
       ) VALUES (
         :id, :workspace_id, :revision_id, :xosc_artifact_id, :xodr_artifact_id,
         :asset_catalog_version_id, :package_artifact_id,
         :manifest_sha256, :xsd_sha256, :ambient_mode, :ambient_runtime_version,
         :ambient_sumo_version, :ambient_network_sha256, :ambient_seed, CAST(:ambient_config AS jsonb),
         :ambient_config_sha256, :ambient_result_sha256,
         :materialized_traffic_artifact_id, :materialized_traffic_sha256,
         :materialized_traffic_source_input_digest,
         'uniscenario.execution-package/v1', :compiler_version, 'xml-1.4-trajectory-replay', :source_input_digest
       ) ON CONFLICT (workspace_id, revision_id, manifest_sha256)
       DO UPDATE SET manifest_sha256 = EXCLUDED.manifest_sha256
       WHERE existing.source_input_digest = EXCLUDED.source_input_digest
       RETURNING id`,
      {
        id: scenarioId("usepkg"),
        workspace_id: locked.workspace_id,
        revision_id: locked.revision_id,
        xosc_artifact_id: xosc.id,
        xodr_artifact_id: locked.xodr_artifact_id,
        asset_catalog_version_id: locked.asset_catalog_version_id,
        package_artifact_id: manifest.id,
        manifest_sha256: input.manifestSha256,
        xsd_sha256: input.xsdSha256,
        compiler_version: locked.compiler_version,
        source_input_digest: input.sourceInputDigest,
        ambient_mode: locked.ambient_mode,
        ambient_runtime_version: locked.ambient_runtime_version,
        ambient_sumo_version: locked.ambient_sumo_version,
        ambient_network_sha256: locked.ambient_network_sha256,
        ambient_seed: locked.ambient_seed,
        ambient_config: locked.ambient_config,
        ambient_config_sha256: locked.ambient_config_sha256,
        ambient_result_sha256: locked.ambient_result_sha256,
        materialized_traffic_artifact_id: locked.materialized_traffic_artifact_id,
        materialized_traffic_sha256: locked.materialized_traffic_sha256,
        materialized_traffic_source_input_digest: locked.materialized_traffic_source_input_digest,
      },
    );
    if (!insertedPackage) throw new Error("execution_package_finalize_failed");
    await tx.execute(
      `UPDATE simforge.exports SET export_state = 'succeeded', progress = 1, artifact_id = :artifact_id,
         execution_package_id = :package_id, completed_at = NOW(), updated_at = NOW()
       WHERE id = :export_id`,
      {
        artifact_id: xosc.id,
        package_id: insertedPackage.id,
        export_id: exportId,
      },
    );
    await tx.execute(
      `UPDATE simforge.export_attempts SET attempt_state = 'succeeded', completed_at = NOW()
       WHERE id = :attempt_id`,
      { attempt_id: input.attemptId },
    );
    await insertCompilerEvent(tx, {
      workspaceId: locked.workspace_id,
      jobId: exportId,
      attemptId: input.attemptId,
      type: "completed",
      payload: {
        executionPackageId: insertedPackage.id,
        artifactId: xosc.id,
        manifestSha256: input.manifestSha256,
      },
    });
    return { executionPackageId: insertedPackage.id, artifactId: xosc.id };
  });
}

export async function failCompilerExport(
  exportId: string,
  input: {
    attemptId: string;
    fenceToken: string;
    code: string;
    detail: Record<string, unknown>;
  },
) {
  return withScenarioJobTransaction(exportId, async (tx) => {
    const current = await tx.queryOne<{ retry: boolean; workspace_id: string }>(
      `SELECT (e.attempt_count < e.max_attempts) AS retry, e.workspace_id
       FROM simforge.exports e JOIN simforge.export_attempts a ON a.export_id = e.id
       WHERE e.id = :export_id AND a.id = :attempt_id AND a.attempt_state = 'active'
         AND a.expires_at > NOW()
         AND e.cancel_requested_at IS NULL
         AND a.fence_token_sha256 = :fence_token_sha256 FOR UPDATE OF e, a`,
      {
        export_id: exportId,
        attempt_id: input.attemptId,
        fence_token_sha256: sha256(input.fenceToken),
      },
    );
    if (!current) return null;
    await tx.execute(
      `UPDATE simforge.export_attempts SET attempt_state = 'failed', completed_at = NOW(),
         failure_code = :code, failure_detail = CAST(:detail AS jsonb) WHERE id = :attempt_id`,
      { attempt_id: input.attemptId, code: input.code, detail: input.detail },
    );
    await tx.execute(
      `UPDATE simforge.exports SET export_state = :state, error_code = :code,
         error_detail = CAST(:detail AS jsonb), completed_at = CASE WHEN :retry THEN NULL ELSE NOW() END,
         updated_at = NOW() WHERE id = :export_id`,
      {
        export_id: exportId,
        state: current.retry ? "queued" : "failed",
        code: input.code,
        detail: input.detail,
        retry: current.retry,
      },
    );
    await insertCompilerEvent(tx, {
      workspaceId: current.workspace_id,
      jobId: exportId,
      attemptId: input.attemptId,
      type: current.retry ? "retry_queued" : "failed",
      payload: { code: input.code },
    });
    return { retryQueued: current.retry };
  });
}

export async function cancelCompilerExport(
  exportId: string,
  input: { attemptId: string; fenceToken: string },
) {
  return withScenarioJobTransaction(exportId, async (tx) => {
    const attempt = await tx.queryOne<{ workspace_id: string }>(
      `SELECT e.workspace_id FROM simforge.exports e
        JOIN simforge.export_attempts a ON a.export_id = e.id
       WHERE e.id = :job_id AND a.id = :attempt_id AND a.attempt_state = 'active'
         AND a.expires_at > NOW() AND a.fence_token_sha256 = :fence_token_sha256
       FOR UPDATE OF e, a`,
      {
        job_id: exportId,
        attempt_id: input.attemptId,
        fence_token_sha256: sha256(input.fenceToken),
      },
    );
    if (!attempt) return null;
    await tx.execute(
      `UPDATE simforge.export_attempts SET attempt_state = 'cancelled', completed_at = NOW(),
         failure_code = 'cancelled' WHERE id = :attempt_id`,
      { attempt_id: input.attemptId },
    );
    await tx.execute(
      `UPDATE simforge.exports SET export_state = 'cancelled', completed_at = NOW(),
         updated_at = NOW(), error_code = 'cancelled' WHERE id = :job_id`,
      { job_id: exportId },
    );
    await insertCompilerEvent(tx, {
      workspaceId: attempt.workspace_id,
      jobId: exportId,
      attemptId: input.attemptId,
      type: "cancelled",
      payload: { code: "cancelled" },
    });
    return { retryQueued: false };
  });
}
