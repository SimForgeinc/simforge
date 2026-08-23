"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/app/lib/utils";

/**
 * The page's two either/or switches — Models vs Maps, and All vs Mine.
 *
 * Both were hand-rolled div-and-button pairs with the active class inlined at
 * each callsite, which is how they drifted apart. A radio group would be the
 * textbook control, but each option here re-fetches or re-routes the whole page
 * on activation, and radios fire on arrow-key focus: a keyboard user sweeping
 * the group would trigger every option on the way past. Buttons carrying
 * `aria-pressed` inside a labelled group announce the same state and only act
 * when actually chosen.
 */
export function AssetGallerySegmented<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: Value;
  options: readonly { value: Value; label: string; icon?: LucideIcon }[];
  onChange: (value: Value) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex items-center gap-0.5 rounded-md border border-border bg-muted/30 p-0.5", className)}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon ? <Icon aria-hidden="true" className="size-3.5" /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
