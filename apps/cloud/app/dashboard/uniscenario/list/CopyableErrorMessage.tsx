"use client";

import { useCallback, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/app/lib/utils";

// `navigator.clipboard` is undefined in non-secure contexts (plain HTTP) and some restricted
// webviews; fall back to the legacy textarea+execCommand path so the copy button still works instead
// of throwing a TypeError.
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

type Variant = "box" | "inline";

const containerClassByVariant: Record<Variant, string> = {
  box: "flex items-start justify-between gap-2 border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive",
  inline: "flex items-start gap-1.5 text-xs text-destructive",
};

const buttonClassByVariant: Record<Variant, string> = {
  box: "inline-flex shrink-0 items-center gap-1 p-1 text-meta text-destructive/80 transition-colors hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  inline:
    "inline-flex shrink-0 items-center justify-center p-0.5 text-destructive/70 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
};

/**
 * An error the user can get out of the browser.
 *
 * Ported from v1 minus its three rose variants, which existed for surfaces v2 does not have. Errors
 * here carry ids and digests that matter in a bug report, so a copy affordance is not a nicety.
 */
export function CopyableErrorMessage({
  message,
  variant = "box",
  className,
  copyText,
}: {
  message: string;
  variant?: Variant;
  className?: string;
  copyText?: string;
}) {
  const { copied, copy } = useCopyToClipboard();

  function handleCopy(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    event.preventDefault();
    copy(copyText ?? message);
  }

  return (
    <div className={cn(containerClassByVariant[variant], className)} role="alert">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{message}</span>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Error copied to clipboard" : "Copy error to clipboard"}
        title={copied ? "Copied" : "Copy error to clipboard"}
        className={buttonClassByVariant[variant]}
      >
        {copied ? (
          <Check className="size-3" aria-hidden="true" />
        ) : (
          <Copy className="size-3" aria-hidden="true" />
        )}
        {variant === "box" ? <span>{copied ? "Copied" : "Copy"}</span> : null}
      </button>
    </div>
  );
}
