"use client";

import { useCallback, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/app/lib/utils";

// Kept local to the v2 editor so error presentation has one owner.
// (manifest item 169). The only change is `cn` resolving to `@/app/lib/utils`
// rather than v1's local `helpers`, and the rose variants dropping their inert
// radii.

// `navigator.clipboard` is undefined in non-secure contexts (plain HTTP) and
// some restricted webviews; fall back to the legacy textarea+execCommand path
// so the copy button still works instead of throwing a TypeError.
function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  return legacyCopy(text);
}

export function useCopyToClipboard(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback(
    (text: string) => {
      void writeToClipboard(text).then((ok) => {
        if (!ok) return;
        setCopied(true);
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = setTimeout(() => setCopied(false), resetMs);
      });
    },
    [resetMs],
  );

  return { copied, copy };
}

// The five v1 variant names are kept so a ported call site does not also have
// to change its props. The two `*Rose` ones were hand-mixed rose scales; they
// now resolve to the same `destructive` token as `box`/`inline`, differing only
// in the padding scale they were written for.
type Variant = "box" | "boxRose" | "inline" | "inlineRose" | "inlineMuted";

type CopyableErrorMessageProps = {
  message: string;
  variant?: Variant;
  className?: string;
  copyText?: string;
};

const containerClassByVariant: Record<Variant, string> = {
  box: "flex items-start justify-between gap-2 border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive",
  boxRose:
    "flex items-start justify-between gap-2 border border-destructive/30 bg-destructive/10 px-6 py-4 text-sm text-destructive",
  inline: "flex items-start gap-1.5 text-xs text-destructive",
  inlineRose: "flex items-start gap-1.5 text-sm text-destructive",
  inlineMuted: "flex items-start gap-1.5 text-xs text-muted-foreground",
};

const buttonClassByVariant: Record<Variant, string> = {
  box: "editor-motion inline-flex shrink-0 items-center gap-1 p-1 text-meta text-destructive/80 hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  boxRose:
    "editor-motion inline-flex shrink-0 items-center gap-1 p-1 text-meta text-destructive/80 hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  inlineRose:
    "editor-motion inline-flex shrink-0 items-center justify-center p-0.5 text-destructive/70 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  inline:
    "editor-motion inline-flex shrink-0 items-center justify-center p-0.5 text-destructive/70 hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
  inlineMuted:
    "editor-motion inline-flex shrink-0 items-center justify-center p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
};

export function CopyableErrorMessage({
  message,
  variant = "box",
  className,
  copyText,
}: CopyableErrorMessageProps) {
  const { copied, copy } = useCopyToClipboard();

  function handleCopy(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    copy(copyText ?? message);
  }

  return (
    <div className={cn(containerClassByVariant[variant], className)}>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {message}
      </span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={
          copied ? "Error copied to clipboard" : "Copy error to clipboard"
        }
        title={copied ? "Copied" : "Copy error to clipboard"}
        className={buttonClassByVariant[variant]}
      >
        {copied ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
        {variant === "box" || variant === "boxRose" ? (
          <span>{copied ? "Copied" : "Copy"}</span>
        ) : null}
      </button>
    </div>
  );
}
