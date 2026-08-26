import { cacheLife, cacheTag } from "next/cache";
import type { AppContext } from "@/app/lib/db/app-context";
import { parseTemplate, type ScenarioTemplateV2 } from "@simforge-oss/scenario";
import { queryOne, queryRows, withTransaction } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import {
  type ScenarioAmbientProvenance,
  type ScenarioMaterializedTrafficReference,
  OPENSCENARIO_NATIVE_PROFILE,
  type ScenarioDocumentDto,
  type ScenarioDocumentSummaryDto,
  type ScenarioDocumentSummaryPageDto,
  type ScenarioMapDescriptorDto,
  type ScenarioRevisionDto,
} from "./contracts";
import { canonicalContentSha256, scenarioId } from "./core";
import { simforgeEnv } from "@/lib/compat-env";

type DocumentRow = {
  id: string;
  workspace_id: string;
  title: string;
  draft_version: number;
  schema_version: string;
  content_sha256: string;
  canonical_content: string | Record<string, unknown>;
  map_version_id: string | null;
  dataset_id: string;
  authoring_quality_id: ScenarioDocumentDto["authoringQualityId"];
  created_at: string;
  updated_at: string;
  latest_revision_id: string | null;
};

type RevisionRow = {
  id: string;
  workspace_id: string;
  document_id: string;
  revision_number: number;
  source_draft_version: number;
  schema_version: string;
  content_sha256: string;
  map_version_id: string | null;
  openscenario_profile: string;
  created_at: string;
  export_id: string;
  export_format: "openscenario_xml_1_4";
  export_state: ScenarioRevisionDto["export"]["status"];
  export_artifact_id: string | null;
};

const DOCUMENT_SELECT = `
  SELECT d.id, d.workspace_id, d.title, dr.draft_version, dr.schema_version,
    dr.content_sha256,
    dr.canonical_content::text AS canonical_content, dr.map_version_id,
    d.dataset_id, dr.authoring_quality_id,
    d.created_at::text AS created_at, d.updated_at::text AS updated_at,
    d.latest_revision_id
  FROM simforge.documents d
  JOIN simforge.drafts dr ON dr.document_id = d.id AND dr.workspace_id = d.workspace_id
`;

function documentDto(row: DocumentRow): ScenarioDocumentDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    draftVersion: Number(row.draft_version),
    schemaVersion: row.schema_version,
    contentSha256: row.content_sha256,
    content: parseTemplate(parseJsonObject(row.canonical_content)),
    mapVersionId: row.map_version_id,
    datasetId: row.dataset_id,
    authoringQualityId: row.authoring_quality_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestRevisionId: row.latest_revision_id,
  };
}

function revisionDto(row: RevisionRow): ScenarioRevisionDto {
  if (row.openscenario_profile !== OPENSCENARIO_NATIVE_PROFILE) {
    throw new Error(`Unsupported OpenSCENARIO profile: ${row.openscenario_profile}`);
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    documentId: row.document_id,
    revisionNumber: Number(row.revision_number),
    sourceDraftVersion: Number(row.source_draft_version),
    schemaVersion: row.schema_version,
    contentSha256: row.content_sha256,
    mapVersionId: row.map_version_id,
    openScenarioProfile: OPENSCENARIO_NATIVE_PROFILE,
    export: {
      id: row.export_id,
      format: row.export_format,
      status: row.export_state,
      artifactId: row.export_artifact_id,
    },
    createdAt: row.created_at,
  };
}

export async function listScenarioDocuments(context: AppContext, limit = 50, datasetId?: string | null) {
  const rows = await queryRows<DocumentRow>(
    `${DOCUMENT_SELECT}
     WHERE d.workspace_id = :workspace_id AND d.deleted_at IS NULL
       ${datasetId ? "AND d.dataset_id = :dataset_id" : ""}
     ORDER BY d.updated_at DESC, d.id
     LIMIT :row_limit`,
    { workspace_id: context.workspaceId, row_limit: Math.max(1, Math.min(limit, 100)), ...(datasetId ? { dataset_id: datasetId } : {}) },
  );
  return rows.map(documentDto);
}

type DocumentSummaryRow = {
  id: string;
  workspace_id: string;
  title: string;
  summary_description: string | null;
  dataset_id: string;
  dataset_sort_order: number;
  map_version_id: string | null;
  map_label: string | null;
  map_source_map_id: string | null;
  map_has_thumbnail: boolean;
  latest_revision_id: string | null;
  revision_count: number;
  summary_archetype: string | null;
  summary_author: string | null;
  summary_content_tags: string | string[] | null;
  summary_role_count: number | null;
  summary_has_sensor_profile: boolean | null;
  summary_prop_count: number | null;
  summary_variant_count: number | null;
  summary_clip_seconds: number | null;
  summary_negative_control: boolean | null;
  derivation_kind: ScenarioDocumentSummaryDto["derivationKind"];
  derived_from_document_id: string | null;
  has_render: boolean;
  tags: string | Array<{ id: string; label: string; color: string | null }> | null;
  created_by_user_name: string | null;
  updated_by_user_name: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The list read. Deliberately does NOT select `dr.canonical_content`.
 *
 * `DOCUMENT_SELECT` casts the whole `ScenarioTemplateV2` to text and `documentDto` runs a full Zod
 * `parseTemplate()` on it — fifty schema parses to draw fifty table rows. Every template-derived
 * field below instead reads a STORED GENERATED projection from migration `20260805010000`, so it
 * is both cheap and incapable of disagreeing with `content_sha256`.
 */
const DOCUMENT_SUMMARY_SELECT = `
  SELECT d.id, d.workspace_id, d.title, dr.summary_description,
    d.dataset_id, d.dataset_sort_order, dr.map_version_id, mv.label AS map_label,
    mv.source_map_asset_id AS map_source_map_id,
    (mv.thumbnail_artifact_id IS NOT NULL) AS map_has_thumbnail,
    d.latest_revision_id, d.derivation_kind, d.derived_from_document_id,
    dr.summary_archetype, dr.summary_author, dr.summary_content_tags,
    dr.summary_role_count, dr.summary_has_sensor_profile,
    dr.summary_prop_count, dr.summary_variant_count,
    dr.summary_clip_seconds, dr.summary_negative_control,
    COALESCE(NULLIF(BTRIM(author.name), ''), NULLIF(BTRIM(author.email), '')) AS created_by_user_name,
    COALESCE(NULLIF(BTRIM(editor.name), ''), NULLIF(BTRIM(editor.email), '')) AS updated_by_user_name,
    d.created_at::text AS created_at, d.updated_at::text AS updated_at,
    (SELECT COUNT(*)::int FROM simforge.revisions rev
       WHERE rev.workspace_id = d.workspace_id AND rev.document_id = d.id) AS revision_count,
    EXISTS (
      SELECT 1 FROM simforge.render_jobs rj
      JOIN simforge.revisions rev
        ON rev.id = rj.revision_id AND rev.workspace_id = rj.workspace_id
      WHERE rev.document_id = d.id AND rev.workspace_id = d.workspace_id
        AND rj.job_state = 'succeeded'
    ) AS has_render,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label, 'color', t.color)
                       ORDER BY t.label, t.id)
      FROM simforge.document_tags dt
      JOIN simforge.tags t ON t.id = dt.tag_id AND t.workspace_id = dt.workspace_id
      WHERE dt.workspace_id = d.workspace_id AND dt.document_id = d.id
        AND t.deleted_at IS NULL
    ), '[]'::jsonb) AS tags
  FROM simforge.documents d
  JOIN simforge.drafts dr ON dr.document_id = d.id AND dr.workspace_id = d.workspace_id
  LEFT JOIN simforge.map_versions mv
    ON mv.id = dr.map_version_id
  LEFT JOIN public.ba_user author ON author.id = d.created_by_user_id
  LEFT JOIN public.ba_user editor ON editor.id = d.updated_by_user_id
`;

function jsonColumn<T>(value: string | T | null, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function documentSummaryDto(row: DocumentSummaryRow): ScenarioDocumentSummaryDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    description: row.summary_description,
    datasetId: row.dataset_id,
    datasetSortOrder: Number(row.dataset_sort_order ?? 0),
    mapVersionId: row.map_version_id,
    mapLabel: row.map_label,
    mapSourceMapId: row.map_source_map_id,
    // Keep the preview bound to the document's exact immutable map version. Older scenarios can
    // legitimately reference a version that is no longer offered by the current map picker.
    mapThumbnailUrl: row.map_version_id && row.map_has_thumbnail
      ? `/api/simforge/maps/${encodeURIComponent(row.map_version_id)}/thumbnail`
      : null,
    latestRevisionId: row.latest_revision_id,
    revisionCount: Number(row.revision_count ?? 0),
    archetype: row.summary_archetype,
    author: row.summary_author,
    contentTags: jsonColumn<string[]>(row.summary_content_tags, []),
    tags: jsonColumn<ScenarioDocumentSummaryDto["tags"]>(row.tags, []),
    roleCount: Number(row.summary_role_count ?? 0),
    hasSensorProfile: Boolean(row.summary_has_sensor_profile),
    propCount: Number(row.summary_prop_count ?? 0),
    variantCount: Number(row.summary_variant_count ?? 0),
    clipSeconds: row.summary_clip_seconds === null ? null : Number(row.summary_clip_seconds),
    negativeControl: Boolean(row.summary_negative_control),
    derivationKind: row.derivation_kind,
    derivedFromDocumentId: row.derived_from_document_id,
    hasRender: Boolean(row.has_render),
    createdByUserName: row.created_by_user_name,
    updatedByUserName: row.updated_by_user_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Encode/decode the keyset cursor.
 *
 * Keyed on `(updated_at, id)`, not an offset: documents are ordered by `updated_at DESC` and
 * editing one moves it, so `OFFSET` would skip or repeat rows between pages. The `id` tiebreak is
 * what makes the key total.
 */
function encodeSummaryCursor(row: { updatedAt: string; id: string }) {
  return Buffer.from(`${row.updatedAt}|${row.id}`, "utf8").toString("base64url");
}

function decodeSummaryCursor(cursor: string): { updatedAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = decoded.lastIndexOf("|");
    if (separator <= 0) return null;
    const updatedAt = decoded.slice(0, separator);
    const id = decoded.slice(separator + 1);
    if (!updatedAt || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

export async function listScenarioDocumentSummaries(
  context: AppContext,
  input: { datasetId: string; limit?: number; cursor?: string | null },
): Promise<ScenarioDocumentSummaryPageDto> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 100));
  const cursor = input.cursor ? decodeSummaryCursor(input.cursor) : null;
  // An unparseable cursor is treated as "start from the beginning" rather than as an error: a
  // stale bookmark should not 500 the list.
  const rows = await queryRows<DocumentSummaryRow>(
    `${DOCUMENT_SUMMARY_SELECT}
     WHERE d.workspace_id = :workspace_id AND d.dataset_id = :dataset_id
       AND d.deleted_at IS NULL
       ${cursor ? "AND (d.updated_at, d.id) < (CAST(:cursor_updated_at AS timestamptz), :cursor_id)" : ""}
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT :row_limit`,
    {
      workspace_id: context.workspaceId,
      dataset_id: input.datasetId,
      row_limit: limit + 1,
      ...(cursor ? { cursor_updated_at: cursor.updatedAt, cursor_id: cursor.id } : {}),
    },
  );

  const hasMore = rows.length > limit;
  const page = (hasMore ? rows.slice(0, limit) : rows).map(documentSummaryDto);
  const last = page.at(-1);
  return {
    documents: page,
    nextCursor: hasMore && last ? encodeSummaryCursor(last) : null,
  };
}

/**
 * Duplicate a document within the workspace.
 *
 * The copy is a SEPARATE document with a parent pointer, never a revision of the original (§6.4):
 * a revision would share the original's id, title and dataset and would move the original's
 * `latest_revision_id`. `derived_from_revision_id` pins the exact immutable revision the copy was
 * taken from when one exists — v1 could not say that, because `draft_json` was mutable underneath.
 */
export async function duplicateScenarioDocument(
  context: AppContext,
  documentId: string,
  input: { title?: string; datasetId?: string } = {},
): Promise<{ kind: "created"; document: ScenarioDocumentDto } | { kind: "not_found" }> {
  return withTransaction(async (tx) => {
    const sourceRow = await tx.queryOne<DocumentRow>(
      `${DOCUMENT_SELECT}
       WHERE d.workspace_id = :workspace_id AND d.id = :document_id AND d.deleted_at IS NULL
       LIMIT 1`,
      { workspace_id: context.workspaceId, document_id: documentId },
    );
    if (!sourceRow) return { kind: "not_found" as const };
    const source = documentDto(sourceRow);

    const targetDatasetId = input.datasetId ?? source.datasetId;
    const dataset = await tx.queryOne<{ id: string }>(
      `SELECT id FROM simforge.datasets
       WHERE workspace_id = :workspace_id AND id = :dataset_id AND deleted_at IS NULL
       LIMIT 1`,
      { workspace_id: context.workspaceId, dataset_id: targetDatasetId },
    );
    if (!dataset) return { kind: "not_found" as const };

    const copyId = scenarioId("uscn");
    const title = (input.title ?? `${source.title} Copy`).slice(0, 200);
    await tx.execute(
      `INSERT INTO simforge.documents (
         id, workspace_id, title, schema_version, map_version_id, dataset_id,
         created_by_user_id, updated_by_user_id,
         derivation_kind, derived_from_document_id, derived_from_revision_id,
         derived_by_user_id, derived_at
       ) VALUES (
         :id, :workspace_id, :title, :schema_version, :map_version_id, :dataset_id,
         :user_id, :user_id,
         'copy', :source_document_id, :source_revision_id,
         :user_id, NOW()
       )`,
      {
        id: copyId,
        workspace_id: context.workspaceId,
        title,
        schema_version: source.schemaVersion,
        map_version_id: source.mapVersionId,
        dataset_id: targetDatasetId,
        user_id: context.userId,
        source_document_id: source.id,
        source_revision_id: source.latestRevisionId,
      },
    );
    // Copy the draft content verbatim so the copy's content_sha256 equals the source's.
    await tx.execute(
      `INSERT INTO simforge.drafts (
         document_id, workspace_id, schema_version, canonical_content,
         content_sha256, map_version_id, authoring_quality_id, updated_by_user_id
       ) VALUES (
         :document_id, :workspace_id, :schema_version, CAST(:content AS jsonb),
         :content_sha256, :map_version_id, :authoring_quality_id, :user_id
       )`,
      {
        document_id: copyId,
        workspace_id: context.workspaceId,
        schema_version: source.schemaVersion,
        content: source.content,
        content_sha256: canonicalContentSha256(source.content),
        map_version_id: source.mapVersionId,
        authoring_quality_id: source.authoringQualityId,
        user_id: context.userId,
      },
    );
    const created = await tx.queryOne<DocumentRow>(
      `${DOCUMENT_SELECT} WHERE d.workspace_id = :workspace_id AND d.id = :document_id`,
      { workspace_id: context.workspaceId, document_id: copyId },
    );
    if (!created) throw new Error("Scenario document duplicate did not return a document.");
    return { kind: "created" as const, document: documentDto(created) };
  });
}

export async function getScenarioDocument(context: AppContext, documentId: string) {
  const rows = await queryRows<DocumentRow>(
    `${DOCUMENT_SELECT}
     WHERE d.workspace_id = :workspace_id AND d.id = :document_id AND d.deleted_at IS NULL
     LIMIT 1`,
    { workspace_id: context.workspaceId, document_id: documentId },
  );
  return rows[0] ? documentDto(rows[0]) : null;
}

/**
 * Fold a wire-level `description` into the template it belongs to.
 *
 * `meta.description` is the only home for a document description. Writing it here — before the
 * digest is taken — is what keeps the projection in migration `20260805010000`, the stored
 * `content_sha256`, and every exported `.xosc` telling the same story. Returning the template
 * unchanged when no description was supplied matters: rewriting `meta` unconditionally would
 * change the digest of an untouched document.
 */
function withDescription(content: ScenarioTemplateV2, description: string | undefined) {
  if (description === undefined) return content;
  if (content.meta.description === description) return content;
  return { ...content, meta: { ...content.meta, description } };
}

export async function createScenarioDocument(
  context: AppContext,
  input: {
    title: string;
    description?: string;
    schemaVersion: string;
    content: ScenarioTemplateV2;
    mapVersionId?: string | null;
    datasetId: string;
    authoringQualityId: ScenarioDocumentDto["authoringQualityId"];
  },
) {
  const documentId = scenarioId("uscn");
  const content = withDescription(input.content, input.description);
  const digest = canonicalContentSha256(content);
  return withTransaction(async (tx) => {
    await tx.execute(
      `INSERT INTO simforge.documents (
         id, workspace_id, title, schema_version, map_version_id, dataset_id,
         created_by_user_id, updated_by_user_id
       ) VALUES (
         :id, :workspace_id, :title, :schema_version, :map_version_id, :dataset_id,
         :user_id, :user_id
       )`,
      {
        id: documentId,
        workspace_id: context.workspaceId,
        title: input.title,
        schema_version: input.schemaVersion,
        map_version_id: input.mapVersionId ?? null,
        dataset_id: input.datasetId,
        user_id: context.userId,
      },
    );
    await tx.execute(
      `INSERT INTO simforge.drafts (
         document_id, workspace_id, schema_version, canonical_content,
         content_sha256, map_version_id, authoring_quality_id, updated_by_user_id
       ) VALUES (
         :document_id, :workspace_id, :schema_version, CAST(:content AS jsonb),
         :content_sha256, :map_version_id, :authoring_quality_id, :user_id
       )`,
      {
        document_id: documentId,
        workspace_id: context.workspaceId,
        schema_version: input.schemaVersion,
        content,
        content_sha256: digest,
        map_version_id: input.mapVersionId ?? null,
        authoring_quality_id: input.authoringQualityId,
        user_id: context.userId,
      },
    );
    const row = await tx.queryOne<DocumentRow>(
      `${DOCUMENT_SELECT} WHERE d.workspace_id = :workspace_id AND d.id = :document_id`,
      { workspace_id: context.workspaceId, document_id: documentId },
    );
    if (!row) throw new Error("Scenario document insert did not return a document.");
    return documentDto(row);
  });
}

export async function updateScenarioDocument(
  context: AppContext,
  documentId: string,
  input: {
    expectedVersion: number;
    title?: string;
    description?: string;
    schemaVersion?: string;
    content?: ScenarioTemplateV2;
    mapVersionId?: string | null;
    authoringQualityId?: ScenarioDocumentDto["authoringQualityId"];
  },
): Promise<{ kind: "updated"; document: ScenarioDocumentDto } | { kind: "conflict"; current: ScenarioDocumentDto } | { kind: "not_found" }> {
  return withTransaction(async (tx) => {
    const currentRow = await tx.queryOne<DocumentRow>(
      `${DOCUMENT_SELECT}
       WHERE d.workspace_id = :workspace_id AND d.id = :document_id AND d.deleted_at IS NULL
       LIMIT 1
       FOR UPDATE OF d, dr`,
      { workspace_id: context.workspaceId, document_id: documentId },
    );
    if (!currentRow) return { kind: "not_found" as const };
    const current = documentDto(currentRow);
    if (current.draftVersion !== input.expectedVersion) {
      return { kind: "conflict" as const, current };
    }

    const content = withDescription(input.content ?? current.content, input.description);
    const schemaVersion = input.schemaVersion ?? current.schemaVersion;
    const mapVersionId = "mapVersionId" in input ? input.mapVersionId ?? null : current.mapVersionId;
    const draftRows = await tx.queryRows<{ document_id: string }>(
      `UPDATE simforge.drafts
       SET draft_version = draft_version + 1,
           schema_version = :schema_version,
           canonical_content = CAST(:content AS jsonb),
           content_sha256 = :content_sha256,
           map_version_id = :map_version_id,
           authoring_quality_id = :authoring_quality_id,
           updated_by_user_id = :user_id,
           updated_at = NOW()
       WHERE workspace_id = :workspace_id AND document_id = :document_id
         AND draft_version = :expected_version
       RETURNING document_id`,
      {
        schema_version: schemaVersion,
        content,
        content_sha256: canonicalContentSha256(content),
        map_version_id: mapVersionId,
        authoring_quality_id: input.authoringQualityId ?? current.authoringQualityId,
        user_id: context.userId,
        workspace_id: context.workspaceId,
        document_id: documentId,
        expected_version: input.expectedVersion,
      },
    );
    if (draftRows.length === 0) {
      const raced = await tx.queryOne<DocumentRow>(
        `${DOCUMENT_SELECT} WHERE d.workspace_id = :workspace_id AND d.id = :document_id`,
        { workspace_id: context.workspaceId, document_id: documentId },
      );
      if (!raced) return { kind: "not_found" as const };
      return { kind: "conflict" as const, current: documentDto(raced) };
    }
    await tx.execute(
      `UPDATE simforge.documents
       SET title = :title, schema_version = :schema_version, map_version_id = :map_version_id,
           updated_by_user_id = :user_id, updated_at = NOW()
       WHERE workspace_id = :workspace_id AND id = :document_id AND deleted_at IS NULL`,
      {
        title: input.title ?? current.title,
        schema_version: schemaVersion,
        map_version_id: mapVersionId,
        user_id: context.userId,
        workspace_id: context.workspaceId,
        document_id: documentId,
      },
    );
    const updated = await tx.queryOne<DocumentRow>(
      `${DOCUMENT_SELECT} WHERE d.workspace_id = :workspace_id AND d.id = :document_id`,
      { workspace_id: context.workspaceId, document_id: documentId },
    );
    if (!updated) throw new Error("Scenario document disappeared during update.");
    return { kind: "updated" as const, document: documentDto(updated) };
  });
}

export async function softDeleteScenarioDocument(context: AppContext, documentId: string) {
  const rows = await queryRows<{ id: string }>(
    `UPDATE simforge.documents
     SET deleted_at = NOW(), deleted_by_user_id = :user_id, updated_by_user_id = :user_id,
         updated_at = NOW()
     WHERE workspace_id = :workspace_id AND id = :document_id AND deleted_at IS NULL
     RETURNING id`,
    { workspace_id: context.workspaceId, document_id: documentId, user_id: context.userId },
  );
  return rows.length > 0;
}

export async function createScenarioRevision(
  context: AppContext,
  documentId: string,
  input: { expectedVersion: number; idempotencyKey?: string; ambient: ScenarioAmbientProvenance; materializedTraffic?: ScenarioMaterializedTrafficReference },
) {
  return withTransaction(async (tx) => {
    const traffic = input.materializedTraffic;
    const draft = await tx.queryOne<DocumentRow>(
      `${DOCUMENT_SELECT}
       WHERE d.workspace_id = :workspace_id AND d.id = :document_id AND d.deleted_at IS NULL
       LIMIT 1`,
      { workspace_id: context.workspaceId, document_id: documentId },
    );
    if (!draft) return { kind: "not_found" as const };
    const current = documentDto(draft);
    if (current.draftVersion !== input.expectedVersion) {
      return { kind: "conflict" as const, current };
    }
    if (traffic) {
      const bound = await tx.queryOne<{ id: string }>(
        `SELECT id FROM simforge.artifacts
         WHERE id = :artifact_id AND workspace_id = :workspace_id
           AND artifact_kind = 'materialized-traffic' AND artifact_state = 'available'
           AND sha256 = :sha256 AND byte_length = :size_bytes
           AND metadata->>'documentId' = :document_id
           AND metadata->>'sourceInputDigest' = :source_input_digest
           AND metadata->>'mapAssetId' = :map_asset_id
           AND metadata->>'mapVersionId' = :map_version_id LIMIT 1`,
        {
          artifact_id: traffic.artifactId, workspace_id: context.workspaceId, sha256: traffic.sha256,
          size_bytes: traffic.sizeBytes, document_id: documentId, source_input_digest: traffic.sourceInputDigest,
          map_asset_id: traffic.mapAssetId, map_version_id: traffic.mapVersionId,
        },
      );
      if (!bound || traffic.mapVersionId !== current.mapVersionId) throw new Error("materialized_traffic_binding_invalid");
    }
    if (input.idempotencyKey) {
      const existing = await tx.queryOne<RevisionRow>(
        revisionSelect("r.workspace_id = :workspace_id AND r.document_id = :document_id AND r.idempotency_key = :idempotency_key"),
        {
          workspace_id: context.workspaceId,
          document_id: documentId,
          idempotency_key: input.idempotencyKey,
        },
      );
      if (existing) return { kind: "created" as const, revision: revisionDto(existing) };
    }
    const existingDraftRevision = await tx.queryOne<RevisionRow>(
      revisionSelect(
        "r.workspace_id = :workspace_id AND r.document_id = :document_id AND r.source_draft_version = :source_draft_version",
      ),
      {
        workspace_id: context.workspaceId,
        document_id: documentId,
        source_draft_version: current.draftVersion,
      },
    );
    if (existingDraftRevision) {
      if (!["failed", "cancelled"].includes(existingDraftRevision.export_state)) {
        return { kind: "created" as const, revision: revisionDto(existingDraftRevision) };
      }
      const retryExportId = scenarioId("usexp");
      await tx.execute(
        `INSERT INTO simforge.exports (
           id, workspace_id, revision_id, export_format, compiler_version, idempotency_key,
           ambient_mode, ambient_runtime_version, ambient_sumo_version, ambient_network_sha256,
           ambient_seed, ambient_config, ambient_config_sha256, ambient_result_sha256,
           materialized_traffic_artifact_id, materialized_traffic_sha256,
           materialized_traffic_size_bytes, materialized_traffic_source_input_digest
         )
         SELECT :id, r.workspace_id, r.id, 'openscenario_xml_1_4', r.compiler_version, :idempotency_key,
           r.ambient_mode, r.ambient_runtime_version, r.ambient_sumo_version, r.ambient_network_sha256,
           r.ambient_seed, r.ambient_config, r.ambient_config_sha256, r.ambient_result_sha256,
           r.materialized_traffic_artifact_id, r.materialized_traffic_sha256,
           r.materialized_traffic_size_bytes, r.materialized_traffic_source_input_digest
         FROM simforge.revisions r
         WHERE r.workspace_id = :workspace_id AND r.id = :revision_id`,
        {
          id: retryExportId,
          workspace_id: context.workspaceId,
          revision_id: existingDraftRevision.id,
          idempotency_key: input.idempotencyKey ?? `revision-retry:${retryExportId}`,
        },
      );
      const retried = await tx.queryOne<RevisionRow>(
        revisionSelect(
          "r.workspace_id = :workspace_id AND r.id = :revision_id AND e.id = :export_id",
        ),
        {
          workspace_id: context.workspaceId,
          revision_id: existingDraftRevision.id,
          export_id: retryExportId,
        },
      );
      if (!retried) throw new Error("Scenario export retry did not return a revision.");
      return { kind: "created" as const, revision: revisionDto(retried) };
    }
    const next = await tx.queryOne<{ next_revision: number }>(
      `SELECT COALESCE(MAX(revision_number), 0) + 1 AS next_revision
       FROM simforge.revisions
       WHERE workspace_id = :workspace_id AND document_id = :document_id`,
      { workspace_id: context.workspaceId, document_id: documentId },
    );
    const revisionId = scenarioId("usrev");
    const exportId = scenarioId("usexp");
    const compilerVersion = simforgeEnv("COMPILER_VERSION")?.trim() || "uniscenario-compiler@2.0.0";
    await tx.execute(
      `INSERT INTO simforge.revisions (
         id, workspace_id, document_id, revision_number, source_draft_version,
         schema_version, canonical_content, content_sha256, map_version_id,
         compiler_version, openscenario_profile, idempotency_key, created_by_user_id,
         ambient_mode, ambient_runtime_version, ambient_sumo_version, ambient_network_sha256,
         ambient_seed, ambient_config, ambient_config_sha256, ambient_result_sha256,
         materialized_traffic_artifact_id, materialized_traffic_sha256,
         materialized_traffic_size_bytes, materialized_traffic_source_input_digest
       ) VALUES (
         :id, :workspace_id, :document_id, :revision_number, :source_draft_version,
         :schema_version, CAST(:content AS jsonb), :content_sha256, :map_version_id,
         :compiler_version, :openscenario_profile, :idempotency_key, :user_id,
         :ambient_mode, :ambient_runtime_version, :ambient_sumo_version, :ambient_network_sha256,
         :ambient_seed, CAST(:ambient_config AS jsonb), :ambient_config_sha256, :ambient_result_sha256,
         :materialized_traffic_artifact_id, :materialized_traffic_sha256,
         :materialized_traffic_size_bytes, :materialized_traffic_source_input_digest
       )`,
      {
        id: revisionId,
        workspace_id: context.workspaceId,
        document_id: documentId,
        revision_number: Number(next?.next_revision ?? 1),
        source_draft_version: current.draftVersion,
        schema_version: current.schemaVersion,
        content: current.content,
        content_sha256: canonicalContentSha256(current.content),
        map_version_id: current.mapVersionId,
        compiler_version: compilerVersion,
        openscenario_profile: OPENSCENARIO_NATIVE_PROFILE,
        idempotency_key: input.idempotencyKey ?? null,
        user_id: context.userId,
        ambient_mode: input.ambient.mode,
        ambient_runtime_version: input.ambient.mode === "native" ? input.ambient.runtimeVersion : null,
        ambient_sumo_version: input.ambient.mode === "sumo" ? input.ambient.sumoVersion : null,
        ambient_network_sha256: input.ambient.mode === "sumo" ? input.ambient.networkSha256 : null,
        ambient_seed: input.ambient.mode === "disabled" ? null : String(input.ambient.seed),
        ambient_config: input.ambient.ambientConfig,
        ambient_config_sha256: input.ambient.configSha256,
        ambient_result_sha256: input.ambient.resultSha256,
        materialized_traffic_artifact_id: traffic?.artifactId ?? null,
        materialized_traffic_sha256: traffic?.sha256 ?? null,
        materialized_traffic_size_bytes: traffic?.sizeBytes ?? null,
        materialized_traffic_source_input_digest: traffic?.sourceInputDigest ?? null,
      },
    );
    await tx.execute(
      `INSERT INTO simforge.exports (
         id, workspace_id, revision_id, export_format, compiler_version, idempotency_key,
         ambient_mode, ambient_runtime_version, ambient_sumo_version, ambient_network_sha256,
         ambient_seed, ambient_config, ambient_config_sha256, ambient_result_sha256,
         materialized_traffic_artifact_id, materialized_traffic_sha256,
         materialized_traffic_size_bytes, materialized_traffic_source_input_digest
       ) VALUES (
         :id, :workspace_id, :revision_id, 'openscenario_xml_1_4', :compiler_version, :idempotency_key,
         :ambient_mode, :ambient_runtime_version, :ambient_sumo_version, :ambient_network_sha256,
         :ambient_seed, CAST(:ambient_config AS jsonb), :ambient_config_sha256, :ambient_result_sha256,
         :materialized_traffic_artifact_id, :materialized_traffic_sha256,
         :materialized_traffic_size_bytes, :materialized_traffic_source_input_digest
       )`,
      {
        id: exportId,
        workspace_id: context.workspaceId,
        revision_id: revisionId,
        compiler_version: compilerVersion,
        idempotency_key: input.idempotencyKey ?? `revision:${revisionId}`,
        ambient_mode: input.ambient.mode,
        ambient_runtime_version: input.ambient.mode === "native" ? input.ambient.runtimeVersion : null,
        ambient_sumo_version: input.ambient.mode === "sumo" ? input.ambient.sumoVersion : null,
        ambient_network_sha256: input.ambient.mode === "sumo" ? input.ambient.networkSha256 : null,
        ambient_seed: input.ambient.mode === "disabled" ? null : String(input.ambient.seed),
        ambient_config: input.ambient.ambientConfig,
        ambient_config_sha256: input.ambient.configSha256,
        ambient_result_sha256: input.ambient.resultSha256,
        materialized_traffic_artifact_id: traffic?.artifactId ?? null,
        materialized_traffic_sha256: traffic?.sha256 ?? null,
        materialized_traffic_size_bytes: traffic?.sizeBytes ?? null,
        materialized_traffic_source_input_digest: traffic?.sourceInputDigest ?? null,
      },
    );
    await tx.execute(
      `UPDATE simforge.documents
       SET latest_revision_id = :revision_id, updated_by_user_id = :user_id, updated_at = NOW()
       WHERE workspace_id = :workspace_id AND id = :document_id`,
      {
        revision_id: revisionId,
        user_id: context.userId,
        workspace_id: context.workspaceId,
        document_id: documentId,
      },
    );
    const created = await tx.queryOne<RevisionRow>(
      revisionSelect("r.workspace_id = :workspace_id AND r.id = :revision_id"),
      { workspace_id: context.workspaceId, revision_id: revisionId },
    );
    if (!created) throw new Error("Scenario revision insert did not return a revision.");
    return { kind: "created" as const, revision: revisionDto(created) };
  });
}

function revisionSelect(where: string) {
  return `SELECT r.id, r.workspace_id, r.document_id, r.revision_number,
      r.source_draft_version, r.schema_version, r.content_sha256, r.map_version_id,
      r.openscenario_profile, r.created_at::text AS created_at,
      e.id AS export_id, e.export_format, e.export_state, e.artifact_id AS export_artifact_id
    FROM simforge.revisions r
    JOIN simforge.exports e ON e.revision_id = r.id AND e.workspace_id = r.workspace_id
    WHERE ${where}
    ORDER BY e.created_at DESC
    LIMIT 1`;
}

export async function listScenarioRevisions(context: AppContext, documentId: string) {
  const rows = await queryRows<RevisionRow>(
    revisionSelect("r.workspace_id = :workspace_id AND r.document_id = :document_id").replace("LIMIT 1", "LIMIT 100"),
    { workspace_id: context.workspaceId, document_id: documentId },
  );
  return rows.map(revisionDto);
}

export async function getScenarioRevision(context: AppContext, revisionId: string) {
  const rows = await queryRows<RevisionRow>(
    revisionSelect("r.workspace_id = :workspace_id AND r.id = :revision_id"),
    { workspace_id: context.workspaceId, revision_id: revisionId },
  );
  return rows[0] ? revisionDto(rows[0]) : null;
}

export type ScenarioMapBrowserAsset = {
  bucket: string;
  key: string;
  objectVersionId: string | null;
  sha256: string;
  byteLength: number;
  mediaType: string;
};

/**
 * Resolve one exact member of a published immutable browser asset set. There
 * is deliberately no prefix, basename, legacy-map, or storage-list fallback.
 *
 * Cached: this returns storage coordinates and content hashes only — never a
 * presigned URL — and the rows it reads are immutable once the set is
 * `available` and the blob `verified`. `workspaceId` is passed as a primitive
 * rather than the `AppContext` so it, and only it, lands in the cache key; see
 * the `use cache` rules in `plans/2026-08-04-scenario-v2-parity-plan.md`
 * §2.5. The caller must have authorized the request already — authorization is
 * never performed inside a cached function.
 *
 * `days` rather than `max` because the query also filters `mv.retired_at IS
 * NULL`. Retirement has no write path in the web app today, so there is nothing
 * to hook `revalidateTag` into; bounding staleness at a day is the honest floor
 * until one exists. Add `revalidateTag` on the map-version tag when it does.
 */
async function readScenarioMapBrowserAsset(
  mapVersionId: string,
  relativePath: string,
): Promise<ScenarioMapBrowserAsset | null> {
  "use cache";
  cacheLife("days");
  cacheTag(`scenario:map-version:${mapVersionId}`);

  const rows = await queryRows<{
    storage_bucket: string; storage_key: string; object_version_id: string | null;
    sha256: string; byte_length: number; media_type: string;
  }>(
    `SELECT b.storage_bucket, b.storage_key, b.object_version_id,
       b.sha256, b.byte_length, b.media_type
     FROM simforge.map_versions mv
     JOIN simforge.browser_asset_sets s ON s.id = mv.browser_asset_set_id
       AND s.workspace_id = mv.workspace_id AND s.map_version_id = mv.id
       AND s.asset_set_state = 'available'
     JOIN simforge.browser_asset_members m ON m.asset_set_id = s.id
       AND m.relative_path = :relative_path
     JOIN simforge.browser_asset_blobs b ON b.id = m.blob_id
       AND b.verification_state = 'verified'
     WHERE mv.id = :map_version_id
       AND mv.retired_at IS NULL
     LIMIT 1`,
    { map_version_id: mapVersionId, relative_path: relativePath },
  );
  const row = rows[0];
  if (!row) return null;
  return {
    bucket: row.storage_bucket,
    key: row.storage_key,
    objectVersionId: row.object_version_id,
    sha256: row.sha256,
    byteLength: Number(row.byte_length),
    mediaType: row.media_type,
  };
}

export async function getScenarioMapBrowserAsset(
  _context: AppContext,
  mapVersionId: string,
  relativePath: string,
): Promise<ScenarioMapBrowserAsset | null> {
  return readScenarioMapBrowserAsset(mapVersionId, relativePath);
}

export type ScenarioMapBrowserAssetRequest = {
  mapVersionId: string;
  relativePath: string;
};

export async function getScenarioMapBrowserAssets(
  _context: AppContext,
  requests: ScenarioMapBrowserAssetRequest[],
): Promise<Array<ScenarioMapBrowserAssetRequest & ScenarioMapBrowserAsset>> {
  if (requests.length === 0) return [];
  return queryRows<
    ScenarioMapBrowserAssetRequest & ScenarioMapBrowserAsset
  >(
    `WITH requested AS (
       SELECT map_version_id, relative_path
       FROM jsonb_to_recordset(:requests::jsonb)
         AS entry(map_version_id text, relative_path text)
     )
     SELECT requested.map_version_id AS "mapVersionId",
       requested.relative_path AS "relativePath",
       b.storage_bucket AS bucket, b.storage_key AS key,
       b.object_version_id AS "objectVersionId", b.sha256,
       b.byte_length AS "byteLength", b.media_type AS "mediaType"
     FROM requested
     JOIN simforge.map_versions mv ON mv.id = requested.map_version_id
       AND mv.retired_at IS NULL
     JOIN simforge.browser_asset_sets s ON s.id = mv.browser_asset_set_id
       AND s.workspace_id = mv.workspace_id AND s.map_version_id = mv.id
       AND s.asset_set_state = 'available'
     JOIN simforge.browser_asset_members m ON m.asset_set_id = s.id
       AND m.relative_path = requested.relative_path
     JOIN simforge.browser_asset_blobs b ON b.id = m.blob_id
       AND b.verification_state = 'verified'`,
    // `jsonb_to_recordset` matches record columns by key name, so the bound
    // array must use the snake_case names the AS clause declares. Binding the
    // camelCase request objects made every column NULL, so nothing joined and
    // this endpoint returned an empty list for every map it was ever asked about.
    {
      requests: requests.map((request) => ({
        map_version_id: request.mapVersionId,
        relative_path: request.relativePath,
      })),
    },
  );
}

export type ScenarioBrowserCacheAsset = {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  required: boolean;
};

export type ScenarioBrowserCacheMap = {
  mapVersionId: string;
  closureSha256: string;
  assets: ScenarioBrowserCacheAsset[];
};

/**
 * Complete verified browser-asset inventory for the active editor release.
 * Storage coordinates deliberately stay server-side; clients receive stable
 * first-party paths plus immutable content identities only.
 */
export async function listScenarioBrowserCacheInventory(
  _context: AppContext,
): Promise<{ releaseKey: string; maps: ScenarioBrowserCacheMap[] }> {
  const releaseKey = await readActiveEditorAssetReleaseCacheKey();
  type CacheInventoryRow = {
    map_version_id: string;
    closure_sha256: string;
    relative_path: string;
    sha256: string;
    byte_length: number;
    media_type: string;
    required: boolean;
  };
  const rows: CacheInventoryRow[] = [];
  let afterMapVersionId = "";
  let afterRelativePath = "";
  const pageSize = 250;
  while (true) {
    // Aurora Data API rejects formatted results larger than 1 MB. Keyset
    // pagination keeps each response bounded even for dense optimized maps.
    const page = await queryRows<CacheInventoryRow>(
      `SELECT mv.id AS map_version_id, bs.closure_sha256, bm.relative_path,
         bb.sha256, bb.byte_length, bb.media_type, bm.required
       FROM simforge.map_versions mv
       JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id
         AND bs.workspace_id = mv.workspace_id AND bs.map_version_id = mv.id
         AND bs.asset_set_state = 'available'
       JOIN simforge.browser_asset_members bm ON bm.asset_set_id = bs.id
       JOIN simforge.browser_asset_blobs bb ON bb.id = bm.blob_id
         AND bb.verification_state = 'verified'
       WHERE mv.retired_at IS NULL
         AND (
           mv.id > :after_map_version_id
           OR (mv.id = :after_map_version_id AND bm.relative_path > :after_relative_path)
         )
       ORDER BY mv.id, bm.relative_path
       LIMIT ${pageSize}`,
      {
        after_map_version_id: afterMapVersionId,
        after_relative_path: afterRelativePath,
      },
    );
    rows.push(...page);
    if (page.length < pageSize) break;
    const last = page.at(-1);
    if (!last) break;
    afterMapVersionId = last.map_version_id;
    afterRelativePath = last.relative_path;
  }
  const maps = new Map<string, ScenarioBrowserCacheMap>();
  for (const row of rows) {
    const current = maps.get(row.map_version_id) ?? {
      mapVersionId: row.map_version_id,
      closureSha256: row.closure_sha256,
      assets: [],
    };
    current.assets.push({
      relativePath: row.relative_path,
      sha256: row.sha256,
      byteLength: Number(row.byte_length),
      mediaType: row.media_type,
      required: row.required,
    });
    maps.set(row.map_version_id, current);
  }
  return { releaseKey, maps: [...maps.values()] };
}

type MapDescriptorRow = {
  id: string; source_map_asset_id: string; label: string; locality: string | null;
  browser_closure_sha256: string;
  topology_artifact_url: string; xodr_artifact_id: string; xodr_sha256: string;
  coordinate_system_id: string; coordinate_system_sha256: string;
  browser_xodr_sha256: string; topology_sha256: string;
  derived_topology_sha256: string; locations_sha256: string;
  signals_sha256: string; lane_polygons_sha256: string;
  sumo_network_sha256: string | null;
};

/**
 * The cacheable half of {@link listScenarioMapDescriptors}: storage
 * coordinates and hashes, no credentials.
 *
 * Signing deliberately does NOT happen here. Every media field is a stable,
 * authenticated first-party route, so cached descriptors cannot outlive a
 * short-lived S3 signature (§5.7 FINDING C).
 */
async function readActiveEditorAssetReleaseCacheKey() {
  const row = await queryOne<{ release_cache_key: string | null }>(
    `SELECT STRING_AGG(
       CONCAT_WS(':', workspace_id, id, manifest_sha256),
       ',' ORDER BY workspace_id, id
     ) AS release_cache_key
     FROM simforge.editor_asset_releases
     WHERE release_state = 'active'`,
    {},
  );
  return row?.release_cache_key ?? "no-active-editor-asset-release";
}

async function readScenarioMapDescriptorRows(_activeReleaseCacheKey: string) {
  "use cache";
  cacheLife("days");
  cacheTag("scenario:maps:global");

  return queryRows<MapDescriptorRow>(
    `WITH ranked_map_versions AS (
     SELECT mv.id, mv.source_map_asset_id, mv.label, mv.locality, mv.topology_artifact_url,
       mv.xodr_artifact_id, mv.xodr_sha256, mv.coordinate_system_id, mv.coordinate_system_sha256,
       bs.closure_sha256 AS browser_closure_sha256,
       xodr_blob.sha256 AS browser_xodr_sha256,
       topology_blob.sha256 AS topology_sha256,
       derived_blob.sha256 AS derived_topology_sha256,
       locations_blob.sha256 AS locations_sha256,
       signals_blob.sha256 AS signals_sha256,
       lanes_blob.sha256 AS lane_polygons_sha256,
       mv.sumo_network_sha256,
       ROW_NUMBER() OVER (
         PARTITION BY mv.source_map_asset_id
         ORDER BY mv.created_at DESC, mv.id DESC
       ) AS source_publication_rank
     FROM simforge.map_versions mv
     JOIN simforge.browser_asset_sets bs ON bs.id = mv.browser_asset_set_id
       AND bs.workspace_id = mv.workspace_id AND bs.map_version_id = mv.id
       AND bs.asset_set_state = 'available'
     JOIN simforge.browser_asset_members bm ON bm.asset_set_id = bs.id
       AND bm.relative_path = '3d/manifest.json' AND bm.role = 'manifest' AND bm.required = TRUE
     JOIN simforge.browser_asset_blobs bb ON bb.id = bm.blob_id
       AND bb.verification_state = 'verified'
     JOIN simforge.browser_asset_members xodr_member ON xodr_member.asset_set_id = bs.id
       AND xodr_member.relative_path = 'map.xodr' AND xodr_member.required = TRUE
     JOIN simforge.browser_asset_blobs xodr_blob ON xodr_blob.id = xodr_member.blob_id
       AND xodr_blob.verification_state = 'verified'
     JOIN simforge.browser_asset_members topology_member ON topology_member.asset_set_id = bs.id
       AND topology_member.relative_path = 'topology-index.json.gz' AND topology_member.required = TRUE
     JOIN simforge.browser_asset_blobs topology_blob ON topology_blob.id = topology_member.blob_id
       AND topology_blob.verification_state = 'verified'
     JOIN simforge.browser_asset_members derived_member ON derived_member.asset_set_id = bs.id
       AND derived_member.relative_path = 'derived/topology-derived.json.gz' AND derived_member.required = TRUE
     JOIN simforge.browser_asset_blobs derived_blob ON derived_blob.id = derived_member.blob_id
       AND derived_blob.verification_state = 'verified'
     JOIN simforge.browser_asset_members locations_member ON locations_member.asset_set_id = bs.id
       AND locations_member.relative_path = 'derived/locations.json.gz' AND locations_member.required = TRUE
     JOIN simforge.browser_asset_blobs locations_blob ON locations_blob.id = locations_member.blob_id
       AND locations_blob.verification_state = 'verified'
     JOIN simforge.browser_asset_members signals_member ON signals_member.asset_set_id = bs.id
       AND signals_member.relative_path = 'signals.geojson.gz' AND signals_member.required = TRUE
     JOIN simforge.browser_asset_blobs signals_blob ON signals_blob.id = signals_member.blob_id
       AND signals_blob.verification_state = 'verified'
     JOIN simforge.browser_asset_members lanes_member ON lanes_member.asset_set_id = bs.id
       AND lanes_member.relative_path = 'lane-polygons.geojson.gz' AND lanes_member.required = TRUE
     JOIN simforge.browser_asset_blobs lanes_blob ON lanes_blob.id = lanes_member.blob_id
       AND lanes_blob.verification_state = 'verified'
     WHERE mv.retired_at IS NULL
       AND NULLIF(BTRIM(mv.source_map_asset_id), '') IS NOT NULL
     )
     SELECT id, source_map_asset_id, label, locality, topology_artifact_url,
       xodr_artifact_id, xodr_sha256, coordinate_system_id, coordinate_system_sha256,
       browser_closure_sha256, browser_xodr_sha256, topology_sha256,
       derived_topology_sha256, locations_sha256, signals_sha256,
       lane_polygons_sha256, sumo_network_sha256
     FROM ranked_map_versions
     WHERE source_publication_rank = 1
     ORDER BY label, id`,
    {},
  );
}

/** Thumbnail bindings are mutable presentation state and deliberately stay outside the immutable
 * descriptor cache. The query is small and lets a publication become visible immediately. */
async function readAvailableThumbnailMapVersionIds() {
  return queryRows<{ id: string }>(
    `SELECT mv.id
     FROM simforge.map_versions mv
     JOIN simforge.artifacts th ON th.id = mv.thumbnail_artifact_id
       AND th.workspace_id = mv.workspace_id
       AND th.artifact_kind = 'map-thumbnail-v2'
       AND th.artifact_state = 'available'
       AND th.deleted_at IS NULL
     WHERE mv.retired_at IS NULL`,
    {},
  );
}

export async function listScenarioMapDescriptors(_context: AppContext) {
  // The release ledger is the mutable pointer for an otherwise immutable
  // catalog. Reading its tiny identity outside the cached function makes a
  // release switch part of the cache key, so activation is visible immediately
  // without discarding the expensive descriptor cache between releases.
  const activeReleaseCacheKey = await readActiveEditorAssetReleaseCacheKey();
  const rows = await readScenarioMapDescriptorRows(activeReleaseCacheKey);
  const thumbnailMapVersionIds = new Set(
    (await readAvailableThumbnailMapVersionIds()).map((row) => row.id),
  );
  return rows.map((row): ScenarioMapDescriptorDto => {
    if (row.xodr_sha256 !== row.browser_xodr_sha256) {
      throw new Error(`Map ${row.id} publishes XODR bytes that do not match its immutable map version`);
    }
    const browserAssetRootUrl = `/api/simforge/maps/${encodeURIComponent(row.id)}/browser-assets`;
    return {
    mapVersionId: row.id,
    sourceMapId: row.source_map_asset_id,
    label: row.label,
    locality: row.locality,
    browserAssetRootUrl,
    browserManifestUrl: `${browserAssetRootUrl}/3d/manifest.json`,
    browserClosureSha256: row.browser_closure_sha256,
    artifacts: {
      xodrSha256: row.browser_xodr_sha256,
      topologySha256: row.topology_sha256,
      derivedTopologySha256: row.derived_topology_sha256,
      locationsSha256: row.locations_sha256,
      signalsSha256: row.signals_sha256,
      lanePolygonsSha256: row.lane_polygons_sha256,
    },
    sumoNetworkSha256: row.sumo_network_sha256,
    // Existing aliases remain on the same browser route. Unlike presigned
    // artifact URLs, these cannot expire while a page is open.
    topologyArtifactUrl: `${browserAssetRootUrl}/topology-index.json.gz`,
    derivedTopologyUrl: `${browserAssetRootUrl}/derived/topology-derived.json.gz`,
    locationsUrl: `${browserAssetRootUrl}/derived/locations.json.gz`,
    sumoNetworkUrl: null,
    // Stable first-party route: the browser never needs to know which bucket owns the immutable
    // preview, and it never keeps an expiring S3 URL in SPA state.
    thumbnailUrl: thumbnailMapVersionIds.has(row.id)
      ? `/api/simforge/maps/${encodeURIComponent(row.id)}/thumbnail`
      : null,
    // `signals.geojson`, for the 3D layer's signal overlay: `buildSignalOverlay`
    // takes `SignalFeature[]` from this artifact. Presigned per request like the
    // URLs above and never cached (§2.5.3). The editor's authoring projection does
    // NOT come through here — it is built server-side from the artifact bytes,
    // because these inputs are megabytes and the projection is kilobytes.
    signalsArtifactUrl: `${browserAssetRootUrl}/signals.geojson.gz`,
    xodr: { artifactId: row.xodr_artifact_id, sha256: row.xodr_sha256 },
    coordinateSystem: { id: row.coordinate_system_id, sha256: row.coordinate_system_sha256 },
  };
  });
}
