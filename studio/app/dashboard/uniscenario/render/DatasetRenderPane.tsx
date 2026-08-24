"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import { Button } from "@/app/components/ui/button";
import * as api from "../list/api";
import { DocumentRenderWorkspace } from "../editor/render/DocumentRenderWorkspace";

type ResolvedDocument = {
  title: string;
  draftVersion: number | null;
  latestRevisionId: string | null;
};

/**
 * The dataset surface's right pane.
 *
 * It is absolutely layered over the still-mounted scene and stays glass throughout: no opaque card
 * background, because the world behind it is the scenario the renders are of and hiding it behind a
 * black panel wastes the one piece of context the pane has. A reload has only a document id in the
 * URL, so that path resolves the real document record before mounting the render workspace.
 */
export function DatasetRenderPane({
  documentId,
  initialDocumentTitle,
  initialRevisionId,
  resolveDocument,
  onClose,
  onRenderActivityChange,
  onImmersiveChange,
}: {
  documentId: string;
  initialDocumentTitle: string | null;
  initialRevisionId: string | null;
  resolveDocument: boolean;
  onClose: () => void;
  onRenderActivityChange?: (activityKey: string, live: boolean) => void;
  /** True while the pane shows one render or the create form, which claim the full width. */
  onImmersiveChange?: (immersive: boolean) => void;
}) {
  const [document, setDocument] = useState<ResolvedDocument | null>(() =>
    resolveDocument
      ? null
      : { title: initialDocumentTitle ?? "", draftVersion: null, latestRevisionId: initialRevisionId },
  );
  const [loading, setLoading] = useState(resolveDocument);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const record = await api.getDocument(documentId, signal);
        if (signal?.aborted) return;
        setDocument({
          title: record.title,
          draftVersion: record.draftVersion,
          latestRevisionId: record.latestRevisionId,
        });
      } catch (cause) {
        if (
          signal?.aborted ||
          (cause as { name?: string } | null)?.name === "AbortError"
        )
          return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Failed to load this scenario.",
        );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [documentId],
  );

  useEffect(() => {
    if (!resolveDocument) {
      setDocument({
        title: initialDocumentTitle ?? "",
        draftVersion: null,
        latestRevisionId: initialRevisionId,
      });
      setLoading(false);
      setError(null);
      return;
    }
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [initialDocumentTitle, initialRevisionId, load, resolveDocument]);

  return (
    <aside
      aria-label="Render workspace"
      className="render-view-enter absolute inset-0 z-20 flex min-h-0 flex-col text-foreground"
      data-testid="uniscenario-dataset-render-pane"
    >
      {loading || !document ? (
        <WorkspacePaneLoading
          hint="Preparing the saved scenario and its render history."
          message="Loading scenario renders"
        />
      ) : error ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="max-w-md text-sm text-destructive">{error}</p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Try again
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              <X className="size-3.5" aria-hidden="true" />
              Close
            </Button>
          </div>
        </div>
      ) : !document ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="max-w-md text-sm text-muted-foreground">
            The saved scenario details are not available yet.
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={() => void load()}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Try again
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              <X className="size-3.5" aria-hidden="true" />
              Close
            </Button>
          </div>
        </div>
      ) : (
        <DocumentRenderWorkspace
          documentId={documentId}
          documentTitle={document.title}
          expectedDraftVersion={document.draftVersion}
          // Only an explicit deep link pins the pane to one snapshot. Defaulting to the latest
          // revision would hide every render taken from an earlier one, which is the history the
          // pane exists to show now that a render freezes its own snapshot.
          initialRevisionId={initialRevisionId ?? null}
          onClose={onClose}
          onRenderActivityChange={onRenderActivityChange}
          onImmersiveChange={onImmersiveChange}
        />
      )}
    </aside>
  );
}
