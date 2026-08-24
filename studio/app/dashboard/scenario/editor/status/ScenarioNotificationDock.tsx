"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import {
  NOTIFICATION_STACK_CAP,
  collapseNotifications,
  orderNotifications,
  visibleNotificationGroups,
} from "./notification-model";
import {
  undismissedNotifications,
  useScenarioNotificationStore,
} from "./notification-store";
import { ScenarioNotificationCard } from "./ScenarioNotificationCard";

/** How often expiry is checked. Coarse on purpose — TTLs are seconds, not frames. */
const SWEEP_INTERVAL_MS = 500;

/**
 * The v2 editor's one notification surface: a stacked card column in the bottom
 * right, newest nearest the corner and growing upward.
 *
 * `z-[70]` matches v1 deliberately. It sits above the timeline dock and the
 * floating tool strip, and below modals — when an author has a panel open, a
 * transient card must not cover the thing they are editing.
 */
export function ScenarioNotificationDock() {
  const entries = useScenarioNotificationStore((state) => state.entries);
  const dismissedRevisionByKey = useScenarioNotificationStore(
    (state) => state.dismissedRevisionByKey,
  );
  const dismiss = useScenarioNotificationStore((state) => state.dismiss);
  const setPaused = useScenarioNotificationStore((state) => state.setPaused);
  const sweep = useScenarioNotificationStore((state) => state.sweep);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [sweep]);

  const visible = useMemo(
    () =>
      undismissedNotifications(entries, dismissedRevisionByKey).filter(
        (entry) => !entry.blocking,
      ),
    [dismissedRevisionByKey, entries],
  );

  const { groups, overflowCount } = useMemo(() => {
    if (expanded) {
      return {
        groups: collapseNotifications(orderNotifications(visible)),
        overflowCount: 0,
      };
    }
    return visibleNotificationGroups(visible, NOTIFICATION_STACK_CAP);
  }, [expanded, visible]);

  // Collapsing is only meaningful while something is hidden; once the stack
  // drains below the cap the expanded state would silently persist and the
  // "Show less" row would be the only thing left to click.
  const hiddenCount = expanded
    ? Math.max(0, groups.length - NOTIFICATION_STACK_CAP)
    : overflowCount;

  useEffect(() => {
    if (expanded && hiddenCount === 0) setExpanded(false);
  }, [expanded, hiddenCount]);

  if (groups.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed bottom-5 right-5 z-[70] flex w-[min(380px,calc(100vw-2rem))] flex-col-reverse gap-2"
      data-testid="scenario-notification-dock"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {groups.map((group) => (
        <ScenarioNotificationCard
          key={group.notification.key}
          group={group}
          onDismiss={dismiss}
        />
      ))}
      {hiddenCount > 0 || expanded ? (
        <Button
          aria-expanded={expanded}
          className="pointer-events-auto h-auto justify-center border-border/70 bg-background/95 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur-md hover:text-foreground"
          data-testid="scenario-notification-overflow"
          size="sm"
          variant="outline"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? (
            <>
              <ChevronDown aria-hidden="true" />
              Show less
            </>
          ) : (
            <>
              <ChevronUp aria-hidden="true" />
              {`+${hiddenCount} more`}
            </>
          )}
        </Button>
      ) : null}
    </div>
  );
}
