/**
 * The v2 editor's status and notification system (manifest items 166-170).
 *
 * Port a v1 panel that publishes status by swapping
 * `useEditorWorkspaceStatus` → `useUniScenarioWorkspaceStatus` and
 * `useEditorNotification` → `useUniScenarioNotification`. The publish shapes are
 * identical; only the store behind them changes.
 */
export { CopyableErrorMessage, useCopyToClipboard } from "./CopyableErrorMessage";
export { UniScenarioBootGate } from "./UniScenarioBootGate";
export { UniScenarioNotificationCard } from "./UniScenarioNotificationCard";
export { UniScenarioNotificationDock } from "./UniScenarioNotificationDock";
export { UniScenarioWorkspaceErrorState } from "./UniScenarioWorkspaceErrorState";
export { UniScenarioWorkspaceStatusProvider } from "./UniScenarioWorkspaceStatusProvider";
export {
  notifyUniScenario,
  useUniScenarioNotification,
} from "./use-uniscenario-notification";
export { useUniScenarioWorkspaceStatus } from "./use-workspace-status";
export {
  undismissedNotifications,
  useUniScenarioNotificationStore,
} from "./notification-store";
export {
  NOTIFICATION_STACK_CAP,
  clampStatusProgress,
  collapseNotifications,
  expiredNotificationKeys,
  inferNotificationSource,
  notificationContentKey,
  notificationTtlMs,
  orderNotifications,
  resolveBlockingNotification,
  userSafeErrorDetail,
  visibleNotificationGroups,
  type NotificationAction,
  type NotificationGroup,
  type NotificationSeverity,
  type NotificationSource,
  type UniScenarioNotification,
  type UniScenarioNotificationInput,
} from "./notification-model";
export {
  type UniScenarioWorkspaceStatus,
  type UniScenarioWorkspaceStatusKind,
} from "./workspace-status";
