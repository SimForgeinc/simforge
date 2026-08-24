"use client";

import { useRouter } from "next/navigation";
import { useScenarioWorkspaceStatus } from "./use-workspace-status";

/**
 * Publishes a blocking error into the stream and renders nothing visible.
 *
 * The point is that the *caller* keeps rendering. A workspace that hits an error
 * mounts this alongside the editor rather than in place of it, so the boot gate
 * paints over a live tree instead of replacing one.
 */
export function ScenarioWorkspaceErrorState({
  actionHref,
  actionLabel = "Back to datasets",
  detail,
  label,
  statusKey,
}: {
  actionHref?: string | null;
  actionLabel?: string;
  detail: string;
  label: string;
  statusKey: string;
}) {
  const router = useRouter();
  useScenarioWorkspaceStatus(statusKey, {
    kind: "error",
    label,
    detail,
    blocking: true,
    actionLabel: actionHref ? actionLabel : null,
    action: actionHref ? () => router.push(actionHref) : null,
  });

  return null;
}
