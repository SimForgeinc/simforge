import { queryOne, queryRows } from "@/app/lib/db/data-api";
import type { DatasetCompileReadinessResponse } from "@/app/lib/db/dataset-compile-readiness-cache";

export type DatasetSimulationArtifactLoadMode = "all" | "recordings" | "none";

export type DatasetSimulationArtifactRow = {
  id: string;
  simulation_id: string;
  kind: string;
  label: string | null;
  content_type: string | null;
  file_ext: string | null;
  size_bytes: number | null;
  s3_bucket: string;
  s3_key: string;
  artifact_class?: string | null;
  sensor_id?: string | null;
  sensor_label?: string | null;
  sensor_category?: string | null;
  output_modality?: string | null;
  artifact_format?: string | null;
  frame_index?: number | null;
  sequence_id?: string | null;
  is_raw?: boolean | null;
};

export type DatasetSimulationRow = {
  id: string;
  scenario_id: string;
  scenario_name: string | null;
  job_type?: string | null;
  map_name: string | null;
  status: string;
  error_message: string | null;
  queue_position: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  artifact_count?: number;
  artifacts: DatasetSimulationArtifactRow[];
};

export async function getDatasetBatchProgress(workspaceId: string, datasetId: string) {
  const row = await queryOne<{ total: number; completed: number; failed: number; running: number }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE rj.job_state = 'succeeded')::int AS completed,
            COUNT(*) FILTER (WHERE rj.job_state = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE rj.job_state IN ('queued', 'leased', 'running'))::int AS running
       FROM uniscenario.render_jobs rj
       JOIN uniscenario.revisions rev
         ON rev.id = rj.revision_id AND rev.workspace_id = rj.workspace_id
       JOIN uniscenario.documents doc
         ON doc.id = rev.document_id AND doc.workspace_id = rev.workspace_id
      WHERE doc.workspace_id = :workspace_id AND doc.dataset_id = :dataset_id
        AND doc.deleted_at IS NULL AND rj.job_mode IN ('interaction_2d', 'full_render')`,
    { workspace_id: workspaceId, dataset_id: datasetId },
  );
  return row ?? { total: 0, completed: 0, failed: 0, running: 0 };
}

/**
 * Compatibility shape for the existing dataset UI, derived exclusively from canonical
 * UniScenarios documents, jobs, and artifacts.
 */
export async function getDatasetCompileReadiness(
  workspaceId: string,
  datasetId: string,
): Promise<DatasetCompileReadinessResponse> {
  const rows = await queryRows<{
    id: string;
    display_name: string | null;
    has_render: boolean;
    has_cosmos: boolean;
    has_vlm: boolean;
  }>(
    `SELECT doc.id, doc.title AS display_name,
       EXISTS (
         SELECT 1
           FROM uniscenario.revisions rev
           JOIN uniscenario.render_jobs rj
             ON rj.revision_id = rev.id AND rj.workspace_id = rev.workspace_id
          WHERE rev.document_id = doc.id AND rev.workspace_id = doc.workspace_id
            AND rj.job_state = 'succeeded'
            AND rj.job_mode IN ('interaction_2d', 'full_render')
            AND EXISTS (
              SELECT 1
                FROM uniscenario.artifact_links link
                JOIN uniscenario.artifacts artifact ON artifact.id = link.artifact_id
               WHERE link.render_job_id = rj.id
                 AND artifact.workspace_id = rj.workspace_id
                 AND artifact.artifact_state = 'available'
                 AND artifact.deleted_at IS NULL
                 AND NULLIF(BTRIM(artifact.storage_key), '') IS NOT NULL
                 AND (
                   LOWER(COALESCE(artifact.media_type, '')) LIKE 'video/%'
                   OR LOWER(artifact.storage_key) ~ '\\.(mp4|webm)$'
                 )
            )
       ) AS has_render,
       EXISTS (
         SELECT 1
           FROM uniscenario.revisions rev
           JOIN uniscenario.render_jobs rj
             ON rj.revision_id = rev.id AND rj.workspace_id = rev.workspace_id
          WHERE rev.document_id = doc.id AND rev.workspace_id = doc.workspace_id
            AND rj.job_state = 'succeeded' AND rj.job_mode = 'cosmos_augment'
       ) AS has_cosmos,
       EXISTS (
         SELECT 1
           FROM uniscenario.revisions rev
           JOIN uniscenario.render_jobs rj
             ON rj.revision_id = rev.id AND rj.workspace_id = rev.workspace_id
          WHERE rev.document_id = doc.id AND rev.workspace_id = doc.workspace_id
            AND rj.job_state = 'succeeded' AND rj.job_mode = 'vlm_annotate'
       ) AS has_vlm
     FROM uniscenario.documents doc
     WHERE doc.workspace_id = :workspace_id AND doc.dataset_id = :dataset_id
       AND doc.deleted_at IS NULL
     ORDER BY doc.dataset_sort_order, doc.updated_at DESC, doc.id
     LIMIT 1000`,
    { workspace_id: workspaceId, dataset_id: datasetId },
  );
  return {
    dataset_id: datasetId,
    summary: {
      total: rows.length,
      rendered: rows.filter((row) => row.has_render).length,
      cosmosed: rows.filter((row) => row.has_cosmos).length,
      vlmed: rows.filter((row) => row.has_vlm).length,
    },
    scenarios: rows.map((row) => ({
      id: row.id,
      display_name: row.display_name,
      has_render: Boolean(row.has_render),
      has_cosmos: Boolean(row.has_cosmos),
      has_vlm: Boolean(row.has_vlm),
    })),
  };
}

export async function listSimulationsForDataset(
  workspaceId: string,
  datasetId: string,
  options: { artifactLoadMode?: DatasetSimulationArtifactLoadMode } = {},
): Promise<DatasetSimulationRow[]> {
  const mode = options.artifactLoadMode ?? "all";
  const runs = await queryRows<Omit<DatasetSimulationRow, "artifacts">>(
    `SELECT rj.id, doc.id AS scenario_id, doc.title AS scenario_name,
            rj.job_mode AS job_type, mv.label AS map_name, rj.job_state AS status,
            COALESCE(rj.failure_detail->>'message', rj.failure_code) AS error_message,
            NULL::int AS queue_position, rj.created_at::text AS created_at,
            rj.started_at::text AS started_at, rj.completed_at::text AS finished_at,
            (SELECT COUNT(*)::int FROM uniscenario.artifact_links l
              JOIN uniscenario.artifacts a ON a.id = l.artifact_id
             WHERE l.render_job_id = rj.id AND a.artifact_state = 'available'
               AND a.deleted_at IS NULL) AS artifact_count
       FROM uniscenario.render_jobs rj
       JOIN uniscenario.revisions rev
         ON rev.id = rj.revision_id AND rev.workspace_id = rj.workspace_id
       JOIN uniscenario.documents doc
         ON doc.id = rev.document_id AND doc.workspace_id = rev.workspace_id
       LEFT JOIN uniscenario.map_versions mv ON mv.id = rev.map_version_id
      WHERE doc.workspace_id = :workspace_id AND doc.dataset_id = :dataset_id
        AND doc.deleted_at IS NULL AND rj.job_mode IN ('interaction_2d', 'full_render')
      ORDER BY rj.created_at DESC, rj.id DESC`,
    { workspace_id: workspaceId, dataset_id: datasetId },
  );
  if (runs.length === 0 || mode === "none") return runs.map((run) => ({ ...run, artifacts: [] }));
  const bindings: Record<string, string> = { workspace_id: workspaceId };
  const ids = runs.map((run, index) => {
    const key = `job_${index}`;
    bindings[key] = run.id;
    return `:${key}`;
  });
  const artifacts = await queryRows<DatasetSimulationArtifactRow>(
    `SELECT a.id, l.render_job_id AS simulation_id, a.artifact_kind AS kind,
            a.metadata->>'label' AS label, a.media_type AS content_type,
            NULL::text AS file_ext, a.byte_length AS size_bytes,
            a.storage_bucket AS s3_bucket, a.storage_key AS s3_key,
            a.artifact_kind AS artifact_class,
            a.metadata->>'sensorId' AS sensor_id,
            a.metadata->>'sensorLabel' AS sensor_label,
            a.metadata->>'sensorCategory' AS sensor_category,
            a.metadata->>'outputModality' AS output_modality,
            a.metadata->>'artifactFormat' AS artifact_format,
            CASE WHEN a.metadata->>'frameIndex' ~ '^[0-9]+$'
              THEN (a.metadata->>'frameIndex')::int ELSE NULL END AS frame_index,
            a.metadata->>'sequenceId' AS sequence_id,
            COALESCE((a.metadata->>'isRaw')::boolean, TRUE) AS is_raw
       FROM uniscenario.artifact_links l
       JOIN uniscenario.artifacts a ON a.id = l.artifact_id
      WHERE a.workspace_id = :workspace_id AND l.render_job_id IN (${ids.join(", ")})
        AND a.artifact_state = 'available' AND a.deleted_at IS NULL
        ${mode === "recordings" ? "AND (a.media_type LIKE 'video/%' OR LOWER(a.storage_key) ~ '\\.(mp4|webm)$')" : ""}
      ORDER BY a.created_at, a.id`,
    bindings,
  );
  const byJob = new Map<string, DatasetSimulationArtifactRow[]>();
  for (const artifact of artifacts) byJob.set(artifact.simulation_id, [...(byJob.get(artifact.simulation_id) ?? []), artifact]);
  return runs.map((run) => ({ ...run, artifacts: byJob.get(run.id) ?? [] }));
}
