"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/app/components/ui/button";

/**
 * Full-pane playback for one artifact — manifest #148.
 *
 * Takes a URL rather than an artifact id because the signature was minted per request by the route
 * that listed the artifact and must not be re-derived or stored. If the modal is open long enough for
 * a 1h signature to expire, the `<video>` element's own error state is the honest outcome; refreshing
 * the list re-signs.
 */
export function VideoPreviewModal({
  open,
  title,
  eyebrow,
  url,
  mediaType,
  onClose,
}: {
  open: boolean;
  title: string;
  eyebrow?: string | null;
  url: string | null;
  mediaType: string;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;

  const isVideo = mediaType.startsWith("video/");

  return (
    <div
      aria-label={title}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-4 backdrop-blur"
      role="dialog"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-[85vh] w-full max-w-[1200px] flex-col overflow-hidden border border-border bg-card shadow-2xl">
        <header className="flex items-center gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0 flex-1">
            {eyebrow ? (
              <p className="truncate text-micro uppercase tracking-meta text-muted-foreground">
                {eyebrow}
              </p>
            ) : null}
            <h2 className="truncate text-sm font-semibold text-card-foreground">{title}</h2>
          </div>
          <Button aria-label="Close preview" onClick={onClose} size="icon" variant="ghost">
            <X aria-hidden="true" className="size-4" />
          </Button>
        </header>
        <div className="relative min-h-0 flex-1 bg-background">
          {!url ? (
            <p className="grid size-full place-items-center text-meta uppercase tracking-meta text-muted-foreground">
              This file has no playable URL.
            </p>
          ) : isVideo ? (
            <video autoPlay className="size-full object-contain" controls loop muted playsInline src={url}>
              <track kind="captions" />
            </video>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- presigned URL; see RenderGalleryTile
            <img alt={title} className="size-full object-contain" src={url} />
          )}
        </div>
      </div>
    </div>
  );
}
