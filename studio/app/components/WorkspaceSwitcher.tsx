"use client";

import { Check } from "lucide-react";
import { cn } from "@/app/lib/utils";

export type WorkspaceSwitcherOption = {
  id: string;
  name: string;
  type: string;
};

export function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  className,
}: {
  workspaces: WorkspaceSwitcherOption[];
  activeWorkspaceId: string;
  className?: string;
  onNavigate?: () => void;
  onWorkspaceSelected?: () => void;
}) {
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
    ?? workspaces[0];

  return (
    <div className={className}>
      <div
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left",
          "text-foreground",
        )}
        aria-label="Local workspace"
      >
        <span className="size-2 shrink-0 bg-[color:var(--accent-brand)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {activeWorkspace?.name ?? "Local Workspace"}
        </span>
        <Check className="size-4 shrink-0" aria-label="Current workspace" />
      </div>
    </div>
  );
}
