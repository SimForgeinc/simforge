"use client";

import { ArrowUpDown, Loader2, Search, X } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Input } from "@/app/components/ui/input";
import { SelectMenu } from "@/app/components/ui/select-menu";
import { Toolbar, ToolbarGroup } from "@/app/components/ui/toolbar";
import type { GalleryActorClass } from "@/app/lib/asset-gallery/contracts";
import { AssetGallerySegmented } from "./AssetGallerySegmented";
import {
  GALLERY_ACTOR_CLASS_OPTIONS,
  GALLERY_CARLA_FILTER_OPTIONS,
  GALLERY_SORT_LABELS,
  GALLERY_SORT_ORDER,
  type GalleryCarlaFilter,
  type GallerySort,
} from "./gallery-filters";

const OWNERSHIP_OPTIONS = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
] as const;

export function AssetGalleryToolbar({
  query,
  onQueryChange,
  actorClass,
  onActorClassChange,
  carla,
  onCarlaChange,
  mine,
  onMineChange,
  sort,
  onSortChange,
  resultCount,
  hasMore,
  searching,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  actorClass: GalleryActorClass | "all";
  onActorClassChange: (actorClass: GalleryActorClass | "all") => void;
  carla: GalleryCarlaFilter;
  onCarlaChange: (carla: GalleryCarlaFilter) => void;
  mine: boolean;
  onMineChange: (mine: boolean) => void;
  sort: GallerySort;
  onSortChange: (sort: GallerySort) => void;
  resultCount: number;
  /** A cursor is still outstanding, so both count and sort cover a prefix. */
  hasMore: boolean;
  searching: boolean;
}) {
  return (
    <Toolbar className="mx-auto max-w-[1500px] border-b-0 bg-transparent px-0 sm:px-0">
      <div className="relative min-w-0 flex-1 sm:max-w-sm">
        {searching ? (
          <Loader2
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-primary"
          />
        ) : (
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
        )}
        <Input
          type="search"
          aria-label="Search assets by title"
          placeholder="Search assets by title…"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          // `type=search` gives assistive tech and the Escape key their usual
          // meaning, but Chrome also draws its own clear glyph — which sat next
          // to ours as a second, unlabelled ×.
          className="h-9 pl-9 pr-9 text-sm [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQueryChange("")}
            className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        ) : null}
      </div>

      <SelectMenu
        value={actorClass}
        onChange={(value) => onActorClassChange(value as GalleryActorClass | "all")}
        options={GALLERY_ACTOR_CLASS_OPTIONS}
        label="Filter by actor class"
        className="h-9 text-xs sm:w-48"
      />
      <SelectMenu
        value={carla}
        onChange={(value) => onCarlaChange(value as GalleryCarlaFilter)}
        options={GALLERY_CARLA_FILTER_OPTIONS}
        label="Filter by CARLA compatibility"
        className="h-9 text-xs sm:w-40"
      />
      <AssetGallerySegmented
        label="Ownership filter"
        value={mine ? "mine" : "all"}
        options={OWNERSHIP_OPTIONS}
        onChange={(value) => onMineChange(value === "mine")}
      />

      <ToolbarGroup className="ml-auto">
        <p className="shrink-0 text-xs text-muted-foreground">
          <span className="tabular-nums text-foreground">{resultCount}</span>{" "}
          {resultCount === 1 ? "asset" : "assets"}
          {hasMore ? " loaded" : ""}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 text-xs"
              title={
                hasMore
                  ? "Sorts the assets loaded so far. Load more to sort across the rest of the library."
                  : undefined
              }
            >
              <ArrowUpDown aria-hidden="true" className="size-3.5" />
              Sort: {GALLERY_SORT_LABELS[sort]}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={sort} onValueChange={(value) => onSortChange(value as GallerySort)}>
              {GALLERY_SORT_ORDER.map((option) => (
                <DropdownMenuRadioItem key={option} value={option}>
                  {GALLERY_SORT_LABELS[option]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ToolbarGroup>
    </Toolbar>
  );
}
