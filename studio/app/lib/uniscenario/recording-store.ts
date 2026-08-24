import type { AppContext } from "@/app/lib/db/app-context";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { queryRows, withTransaction } from "@/app/lib/db/data-api";
import {
  ScenarioTemplateV2Schema,
  type ScenarioTemplateV2,
} from "@simforge/scenario";
import {
  checksumBoundPutRequiredHeaders,
  getPresignedGetUrl,
  getPresignedPutUrl,
  headS3Object,
} from "@/app/lib/s3/s3-presign";
import {
  canonicalContentSha256,
  canonicalJsonSha256,
  uniscenarioId,
} from "./core";
import {
  createLocalArtifactProducer,
  finalizeLocalArtifactProducerSet,
} from "./jobs/local-artifact-producer-store";
import {
  withUniScenarioJobTransaction,
  type JobTransaction,
} from "./jobs/lifecycle-lock";
import {
  BROWSER_RECORDING_ADAPTER_VERSION,
  BROWSER_RECORDING_KIND,
  BROWSER_RECORDING_REQUEST_CONTRACT,
  BROWSER_RECORDING_RESULT_CONTRACT,
  CreateBrowserRecordingSchema,
  BrowserRecordingRequestPayloadSchema,
  type BrowserRecordingArtifactDto,
  type BrowserRecordingArtifactReservationDto,
  type BrowserRecordingArtifactRole,
  type BrowserRecordingSensorIdentity,
  type BrowserRecordingDetailDto,
  type BrowserRecordingRequestPayload,
  type BrowserRecordingResultPayload,
  type BrowserRecordingSummaryDto,
  type CreateBrowserRecordingInput,
  type FinalizeBrowserRecordingInput,
  type JsonValue,
  type ReserveBrowserRecordingArtifactsInput,
  type UpdateBrowserRecordingProgressInput,
} from "./recording-contracts";

const RECORDING_SESSION_TTL_SECONDS = 20 * 60;
const SUPPORTED_V3_ARTIFACTS = new Set([
  "video",
  "manifest",
  "frames",
  "sensorArchive",
  // These are embedded in the verified runtime manifest. They are not separate browser-recording
  // uploads, so they participate in intent validation without adding recording artifact rows.
  "trace",
  "annotations",
]);
const PHASE_ORDER = new Map([
  ["preparing_assets", 0],
  ["capturing", 1],
  ["encoding", 2],
  ["uploading", 3],
]);

const ARTIFACT_KINDS: Record<BrowserRecordingArtifactRole, string> = {
  video: "browser-threejs-recording-video-v1",
  poster: "browser-threejs-recording-poster-v1",
  manifest: "browser-threejs-recording-manifest-v1",
  frames: "browser-threejs-recording-frames-v1",
  sensor_archive: "browser-threejs-recording-sensor-archive-v1",
  sensor_video: "browser-threejs-recording-sensor-video-v1",
  trace: "browser-threejs-recording-trace-v1",
  log: "browser-threejs-recording-log-v1",
};

type FrozenRecordingRevision = {
  id: string;
  document_id: string;
  content_sha256: string;
  canonical_content: string | Record<string, unknown>;
  map_id: string;
  map_version_id: string;
  xodr_sha256: string;
};

function sameCanonicalValue(left: unknown, right: unknown) {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}
type DeclaredRecordingArtifact = {
  role: BrowserRecordingArtifactRole;
  sensor: BrowserRecordingSensorIdentity | null;
};

function artifactIdentity(artifact: DeclaredRecordingArtifact): string {
  return artifact.sensor
    ? `${artifact.role}\u0000${artifact.sensor.actorId}\u0000${artifact.sensor.sensorId}\u0000${artifact.sensor.modality}`
    : artifact.role;
}

function declaredRecordingArtifacts(
  renderSpec: CreateBrowserRecordingInput["renderSpec"],
): DeclaredRecordingArtifact[] | null {
  if (renderSpec.schema === "uniscenario.render-spec/v2") {
    const legacyRoles = new Set(renderSpec.artifacts);
    return renderSpec.artifacts.length === 2
      && legacyRoles.has("video")
      && legacyRoles.has("manifest")
      ? [
          { role: "video", sensor: null },
          { role: "manifest", sensor: null },
        ]
      : null;
  }
  if (renderSpec.artifacts.some((artifact) => !SUPPORTED_V3_ARTIFACTS.has(artifact))) {
    return null;
  }
  const declared: DeclaredRecordingArtifact[] = [];
  if (renderSpec.artifacts.includes("video")) declared.push({ role: "video", sensor: null });
  declared.push({ role: "manifest", sensor: null });
  if (renderSpec.artifacts.includes("frames")) declared.push({ role: "frames", sensor: null });
  if (renderSpec.artifacts.includes("sensorArchive")) {
    for (const source of renderSpec.sources) {
      // Archive-light review contract: LiDAR/radar remain raw data products by
      // default. Image frame archives are opt-in via the explicit frames artifact.
      if (
        renderSpec.artifacts.includes("frames")
        || source.modality === "lidar"
        || source.modality === "radar"
      ) {
        declared.push({
          role: "sensor_archive",
          sensor: {
            actorId: source.actorId,
            sensorId: source.sensorId,
            modality: source.modality,
          },
        });
      }
      if (
        renderSpec.video
        && (source.modality === "lidar" || source.modality === "radar")
      ) {
        declared.push({
          role: "sensor_video",
          sensor: {
            actorId: source.actorId,
            sensorId: source.sensorId,
            modality: source.modality,
          },
        });
      }
    }
  }
  return declared;
}

function exactArtifactClosure(
  expected: readonly DeclaredRecordingArtifact[],
  actual: readonly DeclaredRecordingArtifact[],
): boolean {
  if (expected.length !== actual.length) return false;
  const expectedIdentities = new Set(expected.map(artifactIdentity));
  return actual.every((artifact) => expectedIdentities.has(artifactIdentity(artifact)));
}


/**
 * Re-derive every client-provided binding from the immutable revision. The
 * portable manifest is evidence, not authority: only the server-read revision
 * can authorize its revision, environment, actor, and physical sensor snapshot.
 */
function recordingInputMatchesFrozenRevision(
  input: CreateBrowserRecordingInput,
  revision: FrozenRecordingRevision,
  template: ScenarioTemplateV2,
) {
  const { renderSpec, resolvedManifest } = input;
  const declaredArtifacts = declaredRecordingArtifacts(renderSpec);
  const video = renderSpec.video;
  if (
    !declaredArtifacts
    || revision.id !== input.revisionId
    || revision.document_id !== input.documentId
    || resolvedManifest.scenarioRevision.id !== revision.id
    || resolvedManifest.scenarioRevision.contentSha256 !== revision.content_sha256
    || canonicalContentSha256(template) !== revision.content_sha256
    || !sameCanonicalValue(renderSpec, resolvedManifest.renderSpec)
    || !sameCanonicalValue(renderSpec.authoredEnvironment, template.environment)
    || !sameCanonicalValue(
      resolvedManifest.environmentProvenance.baseAuthoredEnvironment,
      template.environment,
    )
    || resolvedManifest.environmentProvenance.stateChanges.length > 0
    || resolvedManifest.mapEvidence.mapId !== revision.map_id
    || resolvedManifest.mapEvidence.xodrSha256 !== revision.xodr_sha256
    || resolvedManifest.renderer.id !== "uniscenarios-city-renderer"
    || resolvedManifest.renderer.version !== BROWSER_RECORDING_ADAPTER_VERSION
    || (video !== undefined && (video.container !== "webm" || video.codec !== "vp9"))
    || renderSpec.sources.length !== resolvedManifest.resolvedSources.length
  ) {
    return false;
  }

  for (const requestedSource of renderSpec.sources) {
    const resolvedSource = resolvedManifest.resolvedSources.find((candidate) =>
      candidate.actorId === requestedSource.actorId
      && candidate.sensorId === requestedSource.sensorId
      && candidate.modality === requestedSource.modality
    );
    if (!resolvedSource) return false;
    const { sensor: resolvedSensor, ...resolvedRequest } = resolvedSource;
    if (!sameCanonicalValue(requestedSource, resolvedRequest)) return false;
    const role = template.roles.find((candidate) => candidate.id === requestedSource.actorId);
    const authoredSensor = role?.actor.sensors.find(
      (candidate) => candidate.id === requestedSource.sensorId,
    );
    if (
      !authoredSensor
      || !authoredSensor.enabled
      || !sameCanonicalValue(authoredSensor, resolvedSensor)
    ) {
      return false;
    }
  }
  return true;
}

function artifactBucket() { return process.env.UNISCENARIO_ARTIFACT_BUCKET?.trim() || "local-artifacts"; }

type RecordingRow = {
  id: string;
  revision_id: string;
  document_id: string;
  state: BrowserRecordingSummaryDto["status"];
  phase: string;
  progress: number;
  request_payload: BrowserRecordingRequestPayload | string;
  request_payload_sha256: string;
  progress_payload: Record<string, JsonValue>;
  result_payload: BrowserRecordingResultPayload | null;
  cancel_requested_at: string | null;
  failure_code: string | null;
  failure_detail: Record<string, JsonValue> | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
};

type ArtifactRow = {
  id: string;
  artifact_role: BrowserRecordingArtifactRole;
  artifact_sensor_actor_id: string | null;
  artifact_sensor_id: string | null;
  artifact_sensor_modality: BrowserRecordingSensorIdentity["modality"] | null;
  artifact_kind: string;
  media_type: string;
  sha256: string;
  byte_length: number;
  artifact_state: BrowserRecordingArtifactDto["state"];
  storage_bucket: string;
  storage_key: string;
  producer_job_id: string;
  reused: boolean;
};

const RECORDING_COLUMNS = `
  job.id, job.revision_id,
  job.request_payload->>'documentId' AS document_id,
  job.state, job.phase, job.progress,
  job.request_payload, job.request_payload_sha256, job.progress_payload,
  job.result_payload,
  job.cancel_requested_at::text AS cancel_requested_at,
  job.failure_code, job.failure_detail,
  job.created_at::text AS created_at, job.updated_at::text AS updated_at,
  job.started_at::text AS started_at, job.completed_at::text AS completed_at,
  job.expires_at::text AS expires_at`;

function summaryDto(row: RecordingRow): BrowserRecordingSummaryDto {
  return {
    id: row.id,
    family: "artifact_postprocess",
    type: BROWSER_RECORDING_KIND,
    revisionId: row.revision_id,
    documentId: row.document_id,
    status: row.state,
    phase: row.phase,
    progress: Number(row.progress),
    requestPayloadSha256: row.request_payload_sha256,
    cancelRequestedAt: row.cancel_requested_at,
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

async function artifactDto(
  row: ArtifactRow,
  includeDownloadUrl: boolean,
): Promise<BrowserRecordingArtifactDto> {
  return {
    artifactId: row.id,
    role: row.artifact_role,
    sensor: row.artifact_sensor_actor_id && row.artifact_sensor_id && row.artifact_sensor_modality
      ? {
          actorId: row.artifact_sensor_actor_id,
          sensorId: row.artifact_sensor_id,
          modality: row.artifact_sensor_modality,
        }
      : null,
    kind: row.artifact_kind,
    mediaType: row.media_type,
    sha256: row.sha256,
    sizeBytes: Number(row.byte_length),
    state: row.artifact_state,
    reused: Boolean(row.reused),
    downloadUrl:
      includeDownloadUrl && row.artifact_state === "available"
        ? await getPresignedGetUrl(row.storage_key, row.storage_bucket)
        : null,
  };
}

async function insertRecordingEvent(
  tx: JobTransaction,
  input: {
    workspaceId: string;
    recordingId: string;
    type: string;
    payload?: Record<string, unknown>;
  },
) {
  await tx.execute(
    `INSERT INTO uniscenario.operational_job_events (
       id, workspace_id, job_family, job_id, attempt_id,
       event_ordinal, event_type, event_payload
     ) VALUES (
       :id, :workspace_id, 'artifact_postprocess', :job_id, NULL,
       COALESCE((
         SELECT MAX(event_ordinal) + 1
           FROM uniscenario.operational_job_events
          WHERE job_family = 'artifact_postprocess' AND job_id = :job_id
       ), 1), :event_type, CAST(:event_payload AS jsonb)
     )`,
    {
      id: uniscenarioId("usevt"),
      workspace_id: input.workspaceId,
      job_id: input.recordingId,
      event_type: input.type,
      event_payload: input.payload ?? {},
    },
  );
}

async function quarantinePendingArtifacts(
  tx: JobTransaction,
  workspaceId: string,
  recordingId: string,
) {
  await tx.execute(
    `UPDATE uniscenario.artifacts artifact
        SET artifact_state = 'quarantined'
       FROM uniscenario.operational_job_artifact_links link
      WHERE link.workspace_id = :workspace_id
        AND link.job_family = 'artifact_postprocess' AND link.job_id = :job_id
        AND link.artifact_id = artifact.id AND link.workspace_id = artifact.workspace_id
        AND artifact.producer_job_id = :job_id
        AND artifact.artifact_state = 'pending'`,
    { workspace_id: workspaceId, job_id: recordingId },
  );
}

async function expireRecordingIfAbandoned(
  workspaceId: string,
  recordingId: string,
) {
  return withUniScenarioJobTransaction(recordingId, async (tx) => {
    const expired = await tx.queryOne<{ id: string }>(
      `UPDATE uniscenario.artifact_postprocess_jobs
          SET state = 'failed', phase = 'abandoned',
              failure_code = 'recording_session_expired',
              failure_detail = jsonb_build_object(
                'message', 'Browser recording stopped sending progress before its session expired.'
              ),
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND postprocess_kind = 'browser_threejs_recording'
          AND state = 'running' AND expires_at <= NOW()
        RETURNING id`,
      { workspace_id: workspaceId, job_id: recordingId },
    );
    if (!expired) return false;
    await quarantinePendingArtifacts(tx, workspaceId, recordingId);
    await insertRecordingEvent(tx, {
      workspaceId,
      recordingId,
      type: "recording_abandoned",
      payload: { failureCode: "recording_session_expired" },
    });
    return true;
  });
}

async function expireAbandonedRecordingBatch(workspaceId: string) {
  const rows = await queryRows<{ id: string }>(
    `SELECT id FROM uniscenario.artifact_postprocess_jobs
      WHERE workspace_id = :workspace_id
        AND postprocess_kind = 'browser_threejs_recording'
        AND state = 'running' AND expires_at <= NOW()
      ORDER BY expires_at, id LIMIT 20`,
    { workspace_id: workspaceId },
  );
  for (const row of rows) await expireRecordingIfAbandoned(workspaceId, row.id);
}

async function readRecordingRow(
  context: Pick<AppContext, "workspaceId">,
  recordingId: string,
) {
  const rows = await queryRows<RecordingRow>(
    `SELECT ${RECORDING_COLUMNS}
       FROM uniscenario.artifact_postprocess_jobs job
      WHERE job.id = :job_id AND job.workspace_id = :workspace_id
        AND job.postprocess_kind = 'browser_threejs_recording'
      LIMIT 1`,
    { workspace_id: context.workspaceId, job_id: recordingId },
  );
  return rows[0] ?? null;
}

async function readRecordingArtifacts(
  context: Pick<AppContext, "workspaceId">,
  recordingId: string,
) {
  return queryRows<ArtifactRow>(
    `SELECT artifact.id, link.artifact_role,
            link.artifact_sensor_actor_id, link.artifact_sensor_id,
            link.artifact_sensor_modality, artifact.artifact_kind,
            artifact.media_type, artifact.sha256, artifact.byte_length,
            artifact.artifact_state, artifact.storage_bucket, artifact.storage_key,
            artifact.producer_job_id,
            artifact.producer_job_id <> :job_id AS reused
       FROM uniscenario.operational_job_artifact_links link
       JOIN uniscenario.artifacts artifact
         ON artifact.id = link.artifact_id AND artifact.workspace_id = link.workspace_id
      WHERE link.workspace_id = :workspace_id
        AND link.job_family = 'artifact_postprocess' AND link.job_id = :job_id
        AND link.attempt_id IS NULL AND link.artifact_role IS NOT NULL
      ORDER BY CASE link.artifact_role
        WHEN 'video' THEN 1 WHEN 'manifest' THEN 2 WHEN 'frames' THEN 3
        WHEN 'sensor_video' THEN 4 WHEN 'sensor_archive' THEN 5 WHEN 'poster' THEN 6
        WHEN 'trace' THEN 7 ELSE 8 END,
        link.artifact_sensor_actor_id, link.artifact_sensor_id, link.artifact_sensor_modality`,
    { workspace_id: context.workspaceId, job_id: recordingId },
  );
}

export async function createBrowserRecording(
  context: AppContext,
  input: CreateBrowserRecordingInput,
): Promise<BrowserRecordingDetailDto | null> {
  const parsedInput = CreateBrowserRecordingSchema.parse(input);
  const revisions = await queryRows<FrozenRecordingRevision>(
    `SELECT revision.id, revision.document_id, revision.content_sha256,
       revision.canonical_content::text AS canonical_content,
       revision.map_version_id, map_version.source_map_asset_id AS map_id,
       map_version.xodr_sha256
       FROM uniscenario.revisions revision
       JOIN uniscenario.documents document
         ON document.id = revision.document_id
        AND document.workspace_id = revision.workspace_id
       JOIN uniscenario.map_versions map_version
         ON map_version.id = revision.map_version_id
      WHERE revision.id = :revision_id AND revision.workspace_id = :workspace_id
        AND revision.document_id = :document_id AND document.deleted_at IS NULL
      LIMIT 1`,
    {
      revision_id: parsedInput.revisionId,
      workspace_id: context.workspaceId,
      document_id: parsedInput.documentId,
    },
  );
  const revision = revisions[0];
  if (!revision) return null;
  const parsedTemplate = ScenarioTemplateV2Schema.safeParse(
    parseJsonObject(revision.canonical_content),
  );
  if (!parsedTemplate.success) {
    throw new Error("browser_recording_revision_invalid");
  }
  if (!recordingInputMatchesFrozenRevision(parsedInput, revision, parsedTemplate.data)) {
    return null;
  }
  const requestPayload: BrowserRecordingRequestPayload = {
    contract: BROWSER_RECORDING_REQUEST_CONTRACT,
    revisionId: revision.id,
    documentId: revision.document_id,
    revisionContentSha256: revision.content_sha256,
    idempotencyKey: parsedInput.idempotencyKey,
    renderSpec: parsedInput.renderSpec,
    renderSpecSha256: canonicalJsonSha256(parsedInput.renderSpec),
    resolvedManifest: parsedInput.resolvedManifest,
    resolvedManifestSha256: canonicalJsonSha256(parsedInput.resolvedManifest),
  };
  const requestPayloadSha256 = canonicalJsonSha256(requestPayload);
  const id = await createLocalArtifactProducer({
    workspaceId: context.workspaceId,
    revisionId: revision.id,
    requestedByUserId: context.userId,
    operation: BROWSER_RECORDING_KIND,
    requestPayload,
    requestPayloadSha256,
    idempotencyKey: `browser-recording:${parsedInput.idempotencyKey}`,
    initialPhase: "preparing_assets",
    initialProgress: 0,
    maxAttempts: 1,
    clientSessionExpiresSeconds: RECORDING_SESSION_TTL_SECONDS,
  });
  const admitted = await queryRows<{ request_payload_sha256: string }>(
    `SELECT request_payload_sha256
       FROM uniscenario.artifact_postprocess_jobs
      WHERE id = :job_id AND workspace_id = :workspace_id
        AND postprocess_kind = 'browser_threejs_recording' LIMIT 1`,
    { job_id: id, workspace_id: context.workspaceId },
  );
  if (admitted[0]?.request_payload_sha256 !== requestPayloadSha256) {
    throw new Error("browser_recording_idempotency_conflict");
  }
  return getBrowserRecording(context, id);
}

export async function listBrowserRecordings(
  context: Pick<AppContext, "workspaceId">,
  input: { revisionId?: string | null; documentId?: string | null; limit?: number } = {},
): Promise<BrowserRecordingSummaryDto[]> {
  await expireAbandonedRecordingBatch(context.workspaceId);
  const rows = await queryRows<RecordingRow>(
    `SELECT ${RECORDING_COLUMNS}
       FROM uniscenario.artifact_postprocess_jobs job
      WHERE job.workspace_id = :workspace_id
        AND job.postprocess_kind = 'browser_threejs_recording'
        ${input.revisionId ? "AND job.revision_id = :revision_id" : ""}
        ${input.documentId ? "AND job.request_payload->>'documentId' = :document_id" : ""}
      ORDER BY job.created_at DESC, job.id DESC LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      ...(input.revisionId ? { revision_id: input.revisionId } : {}),
      ...(input.documentId ? { document_id: input.documentId } : {}),
      row_limit: Math.max(1, Math.min(input.limit ?? 50, 100)),
    },
  );
  return rows.map(summaryDto);
}

export async function getBrowserRecording(
  context: Pick<AppContext, "workspaceId">,
  recordingId: string,
): Promise<BrowserRecordingDetailDto | null> {
  await expireRecordingIfAbandoned(context.workspaceId, recordingId);
  const row = await readRecordingRow(context, recordingId);
  if (!row) return null;
  const artifacts = await readRecordingArtifacts(context, recordingId);
  return {
    ...summaryDto(row),
    request: parseJsonObject(row.request_payload) as BrowserRecordingRequestPayload,
    progressDetail: row.progress_payload,
    result: row.result_payload,
    artifacts: await Promise.all(artifacts.map((artifact) => artifactDto(artifact, true))),
  };
}

export async function updateBrowserRecordingProgress(
  context: Pick<AppContext, "workspaceId">,
  recordingId: string,
  input: UpdateBrowserRecordingProgressInput,
) {
  await expireRecordingIfAbandoned(context.workspaceId, recordingId);
  const updated = await withUniScenarioJobTransaction(recordingId, async (tx) => {
    const current = await tx.queryOne<{ phase: string; progress: number }>(
      `SELECT phase, progress
         FROM uniscenario.artifact_postprocess_jobs
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND postprocess_kind = 'browser_threejs_recording'
          AND state = 'running' AND cancel_requested_at IS NULL
          AND expires_at > NOW() FOR UPDATE`,
      { workspace_id: context.workspaceId, job_id: recordingId },
    );
    if (!current) return false;
    const currentOrder = PHASE_ORDER.get(current.phase) ?? 0;
    const nextOrder = PHASE_ORDER.get(input.phase) ?? -1;
    if (nextOrder < currentOrder || input.progress < Number(current.progress)) return false;
    const row = await tx.queryOne<{ id: string }>(
      `UPDATE uniscenario.artifact_postprocess_jobs
          SET phase = :phase, progress = :progress,
              progress_payload = CAST(:progress_payload AS jsonb),
              client_heartbeat_at = NOW(),
              expires_at = NOW() + (:session_ttl * INTERVAL '1 second'),
              updated_at = NOW()
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND postprocess_kind = 'browser_threejs_recording'
          AND state = 'running' AND cancel_requested_at IS NULL
          AND expires_at > NOW() RETURNING id`,
      {
        workspace_id: context.workspaceId,
        job_id: recordingId,
        phase: input.phase,
        progress: input.progress,
        progress_payload: input.detail,
        session_ttl: RECORDING_SESSION_TTL_SECONDS,
      },
    );
    if (!row) return false;
    await insertRecordingEvent(tx, {
      workspaceId: context.workspaceId,
      recordingId,
      type: "recording_progress",
      payload: { phase: input.phase, progress: input.progress, ...input.detail },
    });
    return true;
  });
  return updated ? getBrowserRecording(context, recordingId) : null;
}

export async function reserveBrowserRecordingArtifacts(
  context: Pick<AppContext, "workspaceId" | "userId">,
  recordingId: string,
  input: ReserveBrowserRecordingArtifactsInput,
): Promise<BrowserRecordingArtifactReservationDto[] | null> {
  await expireRecordingIfAbandoned(context.workspaceId, recordingId);
  const bucket = artifactBucket();
  const reserved = await withUniScenarioJobTransaction(recordingId, async (tx) => {
    const owner = await tx.queryOne<{
      revision_id: string;
      request_payload: BrowserRecordingRequestPayload | string;
      request_payload_sha256: string;
    }>(
      `SELECT revision_id, request_payload, request_payload_sha256
         FROM uniscenario.artifact_postprocess_jobs
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND postprocess_kind = 'browser_threejs_recording'
          AND state = 'running' AND cancel_requested_at IS NULL
          AND expires_at > NOW() FOR UPDATE`,
      { workspace_id: context.workspaceId, job_id: recordingId },
    );
    if (!owner) return null;
    const request = BrowserRecordingRequestPayloadSchema.parse(
      parseJsonObject(owner.request_payload),
    );
    const expected = declaredRecordingArtifacts(request.renderSpec);
    const requested = input.artifacts.map((artifact) => ({
      role: artifact.role,
      sensor: "sensor" in artifact ? artifact.sensor : null,
    }));
    if (!expected || !exactArtifactClosure(expected, requested)) return null;
    const reservations: Array<{
      artifactId: string;
      role: BrowserRecordingArtifactRole;
      sensor: BrowserRecordingSensorIdentity | null;
      mediaType: string;
      sha256: string;
      storageBucket: string;
      storageKey: string;
      uploadRequired: boolean;
    }> = [];
    for (const declaration of input.artifacts) {
      const sensor = "sensor" in declaration ? declaration.sensor : null;
      const existingRole = await tx.queryOne<ArtifactRow>(
        `SELECT artifact.id, link.artifact_role,
                link.artifact_sensor_actor_id, link.artifact_sensor_id,
                link.artifact_sensor_modality, artifact.artifact_kind,
                artifact.media_type, artifact.sha256, artifact.byte_length,
                artifact.artifact_state, artifact.storage_bucket, artifact.storage_key,
                artifact.producer_job_id,
                artifact.producer_job_id <> :job_id AS reused
           FROM uniscenario.operational_job_artifact_links link
           JOIN uniscenario.artifacts artifact
             ON artifact.id = link.artifact_id AND artifact.workspace_id = link.workspace_id
          WHERE link.workspace_id = :workspace_id
            AND link.job_family = 'artifact_postprocess' AND link.job_id = :job_id
            AND link.attempt_id IS NULL AND link.artifact_role = :artifact_role
            AND link.artifact_sensor_actor_id IS NOT DISTINCT FROM :sensor_actor_id
            AND link.artifact_sensor_id IS NOT DISTINCT FROM :sensor_id
            AND link.artifact_sensor_modality IS NOT DISTINCT FROM :sensor_modality
          LIMIT 1`,
        {
          workspace_id: context.workspaceId,
          job_id: recordingId,
          artifact_role: declaration.role,
          sensor_actor_id: sensor?.actorId ?? null,
          sensor_id: sensor?.sensorId ?? null,
          sensor_modality: sensor?.modality ?? null,
        },
      );
      if (existingRole) {
        if (
          existingRole.sha256 !== declaration.sha256 ||
          existingRole.media_type !== declaration.mediaType ||
          Number(existingRole.byte_length) !== declaration.sizeBytes ||
          !["pending", "available"].includes(existingRole.artifact_state)
        ) {
          throw new Error("browser_recording_artifact_role_conflict");
        }
        reservations.push({
          artifactId: existingRole.id,
          role: declaration.role,
          sensor,
          mediaType: declaration.mediaType,
          sha256: declaration.sha256,
          storageBucket: existingRole.storage_bucket,
          storageKey: existingRole.storage_key,
          uploadRequired: existingRole.artifact_state !== "available",
        });
        continue;
      }
      const artifactKind = ARTIFACT_KINDS[declaration.role];
      const identitySuffix = sensor ? `/${canonicalJsonSha256(sensor)}` : "";
      const storageKey = `${context.workspaceId}/recordings/${recordingId}/sha256/${declaration.sha256}/${declaration.role}${identitySuffix}`;
      const metadata = {
        recordingId,
        role: declaration.role,
        sensor,
        requestPayloadSha256: owner.request_payload_sha256,
      };
      const provenance = {
        contract: "uniscenario.artifact-provenance/v1",
        producerJobFamily: "artifact_postprocess",
        producerJobId: recordingId,
        revisionId: owner.revision_id,
        operation: BROWSER_RECORDING_KIND,
        artifactRole: declaration.role,
        sensor,
        requestPayloadSha256: owner.request_payload_sha256,
      };
      const reservationParams = {
        id: uniscenarioId("usart"),
        workspace_id: context.workspaceId,
        revision_id: owner.revision_id,
        artifact_kind: artifactKind,
        artifact_role: declaration.role,
        sensor_actor_id: sensor?.actorId ?? null,
        sensor_id: sensor?.sensorId ?? null,
        sensor_modality: sensor?.modality ?? null,
        media_type: declaration.mediaType,
        storage_bucket: bucket,
        storage_key: storageKey,
        sha256: declaration.sha256,
        byte_length: declaration.sizeBytes,
        metadata,
        user_id: context.userId,
        job_id: recordingId,
        provenance,
      };
      const existingDigest = await tx.queryOne<ArtifactRow & { deleted_at: string | null }>(
        `SELECT id, :artifact_role AS artifact_role,
                :sensor_actor_id AS artifact_sensor_actor_id,
                :sensor_id AS artifact_sensor_id,
                :sensor_modality AS artifact_sensor_modality,
                artifact_kind, media_type, sha256, byte_length, artifact_state,
                storage_bucket, storage_key, producer_job_id, deleted_at::text,
                producer_job_id <> :job_id AS reused
           FROM uniscenario.artifacts
          WHERE workspace_id = :workspace_id AND sha256 = :sha256
            AND artifact_kind = :artifact_kind LIMIT 1`,
        reservationParams,
      );
      const inserted = existingDigest ? null : await tx.queryOne<ArtifactRow>(
        `INSERT INTO uniscenario.artifacts (
           id, workspace_id, revision_id, artifact_kind, media_type,
           storage_bucket, storage_key, sha256, byte_length, artifact_state,
           metadata, created_by_user_id, producer_job_family, producer_job_id, provenance
         ) VALUES (
           :id, :workspace_id, :revision_id, :artifact_kind, :media_type,
           :storage_bucket, :storage_key, :sha256, :byte_length, 'pending',
           CAST(:metadata AS jsonb), :user_id, 'artifact_postprocess', :job_id,
           CAST(:provenance AS jsonb)
         )
         RETURNING id, :artifact_role AS artifact_role,
           :sensor_actor_id AS artifact_sensor_actor_id,
           :sensor_id AS artifact_sensor_id,
           :sensor_modality AS artifact_sensor_modality,
           artifact_kind, media_type, sha256, byte_length, artifact_state,
           storage_bucket, storage_key, producer_job_id, false AS reused`,
        reservationParams,
      );
      // A failed/expired recording quarantines its immutable outputs. Reclaim
      // only an exact-byte quarantined row while holding this serialized local
      // transaction; available artifacts retain normal digest reuse.
      const reclaimed = existingDigest?.artifact_state === "quarantined"
        && existingDigest.media_type === declaration.mediaType
        && Number(existingDigest.byte_length) === declaration.sizeBytes
        ? await tx.queryOne<ArtifactRow>(
          `UPDATE uniscenario.artifacts
              SET revision_id = :revision_id, media_type = :media_type,
                  storage_bucket = :storage_bucket, storage_key = :storage_key,
                  byte_length = :byte_length, artifact_state = 'pending',
                  metadata = CAST(:metadata AS jsonb), deleted_at = NULL,
                  producer_job_family = 'artifact_postprocess',
                  producer_job_id = :job_id, provenance = CAST(:provenance AS jsonb)
            WHERE workspace_id = :workspace_id AND sha256 = :sha256
              AND artifact_kind = :artifact_kind AND artifact_state = 'quarantined'
            RETURNING id, :artifact_role AS artifact_role,
              :sensor_actor_id AS artifact_sensor_actor_id,
              :sensor_id AS artifact_sensor_id,
              :sensor_modality AS artifact_sensor_modality,
              artifact_kind, media_type, sha256, byte_length, artifact_state,
              storage_bucket, storage_key, producer_job_id, false AS reused`,
          reservationParams,
        )
        : null;
      const reusable = existingDigest
        && existingDigest.deleted_at === null
        && (
          existingDigest.artifact_state === "available"
          || (
            existingDigest.artifact_state === "pending"
            && existingDigest.producer_job_id === recordingId
          )
        )
        ? existingDigest
        : null;
      const artifact = reclaimed ?? inserted ?? reusable;
      const conflicting = artifact ? null : existingDigest;
      if (
        !artifact
        || artifact.sha256 !== declaration.sha256
        || artifact.media_type !== declaration.mediaType
        || Number(artifact.byte_length) !== declaration.sizeBytes
        || !["pending", "available"].includes(artifact.artifact_state)
      ) {
        throw new Error(
          `browser_recording_artifact_reservation_conflict:${declaration.role}:`
          + `${sensor?.sensorId ?? "global"}:${declaration.sha256.slice(0, 12)}:`
          + `${artifact?.artifact_state ?? conflicting?.artifact_state ?? "missing"}:`
          + `${conflicting?.producer_job_id ?? "no-producer"}:`
          + `${conflicting?.deleted_at ? "deleted" : "live"}`,
        );
      }
      await tx.execute(
        `INSERT INTO uniscenario.operational_job_artifact_links (
           id, workspace_id, artifact_id, job_family, job_id,
           attempt_id, relationship, artifact_role,
           artifact_sensor_actor_id, artifact_sensor_id, artifact_sensor_modality
         ) VALUES (
           :id, :workspace_id, :artifact_id, 'artifact_postprocess', :job_id,
           NULL, 'output', :artifact_role,
           :sensor_actor_id, :sensor_id, :sensor_modality
         )`,
        {
          id: uniscenarioId("usjal"),
          workspace_id: context.workspaceId,
          artifact_id: artifact.id,
          job_id: recordingId,
          artifact_role: declaration.role,
          sensor_actor_id: sensor?.actorId ?? null,
          sensor_id: sensor?.sensorId ?? null,
          sensor_modality: sensor?.modality ?? null,
        },
      );
      reservations.push({
        artifactId: artifact.id,
        role: declaration.role,
        sensor,
        mediaType: declaration.mediaType,
        sha256: declaration.sha256,
        storageBucket: artifact.storage_bucket,
        storageKey: artifact.storage_key,
        uploadRequired: artifact.artifact_state !== "available",
      });
    }
    await tx.execute(
      `UPDATE uniscenario.artifact_postprocess_jobs
          SET phase = 'uploading', progress = GREATEST(progress, 0.9),
              client_heartbeat_at = NOW(),
              expires_at = NOW() + (:session_ttl * INTERVAL '1 second'),
              updated_at = NOW()
        WHERE id = :job_id AND workspace_id = :workspace_id`,
      {
        workspace_id: context.workspaceId,
        job_id: recordingId,
        session_ttl: RECORDING_SESSION_TTL_SECONDS,
      },
    );
    await insertRecordingEvent(tx, {
      workspaceId: context.workspaceId,
      recordingId,
      type: "recording_artifacts_reserved",
      payload: { roles: input.artifacts.map((artifact) => artifact.role) },
    });
    return reservations;
  });
  if (!reserved) return null;
  return Promise.all(
    reserved.map(async (artifact) => ({
      artifactId: artifact.artifactId,
      role: artifact.role,
      sensor: artifact.sensor,
      uploadRequired: artifact.uploadRequired,
      uploadUrl: artifact.uploadRequired
        ? await getPresignedPutUrl(
            artifact.storageKey,
            artifact.mediaType,
            artifact.storageBucket,
            900,
            artifact.sha256,
          )
        : null,
      headers: checksumBoundPutRequiredHeaders(artifact.mediaType, artifact.sha256),
    })),
  );
}

export async function finalizeBrowserRecording(
  context: Pick<AppContext, "workspaceId">,
  recordingId: string,
  input: FinalizeBrowserRecordingInput,
) {
  await expireRecordingIfAbandoned(context.workspaceId, recordingId);
  const current = await readRecordingRow(context, recordingId);
  if (!current) return null;
  const request = BrowserRecordingRequestPayloadSchema.parse(
    parseJsonObject(current.request_payload),
  );
  const expected = declaredRecordingArtifacts(request.renderSpec);
  const completedClosure = input.artifacts.map((artifact) => ({
    role: artifact.role,
    sensor: "sensor" in artifact ? artifact.sensor : null,
  }));
  if (!expected || !exactArtifactClosure(expected, completedClosure)) return null;
  const artifacts = await readRecordingArtifacts(context, recordingId);
  const linkedClosure = artifacts.map((artifact) => ({
    role: artifact.artifact_role,
    sensor: artifact.artifact_sensor_actor_id
      && artifact.artifact_sensor_id
      && artifact.artifact_sensor_modality
      ? {
          actorId: artifact.artifact_sensor_actor_id,
          sensorId: artifact.artifact_sensor_id,
          modality: artifact.artifact_sensor_modality,
        }
      : null,
  }));
  if (!exactArtifactClosure(expected, linkedClosure)) return null;
  for (const artifact of artifacts) {
    const artifactKey = artifactIdentity({
      role: artifact.artifact_role,
      sensor: artifact.artifact_sensor_actor_id
        && artifact.artifact_sensor_id
        && artifact.artifact_sensor_modality
        ? {
            actorId: artifact.artifact_sensor_actor_id,
            sensorId: artifact.artifact_sensor_id,
            modality: artifact.artifact_sensor_modality,
          }
        : null,
    });
    const declared = input.artifacts.find((candidate) => {
      const candidateIdentity = artifactIdentity({
        role: candidate.role,
        sensor: "sensor" in candidate ? candidate.sensor : null,
      });
      return candidate.artifactId === artifact.id && candidateIdentity === artifactKey;
    });
    if (
      !declared
      || declared.sha256 !== artifact.sha256
      || declared.sizeBytes !== Number(artifact.byte_length)
      || !["pending", "available"].includes(artifact.artifact_state)
    ) {
      return null;
    }
    const head = await headS3Object(artifact.storage_key, artifact.storage_bucket);
    const checksum = head.checksumSha256
      ? Buffer.from(head.checksumSha256, "base64").toString("hex")
      : null;
    if (
      head.contentLength !== declared.sizeBytes
      || checksum !== declared.sha256
      || head.contentType !== artifact.media_type
    ) {
      throw new Error("browser_recording_artifact_upload_mismatch");
    }
  }
  const resultPayload: BrowserRecordingResultPayload = {
    contract: BROWSER_RECORDING_RESULT_CONTRACT,
    requestPayloadSha256: current.request_payload_sha256,
    artifacts: artifacts.map((artifact) => ({
      artifactId: artifact.id,
      role: artifact.artifact_role,
      sensor: artifact.artifact_sensor_actor_id
        && artifact.artifact_sensor_id
        && artifact.artifact_sensor_modality
        ? {
            actorId: artifact.artifact_sensor_actor_id,
            sensorId: artifact.artifact_sensor_id,
            modality: artifact.artifact_sensor_modality,
          }
        : null,
      kind: artifact.artifact_kind,
      mediaType: artifact.media_type,
      sha256: artifact.sha256,
      sizeBytes: Number(artifact.byte_length),
      reused: Boolean(artifact.reused),
    })),
    summary: input.summary,
  };
  const finalized = await withTransaction(async (tx) => {
    const result = await finalizeLocalArtifactProducerSet(
      {
        workspaceId: context.workspaceId,
        producerJobId: recordingId,
        artifacts: artifacts.map((artifact) => ({
          artifactId: artifact.id,
          role: artifact.artifact_role,
        })),
        resultPayload,
      },
      tx,
    );
    if (!result || result.alreadySucceeded) return result;
    await insertRecordingEvent(tx, {
      workspaceId: context.workspaceId,
      recordingId,
      type: "recording_succeeded",
      payload: { roles: artifacts.map((artifact) => artifact.artifact_role) },
    });
    return result;
  });
  return finalized ? getBrowserRecording(context, recordingId) : null;
}

export async function cancelBrowserRecording(
  context: Pick<AppContext, "workspaceId">,
  recordingId: string,
  reason: string,
) {
  await expireRecordingIfAbandoned(context.workspaceId, recordingId);
  const found = await withUniScenarioJobTransaction(recordingId, async (tx) => {
    const current = await tx.queryOne<{ state: string }>(
      `SELECT state FROM uniscenario.artifact_postprocess_jobs
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND postprocess_kind = 'browser_threejs_recording' FOR UPDATE`,
      { workspace_id: context.workspaceId, job_id: recordingId },
    );
    if (!current) return false;
    if (["succeeded", "failed", "cancelled"].includes(current.state)) return true;
    await tx.execute(
      `UPDATE uniscenario.artifact_postprocess_jobs
          SET state = 'cancelled', phase = 'cancelled',
              cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
              cancel_reason = COALESCE(cancel_reason, :reason),
              failure_code = COALESCE(failure_code, 'cancelled'),
              failure_detail = COALESCE(
                failure_detail, jsonb_build_object('reason', :reason, 'requestedBy', 'user')
              ),
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND state = 'running'`,
      { workspace_id: context.workspaceId, job_id: recordingId, reason },
    );
    await quarantinePendingArtifacts(tx, context.workspaceId, recordingId);
    await insertRecordingEvent(tx, {
      workspaceId: context.workspaceId,
      recordingId,
      type: "recording_cancelled",
      payload: { reason },
    });
    return true;
  });
  return found ? getBrowserRecording(context, recordingId) : null;
}

export async function failBrowserRecording(
  context: Pick<AppContext, "workspaceId">,
  recordingId: string,
  input: { code: string; detail: Record<string, JsonValue> },
) {
  await expireRecordingIfAbandoned(context.workspaceId, recordingId);
  const found = await withUniScenarioJobTransaction(recordingId, async (tx) => {
    const current = await tx.queryOne<{ state: string }>(
      `SELECT state FROM uniscenario.artifact_postprocess_jobs
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND postprocess_kind = 'browser_threejs_recording' FOR UPDATE`,
      { workspace_id: context.workspaceId, job_id: recordingId },
    );
    if (!current) return false;
    if (["succeeded", "failed", "cancelled"].includes(current.state)) return true;
    await tx.execute(
      `UPDATE uniscenario.artifact_postprocess_jobs
          SET state = 'failed', phase = 'failed', failure_code = :failure_code,
              failure_detail = CAST(:failure_detail AS jsonb),
              completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE id = :job_id AND workspace_id = :workspace_id
          AND state = 'running'`,
      {
        workspace_id: context.workspaceId,
        job_id: recordingId,
        failure_code: input.code,
        failure_detail: input.detail,
      },
    );
    await quarantinePendingArtifacts(tx, context.workspaceId, recordingId);
    await insertRecordingEvent(tx, {
      workspaceId: context.workspaceId,
      recordingId,
      type: "recording_failed",
      payload: { code: input.code, ...input.detail },
    });
    return true;
  });
  return found ? getBrowserRecording(context, recordingId) : null;
}
