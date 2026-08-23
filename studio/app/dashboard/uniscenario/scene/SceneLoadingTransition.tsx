"use client";

import { useMemo } from "react";
import { RotateCcw } from "lucide-react";
import {
  useDashboardLoadingSource,
  type DashboardLoadingSource,
} from "@/app/components/DashboardLoadingCoordinator";
import { Button } from "@/app/components/ui/button";
import type { SceneLoadProgress } from "./map-load-progress";
import { CacheAllMapAssetsButton } from "./CacheAllMapAssetsButton";

export function SceneLoadingTransition({
  visible,
  progress,
  onRetry,
}: {
  visible: boolean;
  progress: SceneLoadProgress;
  onRetry?: (() => void) | null;
}) {
  const failed = progress.phase === "error";
  const source = useMemo<DashboardLoadingSource | null>(() => {
    if (!visible) return null;
    return {
      kind: "scene",
      title: progress.message,
      detail: progress.detail,
      eyebrow: failed ? "Scene interrupted" : "Preparing scene",
      progress: failed ? undefined : (progress.percent ?? null),
      progressLabel: phaseLabel(progress.phase),
      telemetry: progress.download,
      phase: progress.phase,
      severity: failed ? "error" : "loading",
      icon: failed ? <RotateCcw className="size-5" aria-hidden="true" /> : undefined,
      actions: (
        <>
          {failed && onRetry ? (
            <Button
              className="mt-6 h-10 rounded-full bg-[#E8E044] px-5 text-black hover:bg-[#f1ea55]"
              onClick={onRetry}
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              Try again
            </Button>
          ) : null}
          <CacheAllMapAssetsButton />
        </>
      ),
    };
  }, [failed, onRetry, progress, visible]);

  useDashboardLoadingSource(source);
  return null;
}

function phaseLabel(phase: SceneLoadProgress["phase"]): string {
  switch (phase) {
    case "covering": return "Switching map";
    case "resolving": return "Map definition";
    case "assets": return "Scene assets";
    case "stabilizing": return "Final checks";
    case "ready": return "Ready";
    case "error": return "Stopped";
  }
}
