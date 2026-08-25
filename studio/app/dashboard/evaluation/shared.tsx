"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/app/components/ui/badge";
import { cn } from "@/app/lib/utils";

const STATUS_BADGE_CLASS: Record<string, string> = {
  queued: "bg-muted text-muted-foreground border-transparent",
  running: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-transparent",
  complete: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent",
  succeeded: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent",
  promoted: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent",
  registered: "bg-muted text-muted-foreground border-transparent",
  failed: "bg-destructive/15 text-destructive border-transparent",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "capitalize",
        STATUS_BADGE_CLASS[status] ?? "bg-muted text-muted-foreground border-transparent",
      )}
    >
      {status}
    </Badge>
  );
}

/** Driving scores are 0..1 on the wire; render as percent. */
export function formatScore(score: number | null | undefined): string {
  return typeof score === "number" ? `${(score * 100).toFixed(1)}%` : "—";
}

export function formatDelta(delta: number | null | undefined): string {
  if (typeof delta !== "number") return "—";
  const points = delta * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pts`;
}

export type FetchState<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

/** Same-origin JSON GET with the loading/error/ready triple every page shares. */
export function useJsonFetch<T>(url: string | null, refreshKey = 0): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ kind: "loading" });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${response.status}`);
        }
        return (await response.json()) as T;
      })
      .then((data) => setState({ kind: "ready", data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => controller.abort();
  }, [url, refreshKey]);
  return state;
}

export function PanelMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-40 items-center justify-center px-4 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
