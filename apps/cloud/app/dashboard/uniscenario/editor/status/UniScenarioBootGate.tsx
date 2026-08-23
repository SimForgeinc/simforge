"use client";

import { useMemo } from "react";
import { CircleAlert } from "lucide-react";
import {
  useDashboardLoadingSource,
  type DashboardLoadingSource,
} from "@/app/components/DashboardLoadingCoordinator";
import { Button } from "@/app/components/ui/button";
import { resolveBlockingNotification } from "./notification-model";
import {
  undismissedNotifications,
  useUniScenarioNotificationStore,
} from "./notification-store";

/**
 * Publishes editor-blocking work into the dashboard's single viewport loader.
 * The editor stays mounted beneath the cover, so progress changes never replace
 * its WebGL context or compete with the scene loader for a second overlay.
 */
export function UniScenarioBootGate() {
  const entries = useUniScenarioNotificationStore((state) => state.entries);
  const dismissedRevisionByKey = useUniScenarioNotificationStore(
    (state) => state.dismissedRevisionByKey,
  );

  const blocking = useMemo(
    () =>
      resolveBlockingNotification(
        undismissedNotifications(entries, dismissedRevisionByKey),
      ),
    [dismissedRevisionByKey, entries],
  );

  const source = useMemo<DashboardLoadingSource | null>(() => {
    if (!blocking) return null;
    const isError = blocking.severity === "error";
    return {
      kind: "boot",
      title: blocking.message,
      detail: blocking.detail,
      eyebrow: isError ? "Editor interrupted" : "Preparing editor",
      progress: isError ? undefined : (blocking.progress ?? null),
      progressLabel: "Editor workspace",
      severity: isError ? "error" : "loading",
      icon: isError ? <CircleAlert className="size-5" aria-hidden="true" /> : undefined,
      actions: blocking.action ? (
        <Button
          className="mt-6 h-10 rounded-full bg-[#E8E044] px-5 text-black hover:bg-[#f1ea55]"
          onClick={blocking.action.run}
        >
          {blocking.action.label}
        </Button>
      ) : undefined,
    };
  }, [blocking]);

  useDashboardLoadingSource(source);
  return null;
}
