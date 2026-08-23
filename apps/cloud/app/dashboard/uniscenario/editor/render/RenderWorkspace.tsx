"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, PanelRightClose, RefreshCw, Sparkles, Undo2, EyeOff } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import { useVisiblePolling } from "@/app/lib/use-visible-polling";
import { listBrowserRecordingsClient as listBrowserRecordings } from "@/app/lib/uniscenario/recording-client";
import { useUniScenarioNotification } from "../status";
import { ArtifactsWorkspacePanel } from "./ArtifactsWorkspacePanel";
import { RenderGalleryTile } from "./RenderGalleryTile";
import { RenderConfigPanel } from "./RenderConfigPanel";
import { RenderTheater } from "./RenderTheater";
import { RenderProgressView } from "./RenderProgressView";
import { BrowserRecordingDetails } from "./BrowserRecordingDetails";
import { EsminiGalleryTile, RecordingGalleryTile } from "./UnifiedGalleryTiles";
import {
  fetchRenderGallery,
  listValidationRuns,
  RenderRequestError,
  setRenderJobHidden,
  type UniScenarioValidationRunDto,
} from "./api";
import { formatTimestamp, hasLiveJob, humanizeCode, jobModeLabel, jobModeTag, renderStateVisual } from "./render-view-model";
import type { UniScenarioGalleryItemDto } from "@/app/lib/uniscenario/render/contracts";
import type { BrowserRecordingSummaryDto } from "@/app/lib/uniscenario/recording-contracts";
import type { ScenarioTemplateV2 } from "@uniscenarios/scenario-model";

const POLL_INTERVAL_MS = 5000;

type GalleryFilter = "all" | "carla" | "browser" | "esmini";

const FILTER_LABELS: Record<GalleryFilter, string> = {
  all: "All",
  carla: "CARLA",
  browser: "Browser",
  esmini: "esmini",
};

/** One entry of the unified gallery, whatever produced it. */
type UnifiedGalleryEntry =
  | { kind: "job"; at: number; job: UniScenarioGalleryItemDto }
  | { kind: "recording"; at: number; recording: BrowserRecordingSummaryDto }
  | { kind: "esmini"; at: number; run: UniScenarioValidationRunDto };

/**
 * Which of the pane's states is showing.
 *
 * One union rather than the four independent booleans this used to keep (`configOpen`,
 * `expandedJobId`, `openRecordingId`, `artifactsOpen`): they were mutually exclusive in practice and
 * nothing enforced it, so opening a render while the config dialog was up stacked two overlays. It
 * also makes "does this state want the full width" a single expression.
 */
type WorkspaceView =
  | { kind: "gallery" }
  | { kind: "render"; jobId: string }
  | { kind: "progress"; jobId: string }
  | { kind: "create" }
  | { kind: "recording"; recordingId: string }
  | { kind: "artifacts" };

/**
 * States that claim the pane's full width, sliding the scenario list out.
 *
 * Only the two that show footage: a video is the thing being judged, and pane width is not enough
 * of it. Everything else stays beside the scenario list.
 *
 * The create form is excluded even though it is the pane's biggest view. Setting a render up is
 * work an author does *about* a scenario, and shoving the list they just picked from off-screen to
 * make room for a form takes away the thing that says which scenario they are configuring. The
 * artifacts browser is excluded for the same kind of reason: it is a list, it reads fine at pane
 * width, and it is used to compare against the scenarios still visible next to it.
 */
function viewIsImmersive(view: WorkspaceView): boolean {
  return view.kind === "render" || view.kind === "recording";
}

function isFailedOrCancelled(item: UniScenarioGalleryItemDto): boolean {
  return item.jobState === "failed" || item.jobState === "cancelled";
}

function entryTag(entry: UnifiedGalleryEntry): Exclude<GalleryFilter, "all"> {
  if (entry.kind === "esmini") return "esmini";
  if (entry.kind === "recording") return "browser";
  return jobModeTag(entry.job.jobMode);
}

function entryFailed(entry: UnifiedGalleryEntry): boolean {
  if (entry.kind === "job") return isFailedOrCancelled(entry.job);
  if (entry.kind === "recording") return entry.recording.status === "failed" || entry.recording.status === "cancelled";
  return entry.run.validation_state === "failed" || entry.run.validation_state === "errored";
}

function entryLive(entry: UnifiedGalleryEntry): boolean {
  if (entry.kind === "job") return renderStateVisual(entry.job.jobState).live;
  if (entry.kind === "recording") return entry.recording.status === "running";
  return entry.run.validation_state === "queued" || entry.run.validation_state === "running";
}

/**
 * The render workspace: the pane's router, and the gallery that is its home state.
 *
 * Every render, recording and esmini replay for the scenario appears in one newest-first grid of
 * hover-playable tiles, with backend filter chips above it. Opening a tile, or starting a new render,
 * replaces this view rather than covering it — the dialogs those two used to be are now
 * `RenderTheater` and `RenderConfigPanel`. Playback additionally takes the pane's full width and
 * slides the scenario list out; that is what `viewIsImmersive` decides and `onImmersiveChange`
 * reports.
 *
 * Render submission is document → immutable revision → execution package → one canonical
 * `uniscenario.render-intent/v1`. Both browser and CARLA are registered GPU workers; this workspace
 * only submits and reconnects to durable state.
 */
export function RenderWorkspace({
  revisionId,
  documentId,
  documentTitle,
  currentContent,
  currentContentSha256,
  ensureSnapshot,
  onRestoreSnapshot,
  onClose,
  onRenderActivityChange,
  onImmersiveChange,
}: {
  /** Pins the pane to one immutable snapshot. Null lists the document's whole render history. */
  revisionId: string | null;
  documentId: string;
  documentTitle: string | null;
  currentContent?: ScenarioTemplateV2 | null;
  /** The draft's server-computed digest, compared against each render's snapshot digest. */
  currentContentSha256?: string | null;
  /** Freezes the open draft and resolves its snapshot id. Called when a render is created. */
  ensureSnapshot: (signal?: AbortSignal) => Promise<string>;
  /** Restores a render's snapshot over the open draft. */
  onRestoreSnapshot?: (revisionId: string) => Promise<void>;
  onClose: () => void;
  onRenderActivityChange?: (activityKey: string, live: boolean) => void;
  /** Reports whether the current view wants the pane's full width. */
  onImmersiveChange?: (immersive: boolean) => void;
}) {
  const [items, setItems] = useState<UniScenarioGalleryItemDto[]>([]);
  const [recordings, setRecordings] = useState<BrowserRecordingSummaryDto[]>([]);
  const [esminiRuns, setEsminiRuns] = useState<UniScenarioValidationRunDto[]>([]);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadedActivityKey, setLoadedActivityKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hideBusyId, setHideBusyId] = useState<string | null>(null);
  const [recentlyHidden, setRecentlyHidden] = useState<UniScenarioGalleryItemDto[]>([]);
  const [showFailed, setShowFailed] = useState(false);
  const [filter, setFilter] = useState<GalleryFilter>("all");
  // The gallery is the home state. This used to open the New-render dialog straight over the gallery
  // when a deep link asked for the "recording" tab; with the dialog gone that would land the author
  // in the create form with the scenario's existing renders hidden behind it.
  const [view, setView] = useState<WorkspaceView>({ kind: "gallery" });
  const backToGallery = useCallback(() => setView({ kind: "gallery" }), []);

  const immersive = viewIsImmersive(view);
  useEffect(() => {
    onImmersiveChange?.(immersive);
  }, [immersive, onImmersiveChange]);
  // Closing the pane while a render was expanded must not leave the scenario list slid out.
  useEffect(() => () => onImmersiveChange?.(false), [onImmersiveChange]);
  const renderActivityKey = `${documentId}:${revisionId ?? "none"}`;

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        // Document-scoped unless the pane was deep-linked to one snapshot. A render freezes its own
        // snapshot, so scoping to a single revision would drop the scenario's earlier renders the
        // moment the author edited anything.
        const [result, validationRuns, nextRecordings] = await Promise.all([
          fetchRenderGallery(revisionId ? { revisionId, limit: 60 } : { documentId, limit: 60 }, signal),
          revisionId ? listValidationRuns(revisionId, signal).catch(() => null) : Promise.resolve(null),
          listBrowserRecordings({ documentId, revisionId, signal }).catch(() => null),
        ]);
        if (signal?.aborted) return;
        setLoadedActivityKey(renderActivityKey);
        setItems(result.items);
        setHiddenCount(result.hiddenCount);
        if (validationRuns) {
          setEsminiRuns(validationRuns.filter((run) => run.validator_kind === "esmini"));
        } else if (!revisionId) {
          setEsminiRuns([]);
        }
        if (nextRecordings) {
          setRecordings(Array.isArray(nextRecordings) ? nextRecordings : []);
        }
        setError(null);
      } catch (cause) {
        if (signal?.aborted) return;
        setError(cause instanceof Error ? cause.message : "render_gallery_failed");
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [documentId, renderActivityKey, revisionId],
  );

  // A new scope (another document, another snapshot, a finished recording) means the render or
  // recording that was open belongs to the previous one.
  useEffect(() => {
    setLoading(true);
    setLoadedActivityKey(null);
    setRecentlyHidden([]);
    setView((current) =>
      current.kind === "render" || current.kind === "recording" ? { kind: "gallery" } : current,
    );
  }, [load]);

  const entries = useMemo<UnifiedGalleryEntry[]>(() => {
    const all: UnifiedGalleryEntry[] = [
      ...items.map((job) => ({ kind: "job" as const, at: Date.parse(job.createdAt) || 0, job })),
      ...recordings.map((recording) => ({
        kind: "recording" as const,
        at: Date.parse(recording.createdAt) || 0,
        recording,
      })),
      ...esminiRuns.map((run) => ({ kind: "esmini" as const, at: Date.parse(run.created_at) || 0, run })),
    ];
    return all.sort((a, b) => b.at - a.at);
  }, [items, recordings, esminiRuns]);

  /**
   * Whether a render's snapshot still matches the scenario on screen.
   *
   * Both sides are the server's `canonicalContentSha256`, never the client's `contentHash` — the two
   * use different serializers and would disagree on identical content. Unknown (null) whenever
   * either digest is missing, so a tile is only ever marked outdated on positive evidence.
   */
  const isOutdated = useCallback(
    (job: UniScenarioGalleryItemDto) => {
      if (!currentContentSha256 || !job.revisionContentSha256) return false;
      return job.revisionContentSha256 !== currentContentSha256;
    },
    [currentContentSha256],
  );

  const [restoringRevisionId, setRestoringRevisionId] = useState<string | null>(null);

  const restoreSnapshot = useCallback(
    async (job: UniScenarioGalleryItemDto) => {
      if (!onRestoreSnapshot) return;
      setRestoringRevisionId(job.revisionId);
      try {
        await onRestoreSnapshot(job.revisionId);
        setError(null);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "This render's scenario could not be restored.",
        );
      } finally {
        setRestoringRevisionId(null);
      }
    },
    [onRestoreSnapshot],
  );

  const renderWorkLive = hasLiveJob(items) || entries.some(entryLive);
  useEffect(() => {
    if (!loading && loadedActivityKey === renderActivityKey) {
      onRenderActivityChange?.(renderActivityKey, renderWorkLive);
    }
  }, [loadedActivityKey, loading, onRenderActivityChange, renderActivityKey, renderWorkLive]);
  useVisiblePolling(
    load,
    POLL_INTERVAL_MS,
    loading || renderWorkLive,
    renderActivityKey,
  );

  useUniScenarioNotification(
    "uniscenario-render:gallery",
    error
      ? {
          severity: "error",
          source: "render",
          message: "The render gallery could not be loaded.",
          detail: error,
          action: { label: "Retry", run: () => void load() },
        }
      : null,
  );

  const failedCount = useMemo(() => entries.filter(entryFailed).length, [entries]);
  const visibleEntries = useMemo(
    () =>
      entries
        .filter((entry) => (showFailed ? true : !entryFailed(entry)))
        .filter((entry) => filter === "all" || entryTag(entry) === filter),
    [entries, filter, showFailed],
  );
  const liveCount = useMemo(() => entries.filter(entryLive).length, [entries]);
  const tagCounts = useMemo(() => {
    const counts: Record<Exclude<GalleryFilter, "all">, number> = { carla: 0, browser: 0, esmini: 0 };
    for (const entry of entries) {
      if (showFailed || !entryFailed(entry)) counts[entryTag(entry)] += 1;
    }
    return counts;
  }, [entries, showFailed]);

  useEffect(() => {
    if (failedCount === 0) setShowFailed(false);
  }, [failedCount]);

  async function hide(item: UniScenarioGalleryItemDto, hidden: boolean) {
    setHideBusyId(item.id);
    // Optimistic splice rather than a refetch: the gallery is a live list, and a full reload would
    // also discard the poll's in-flight state. The row is put back if the write fails.
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    setRecentlyHidden((current) =>
      hidden ? [item, ...current.filter((entry) => entry.id !== item.id)] : current,
    );
    try {
      await setRenderJobHidden(item.id, hidden);
      setHiddenCount((current) => Math.max(0, current + (hidden ? 1 : -1)));
      if (!hidden) await load();
    } catch (cause) {
      setItems((current) =>
        current.some((entry) => entry.id === item.id) ? current : [item, ...current],
      );
      setRecentlyHidden((current) => current.filter((entry) => entry.id !== item.id));
      setError(
        cause instanceof RenderRequestError
          ? humanizeCode(cause.code)
          : "The render could not be hidden.",
      );
    } finally {
      setHideBusyId(null);
    }
  }

  async function unhide(item: UniScenarioGalleryItemDto) {
    setRecentlyHidden((current) => current.filter((entry) => entry.id !== item.id));
    try {
      await setRenderJobHidden(item.id, false);
      setHiddenCount((current) => Math.max(0, current - 1));
      await load();
    } catch {
      setRecentlyHidden((current) => [item, ...current]);
      setError("The render could not be restored.");
    }
  }

  const summary =
    entries.length === 0
      ? "No renders yet"
      : visibleEntries.length === 0
        ? "No visible renders"
        : `${visibleEntries.length} ${visibleEntries.length === 1 ? "render" : "renders"}${liveCount > 0 ? ` · ${liveCount} running` : ""}`;

  return (
    <div
      className="render-glass-pane render-hairline flex min-h-0 flex-1 flex-col border-l backdrop-blur-2xl backdrop-saturate-150"
      data-render-view={view.kind}
    >
      {/* Always present, whatever the view: the scenario being looked at, and the way out of the
          pane. Each view owns its own back affordance, so this bar never carries one. */}
      <div className="flex shrink-0 items-center gap-2 border-b render-hairline px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">Renders</h2>
          <p className="truncate text-micro uppercase tracking-meta text-muted-foreground">
            {documentTitle ?? "This scenario"} · {summary}
          </p>
        </div>
        <Button
          aria-label="Browse workspace artifacts"
          aria-pressed={view.kind === "artifacts"}
          onClick={() =>
            setView((current) =>
              current.kind === "artifacts" ? { kind: "gallery" } : { kind: "artifacts" },
            )
          }
          size="icon"
          variant={view.kind === "artifacts" ? "secondary" : "ghost"}
        >
          <FolderOpen aria-hidden="true" className="size-3.5" />
        </Button>
        <Button aria-label="Refresh renders" onClick={() => void load()} size="icon" variant="ghost">
          <RefreshCw aria-hidden="true" className="size-3.5" />
        </Button>
        <Button aria-label="Close the render workspace" onClick={onClose} size="icon" variant="ghost">
          <PanelRightClose aria-hidden="true" className="size-4" />
        </Button>
      </div>

      {view.kind === "render" ? (
        <RenderTheater
          jobId={view.jobId}
          onBack={backToGallery}
          onHiddenChange={() => void load()}
        />
      ) : view.kind === "progress" ? (
        <RenderProgressView
          jobId={view.jobId}
          onBack={backToGallery}
          onWatch={(jobId) => setView({ kind: "render", jobId })}
        />
      ) : view.kind === "create" ? (
        // No revision gate: the panel configures against the draft and freezes on submit.
        <RenderConfigPanel
          currentContent={currentContent ?? null}
          onClose={backToGallery}
          onEsminiRunCreated={() => {
            backToGallery();
            void load();
          }}
          onManagedJobCreated={(jobId) => {
            void load();
            // Its own status, not the theater: a job that has not rendered a frame has no footage,
            // and an empty video frame is what made submitting feel like nothing had happened.
            setView({ kind: "progress", jobId });
          }}
          ensureSnapshot={ensureSnapshot}
        />
      ) : view.kind === "recording" ? (
        <BrowserRecordingDetails
          onBack={backToGallery}
          recordingId={view.recordingId}
        />
      ) : view.kind === "artifacts" ? (
        <ArtifactsWorkspacePanel />
      ) : (
        <>
          <div className="render-view-enter flex shrink-0 flex-wrap items-center gap-2 border-b render-hairline px-4 py-2.5">
            {/* Never gated on `revisionId`: that prop only pins the pane to one snapshot for a history
                deep link, and is null for a scenario opened from the list — which disabled this
                button for every scenario that had never been rendered, i.e. the normal case. The
                create view freezes its own snapshot at submit through `ensureSnapshot`, so there is
                nothing to wait for here. */}
            <Button
              data-testid="new-render-button"
              onClick={() => setView({ kind: "create" })}
              size="sm"
            >
              <Sparkles aria-hidden="true" className="size-3.5" />
              New render
            </Button>
            <div aria-label="Filter renders by backend" className="flex items-center gap-1" role="group">
              {(Object.keys(FILTER_LABELS) as GalleryFilter[]).map((tag) => {
                const count = tag === "all" ? visibleEntries.length : tagCounts[tag];
                return (
                  <button
                    aria-pressed={filter === tag}
                    className={
                      filter === tag
                        ? "editor-motion bg-primary/15 px-2 py-1 text-micro uppercase tracking-meta text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        : "editor-motion px-2 py-1 text-micro uppercase tracking-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    }
                    key={tag}
                    onClick={() => setFilter(tag)}
                    type="button"
                  >
                    {FILTER_LABELS[tag]}
                    {tag !== "all" && count > 0 ? ` · ${count}` : ""}
                  </button>
                );
              })}
            </div>
            {failedCount > 0 ? (
              <Button
                aria-pressed={showFailed}
                onClick={() => setShowFailed((current) => !current)}
                size="sm"
                variant="outline"
              >
                {showFailed ? "Hide" : "Show"} failed · {failedCount}
              </Button>
            ) : null}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {recentlyHidden.length > 0 ? (
            <ul className="mb-3 flex flex-col gap-1">
              {recentlyHidden.map((item) => (
                <li
                  className="flex items-center gap-2 border border-border bg-muted/40 px-2.5 py-1.5 backdrop-blur"
                  key={item.id}
                >
                  <EyeOff aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground">
                    Hid {jobModeLabel(item.jobMode).toLowerCase()} from {formatTimestamp(item.createdAt)}
                  </span>
                  <Button onClick={() => void unhide(item)} size="sm" variant="outline">
                    <Undo2 aria-hidden="true" className="size-3" />
                    Undo
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          {loading && entries.length === 0 ? (
            <WorkspacePaneLoading
              className="min-h-72"
              hint="Reading render jobs, recordings, and esmini replays."
              message="Loading renders…"
            />
          ) : visibleEntries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
              <p className="font-heavy text-2xl tracking-tight text-foreground/20">
                {entries.length === 0 ? "Create a render." : "No visible renders."}
              </p>
              <p className="text-xs text-muted-foreground">
                {entries.length === 0
                  ? "Videos and artifacts will appear here."
                  : filter !== "all"
                    ? "Nothing matches this filter."
                    : "Failed and cancelled renders are filtered out."}
              </p>
            </div>
          ) : (
            <div
              className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
              data-testid="unified-render-gallery"
            >
              {visibleEntries.map((entry, index) => (
                <div
                  className="render-tile-enter"
                  key={
                    entry.kind === "job"
                      ? entry.job.id
                      : entry.kind === "recording"
                        ? entry.recording.id
                        : entry.run.id
                  }
                  // Consumed by the stagger; the cap lives in the CSS so a long gallery does not
                  // make its last tile arrive late.
                  style={{ "--render-tile-index": index } as React.CSSProperties}
                >
                  {entry.kind === "job" ? (
                    <RenderGalleryTile
                      hideBusy={hideBusyId === entry.job.id}
                      item={entry.job}
                      onHide={() => void hide(entry.job, true)}
                      onOpen={() => setView(renderStateVisual(entry.job.jobState).live
                        // A job still moving has status to show and nothing to play yet.
                        ? { kind: "progress", jobId: entry.job.id }
                        : { kind: "render", jobId: entry.job.id })}
                      onRestore={
                        onRestoreSnapshot && isOutdated(entry.job)
                          ? () => void restoreSnapshot(entry.job)
                          : undefined
                      }
                      outdated={isOutdated(entry.job)}
                      restoreBusy={restoringRevisionId === entry.job.revisionId}
                    />
                  ) : entry.kind === "recording" ? (
                    <RecordingGalleryTile
                      onOpen={() => setView({ kind: "recording", recordingId: entry.recording.id })}
                      recording={entry.recording}
                    />
                  ) : (
                    <EsminiGalleryTile run={entry.run} />
                  )}
                </div>
              ))}
            </div>
          )}

          {hiddenCount > 0 ? (
            <p className="mt-3 text-micro text-muted-foreground">
              {hiddenCount} hidden {hiddenCount === 1 ? "render" : "renders"} not shown. A hidden
              render keeps all of its files and stays reachable by its job id.
            </p>
          ) : null}
          </div>
        </>
      )}
    </div>
  );
}
