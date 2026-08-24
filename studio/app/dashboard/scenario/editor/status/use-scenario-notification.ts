"use client";

import { useEffect, useRef } from "react";
import { useScenarioNotificationStore } from "./notification-store";
import type {
  NotificationAction,
  ScenarioNotificationInput,
} from "./notification-model";

type PublishableNotification = Omit<ScenarioNotificationInput, "key">;

let transientSerial = 0;

/**
 * Fire-and-forget publish for one-shot outcomes ("Export ready") that have no
 * ongoing condition to mirror, and so no natural moment to retract.
 *
 * Each call gets a fresh key so repeats collapse into a ×N badge rather than
 * overwriting each other, and the per-severity TTL takes them down.
 */
export function notifyScenario(
  notification: PublishableNotification & { key?: string },
) {
  transientSerial += 1;
  const key = notification.key ?? `transient:${transientSerial}`;
  useScenarioNotificationStore.getState().publish({ ...notification, key });
  return key;
}

/**
 * Declarative publish: hold this notification up for as long as the caller
 * renders it, and take it down when the caller stops or unmounts.
 *
 * Callers describe a condition ("the map is still booting"), not an event, so a
 * hook that mirrors mount/unmount is the shape that cannot leak.
 */
export function useScenarioNotification(
  key: string,
  notification: PublishableNotification | null,
  enabled = true,
) {
  const publish = useScenarioNotificationStore((state) => state.publish);
  const unpublish = useScenarioNotificationStore((state) => state.unpublish);

  // The action closure is almost always a fresh function each render. Holding
  // it in a ref and publishing a stable wrapper keeps that identity churn from
  // re-publishing (and so restarting the TTL of) an otherwise unchanged card.
  const actionRef = useRef<NotificationAction | null | undefined>(
    notification?.action,
  );
  actionRef.current = notification?.action;

  const severity = notification?.severity;
  const source = notification?.source;
  const message = notification?.message;
  const detail = notification?.detail;
  const progress = notification?.progress;
  const ttlMs = notification?.ttlMs;
  const blocking = notification?.blocking;
  const actionLabel = notification?.action?.label;

  useEffect(() => {
    if (!enabled || !severity || !source || !message) {
      unpublish(key);
      return;
    }
    publish({
      key,
      severity,
      source,
      message,
      detail,
      progress,
      ttlMs,
      blocking,
      action: actionLabel
        ? { label: actionLabel, run: () => actionRef.current?.run() }
        : null,
    });
    return () => unpublish(key);
  }, [
    actionLabel,
    blocking,
    detail,
    enabled,
    key,
    message,
    progress,
    publish,
    severity,
    source,
    ttlMs,
    unpublish,
  ]);
}
