/**
 * The v2 editor's status and notification system (manifest items 166-170).
 *
 * Port a v1 panel that publishes status by swapping
 * `useEditorWorkspaceStatus` → `useScenarioWorkspaceStatus` and
 * `useEditorNotification` → `useScenarioNotification`. The publish shapes are
 * identical; only the store behind them changes.
 */
export { CopyableErrorMessage, useCopyToClipboard } from "./CopyableErrorMessage";
export { ScenarioBootGate } from "./ScenarioBootGate";
export { ScenarioNotificationCard } from "./ScenarioNotificationCard";
export { ScenarioNotificationDock } from "./ScenarioNotificationDock";
export { ScenarioWorkspaceErrorState } from "./ScenarioWorkspaceErrorState";
export { ScenarioWorkspaceStatusProvider } from "./ScenarioWorkspaceStatusProvider";
export {
  notifyScenario,
  useScenarioNotification,
} from "./use-scenario-notification";
export { useScenarioWorkspaceStatus } from "./use-workspace-status";
export {
  undismissedNotifications,
  useScenarioNotificationStore,
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
  type ScenarioNotification,
  type ScenarioNotificationInput,
} from "./notification-model";
export {
  type ScenarioWorkspaceStatus,
  type ScenarioWorkspaceStatusKind,
} from "./workspace-status";
