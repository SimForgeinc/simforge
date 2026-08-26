"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { MAP_ASSET_DESCRIPTOR_TAG_IDS, getMapAssetDescriptorTag } from "@simforge-oss/studio-shared";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { displayTag } from "@/app/lib/maps/frontend/add-map-utils";

interface ScenarioTagsPanelProps {
  tags: string[];
  autoTagSet: Set<string>;
  autoTagsLoading: boolean;
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
  onBulkAddCsv: (tagIds: string[]) => void;
}

/** Scenario tags section: tag chips, tag dropdown with search, CSV bulk-add.
 *  Overture-derived enrichment tags are merged in asynchronously after submit
 *  — this panel no longer shows an in-form enrichment preview. */
export function ScenarioTagsPanel({
  tags,
  autoTagSet,
  autoTagsLoading,
  onAddTag,
  onRemoveTag,
  onBulkAddCsv,
}: ScenarioTagsPanelProps) {
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const [csvOpen, setCsvOpen] = useState(false);
  const [csvInput, setCsvInput] = useState("");
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const tagDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!tagDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setTagDropdownOpen(false);
        setTagSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [tagDropdownOpen]);

  function applyCSV() {
    const ids = csvInput
      .split(/[\n,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    const valid = ids.filter((id) => MAP_ASSET_DESCRIPTOR_TAG_IDS.includes(id));
    const invalid = ids.filter((id) => !MAP_ASSET_DESCRIPTOR_TAG_IDS.includes(id));
    if (valid.length > 0) onBulkAddCsv(valid);
    setCsvErrors(invalid);
    if (invalid.length === 0) setCsvInput("");
  }

  const filteredDropdownTags = MAP_ASSET_DESCRIPTOR_TAG_IDS.filter((id) => {
    if (tags.includes(id)) return false;
    const q = tagSearch.toLowerCase();
    return id.toLowerCase().includes(q) || displayTag(id).toLowerCase().includes(q);
  });

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <h2 className="text-sm font-semibold text-foreground">Scenario tags</h2>
        <span
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums",
            tags.length > 0
              ? "bg-yellow-950/60 text-yellow-300"
              : "bg-muted/60 text-muted-foreground",
          )}
        >
          {tags.length} tags
        </span>
        {autoTagsLoading && (
          <span className="text-xs text-muted-foreground">deriving...</span>
        )}
      </div>

      {/* Tag chips */}
      {tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {tags.map((tagId) => {
            const descriptor = getMapAssetDescriptorTag(tagId);
            const isAuto = autoTagSet.has(tagId);
            return (
              <span
                key={tagId}
                title={descriptor?.shortDefinition}
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs",
                  isAuto
                    ? "border-blue-700/60 bg-blue-950/40 text-blue-300"
                    : "border-yellow-700/60 bg-yellow-950/40 text-yellow-300",
                )}
              >
                {isAuto && (
                  <span className="rounded bg-blue-800/50 px-1 py-px text-[9px] font-semibold uppercase leading-none text-blue-300">
                    auto
                  </span>
                )}
                {displayTag(tagId)}
                <button
                  type="button"
                  onClick={() => onRemoveTag(tagId)}
                  className={cn(
                    "ml-0.5 transition-colors",
                    isAuto
                      ? "text-blue-400/70 hover:text-blue-200"
                      : "text-yellow-400/70 hover:text-yellow-200",
                  )}
                  aria-label={`Remove ${tagId}`}
                >
                  <X className="size-2.5" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Add tag button + dropdown */}
      <div className="relative mb-3" ref={tagDropdownRef}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => { setTagDropdownOpen((o) => !o); setTagSearch(""); }}
        >
          + Add tag
        </Button>
        {tagDropdownOpen && (
          <div className="absolute left-0 top-8 z-20 w-80 rounded-md border border-border bg-background shadow-lg">
            <div className="p-2">
              <Input
                value={tagSearch}
                onChange={(e) => setTagSearch(e.target.value)}
                placeholder="Search tags..."
                className="h-7 text-xs"
                autoFocus
              />
            </div>
            <ul className="max-h-48 overflow-y-auto">
              {filteredDropdownTags.length === 0 && (
                <li className="px-3 py-2 text-xs text-muted-foreground">No matching tags</li>
              )}
              {filteredDropdownTags.map((tagId) => {
                const descriptor = getMapAssetDescriptorTag(tagId);
                return (
                  <li key={tagId}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/50"
                      onClick={() => {
                        onAddTag(tagId);
                        setTagDropdownOpen(false);
                        setTagSearch("");
                      }}
                    >
                      <span className="shrink-0 font-mono font-medium text-foreground">{displayTag(tagId)}</span>
                      {descriptor?.shortDefinition && (
                        <span className="text-muted-foreground">{descriptor.shortDefinition}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* CSV paste — secondary escape hatch */}
      <div>
        <button
          type="button"
          onClick={() => setCsvOpen((o) => !o)}
          className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown
            className={cn("size-3 shrink-0 transition-transform", !csvOpen && "-rotate-90")}
          />
          Bulk-add via CSV paste
        </button>
        {csvOpen && (
          <div className="mt-2 max-w-lg space-y-1.5">
            <textarea
              value={csvInput}
              onChange={(e) => { setCsvInput(e.target.value); setCsvErrors([]); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); applyCSV(); }
              }}
              placeholder={"SCHOOL_ZONE_BOUNDARY,\nINTERSECTION_SIGNALIZED"}
              spellCheck={false}
              rows={3}
              className="w-full resize-none rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            {csvErrors.length > 0 && (
              <p className="text-xs text-destructive">
                Unrecognised (ignored):{" "}
                <span className="font-mono">{csvErrors.join(", ")}</span>
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={!csvInput.trim()}
              onClick={applyCSV}
            >
              Apply CSV
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
