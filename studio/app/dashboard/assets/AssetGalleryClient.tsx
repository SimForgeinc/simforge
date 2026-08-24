"use client";

import { Boxes, Loader2, SearchX } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/app/components/ui/button";
import { EmptyState } from "@/app/components/ui/empty-state";
import {
  type GalleryActorClass,
  type GalleryAssetSummary,
} from "@/app/lib/asset-gallery/contracts";
import { AssetDetailDrawer } from "./AssetDetailDrawer";
import { AssetGalleryGrid, AssetGalleryGridSkeleton } from "./AssetGalleryGrid";
import { AssetGalleryHeader, type GallerySection } from "./AssetGalleryHeader";
import { AssetGalleryToolbar } from "./AssetGalleryToolbar";
import { AssetUploadDialog, type AssetUploadKind } from "./AssetUploadDialog";
import { MapList } from "./MapList";
import {
  galleryVisibleAssets,
  type GalleryCarlaFilter,
  type GallerySort,
} from "./gallery-filters";

type GalleryPage = { items: GalleryAssetSummary[]; nextCursor: string | null };

const PAGE_SIZE = 24;
/** Long enough that a typed word is one request, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

export function AssetGalleryClient({ initialPage }: { initialPage: GalleryPage }) {
  const [items, setItems] = useState(initialPage.items);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [actorClass, setActorClass] = useState<GalleryActorClass | "all">("all");
  const [carla, setCarla] = useState<GalleryCarlaFilter>("all");
  // Defaults to the whole library: this page's job is to show what the
  // community made, and a personal shelf is the narrower question.
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState<GallerySort>("newest");
  const [section, setSection] = useState<GallerySection>("models");
  const [selected, setSelected] = useState<GalleryAssetSummary | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadKind, setUploadKind] = useState<AssetUploadKind>("model");
  // Bumped on publish so the Maps section refetches the catalog it just added to.
  const [mapReloadToken, setMapReloadToken] = useState(0);
  const [reloading, setReloading] = useState(false);
  const [appending, setAppending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedQuery = query.trim();
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(trimmedQuery), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [trimmedQuery]);

  /**
   * Re-list whenever a server-answered filter changes.
   *
   * The first run is deliberately skipped: `initialPage` is this exact query
   * already resolved on the server, so fetching it again would blank a grid
   * that is already correct. A ref rather than a key comparison, because
   * returning the controls to their defaults must still re-list — the user may
   * be clearing filters after a delete changed what the default page holds.
   */
  const hydrated = useRef(false);
  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    const abort = new AbortController();
    setReloading(true);
    setError(null);
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (actorClass !== "all") params.set("actorClass", actorClass);
    if (mine) params.set("mine", "1");
    void fetch(`/api/asset-gallery?${params}`, { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("The asset gallery could not be loaded.");
        return (await response.json()) as GalleryPage;
      })
      .then((page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "The asset gallery could not be loaded.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setReloading(false);
      });
    return () => abort.abort();
  }, [debouncedQuery, actorClass, mine]);

  const loadMore = async () => {
    if (!nextCursor || appending) return;
    setAppending(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), cursor: nextCursor });
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (actorClass !== "all") params.set("actorClass", actorClass);
      if (mine) params.set("mine", "1");
      const response = await fetch(`/api/asset-gallery?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("The asset gallery could not be loaded.");
      const page = (await response.json()) as GalleryPage;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The asset gallery could not be loaded.");
    } finally {
      setAppending(false);
    }
  };

  const visibleItems = useMemo(
    () => galleryVisibleAssets(items, carla, sort),
    [items, carla, sort],
  );

  const filtered = trimmedQuery !== "" || actorClass !== "all" || carla !== "all" || mine;

  const clearFilters = () => {
    setQuery("");
    setActorClass("all");
    setCarla("all");
    setMine(false);
  };

  const publish = (asset: GalleryAssetSummary) => {
    setItems((current) => [asset, ...current.filter((item) => item.assetId !== asset.assetId)]);
    setSelected(asset);
  };

  return (
    <div className="min-h-full bg-background text-foreground">
      <AssetGalleryHeader
        section={section}
        onSectionChange={setSection}
        onUpload={() => {
          setUploadKind(section === "maps" ? "map" : "model");
          setUploadOpen(true);
        }}
      />

      {/* Title search, actor class, CARLA compatibility, ownership and sort are
          all model-catalog concepts. The map catalog is small, global and has
          none of them, so the controls go away rather than sitting there inert. */}
      {section === "models" ? (
        <div className="sticky top-0 z-20 border-b border-border bg-background/85 px-5 backdrop-blur-sm sm:px-8">
          <AssetGalleryToolbar
            query={query}
            onQueryChange={setQuery}
            actorClass={actorClass}
            onActorClassChange={setActorClass}
            carla={carla}
            onCarlaChange={setCarla}
            mine={mine}
            onMineChange={setMine}
            sort={sort}
            onSortChange={setSort}
            resultCount={visibleItems.length}
            hasMore={nextCursor !== null}
            searching={reloading}
          />
        </div>
      ) : null}

      <main className="px-5 py-6 sm:px-8">
        <div className="mx-auto max-w-[1500px]">
          {section === "maps" ? (
            <MapList
              reloadToken={mapReloadToken}
              onUpload={() => {
                setUploadKind("map");
                setUploadOpen(true);
              }}
            />
          ) : (
            <>
              {error ? (
                <p
                  role="alert"
                  className="mb-4 rounded-lg border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-200"
                >
                  {error}
                </p>
              ) : null}

              {reloading && visibleItems.length === 0 ? (
                <AssetGalleryGridSkeleton />
              ) : visibleItems.length > 0 ? (
                <AssetGalleryGrid assets={visibleItems} onSelect={setSelected} />
              ) : filtered ? (
                <EmptyState
                  icon={<SearchX className="size-7" />}
                  title="Nothing matches these filters"
                  description="No published asset fits this combination. Widen the search, or clear the filters to see the whole library again."
                  action={
                    <Button type="button" variant="outline" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  }
                  className="rounded-lg border border-dashed border-border"
                />
              ) : (
                <EmptyState
                  icon={<Boxes className="size-7" />}
                  title="The library is empty"
                  description="Nobody has published a model yet. Upload a GLB you already have to add it to the local library."
                  action={
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Button type="button" disabled title="Meshy generation is unavailable in local mode">
                        Generate asset · In development
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setUploadKind("model");
                          setUploadOpen(true);
                        }}
                      >
                        Upload a model
                      </Button>
                    </div>
                  }
                  className="rounded-lg border border-dashed border-border"
                />
              )}

              {nextCursor ? (
                <div className="mt-8 flex justify-center">
                  <Button type="button" variant="outline" disabled={appending} onClick={() => void loadMore()}>
                    {appending ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
                    {appending ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </main>

      <AssetUploadDialog
        open={uploadOpen}
        initialKind={uploadKind}
        onOpenChange={setUploadOpen}
        onUploaded={publish}
        onMapPublished={() => {
          // The catalog now holds a version it did not a moment ago, and the user is
          // looking at the dialog that made it — land them on it when they close.
          setSection("maps");
          setMapReloadToken((token) => token + 1);
        }}
      />
      <AssetDetailDrawer
        asset={selected}
        onClose={() => setSelected(null)}
        onDeleted={(assetId) => setItems((current) => current.filter((item) => item.assetId !== assetId))}
        onRenamed={(renamed) => {
          setItems((current) => current.map((item) => (item.assetId === renamed.assetId ? renamed : item)));
          setSelected(renamed);
        }}
      />
    </div>
  );
}
