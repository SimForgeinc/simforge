"use client";

import { Check, Copy } from "lucide-react";

/** Props for the UtilityButtons component. */
type UtilityButtonsProps = {
  assetId: string;
  bboxText: string;
  centerText: string;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
};

/** Render copy-to-clipboard buttons for map ID, bounding box, and center coordinates. */
export function UtilityButtons({
  assetId,
  bboxText,
  centerText,
  copiedKey,
  onCopy,
}: UtilityButtonsProps) {
  return (
    <section className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onCopy(assetId, "mapId")}
        className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        {copiedKey === "mapId" ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
        Map ID
      </button>
      <button
        type="button"
        onClick={() => onCopy(bboxText, "bbox")}
        className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        {copiedKey === "bbox" ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
        bbox
      </button>
      <button
        type="button"
        onClick={() => onCopy(centerText, "center")}
        className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        {copiedKey === "center" ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
        center
      </button>
    </section>
  );
}
