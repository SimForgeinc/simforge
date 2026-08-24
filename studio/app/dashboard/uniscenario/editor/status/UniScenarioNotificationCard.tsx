"use client";

import {
  AlertTriangle,
  Check,
  CircleAlert,
  CircleCheck,
  Copy,
  Info,
  LoaderCircle,
  X,
} from "lucide-react";
import { Button } from "@/app/components/ui/button";
import type {
  NotificationGroup,
  NotificationSeverity,
} from "./notification-model";
import { useCopyToClipboard } from "./CopyableErrorMessage";

const SEVERITY_ICON = {
  error: CircleAlert,
  warning: AlertTriangle,
  success: CircleCheck,
  info: Info,
  progress: LoaderCircle,
} as const;

const SEVERITY_CHROME: Record<NotificationSeverity, string> = {
  error: "border-destructive/50 bg-destructive/20 text-foreground",
  warning: "border-amber-400/40 bg-amber-500/15 text-foreground",
  success: "border-emerald-400/40 bg-emerald-500/15 text-foreground",
  info: "border-border/70 bg-background/95 text-foreground",
  progress: "border-border/70 bg-background/95 text-foreground",
};

const ICON_BUTTON =
  "editor-motion -mt-1 inline-flex size-7 shrink-0 items-center justify-center border border-border/70 bg-muted/40 text-current hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export function UniScenarioNotificationCard({
  group,
  onDismiss,
}: {
  group: NotificationGroup;
  onDismiss: (keys: string[]) => void;
}) {
  const { notification, count, keys } = group;
  const { severity, source, message, detail, progress, action } = notification;
  const isError = severity === "error";
  const Icon = SEVERITY_ICON[severity];
  const { copied, copy } = useCopyToClipboard();

  return (
    <div
      aria-live={isError ? "assertive" : "polite"}
      className={[
        "pointer-events-auto border px-3 py-2 shadow-lg backdrop-blur-md",
        SEVERITY_CHROME[severity],
        progress != null ? "relative overflow-hidden pb-2.5" : "",
      ].join(" ")}
      data-severity={severity}
      data-source={source}
      data-testid="uniscenario-notification-card"
      role={isError ? "alert" : "status"}
    >
      <div className="flex items-start gap-2">
        <Icon
          aria-hidden="true"
          className={[
            "mt-0.5 size-4 shrink-0",
            severity === "progress" ? "animate-spin text-primary" : "",
          ].join(" ")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-micro font-bold uppercase tracking-meta opacity-70">
              {source}
            </span>
            {count > 1 ? (
              <span
                className="border border-border/70 bg-muted/40 px-1 text-micro font-bold tabular-nums"
                data-testid="uniscenario-notification-count"
                title={`${count} notifications say this`}
              >
                ×{count}
              </span>
            ) : null}
            {progress != null ? (
              <span className="ml-auto text-meta font-medium tabular-nums opacity-80">
                {progress}%
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 text-sm font-medium leading-snug">
            {message}
          </div>
          {detail ? (
            <div className="mt-0.5 text-xs leading-snug opacity-70">
              {detail}
            </div>
          ) : null}
          {action ? (
            <Button
              className="mt-2 h-7 px-2.5 text-xs"
              size="sm"
              variant="outline"
              onClick={action.run}
            >
              {action.label}
            </Button>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={
            copied
              ? `${message} copied to clipboard`
              : `Copy ${message} to clipboard`
          }
          className={ICON_BUTTON}
          title={copied ? "Copied" : "Copy to clipboard"}
          onClick={() =>
            copy(
              detail
                ? `[${source}] ${message} — ${detail}`
                : `[${source}] ${message}`,
            )
          }
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          aria-label={`Dismiss ${message}`}
          className={`${ICON_BUTTON} -mr-1`}
          onClick={() => onDismiss(keys)}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      {progress != null ? (
        <div
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
          aria-label={`${message} progress`}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-muted"
          role="progressbar"
        >
          <span
            className="block h-full bg-primary transition-[width] duration-300 motion-reduce:transition-none"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}
