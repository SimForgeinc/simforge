"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import { SelectMenuField } from "@/app/components/ui/select-menu";
import { useUniScenarioNotification } from "../status";
import { RenderArtifactList } from "./RenderArtifactList";
import { VideoPreviewModal } from "./VideoPreviewModal";
import {
  fetchArtifactIndex,
  resolveArtifactUrl,
  type DisplayArtifact,
  type PresignedArtifact,
  type WorkspaceArtifact,
} from "./api";

/**
 * The artifacts workspace — manifest #146. Every artifact in the workspace reachable from a visible
 * render, newest first, with search and a kind filter.
 *
 * **The index carries no URLs**, because `artifact-index` deliberately never presigns: signing a whole
 * workspace would mint a 3600-second credential for every file, on a surface whose job is to help
 * someone find one. A row is signed on click, through `[jobId]/downloads`, scoped to that row's job.
 *
 * Search is client-side over the loaded page, deliberately: the server read is ordered to match
 * `(workspace_id, created_at DESC, id)` and a `LIKE` predicate would take it off that index, degrading
 * silently on a table that only grows. The kind filter *is* server-side, because `artifact_kind` is an
 * equality predicate the query already accepts.
 *
 * Not polled. Unlike the gallery, an artifact row is written once by the upload-binding path and then
 * only ever soft-deleted — there is no counter a worker advances under the reader.
 */
export function ArtifactsWorkspacePanel() {
  const [artifacts, setArtifacts] = useState<WorkspaceArtifact[]>([]);
  const [kind, setKind] = useState("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<PresignedArtifact | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const items = await fetchArtifactIndex(
          { artifactKind: kind === "all" ? null : kind },
          signal,
        );
        if (signal?.aborted) return;
        setArtifacts(items);
        setError(null);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof Error ? cause.message : "artifacts_failed");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [kind],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useUniScenarioNotification(
    "uniscenario-artifacts:list",
    error
      ? {
          severity: "error",
          source: "artifacts",
          message: "The workspace artifacts could not be loaded.",
          detail: error,
          action: { label: "Retry", run: () => void load() },
        }
      : null,
  );

  // Kind options come from what actually loaded, not a hardcoded list: `artifact_kind` is a free-form
  // column (max 100 chars) that workers extend, so an enum here would silently hide new kinds.
  const kindOptions = useMemo(() => {
    const kinds = [...new Set(artifacts.map((artifact) => artifact.artifactKind))].sort();
    return [{ value: "all", label: "All kinds" }, ...kinds.map((value) => ({ value }))];
  }, [artifacts]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return artifacts;
    return artifacts.filter((artifact) =>
      [artifact.artifactKind, artifact.mediaType, artifact.relationship, artifact.renderJobId, artifact.sha256]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [artifacts, search]);

  /**
   * Sign one row on demand.
   *
   * An index row with no `renderJobId` cannot be signed at all — `downloads` is job-scoped and there is
   * no workspace-wide signing route, by design. Returning null makes the row say so rather than
   * silently doing nothing on click.
   */
  const resolve = useCallback(async (artifact: DisplayArtifact) => {
    const renderJobId = "renderJobId" in artifact ? artifact.renderJobId : null;
    if (!renderJobId) return null;
    return resolveArtifactUrl(renderJobId, artifact.id);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="uniscenario-artifacts-workspace">
      <div className="flex shrink-0 items-end gap-2 border-b render-hairline px-4 pb-3 pt-1">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search artifacts</span>
          <span className="relative block">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="h-9 pl-8 text-xs"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search kind, media type, job…"
              type="search"
              value={search}
            />
          </span>
        </label>
        <SelectMenuField
          fieldClassName="w-40"
          label="Kind"
          labelClassName="text-micro uppercase tracking-meta"
          onChange={setKind}
          options={kindOptions}
          value={kind}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && artifacts.length === 0 ? (
          <WorkspacePaneLoading
            className="min-h-64"
            hint="Indexing the outputs available in this workspace."
            message="Loading artifacts…"
          />
        ) : (
          <RenderArtifactList
            artifacts={filtered}
            emptyMessage={
              search.trim()
                ? `Nothing matches “${search.trim()}”.`
                : "No artifacts in this workspace yet."
            }
            onPreview={setPreview}
            resolve={resolve}
            signed={false}
          />
        )}
      </div>

      <VideoPreviewModal
        eyebrow={preview?.artifactKind ?? null}
        mediaType={preview?.mediaType ?? ""}
        onClose={() => setPreview(null)}
        open={preview != null}
        title={preview?.artifactKind ?? "Preview"}
        url={preview && "url" in preview ? preview.url : null}
      />
    </div>
  );
}
