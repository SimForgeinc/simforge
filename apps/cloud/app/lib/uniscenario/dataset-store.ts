import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne, queryRows, withTransaction } from "@/app/lib/db/data-api";
import type {
  UniScenarioDatasetDto,
  UniScenarioDatasetReadinessDto,
  UniScenarioDatasetVisibility,
} from "./contracts";
import { uniscenarioId } from "./core";
import { getDatasetCompileReadiness } from "./dataset-render-store";

type DatasetRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  visibility: UniScenarioDatasetVisibility;
  is_system_managed: boolean;
  system_slug: string | null;
  is_default: boolean;
  item_count: number;
  document_count: number;
  render_submitted_count: number;
  render_completed_count: number;
  export_completed_count: number;
  created_by_user_name: string | null;
  updated_by_user_name: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Every count here is DERIVED, per §6.7.9. v1 needed eleven `stats_*` columns, two CHECKs, a
 * `stats_repair_state ∈ healthy|dirty|repairing` machine and app-code maintenance on every
 * membership change — with documented drift risk. These are correlated scalar subqueries rather
 * than `LEFT JOIN ... GROUP BY` on purpose: joining five one-to-many relations in one grouped
 * query multiplies the rows and silently inflates every count.
 */
const DATASET_SELECT = `SELECT d.id, d.workspace_id, d.name, d.description,
  d.visibility, d.is_system_managed, d.system_slug, d.is_default,
  d.created_at::text AS created_at, d.updated_at::text AS updated_at,
  COALESCE(NULLIF(BTRIM(author.name), ''), NULLIF(BTRIM(author.email), '')) AS created_by_user_name,
  COALESCE(NULLIF(BTRIM(editor.name), ''), NULLIF(BTRIM(editor.email), '')) AS updated_by_user_name,
  (SELECT COUNT(*)::int FROM uniscenario.dataset_items di
     WHERE di.workspace_id = d.workspace_id AND di.dataset_id = d.id) AS item_count,
  (SELECT COUNT(*)::int FROM uniscenario.documents doc
     WHERE doc.workspace_id = d.workspace_id AND doc.dataset_id = d.id
       AND doc.deleted_at IS NULL) AS document_count,
  (SELECT COUNT(*)::int FROM uniscenario.render_jobs rj
     JOIN uniscenario.revisions rev
       ON rev.id = rj.revision_id AND rev.workspace_id = rj.workspace_id
     JOIN uniscenario.documents doc
       ON doc.id = rev.document_id AND doc.workspace_id = rev.workspace_id
     WHERE doc.workspace_id = d.workspace_id AND doc.dataset_id = d.id
       AND doc.deleted_at IS NULL) AS render_submitted_count,
  (SELECT COUNT(*)::int FROM uniscenario.render_jobs rj
     JOIN uniscenario.revisions rev
       ON rev.id = rj.revision_id AND rev.workspace_id = rj.workspace_id
     JOIN uniscenario.documents doc
       ON doc.id = rev.document_id AND doc.workspace_id = rev.workspace_id
     WHERE doc.workspace_id = d.workspace_id AND doc.dataset_id = d.id
       AND doc.deleted_at IS NULL AND rj.job_state = 'succeeded') AS render_completed_count,
  (SELECT COUNT(*)::int FROM uniscenario.exports ex
     JOIN uniscenario.revisions rev
       ON rev.id = ex.revision_id AND rev.workspace_id = ex.workspace_id
     JOIN uniscenario.documents doc
       ON doc.id = rev.document_id AND doc.workspace_id = rev.workspace_id
     WHERE doc.workspace_id = d.workspace_id AND doc.dataset_id = d.id
       AND doc.deleted_at IS NULL AND ex.export_state = 'succeeded') AS export_completed_count
  FROM uniscenario.datasets d
  LEFT JOIN public.ba_user author ON author.id = d.created_by_user_id
  LEFT JOIN public.ba_user editor ON editor.id = d.updated_by_user_id`;

export const DEFAULT_UNISCENARIO_DATASET_NAME = "Uncategorized";
export const DEFAULT_UNISCENARIO_DATASET_DESCRIPTION =
  "Scenarios that have not been organized into another dataset.";

function dto(row: DatasetRow): UniScenarioDatasetDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    isSystemManaged: Boolean(row.is_system_managed),
    systemSlug: row.system_slug,
    isDefault: Boolean(row.is_default),
    itemCount: Number(row.item_count),
    documentCount: Number(row.document_count),
    renderSubmittedCount: Number(row.render_submitted_count),
    renderCompletedCount: Number(row.render_completed_count),
    exportCompletedCount: Number(row.export_completed_count),
    createdByUserName: row.created_by_user_name,
    updatedByUserName: row.updated_by_user_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listUniScenarioDatasets(context: AppContext) {
  await ensureDefaultUniScenarioDataset(context);
  const rows = await queryRows<DatasetRow>(
    `${DATASET_SELECT}
     WHERE d.workspace_id = :workspace_id AND d.deleted_at IS NULL
     ORDER BY d.updated_at DESC, d.id
     LIMIT 100`,
    { workspace_id: context.workspaceId },
  );
  return rows.map(dto);
}

export async function getDefaultUniScenarioDataset(context: AppContext) {
  const rows = await queryRows<DatasetRow>(
    `${DATASET_SELECT}
     WHERE d.workspace_id = :workspace_id AND d.is_default = TRUE AND d.deleted_at IS NULL
     LIMIT 1`,
    { workspace_id: context.workspaceId },
  );
  return rows[0] ? dto(rows[0]) : null;
}

/**
 * Return the workspace's catch-all dataset, creating it when necessary.
 *
 * Existing workspaces predate `is_default`, so this is intentionally lazy rather than only part
 * of new-workspace provisioning. The transaction-scoped advisory lock serializes first access for
 * a workspace; it also lets us safely revive a previously deleted "Uncategorized" row because the
 * dataset name constraint includes soft-deleted rows.
 */
export async function ensureDefaultUniScenarioDataset(context: AppContext) {
  const datasetId = await withTransaction(async (tx) => {
    await tx.execute(`SELECT pg_advisory_xact_lock(hashtext(:workspace_id))`, {
      workspace_id: context.workspaceId,
    });

    const current = await tx.queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.datasets
       WHERE workspace_id = :workspace_id AND is_default = TRUE AND deleted_at IS NULL
       LIMIT 1`,
      { workspace_id: context.workspaceId },
    );
    if (current) return current.id;

    const named = await tx.queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.datasets
       WHERE workspace_id = :workspace_id AND name = :name
       LIMIT 1`,
      { workspace_id: context.workspaceId, name: DEFAULT_UNISCENARIO_DATASET_NAME },
    );
    if (named) {
      await tx.execute(
        `UPDATE uniscenario.datasets
         SET description = COALESCE(description, :description),
             is_default = TRUE,
             deleted_at = NULL,
             deleted_by_user_id = NULL,
             updated_by_user_id = :user_id,
             updated_at = NOW()
         WHERE workspace_id = :workspace_id AND id = :dataset_id`,
        {
          description: DEFAULT_UNISCENARIO_DATASET_DESCRIPTION,
          user_id: context.userId,
          workspace_id: context.workspaceId,
          dataset_id: named.id,
        },
      );
      return named.id;
    }

    const id = uniscenarioId("usds");
    await tx.execute(
      `INSERT INTO uniscenario.datasets (
         id, workspace_id, name, description, is_default,
         created_by_user_id, updated_by_user_id
       ) VALUES (
         :id, :workspace_id, :name, :description, TRUE, :user_id, :user_id
       )`,
      {
        id,
        workspace_id: context.workspaceId,
        name: DEFAULT_UNISCENARIO_DATASET_NAME,
        description: DEFAULT_UNISCENARIO_DATASET_DESCRIPTION,
        user_id: context.userId,
      },
    );
    return id;
  });

  const dataset = await getUniScenarioDataset(context, datasetId);
  if (!dataset) throw new Error("Default UniScenario dataset could not be provisioned.");
  return dataset;
}

export async function getUniScenarioDataset(context: AppContext, datasetId: string) {
  const rows = await queryRows<DatasetRow>(
    `${DATASET_SELECT}
     WHERE d.workspace_id = :workspace_id AND d.id = :dataset_id AND d.deleted_at IS NULL
     LIMIT 1`,
    { workspace_id: context.workspaceId, dataset_id: datasetId },
  );
  return rows[0] ? dto(rows[0]) : null;
}

export type UniScenarioDatasetWriteResult =
  | { kind: "ok"; dataset: UniScenarioDatasetDto }
  | { kind: "name_conflict" }
  | { kind: "not_found" };

export async function createUniScenarioDataset(
  context: AppContext,
  input: { name: string; description?: string | null },
): Promise<UniScenarioDatasetWriteResult> {
  const datasetId = uniscenarioId("usds");
  // `ON CONFLICT ... DO NOTHING` rather than catching a driver error: the UNIQUE
  // (workspace_id, name) violation is then a zero-row result instead of an exception whose text
  // this code would have to pattern-match. Note the constraint is not partial, so a soft-deleted
  // dataset still holds its name.
  const inserted = await queryRows<{ id: string }>(
    `INSERT INTO uniscenario.datasets (
       id, workspace_id, name, description, created_by_user_id, updated_by_user_id
     ) VALUES (:id, :workspace_id, :name, :description, :user_id, :user_id)
     ON CONFLICT (workspace_id, name) DO NOTHING
     RETURNING id`,
    {
      id: datasetId,
      workspace_id: context.workspaceId,
      name: input.name,
      description: input.description ?? null,
      user_id: context.userId,
    },
  );
  if (inserted.length === 0) return { kind: "name_conflict" };
  const dataset = await getUniScenarioDataset(context, datasetId);
  if (!dataset) throw new Error("UniScenario dataset insert did not return a dataset.");
  return { kind: "ok", dataset };
}

export async function updateUniScenarioDataset(
  context: AppContext,
  datasetId: string,
  input: { name?: string; description?: string | null },
): Promise<UniScenarioDatasetWriteResult> {
  if (input.name !== undefined) {
    const clash = await queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.datasets
       WHERE workspace_id = :workspace_id AND name = :name AND id <> :dataset_id
       LIMIT 1`,
      { workspace_id: context.workspaceId, name: input.name, dataset_id: datasetId },
    );
    if (clash) return { kind: "name_conflict" };
  }
  const updated = await queryRows<{ id: string }>(
    `UPDATE uniscenario.datasets
     SET name = COALESCE(:name, name),
         description = CASE WHEN :description_provided THEN :description ELSE description END,
         updated_by_user_id = :user_id,
         updated_at = NOW()
     WHERE workspace_id = :workspace_id AND id = :dataset_id AND deleted_at IS NULL
     RETURNING id`,
    {
      name: input.name ?? null,
      description_provided: "description" in input,
      description: input.description ?? null,
      user_id: context.userId,
      workspace_id: context.workspaceId,
      dataset_id: datasetId,
    },
  );
  if (updated.length === 0) return { kind: "not_found" };
  const dataset = await getUniScenarioDataset(context, datasetId);
  if (!dataset) return { kind: "not_found" };
  return { kind: "ok", dataset };
}

/**
 * Soft-delete a dataset and its documents in ONE transaction.
 *
 * `uniscenario.documents.dataset_id` is `ON DELETE RESTRICT`, and v2 soft-deletes rather than
 * hard-deletes (§6.7.5), so leaving child documents live would strand them: unreachable through
 * any dataset list, yet still counted by any query that does not filter on the parent. Both
 * writes must land together or neither does.
 */
export async function softDeleteUniScenarioDataset(context: AppContext, datasetId: string) {
  return withTransaction(async (tx) => {
    const rows = await tx.queryRows<{ id: string }>(
      `UPDATE uniscenario.datasets
       SET deleted_at = NOW(), deleted_by_user_id = :user_id, updated_by_user_id = :user_id,
           updated_at = NOW()
       WHERE workspace_id = :workspace_id AND id = :dataset_id AND deleted_at IS NULL
       RETURNING id`,
      { workspace_id: context.workspaceId, dataset_id: datasetId, user_id: context.userId },
    );
    if (rows.length === 0) return { kind: "not_found" as const };
    const documents = await tx.queryRows<{ id: string }>(
      `UPDATE uniscenario.documents
       SET deleted_at = NOW(), deleted_by_user_id = :user_id, updated_by_user_id = :user_id,
           updated_at = NOW()
       WHERE workspace_id = :workspace_id AND dataset_id = :dataset_id AND deleted_at IS NULL
       RETURNING id`,
      { workspace_id: context.workspaceId, dataset_id: datasetId, user_id: context.userId },
    );
    return { kind: "deleted" as const, deletedDocumentCount: documents.length };
  });
}

/**
 * Readiness counters shaped exactly for `useDatasetCrudController.applyDatasetReadiness`:
 * `{ summary: { total, rendered, cosmosed, vlmed }, scenarios: [{ id, has_render }] }`.
 */
export async function getUniScenarioDatasetReadiness(
  context: AppContext,
  datasetId: string,
): Promise<UniScenarioDatasetReadinessDto | null> {
  const dataset = await queryOne<{ id: string }>(
    `SELECT id FROM uniscenario.datasets
     WHERE workspace_id = :workspace_id AND id = :dataset_id AND deleted_at IS NULL
     LIMIT 1`,
    { workspace_id: context.workspaceId, dataset_id: datasetId },
  );
  if (!dataset) return null;

  const readiness = await getDatasetCompileReadiness(context.workspaceId, datasetId);
  return {
    summary: readiness.summary,
    scenarios: readiness.scenarios.map((scenario) => ({
      id: scenario.id,
      has_render: scenario.has_render,
    })),
  };
}

export async function addUniScenarioDatasetItem(
  context: AppContext,
  datasetId: string,
  input: { revisionId: string; renderJobId?: string | null; metadata?: Record<string, unknown> },
) {
  const rows = await queryRows<{ id: string }>(
    `INSERT INTO uniscenario.dataset_items (
       id, workspace_id, dataset_id, revision_id, render_job_id, metadata, created_by_user_id
     )
     SELECT :id, d.workspace_id, d.id, r.id, j.id, CAST(:metadata AS jsonb), :user_id
     FROM uniscenario.datasets d
     JOIN uniscenario.revisions r ON r.workspace_id = d.workspace_id AND r.id = :revision_id
     LEFT JOIN uniscenario.render_jobs j
       ON j.workspace_id = d.workspace_id AND j.id = :render_job_id AND j.revision_id = r.id
     WHERE d.workspace_id = :workspace_id AND d.id = :dataset_id AND d.deleted_at IS NULL
       AND (:render_job_id IS NULL OR j.id IS NOT NULL)
     ON CONFLICT (workspace_id, dataset_id, revision_id, render_job_id)
     DO UPDATE SET metadata = EXCLUDED.metadata
     RETURNING id`,
    {
      id: uniscenarioId("usdi"),
      workspace_id: context.workspaceId,
      dataset_id: datasetId,
      revision_id: input.revisionId,
      render_job_id: input.renderJobId ?? null,
      metadata: input.metadata ?? {},
      user_id: context.userId,
    },
  );
  return rows[0] ?? null;
}

// --- Authorization (§5.7 FINDING A / §6.5) ------------------------------------------------

export type UniScenarioDatasetAction =
  | "read"
  | "updateMetadata"
  | "mutateContent"
  | "delete"
  | "copy";

export type UniScenarioDatasetMutability = "editable" | "read_only";

export type UniScenarioDatasetAccess = {
  datasetId: string;
  actorWorkspaceId: string;
  resourceWorkspaceId: string;
  visibility: UniScenarioDatasetVisibility;
  isSystemManaged: boolean;
  isOwnerWorkspace: boolean;
  /** Always derived. There is deliberately no stored `mutability` column — see §6.5. */
  mutability: UniScenarioDatasetMutability;
  actions: Record<UniScenarioDatasetAction, boolean>;
};

type DatasetAccessRow = {
  id: string;
  workspace_id: string;
  visibility: UniScenarioDatasetVisibility;
  is_system_managed: boolean;
  organization_id: string | null;
};

function isPlatformAdmin(context: AppContext) {
  return context.session.role === "admin";
}

/**
 * Derive what this caller may do to this dataset.
 *
 * Mirrors `effectiveDatasetMutability()` in `app/lib/scenario-sharing/access-policy.ts`: a
 * system-managed dataset is editable only for a platform admin, and read-only for everybody else.
 * A dataset shared into view by `visibility` is readable but never writable from a non-owning
 * workspace — v2's immutable revisions protect history, not the shared dataset's name or
 * existence.
 */
export async function resolveUniScenarioDatasetAccess(
  context: AppContext,
  datasetId: string,
): Promise<UniScenarioDatasetAccess | null> {
  const row = await queryOne<DatasetAccessRow>(
    `SELECT d.id, d.workspace_id, d.visibility, d.is_system_managed,
       w.auth_organization_id AS organization_id
     FROM uniscenario.datasets d
     JOIN public.workspaces w ON w.id = d.workspace_id
     WHERE d.id = :dataset_id AND d.deleted_at IS NULL
     LIMIT 1`,
    { dataset_id: datasetId },
  );
  if (!row) return null;

  const isOwnerWorkspace = row.workspace_id === context.workspaceId;
  const admin = isPlatformAdmin(context);
  const sharedIntoView =
    row.visibility === "public" ||
    (row.visibility === "organization" && row.organization_id === context.organizationId);
  const readable = isOwnerWorkspace || sharedIntoView || admin;

  const mutability: UniScenarioDatasetMutability = row.is_system_managed
    ? admin
      ? "editable"
      : "read_only"
    : isOwnerWorkspace || admin
      ? "editable"
      : "read_only";

  const editable = readable && mutability === "editable";
  return {
    datasetId: row.id,
    actorWorkspaceId: context.workspaceId,
    resourceWorkspaceId: row.workspace_id,
    visibility: row.visibility,
    isSystemManaged: Boolean(row.is_system_managed),
    isOwnerWorkspace,
    mutability,
    actions: {
      read: readable,
      updateMetadata: editable,
      mutateContent: editable,
      delete: editable && isOwnerWorkspace && !row.is_system_managed,
      copy: readable,
    },
  };
}

/** Resolve access for the dataset that owns a document, for document-level mutations. */
export async function resolveUniScenarioDocumentDatasetAccess(
  context: AppContext,
  documentId: string,
): Promise<UniScenarioDatasetAccess | null> {
  const row = await queryOne<{ dataset_id: string }>(
    `SELECT dataset_id FROM uniscenario.documents
     WHERE id = :document_id AND deleted_at IS NULL
     LIMIT 1`,
    { document_id: documentId },
  );
  if (!row) return null;
  return resolveUniScenarioDatasetAccess(context, row.dataset_id);
}

/** Resolve access for the dataset that owns a revision, for export and render-job routes. */
export async function resolveUniScenarioRevisionDatasetAccess(
  context: AppContext,
  revisionId: string,
): Promise<UniScenarioDatasetAccess | null> {
  const row = await queryOne<{ dataset_id: string }>(
    `SELECT doc.dataset_id
     FROM uniscenario.revisions rev
     JOIN uniscenario.documents doc
       ON doc.id = rev.document_id AND doc.workspace_id = rev.workspace_id
     WHERE rev.id = :revision_id AND doc.deleted_at IS NULL
     LIMIT 1`,
    { revision_id: revisionId },
  );
  if (!row) return null;
  return resolveUniScenarioDatasetAccess(context, row.dataset_id);
}

/** Resolve access for the dataset behind a render job, for cancellation. */
export async function resolveUniScenarioRenderJobDatasetAccess(
  context: AppContext,
  renderJobId: string,
): Promise<UniScenarioDatasetAccess | null> {
  const row = await queryOne<{ dataset_id: string }>(
    `SELECT doc.dataset_id
     FROM uniscenario.render_jobs rj
     JOIN uniscenario.revisions rev
       ON rev.id = rj.revision_id AND rev.workspace_id = rj.workspace_id
     JOIN uniscenario.documents doc
       ON doc.id = rev.document_id AND doc.workspace_id = rev.workspace_id
     WHERE rj.id = :render_job_id AND doc.deleted_at IS NULL
     LIMIT 1`,
    { render_job_id: renderJobId },
  );
  if (!row) return null;
  return resolveUniScenarioDatasetAccess(context, row.dataset_id);
}
