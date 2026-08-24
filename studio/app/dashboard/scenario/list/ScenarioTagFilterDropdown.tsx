"use client";

import { Filter } from "lucide-react";
import type { ScenarioTagDto } from "@/app/lib/scenario/contracts";
import { Button } from "@/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import { cn } from "@/app/lib/utils";

export type ScenarioCreatorFilterOption = {
  value: string;
  label: string;
  count: number;
};

export function ScenarioTagFilterDropdown({
  tags,
  creatorOptions,
  selectedTagFilter,
  selectedCreatorFilter,
  onSelectTagFilter,
  onSelectCreatorFilter,
}: {
  tags: ScenarioTagDto[];
  creatorOptions: ScenarioCreatorFilterOption[];
  selectedTagFilter: string | null;
  selectedCreatorFilter: string | null;
  onSelectTagFilter: (tagId: string | null) => void;
  onSelectCreatorFilter: (creator: string | null) => void;
}) {
  const selectedTag = tags.find((tag) => tag.id === selectedTagFilter) ?? null;
  const selectedCreator =
    creatorOptions.find((creator) => creator.value === selectedCreatorFilter) ?? null;
  const hasActiveFilter = Boolean(selectedTag || selectedCreator);
  const showingAll = selectedTagFilter === null && selectedCreatorFilter === null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className={cn(
            "h-8 gap-2 rounded-none border-border/80 px-3 font-[Share_Tech_Mono,IBM_Plex_Mono,monospace] text-[10px] font-bold uppercase tracking-[0.16em]",
            hasActiveFilter
              ? "bg-foreground text-background hover:bg-foreground/90"
              : "bg-background/70 text-foreground/75 hover:bg-muted hover:text-foreground",
          )}
          aria-label="Filter scenarios"
        >
          <Filter className="size-3.5" aria-hidden="true" />
          Filter
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[220px]">
        <DropdownMenuItem
          data-scenario-filter-all
          onSelect={() => {
            onSelectTagFilter(null);
            onSelectCreatorFilter(null);
          }}
          className={cn(
            "font-meta text-micro uppercase tracking-meta",
            showingAll ? "text-primary" : null,
          )}
        >
          <span
            className={cn(
              "size-2 border border-primary/45",
              showingAll ? "bg-primary" : "bg-transparent",
            )}
            aria-hidden="true"
          />
          All scenarios
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-meta text-micro uppercase tracking-meta-wide text-muted-foreground">
          Created by
        </DropdownMenuLabel>
        {creatorOptions.length === 0 ? (
          <DropdownMenuItem disabled>No creators yet</DropdownMenuItem>
        ) : (
          creatorOptions.map((creator) => (
            <DropdownMenuItem
              key={creator.value}
              data-scenario-filter-creator={creator.value}
              onSelect={() => {
                onSelectCreatorFilter(creator.value);
                onSelectTagFilter(null);
              }}
              className={cn(
                "font-meta text-micro uppercase tracking-meta-tight",
                selectedCreatorFilter === creator.value ? "text-primary" : null,
              )}
            >
              <span
                className={cn(
                  "size-2 border border-primary/45",
                  selectedCreatorFilter === creator.value ? "bg-primary" : "bg-transparent",
                )}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{creator.label}</span>
              <span className="text-micro text-muted-foreground">{creator.count}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-meta text-micro uppercase tracking-meta-wide text-muted-foreground">
          Tags
        </DropdownMenuLabel>
        {tags.length === 0 ? (
          <DropdownMenuItem disabled>No tags yet</DropdownMenuItem>
        ) : (
          tags.map((tag) => (
            <DropdownMenuItem
              key={tag.id}
              data-scenario-filter-tag-id={tag.id}
              onSelect={() => {
                onSelectTagFilter(tag.id);
                onSelectCreatorFilter(null);
              }}
              className={cn(
                "font-meta text-micro uppercase tracking-meta",
                selectedTagFilter === tag.id ? "text-primary" : null,
              )}
            >
              {/*
                A tag's colour is operator-chosen data, so it arrives as an inline style rather than
                as a class. The border is a token so an unset colour still reads as a swatch.
              */}
              <span
                className="size-2 border border-border"
                style={tag.color ? { backgroundColor: tag.color } : undefined}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{tag.label}</span>
              <span className="text-micro text-muted-foreground">{tag.documentCount}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
