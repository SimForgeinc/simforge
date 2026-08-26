"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, MapPin } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import type { ScenarioSummary } from "@/app/lib/scenarios";
import { TopBarActionsPortal } from "@/app/components/TopBarSlot";
import { Button } from "@/app/components/ui/button";
import { EmptyState } from "@/app/components/ui/empty-state";
import { MapCatalogToolbar } from "./MapCatalogToolbar";
import { MapCardGrid } from "./MapCardGrid";
import { MapCatalogMapView } from "./MapCatalogMapView";
import {
  buildCorpus,
  filterAssets,
  sortAssets,
  type CatalogView,
  type CatalogSort,
} from "./catalog-filters";

interface MapCatalogPageClientProps {
  assets: MapAsset[];
  runs: ScenarioSummary[];
}

function AddMapTopBarAction() {
  return (
    <TopBarActionsPortal>
      <Button asChild size="sm">
        <Link href="/dashboard/map-assets/new">
          <Plus className="size-4" />
          Add map
        </Link>
      </Button>
    </TopBarActionsPortal>
  );
}

export function MapCatalogPageClient({ assets, runs: _runs }: MapCatalogPageClientProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CatalogSort>("date");
  const [view, setView] = useState<CatalogView>("grid");

  const corpora = useMemo(() => assets.map(buildCorpus), [assets]);

  const filtered = useMemo(() => {
    const matched = filterAssets(assets, corpora, query);
    return sortAssets(matched, sort);
  }, [assets, corpora, query, sort]);

  // Empty state
  if (assets.length === 0) {
    return (
      <>
        <AddMapTopBarAction />
        <EmptyState
          icon={<MapPin className="size-7" />}
          title="No maps yet"
          description="Upload your first map to start exploring assets and building simulation scenarios."
          action={<Button asChild><Link href="/dashboard/map-assets/new"><Plus className="mr-1.5 size-4" />Add map</Link></Button>}
          className="h-full"
        />
      </>
    );
  }

  return (
    <>
      <AddMapTopBarAction />
      <div className="flex h-full flex-col">
        <MapCatalogToolbar
          query={query}
          onQueryChange={setQuery}
          sort={sort}
          onSortChange={setSort}
          view={view}
          onViewChange={setView}
          resultCount={filtered.length}
        />

        <div className="flex-1 min-h-0 overflow-hidden">
          {view === "grid" ? (
            <div className="h-full overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <p className="text-sm text-muted-foreground">No maps match your search.</p>
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="mt-2 text-xs text-primary hover:text-primary/80"
                  >
                    Clear search
                  </button>
                </div>
              ) : (
                <MapCardGrid assets={filtered} />
              )}
            </div>
          ) : (
            <MapCatalogMapView assets={filtered} />
          )}
        </div>
      </div>
    </>
  );
}
