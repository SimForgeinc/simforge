import { randomBytes } from "node:crypto";
import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows } from "@/app/lib/db/data-api";
import { putS3Object } from "@/app/lib/s3/s3-put-object";
import { sha256, scenarioId } from "./core";
import { createLocalArtifactProducer } from "./jobs/local-artifact-producer-store";
import { withScenarioJobTransaction } from "./jobs/lifecycle-lock";
import { simforgeEnv } from "@/lib/compat-env";

const ARTIFACT_KIND = "source-openscenario";

function artifactBucket() {
  return (
    simforgeEnv("ARTIFACT_BUCKET")?.trim() ||
    process.env.S3_BUCKET?.trim() ||
    "local-artifacts"
  );
}

type ArtifactRow = {
  id: string;
  artifact_state: "pending" | "available" | "quarantined" | "deleted";
  sha256: string;
  byte_length: number;
  media_type: string;
  producer_job_id: string | null;
  storage_bucket: string;
  storage_key: string;
};

async function publishOpenScenarioImportArtifact(input: {
  workspaceId: string;
  userId: string | null;
  producerJobId: string;
  artifactId: string;
  storageBucket: string;
  storageKey: string;
  sha256: string;
  byteLength: number;
  mediaType: "application/xml";
}) {
  return withScenarioJobTransaction(input.producerJobId, async (tx) => {
    const producer = await tx.queryOne<{
      state: string;
      cancel_requested_at: string | null;
      result_matches: boolean;
      artifact_id: string | null;
      artifact_state: string | null;
    }>(
      `SELECT job.state, job.cancel_requested_at::text AS cancel_requested_at,
              job.result_payload = jsonb_build_object(
                'artifactId', artifact.id, 'artifactKind', artifact.artifact_kind,
                'sha256', artifact.sha256, 'provenance', artifact.provenance
              ) AS result_matches,
              artifact.id AS artifact_id, artifact.artifact_state
         FROM simforge.artifact_postprocess_jobs job
         LEFT JOIN simforge.artifacts artifact
           ON artifact.workspace_id = job.workspace_id
          AND artifact.producer_job_family = 'artifact_postprocess'
          AND artifact.producer_job_id = job.id
          AND artifact.artifact_kind = :artifact_kind
          AND artifact.sha256 = :sha256 AND artifact.deleted_at IS NULL
        WHERE job.id = :producer_job_id AND job.workspace_id = :workspace_id
          AND job.postprocess_kind = 'openscenario_import'
        FOR UPDATE OF job`,
      {
        producer_job_id: input.producerJobId,
        workspace_id: input.workspaceId,
        artifact_kind: ARTIFACT_KIND,
        sha256: input.sha256,
      },
    );
    if (!producer) return null;
    if (producer.state === "succeeded") {
      if (!producer.result_matches || producer.artifact_state !== "available" || !producer.artifact_id) {
        throw new Error("xosc_source_producer_replay_mismatch");
      }
      return tx.queryOne<ArtifactRow>(
        `SELECT id, artifact_state, sha256, byte_length, media_type,
                producer_job_id, storage_bucket, storage_key
           FROM simforge.artifacts
          WHERE id = :artifact_id AND workspace_id = :workspace_id
            AND producer_job_family = 'artifact_postprocess'
            AND producer_job_id = :producer_job_id
            AND artifact_kind = :artifact_kind AND sha256 = :sha256
            AND artifact_state = 'available' AND deleted_at IS NULL`,
        {
          artifact_id: producer.artifact_id,
          workspace_id: input.workspaceId,
          producer_job_id: input.producerJobId,
          artifact_kind: ARTIFACT_KIND,
          sha256: input.sha256,
        },
      );
    }
    if (producer.state !== "running" || producer.cancel_requested_at) {
      await tx.execute(
        `UPDATE simforge.artifacts
            SET artifact_state = 'quarantined'
          WHERE workspace_id = :workspace_id
            AND producer_job_family = 'artifact_postprocess'
            AND producer_job_id = :producer_job_id
            AND artifact_kind = :artifact_kind AND sha256 = :sha256
            AND artifact_state = 'available'`,
        {
          workspace_id: input.workspaceId,
          producer_job_id: input.producerJobId,
          artifact_kind: ARTIFACT_KIND,
          sha256: input.sha256,
        },
      );
      return null;
    }

    const attemptId = scenarioId("usppat");
    const fenceToken = randomBytes(32).toString("hex");
    const attempt = await tx.queryOne<{ id: string }>(
      `INSERT INTO simforge.cpu_job_attempts (
         id, workspace_id, job_family, job_id, attempt_number, worker_id,
         fence_token_sha256, attempt_state, expires_at
       ) VALUES (
         :id, :workspace_id, 'artifact_postprocess', :job_id, 1,
         'local:openscenario_import', :fence_token_sha256, 'active', NOW() + INTERVAL '15 minutes'
       )
       ON CONFLICT (job_family, job_id, attempt_number) DO UPDATE SET
         id = simforge.cpu_job_attempts.id
       RETURNING id`,
      {
        id: attemptId,
        workspace_id: input.workspaceId,
        job_id: input.producerJobId,
        fence_token_sha256: sha256(fenceToken),
      },
    );
    if (!attempt) throw new Error("xosc_source_attempt_admission_failed");

    const provenance = {
      contract: "uniscenario.artifact-provenance/v1",
      producerJobFamily: "artifact_postprocess",
      producerJobId: input.producerJobId,
      producerAttemptId: attempt.id,
      operation: "openscenario_import",
      sourceSha256: input.sha256,
    };
    const artifact = await tx.queryOne<ArtifactRow>(
      `INSERT INTO simforge.artifacts (
         id, workspace_id, revision_id, artifact_kind, media_type,
         storage_bucket, storage_key, sha256, byte_length, artifact_state,
         metadata, created_by_user_id, verification_method, verification_sha256,
         producer_job_family, producer_job_id, producer_attempt_id, provenance
       ) VALUES (
         :id, :workspace_id, NULL, :artifact_kind, :media_type,
         :storage_bucket, :storage_key, :sha256, :byte_length, 'pending',
         CAST(:metadata AS jsonb), :user_id, 'stream_sha256', :sha256,
         'artifact_postprocess', :producer_job_id, :attempt_id, CAST(:provenance AS jsonb)
       )
       ON CONFLICT (workspace_id, sha256, artifact_kind)
       WHERE artifact_state IN ('pending', 'available') AND deleted_at IS NULL
       DO UPDATE SET
         artifact_state = 'pending', verified_at = NULL,
         producer_attempt_id = EXCLUDED.producer_attempt_id,
         provenance = EXCLUDED.provenance
       WHERE simforge.artifacts.producer_job_family = 'artifact_postprocess'
         AND simforge.artifacts.producer_job_id = EXCLUDED.producer_job_id
         AND simforge.artifacts.storage_bucket = EXCLUDED.storage_bucket
         AND simforge.artifacts.storage_key = EXCLUDED.storage_key
       RETURNING id, artifact_state, sha256, byte_length, media_type,
         producer_job_id, storage_bucket, storage_key`,
      {
        id: input.artifactId,
        workspace_id: input.workspaceId,
        artifact_kind: ARTIFACT_KIND,
        media_type: input.mediaType,
        storage_bucket: input.storageBucket,
        storage_key: input.storageKey,
        sha256: input.sha256,
        byte_length: input.byteLength,
        metadata: { standard: "ASAM OpenSCENARIO", contentAddressed: true },
        user_id: input.userId,
        producer_job_id: input.producerJobId,
        attempt_id: attempt.id,
        provenance,
      },
    );
    if (
      !artifact || artifact.producer_job_id !== input.producerJobId ||
      artifact.storage_bucket !== input.storageBucket || artifact.storage_key !== input.storageKey
    ) {
      throw new Error("xosc_source_artifact_identity_conflict");
    }
    await tx.execute(
      `INSERT INTO simforge.operational_job_artifact_links (
         id, workspace_id, artifact_id, job_family, job_id, attempt_id, relationship
       ) VALUES (
         :id, :workspace_id, :artifact_id, 'artifact_postprocess', :job_id, :attempt_id, 'output'
       ) ON CONFLICT (artifact_id, job_family, job_id, attempt_id, relationship) DO NOTHING`,
      {
        id: scenarioId("usojal"),
        workspace_id: input.workspaceId,
        artifact_id: artifact.id,
        job_id: input.producerJobId,
        attempt_id: attempt.id,
      },
    );
    const finalized = await tx.queryOne<{ id: string }>(
      `UPDATE simforge.artifact_postprocess_jobs job
          SET state = 'succeeded', phase = 'finalized', progress = 1,
              result_payload = jsonb_build_object(
                'artifactId', artifact.id, 'artifactKind', artifact.artifact_kind,
                'sha256', artifact.sha256, 'provenance', artifact.provenance
              ), completed_at = NOW(), updated_at = NOW()
         FROM simforge.artifacts artifact
        WHERE job.id = :job_id AND job.workspace_id = :workspace_id
          AND artifact.id = :artifact_id AND artifact.workspace_id = job.workspace_id
          AND artifact.producer_job_id = job.id
          AND artifact.producer_attempt_id = :attempt_id
          AND job.state = 'running' AND job.cancel_requested_at IS NULL
          AND EXISTS (
            SELECT 1 FROM simforge.cpu_job_attempts active
             WHERE active.id = :attempt_id AND active.job_id = job.id
               AND active.job_family = 'artifact_postprocess'
               AND active.attempt_state = 'active' AND active.expires_at > NOW()
          )
        RETURNING job.id`,
      {
        job_id: input.producerJobId,
        workspace_id: input.workspaceId,
        artifact_id: artifact.id,
        attempt_id: attempt.id,
      },
    );
    if (!finalized) throw new Error("xosc_source_producer_finalize_failed");
    await tx.execute(
      `UPDATE simforge.cpu_job_attempts
          SET attempt_state = 'succeeded', progress = 1, completed_at = NOW()
        WHERE id = :attempt_id AND attempt_state = 'active'`,
      { attempt_id: attempt.id },
    );
    const available = await tx.queryOne<ArtifactRow>(
      `UPDATE simforge.artifacts
          SET artifact_state = 'available', verified_at = NOW()
        WHERE id = :artifact_id AND workspace_id = :workspace_id
          AND producer_job_id = :producer_job_id AND producer_attempt_id = :attempt_id
          AND artifact_state = 'pending'
        RETURNING id, artifact_state, sha256, byte_length, media_type,
          producer_job_id, storage_bucket, storage_key`,
      {
        artifact_id: artifact.id,
        workspace_id: input.workspaceId,
        producer_job_id: input.producerJobId,
        attempt_id: attempt.id,
      },
    );
    if (!available) throw new Error("xosc_source_artifact_publish_failed");
    return available;
  });
}

/**
 * Store one immutable, content-addressed copy of imported source bytes.
 *
 * The document draft stores only this artifact id plus hash/report provenance. The unique
 * `(workspace_id, sha256, artifact_kind)` constraint and deterministic S3 key make repeated imports
 * converge on one object instead of copying Base64 into every mutable draft or revision.
 */
export async function storeOpenScenarioSourceArtifact(
  context: AppContext,
  input: {
    bytes: Uint8Array;
    sha256: string;
    byteLength: number;
    mediaType: "application/xml";
  },
) {
  const existing = await queryRows<ArtifactRow>(
    `SELECT artifact.id, artifact.artifact_state, artifact.sha256, artifact.byte_length,
       artifact.media_type, artifact.producer_job_id, artifact.storage_bucket, artifact.storage_key
     FROM simforge.artifacts artifact
     WHERE artifact.workspace_id = :workspace_id AND artifact.sha256 = :sha256
       AND artifact.artifact_kind = :artifact_kind AND artifact.deleted_at IS NULL
     LIMIT 1`,
    {
      workspace_id: context.workspaceId,
      sha256: input.sha256,
      artifact_kind: ARTIFACT_KIND,
    },
  );
  if (existing[0]) {
    if (existing[0].artifact_state !== "available") throw new Error("xosc_source_artifact_unavailable");
    if (existing[0].producer_job_id) {
      const replay = await publishOpenScenarioImportArtifact({
        workspaceId: context.workspaceId,
        userId: context.userId,
        producerJobId: existing[0].producer_job_id,
        artifactId: existing[0].id,
        storageBucket: existing[0].storage_bucket,
        storageKey: existing[0].storage_key,
        sha256: input.sha256,
        byteLength: input.byteLength,
        mediaType: input.mediaType,
      });
      if (!replay) throw new Error("xosc_source_producer_finalize_failed");
    }
    return {
      artifactId: existing[0].id,
      sha256: existing[0].sha256,
      byteLength: Number(existing[0].byte_length),
      mediaType: existing[0].media_type as "application/xml",
    };
  }

  const bucket = artifactBucket();
  const key = `${context.workspaceId}/imports/openscenario/sha256/${input.sha256.slice(0, 2)}/${input.sha256}.xosc`;
  await putS3Object(bucket, key, input.bytes, input.mediaType);
  const artifactId = scenarioId("usart");
  const producerJobId = await createLocalArtifactProducer({
    workspaceId: context.workspaceId,
    requestedByUserId: context.userId,
    operation: "openscenario_import",
    artifactKind: ARTIFACT_KIND,
    artifactSha256: input.sha256,
    requestPayload: { mediaType: input.mediaType, byteLength: input.byteLength },
  });
  const stored = await publishOpenScenarioImportArtifact({
    workspaceId: context.workspaceId,
    userId: context.userId,
    producerJobId,
    artifactId,
    storageBucket: bucket,
    storageKey: key,
    sha256: input.sha256,
    byteLength: input.byteLength,
    mediaType: input.mediaType,
  });
  if (!stored || stored.artifact_state !== "available") throw new Error("xosc_source_artifact_unavailable");
  return {
    artifactId: stored.id,
    sha256: stored.sha256,
    byteLength: Number(stored.byte_length),
    mediaType: stored.media_type as "application/xml",
  };
}
