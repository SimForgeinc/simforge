import type { AppContext } from "@/app/lib/db/app-context";
import { queryOne } from "@/app/lib/db/data-api";
import { parseJsonObject } from "@/app/lib/db/json-helpers";
import {
  parseTemplate,
  type ScenarioTemplateV2,
} from "@simforge/scenario";

type RecordingRevisionRow = {
  id: string;
  document_id: string;
  source_draft_version: number;
  content_sha256: string;
  map_version_id: string | null;
  canonical_content: string | Record<string, unknown>;
  created_at: string;
};

export type UniScenarioRecordingRevisionInput = {
  id: string;
  documentId: string;
  sourceDraftVersion: number;
  contentSha256: string;
  mapVersionId: string | null;
  content: ScenarioTemplateV2;
  createdAt: string;
};

/**
 * Read the immutable scenario snapshot used to resolve a browser recording.
 *
 * The editor draft is deliberately not accepted here. Camera bindings and the
 * authored environment must come from the same revision whose digest is later
 * persisted in the capture manifest.
 */
export async function getUniScenarioRecordingRevisionInput(
  context: Pick<AppContext, "workspaceId">,
  revisionId: string,
): Promise<UniScenarioRecordingRevisionInput | null> {
  const row = await queryOne<RecordingRevisionRow>(
    `SELECT revision.id, revision.document_id, revision.source_draft_version,
       revision.content_sha256, revision.map_version_id,
       revision.canonical_content::text AS canonical_content,
       revision.created_at::text AS created_at
     FROM uniscenario.revisions revision
     JOIN uniscenario.documents document
       ON document.id = revision.document_id
      AND document.workspace_id = revision.workspace_id
     WHERE revision.id = :revision_id
       AND revision.workspace_id = :workspace_id
       AND document.deleted_at IS NULL
     LIMIT 1`,
    { revision_id: revisionId, workspace_id: context.workspaceId },
  );
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    sourceDraftVersion: Number(row.source_draft_version),
    contentSha256: row.content_sha256,
    mapVersionId: row.map_version_id,
    content: parseTemplate(parseJsonObject(row.canonical_content)),
    createdAt: row.created_at,
  };
}
