import { Suspense, type ReactNode } from "react";
import { AppTopBar } from "@/app/components/AppTopBar";
import { TopBarSlotProvider } from "@/app/components/TopBarSlot";
import { RenderingPreferenceGate } from "@/app/components/RenderingPreferenceGate";
import { DashboardLoadingProvider } from "@/app/components/DashboardLoadingCoordinator";
import DashboardLoading from "./loading";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <TopBarSlotProvider>
      <DashboardLoadingProvider>
        <div className="flex h-svh flex-col overflow-hidden bg-background">
          {/* AppTopBar reads usePathname(); Suspense lets the static shell prerender. */}
          <Suspense fallback={<div className="h-14 shrink-0" />}>
            <AppTopBar />
          </Suspense>
          <main className="flex-1 min-h-0 overflow-y-auto">
            <div className="h-full min-h-0">
              <Suspense fallback={<DashboardLoading />}>
                <RenderingPreferenceGate>
                  <Suspense fallback={<DashboardLoading />}>{children}</Suspense>
                </RenderingPreferenceGate>
              </Suspense>
            </div>
          </main>
        </div>
      </DashboardLoadingProvider>
    </TopBarSlotProvider>
  );
}
