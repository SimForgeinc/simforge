"use client";

import { ChevronRight, Check, Copy } from "lucide-react";
import { getMapAssetDescriptorTag } from "@simcloud/shared";
import { cn } from "@/app/lib/utils";

/** Props for the ScenarioTagsSection component. */
type ScenarioTagsSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  tags: string[];
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
};

/** Display scenario descriptor tags with definitions in a collapsible list. */
export function ScenarioTagsSection({
  open,
  onToggleOpen,
  tags,
  copiedKey,
  onCopy,
}: ScenarioTagsSectionProps) {
  return (
    <section>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={open}
        >
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
          />
          Scenario tags ({tags.length})
        </button>
        <button
          type="button"
          onClick={() => onCopy(tags.join(","), "tags")}
          aria-label="Copy tags as CSV"
          title="Copy tags as CSV"
          className="shrink-0 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
        >
          {copiedKey === "tags" ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
        </button>
      </div>
      {open && (
        <ul className="mt-2 space-y-1.5">
          {tags.map((tagId) => {
            const descriptor = getMapAssetDescriptorTag(tagId);
            return (
              <li key={tagId} className="rounded border border-border bg-muted/30 px-2.5 py-2">
                <p className="text-xs font-medium text-foreground">{tagId.replace(/_/g, " ")}</p>
                {descriptor?.shortDefinition && (
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {descriptor.shortDefinition}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
