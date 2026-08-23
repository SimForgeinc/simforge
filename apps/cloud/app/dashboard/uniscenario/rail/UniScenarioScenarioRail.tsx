"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import {
  BarChart3,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  LayoutList,
  Pause,
  Play,
  Plus,
} from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import type { UniScenarioDocumentSummaryDto } from "@/app/lib/uniscenario/contracts";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { documentMapLabel, documentName } from "../list/document-list-utils";

/**
 * The in-editor scenario rail: every sibling document in the active dataset, selectable in place.
 *
 * This is what makes the editor navigable at all. Without it the editor opens `documents[0]` and every
 * other document in the dataset is unreachable — a dataset of 40 is a dataset where 39 are invisible.
 *
 * The rail is wider than v1's 72px strip because a v2 document has a title worth reading; v1's rail
 * showed an actor count and a runtime badge, which fit in a column that a scenario name does not.
 */
export function UniScenarioScenarioRail({
  datasetId,
  datasetName,
  documents,
  activeDocumentId,
  loading,
  error,
  canCreate,
  creating,
  autoplayPlaying,
  autoplayProgress,
  statusOpen,
  onSelectDocument,
  onSelectPrevious,
  onSelectNext,
  onCreateDocument,
  onToggleAutoplay,
  onToggleStatus,
  onBack,
}: {
  datasetId: string;
  datasetName: string | null;
  documents: UniScenarioDocumentSummaryDto[];
  activeDocumentId: string | null;
  loading: boolean;
  error: string | null;
  canCreate: boolean;
  creating: boolean;
  autoplayPlaying: boolean;
  autoplayProgress: number;
  statusOpen: boolean;
  onSelectDocument: (documentId: string) => void;
  onSelectPrevious: () => void;
  onSelectNext: () => void;
  onCreateDocument: () => void;
  onToggleAutoplay: () => void;
  onToggleStatus: () => void;
  /**
   * Return to the dataset list *within the same rail*, when the rail is the datasets page's sidebar.
   *
   * When given, the dataset label stops being a link out to the dataset route: on that page there is nowhere
   * to navigate to, and following a link would unmount the world scene beside the rail — the exact
   * teardown this rail's in-place selection exists to avoid. Omitted inside the editor, where the label
   * links to the full list as before.
   */
  onBack?: () => void;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);

  // Autoplay and Alt+Arrow both move the selection without the user scrolling, so the rail has to
  // follow. `nearest` rather than `center` so a manual click does not jump the list under the cursor.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeDocumentId]);

  return (
    <aside
      className="flex h-full w-[220px] shrink-0 flex-col border-r border-white/15 bg-transparent"
      data-testid="uniscenario-scenario-rail"
      aria-label="Scenarios in this dataset"
    >
      <div
        className="space-y-2 border-b border-white/15 p-3"
        data-testid="uniscenario-scenario-header"
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          <h2 className="font-meta text-micro font-bold uppercase tracking-meta-wider text-foreground">
            Scenarios
          </h2>
          <span className="font-meta text-micro tabular-nums text-white/70">
            {documents.length}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="flex min-w-0 flex-1 items-center gap-1 truncate font-meta text-micro uppercase tracking-meta-wider text-white/75 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Back to all datasets"
            >
              <ChevronLeft className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{datasetName ?? "Dataset"}</span>
            </button>
          ) : (
            <Link
              href={`/dashboard/uniscenario/${encodeURIComponent(datasetId)}`}
              className="min-w-0 flex-1 truncate font-meta text-micro uppercase tracking-meta-wider text-white/75 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Open the full scenario list"
            >
              <LayoutList className="mr-1 inline size-3" aria-hidden="true" />
              {datasetName ?? "Dataset"}
            </Link>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn("size-7 bg-transparent hover:bg-transparent", statusOpen && "text-primary")}
            aria-pressed={statusOpen}
            aria-label="Dataset status"
            title="Dataset status"
            onClick={onToggleStatus}
          >
            <BarChart3 className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Previous scenario"
            title="Previous scenario (Alt+↑)"
            onClick={onSelectPrevious}
          >
            <ChevronUp className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label="Next scenario"
            title="Next scenario (Alt+↓)"
            onClick={onSelectNext}
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className={cn(
              "h-7 flex-1 gap-1.5 bg-transparent px-2 font-meta text-micro font-bold uppercase tracking-meta hover:bg-transparent hover:text-primary",
              autoplayPlaying && "text-primary",
            )}
            aria-pressed={autoplayPlaying}
            title="Step through every scenario in this dataset"
            onClick={onToggleAutoplay}
          >
            {autoplayPlaying ? (
              <Pause className="size-3" aria-hidden="true" />
            ) : (
              <Play className="size-3" aria-hidden="true" />
            )}
            Review
          </Button>
        </div>
        {canCreate ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-9 w-full justify-center gap-1.5 rounded-none border-0 border-t border-white/10 bg-[#E8E044] px-0 font-meta text-micro font-bold uppercase tracking-meta text-black hover:bg-[#f1e949] hover:text-black"
            disabled={creating}
            onClick={onCreateDocument}
          >
            {creating ? (
              <CloudActivityIndicator />
            ) : (
              <Plus className="size-3" aria-hidden="true" />
            )}
            Add Scenario
          </Button>
        ) : null}
        {autoplayPlaying ? (
          <div
            className="h-px w-full bg-white/15"
            role="progressbar"
            aria-label="Time until the next scenario"
            aria-valuenow={Math.round(autoplayProgress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="h-full bg-primary transition-[width] duration-100 ease-linear motion-reduce:transition-none"
              style={{ width: `${autoplayProgress * 100}%` }}
            />
          </div>
        ) : null}
      </div>

      <div className="uniscenario-glass-scrollbar min-h-0 flex-1 overflow-y-auto px-3">
        {error ? (
          <p className="px-1 py-2 text-meta text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {loading && documents.length === 0 ? (
          <WorkspacePaneLoading
            className="min-h-52"
            hint="Reading scenarios in this dataset."
            message="Loading scenarios"
          />
        ) : documents.length === 0 ? (
          <p className="px-1 py-2 text-meta text-white/75">
            No scenarios in this dataset yet.
          </p>
        ) : (
          <ul className="divide-y divide-white/10">
            {documents.map((document) => {
              const active = document.id === activeDocumentId;
              return (
                <li key={document.id}>
                  <button
                    ref={active ? activeRef : undefined}
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelectDocument(document.id)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 border-l-2 bg-transparent px-2 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                      active
                        ? "border-l-primary text-foreground"
                        : "border-l-transparent text-white/75 hover:border-l-primary/60 hover:text-white",
                    )}
                    data-document-id={document.id}
                  >
                    <span className="line-clamp-2 text-meta font-medium leading-tight">
                      {documentName(document)}
                    </span>
                    <span className="truncate font-meta text-micro uppercase tracking-meta-tight text-white/70">
                      {documentMapLabel(document)} · {document.roleCount}{" "}
                      {document.roleCount === 1 ? "role" : "roles"}
                    </span>
                    {document.hasRender ? (
                      <span className="font-meta text-micro uppercase tracking-meta-tight text-green-400">
                        Rendered
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
