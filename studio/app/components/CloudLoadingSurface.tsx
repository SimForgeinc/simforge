"use client";

import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { SkyCloudBackdrop } from "@/app/components/SkyCloudBackdrop";
import { cn } from "@/app/lib/utils";

export type CloudLoadingTelemetry = {
  transferred: string;
  total?: string | null;
  speed?: string | null;
  eta?: string | null;
  stalled?: boolean;
  stalledFor?: string | null;
};

export type CloudLoadingSurfaceProps = {
  scope?: "screen" | "pane" | "embedded";
  eyebrow?: string;
  title: string;
  detail?: string | null;
  progress?: number | null;
  progressLabel?: string;
  progressValueLabel?: string;
  telemetry?: CloudLoadingTelemetry | null;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
  backdropClassName?: string;
  contentWrapClassName?: string;
  contentClassName?: string;
  testId?: string;
  contentTestId?: string;
  telemetryTestId?: string;
  role?: "status" | "alert";
  ariaBusy?: boolean;
  ariaHidden?: boolean;
  dataLoadKind?: string;
  dataLoadPhase?: string;
  dataTransitionState?: "covering" | "revealing";
};

/**
 \* The single loading language for SimForge workspaces.
 *
 * Screen and pane loaders share the same cloud field and intentionally keep
 * their content flat: loading is a transient layer, not another card in the
 * product hierarchy. `embedded` is used by lifecycle wrappers that already
 * own positioning and portal behavior, such as the scene reveal transition.
 */
export function CloudLoadingSurface({
  scope = "pane",
  eyebrow = "SimForge",
  title,
  detail,
  progress,
  progressLabel = "Loading",
  progressValueLabel,
  telemetry,
  icon,
  children,
  className,
  backdropClassName,
  contentWrapClassName,
  contentClassName,
  testId = "cloud-loading-surface",
  contentTestId = "cloud-loading-content",
  telemetryTestId = "cloud-loading-telemetry",
  role = "status",
  ariaBusy = role !== "alert",
  ariaHidden = false,
  dataLoadKind,
  dataLoadPhase,
  dataTransitionState,
}: CloudLoadingSurfaceProps) {
  const normalizedProgress = normalizeProgress(progress);
  const hasProgress = progress !== undefined;

  return (
    <div
      aria-busy={ariaBusy}
      aria-hidden={ariaHidden || undefined}
      aria-live={role === "alert" ? "assertive" : "polite"}
      className={cn(
        "isolate overflow-hidden bg-black text-white",
        scope === "screen" && "fixed inset-0 z-[240] min-h-dvh",
        scope === "pane" && "relative h-full min-h-48 w-full",
        scope === "embedded" && "absolute inset-0",
        className,
      )}
      data-cloud-loading-scope={scope}
      data-load-kind={dataLoadKind}
      data-load-phase={dataLoadPhase}
      data-transition-state={dataTransitionState}
      data-testid={testId}
      role={role}
    >
      <SkyCloudBackdrop
        animated={scope !== "pane"}
        className={backdropClassName}
      />
      <div
        className={cn(
          "relative z-10 grid min-h-full place-items-center px-5 py-10",
          contentWrapClassName,
        )}
      >
        <div
          className={cn(
            scope === "pane"
              ? "w-full max-w-[430px] px-5 py-6"
              : "w-[min(430px,calc(100vw-2rem))] px-6 py-6 sm:px-8 sm:py-7",
            contentClassName,
          )}
          data-testid={contentTestId}
        >
          <div className="flex items-start gap-4">
            <div className="grid size-10 shrink-0 place-items-center text-[#E8E044]">
              {icon ?? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-5 animate-spin motion-reduce:animate-none"
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-meta text-[9px] font-bold uppercase tracking-[0.2em] text-[#E8E044]">
                {eyebrow}
              </p>
              <h2
                className={cn(
                  "mt-1 font-semibold tracking-tight text-white",
                  scope === "pane" ? "text-lg" : "text-xl",
                )}
              >
                {title}
              </h2>
              {detail ? (
                <p className="mt-2 text-sm leading-5 text-white/55">{detail}</p>
              ) : null}
              {telemetry ? (
                <CloudLoadingTelemetryPanel
                  telemetry={telemetry}
                  testId={telemetryTestId}
                />
              ) : null}
            </div>
          </div>

          {hasProgress ? (
            <div className="mt-6">
              <div
                aria-label={`${title} progress`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={normalizedProgress ?? undefined}
                className="h-1.5 overflow-hidden rounded-full bg-white/10"
                role="progressbar"
              >
                {normalizedProgress == null ? (
                  <div className="h-full w-1/3 animate-shimmer rounded-full bg-[#E8E044] motion-reduce:w-full motion-reduce:animate-none" />
                ) : (
                  <div
                    className="h-full rounded-full bg-[#E8E044] transition-[width] duration-300 ease-out motion-reduce:transition-none"
                    style={{ width: `${normalizedProgress}%` }}
                  />
                )}
              </div>
              <div className="mt-2 flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.12em] text-white/35">
                <span>{progressLabel}</span>
                <span>
                  {progressValueLabel
                    ?? (normalizedProgress == null ? "Working" : `${normalizedProgress}%`)}
                </span>
              </div>
            </div>
          ) : null}

          {children}
        </div>
      </div>
    </div>
  );
}

export function CloudActivityIndicator({
  label,
  className,
  iconClassName,
  testId,
}: {
  label?: string;
  className?: string;
  iconClassName?: string;
  testId?: string;
}) {
  return (
    <span
      className={cn("inline-flex items-center gap-2", className)}
      data-testid={testId}
      role={label ? "status" : undefined}
    >
      <LoaderCircle
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 animate-spin text-[#E8E044] motion-reduce:animate-none",
          iconClassName,
        )}
      />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

function CloudLoadingTelemetryPanel({
  telemetry,
  testId,
}: {
  telemetry: CloudLoadingTelemetry;
  testId: string;
}) {
  return (
    <div
      className={cn(
        "mt-4 rounded-xl border px-3 py-2.5 font-mono text-[11px]",
        telemetry.stalled
          ? "border-amber-300/25 bg-amber-300/10 text-amber-100"
          : "border-white/8 bg-black/15 text-white/65",
      )}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-4">
        <span>
          {telemetry.transferred}
          {telemetry.total ? ` / ${telemetry.total}` : " downloaded"}
        </span>
        {telemetry.speed ? <span>{telemetry.speed}</span> : null}
      </div>
      {telemetry.eta ? (
        <p className="mt-1.5 text-[10px] uppercase tracking-[0.1em] text-white/45">
          {telemetry.eta} remaining
        </p>
      ) : null}
      {telemetry.stalled ? (
        <p className="mt-1.5 text-[10px] uppercase tracking-[0.1em] text-amber-100/70">
          No bytes received for {telemetry.stalledFor ?? "several seconds"}
        </p>
      ) : null}
    </div>
  );
}

function normalizeProgress(progress: number | null | undefined) {
  if (progress == null || !Number.isFinite(progress)) return null;
  return Math.max(0, Math.min(100, Math.round(progress)));
}
