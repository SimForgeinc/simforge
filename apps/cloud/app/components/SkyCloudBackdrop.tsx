"use client";

import { AppSwitcherSkyScene } from "@/app/components/AppSwitcherSkyScene";
import { cn } from "@/app/lib/utils";

export function SkyCloudBackdrop({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "absolute inset-0 overflow-hidden bg-black/60 backdrop-blur-[42px] backdrop-saturate-0 backdrop-contrast-125 before:absolute before:inset-0 before:bg-[radial-gradient(circle_at_50%_46%,rgba(255,255,255,0.07)_0%,rgba(18,19,20,0.18)_38%,rgba(2,3,4,0.72)_100%)]",
        className,
      )}
      data-testid="sky-cloud-backdrop"
    >
      {animated ? (
        <AppSwitcherSkyScene />
      ) : (
        <div aria-hidden="true" className="app-topbar-clouds absolute inset-0" />
      )}
    </div>
  );
}
