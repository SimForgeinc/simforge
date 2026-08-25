"use client";

import { Check, Database } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { readRenderingPreference } from "@/app/components/rendering-preference"
import { Button } from "@/app/components/ui/button";
import { listMapOptions } from "@/app/dashboard/scenario/list/api";
import {
  cacheProfileMapPlan,
  createProfileMapPlan,
  type ProfileMapCacheProgress,
} from "@/app/lib/scenario/editor/profile-map-cache";
import {
  cacheReceiptKey,
  hasCacheReceipt,
  writeCacheReceipt,
} from "@/app/lib/maps/frontend/map-asset-cache";

type State = "idle" | "planning" | "downloading" | "complete" | "error";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function CacheAllMapAssetsButton() {
  const [state, setState] = useState<State>("idle");
  const [progress, setProgress] = useState<ProfileMapCacheProgress | null>(null);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);

  useEffect(() => () => operation.current?.abort(), []);

  const start = async () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    const profile = readRenderingPreference() ?? "high";
    setState("planning");
    setError("");
    setProgress(null);
    try {
      const maps = await listMapOptions(controller.signal);
      const plan = await createProfileMapPlan(maps, profile, controller.signal);
      if (controller.signal.aborted) return;
      const receipt = cacheReceiptKey(plan.releaseKey, profile);
      if (plan.remainingAssets === 0 && hasCacheReceipt(receipt)) {
        setState("complete");
        return;
      }
      setState("downloading");
      const result = await cacheProfileMapPlan(plan, controller.signal, setProgress);
      if (result.failedAssets > 0) {
        throw new Error(`${result.failedAssets} assets could not be verified and cached.`);
      }
      writeCacheReceipt(receipt, plan.assets.length, plan.totalBytes);
      setState("complete");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Map caching failed.");
      setState("error");
    }
  };

  const percent = progress?.totalAssets
    ? Math.round((progress.completedAssets / progress.totalAssets) * 100)
    : 0;

  return (
    <div className="mt-7 border-t border-white/10 pt-4" data-testid="cache-all-map-assets">
      <Button
        className="h-auto min-h-10 w-full justify-start rounded-full border border-[#E8E044] bg-[#E8E044] px-4 py-2 text-left text-xs font-semibold text-neutral-950 shadow-[0_0_24px_rgba(232,224,68,0.16)] hover:bg-[#F3EB4F] hover:text-black focus-visible:ring-[#E8E044] focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        disabled={state === "planning" || state === "downloading" || state === "complete"}
        onClick={() => void start()}
        type="button"
        variant="ghost"
      >
        {state === "planning" || state === "downloading" ? (
          <CloudActivityIndicator iconClassName="size-4 text-neutral-950" />
        ) : state === "complete" ? (
          <Check className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <Database className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span>
          {state === "idle"
            ? "Tip: Click here to cache all assets."
            : state === "planning"
              ? "Calculating the complete offline map library…"
              : state === "downloading"
                ? `Caching all map assets · ${percent}%${progress ? ` · ${formatBytes(progress.completedBytes)} / ${formatBytes(progress.totalBytes)}` : ""}`
                : state === "complete"
                  ? "All maps are available offline for this rendering profile."
                  : "Caching stopped. Click to retry."}
        </span>
      </Button>
      {error ? <p className="mt-2 px-3 text-xs leading-5 text-red-300" role="alert">{error}</p> : null}
    </div>
  );
}
