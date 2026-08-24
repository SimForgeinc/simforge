"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import { useCopyToClipboard } from "../status/CopyableErrorMessage";

export function CopyDebugInformationButton({
  getDebugInformation,
  className,
}: {
  getDebugInformation: () => string;
  className?: string;
}) {
  const { copied, copy } = useCopyToClipboard(2000);

  return (
    <Button
      aria-label={copied ? "Debug information copied" : "Copy debug information"}
      className={cn(
        "h-8 gap-2 rounded-none border border-border bg-card/90 px-3 shadow-sm backdrop-blur",
        className,
      )}
      onClick={() => copy(getDebugInformation())}
      size="sm"
      title="Copy scenario and editor diagnostics for a support ticket"
      type="button"
      variant="outline"
    >
      {copied ? (
        <Check aria-hidden="true" className="size-4 text-emerald-400" />
      ) : (
        <Copy aria-hidden="true" className="size-4" />
      )}
      <span>{copied ? "Copied debug information" : "Copy debug information"}</span>
    </Button>
  );
}
