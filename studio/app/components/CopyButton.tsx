"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function CopyButton({
  text,
  title = "Copy to clipboard",
  label,
}: {
  text: string;
  title?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }

  if (label) {
    return (
      <button
        type="button"
        onClick={copy}
        title={title}
        className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
      >
        {copied ? <Check className="size-3 text-green-400" /> : <Copy className="size-3" />}
        <span>{label}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={title}
      className="inline-flex shrink-0 text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? <Check className="size-3.5 text-green-400" /> : <Copy className="size-3.5" />}
    </button>
  );
}
