"use client";

import type { ReactNode } from "react";
import { ScenarioBootGate } from "./ScenarioBootGate";
import { ScenarioNotificationDock } from "./ScenarioNotificationDock";

/**
 * Mounts the v2 editor's two status renderers: the bottom-right notification
 * dock, and the boot gate for the statuses that mean the page is not usable yet.
 *
 * `useScenarioWorkspaceStatus` and `useScenarioNotification` publish into
 * a store, so a publisher does not have to be inside this subtree to be heard —
 * but nothing is *rendered* unless this is mounted somewhere above. That is the
 * failure mode worth naming: a ported panel that publishes a status with no
 * provider mounted looks exactly like a panel that publishes nothing.
 *
 * Both renderers are `fixed` overlays rather than flow children, so appearing
 * and disappearing never reflows the canvas.
 */
export function ScenarioWorkspaceStatusProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      <ScenarioNotificationDock />
      <ScenarioBootGate />
    </div>
  );
}
