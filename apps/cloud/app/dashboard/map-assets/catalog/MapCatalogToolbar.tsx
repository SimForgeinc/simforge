"use client";

import { Search, LayoutGrid, Map, X, ArrowUpDown } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import { Button } from "@/app/components/ui/button";
import { Toolbar, ToolbarGroup } from "@/app/components/ui/toolbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import type { CatalogView, CatalogSort } from "./catalog-filters";
import { cn } from "@/app/lib/utils";

const SORT_LABELS: Record<CatalogSort, string> = {
  date: "Date Added",
  name: "Name",
  mileage: "Mileage",
};

interface MapCatalogToolbarProps {
  query: string;
  onQueryChange: (q: string) => void;
  sort: CatalogSort;
  onSortChange: (s: CatalogSort) => void;
  view: CatalogView;
  onViewChange: (v: CatalogView) => void;
  resultCount: number;
}

export function MapCatalogToolbar({
  query,
  onQueryChange,
  sort,
  onSortChange,
  view,
  onViewChange,
  resultCount,
}: MapCatalogToolbarProps) {
  return (
    <Toolbar>
      {/* Search */}
      <div className="relative flex-1 max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          placeholder="Search maps by name, city, tag..."
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="h-9 pl-9 text-sm"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* Result count */}
      <span className="text-xs text-muted-foreground shrink-0">
        {resultCount} {resultCount === 1 ? "map" : "maps"}
      </span>

      <ToolbarGroup className="ml-auto">
        {/* Sort */}
        <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs">
            <ArrowUpDown className="size-3.5" />
            {SORT_LABELS[sort]}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onSortChange("date")}>Date Added</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSortChange("name")}>Name</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSortChange("mileage")}>Mileage</DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>

      {/* View toggle */}
        <div className="flex items-center rounded-md border border-border bg-muted/30 p-0.5">
        <button
          type="button"
          onClick={() => onViewChange("grid")}
          className={cn(
            "flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors",
            view === "grid"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          title="Grid view"
        >
          <LayoutGrid className="size-3.5" />
          Grid
        </button>
        <button
          type="button"
          onClick={() => onViewChange("map")}
          className={cn(
            "flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition-colors",
            view === "map"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
          title="Map view"
        >
          <Map className="size-3.5" />
          Map
        </button>
        </div>
      </ToolbarGroup>
    </Toolbar>
  );
}
