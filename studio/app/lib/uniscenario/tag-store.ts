import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne, queryRows, withTransaction } from "@/app/lib/db/data-api";
import type { UniScenarioTagDto } from "./contracts";
import { uniscenarioId } from "./core";

type TagRow = {
  id: string;
  workspace_id: string;
  slug: string;
  label: string;
  color: string | null;
  is_system_default: boolean;
  document_count: number;
};

const TAG_SELECT = `SELECT t.id, t.workspace_id, t.slug, t.label, t.color, t.is_system_default,
    (SELECT COUNT(*)::int FROM uniscenario.document_tags dt
       JOIN uniscenario.documents doc
         ON doc.id = dt.document_id AND doc.workspace_id = dt.workspace_id
       WHERE dt.workspace_id = t.workspace_id AND dt.tag_id = t.id
         AND doc.deleted_at IS NULL) AS document_count
  FROM uniscenario.tags t`;

function tagDto(row: TagRow): UniScenarioTagDto {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    label: row.label,
    color: row.color,
    isSystemDefault: Boolean(row.is_system_default),
    documentCount: Number(row.document_count ?? 0),
  };
}

/**
 * Turn a label into the workspace-unique slug the table's CHECK accepts.
 *
 * The slug is the identity a caller can reason about ("crash" is the same tag in every workspace),
 * which is what makes the four seeded defaults recognisable after a rename. It is NOT the primary
 * key — renaming a tag keeps its id and its assignments.
 */
export function uniscenarioTagSlug(label: string) {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return /^[a-z0-9]/.test(slug) ? slug : `tag-${slug}`.slice(0, 63).replace(/-+$/, "");
}

export async function listUniScenarioTags(context: AppContext) {
  const rows = await queryRows<TagRow>(
    `${TAG_SELECT}
     WHERE t.workspace_id = :workspace_id AND t.deleted_at IS NULL
     ORDER BY t.label, t.id`,
    { workspace_id: context.workspaceId },
  );
  return rows.map(tagDto);
}

export type UniScenarioTagWriteResult =
  | { kind: "ok"; tag: UniScenarioTagDto }
  | { kind: "slug_conflict" }
  | { kind: "not_found" };

/**
 * Create a workspace tag.
 *
 * `UNIQUE (workspace_id, slug)` is not partial, so a soft-deleted tag still holds its slug — the
 * same shape as the dataset name constraint. Rather than surface a conflict for something the user
 * cannot see, a soft-deleted row with the requested slug is revived in place (keeping its id, and
 * therefore any assignments that outlived it), which is what "re-create the tag I just deleted"
 * plainly means.
 */
export async function createUniScenarioTag(
  context: AppContext,
  input: { label: string; color?: string | null },
): Promise<UniScenarioTagWriteResult> {
  const slug = uniscenarioTagSlug(input.label);
  if (!slug) return { kind: "slug_conflict" };
  return withTransaction(async (tx) => {
    const revived = await tx.queryRows<{ id: string }>(
      `UPDATE uniscenario.tags
       SET label = :label, color = :color, deleted_at = NULL, updated_by_user_id = :user_id,
           updated_at = NOW()
       WHERE workspace_id = :workspace_id AND slug = :slug AND deleted_at IS NOT NULL
       RETURNING id`,
      {
        workspace_id: context.workspaceId,
        slug,
        label: input.label.trim(),
        color: input.color ?? null,
        user_id: context.userId,
      },
    );
    const tagId = revived[0]?.id ?? uniscenarioId("ustag");
    if (revived.length === 0) {
      const inserted = await tx.queryRows<{ id: string }>(
        `INSERT INTO uniscenario.tags (
           id, workspace_id, slug, label, color, created_by_user_id, updated_by_user_id
         ) VALUES (:id, :workspace_id, :slug, :label, :color, :user_id, :user_id)
         ON CONFLICT (workspace_id, slug) DO NOTHING
         RETURNING id`,
        {
          id: tagId,
          workspace_id: context.workspaceId,
          slug,
          label: input.label.trim(),
          color: input.color ?? null,
          user_id: context.userId,
        },
      );
      if (inserted.length === 0) return { kind: "slug_conflict" as const };
    }
    const row = await tx.queryOne<TagRow>(
      `${TAG_SELECT} WHERE t.workspace_id = :workspace_id AND t.id = :tag_id LIMIT 1`,
      { workspace_id: context.workspaceId, tag_id: tagId },
    );
    if (!row) throw new Error("UniScenario tag insert did not return a tag.");
    return { kind: "ok" as const, tag: tagDto(row) };
  });
}

/**
 * Rename or recolour a tag.
 *
 * The slug deliberately does NOT follow the label. Assignments are keyed on the id and the slug is
 * only an identity handle; re-slugging on rename would make "crash" stop being the seeded crash tag
 * the moment someone fixed its capitalisation.
 */
export async function updateUniScenarioTag(
  context: AppContext,
  tagId: string,
  input: { label?: string; color?: string | null },
): Promise<UniScenarioTagWriteResult> {
  if (input.label !== undefined) {
    const clash = await queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.tags
       WHERE workspace_id = :workspace_id AND deleted_at IS NULL AND id <> :tag_id
         AND LOWER(BTRIM(label)) = LOWER(BTRIM(:label))
       LIMIT 1`,
      { workspace_id: context.workspaceId, tag_id: tagId, label: input.label },
    );
    if (clash) return { kind: "slug_conflict" };
  }
  const updated = await queryRows<{ id: string }>(
    `UPDATE uniscenario.tags
     SET label = COALESCE(:label, label),
         color = CASE WHEN :color_provided THEN :color ELSE color END,
         updated_by_user_id = :user_id,
         updated_at = NOW()
     WHERE workspace_id = :workspace_id AND id = :tag_id AND deleted_at IS NULL
     RETURNING id`,
    {
      label: input.label ?? null,
      color_provided: "color" in input,
      color: input.color ?? null,
      user_id: context.userId,
      workspace_id: context.workspaceId,
      tag_id: tagId,
    },
  );
  if (updated.length === 0) return { kind: "not_found" };
  const row = await queryOne<TagRow>(
    `${TAG_SELECT} WHERE t.workspace_id = :workspace_id AND t.id = :tag_id LIMIT 1`,
    { workspace_id: context.workspaceId, tag_id: tagId },
  );
  return row ? { kind: "ok", tag: tagDto(row) } : { kind: "not_found" };
}

/**
 * Soft-delete a tag and drop its assignments.
 *
 * The assignments go for real: `document_tags` is a pure join with no history value, and leaving
 * rows pointing at an invisible tag would keep the deleted label in every `documentCount` and in
 * the summary projection's tag array.
 */
export async function deleteUniScenarioTag(context: AppContext, tagId: string) {
  return withTransaction(async (tx) => {
    const rows = await tx.queryRows<{ id: string }>(
      `UPDATE uniscenario.tags
       SET deleted_at = NOW(), updated_by_user_id = :user_id, updated_at = NOW()
       WHERE workspace_id = :workspace_id AND id = :tag_id AND deleted_at IS NULL
       RETURNING id`,
      { workspace_id: context.workspaceId, tag_id: tagId, user_id: context.userId },
    );
    if (rows.length === 0) return { kind: "not_found" as const };
    await tx.execute(
      `DELETE FROM uniscenario.document_tags
       WHERE workspace_id = :workspace_id AND tag_id = :tag_id`,
      { workspace_id: context.workspaceId, tag_id: tagId },
    );
    return { kind: "deleted" as const };
  });
}

/**
 * Replace a document's whole tag set.
 *
 * A set-replace rather than add/remove endpoints because that is what the UI actually holds: the
 * row knows its complete tag list, and two concurrent single-tag toggles against the same row would
 * otherwise interleave into a state neither client asked for. Unknown or soft-deleted tag ids are
 * dropped by the `SELECT` source rather than rejected, so a stale row cannot wedge a save.
 */
export async function setUniScenarioDocumentTags(
  context: AppContext,
  documentId: string,
  tagIds: string[],
): Promise<{ kind: "ok"; tags: UniScenarioTagDto[] } | { kind: "not_found" }> {
  return withTransaction(async (tx) => {
    const document = await tx.queryOne<{ id: string }>(
      `SELECT id FROM uniscenario.documents
       WHERE workspace_id = :workspace_id AND id = :document_id AND deleted_at IS NULL
       LIMIT 1`,
      { workspace_id: context.workspaceId, document_id: documentId },
    );
    if (!document) return { kind: "not_found" as const };

    await tx.execute(
      `DELETE FROM uniscenario.document_tags
       WHERE workspace_id = :workspace_id AND document_id = :document_id`,
      { workspace_id: context.workspaceId, document_id: documentId },
    );
    if (tagIds.length > 0) {
      await tx.execute(
        `INSERT INTO uniscenario.document_tags (
           workspace_id, document_id, tag_id, assigned_by_user_id
         )
         SELECT t.workspace_id, :document_id, t.id, :user_id
         FROM uniscenario.tags t
         WHERE t.workspace_id = :workspace_id AND t.deleted_at IS NULL
           AND t.id = ANY(CAST(:tag_ids AS text[]))
         ON CONFLICT (document_id, tag_id) DO NOTHING`,
        {
          workspace_id: context.workspaceId,
          document_id: documentId,
          user_id: context.userId,
          // Same array-literal crossing as `listUniScenarioRatingAggregates`: the Data API has no
          // array parameter type, and this is still a bound parameter.
          tag_ids: `{${tagIds.map((id) => `"${id.replaceAll('"', "")}"`).join(",")}}`,
        },
      );
    }
    const rows = await tx.queryRows<TagRow>(
      `${TAG_SELECT}
       WHERE t.workspace_id = :workspace_id AND t.deleted_at IS NULL
         AND EXISTS (
           SELECT 1 FROM uniscenario.document_tags dt
           WHERE dt.workspace_id = t.workspace_id AND dt.tag_id = t.id
             AND dt.document_id = :document_id
         )
       ORDER BY t.label, t.id`,
      { workspace_id: context.workspaceId, document_id: documentId },
    );
    return { kind: "ok" as const, tags: rows.map(tagDto) };
  });
}
