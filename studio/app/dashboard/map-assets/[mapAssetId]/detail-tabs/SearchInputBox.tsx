"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { getMapSearchSuggestions } from "@/app/lib/maps/search/map-search";

interface SearchInputBoxProps {
  draftQuery: string;
  onDraftQueryChange: (value: string) => void;
  onSubmitSearch: (nextQuery?: string) => void;
  autoFocus?: boolean;
}

export function SearchInputBox({
  draftQuery,
  onDraftQueryChange,
  onSubmitSearch,
  autoFocus = false,
}: SearchInputBoxProps) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightedSuggestionIndex, setHighlightedSuggestionIndex] = useState(-1);
  const suggestions = useMemo(() => getMapSearchSuggestions(draftQuery), [draftQuery]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHighlightedSuggestionIndex(-1);
  }, [draftQuery, suggestions.length]);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  function applySuggestion(applyValue: string) {
    onDraftQueryChange(applyValue);
    onSubmitSearch(applyValue);
    setShowSuggestions(false);
    setHighlightedSuggestionIndex(-1);
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="text"
        placeholder="Search for scenario locations on this map…"
        value={draftQuery}
        onChange={(event) => {
          onDraftQueryChange(event.target.value);
          setShowSuggestions(true);
        }}
        onFocus={() => setShowSuggestions(true)}
        onBlur={() => {
          window.setTimeout(() => setShowSuggestions(false), 0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            if (suggestions.length === 0) return;
            event.preventDefault();
            setShowSuggestions(true);
            setHighlightedSuggestionIndex((current) => (current + 1) % suggestions.length);
            return;
          }

          if (event.key === "ArrowUp") {
            if (suggestions.length === 0) return;
            event.preventDefault();
            setShowSuggestions(true);
            setHighlightedSuggestionIndex((current) =>
              current <= 0 ? suggestions.length - 1 : current - 1,
            );
            return;
          }

          if (event.key === "Escape") {
            setShowSuggestions(false);
            setHighlightedSuggestionIndex(-1);
            return;
          }

          if (event.key === "Enter") {
            if (showSuggestions && highlightedSuggestionIndex >= 0 && highlightedSuggestionIndex < suggestions.length) {
              event.preventDefault();
              applySuggestion(suggestions[highlightedSuggestionIndex]!.applyValue);
              return;
            }
            setShowSuggestions(false);
            setHighlightedSuggestionIndex(-1);
            onSubmitSearch();
          }
        }}
        className="h-10 rounded-md border-border bg-muted/30 pl-9 pr-9 text-sm"
        aria-label="Search this map"
        aria-autocomplete="list"
        aria-expanded={showSuggestions && suggestions.length > 0}
        aria-controls="map-search-suggestions"
        aria-activedescendant={
          showSuggestions && highlightedSuggestionIndex >= 0
            ? `map-search-suggestion-${highlightedSuggestionIndex}`
            : undefined
        }
      />
      {draftQuery ? (
        <button
          type="button"
          onClick={() => {
            onDraftQueryChange("");
            onSubmitSearch("");
          }}
          className="absolute right-3 top-1/2 z-10 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="size-3.5" />
        </button>
      ) : null}
      {showSuggestions && suggestions.length > 0 ? (
        <div
          id="map-search-suggestions"
          className="absolute left-0 right-0 top-full z-20 mt-1 rounded-md border border-border bg-popover p-1 shadow-md"
          role="listbox"
        >
          {suggestions.map((suggestion, index) => (
            <button
              key={suggestion.id}
              id={`map-search-suggestion-${index}`}
              type="button"
              role="option"
              aria-selected={index === highlightedSuggestionIndex}
              className={cn(
                "flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary/40",
                index === highlightedSuggestionIndex && "bg-secondary/40",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onMouseEnter={() => {
                setHighlightedSuggestionIndex(index);
              }}
              onClick={() => {
                applySuggestion(suggestion.applyValue);
              }}
            >
              {suggestion.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
