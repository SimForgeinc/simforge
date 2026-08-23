"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, MapPin, Search, X } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import type { UniScenarioMapOption } from "./document-map-groups";

function searchableText(map: UniScenarioMapOption) {
  return [map.label, map.locality, map.mapVersionId].filter(Boolean).join(" ").toLowerCase();
}

/**
 * The map picker for "New Scenario".
 *
 * Ported from v1's `EditorMapPickerDialog`, with three things dropped because v2's map catalog does
 * not have them: the runtime toggle (v2 has exactly one CARLA runtime, so v1's single-option picker
 * was already inert chrome), the "bundle missing" gate (a `map_versions` row only exists once its
 * browser asset set is published, with `closure_sha256` proving the closure), and the deep link into
 * `/dashboard/map-assets`, which is v1's map surface.
 *
 * Thumbnail URLs are stable first-party routes backed by independently versioned UniScenario
 * artifacts, so switching views never has to retain an expiring S3 URL.
 */
export function UniScenarioMapPickerDialog({
  maps,
  currentMapVersionId,
  open,
  onOpenChange,
  onSelectMap,
}: {
  maps: ReadonlyArray<UniScenarioMapOption>;
  currentMapVersionId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectMap: (map: UniScenarioMapOption) => void;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();

  // Close on Escape, lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onOpenChange]);

  const sortedMaps = useMemo(
    () =>
      [...maps].sort((a, b) => {
        if (a.mapVersionId === currentMapVersionId) return -1;
        if (b.mapVersionId === currentMapVersionId) return 1;
        return a.label.localeCompare(b.label);
      }),
    [currentMapVersionId, maps],
  );
  const filteredMaps = useMemo(
    () =>
      normalizedQuery
        ? sortedMaps.filter((map) => searchableText(map).includes(normalizedQuery))
        : sortedMaps,
    [normalizedQuery, sortedMaps],
  );

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/55 backdrop-blur-md"
        aria-label="Close map picker"
        onClick={() => onOpenChange(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Select map"
        className="relative flex h-[80vh] w-[80vw] flex-col overflow-hidden border border-border bg-background shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-6 py-4">
          <div className="min-w-0">
            <h2 className="font-heavy text-base font-bold uppercase tracking-meta-narrow text-foreground">
              Select Map
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {filteredMaps.length} of {maps.length} maps
            </p>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative w-[min(360px,40vw)]">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                autoFocus
                aria-label="Search maps"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search maps"
                className="h-9 pl-9"
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              aria-label="Close map picker"
            >
              <X className="size-5" aria-hidden="true" />
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {filteredMaps.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {maps.length === 0 ? "No maps available." : "No maps match your search."}
            </div>
          ) : (
            <div className="mx-auto grid max-w-7xl gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredMaps.map((map) => {
                const isCurrent = map.mapVersionId === currentMapVersionId;
                return (
                  <div
                    key={map.mapVersionId}
                    className={cn(
                      "group overflow-hidden border bg-card transition-colors duration-200",
                      isCurrent
                        ? "border-primary ring-1 ring-primary/40"
                        : "border-border hover:border-primary/50",
                    )}
                  >
                    <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted/30">
                      {map.thumbnailUrl ? (
                        <Image
                          src={map.thumbnailUrl}
                          alt={map.label}
                          fill
                          sizes="(max-width: 768px) 100vw, (max-width: 1280px) 33vw, 25vw"
                          className="object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none"
                          // The route redirects to immutable media; image optimization adds no value.
                          unoptimized
                        />
                      ) : (
                        <div className="h-full w-full bg-gradient-to-br from-muted via-muted/60 to-muted/30" />
                      )}
                      <div
                        aria-hidden="true"
                        className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent"
                      />
                      {isCurrent ? (
                        <div className="absolute right-3 top-3 flex items-center gap-1.5 bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                          <Check className="size-3.5" aria-hidden="true" />
                          Current
                        </div>
                      ) : null}
                      <div className="absolute inset-x-0 bottom-0 p-4">
                        {map.locality ? (
                          <div className="mb-1 flex items-center gap-1.5">
                            <MapPin className="size-3 shrink-0 text-white/70" aria-hidden="true" />
                            <p className="truncate text-xs text-white/70">{map.locality}</p>
                          </div>
                        ) : null}
                        <p className="line-clamp-2 text-base font-bold leading-tight text-white">
                          {map.label}
                        </p>
                      </div>
                    </div>
                    <div className="px-4 py-3">
                      <Button
                        type="button"
                        className="w-full"
                        variant={isCurrent ? "outline" : "default"}
                        onClick={() => {
                          onSelectMap(map);
                          onOpenChange(false);
                        }}
                      >
                        {isCurrent ? "Use This Map" : "Select Map"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
