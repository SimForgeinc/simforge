import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows, withTransaction } from "@/app/lib/db/data-api";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedPutUrl,
  headS3Object,
} from "@/app/lib/s3/s3-presign";
import type { UniScenarioMaterializedTrafficReference } from "./contracts";
import { uniscenarioId } from "./core";
import {
  createLocalArtifactProducer,
  finalizeLocalArtifactProducer,
} from "./jobs/local-artifact-producer-store";

const MEDIA_TYPE = "application/vnd.uniscenarios.materialized-traffic+json";

function artifactBucket() { return process.env.UNISCENARIO_ARTIFACT_BUCKET?.trim() || "local-artifacts"; }

export async function reserveMaterializedTraffic(
  context: AppContext,
  documentId: string,
  input: Omit<UniScenarioMaterializedTrafficReference, "artifactId"> & {
    expectedVersion: number;
  },
) {
  const documents = await queryRows<{
    workspace_id: string;
    draft_version: number;
    map_version_id: string | null;
    source_map_asset_id: string | null;
  }>(
    `SELECT d.workspace_id, dr.draft_version, dr.map_version_id, mv.source_map_asset_id
     FROM uniscenario.documents d JOIN uniscenario.drafts dr
       ON dr.document_id = d.id AND dr.workspace_id = d.workspace_id
     JOIN uniscenario.map_versions mv ON mv.id = dr.map_version_id
     WHERE d.id = :document_id AND d.workspace_id = :workspace_id AND d.deleted_at IS NULL LIMIT 1`,
    { document_id: documentId, workspace_id: context.workspaceId },
  );
  const document = documents[0];
  if (
    !document ||
    Number(document.draft_version) !== input.expectedVersion ||
    document.map_version_id !== input.mapVersionId ||
    document.source_map_asset_id !== input.mapAssetId
  )
    return null;
  const bucket = artifactBucket();
  const key = `${context.workspaceId}/materialized-traffic/sha256/${input.sha256}.json`;
  const artifactId = uniscenarioId("usart");
  const producerJobId = await createLocalArtifactProducer({
    workspaceId: context.workspaceId,
    requestedByUserId: context.userId,
    operation: "materialize_traffic",
    artifactKind: "materialized-traffic",
    artifactSha256: input.sha256,
    requestPayload: {
      documentId,
      draftVersion: input.expectedVersion,
      sourceInputDigest: input.sourceInputDigest,
      mapVersionId: input.mapVersionId,
    },
  });
  const rows = await queryRows<{
    id: string;
    artifact_state: string;
    storage_bucket: string;
    storage_key: string;
  }>(
    // The conflict target is (workspace_id, sha256, artifact_kind) — content, not
    // document — so two documents whose traffic hashes the same share one row, yet
    // the row carries per-RESERVATION facts (`metadata.documentId`, `producer_job_id`).
    // Refreshing them on conflict is what lets `completeMaterializedTraffic` match
    // the caller's document instead of 404ing against another reservation's
    // metadata; the producer fields may only move while the row is still `pending`
    // (`uniscenario_artifacts_finalized_provenance_immutable` freezes them after).
    // Same disease and cure as `reserveSimulationPreview`. `artifact_state` is
    // deliberately not reset: uploaded bytes stay uploaded, so `uploadRequired`
    // can skip the redundant PUT.
    `INSERT INTO uniscenario.artifacts (
       id, workspace_id, artifact_kind, media_type, storage_bucket, storage_key,
       sha256, byte_length, artifact_state, metadata,
       producer_job_family, producer_job_id, provenance
     ) VALUES (
       :id, :workspace_id, 'materialized-traffic', :media_type, :bucket, :storage_key,
       :sha256, :size_bytes, 'pending', CAST(:metadata AS jsonb),
       'artifact_postprocess', :producer_job_id, CAST(:provenance AS jsonb)
     ) ON CONFLICT (workspace_id, sha256, artifact_kind)
     DO UPDATE SET
       metadata = EXCLUDED.metadata,
       producer_job_id = CASE WHEN uniscenario.artifacts.artifact_state = 'pending'
         THEN EXCLUDED.producer_job_id ELSE uniscenario.artifacts.producer_job_id END,
       provenance = CASE WHEN uniscenario.artifacts.artifact_state = 'pending'
         THEN EXCLUDED.provenance ELSE uniscenario.artifacts.provenance END
     RETURNING id, artifact_state, storage_bucket, storage_key`,
    {
      id: artifactId,
      workspace_id: context.workspaceId,
      media_type: MEDIA_TYPE,
      bucket,
      storage_key: key,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      metadata: {
        documentId,
        expectedVersion: input.expectedVersion,
        sourceInputDigest: input.sourceInputDigest,
        mapAssetId: input.mapAssetId,
        mapVersionId: input.mapVersionId,
      },
      producer_job_id: producerJobId,
      provenance: {
        contract: "uniscenario.artifact-provenance/v1",
        producerJobFamily: "artifact_postprocess",
        producerJobId,
        operation: "materialize_traffic",
        documentId,
        draftVersion: input.expectedVersion,
        sourceInputDigest: input.sourceInputDigest,
      },
    },
  );
  const row = rows[0];
  if (!row) throw new Error("materialized_traffic_reservation_failed");
  return {
    artifactId: row.id,
    uploadRequired: row.artifact_state !== "available",
    uploadUrl:
      row.artifact_state === "available"
        ? null
        : await getPresignedPutUrl(row.storage_key, MEDIA_TYPE, row.storage_bucket, 900, input.sha256),
    headers: checksumBoundPutRequiredHeaders(MEDIA_TYPE, input.sha256),
  };
}

export async function completeMaterializedTraffic(
  context: AppContext,
  documentId: string,
  input: UniScenarioMaterializedTrafficReference,
) {
  const rows = await queryRows<{
    storage_bucket: string;
    storage_key: string;
    sha256: string;
    byte_length: number;
  }>(
    `SELECT storage_bucket, storage_key, sha256, byte_length FROM uniscenario.artifacts
     WHERE id = :artifact_id AND workspace_id = :workspace_id
       AND artifact_kind = 'materialized-traffic' AND artifact_state IN ('pending', 'available')
       AND metadata->>'documentId' = :document_id
       AND metadata->>'sourceInputDigest' = :source_input_digest
       AND metadata->>'mapAssetId' = :map_asset_id
       AND metadata->>'mapVersionId' = :map_version_id LIMIT 1`,
    {
      artifact_id: input.artifactId,
      workspace_id: context.workspaceId,
      document_id: documentId,
      source_input_digest: input.sourceInputDigest,
      map_asset_id: input.mapAssetId,
      map_version_id: input.mapVersionId,
    },
  );
  const row = rows[0];
  if (!row || row.sha256 !== input.sha256 || Number(row.byte_length) !== input.sizeBytes) return null;
  const head = await headS3Object(row.storage_key, row.storage_bucket);
  const checksum = head.checksumSha256 ? Buffer.from(head.checksumSha256, "base64").toString("hex") : null;
  if (head.contentLength !== input.sizeBytes || checksum !== input.sha256)
    throw new Error("materialized_traffic_upload_mismatch");
  const finalized = await withTransaction(async (tx) => {
    const finalization = await finalizeLocalArtifactProducer(
      { workspaceId: context.workspaceId, artifactId: input.artifactId },
      tx,
    );
    if (!finalization) return false;
    await tx.execute(
      `UPDATE uniscenario.artifacts SET artifact_state = 'available', verified_at = NOW()
       WHERE id = :artifact_id AND workspace_id = :workspace_id
         AND artifact_state IN ('pending', 'available')`,
      { artifact_id: input.artifactId, workspace_id: context.workspaceId },
    );
    return true;
  });
  return finalized ? input : null;
}
