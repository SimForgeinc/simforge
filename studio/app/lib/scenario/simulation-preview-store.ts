import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows, withTransaction } from "@/app/lib/db/data-api";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedGetUrl,
  getPresignedPutUrl,
  headS3Object,
} from "@/app/lib/s3/s3-presign";
import type { ScenarioSimulationPreviewDto } from "./contracts";
import { scenarioId } from "./core";
import {
  createLocalArtifactProducer,
  finalizeLocalArtifactProducer,
} from "./jobs/local-artifact-producer-store";
import { simforgeEnv } from "@/lib/compat-env";
import { COMPRESSED_PLAYBACK_MEDIA_TYPE } from "./stored-wire-compat";

const KIND = "browser-simulation-preview-v1";
class StaleSimulationPreviewCompletion extends Error {}

type PreviewArtifactMetadata = { contentSha256: string; mapVersionId: string };

/** Aurora's Data API hands back `jsonb` as either an object or its text form. */
function parseArtifactMetadata(value: unknown): PreviewArtifactMetadata | null {
  const record =
    typeof value === "string"
      ? (JSON.parse(value) as Record<string, unknown> | null)
      : (value as Record<string, unknown> | null);
  const contentSha256 = record?.contentSha256;
  const mapVersionId = record?.mapVersionId;
  return typeof contentSha256 === "string" && typeof mapVersionId === "string"
    ? { contentSha256, mapVersionId }
    : null;
}

function artifactBucket() { return simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts"; }
type Identity = { expectedVersion: number; sha256: string; sizeBytes: number };

export async function reserveSimulationPreview(context: AppContext, documentId: string, input: Identity) {
  const docs = await queryRows<{
    draft_version: number;
    content_sha256: string;
    map_version_id: string | null;
  }>(
    `SELECT dr.draft_version,dr.content_sha256,dr.map_version_id FROM simforge.documents d JOIN simforge.drafts dr ON dr.document_id=d.id AND dr.workspace_id=d.workspace_id WHERE d.id=:document_id AND d.workspace_id=:workspace_id AND d.deleted_at IS NULL LIMIT 1`,
    { document_id: documentId, workspace_id: context.workspaceId },
  );
  const doc = docs[0];
  if (!doc || Number(doc.draft_version) !== input.expectedVersion || !doc.map_version_id) return null;
  const bucket = artifactBucket();
  const key = `${context.workspaceId}/simulation-previews/sha256/${input.sha256}.json.gz`;
  const artifactId = scenarioId("usart");
  const producerJobId = await createLocalArtifactProducer({
    workspaceId: context.workspaceId,
    requestedByUserId: context.userId,
    operation: "browser_simulation_preview",
    artifactKind: KIND,
    artifactSha256: input.sha256,
    requestPayload: {
      documentId,
      draftVersion: input.expectedVersion,
      contentSha256: doc.content_sha256,
      mapVersionId: doc.map_version_id,
    },
  });
  const rows = await queryRows<{
    id: string;
    artifact_state: string;
    storage_bucket: string;
    storage_key: string;
  }>(
    // The conflict target is (workspace_id, sha256, artifact_kind) — content,
    // not document. Two documents with identical content share a row, and so
    // does the same document across draft versions, because unchanged content
    // hashes the same. The row nonetheless carries per-RESERVATION facts:
    // `metadata.documentId`, `metadata.expectedVersion`, and `producer_job_id`.
    //
    // `DO UPDATE SET sha256=EXCLUDED.sha256` refreshed none of them, so a second
    // reservation returned the FIRST one's row. `completeSimulationPreview` then
    // matched `metadata->>'documentId'` and `expectedVersion` against that stale
    // metadata, and `finalizeLocalArtifactProducer` joined through the stale
    // `producer_job_id` to a job belonging to the earlier reservation — both
    // fail, both return null, and the route answers 409 stale_simulation_preview
    // forever. Nothing was ever saved, so the next open re-ran the whole cycle.
    //
    // Refreshing them is sound precisely because the key is the digest: the
    // bytes are identical by definition, and every field below describes which
    // reservation is currently claiming them. `artifact_state` is deliberately
    // NOT reset — bytes already uploaded stay uploaded, which is what lets
    // `uploadRequired` skip a redundant PUT.
    //
    // The producer fields are refreshed only while the row is still `pending`.
    // `uniscenario_artifacts_finalized_provenance_immutable` (migration
    // 20260809022000) rejects any change to provenance or producer_job_id once
    // `artifact_state <> 'pending'`, and it is right to: a finalized artifact's
    // attribution is history. A pending row is an abandoned reservation, so
    // handing it to the live producer job is both legal and correct. `metadata`
    // is outside that freeze, which is what lets completion identify the
    // reservation currently claiming these bytes.
    `INSERT INTO simforge.artifacts (id,workspace_id,artifact_kind,media_type,storage_bucket,storage_key,sha256,byte_length,artifact_state,metadata,created_by_user_id,producer_job_family,producer_job_id,provenance) VALUES (:id,:workspace_id,:kind,:media_type,:bucket,:key,:sha256,:size_bytes,'pending',CAST(:metadata AS jsonb),:user_id,'artifact_postprocess',:producer_job_id,CAST(:provenance AS jsonb)) ON CONFLICT (workspace_id,sha256,artifact_kind) WHERE artifact_state IN ('pending','available') AND deleted_at IS NULL DO UPDATE SET metadata=EXCLUDED.metadata,producer_job_id=CASE WHEN simforge.artifacts.artifact_state='pending' THEN EXCLUDED.producer_job_id ELSE simforge.artifacts.producer_job_id END,provenance=CASE WHEN simforge.artifacts.artifact_state='pending' THEN EXCLUDED.provenance ELSE simforge.artifacts.provenance END RETURNING id,artifact_state,storage_bucket,storage_key`,
    {
      id: artifactId,
      workspace_id: context.workspaceId,
      kind: KIND,
      media_type: COMPRESSED_PLAYBACK_MEDIA_TYPE,
      bucket,
      key,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      metadata: {
        documentId,
        expectedVersion: input.expectedVersion,
        contentSha256: doc.content_sha256,
        mapVersionId: doc.map_version_id,
      },
      user_id: context.userId,
      producer_job_id: producerJobId,
      provenance: {
        contract: "uniscenario.artifact-provenance/v1",
        producerJobFamily: "artifact_postprocess",
        producerJobId,
        operation: "browser_simulation_preview",
        documentId,
        draftVersion: input.expectedVersion,
        sourceContentSha256: doc.content_sha256,
      },
    },
  );
  const row = rows[0];
  if (!row) throw new Error("simulation_preview_reservation_failed");
  return {
    artifactId: row.id,
    uploadRequired: row.artifact_state !== "available",
    uploadUrl:
      row.artifact_state === "available"
        ? null
        : await getPresignedPutUrl(row.storage_key, COMPRESSED_PLAYBACK_MEDIA_TYPE, row.storage_bucket, 900, input.sha256),
    headers: checksumBoundPutRequiredHeaders(COMPRESSED_PLAYBACK_MEDIA_TYPE, input.sha256),
  };
}

export async function completeSimulationPreview(
  context: AppContext,
  documentId: string,
  input: Identity & { artifactId: string },
) {
  const rows = await queryRows<{
    storage_bucket: string;
    storage_key: string;
    sha256: string;
    byte_length: number;
    metadata?: unknown;
  }>(
    `SELECT storage_bucket,storage_key,sha256,byte_length,metadata FROM simforge.artifacts
      WHERE id=:artifact_id AND workspace_id=:workspace_id AND artifact_kind=:kind
        AND artifact_state IN ('pending','available')
        AND metadata->>'documentId' = :document_id
        AND (metadata->>'expectedVersion')::integer = :expected_version
        AND provenance->>'operation' = 'browser_simulation_preview'
      LIMIT 1`,
    {
      artifact_id: input.artifactId,
      workspace_id: context.workspaceId,
      kind: KIND,
      document_id: documentId,
      expected_version: input.expectedVersion,
    },
  );
  const row = rows[0];
  if (!row || row.sha256 !== input.sha256 || Number(row.byte_length) !== input.sizeBytes) return null;
  const head = await headS3Object(row.storage_key, row.storage_bucket);
  const checksum = head.checksumSha256 ? Buffer.from(head.checksumSha256, "base64").toString("hex") : null;
  if (head.contentLength !== input.sizeBytes || checksum !== input.sha256)
    throw new Error("simulation_preview_upload_mismatch");
  try {
    return await withTransaction(async (tx) => {
      const finalization = await finalizeLocalArtifactProducer(
        { workspaceId: context.workspaceId, artifactId: input.artifactId },
        tx,
      );
      if (!finalization) return null;
      if (finalization.alreadySucceeded) {
        // The producer job already succeeded, so the artifact is finalized and
        // must not be re-validated against a draft that has moved since — that
        // is the lost-response retry contract pinned by
        // `scenario-local-artifact-retry-routes`, and why nothing below may
        // re-read the draft.
        //
        // But "the artifact is finalized" does not imply "this document is
        // linked to it". These bytes are keyed by digest, so the job can have
        // succeeded for a different document, or for this one at an earlier
        // draft. Returning bare `ok` there left `simulation_previews` with no
        // row for the document being completed: its next read 404'd, and the
        // editor recompiled and re-uploaded an identical preview on every open.
        //
        // So link it, from the artifact's own metadata — which reserve keeps
        // pointed at the reservation currently claiming these bytes — using
        // only `execute`, so the draft is still never re-read.
        const metadata = parseArtifactMetadata(row.metadata);
        if (metadata) {
          await tx.execute(
            `INSERT INTO simforge.simulation_previews (document_id,workspace_id,source_draft_version,source_content_sha256,map_version_id,artifact_id,created_by_user_id) VALUES (:document_id,:workspace_id,:version,:content_sha256,:map_version_id,:artifact_id,:user_id) ON CONFLICT (document_id) DO UPDATE SET source_draft_version=EXCLUDED.source_draft_version,source_content_sha256=EXCLUDED.source_content_sha256,map_version_id=EXCLUDED.map_version_id,artifact_id=EXCLUDED.artifact_id,created_by_user_id=EXCLUDED.created_by_user_id,created_at=NOW()`,
            {
              document_id: documentId,
              workspace_id: context.workspaceId,
              version: input.expectedVersion,
              content_sha256: metadata.contentSha256,
              map_version_id: metadata.mapVersionId,
              artifact_id: input.artifactId,
              user_id: context.userId,
            },
          );
        }
        return { ok: true as const };
      }
      const docs = await tx.queryRows<{
        draft_version: number;
        content_sha256: string;
        map_version_id: string | null;
      }>(
        `SELECT dr.draft_version,dr.content_sha256,dr.map_version_id FROM simforge.documents d JOIN simforge.drafts dr ON dr.document_id=d.id AND dr.workspace_id=d.workspace_id WHERE d.id=:document_id AND d.workspace_id=:workspace_id AND d.deleted_at IS NULL FOR UPDATE`,
        { document_id: documentId, workspace_id: context.workspaceId },
      );
      const doc = docs[0];
      if (!doc || Number(doc.draft_version) !== input.expectedVersion || !doc.map_version_id) {
        throw new StaleSimulationPreviewCompletion();
      }
      await tx.execute(
        `UPDATE simforge.artifacts SET artifact_state='available',verified_at=NOW() WHERE id=:artifact_id AND workspace_id=:workspace_id`,
        { artifact_id: input.artifactId, workspace_id: context.workspaceId },
      );
      await tx.execute(
        `INSERT INTO simforge.simulation_previews (document_id,workspace_id,source_draft_version,source_content_sha256,map_version_id,artifact_id,created_by_user_id) VALUES (:document_id,:workspace_id,:version,:content_sha256,:map_version_id,:artifact_id,:user_id) ON CONFLICT (document_id) DO UPDATE SET source_draft_version=EXCLUDED.source_draft_version,source_content_sha256=EXCLUDED.source_content_sha256,map_version_id=EXCLUDED.map_version_id,artifact_id=EXCLUDED.artifact_id,created_by_user_id=EXCLUDED.created_by_user_id,created_at=NOW()`,
        {
          document_id: documentId,
          workspace_id: context.workspaceId,
          version: input.expectedVersion,
          content_sha256: doc.content_sha256,
          map_version_id: doc.map_version_id,
          artifact_id: input.artifactId,
          user_id: context.userId,
        },
      );
      return { ok: true as const };
    });
  } catch (error) {
    if (error instanceof StaleSimulationPreviewCompletion) return null;
    throw error;
  }
}

export async function getCurrentSimulationPreview(
  context: AppContext,
  documentId: string,
): Promise<ScenarioSimulationPreviewDto | null> {
  const rows = await queryRows<{
    artifact_id: string;
    source_draft_version: number;
    sha256: string;
    byte_length: number;
    media_type: string;
    storage_bucket: string;
    storage_key: string;
    created_at: string;
  }>(
    `SELECT p.artifact_id,p.source_draft_version,a.sha256,a.byte_length,a.media_type,a.storage_bucket,a.storage_key,p.created_at::text created_at FROM simforge.simulation_previews p JOIN simforge.documents d ON d.id=p.document_id AND d.workspace_id=p.workspace_id JOIN simforge.drafts dr ON dr.document_id=d.id AND dr.workspace_id=d.workspace_id JOIN simforge.artifacts a ON a.id=p.artifact_id AND a.workspace_id=p.workspace_id WHERE p.document_id=:document_id AND p.workspace_id=:workspace_id AND d.deleted_at IS NULL AND a.artifact_state='available' AND p.source_draft_version=dr.draft_version AND p.source_content_sha256=dr.content_sha256 AND p.map_version_id=dr.map_version_id LIMIT 1`,
    { document_id: documentId, workspace_id: context.workspaceId },
  );
  const row = rows[0];
  return row
    ? {
        artifactId: row.artifact_id,
        draftVersion: Number(row.source_draft_version),
        sha256: row.sha256,
        sizeBytes: Number(row.byte_length),
        mediaType: row.media_type,
        downloadUrl: await getPresignedGetUrl(row.storage_key, row.storage_bucket),
        createdAt: row.created_at,
      }
    : null;
}
