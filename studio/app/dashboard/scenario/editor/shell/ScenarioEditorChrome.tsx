import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/app/lib/utils";

export type ScenarioEditorStatusTone =
  | "neutral"
  | "saved"
  | "working"
  | "warning"
  | "error";

const STATUS_TONE_CLASSES: Record<ScenarioEditorStatusTone, string> = {
  neutral: "bg-editor-muted",
  saved: "bg-emerald-400",
  working: "bg-editor-accent",
  warning: "bg-amber-400",
  error: "bg-rose-400",
};

/** Compact document chrome shared by the canvas and OpenSCENARIO workspaces. */
export function ScenarioEditorChromeHeader({
  title,
  subtitle,
  badge = "Scenario",
  status,
  statusTone = "neutral",
  leading,
  actions,
  className,
  ...headerProps
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  status?: ReactNode;
  statusTone?: ScenarioEditorStatusTone;
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header
      {...headerProps}
      className={cn(
        "flex min-h-[var(--scenario-header-height)] min-w-0 items-center gap-3 border-b border-editor-line bg-editor-bg/95 px-3 text-editor-text backdrop-blur-md sm:px-4",
        className,
      )}
      data-editor-shell-region="header"
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-editor-text">{title}</h1>
          {badge ? (
            <span className="shrink-0 border border-editor-line bg-editor-panel2 px-1.5 py-0.5 font-meta text-micro uppercase tracking-meta text-editor-muted">
              {badge}
            </span>
          ) : null}
        </div>
        {subtitle ? (
          <p className="truncate font-meta text-micro uppercase tracking-meta text-editor-muted">
            {subtitle}
          </p>
        ) : null}
      </div>
      {status ? (
        <div
          aria-live="polite"
          className="hidden shrink-0 items-center gap-2 font-meta text-micro uppercase tracking-meta text-editor-muted sm:flex"
          data-editor-header-status={statusTone}
        >
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", STATUS_TONE_CLASSES[statusTone])}
          />
          {status}
        </div>
      ) : null}
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}

/** A small instrument-panel readout that can sit above or below the canvas. */
export function ScenarioEditorReadout({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn(
        "border border-editor-line bg-editor-bg/90 px-3 py-2 font-meta text-micro uppercase tracking-meta text-editor-muted shadow-xl backdrop-blur-md",
        className,
      )}
    >
      {children}
    </div>
  );
}
