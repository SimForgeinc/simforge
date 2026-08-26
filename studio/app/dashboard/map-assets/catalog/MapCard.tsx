"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import { getMapAssetDescriptorTag } from "@simforge-oss/studio-shared";
import { getCardStats, getMapCapabilities, humanizeTag, rankDominantTags } from "./map-card-data";
import { CapabilityHints, CardStatsRow } from "./map-card-display";
import { FLYBY_PREVIEW_ARTIFACT_TYPE } from "@/app/lib/maps/flyby-preview";

// ---------------------------------------------------------------------------
// In-memory thumbnail cache — survives across navigations within the SPA.
// Stores object URLs created from fetched blobs. With ~100 maps at ~200KB
// each this is at most ~20MB, well within browser limits.
// ---------------------------------------------------------------------------
const thumbnailCache = new Map<string, string>(); // key → blob object URL
const inflight = new Map<string, Promise<string | null>>(); // key → pending fetch

function fetchAndCacheThumbnail(url: string): Promise<string | null> {
  const existing = thumbnailCache.get(url);
  if (existing) return Promise.resolve(existing);

  const pending = inflight.get(url);
  if (pending) return pending;

  const promise = fetch(url, { redirect: "follow" })
    .then((res) => {
      if (!res.ok) return null;
      return res.blob();
    })
    .then((blob) => {
      inflight.delete(url);
      if (!blob) return null;
      const objectUrl = URL.createObjectURL(blob);
      thumbnailCache.set(url, objectUrl);
      return objectUrl;
    })
    .catch(() => {
      inflight.delete(url);
      return null;
    });

  inflight.set(url, promise);
  return promise;
}

function CachedThumbnail({ url, alt }: { url: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(() => thumbnailCache.get(url) ?? null);

  useEffect(() => {
    if (thumbnailCache.has(url)) {
      setSrc(thumbnailCache.get(url)!);
      return;
    }
    let cancelled = false;
    fetchAndCacheThumbnail(url).then((objectUrl) => {
      if (!cancelled && objectUrl) setSrc(objectUrl);
    });
    return () => { cancelled = true; };
  }, [url]);

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground/30">
        <div className="size-6 animate-pulse rounded-full bg-muted/50" />
      </div>
    );
  }

  return (
    <Image
      src={src}
      alt={alt}
      fill
      sizes="(max-width: 768px) 100vw, 33vw"
      className="object-cover transition-transform duration-300 group-hover:scale-105"
      unoptimized
    />
  );
}

// ---------------------------------------------------------------------------
// Low-res fly-by preview that plays muted + looping while the card is on (or
// near) screen, falling back to the thumbnail poster otherwise. The <source>
// is only attached while the card is in view so a grid of ~100 cards doesn't
// fetch and decode every preview at once.
// ---------------------------------------------------------------------------
function CardPreviewVideo({
  videoUrl,
  posterUrl,
  alt,
}: {
  videoUrl: string;
  posterUrl: string | null;
  alt: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setActive(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => setActive(!!entries[0]?.isIntersecting),
      { rootMargin: "100px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (active) {
      const playPromise = el.play();
      if (playPromise) playPromise.catch(() => {});
    } else {
      el.pause();
    }
  }, [active]);

  return (
    <video
      ref={videoRef}
      src={active ? videoUrl : undefined}
      poster={posterUrl ?? undefined}
      aria-label={alt}
      muted
      loop
      playsInline
      preload="none"
      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
    />
  );
}



const MAX_TAGS = 3;

interface MapCardProps {
  asset: MapAsset;
}

export function MapCard({ asset }: MapCardProps) {
  const stats = getCardStats(asset);
  const caps = getMapCapabilities(asset);

  const placeContext = asset.place_context;
  const locationStr = placeContext
    ? [placeContext.city, placeContext.state, placeContext.country_code?.toUpperCase()]
        .filter(Boolean)
        .join(", ")
    : null;

  const thumbnailArtifact = asset.artifacts.find((a) => a.artifact_type === "thumbnail");
  const thumbnailKey = thumbnailArtifact
    ? thumbnailArtifact.uri.replace(/^s3:\/\/[^/]+\//, "")
    : null;
  const thumbnailUrl = thumbnailKey
    ? `/api/map-assets/${asset.map_asset_id}/media?key=${encodeURIComponent(thumbnailKey)}`
    : null;

  const previewArtifact = asset.artifacts.find(
    (a) => a.artifact_type === FLYBY_PREVIEW_ARTIFACT_TYPE,
  );
  const previewKey = previewArtifact
    ? previewArtifact.uri.replace(/^s3:\/\/[^/]+\//, "")
    : null;
  const previewUrl = previewKey
    ? `/api/map-assets/${asset.map_asset_id}/media?key=${encodeURIComponent(previewKey)}`
    : null;

  const rankedTags = rankDominantTags(asset);
  const tags = rankedTags.slice(0, MAX_TAGS);
  const remainingTags = rankedTags.length - MAX_TAGS;

  return (
    <Link
      href={`/dashboard/map-assets/${asset.map_asset_id}`}
      className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/20 hover:border-border/80"
    >
      {/* Thumbnail / fly-by preview */}
      <div className="relative aspect-video w-full overflow-hidden bg-muted/30">
        {previewUrl ? (
          <CardPreviewVideo videoUrl={previewUrl} posterUrl={thumbnailUrl} alt={asset.name} />
        ) : thumbnailUrl ? (
          <CachedThumbnail url={thumbnailUrl} alt={asset.name} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-muted-foreground/30">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m3 11 19-9-9 19-2-8-8-2z" />
            </svg>
          </div>
        )}
      </div>

      {/* Card body */}
      <div className="flex flex-1 flex-col gap-2.5 p-3.5">
        {/* Name + location */}
        <div>
          <h3 className="text-sm font-semibold leading-snug truncate group-hover:text-primary transition-colors">
            {asset.name}
          </h3>
          {locationStr && (
            <p className="mt-0.5 text-xs text-muted-foreground truncate">{locationStr}</p>
          )}
        </div>

        {/* Capability hints */}
        <CapabilityHints caps={caps} />

        {/* Quick stats */}
        <CardStatsRow stats={stats} />

        {/* Tags */}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tagId) => (
              <span
                key={tagId}
                className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary border border-primary/20"
                title={getMapAssetDescriptorTag(tagId)?.shortDefinition}
              >
                {humanizeTag(tagId)}
              </span>
            ))}
            {remainingTags > 0 && (
              <span className="inline-flex items-center rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
                +{remainingTags}
              </span>
            )}
          </div>
        )}

        {/* Action */}
        <div className="mt-auto pt-1">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
            Open Map
            <ArrowRight className="size-3" />
          </span>
        </div>
      </div>
    </Link>
  );
}
