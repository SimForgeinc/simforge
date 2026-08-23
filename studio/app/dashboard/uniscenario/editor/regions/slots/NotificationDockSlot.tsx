"use client";

/**
 * HOST SLOT — editor notification publishers. Manifest items 166-168, 175.
 *
 * The dock and card themselves are already ported and live in
 * `../../status/` — `UniScenarioWorkspaceStatusProvider` mounts them, so there
 * is nothing to render here for the display side.
 *
 * Headless publishers added here must use the v2 document and revision
 * contracts and pass a source event id as `dedupeToken`.
 *
 * Publish through `useUniScenarioNotification` from `../../status`. Do not add a
 * second renderer: one stream, two renderers (dock + boot gate), by design.
 */
export function NotificationDockSlot(_props: {
  documentId: string | null;
  datasetId: string | null;
}) {
  return null;
}
