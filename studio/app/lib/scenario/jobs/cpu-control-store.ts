import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { queryRows } from "@/app/lib/db/data-api";
import { getPresignedGetUrl, getPresignedPutUrl, headS3Object } from "@/app/lib/s3/s3-presign";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";
import { putS3Object } from "@/app/lib/s3/s3-put-object";
import {
  resolveCaptureManifest,
  ScenarioTemplateV2Schema,
} from "@simforge-oss/scenario";
import { BROWSER_RECORDING_ADAPTER_VERSION } from "../recording-contracts";
import {
  cancelCompilerExport,
  claimCompilerExport,
  completeCompilerExport,
  failCompilerExport,
  heartbeatCompilerExport,
  reserveCompilerOutputs,
} from "../compiler-control-store";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import { canonicalJsonSha256, sha256, scenarioId } from "../core";
import type { ScenarioCpuJobFamily, ScenarioJobFamily } from "./contracts";
import {
  claimFirstEligibleScenarioJob,
  settleArtifactPostprocessPipelineJob,
  settlePipelineJob,
  withScenarioJobTransaction,
  type JobTransaction,
} from "./lifecycle-lock";
import { simforgeEnv } from "@/lib/compat-env";
import { PLAYBACK_MEDIA_TYPE } from "../stored-wire-compat";

type CpuAttemptFamily = Exclude<ScenarioJobFamily, "openscenario_compile">;

type Candidate = {
  job_family: CpuAttemptFamily;
  job_id: string;
  workspace_id: string;
  revision_id: string;
  priority: number;
  created_at: string;
};

type ValidationSource = Candidate & {
  validator_kind: string;
  validator_version: string;
  artifact_id: string;
  storage_bucket: string;
  storage_key: string;
  media_type: string;
  artifact_sha256: string;
  byte_length: number;
  xsd_sha256: string;
  attempt_count: number;
  xodr_artifact_id: string | null;
  xodr_storage_bucket: string | null;
  xodr_storage_key: string | null;
  xodr_media_type: string | null;
  xodr_sha256: string | null;
  xodr_byte_length: number | null;
};

type PostprocessSource = Candidate & {
  job_mode: "cosmos_augment" | "vlm_annotate";
  parent_render_job_id: string;
  source_artifact_id: string;
  model_family: string;
  model_config: string;
  model_config_sha256: string;
  storage_bucket: string;
  storage_key: string;
  media_type: string;
  artifact_sha256: string;
  byte_length: number;
  attempt_count: number;
};

type BrowserRenderSource = Candidate & {
  document_id: string;
  dataset_id: string;
  map_version_id: string;
  revision_content: string;
  revision_sha256: string;
  map_id: string;
  xodr_sha256: string;
  render_spec: string;
  render_spec_sha256: string;
  render_intent: string;
  attempt_count: number;
  xosc_bucket: string;
  xosc_key: string;
  xosc_sha256: string;
  xosc_size: number;
  preview_bucket: string;
  preview_key: string;
  preview_sha256: string;
  preview_size: number;
};

type BrowserAssetMember = {
  relative_path: string;
  storage_bucket: string;
  storage_key: string;
  sha256: string;
  byte_length: number;
};

function artifactBucket() { return simforgeEnv("ARTIFACT_BUCKET")?.trim() || "local-artifacts"; }

async function browserClaimPayload(source: BrowserRenderSource) {
  const members = await queryRows<BrowserAssetMember>(
    `SELECT member.relative_path, blob.storage_bucket, blob.storage_key,
            blob.sha256, blob.byte_length
       FROM simforge.map_versions map
       JOIN simforge.browser_asset_sets asset_set
         ON asset_set.id = map.browser_asset_set_id
        AND asset_set.map_version_id = map.id
        AND asset_set.asset_set_state = 'available'
       JOIN simforge.browser_asset_members member
         ON member.asset_set_id = asset_set.id
       JOIN simforge.browser_asset_blobs blob
         ON blob.id = member.blob_id AND blob.verification_state = 'verified'
      WHERE map.id = :map_version_id
      ORDER BY member.relative_path`,
    { map_version_id: source.map_version_id },
  );
  if (!members.some((member) => member.relative_path === "3d/manifest.json")) {
    throw new Error("browser_render_map_manifest_missing");
  }

  const storedPreview = Buffer.from(
    await getS3ObjectBytes(source.preview_bucket, source.preview_key),
  );
  const decodedPreview =
    storedPreview[0] === 0x1f && storedPreview[1] === 0x8b
      ? gunzipSync(storedPreview)
      : storedPreview;
  const storedPlayback = parseJsonObject(decodedPreview.toString("utf8"));
  const instance = parseJsonObject(storedPlayback.instance as Record<string, unknown>);
  const input = parseJsonObject(instance.input as Record<string, unknown>);
  const trace = parseJsonObject(storedPlayback.trace as Record<string, unknown>);
  const ticks = parseJsonObject(trace.ticks as Record<string, unknown>);
  const previewTimes = Array.isArray(ticks.t)
    ? ticks.t.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    : [];
  const actors = Array.isArray(input.actors)
    ? input.actors.map((value) => {
        const actor = parseJsonObject(value as Record<string, unknown>);
        const initial = parseJsonObject(actor.initial as Record<string, unknown>);
        const pose = parseJsonObject(initial.pose as Record<string, unknown>);
        const tags = Array.isArray(actor.tags) ? actor.tags.filter((tag): tag is string => typeof tag === "string") : [];
        return {
          id: actor.id,
          kind: actor.kind,
          static: actor.static === true,
          tags,
          catalogId: tags.find((tag) => tag.startsWith("catalog:"))?.slice("catalog:".length),
          modelBasis: "input-tag",
          dims: actor.dims,
          initial: { x: pose.x, z: pose.z, headingRad: pose.headingRad },
        };
      })
    : [];
  const playback = {
    instance,
    trace,
    actors,
    props: Array.isArray(input.props) ? input.props : [],
    signals: [],
    source: { instanceName: "saved scenario", traceName: "saved simulation" },
    startTime: previewTimes[0] ?? 0,
    endTime: previewTimes.at(-1) ?? 0,
  };
  const playbackBytes = Buffer.from(JSON.stringify(playback));
  const playbackSha256 = sha256(playbackBytes);
  const playbackKey =
    `${source.workspace_id}/browser-render-inputs/playback/${playbackSha256}.json`;
  try {
    const existing = await headS3Object(playbackKey, artifactBucket());
    const expectedChecksum = Buffer.from(playbackSha256, "hex").toString("base64");
    if (
      existing.contentLength !== playbackBytes.byteLength ||
      existing.checksumSha256 !== expectedChecksum
    ) {
      throw new Error("browser_render_playback_object_mismatch");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "browser_render_playback_object_mismatch"
    ) {
      throw error;
    }
    await putS3Object(
      artifactBucket(),
      playbackKey,
      playbackBytes,
      PLAYBACK_MEDIA_TYPE,
    );
  }

  const template = ScenarioTemplateV2Schema.parse(
    parseJsonObject(source.revision_content),
  );
  const renderSpec = parseJsonObject(source.render_spec);
  const playbackRecord = playback as {
    instance?: unknown;
    trace?: {
      header?: { engineVersion?: unknown; version?: unknown };
      ticks?: { t?: unknown };
    };
  };
  const times = Array.isArray(playbackRecord.trace?.ticks?.t)
    ? playbackRecord.trace.ticks.t.filter(
        (time): time is number => typeof time === "number" && Number.isFinite(time),
      )
    : [];
  const playbackEnd = times.at(-1);
  if (typeof playbackEnd !== "number" || playbackEnd <= 0) {
    throw new Error("browser_render_playback_bounds_invalid");
  }
  const resolvedManifest = resolveCaptureManifest(renderSpec, {
    createdAt: new Date().toISOString(),
    scenarioRevision: {
      id: source.revision_id,
      contentSha256: source.revision_sha256,
    },
    playbackEvidence: {
      inputSha256: canonicalJsonSha256(playbackRecord.instance ?? {}),
      traceSha256: canonicalJsonSha256(playbackRecord.trace ?? {}),
      engineVersion:
        typeof playbackRecord.trace?.header?.engineVersion === "string"
          ? playbackRecord.trace.header.engineVersion
          : "@simforge-oss/engine/local",
      traceVersion:
        typeof playbackRecord.trace?.header?.version === "number"
          ? playbackRecord.trace.header.version
          : 1,
      bounds: { startSeconds: 0, endSeconds: playbackEnd, verified: true },
      identity: { complete: true, hashBound: true },
    },
    mapEvidence: {
      mapId: source.map_id,
      xodrSha256: source.xodr_sha256,
    },
    renderer: {
      id: "simforge-city-renderer",
      version: BROWSER_RECORDING_ADAPTER_VERSION,
      availableCapabilities: [
        "environment.authored",
        "timing.fixed_step",
        "sensor.rgb",
        "sensor.depth",
        "sensor.semantic",
        "sensor.instance",
        "sensor.lidar",
        "sensor.radar",
        "artifact.video",
        "artifact.manifest",
        "artifact.frames",
        "artifact.sensor_archive",
        "artifact.sensor_video",
        // The browser recording adapter derives these from the immutable
        // playback evidence carried by the claim. They are not frame-capture
        // products of the Three.js renderer itself.
        "artifact.trace",
        "artifact.annotations",
      ],
    },
    revisionEnvironment: {
      authoritativeEnvironment: template.environment,
      operationalConditions: {
        weather: "clear",
        timeOfDay: "day",
        traffic: "moderate",
        visibility: "unrestricted",
        effects: {
          visibilityRangeM: 1_000,
          frictionScale: 1,
          trafficSpeedFactor: 1,
        },
      },
    },
  });

  const mapInputs = await Promise.all(
    members.map(async (member) => {
      const inputId =
        member.relative_path === "3d/manifest.json"
          ? "map.manifest"
          : `map/${member.relative_path}`;
      return {
        inputId,
        relativePath: member.relative_path,
        sha256: member.sha256,
        sizeBytes: Number(member.byte_length),
        download: {
          url: await getPresignedGetUrl(
            member.storage_key,
            member.storage_bucket,
          ),
          headers: {},
        },
      };
    }),
  );
  const playbackInput = {
    inputId: "playback.bundle",
    relativePath: "playback.bundle",
    sha256: playbackSha256,
    sizeBytes: playbackBytes.byteLength,
    download: {
      url: await getPresignedGetUrl(playbackKey, artifactBucket()),
      headers: {},
    },
  };
  const storedIntent = parseJsonObject(source.render_intent);
  const intent = {
    ...storedIntent,
    engine: "browser",
    schedule: resolvedManifest.schedule,
    assets: [
      ...mapInputs.map((member) => ({
        assetId: member.inputId,
        kind: member.inputId === "map.manifest" ? "map" : "other",
        sha256: member.sha256,
        sizeBytes: member.sizeBytes,
      })),
      {
        assetId: playbackInput.inputId,
        kind: "other",
        sha256: playbackInput.sha256,
        sizeBytes: playbackInput.sizeBytes,
      },
    ],
  };
  return {
    engine: "browser" as const,
    intent,
    intentSha256: canonicalJsonSha256(intent),
    inputs: [
      {
        inputId: "scenario.xosc",
        relativePath: "scenario.xosc",
        sha256: source.xosc_sha256,
        sizeBytes: Number(source.xosc_size),
        download: {
          url: await getPresignedGetUrl(source.xosc_key, source.xosc_bucket),
          headers: {},
        },
      },
      ...mapInputs,
      playbackInput,
    ],
    recording: {
      revisionId: source.revision_id,
      documentId: source.document_id,
      renderSpec,
      resolvedManifest,
      idempotencyKey: `browser-render-${source.job_id}`,
    },
  };
}

async function insertCpuEvent(
  tx: JobTransaction,
  input: { workspaceId: string; jobFamily: ScenarioJobFamily; jobId: string; attemptId?: string | null; type: string; payload?: Record<string, unknown> },
) {
  await tx.execute(
    `INSERT INTO simforge.operational_job_events (
         id, workspace_id, job_family, job_id, attempt_id, event_ordinal, event_type, event_payload
       ) VALUES (
         :id, :workspace_id, :job_family, :job_id, :attempt_id,
         (SELECT COALESCE(MAX(event_ordinal), 0) + 1
            FROM simforge.operational_job_events
           WHERE job_family = :job_family AND job_id = :job_id),
         :event_type, CAST(:event_payload AS jsonb)
       )`,
    {
      id: scenarioId("usje"),
      workspace_id: input.workspaceId,
      job_family: input.jobFamily,
      job_id: input.jobId,
      attempt_id: input.attemptId ?? null,
      event_type: input.type,
      event_payload: input.payload ?? {},
    },
  );
}

async function expireCpuAttempts() {
  const candidates = await queryRows<{ job_family: CpuAttemptFamily; job_id: string }>(
    `SELECT 'openscenario_validate'::text AS job_family, job.id AS job_id
       FROM simforge.validation_runs job
      WHERE job.validation_state = 'running' AND (
        EXISTS (SELECT 1 FROM simforge.cpu_job_attempts attempt
                 WHERE attempt.job_family = 'openscenario_validate' AND attempt.job_id = job.id
                   AND attempt.attempt_state = 'active' AND attempt.expires_at <= NOW())
        OR NOT EXISTS (SELECT 1 FROM simforge.cpu_job_attempts attempt
                       WHERE attempt.job_family = 'openscenario_validate' AND attempt.job_id = job.id
                         AND attempt.attempt_state = 'active')
      )
      UNION ALL
     SELECT 'artifact_postprocess'::text, job.id
       FROM simforge.render_jobs job
      WHERE job.job_state IN ('leased', 'running')
        AND job.job_mode IN ('cosmos_augment', 'vlm_annotate') AND (
          EXISTS (SELECT 1 FROM simforge.cpu_job_attempts attempt
                   WHERE attempt.job_family = 'artifact_postprocess' AND attempt.job_id = job.id
                     AND attempt.attempt_state = 'active' AND attempt.expires_at <= NOW())
          OR NOT EXISTS (SELECT 1 FROM simforge.cpu_job_attempts attempt
                         WHERE attempt.job_family = 'artifact_postprocess' AND attempt.job_id = job.id
                           AND attempt.attempt_state = 'active')
        )
      UNION ALL
     SELECT 'openscenario_render'::text, job.id
       FROM simforge.render_jobs job
      WHERE job.job_state IN ('leased', 'running')
        AND job.job_mode = 'browser_render' AND (
          EXISTS (SELECT 1 FROM simforge.cpu_job_attempts attempt
                   WHERE attempt.job_family = 'openscenario_render' AND attempt.job_id = job.id
                     AND attempt.attempt_state = 'active' AND attempt.expires_at <= NOW())
          OR NOT EXISTS (SELECT 1 FROM simforge.cpu_job_attempts attempt
                         WHERE attempt.job_family = 'openscenario_render' AND attempt.job_id = job.id
                           AND attempt.attempt_state = 'active')
        )
      ORDER BY job_id LIMIT 100`,
  );
  for (const candidate of candidates) {
    await withScenarioJobTransaction(candidate.job_id, async (tx) => {
      const validation = candidate.job_family === "openscenario_validate";
      const family = candidate.job_family;
      const table = validation ? "validation_runs" : "render_jobs";
      const stateColumn = validation ? "validation_state" : "job_state";
      const activeStates = validation ? "('running')" : "('leased', 'running')";
      const modeFilter = family === "artifact_postprocess"
        ? "AND job.job_mode IN ('cosmos_augment', 'vlm_annotate')"
        : family === "openscenario_render"
          ? "AND job.job_mode = 'browser_render'"
          : "";
      const expiredAttempt = await tx.queryOne<{ id: string }>(
        `UPDATE simforge.cpu_job_attempts attempt
            SET attempt_state = CASE WHEN job.cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'expired' END,
                completed_at = NOW(),
                failure_code = CASE WHEN job.cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE attempt.failure_code END
           FROM simforge.${table} job
          WHERE job.id = :job_id AND attempt.job_family = :job_family AND attempt.job_id = job.id
            AND attempt.attempt_state = 'active' AND attempt.expires_at <= NOW()
          RETURNING attempt.id`,
        { job_id: candidate.job_id, job_family: family },
      );
      const terminalized = await tx.queryOne<{
        id: string;
        workspace_id: string;
        state: "queued" | "failed" | "cancelled";
      }>(
        `UPDATE simforge.${table} job
              SET ${stateColumn} = CASE
                    WHEN job.cancel_requested_at IS NOT NULL THEN 'cancelled'
                    WHEN job.attempt_count < job.max_attempts THEN 'queued'
                    ELSE 'failed'
                  END,
                  failure_code = CASE
                    WHEN job.cancel_requested_at IS NOT NULL THEN COALESCE(job.failure_code, 'cancelled')
                    WHEN job.attempt_count < job.max_attempts THEN NULL
                    ELSE 'cpu_attempts_exhausted'
                  END,
                  completed_at = CASE
                    WHEN job.cancel_requested_at IS NOT NULL OR job.attempt_count >= job.max_attempts
                      THEN COALESCE(job.completed_at, NOW()) ELSE NULL END,
                  updated_at = NOW()
            WHERE job.id = :job_id AND job.${stateColumn} IN ${activeStates}
              ${modeFilter}
              AND NOT EXISTS (
                SELECT 1 FROM simforge.cpu_job_attempts attempt
                 WHERE attempt.job_family = :job_family AND attempt.job_id = job.id
                   AND attempt.attempt_state = 'active'
              )
          RETURNING job.id, job.workspace_id, job.${stateColumn} AS state`,
        { job_id: candidate.job_id, job_family: family },
      );
      if (!terminalized) return;
      await insertCpuEvent(tx, {
        workspaceId: terminalized.workspace_id,
        jobFamily: family,
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
          jobFamily: family,
          jobId: terminalized.id,
          outcome: terminalized.state,
        });
      }
    });
  }
}

async function claimValidationOrPostprocess(input: {
  workerId: string;
  leaseSeconds: number;
  families: readonly ScenarioCpuJobFamily[];
}) {
  await expireCpuAttempts();
  const legs: string[] = [];
  if (input.families.includes("openscenario_validate")) {
    legs.push(
      `SELECT 'openscenario_validate'::text AS job_family, v.id AS job_id,
              v.workspace_id, v.revision_id, v.priority::int, v.created_at::text
         FROM simforge.validation_runs v
        WHERE v.validation_state = 'queued' AND v.cancel_requested_at IS NULL
          AND v.attempt_count < v.max_attempts
          AND EXISTS (
            SELECT 1 FROM simforge.exports e
            JOIN simforge.execution_packages ep
              ON ep.id = e.execution_package_id AND ep.workspace_id = e.workspace_id
            JOIN simforge.artifacts a
              ON a.id = ep.xosc_artifact_id AND a.workspace_id = ep.workspace_id
            WHERE e.workspace_id = v.workspace_id AND e.revision_id = v.revision_id
              AND e.export_state = 'succeeded' AND a.artifact_state = 'available'
          )`,
    );
  }
  if (input.families.includes("openscenario_render")) {
    legs.push(
      `SELECT 'openscenario_render'::text AS job_family, j.id AS job_id,
              j.workspace_id, j.revision_id, j.priority::int, j.created_at::text
         FROM simforge.render_jobs j
        WHERE j.job_state = 'queued' AND j.cancel_requested_at IS NULL
          AND j.attempt_count < j.max_attempts
          AND j.job_mode = 'browser_render'`,
    );
  }
  if (input.families.includes("artifact_postprocess")) {
    // Every leg carries its own aliases: any leg can be first (or alone) depending on the
    // requested families, and the outer ORDER BY needs job_id by name.
    legs.push(
      `SELECT 'artifact_postprocess'::text AS job_family, j.id AS job_id,
              j.workspace_id, j.revision_id, j.priority::int, j.created_at::text
         FROM simforge.render_jobs j
        WHERE j.job_state = 'queued' AND j.cancel_requested_at IS NULL
          AND j.attempt_count < j.max_attempts
          AND j.job_mode IN ('cosmos_augment', 'vlm_annotate')`,
    );
  }
  if (legs.length === 0) return null;
  const candidates = await queryRows<Candidate>(
    `SELECT * FROM (
         ${legs.join("\n         UNION ALL\n")}
       ) candidates
       ORDER BY priority DESC, created_at, job_id LIMIT 16`,
  );
  const claimed = await claimFirstEligibleScenarioJob(
    candidates,
    (candidate) => candidate.job_id,
    async (tx, candidate) => {
      const fenceToken = randomBytes(32).toString("hex");
      const attemptId = scenarioId("uscat");
    const expiry = await tx.queryOne<{ expires_at: string }>(
      `SELECT to_char(
         (NOW() + (:lease_seconds * INTERVAL '1 second')) AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       ) AS expires_at`,
      { lease_seconds: input.leaseSeconds },
    );
    if (!expiry) throw new Error("Unable to compute CPU job lease expiry.");

    let source: ValidationSource | PostprocessSource | BrowserRenderSource | null = null;
    if (candidate.job_family === "openscenario_render") {
      source = await tx.queryOne<BrowserRenderSource>(
        `SELECT 'openscenario_render'::text AS job_family, j.id AS job_id, j.workspace_id,
                j.revision_id, j.priority::int, j.created_at::text,
                r.document_id, d.dataset_id, r.map_version_id,
                r.canonical_content::text AS revision_content,
                r.content_sha256 AS revision_sha256,
                COALESCE(NULLIF(mv.source_map_id, ''), mv.id) AS map_id,
                xodr.sha256 AS xodr_sha256,
                j.render_spec::text AS render_spec, j.render_spec_sha256,
                j.render_intent::text AS render_intent, j.attempt_count,
                xosc.storage_bucket AS xosc_bucket, xosc.storage_key AS xosc_key,
                xosc.sha256 AS xosc_sha256, xosc.byte_length AS xosc_size,
                preview.storage_bucket AS preview_bucket, preview.storage_key AS preview_key,
                preview.sha256 AS preview_sha256, preview.byte_length AS preview_size
           FROM simforge.render_jobs j
           JOIN simforge.revisions r
             ON r.id = j.revision_id AND r.workspace_id = j.workspace_id
           JOIN simforge.documents d
             ON d.id = r.document_id AND d.workspace_id = r.workspace_id
            AND d.deleted_at IS NULL
           JOIN simforge.map_versions mv ON mv.id = r.map_version_id
           JOIN simforge.artifacts xodr
             ON xodr.id = mv.xodr_artifact_id AND xodr.artifact_state = 'available'
           JOIN simforge.execution_packages ep
             ON ep.id = j.execution_package_id AND ep.workspace_id = j.workspace_id
           JOIN simforge.artifacts xosc
             ON xosc.id = ep.xosc_artifact_id AND xosc.workspace_id = ep.workspace_id
            AND xosc.artifact_state = 'available'
           JOIN simforge.simulation_previews simulation
             ON simulation.document_id = r.document_id
            AND simulation.workspace_id = r.workspace_id
            AND simulation.source_draft_version = r.source_draft_version
            AND simulation.source_content_sha256 = r.content_sha256
            AND simulation.map_version_id = r.map_version_id
           JOIN simforge.artifacts preview
             ON preview.id = simulation.artifact_id
            AND preview.workspace_id = simulation.workspace_id
            AND preview.artifact_state = 'available'
          WHERE j.id = :job_id AND j.job_state = 'queued' AND j.cancel_requested_at IS NULL
            AND j.attempt_count < j.max_attempts
            AND j.job_mode = 'browser_render'
          FOR UPDATE OF j SKIP LOCKED`,
        { job_id: candidate.job_id },
      );
      if (!source) return null;
      await tx.execute(
        `UPDATE simforge.render_jobs
            SET job_state = 'running', attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, NOW()), updated_at = NOW(),
                failure_code = NULL, failure_detail = NULL
          WHERE id = :job_id`,
        { job_id: source.job_id },
      );
    } else if (candidate.job_family === "openscenario_validate") {
      source = await tx.queryOne<ValidationSource>(
        `SELECT 'openscenario_validate'::text AS job_family, v.id AS job_id, v.workspace_id,
                v.revision_id, v.priority::int, v.created_at::text, v.validator_kind,
                v.validator_version, a.id AS artifact_id, a.storage_bucket, a.storage_key,
                a.media_type, a.sha256 AS artifact_sha256, a.byte_length, ep.xsd_sha256,
                v.attempt_count,
                xodr.id AS xodr_artifact_id, xodr.storage_bucket AS xodr_storage_bucket,
                xodr.storage_key AS xodr_storage_key, xodr.media_type AS xodr_media_type,
                xodr.sha256 AS xodr_sha256, xodr.byte_length AS xodr_byte_length
           FROM simforge.validation_runs v
           JOIN LATERAL (
             SELECT e.execution_package_id FROM simforge.exports e
              WHERE e.workspace_id = v.workspace_id AND e.revision_id = v.revision_id
                AND e.export_state = 'succeeded' AND e.execution_package_id IS NOT NULL
              ORDER BY e.completed_at DESC, e.id DESC LIMIT 1
           ) latest ON TRUE
           JOIN simforge.execution_packages ep
             ON ep.id = latest.execution_package_id AND ep.workspace_id = v.workspace_id
           JOIN simforge.artifacts a
             ON a.id = ep.xosc_artifact_id AND a.workspace_id = ep.workspace_id
            AND a.artifact_state = 'available'
           JOIN simforge.revisions r
             ON r.id = v.revision_id AND r.workspace_id = v.workspace_id
           LEFT JOIN simforge.map_versions mv ON mv.id = r.map_version_id
           LEFT JOIN simforge.artifacts xodr
             ON xodr.id = mv.xodr_artifact_id AND xodr.artifact_state = 'available'
          WHERE v.id = :job_id AND v.validation_state = 'queued'
            AND v.cancel_requested_at IS NULL AND v.attempt_count < v.max_attempts
          FOR UPDATE OF v SKIP LOCKED`,
        { job_id: candidate.job_id },
      );
      if (!source) return null;
      await tx.execute(
        `UPDATE simforge.validation_runs
            SET validation_state = 'running', attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, NOW()), updated_at = NOW(),
                failure_code = NULL, failure_detail = NULL
          WHERE id = :job_id`,
        { job_id: source.job_id },
      );
    } else {
      source = await tx.queryOne<PostprocessSource>(
        `SELECT 'artifact_postprocess'::text AS job_family, j.id AS job_id, j.workspace_id,
                j.revision_id, j.priority::int, j.created_at::text, j.job_mode,
                j.parent_render_job_id, j.source_artifact_id, j.model_family,
                j.model_config::text, j.model_config_sha256,
                a.storage_bucket, a.storage_key, a.media_type,
                a.sha256 AS artifact_sha256, a.byte_length, j.attempt_count
           FROM simforge.render_jobs j
           JOIN simforge.artifacts a
             ON a.id = j.source_artifact_id AND a.workspace_id = j.workspace_id
            AND a.artifact_state = 'available' AND a.deleted_at IS NULL
          WHERE j.id = :job_id AND j.job_state = 'queued' AND j.cancel_requested_at IS NULL
            AND j.attempt_count < j.max_attempts
            AND j.job_mode IN ('cosmos_augment', 'vlm_annotate')
          FOR UPDATE OF j SKIP LOCKED`,
        { job_id: candidate.job_id },
      );
      if (!source) return null;
      await tx.execute(
        `UPDATE simforge.render_jobs
            SET job_state = 'running', attempt_count = attempt_count + 1,
                started_at = COALESCE(started_at, NOW()), updated_at = NOW(),
                failure_code = NULL, failure_detail = NULL
          WHERE id = :job_id`,
        { job_id: source.job_id },
      );
    }
    await tx.execute(
      `INSERT INTO simforge.cpu_job_attempts (
         id, workspace_id, job_family, job_id, attempt_number, worker_id,
         fence_token_sha256, expires_at
       ) VALUES (
         :id, :workspace_id, :job_family, :job_id, :attempt_number, :worker_id,
         :fence_token_sha256, CAST(:expires_at AS timestamptz)
       )`,
      {
        id: attemptId,
        workspace_id: source.workspace_id,
        job_family: source.job_family,
        job_id: source.job_id,
        attempt_number: Number(source.attempt_count) + 1,
        worker_id: input.workerId,
        fence_token_sha256: sha256(fenceToken),
        expires_at: expiry.expires_at,
      },
    );
    await insertCpuEvent(tx, {
      workspaceId: source.workspace_id,
      jobFamily: source.job_family,
      jobId: source.job_id,
      attemptId,
      type: "leased",
      payload: { workerId: input.workerId },
    });
    return { source, expiresAt: expiry.expires_at, attemptId, fenceToken };
    },
  );
  if (!claimed) return null;
  const common = {
    contract: "uniscenario.cpu-job-claim/v1" as const,
    jobFamily: claimed.source.job_family,
    jobId: claimed.source.job_id,
    attemptId: claimed.attemptId,
    fenceToken: claimed.fenceToken,
    leaseExpiresAt: claimed.expiresAt,
  };
  if (claimed.source.job_family === "openscenario_render") {
    const source = claimed.source as BrowserRenderSource;
    return {
      ...common,
      payload: {
        mode: "browser_render" as const,
        ...(await browserClaimPayload(source)),
      },
    };
  }
  if (claimed.source.job_family === "openscenario_validate") {
    const source = claimed.source as ValidationSource;
    return {
      ...common,
      payload: {
        validatorKind: source.validator_kind,
        validatorVersion: source.validator_version,
        revisionId: source.revision_id,
        xsdSha256: source.xsd_sha256,
        source: {
          artifactId: source.artifact_id,
          mediaType: source.media_type,
          sha256: source.artifact_sha256,
          sizeBytes: Number(source.byte_length),
          downloadUrl: await getPresignedGetUrl(source.storage_key, source.storage_bucket),
        },
        // The revision's OpenDRIVE, for validators that execute the scenario (esmini). Absent only
        // when the map version predates xodr artifacts; XSD-only validation ignores it.
        mapSource: source.xodr_artifact_id && source.xodr_storage_key && source.xodr_storage_bucket
          ? {
              artifactId: source.xodr_artifact_id,
              mediaType: source.xodr_media_type ?? "application/xml",
              sha256: source.xodr_sha256 ?? "",
              sizeBytes: Number(source.xodr_byte_length ?? 0),
              downloadUrl: await getPresignedGetUrl(source.xodr_storage_key, source.xodr_storage_bucket),
            }
          : null,
      },
    };
  }
  const source = claimed.source as PostprocessSource;
  return {
    ...common,
    payload: {
      mode: source.job_mode,
      parentRenderJobId: source.parent_render_job_id,
      sourceArtifactId: source.source_artifact_id,
      modelFamily: source.model_family,
      modelConfig: parseJsonObject(source.model_config),
      modelConfigSha256: source.model_config_sha256,
      source: {
        artifactId: source.source_artifact_id,
        mediaType: source.media_type,
        sha256: source.artifact_sha256,
        sizeBytes: Number(source.byte_length),
        downloadUrl: await getPresignedGetUrl(source.storage_key, source.storage_bucket),
      },
    },
  };
}

export async function claimCpuJob(input: {
  workerId: string;
  leaseSeconds: number;
  families?: readonly ScenarioCpuJobFamily[];
}) {
  const families = input.families ?? ["openscenario_compile", "openscenario_validate", "artifact_postprocess"];
  // Compilation is the prerequisite for validation and render, so it is intentionally drained first.
  if (families.includes("openscenario_compile")) {
    const compile = await claimCompilerExport(input);
    if (compile) {
      return {
        contract: "uniscenario.cpu-job-claim/v1" as const,
        jobFamily: "openscenario_compile" as const,
        jobId: compile.exportId,
        attemptId: compile.attemptId,
        fenceToken: compile.fenceToken,
        leaseExpiresAt: compile.leaseExpiresAt,
        payload: compile,
      };
    }
  }
  return claimValidationOrPostprocess({ ...input, families });
}

async function activeCpuAttempt(jobId: string, attemptId: string, fenceToken: string) {
  const rows = await queryRows<{
    workspace_id: string;
    job_family: CpuAttemptFamily;
  }>(
    `SELECT attempt.workspace_id, attempt.job_family FROM simforge.cpu_job_attempts attempt
      WHERE attempt.id = :attempt_id AND attempt.job_id = :job_id
        AND attempt.attempt_state = 'active' AND attempt.expires_at > NOW()
        AND attempt.fence_token_sha256 = :fence_token_sha256
        AND (
          (attempt.job_family = 'openscenario_validate' AND EXISTS (
            SELECT 1 FROM simforge.validation_runs job
             WHERE job.id = attempt.job_id AND job.validation_state = 'running'
               AND job.cancel_requested_at IS NULL
          ))
          OR (attempt.job_family = 'artifact_postprocess' AND EXISTS (
            SELECT 1 FROM simforge.render_jobs job
             WHERE job.id = attempt.job_id AND job.job_state = 'running'
               AND job.cancel_requested_at IS NULL
          ))
          OR (attempt.job_family = 'openscenario_render' AND EXISTS (
            SELECT 1 FROM simforge.render_jobs job
             WHERE job.id = attempt.job_id AND job.job_state = 'running'
               AND job.job_mode = 'browser_render'
               AND job.cancel_requested_at IS NULL
          ))
        )
      LIMIT 1`,
    {
      attempt_id: attemptId,
      job_id: jobId,
      fence_token_sha256: sha256(fenceToken),
    },
  );
  return rows[0] ?? null;
}

export async function heartbeatCpuJob(
  jobId: string,
  input: {
    jobFamily: ScenarioJobFamily;
    attemptId: string;
    fenceToken: string;
    leaseSeconds: number;
    progress?: number;
  },
) {
  if (input.jobFamily === "openscenario_compile") {
    const heartbeat = await heartbeatCompilerExport(jobId, input);
    if (!heartbeat) return null;
    const state = await queryRows<{ cancel_requested: boolean }>(
      `SELECT cancel_requested_at IS NOT NULL AS cancel_requested
         FROM simforge.exports WHERE id = :job_id LIMIT 1`,
      { job_id: jobId },
    );
    return {
      ...heartbeat,
      cancelRequested: state[0]?.cancel_requested ?? false,
    };
  }
  return withScenarioJobTransaction(jobId, async (tx) => {
    const rows = await tx.queryRows<{ expires_at: string; workspace_id: string }>(
      `UPDATE simforge.cpu_job_attempts SET heartbeat_at = NOW(),
         progress = GREATEST(progress, :progress),
         expires_at = NOW() + (:lease_seconds * INTERVAL '1 second')
       WHERE id = :attempt_id AND job_id = :job_id AND job_family = :job_family
         AND attempt_state = 'active' AND expires_at > NOW()
         AND fence_token_sha256 = :fence_token_sha256
         AND (
           (:job_family = 'openscenario_validate' AND EXISTS (
             SELECT 1 FROM simforge.validation_runs job
              WHERE job.id = :job_id AND job.cancel_requested_at IS NULL
                AND job.validation_state = 'running'
           )) OR (:job_family = 'artifact_postprocess' AND EXISTS (
             SELECT 1 FROM simforge.render_jobs job
              WHERE job.id = :job_id AND job.cancel_requested_at IS NULL
                AND job.job_state = 'running'
           )) OR (:job_family = 'openscenario_render' AND EXISTS (
             SELECT 1 FROM simforge.render_jobs job
              WHERE job.id = :job_id AND job.cancel_requested_at IS NULL
                AND job.job_state = 'running' AND job.job_mode = 'browser_render'
           ))
         )
       RETURNING workspace_id, to_char(expires_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`,
      {
        attempt_id: input.attemptId,
        job_id: jobId,
        job_family: input.jobFamily,
        progress: input.progress ?? 0,
        lease_seconds: input.leaseSeconds,
        fence_token_sha256: sha256(input.fenceToken),
      },
    );
    if (!rows[0]) return null;
    const table = input.jobFamily === "openscenario_validate" ? "validation_runs" : "render_jobs";
    const state = await tx.queryRows<{ cancel_requested: boolean }>(
      `UPDATE simforge.${table} SET progress = GREATEST(progress, :progress), updated_at = NOW()
        WHERE id = :job_id AND cancel_requested_at IS NULL
      RETURNING false AS cancel_requested`,
      { job_id: jobId, progress: input.progress ?? 0 },
    );
    if (!state[0]) return null;
    return { expires_at: rows[0].expires_at, cancelRequested: false };
  });
}

export async function reserveCpuJobOutputs(
  jobId: string,
  input: {
    jobFamily: ScenarioJobFamily;
    attemptId: string;
    fenceToken: string;
    artifacts: Array<{
      kind: string;
      mediaType: string;
      sha256: string;
      sizeBytes: number;
    }>;
  },
) {
  if (input.jobFamily === "openscenario_compile") {
    return reserveCompilerOutputs(jobId, {
      ...input,
      artifacts: input.artifacts as Parameters<typeof reserveCompilerOutputs>[1]["artifacts"],
    });
  }
  const expectedKinds = input.jobFamily === "openscenario_validate" ? new Set(["validation-report", "state-trace"]) : new Set(["postprocess-result", "postprocess-provenance"]);
  if (input.artifacts.some((item) => !expectedKinds.has(item.kind))) {
    throw new Error("cpu_job_artifact_kind_invalid");
  }
  const bucket = artifactBucket();
  const table = input.jobFamily === "openscenario_validate" ? "validation_runs" : "render_jobs";
  const stateColumn = input.jobFamily === "openscenario_validate" ? "validation_state" : "job_state";
  const reserved = await withScenarioJobTransaction(jobId, async (tx) => {
    const owner = await tx.queryOne<{ workspace_id: string; revision_id: string }>(
      `SELECT job.workspace_id, job.revision_id
         FROM simforge.${table} job
         JOIN simforge.cpu_job_attempts attempt
           ON attempt.job_id = job.id AND attempt.job_family = :job_family
        WHERE job.id = :job_id AND job.${stateColumn} = 'running'
          AND job.cancel_requested_at IS NULL
          AND attempt.id = :attempt_id AND attempt.attempt_state = 'active'
          AND attempt.expires_at > NOW()
          AND attempt.fence_token_sha256 = :fence_token_sha256`,
      {
        job_id: jobId,
        job_family: input.jobFamily,
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
      const key = `${owner.workspace_id}/jobs/${input.jobFamily}/${jobId}/sha256/${item.sha256}/${item.kind}`;
      const rows = await tx.queryRows<{
        id: string;
        artifact_state: string;
        storage_bucket: string;
        storage_key: string;
      }>(
        `INSERT INTO simforge.artifacts (
         id, workspace_id, revision_id, artifact_kind, media_type, storage_bucket, storage_key,
         sha256, byte_length, artifact_state, metadata, producer_job_family, producer_job_id,
         producer_attempt_id, provenance
       ) VALUES (
         :id, :workspace_id, :revision_id, :artifact_kind, :media_type, :bucket, :storage_key,
         :sha256, :byte_length, 'pending', CAST(:metadata AS jsonb), :job_family, :job_id,
         :attempt_id, CAST(:provenance AS jsonb)
       ) ON CONFLICT (workspace_id, sha256, artifact_kind)
       WHERE artifact_state IN ('pending', 'available') AND deleted_at IS NULL
       DO UPDATE SET sha256 = EXCLUDED.sha256
       RETURNING id, artifact_state, storage_bucket, storage_key`,
        {
          id: scenarioId("usart"),
          workspace_id: owner.workspace_id,
          revision_id: owner.revision_id,
          artifact_kind: item.kind,
          media_type: item.mediaType,
          bucket,
          storage_key: key,
          sha256: item.sha256,
          byte_length: item.sizeBytes,
          metadata: { producerJobFamily: input.jobFamily, producerJobId: jobId },
          job_family: input.jobFamily,
          job_id: jobId,
          attempt_id: input.attemptId,
          provenance: {
            contract: "uniscenario.artifact-provenance/v1",
            producerJobFamily: input.jobFamily,
            producerJobId: jobId,
            producerAttemptId: input.attemptId,
          },
        },
      );
      const row = rows[0];
      if (!row) throw new Error("cpu_job_artifact_reservation_failed");
      await tx.execute(
        `INSERT INTO simforge.operational_job_artifact_links (
         id, workspace_id, artifact_id, job_family, job_id, attempt_id, relationship
       ) VALUES (
         :id, :workspace_id, :artifact_id, :job_family, :job_id, :attempt_id, :relationship
       ) ON CONFLICT DO NOTHING RETURNING id`,
        {
          id: scenarioId("usjal"),
          workspace_id: owner.workspace_id,
          artifact_id: row.id,
          job_family: input.jobFamily,
          job_id: jobId,
          attempt_id: input.attemptId,
          relationship: item.kind === "validation-report" ? "report" : item.kind === "postprocess-provenance" ? "provenance" : "output",
        },
      );
      reservations.push({ row, item });
    }
    await insertCpuEvent(tx, {
      workspaceId: owner.workspace_id,
      jobFamily: input.jobFamily,
      jobId,
      attemptId: input.attemptId,
      type: "artifacts_reserved",
      payload: { kinds: input.artifacts.map((item) => item.kind) },
    });
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

export async function completeCpuJob(
  jobId: string,
  input: {
    jobFamily: ScenarioJobFamily;
    attemptId: string;
    fenceToken: string;
    artifacts: Array<{
      id: string;
      kind: string;
      sha256: string;
      sizeBytes: number;
    }>;
    compile?: {
      manifestSha256: string;
      xsdSha256: string;
      sourceInputDigest: string;
    };
    validation?: {
      outcome: "passed" | "failed";
      summary: Record<string, unknown>;
    };
    postprocess?: { provenance: Record<string, unknown> };
    browserRender?: { recordingJobId: string };
  },
) {
  if (input.jobFamily === "openscenario_compile") {
    if (!input.compile) throw new Error("compile_completion_required");
    return completeCompilerExport(jobId, {
      ...input,
      artifacts: input.artifacts as Parameters<typeof completeCompilerExport>[1]["artifacts"],
      ...input.compile,
    });
  }
  const attempt = await activeCpuAttempt(jobId, input.attemptId, input.fenceToken);
  if (!attempt || attempt.job_family !== input.jobFamily) return null;
  if (input.jobFamily !== "openscenario_render") {
    const rows = await queryRows<{
      id: string;
      artifact_kind: string;
      storage_bucket: string;
      storage_key: string;
      sha256: string;
      byte_length: number;
    }>(
      `SELECT a.id, a.artifact_kind, a.storage_bucket, a.storage_key, a.sha256, a.byte_length
         FROM simforge.operational_job_artifact_links l
         JOIN simforge.artifacts a ON a.id = l.artifact_id AND a.workspace_id = l.workspace_id
        WHERE l.job_family = :job_family AND l.job_id = :job_id
          AND l.attempt_id = :attempt_id
          AND a.id = ANY(string_to_array(:artifact_ids, ','))`,
      {
        job_family: input.jobFamily,
        job_id: jobId,
        attempt_id: input.attemptId,
        artifact_ids: input.artifacts.map((item) => item.id).join(","),
      },
    );
    if (rows.length !== input.artifacts.length) throw new Error("cpu_job_artifact_closure_incomplete");
    for (const row of rows) {
      const declared = input.artifacts.find((item) => item.id === row.id);
      if (!declared || row.artifact_kind !== declared.kind || row.sha256 !== declared.sha256 || Number(row.byte_length) !== declared.sizeBytes) {
        throw new Error("cpu_job_artifact_metadata_mismatch");
      }
      const head = await headS3Object(row.storage_key, row.storage_bucket);
      const checksum = head.checksumSha256 ? Buffer.from(head.checksumSha256, "base64").toString("hex") : null;
      if (head.contentLength !== declared.sizeBytes || checksum !== declared.sha256) {
        throw new Error("cpu_job_artifact_upload_mismatch");
      }
    }
  }
  const result = await withScenarioJobTransaction(jobId, async (tx) => {
    const locked = await tx.queryOne<{ workspace_id: string }>(
      `SELECT workspace_id FROM simforge.cpu_job_attempts
        WHERE id = :attempt_id AND job_id = :job_id AND job_family = :job_family
          AND attempt_state = 'active' AND expires_at > NOW()
          AND fence_token_sha256 = :fence_token_sha256 FOR UPDATE`,
      {
        attempt_id: input.attemptId,
        job_id: jobId,
        job_family: input.jobFamily,
        fence_token_sha256: sha256(input.fenceToken),
      },
    );
    if (!locked) return null;
    await tx.execute(
      `UPDATE simforge.artifacts SET artifact_state = 'available', verified_at = NOW(),
         provenance = provenance || CAST(:provenance AS jsonb)
       WHERE id = ANY(string_to_array(:artifact_ids, ','))`,
      {
        artifact_ids: input.artifacts.map((item) => item.id).join(","),
        provenance: input.postprocess?.provenance ?? {},
      },
    );
    if (input.jobFamily === "openscenario_validate") {
      // Exactly one report; executing validators (esmini) may add one state-trace beside it.
      const reports = input.artifacts.filter((item) => item.kind === "validation-report");
      const extras = input.artifacts.filter((item) => item.kind !== "validation-report");
      if (
        !input.validation
        || reports.length !== 1
        || extras.some((item) => item.kind !== "state-trace")
        || extras.length > 1
      ) {
        throw new Error("validation_completion_invalid");
      }
      await tx.execute(
        `UPDATE simforge.validation_runs
            SET validation_state = :state, report_artifact_id = :artifact_id,
                summary = CAST(:summary AS jsonb), progress = 1,
                failure_code = CASE WHEN :state = 'failed' THEN 'validation_failed' ELSE NULL END,
                failure_detail = CASE WHEN :state = 'failed' THEN CAST(:summary AS jsonb) ELSE NULL END,
                completed_at = NOW(), updated_at = NOW()
          WHERE id = :job_id`,
        {
          state: input.validation.outcome,
          artifact_id: reports[0]!.id,
          summary: input.validation.summary,
          job_id: jobId,
        },
      );
    } else if (input.jobFamily === "openscenario_render") {
      // A browser render's evidence is its origin recording. Success requires, in one
      // transaction: a succeeded browser recording of the same workspace + revision whose
      // request renderSpec digest equals the job's render_spec_sha256. The recording's
      // database-enforced declared closure is linked in full to the render job.
      if (!input.browserRender) throw new Error("browser_render_completion_requires_recording");
      const recording = await tx.queryOne<{ id: string; requires_video: boolean }>(
        `SELECT recording.id,
                recording.request_payload->'renderSpec'->'artifacts' ? 'video'
                  AS requires_video
           FROM simforge.artifact_postprocess_jobs recording
           JOIN simforge.render_jobs job
             ON job.id = :job_id AND job.workspace_id = recording.workspace_id
          WHERE recording.id = :recording_job_id
            AND recording.workspace_id = :workspace_id
            AND recording.postprocess_kind = 'browser_threejs_recording'
            AND recording.state = 'succeeded'
            AND recording.revision_id = job.revision_id
            AND recording.request_payload->>'renderSpecSha256' = job.render_spec_sha256
            AND job.job_state = 'running' AND job.job_mode = 'browser_render'`,
        {
          job_id: jobId,
          recording_job_id: input.browserRender.recordingJobId,
          workspace_id: locked.workspace_id,
        },
      );
      if (!recording) throw new Error("browser_render_recording_not_eligible");
      const recordingArtifacts = await tx.queryRows<{ artifact_id: string; artifact_role: string }>(
        `SELECT link.artifact_id, link.artifact_role
           FROM simforge.operational_job_artifact_links link
           JOIN simforge.artifacts a
             ON a.id = link.artifact_id AND a.workspace_id = link.workspace_id
            AND a.artifact_state = 'available' AND a.deleted_at IS NULL
          WHERE link.workspace_id = :workspace_id
            AND link.job_family = 'artifact_postprocess'
            AND link.job_id = :recording_job_id
            AND link.attempt_id IS NULL
            AND link.artifact_role IS NOT NULL`,
        { workspace_id: locked.workspace_id, recording_job_id: recording.id },
      );
      const roles = new Set(recordingArtifacts.map((row) => row.artifact_role));
      if (!roles.has("manifest") || (recording.requires_video && !roles.has("video"))) {
        throw new Error("browser_render_recording_artifacts_incomplete");
      }
      for (const artifact of recordingArtifacts) {
        await tx.execute(
          `INSERT INTO simforge.artifact_links (
             id, workspace_id, artifact_id, render_job_id, relationship
           ) VALUES (:id, :workspace_id, :artifact_id, :job_id, 'job_level')
           ON CONFLICT DO NOTHING`,
          {
            id: scenarioId("usal"),
            workspace_id: locked.workspace_id,
            artifact_id: artifact.artifact_id,
            job_id: jobId,
          },
        );
      }
      await tx.execute(
        `UPDATE simforge.render_jobs
            SET job_state = 'succeeded', progress = 1,
                origin_recording_job_id = CASE
                  WHEN request_contract_version = 'uniscenario.render-intent/v1' THEN NULL
                  ELSE :recording_job_id
                END,
                telemetry = COALESCE(telemetry, '{}'::jsonb)
                  || jsonb_build_object('browserRecordingJobId', :recording_job_id::text),
                completed_at = NOW(), updated_at = NOW()
          WHERE id = :job_id`,
        { job_id: jobId, recording_job_id: recording.id },
      );
    } else {
      for (const artifact of input.artifacts) {
        await tx.execute(
          `INSERT INTO simforge.artifact_links (
             id, workspace_id, artifact_id, render_job_id, relationship
           ) VALUES (:id, :workspace_id, :artifact_id, :job_id, 'output')
           ON CONFLICT DO NOTHING`,
          {
            id: scenarioId("usal"),
            workspace_id: locked.workspace_id,
            artifact_id: artifact.id,
            job_id: jobId,
          },
        );
      }
      await tx.execute(
        `UPDATE simforge.render_jobs SET job_state = 'succeeded', progress = 1,
           completed_at = NOW(), updated_at = NOW() WHERE id = :job_id`,
        { job_id: jobId },
      );
    }
    await tx.execute(
      `UPDATE simforge.cpu_job_attempts SET attempt_state = 'succeeded', progress = 1,
         completed_at = NOW() WHERE id = :attempt_id`,
      { attempt_id: input.attemptId },
    );
    await insertCpuEvent(tx, {
      workspaceId: locked.workspace_id,
      jobFamily: input.jobFamily,
      jobId,
      attemptId: input.attemptId,
      type: "completed",
      payload: {
        artifacts: input.artifacts.map((item) => ({
          id: item.id,
          kind: item.kind,
          sha256: item.sha256,
        })),
      },
    });
    if (input.jobFamily === "artifact_postprocess") {
      await settleArtifactPostprocessPipelineJob(tx, locked.workspace_id, jobId, "completed");
    }
    return { workspaceId: locked.workspace_id };
  });
  return result;
}

export async function failCpuJob(
  jobId: string,
  input: {
    jobFamily: ScenarioJobFamily;
    attemptId: string;
    fenceToken: string;
    code: string;
    detail: Record<string, unknown>;
  },
) {
  if (input.code === "cpu_job_cancelled") {
    if (input.jobFamily === "openscenario_compile") {
      return cancelCompilerExport(jobId, input);
    }
    return withScenarioJobTransaction(jobId, async (tx) => {
      const attempt = await tx.queryOne<{ workspace_id: string }>(
        `SELECT workspace_id FROM simforge.cpu_job_attempts
          WHERE id = :attempt_id AND job_id = :job_id AND job_family = :job_family
            AND attempt_state = 'active' AND expires_at > NOW()
            AND fence_token_sha256 = :fence_token_sha256 FOR UPDATE`,
        {
          attempt_id: input.attemptId,
          job_id: jobId,
          job_family: input.jobFamily,
          fence_token_sha256: sha256(input.fenceToken),
        },
      );
      if (!attempt) return null;
      await tx.execute(
        `UPDATE simforge.cpu_job_attempts SET attempt_state = 'cancelled', completed_at = NOW(),
           failure_code = 'cancelled' WHERE id = :attempt_id`,
        { attempt_id: input.attemptId },
      );
      if (input.jobFamily === "openscenario_validate") {
        await tx.execute(
          `UPDATE simforge.validation_runs SET validation_state = 'cancelled', completed_at = NOW(),
             updated_at = NOW(), failure_code = 'cancelled' WHERE id = :job_id`,
          { job_id: jobId },
        );
      } else {
        await tx.execute(
          `UPDATE simforge.render_jobs SET job_state = 'cancelled', completed_at = NOW(),
             updated_at = NOW(), failure_code = 'cancelled' WHERE id = :job_id`,
          { job_id: jobId },
        );
      }
      await insertCpuEvent(tx, {
        workspaceId: attempt.workspace_id,
        jobFamily: input.jobFamily,
        jobId,
        attemptId: input.attemptId,
        type: "cancelled",
        payload: { code: "cancelled" },
      });
      if (input.jobFamily === "artifact_postprocess") {
        await settleArtifactPostprocessPipelineJob(tx, attempt.workspace_id, jobId, "cancelled");
      }
      return { retryQueued: false };
    });
  }
  if (input.jobFamily === "openscenario_compile") return failCompilerExport(jobId, input);
  const result = await withScenarioJobTransaction(jobId, async (tx) => {
    const attempt = await tx.queryOne<{ workspace_id: string }>(
      `SELECT workspace_id FROM simforge.cpu_job_attempts
        WHERE id = :attempt_id AND job_id = :job_id AND job_family = :job_family
          AND attempt_state = 'active' AND expires_at > NOW()
          AND fence_token_sha256 = :fence_token_sha256 FOR UPDATE`,
      {
        attempt_id: input.attemptId,
        job_id: jobId,
        job_family: input.jobFamily,
        fence_token_sha256: sha256(input.fenceToken),
      },
    );
    if (!attempt) return null;
    const table = input.jobFamily === "openscenario_validate" ? "validation_runs" : "render_jobs";
    const stateColumn = input.jobFamily === "openscenario_validate" ? "validation_state" : "job_state";
    const current = await tx.queryOne<{ retry: boolean; cancelled: boolean }>(
      `SELECT (cancel_requested_at IS NULL AND attempt_count < max_attempts) AS retry,
              (cancel_requested_at IS NOT NULL) AS cancelled
         FROM simforge.${table}
        WHERE id = :job_id FOR UPDATE`,
      { job_id: jobId },
    );
    if (!current) return null;
    await tx.execute(
      `UPDATE simforge.cpu_job_attempts SET attempt_state = :attempt_state, completed_at = NOW(),
         failure_code = :code, failure_detail = CAST(:detail AS jsonb) WHERE id = :attempt_id`,
      {
        attempt_id: input.attemptId,
        attempt_state: current.cancelled ? "cancelled" : "failed",
        code: current.cancelled ? "cancelled" : input.code,
        detail: input.detail,
      },
    );
    await tx.execute(
      `UPDATE simforge.${table} SET ${stateColumn} = :state,
         failure_code = :code, failure_detail = CAST(:detail AS jsonb),
         completed_at = CASE WHEN :retry THEN NULL ELSE NOW() END, updated_at = NOW()
       WHERE id = :job_id`,
      {
        job_id: jobId,
        state: current.cancelled ? "cancelled" : current.retry ? "queued" : "failed",
        code: current.cancelled ? "cancelled" : input.code,
        detail: input.detail,
        retry: current.retry,
      },
    );
    await insertCpuEvent(tx, {
      workspaceId: attempt.workspace_id,
      jobFamily: input.jobFamily,
      jobId,
      attemptId: input.attemptId,
      type: current.cancelled ? "cancelled" : current.retry ? "retry_queued" : "failed",
      payload: { code: current.cancelled ? "cancelled" : input.code },
    });
    if (input.jobFamily === "artifact_postprocess" && !current.retry) {
      await settleArtifactPostprocessPipelineJob(
        tx, attempt.workspace_id, jobId, current.cancelled ? "cancelled" : "failed",
      );
    }
    return {
      workspaceId: attempt.workspace_id,
      retryQueued: current.retry,
      cancelled: current.cancelled,
    };
  });
  return result;
}

export async function recordCpuJobEvent(
  jobId: string,
  input: {
    jobFamily: ScenarioJobFamily;
    attemptId: string;
    fenceToken: string;
    type: string;
    payload: Record<string, unknown>;
  },
) {
  return withScenarioJobTransaction(jobId, async (tx) => {
    const owner = input.jobFamily === "openscenario_compile"
      ? await tx.queryOne<{ workspace_id: string }>(
          `SELECT e.workspace_id FROM simforge.exports e
            JOIN simforge.export_attempts a ON a.export_id = e.id
           WHERE e.id = :job_id AND e.export_state = 'running' AND e.cancel_requested_at IS NULL
             AND a.id = :attempt_id AND a.attempt_state = 'active'
             AND a.expires_at > NOW() AND a.fence_token_sha256 = :fence_token_sha256`,
          {
            job_id: jobId,
            attempt_id: input.attemptId,
            fence_token_sha256: sha256(input.fenceToken),
          },
        )
      : await tx.queryOne<{ workspace_id: string; job_family: CpuAttemptFamily }>(
          `SELECT attempt.workspace_id, attempt.job_family
             FROM simforge.cpu_job_attempts attempt
            WHERE attempt.id = :attempt_id AND attempt.job_id = :job_id
              AND attempt.job_family = :job_family AND attempt.attempt_state = 'active'
              AND attempt.expires_at > NOW()
              AND attempt.fence_token_sha256 = :fence_token_sha256
              AND (
                (:job_family = 'openscenario_validate' AND EXISTS (
                  SELECT 1 FROM simforge.validation_runs job
                   WHERE job.id = attempt.job_id AND job.validation_state = 'running'
                     AND job.cancel_requested_at IS NULL
                )) OR (:job_family = 'artifact_postprocess' AND EXISTS (
                  SELECT 1 FROM simforge.render_jobs job
                   WHERE job.id = attempt.job_id AND job.job_state = 'running'
                     AND job.cancel_requested_at IS NULL
                )) OR (:job_family = 'openscenario_render' AND EXISTS (
                  SELECT 1 FROM simforge.render_jobs job
                   WHERE job.id = attempt.job_id AND job.job_state = 'running'
                     AND job.job_mode = 'browser_render'
                     AND job.cancel_requested_at IS NULL
                ))
              )`,
          {
            attempt_id: input.attemptId,
            job_id: jobId,
            job_family: input.jobFamily,
            fence_token_sha256: sha256(input.fenceToken),
          },
        );
    if (!owner) return null;
    await insertCpuEvent(tx, {
      workspaceId: owner.workspace_id,
      jobFamily: input.jobFamily,
      jobId,
      attemptId: input.attemptId,
      type: input.type,
      payload: input.payload,
    });
    return { recorded: true };
  });
}
