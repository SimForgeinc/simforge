"use client";

import { inferNotificationSource } from "./notification-model";
import { useScenarioNotification } from "./use-scenario-notification";
import type {
  ScenarioWorkspaceStatus,
  ScenarioWorkspaceStatusKind,
} from "./workspace-status";
import type { NotificationSeverity } from "./notification-model";

/**
 * "Loading" and "progress" are the same card — a spinner, and a bar only when
 * there is a number to put in it. The old split existed because v1's rail chose
 * one winner and needed `loading` to rank below `progress`; nothing ranks by
 * kind any more.
 */
const SEVERITY_BY_KIND: Record<
  ScenarioWorkspaceStatusKind,
  NotificationSeverity
> = {
  error: "error",
  warning: "warning",
  progress: "progress",
  loading: "progress",
};

/**
 * Legacy publish shape as an adapter over `useScenarioNotification`.
 *
 * This lives apart from `ScenarioWorkspaceStatusProvider` on purpose. The
 * provider pulls in the dock and the boot gate; a publisher wants neither, and
 * co-locating them makes every publisher — including anything behind a
 * `dynamic()` boundary — drag both renderers into its chunk.
 *
 * @deprecated Publish with `useScenarioNotification` in new code — it carries
 * an explicit `source` instead of inferring one from the key.
 */
export function useScenarioWorkspaceStatus(
  key: string,
  status: ScenarioWorkspaceStatus | null,
  enabled = true,
) {
  useScenarioNotification(
    key,
    status
      ? {
          severity: SEVERITY_BY_KIND[status.kind],
          source: inferNotificationSource(key),
          message: status.label,
          detail: status.detail,
          progress: status.progress,
          blocking: status.blocking,
          action:
            status.action && status.actionLabel
              ? { label: status.actionLabel, run: status.action }
              : null,
        }
      : null,
    enabled,
  );
}
