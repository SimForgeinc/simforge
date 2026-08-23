"use client";

import { ChevronRight, Download, Play } from "lucide-react";
import { s3UriToMapAssetProxyUrl } from "@/app/lib/media-utils";
import { cn } from "@/app/lib/utils";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Props for the ArtifactsSection component. */
type ArtifactsSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  artifacts: { uri: string; artifact_type: string; label?: string; sha256?: string; size_bytes?: number | null; created_at?: string | null }[];
  assetId: string;
  onViewArtifact?: (info: { proxyUrl: string; label?: string }) => void;
};

/** Display downloadable artifact list with play/download controls and thumbnail preview. */
export function ArtifactsSection({
  open,
  onToggleOpen,
  artifacts,
  assetId,
  onViewArtifact,
}: ArtifactsSectionProps) {
  // `mp4_preview` is an auto-generated low-res downsample of a fly-by video,
  // managed by the map-flyby-preview Lambda and only surfaced on catalog cards.
  // Hide it here so the artifact list shows the real, user-managed assets.
  const visibleArtifacts = artifacts.filter((a) => a.artifact_type !== "mp4_preview");
  return (
    <section>
      <button
        type="button"
        onClick={onToggleOpen}
        className="flex w-full items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
        />
        Artifacts ({visibleArtifacts.length})
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <ul className="space-y-1">
            {visibleArtifacts.map((artifact, index) => {
              const proxyUrl = s3UriToMapAssetProxyUrl(artifact.uri, assetId);
              const filename = artifact.uri.split("/").pop() ?? "download";
              return (
                <li
                  key={`${artifact.uri}-${index}`}
                  className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{artifact.artifact_type}</span>
                      {artifact.label ? ` — ${artifact.label}` : ""}
                    </span>
                    <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
                      {artifact.created_at && <span>{formatDate(artifact.created_at)}</span>}
                      {artifact.created_at && artifact.size_bytes != null && <span>·</span>}
                      {artifact.size_bytes != null && <span>{formatFileSize(artifact.size_bytes)}</span>}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {artifact.artifact_type === "mp4" && proxyUrl && (
                      <button
                        type="button"
                        title="Play video"
                        aria-label={`Play ${artifact.label ?? artifact.artifact_type}`}
                        onClick={() => onViewArtifact?.({ proxyUrl, label: artifact.label })}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Play className="size-3.5" />
                      </button>
                    )}
                    {proxyUrl && (artifact.artifact_type === "mp4" || artifact.artifact_type === "image" || artifact.artifact_type === "thumbnail") ? (
                      <a
                        href={proxyUrl}
                        download={filename}
                        title={`Download ${filename}`}
                        aria-label={`Download ${filename}`}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Download className="size-3.5" />
                      </a>
                    ) : null}
                    {artifact.artifact_type === "search_index" ? (
                      <a
                        href={`/api/map-assets/${assetId}/search-index`}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${filename} in a new tab`}
                        aria-label={`Open ${filename} in a new tab`}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <Download className="size-3.5" />
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
