"use client";

import { Star } from "lucide-react";
import type { ScenarioRatingAggregateDto } from "@/app/lib/scenario/contracts";
import { Badge } from "@/app/components/ui/badge";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { cn } from "@/app/lib/utils";

/**
 * The 1–5 star widget, ported one-to-one from v1's `ScenarioRating`.
 *
 * `reviewState` carries v1's exact semantics from `document_review_state_v`: no ratings is pending,
 * any single score below four rejects, otherwise accepted (§6.2).
 */
export function ScenarioRating({
  aggregate,
  loading = false,
  saving = false,
  error = null,
  documentName,
  onSetRating,
}: {
  aggregate?: ScenarioRatingAggregateDto;
  loading?: boolean;
  saving?: boolean;
  error?: string | null;
  documentName: string;
  onSetRating: (rating: number) => void;
}) {
  const rating = aggregate?.viewerScore ?? 0;
  return (
    <div className="mt-2 flex min-h-5 flex-wrap items-center gap-1.5">
      <div
        className="flex items-center gap-1"
        role="radiogroup"
        aria-label={`Rating for ${documentName}`}
        data-scenario-rating={rating}
      >
        {[1, 2, 3, 4, 5].map((star) => {
          const filled = rating >= star;
          return (
            <button
              key={star}
              type="button"
              role="radio"
              aria-checked={rating === star}
              aria-label={`${star} ${star === 1 ? "star" : "stars"}`}
              title={`${star} ${star === 1 ? "star" : "stars"}`}
              disabled={loading || saving}
              className={cn(
                "flex size-4 items-center justify-center transition-colors hover:text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-wait disabled:opacity-50",
                filled ? "text-primary" : "text-foreground/25",
              )}
              onClick={() => onSetRating(star)}
            >
              <Star
                className={cn("size-3.5", filled ? "fill-current" : "fill-none")}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>
      <span
        className="font-meta text-micro uppercase tracking-meta-narrow text-muted-foreground"
        data-scenario-rating-aggregate=""
      >
        {saving || loading ? (
          <CloudActivityIndicator label={saving ? "Saving…" : "Loading…"} />
        ) : error
              ? "Rating unavailable"
              : aggregate && aggregate.ratingCount > 0
                ? `${aggregate.averageScore.toFixed(1)} avg · ${aggregate.ratingCount}`
                : "No ratings"}
      </span>
      {aggregate?.reviewState === "rejected" ? (
        <Badge
          variant="outline"
          className="h-4 rounded-full border-red-400/40 bg-red-400/10 px-1.5 py-0 font-meta text-[8px] uppercase tracking-meta-narrow text-red-300"
        >
          Rejected (&lt;4)
        </Badge>
      ) : null}
    </div>
  );
}
