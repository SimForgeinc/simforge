"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AppSwitcherOverlay } from "@/app/components/AppSwitcherOverlay";
import SimForgeLogo from "@/app/components/landing/SimForgeLogo";
import { useTopBarSlotContext } from "@/app/components/TopBarSlot";
import { activeNavItem } from "@/app/lib/dashboard-nav";
import { cn } from "@/app/lib/utils";

type WorkspaceInfo = {
  id: string;
  type: string;
  name: string;
};

type AppTopBarProps = {
  accountEmail: string;
  creditsBalance: number | null;
  pendingCreditsCents: number;
  workspaces: WorkspaceInfo[];
  activeWorkspaceId: string;
};

function formatCreditsCompact(value: number | null): string {
  if (value === null) return "—";
  return `$${(value / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatCreditsWithPending(
  creditsBalance: number | null,
  pendingCreditsCents: number,
) {
  const settled = formatCreditsCompact(creditsBalance);
  if (pendingCreditsCents <= 0) return settled;
  return `${settled} (${formatCreditsCompact(pendingCreditsCents)})`;
}

export function AppTopBar({
  accountEmail,
  creditsBalance,
  pendingCreditsCents,
  workspaces,
  activeWorkspaceId,
}: AppTopBarProps) {
  const pathname = usePathname();
  const switcherTriggerRef = useRef<HTMLButtonElement>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [displayCreditsBalance, setDisplayCreditsBalance] =
    useState(creditsBalance);
  const [displayPendingCreditsCents, setDisplayPendingCreditsCents] =
    useState(pendingCreditsCents);
  const [hasMounted, setHasMounted] = useState(false);

  const slotCtx = useTopBarSlotContext();
  const activeItem = activeNavItem(pathname);
  const routePageTitle = pathname.startsWith("/dashboard/uniscenario")
    ? "Dataset"
    : activeItem?.label ?? null;
  // Page-level title effects can commit before this Suspense boundary hydrates.
  // Keep the server snapshot for the hydration render, then accept contextual
  // titles after this component's first client commit.
  const displayPageTitle = hasMounted
    ? slotCtx?.customTitle ?? routePageTitle
    : routePageTitle;
  const unbrandedPageTitle = displayPageTitle
    ?.replace(/^SIMCLOUD\s*[-—:]\s*/i, "")
    .trim();

  useEffect(() => {
    setHasMounted(true);
  }, []);

  useEffect(() => {
    setDisplayCreditsBalance(creditsBalance);
    setDisplayPendingCreditsCents(pendingCreditsCents);
  }, [creditsBalance, pendingCreditsCents]);

  useEffect(() => {
    if (!switcherOpen) return;
    let cancelled = false;

    async function refreshCreditsBalance() {
      try {
        const response = await fetch("/api/billing/balance", {
          cache: "no-store",
        });
        if (!response.ok) return;
        const payload = (await response.json().catch(() => null)) as {
          creditsBalance?: unknown;
          pendingCreditsCents?: unknown;
        } | null;
        if (!cancelled && typeof payload?.creditsBalance === "number") {
          setDisplayCreditsBalance(payload.creditsBalance);
        }
        if (!cancelled && typeof payload?.pendingCreditsCents === "number") {
          setDisplayPendingCreditsCents(payload.pendingCreditsCents);
        }
      } catch {
        // Keep the server-rendered balance if the refresh is unavailable.
      }
    }

    void refreshCreditsBalance();
    return () => {
      cancelled = true;
    };
  }, [switcherOpen]);


  return (
    <>
      <header
        className="sticky top-0 z-[260] flex h-14 w-full shrink-0 items-center overflow-hidden border-b border-white/15 bg-black/[0.52] shadow-[0_10px_35px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.10)] backdrop-blur-2xl backdrop-saturate-0 after:pointer-events-none after:absolute after:inset-0 after:shadow-[inset_0_0_34px_rgba(255,255,255,0.07)]"
        data-testid="app-topbar"
      >
        <div
          aria-hidden="true"
          className="app-topbar-clouds pointer-events-none absolute -inset-x-[8%] -inset-y-full"
          data-testid="app-topbar-clouds"
        />
        <div className="relative z-10 flex h-full w-full items-center gap-3 px-3">
          <button
            ref={switcherTriggerRef}
            type="button"
            onClick={() => setSwitcherOpen(true)}
            aria-label="Open app switcher"
            aria-haspopup="dialog"
            aria-expanded={switcherOpen}
            className="group flex size-10 shrink-0 items-center justify-center bg-transparent text-primary transition-colors hover:bg-transparent hover:text-[#f4ed55] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className="flex items-center justify-center transition-[transform,filter] duration-200 ease-out [filter:drop-shadow(0_0_0_transparent)] group-hover:scale-[1.18] group-hover:[filter:drop-shadow(0_0_1px_#E8E044)_drop-shadow(0_0_8px_rgba(232,224,68,0.32))] group-focus-visible:scale-[1.18] motion-reduce:transition-none"
              data-testid="app-topbar-logo"
            >
              <SimForgeLogo size={30} />
            </span>
          </button>

          <div className="flex min-w-0 flex-1 items-center gap-4">
            {unbrandedPageTitle ? (
              <span
                suppressHydrationWarning
                className="flex min-w-0 items-baseline gap-2 truncate text-foreground"
                data-topbar-slot="title"
                aria-label={`SIMCLOUD - ${unbrandedPageTitle}`}
              >
                <span
                  className="shrink-0 text-[20px] uppercase"
                  style={{
                    fontFamily: "var(--font-heavy)",
                    fontWeight: 700,
                    letterSpacing: "-0.055em",
                    lineHeight: 0.84,
                  }}
                  data-topbar-slot="brand"
                >
                  SIMCLOUD
                </span>
                <span aria-hidden="true" className="shrink-0 text-foreground/35">
                  -
                </span>
                <span
                  className="min-w-0 truncate text-[22px] font-semibold leading-[1.1] tracking-tight"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {unbrandedPageTitle}
                </span>
              </span>
            ) : null}
            <div
              ref={(element) => slotCtx?.registerActionsSlot(element)}
              className={cn(
                "flex shrink-0 items-center gap-2",
                slotCtx?.actionsAlignment === "start" ? "mr-auto" : "ml-auto",
              )}
              data-topbar-slot="actions"
            />
            <div
              ref={(element) => slotCtx?.registerTrailingSlot(element)}
              className="flex shrink-0 items-center"
              data-topbar-slot="trailing"
            />
          </div>
        </div>
      </header>

      <AppSwitcherOverlay
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        pathname={pathname}
        accountEmail={accountEmail}
        creditsLabel={formatCreditsWithPending(
          displayCreditsBalance,
          displayPendingCreditsCents,
        )}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        triggerRef={switcherTriggerRef}
      />
    </>
  );
}
