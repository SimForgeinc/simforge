import { Suspense } from "react";
import { headers } from "next/headers";
import { connection } from "next/server";
import { AppTopBar } from "@/app/components/AppTopBar";
import { AppTopBarFrame } from "@/app/components/AppTopBarFrame";
import { TopBarSlotProvider } from "@/app/components/TopBarSlot";
import { RenderingPreferenceGate } from "@/app/components/RenderingPreferenceGate";
import { DashboardLoadingProvider } from "@/app/components/DashboardLoadingCoordinator";
import { requireAppContext } from "@/app/lib/db/app-context";
import { listWorkspacesForUser, getWorkspaceCreditSummary } from "@/app/lib/db/workspace-store";
import type { ReactNode } from "react";
import DashboardLoading from "./loading";

const DASHBOARD_FALLBACK_PATH = "/dashboard";
const REQUEST_PATH_HEADER = "x-simforge-request-path";

async function getDashboardNextPath() {
  const requestHeaders = await headers();
  const requestPath = requestHeaders.get(REQUEST_PATH_HEADER)?.trim();
  return requestPath?.startsWith("/dashboard") ? requestPath : DASHBOARD_FALLBACK_PATH;
}

/**
 * The top bar's per-request half: session identity, the workspace list, and the
 * credit balance. Split out of the layout body so it streams independently of
 * the page underneath it — the two used to share one Suspense boundary, which
 * meant the whole dashboard waited on the slowest of them.
 *
 * `requireAppContext`, not `provisionAppContext`: the layout and the page it
 * wraps render in the same request. The dedupe is real even though this now
 * calls it twice — `resolveAppContext` is `cache()`d on the per-request session
 * object, so only the redirect argument differs and the resolution runs once.
 */
async function AuthenticatedTopBar() {
  await connection();
  const {
    session,
    userId,
    workspaceId: activeWorkspaceId,
  } = await requireAppContext(await getDashboardNextPath());

  // Fetch workspaces and credits in parallel
  const [workspaces, creditSummary] = await Promise.all([
    listWorkspacesForUser(userId),
    getWorkspaceCreditSummary(activeWorkspaceId),
  ]);

  return (
    <AppTopBar
      accountEmail={session.email ?? session.name ?? "Authenticated user"}
      creditsBalance={creditSummary.creditsBalance}
      pendingCreditsCents={creditSummary.pendingCreditsCents}
      workspaces={workspaces.map((w) => ({ id: w.id, type: w.type, name: w.name }))}
      activeWorkspaceId={activeWorkspaceId}
    />
  );
}

/**
 * INVARIANT — every page under `app/dashboard/**` must authenticate for itself.
 *
 * `{children}` is deliberately NOT wrapped in a layout-level authorization gate.
 * It used to be, and that made the layout the only thing standing between an
 * unauthenticated request and a page's data reads. It also meant nothing a page
 * rendered could ever reach the prerendered shell, because nothing below a
 * suspended boundary prerenders — so every route shipped the same generic
 * spinner instead of its own chrome and its own `loading.tsx` copy.
 *
 * Access control did not move to the honour system. Two things still enforce it:
 * every page calls `requireAppContext` (or `requireCurrentSession`) itself, and
 * `AuthenticatedTopBar` above resolves the same context on every dashboard
 * request, so an unauthenticated caller is redirected regardless of what the page
 * does. `dashboard-page-auth.test.ts` fails the build if a new page omits its own
 * gate, which is what keeps the invariant true rather than merely documented.
 *
 * If you add a page here, gate it. Do not re-add a gate around `{children}`.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  // Everything outside the two Suspense boundaries is static, and is what
  // Cache Components prerenders into the shell for every /dashboard route: the
  // viewport-height flex column, the header geometry, and the scroll container.
  return (
    <TopBarSlotProvider>
      <DashboardLoadingProvider>
        <div className="flex h-svh flex-col overflow-hidden bg-background">
          <Suspense fallback={<AppTopBarFrame />}>
            <AuthenticatedTopBar />
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
