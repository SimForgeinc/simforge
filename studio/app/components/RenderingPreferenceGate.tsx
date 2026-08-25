"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { readRenderingPreference } from "@/app/components/rendering-preference"
import { installMapAssetFetchGateway } from "@/app/lib/maps/frontend/map-asset-cache";

installMapAssetFetchGateway();

const RENDER_SETTINGS_PATH = "/dashboard/render-settings";

/**
 * Keeps first-run setup out of the pages it configures. Render settings used to
 * be a global overlay, which left map viewers mounted and downloading behind it.
 */
export function RenderingPreferenceGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isSettingsPage = pathname === RENDER_SETTINGS_PATH;
  const [ready, setReady] = useState(isSettingsPage);

  useEffect(() => {
    if (isSettingsPage) {
      setReady(true);
      return;
    }
    if (readRenderingPreference()) {
      setReady(true);
      return;
    }
    setReady(false);
    router.replace(RENDER_SETTINGS_PATH);
  }, [isSettingsPage, router]);

  return (
    <div
      aria-hidden={!ready || undefined}
      className={`h-full min-h-0 ${ready ? "" : "invisible"}`}
      data-testid="rendering-preference-content"
      inert={!ready || undefined}
    >
      {children}
    </div>
  );
}
