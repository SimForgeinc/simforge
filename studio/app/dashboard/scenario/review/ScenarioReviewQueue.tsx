"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ClipboardCheck, RefreshCw } from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import { useSetPageTitle } from "@/app/components/TopBarSlot";
import { VideoPreviewTile } from "@/app/components/VideoPreviewTile";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { EmptyState } from "@/app/components/ui/empty-state";
import { PageHeader } from "@/app/components/ui/page-header";
import { cn } from "@/app/lib/utils";
import {
  SCENARIO_REVIEW_QUEUE_PAGE_SIZE,
  ScenarioReviewQueuePageSchema,
  type ScenarioReviewQueueItem,
} from "@/app/lib/scenario/review-contracts";

const SCORES = [1, 2, 3, 4, 5] as const;

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Ported verbatim from v1: a global shortcut must not fire while the operator is typing. */
function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

async function fetchQueuePage(cursor?: string | null) {
  const params = new URLSearchParams({ limit: String(SCENARIO_REVIEW_QUEUE_PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`/api/uniscenario/review-queue?${params}`, { cache: "no-store" });
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? "Failed to load the review queue.");
  return ScenarioReviewQueuePageSchema.parse(body);
}

export function ScenarioReviewQueue() {
  useSetPageTitle("Scenario Review");
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [items, setItems] = useState<ScenarioReviewQueueItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [ratingErrorId, setRatingErrorId] = useState<string | null>(null);

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);
    setRatingErrorId(null);
    try {
      const page = await fetchQueuePage();
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setActiveId(page.items[0]?.documentId ?? null);
    } catch (loadError) {
      setError(errorMessage(loadError, "Failed to load the review queue."));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await fetchQueuePage(nextCursor);
      setItems((current) => {
        const seen = new Set(current.map((item) => item.documentId));
        return [...current, ...page.items.filter((item) => !seen.has(item.documentId))];
      });
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      setError(errorMessage(loadError, "Failed to load more scenarios."));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  /**
   * Optimistic splice-out, with rollback to the original index on failure — v1's semantics exactly,
   * and the §5.6 house pattern. The rating is what removes the document from the queue, so the row
   * leaves immediately and comes back in place if the write fails.
   *
   * `revisionId` and `renderJobId` ride along so the rating records WHICH revision and WHICH render
   * was judged. That is the reshape's whole point (§6.2): v1 could not say this, because its
   * `draft_json` was mutable under the rating.
   */
  const rateDocument = useCallback(
    async (documentId: string, score: number) => {
      if (score < 1 || score > 5 || savingIds.has(documentId)) return;
      const index = items.findIndex((item) => item.documentId === documentId);
      const item = items[index];
      if (!item) return;
      const remaining = items.filter((candidate) => candidate.documentId !== documentId);
      const nextActive =
        remaining[index]?.documentId ?? remaining[index - 1]?.documentId ?? null;

      setSavingIds((current) => new Set(current).add(documentId));
      setRatingErrorId(null);
      setError(null);
      setItems(remaining);
      setActiveId(nextActive);

      try {
        const response = await fetch(
          `/api/uniscenario/documents/${encodeURIComponent(documentId)}/rating`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              score,
              reviewedVia: "queue",
              revisionId: item.revisionId,
              renderJobId: item.renderJobId,
            }),
          },
        );
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok) throw new Error(body?.error ?? "Failed to save the rating.");
        // Top the queue up so a long session never lands on an empty screen mid-review.
        if (nextCursor) void loadMore();
      } catch (saveError) {
        setItems((current) => {
          if (current.some((candidate) => candidate.documentId === item.documentId)) return current;
          const restored = [...current];
          restored.splice(Math.min(index, restored.length), 0, item);
          return restored;
        });
        setActiveId(item.documentId);
        setRatingErrorId(item.documentId);
        setError(errorMessage(saveError, "Failed to save the rating."));
      } finally {
        setSavingIds((current) => {
          const next = new Set(current);
          next.delete(documentId);
          return next;
        });
      }
    },
    [items, loadMore, nextCursor, savingIds],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }
      if (/^[1-5]$/.test(event.key) && activeId) {
        event.preventDefault();
        void rateDocument(activeId, Number(event.key));
        return;
      }
      if (event.key.toLowerCase() !== "n" || items.length < 2) return;
      event.preventDefault();
      const currentIndex = Math.max(0, items.findIndex((item) => item.documentId === activeId));
      const next = items[(currentIndex + 1) % items.length];
      if (!next) return;
      setActiveId(next.documentId);
      cardRefs.current.get(next.documentId)?.focus();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeId, items, rateDocument]);

  return (
    <div className="flex min-h-full flex-col bg-background">
      <PageHeader
        eyebrow="Operator review"
        title="Scenario review queue"
        description="Rate pending scenarios oldest-first. A rating completes review for the workspace and records the revision and render that were judged."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/dashboard/scenario">Datasets</Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={() => void loadInitial()}
            >
              <RefreshCw className={cn(loading && "animate-spin")} />
              Refresh
            </Button>
          </>
        }
      />

      <div className="border-b border-border/70 bg-card/25 px-5 py-3 sm:px-6">
        <div
          className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground"
          aria-label="Review queue keyboard shortcuts"
        >
          <span className="font-medium text-foreground">Shortcuts</span>
          <span>
            <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-foreground">
              1–5
            </kbd>{" "}
            rate selected
          </span>
          <span>
            <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-foreground">
              n
            </kbd>{" "}
            next scenario
          </span>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="border-b border-destructive/40 bg-destructive/10 px-5 py-3 text-sm text-destructive sm:px-6"
        >
          {error}
        </div>
      )}

      <div className="flex-1 px-5 py-5 sm:px-6">
        {loading ? (
          <WorkspacePaneLoading
            className="min-h-[420px]"
            hint="Collecting unrated scenarios from this workspace."
            message="Loading the review queue…"
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ClipboardCheck className="size-6" aria-hidden />}
            title="Nothing left to review"
            description="Every scenario in this workspace has at least one rating. New scenarios appear here as they are created."
          />
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => {
              const isActive = item.documentId === activeId;
              const isSaving = savingIds.has(item.documentId);
              return (
                <li key={item.documentId}>
                  <article
                    ref={(el) => {
                      if (el) cardRefs.current.set(item.documentId, el);
                      else cardRefs.current.delete(item.documentId);
                    }}
                    tabIndex={0}
                    aria-current={isActive ? "true" : undefined}
                    onFocus={() => setActiveId(item.documentId)}
                    className={cn(
                      "flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isActive && "border-primary/60 bg-card/80",
                      ratingErrorId === item.documentId && "border-destructive/60",
                    )}
                  >
                    <VideoPreviewTile
                      label={item.title}
                      eyebrow={item.datasetName ?? "Dataset"}
                      videoUrl={
                        item.previewArtifactId
                          ? `/api/uniscenario/artifacts/${encodeURIComponent(item.previewArtifactId)}`
                          : null
                      }
                      emptyLabel={
                        item.renderState ? `No video (render ${item.renderState})` : "Not rendered"
                      }
                    />

                    <div className="min-w-0 space-y-1">
                      <h3 className="truncate text-sm font-semibold text-foreground">{item.title}</h3>
                      <p className="text-xs text-muted-foreground">
                        {item.mapLabel ?? "No map"} · {formatDate(item.createdAt)}
                      </p>
                      {item.description && (
                        <p className="line-clamp-2 text-xs text-muted-foreground/90">
                          {item.description}
                        </p>
                      )}
                    </div>

                    {/* v2's classification context, standing in for v1's INTENTION_FIELDS — see the
                        note in review-contracts.ts for why those seven fields are not portable. */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline">{item.reviewState}</Badge>
                      {item.archetype && <Badge variant="secondary">{item.archetype}</Badge>}
                      {item.contentTags.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px]">
                          {tag}
                        </Badge>
                      ))}
                      {item.renderJobId && (
                        <Badge variant="outline" className="font-mono text-[10px]">
                          render {item.renderJobId.slice(-6)}
                        </Badge>
                      )}
                      {item.revisionId && (
                        <Badge variant="outline" className="font-mono text-[10px]">
                          rev {item.revisionId.slice(-6)}
                        </Badge>
                      )}
                    </div>

                    <div
                      className="mt-auto flex items-center gap-1.5"
                      role="group"
                      aria-label={`Rate ${item.title}`}
                    >
                      {SCORES.map((score) => (
                        <Button
                          key={score}
                          type="button"
                          size="sm"
                          variant={item.viewerScore === score ? "default" : "outline"}
                          disabled={isSaving}
                          onClick={() => void rateDocument(item.documentId, score)}
                          aria-label={`Rate ${score} of 5`}
                        >
                          {score}
                        </Button>
                      ))}
                      {isSaving && (
                        <CloudActivityIndicator
                          className="ml-1 text-xs text-muted-foreground"
                          label="Saving rating"
                        />
                      )}
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}

        {nextCursor && items.length > 0 && (
          <div className="mt-5 flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? (
                <CloudActivityIndicator label="Loading…" />
              ) : "Load more"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
