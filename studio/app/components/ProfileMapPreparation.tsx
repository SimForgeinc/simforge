"use client";

import {
  Check,
  Database,
  Download,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/app/components/ui/button";
import type { RenderingPreference } from "@/app/components/rendering-preference"
import { listMapOptions } from "@/app/dashboard/scenario/list/api";
import type { ScenarioMapOption } from "@/app/dashboard/scenario/list/document-map-groups";
import {
  cacheProfileMapPlan,
  createProfileMapPlan,
  type ProfileMapCacheResult,
  type ProfileMapCacheProgress,
  type ProfileMapPlan,
} from "@/app/lib/scenario/editor/profile-map-cache";

type Phase = "planning" | "ready" | "downloading" | "complete" | "error";

type TransferMetrics = {
  bytesPerSecond: number;
  remainingSeconds: number | null;
};

const PROFILE_LABELS: Record<RenderingPreference, string> = {
  "roads-only": "Roads Only",
  "ultra-low-3d": "Low",
  minimal: "Balanced",
  high: "High",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTransferBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function calculateTransferMetrics(
  progress: ProfileMapCacheProgress,
  elapsedMilliseconds: number,
): TransferMetrics {
  if (progress.completedBytes <= 0 || elapsedMilliseconds <= 0) {
    return { bytesPerSecond: 0, remainingSeconds: null };
  }
  const bytesPerSecond = progress.completedBytes / (elapsedMilliseconds / 1000);
  const remainingBytes = Math.max(0, progress.totalBytes - progress.completedBytes);
  return {
    bytesPerSecond,
    remainingSeconds: Math.ceil(remainingBytes / bytesPerSecond),
  };
}

export function formatRemainingTime(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} sec`;
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.ceil(seconds % 60);
    return remainder > 0 ? `${minutes} min ${remainder} sec` : `${minutes} min`;
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

export function ProfileMapPreparation({
  profile,
  redownload = false,
  onContinue,
  onSkip,
}: {
  profile: RenderingPreference;
  redownload?: boolean;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("planning");
  const [plan, setPlan] = useState<ProfileMapPlan | null>(null);
  const [availableMaps, setAvailableMaps] = useState<ScenarioMapOption[]>([]);
  const [selectedMapIds, setSelectedMapIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ProfileMapCacheProgress | null>(
    null,
  );
  const [cacheResult, setCacheResult] = useState<ProfileMapCacheResult | null>(
    null,
  );
  const [error, setError] = useState("");
  const [transferMetrics, setTransferMetrics] = useState<TransferMetrics>({
    bytesPerSecond: 0,
    remainingSeconds: null,
  });
  const operation = useRef<AbortController | null>(null);
  const downloadStartedAt = useRef(0);

  const calculate = (
    downloadAfterPlanning = false,
    requestedSelection?: ReadonlySet<string>,
  ) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setPhase("planning");
    setError("");
    setPlan(null);
    setProgress(null);
    setTransferMetrics({ bytesPerSecond: 0, remainingSeconds: null });
    setCacheResult(null);
    void listMapOptions(controller.signal)
      .then((maps) => {
        const eligibleMaps = maps.filter((map) => Boolean(map.browserManifestUrl));
        const nextSelection = requestedSelection
          ? new Set(
            eligibleMaps
              .filter((map) => requestedSelection.has(map.mapVersionId))
              .map((map) => map.mapVersionId),
          )
          : new Set(eligibleMaps.map((map) => map.mapVersionId));
        setAvailableMaps(eligibleMaps);
        setSelectedMapIds(nextSelection);
        if (nextSelection.size === 0) {
          setPhase("ready");
          return null;
        }
        return createProfileMapPlan(
          eligibleMaps.filter((map) => nextSelection.has(map.mapVersionId)),
          profile,
          controller.signal,
        );
      })
      .then((nextPlan) => {
        if (controller.signal.aborted || !nextPlan) return;
        setPlan(nextPlan);
        if (nextPlan.remainingAssets === 0) {
          setPhase("complete");
        } else if (downloadAfterPlanning) {
          void download(nextPlan, controller);
        } else {
          setPhase("ready");
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "Map preparation could not be calculated.",
        );
        setPhase("error");
      });
  };

  useEffect(() => {
    calculate(redownload);
    return () => operation.current?.abort();
    // Recalculate when the profile or selected bootstrap map changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, redownload]);

  const percent = useMemo(() => {
    if (phase === "complete") return 100;
    if (!progress?.totalAssets) return 0;
    return Math.round((progress.completedAssets / progress.totalAssets) * 100);
  }, [phase, progress]);

  const download = async (
    targetPlan: ProfileMapPlan,
    controller: AbortController,
  ) => {
    setPhase("downloading");
    setError("");
    downloadStartedAt.current = Date.now();
    try {
      await navigator.storage?.persist?.().catch(() => false);
      const result = await cacheProfileMapPlan(
        targetPlan,
        controller.signal,
        (nextProgress) => {
          setProgress(nextProgress);
          setTransferMetrics(
            calculateTransferMetrics(
              nextProgress,
              Date.now() - downloadStartedAt.current,
            ),
          );
        },
      );
      if (!controller.signal.aborted) {
        setCacheResult(result);
        setPhase("complete");
      }
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "The map download stopped unexpectedly.",
      );
      setPhase("error");
    }
  };

  const start = () => {
    if (!plan) return;
    const controller = new AbortController();
    operation.current?.abort();
    operation.current = controller;
    void download(plan, controller);
  };

  const updateMapSelection = (mapVersionId: string, selected: boolean) => {
    const nextSelection = new Set(selectedMapIds);
    if (selected) nextSelection.add(mapVersionId);
    else nextSelection.delete(mapVersionId);
    calculate(false, nextSelection);
  };

  const selectAllMaps = () => {
    calculate(false, new Set(availableMaps.map((map) => map.mapVersionId)));
  };

  const clearMapSelection = () => {
    calculate(false, new Set());
  };

  const profileLabel = PROFILE_LABELS[profile];
  const knownSize = plan ? formatBytes(plan.remainingBytes) : "";
  const sizeQualifier = plan?.unknownSizeAssets ? "at least " : "";
  const failedAssetCount = cacheResult?.failedAssets ?? 0;

  return (
    <div className="relative grid min-h-editor-shell place-items-center overflow-hidden bg-transparent px-5 py-10 sm:p-8">
      <div
        className="relative w-full max-w-xl p-6 text-white sm:p-9"
        data-testid="profile-map-preparation-content"
        data-visual-treatment="inline"
      >
        <div className="flex items-start gap-4">
          <div className="grid size-12 shrink-0 place-items-center text-[#E8E044]">
            {phase === "complete" ? (
              <Check aria-hidden="true" />
            ) : (
              <Database aria-hidden="true" />
            )}
          </div>
          <div>
            <p className="font-meta text-[10px] font-bold uppercase tracking-[0.18em] text-[#E8E044]">
              {profileLabel} profile
            </p>
            <h1
              id="profile-map-preparation-title"
              className="mt-1 text-2xl font-semibold text-white"
            >
              {phase === "complete" ? "Maps are ready" : "Prepare maps"}
            </h1>
            <p
              id="profile-map-preparation-description"
              className="mt-2 text-sm leading-6 text-white/50"
            >
              {phase === "planning"
                ? "Checking the map library…"
                : phase === "downloading"
                  ? "Saving each map’s fast-start assets on this device."
                  : phase === "complete"
                    ? failedAssetCount > 0
                      ? `The selected map is available. ${failedAssetCount} ${failedAssetCount === 1 ? "file will" : "files will"} load on demand.`
                      : "Every active map is available offline for this rendering profile."
                    : selectedMapIds.size === 0
                      ? "Select at least one map to prepare."
                      : `${selectedMapIds.size} selected ${selectedMapIds.size === 1 ? "map" : "maps"} · ${sizeQualifier}${knownSize} remaining`}
            </p>
          </div>
        </div>

        {availableMaps.length > 0 && phase !== "downloading" ? (
          <fieldset className="mt-6 border-y border-white/10 py-4">
            <div className="flex items-center justify-between gap-3">
              <legend className="font-meta text-[9px] font-bold uppercase tracking-[0.16em] text-white/40">
                Maps to cache · {selectedMapIds.size} / {availableMaps.length}
              </legend>
              <div className="flex items-center gap-3 text-[11px]">
                <button
                  className="text-[#E8E044] hover:text-[#f1ea55] disabled:text-white/25"
                  disabled={phase === "planning" || selectedMapIds.size === availableMaps.length}
                  onClick={selectAllMaps}
                  type="button"
                >
                  Select all
                </button>
                <button
                  className="text-white/45 hover:text-white disabled:text-white/20"
                  disabled={phase === "planning" || selectedMapIds.size === 0}
                  onClick={clearMapSelection}
                  type="button"
                >
                  Clear
                </button>
              </div>
            </div>
            <div className="mt-3 grid max-h-40 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
              {availableMaps.map((map) => (
                <label
                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-xs text-white/65 hover:bg-white/5 hover:text-white"
                  key={map.mapVersionId}
                >
                  <input
                    checked={selectedMapIds.has(map.mapVersionId)}
                    className="size-3.5 accent-[#E8E044]"
                    disabled={phase === "planning"}
                    onChange={(event) =>
                      updateMapSelection(map.mapVersionId, event.currentTarget.checked)
                    }
                    type="checkbox"
                  />
                  <span className="truncate">{map.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className="mt-8 h-1 overflow-hidden rounded-full bg-white/10">
          <div
            className={`h-full rounded-full bg-[#E8E044] transition-[width] duration-500 ${phase === "planning" ? "animate-pulse" : ""}`}
            style={{ width: phase === "planning" ? "18%" : `${percent}%` }}
          />
        </div>
        <div className="mt-2 flex justify-between font-mono text-micro uppercase tracking-meta text-white/35">
          <span>
            {phase === "downloading"
              ? `${progress?.completedAssets ?? 0} / ${progress?.totalAssets ?? plan?.assets.length ?? 0} files`
              : phase === "complete"
                ? failedAssetCount > 0
                  ? "Ready online"
                  : "Fast start ready"
                : `${plan?.assets.length ?? 0} startup files`}
          </span>
          <span>{phase === "planning" ? "Scanning" : `${percent}%`}</span>
        </div>

        {phase === "downloading" ? (
          <dl
            className="mt-5 grid grid-cols-3 divide-x divide-white/10 border-y border-white/10 py-4"
            aria-label="Download details"
          >
            <div className="px-3 first:pl-0">
              <dt className="font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-white/35">
                Downloaded
              </dt>
              <dd className="mt-1 whitespace-nowrap font-mono text-xs text-white/75">
                {formatTransferBytes(progress?.completedBytes ?? 0)} /{" "}
                {formatTransferBytes(progress?.totalBytes ?? plan?.remainingBytes ?? 0)}
              </dd>
            </div>
            <div className="px-3">
              <dt className="font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-white/35">
                Speed
              </dt>
              <dd className="mt-1 whitespace-nowrap font-mono text-xs text-white/75">
                {transferMetrics.bytesPerSecond > 0
                  ? `${formatTransferBytes(transferMetrics.bytesPerSecond)}/s`
                  : "Calculating…"}
              </dd>
            </div>
            <div className="px-3 pr-0">
              <dt className="font-meta text-[9px] font-bold uppercase tracking-[0.14em] text-white/35">
                Time remaining
              </dt>
              <dd className="mt-1 whitespace-nowrap font-mono text-xs text-white/75">
                {transferMetrics.remainingSeconds === null
                  ? "Estimating…"
                  : transferMetrics.remainingSeconds === 0
                    ? "Finishing…"
                    : formatRemainingTime(transferMetrics.remainingSeconds)}
              </dd>
            </div>
          </dl>
        ) : null}

        {error ? (
          <p
            className="mt-5 border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {failedAssetCount > 0 ? (
          <p className="mt-5 border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
            Local storage skipped {failedAssetCount}{" "}
            {failedAssetCount === 1 ? "file" : "files"}. The renderer will fetch
            them when needed.
          </p>
        ) : null}

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          {phase === "ready" ? (
            <Button
              className="h-12 flex-1 gap-2 rounded-full bg-[#E8E044] text-black hover:bg-[#f1ea55] focus-visible:ring-[#E8E044]"
              disabled={!plan || selectedMapIds.size === 0}
              onClick={start}
            >
              <Download className="size-4" aria-hidden="true" />
              {plan ? `Prepare ${knownSize}` : "Select maps"}
            </Button>
          ) : phase === "downloading" || phase === "planning" ? (
            <Button
              className="h-12 flex-1 gap-2 rounded-full bg-[#E8E044] text-black"
              disabled
            >
              <LoaderCircle
                className="size-4 animate-spin"
                aria-hidden="true"
              />
              {phase === "planning" ? "Calculating" : "Preparing maps"}
            </Button>
          ) : phase === "complete" ? (
            <Button
              className="h-12 flex-1 rounded-full bg-[#E8E044] text-black hover:bg-[#f1ea55] focus-visible:ring-[#E8E044]"
              onClick={onContinue}
            >
              Open map gallery
            </Button>
          ) : (
            <Button
              className="h-12 flex-1 gap-2 rounded-full bg-[#E8E044] text-black hover:bg-[#f1ea55] focus-visible:ring-[#E8E044]"
              onClick={() => calculate(false, selectedMapIds)}
            >
              <RotateCcw className="size-4" aria-hidden="true" /> Retry
            </Button>
          )}
          {phase !== "complete" ? (
            <Button
              className="h-12 rounded-full border-white/15 bg-transparent text-white hover:bg-transparent hover:text-[#E8E044]"
              variant="outline"
              onClick={onSkip}
            >
              Skip to map gallery
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
