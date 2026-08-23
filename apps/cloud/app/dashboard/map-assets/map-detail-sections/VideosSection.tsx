"use client";

import { ChevronRight, Play } from "lucide-react";
import { cn } from "@/app/lib/utils";
import { s3UriToMapAssetProxyUrl } from "@/app/lib/media-utils";

/** A fly-by `mp4` artifact, optionally paired with its low-res preview clip. */
type FlybyArtifact = {
  uri: string;
  artifact_type: string;
  label?: string;
  /** S3 URI of the matching `mp4_preview` clip, when one exists. */
  previewUri?: string | null;
};

/** Props for the VideosSection component. */
type VideosSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  mp4Artifacts: FlybyArtifact[];
  assetId: string;
  /** S3 URI of the map thumbnail, used as the preview poster while it loads. */
  thumbnailUri?: string | null;
  onViewArtifact: (info: { proxyUrl: string; label?: string }) => void;
};

/** Display playable MP4 video artifacts for a map asset. */
export function VideosSection({
  open,
  onToggleOpen,
  mp4Artifacts,
  assetId,
  thumbnailUri,
  onViewArtifact,
}: VideosSectionProps) {
  const posterUrl = thumbnailUri ? s3UriToMapAssetProxyUrl(thumbnailUri, assetId) : null;

  return (
    <section>
      <button
        type="button"
        onClick={onToggleOpen}
        className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
        />
        Videos
      </button>
      {open && (
        <ul className="mt-2 space-y-2">
          {mp4Artifacts.map((artifact) => {
            const proxyUrl = s3UriToMapAssetProxyUrl(artifact.uri, assetId);
            if (!proxyUrl) return null;
            const label = artifact.label || "Fly-by video";
            const previewUrl = artifact.previewUri
              ? s3UriToMapAssetProxyUrl(artifact.previewUri, assetId)
              : null;

            // With a preview clip, show a larger 16:9 thumbnail of its first
            // frame (static — no autoplay) with a play overlay. Clicking always
            // opens the full-res mp4 in the media panel below the map.
            if (previewUrl) {
              return (
                <li key={artifact.uri}>
                  <button
                    type="button"
                    onClick={() => onViewArtifact({ proxyUrl, label: artifact.label })}
                    className="group block w-full overflow-hidden rounded-md border border-border bg-muted/30 text-left transition-colors hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="relative aspect-video w-full bg-muted/30">
                      <video
                        // `#t=0.1` nudges the element to decode and paint an
                        // actual frame; the poster covers the gap until then.
                        src={`${previewUrl}#t=0.1`}
                        poster={posterUrl ?? undefined}
                        muted
                        playsInline
                        preload="metadata"
                        aria-label={label}
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/10">
                        <span className="flex size-11 items-center justify-center rounded-full bg-foreground/80 text-background transition-transform group-hover:scale-110">
                          <Play className="size-5 fill-current" />
                        </span>
                      </div>
                    </div>
                    <span className="block truncate px-2 py-1.5 text-xs text-muted-foreground group-hover:text-foreground">
                      {label}
                    </span>
                  </button>
                </li>
              );
            }

            // No preview available — keep the compact play-icon row.
            return (
              <li key={artifact.uri}>
                <button
                  type="button"
                  onClick={() => onViewArtifact({ proxyUrl, label: artifact.label })}
                  className="group flex w-full items-center gap-2 overflow-hidden rounded-md border border-border bg-muted/30 py-1.5 pl-1.5 pr-2 transition-colors hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex size-12 shrink-0 items-center justify-center rounded bg-muted/60">
                    <span className="flex size-7 items-center justify-center rounded-full bg-foreground/80 text-background transition-transform group-hover:scale-110">
                      <Play className="size-3.5 fill-current" />
                    </span>
                  </div>
                  <span className="min-w-0 flex-1 truncate text-left text-xs text-muted-foreground group-hover:text-foreground">
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
