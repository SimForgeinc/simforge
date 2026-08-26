"use client";

import { useRef, useState, useMemo, useEffect } from "react";
import { ChevronDown, Search, Check } from "lucide-react";
import type { MapAsset } from "@simforge-oss/studio-shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";

interface MapSwitcherDropdownProps {
  currentAsset: MapAsset;
  allAssets: MapAsset[];
  onSwitchMap: (mapAssetId: string) => void;
}

export function MapSwitcherDropdown({ currentAsset, allAssets, onSwitchMap }: MapSwitcherDropdownProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allAssets;
    return allAssets.filter((a) => {
      const place = a.place_context
        ? [a.place_context.city, a.place_context.state, a.place_context.country]
            .filter(Boolean)
            .join(" ")
        : "";
      const corpus = `${a.name} ${place}`.toLowerCase();
      return corpus.includes(q);
    });
  }, [allAssets, query]);

  function switchToMap(mapAssetId: string) {
    onSwitchMap(mapAssetId);
    setOpen(false);
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-10 w-44 items-center gap-1.5 rounded-md border border-border bg-muted/30 px-3 text-sm font-medium transition-colors hover:bg-muted/50 sm:w-[280px]"
        >
          <span className="flex-1 truncate text-left">{currentAsset.name}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground ml-auto" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[280px] p-0" sideOffset={4}>
        {/* Search input */}
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={inputRef}
              type="search"
              placeholder="Search maps..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
              onKeyDown={(e) => {
                // Prevent dropdown from closing on key presses
                e.stopPropagation();
                // Enter selects first result
                if (e.key === "Enter" && filtered.length > 0) {
                  const first = filtered[0]!;
                  if (first.map_asset_id !== currentAsset.map_asset_id) {
                    switchToMap(first.map_asset_id);
                  }
                }
              }}
            />
          </div>
        </div>

        {/* Map list */}
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">No maps found</p>
          ) : (
            filtered.map((asset) => {
              const isCurrent = asset.map_asset_id === currentAsset.map_asset_id;
              const place = asset.place_context
                ? [
                    asset.place_context.city,
                    asset.place_context.state,
                    asset.place_context.country_code?.toUpperCase(),
                  ]
                    .filter(Boolean)
                    .join(", ")
                : null;

              return (
                <button
                  key={asset.map_asset_id}
                  type="button"
                  onClick={() => {
                    if (!isCurrent) switchToMap(asset.map_asset_id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left transition-colors",
                    isCurrent
                      ? "bg-primary/5 text-primary"
                      : "text-foreground hover:bg-muted/50",
                  )}
                >
                  {isCurrent ? (
                    <Check className="size-3.5 shrink-0 text-primary" />
                  ) : (
                    <div className="size-3.5 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-xs truncate", isCurrent && "font-medium")}>
                      {asset.name}
                    </p>
                    {place && (
                      <p className="text-[10px] text-muted-foreground truncate">{place}</p>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
