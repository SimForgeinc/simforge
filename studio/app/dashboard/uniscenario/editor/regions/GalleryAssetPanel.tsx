"use client";

import { useEffect, useMemo, useState, type DragEvent } from "react";
import type { EditorController, EditorState } from "@simforge/editor";
import type { CatalogId } from "@simforge/asset-catalog";
import { CarlaCompatibilityPill } from "@/app/components/CarlaCompatibilityPill";
import type { CarlaCompatibility } from "@/app/lib/uniscenario/carla-compatibility";
import type { GalleryAssetSummary } from "@/app/lib/asset-gallery/contracts";
import { resolveGalleryCatalogIds } from "@/app/lib/asset-gallery/editor-bridge";

const PAGE_SIZE = 24;
const CATALOG_DRAG_TYPE = "application/x-uniscenarios-catalog-id";
const GALLERY_COMPATIBILITY: CarlaCompatibility = {
  status: "browser-only",
  reason:
    "User-uploaded model has no CARLA runtime blueprint; it renders in browser preview and browser-recorded renders only.",
};

export function GalleryAssetPanel({
  controller,
  state,
  favorites,
  onFavorite,
  onRemember,
}: {
  controller: EditorController;
  state: EditorState | null;
  favorites: ReadonlySet<string>;
  onFavorite: (catalogId: string) => void;
  onRemember: (catalogId: CatalogId) => void;
}) {
  const [query, setQuery] = useState("");
  const [mine, setMine] = useState(false);
  const [items, setItems] = useState<GalleryAssetSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [armingId, setArmingId] = useState<string | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  const trimmedQuery = query.trim();
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(trimmedQuery), 250);
    return () => window.clearTimeout(timeout);
  }, [trimmedQuery]);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (mine) params.set("mine", "1");
    void fetch(`/api/asset-gallery?${params}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Could not load gallery assets (${response.status}).`);
        return response.json() as Promise<{
          items: GalleryAssetSummary[];
          nextCursor: string | null;
        }>;
      })
      .then(async (page) => {
        if (abort.signal.aborted) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
        const missing = new Set(await resolveGalleryCatalogIds(page.items.map((item) => item.catalogId)));
        if (abort.signal.aborted) return;
        setResolved(new Set(page.items.filter((item) => !missing.has(item.catalogId)).map((item) => item.catalogId)));
      })
      .catch((reason: unknown) => {
        if ((reason as { name?: string } | null)?.name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [debouncedQuery, mine]);

  const visibleItems = useMemo(() => {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.catalogId)) return false;
      seen.add(item.catalogId);
      return true;
    });
  }, [items]);

  const loadMore = async () => {
    if (!nextCursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ cursor: nextCursor, limit: String(PAGE_SIZE) });
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (mine) params.set("mine", "1");
      const response = await fetch(`/api/asset-gallery?${params}`);
      if (!response.ok) throw new Error(`Could not load gallery assets (${response.status}).`);
      const page = (await response.json()) as {
        items: GalleryAssetSummary[];
        nextCursor: string | null;
      };
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      const missing = new Set(await resolveGalleryCatalogIds(page.items.map((item) => item.catalogId)));
      setResolved((current) => {
        const next = new Set(current);
        for (const item of page.items) {
          if (!missing.has(item.catalogId)) next.add(item.catalogId);
        }
        return next;
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const choose = async (catalogId: string) => {
    setArmingId(catalogId);
    setError(null);
    try {
      const missing = await resolveGalleryCatalogIds([catalogId]);
      if (missing.length) throw new Error("This gallery asset is no longer available.");
      setResolved((current) => new Set(current).add(catalogId));
      if (state?.placing !== catalogId) controller.togglePlacement(catalogId as CatalogId);
      onRemember(catalogId as CatalogId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setArmingId(null);
    }
  };

  const beginDrag = (event: DragEvent, catalogId: string) => {
    // Pages are resolved as they arrive, so registration is complete before a
    // native drag can begin. An unavailable tile never emits a catalog payload.
    if (!resolved.has(catalogId)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(CATALOG_DRAG_TYPE, catalogId);
    event.dataTransfer.setData("text/plain", catalogId);
    onRemember(catalogId as CatalogId);
  };

  return (
    <div className="space-y-3" data-testid="gallery-asset-panel">
      <p className="text-[9px] leading-relaxed text-white/45">
        Gallery models render in the browser and browser-recorded renders, not in CARLA.
      </p>
      <button
        className="h-8 w-full cursor-not-allowed rounded-md border border-white/10 bg-white/[0.03] px-2.5 text-left text-[9px] text-white/35"
        data-testid="gallery-meshy-disabled"
        disabled
        title="Meshy generation is unavailable in local mode."
        type="button"
      >
        Generate 3D model · unavailable in local mode
      </button>
      <input
        aria-label="Search asset gallery"
        className="h-8 w-full rounded-md border border-white/15 bg-black/25 px-2.5 text-[11px] text-white outline-none placeholder:text-white/35 focus:border-white/30"
        placeholder="Search asset gallery…"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <div aria-label="Gallery ownership" className="flex gap-1" role="group">
        {([false, true] as const).map((owned) => (
          <button
            aria-pressed={mine === owned}
            className={`rounded-full border px-2.5 py-1 text-[9px] ${
              mine === owned
                ? "border-[#d56d27] bg-[#5a3521] text-[#ffd2b2]"
                : "border-white/10 bg-white/[0.04] text-white/55"
            }`}
            key={String(owned)}
            type="button"
            onClick={() => setMine(owned)}
          >
            {owned ? "Mine" : "All"}
          </button>
        ))}
      </div>

      {visibleItems.length ? (
        <div className="grid grid-cols-2 gap-2">
          {visibleItems.map((asset) => {
            const available = resolved.has(asset.catalogId);
            const active = state?.placing === asset.catalogId;
            return (
              <div
                className={`group relative overflow-hidden rounded-md border bg-white/[0.04] ${
                  active ? "border-[#f08a43] bg-[#4a3020]" : "border-white/10"
                }`}
                key={asset.catalogId}
                title={asset.description ?? asset.title}
              >
                <div
                  aria-disabled={!available}
                  aria-label={`Place ${asset.title}`}
                  className={`cursor-grab outline-none ${available ? "" : "cursor-wait opacity-60"}`}
                  draggable={available}
                  role="button"
                  tabIndex={0}
                  onClick={() => void choose(asset.catalogId)}
                  onDragStart={(event) => beginDrag(event, asset.catalogId)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void choose(asset.catalogId);
                    }
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- short-lived presigned S3 thumbnail; see AssetGalleryClient */}
                  <img
                    alt=""
                    className="aspect-square w-full bg-black/20 object-contain"
                    draggable={false}
                    loading="lazy"
                    src={asset.thumbnailUrl}
                  />
                  <div className="min-w-0 px-2 py-1.5">
                    <strong className="block truncate text-[10px] font-semibold text-white/85">
                      {asset.title}
                    </strong>
                    <span className="block truncate text-[8px] text-white/40">
                      v{asset.version} · {asset.dims.l.toFixed(1)} × {asset.dims.w.toFixed(1)} m
                    </span>
                    <div className="mt-1.5">
                      <CarlaCompatibilityPill compatibility={GALLERY_COMPATIBILITY} size="sm" />
                    </div>
                  </div>
                </div>
                <button
                  aria-label={`${favorites.has(asset.catalogId) ? "Remove" : "Add"} ${asset.title} ${favorites.has(asset.catalogId) ? "from" : "to"} favorites`}
                  aria-pressed={favorites.has(asset.catalogId)}
                  className={`absolute right-1 top-1 grid size-6 place-items-center rounded bg-black/55 text-sm ${
                    favorites.has(asset.catalogId) ? "text-amber-300" : "text-white/55"
                  }`}
                  type="button"
                  onClick={() => onFavorite(asset.catalogId)}
                >
                  {favorites.has(asset.catalogId) ? "★" : "☆"}
                </button>
                {armingId === asset.catalogId ? (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-[#f08a43]" />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : !loading ? (
        <div className="py-16 text-center text-[10px] text-white/45">
          No gallery assets match this view.
        </div>
      ) : null}

      {error ? <p className="text-[9px] leading-relaxed text-red-300">{error}</p> : null}
      {nextCursor ? (
        <button
          className="w-full rounded-md border border-white/10 bg-white/[0.05] py-2 text-[10px] text-white/65 disabled:opacity-50"
          disabled={loading}
          type="button"
          onClick={() => void loadMore()}
        >
          {loading ? "Loading…" : "Load 24 more"}
        </button>
      ) : loading ? (
        <p className="py-2 text-center text-[9px] text-white/40">Loading gallery…</p>
      ) : null}
    </div>
  );
}
