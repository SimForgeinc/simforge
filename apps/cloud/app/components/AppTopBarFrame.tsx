import SimForgeLogo from "@/app/components/landing/SimForgeLogo";

/**
 * Static replica of `AppTopBar`'s chrome, used as the Suspense fallback while
 * the authenticated top bar resolves.
 *
 * This is the piece Cache Components prerenders into the route shell, so it
 * must stay free of `cookies()`, `headers()`, `connection()`, and every other
 * per-request read. Before this existed the whole dashboard shell prerendered
 * to a single full-page spinner; the header geometry (h-14, the border, the
 * logo button) is now static HTML and no longer waits on session resolution.
 *
 * Geometry is duplicated from `AppTopBar` deliberately rather than shared: the
 * real bar is a client component whose chrome is entangled with hover state,
 * and a placeholder that imported it would drag that bundle into the shell.
 * Keep the header height and border in sync with `AppTopBar` so the streamed
 * bar does not shift layout when it replaces this.
 */
export function AppTopBarFrame() {
  return (
    <header
      className="sticky top-0 z-30 flex h-14 w-full shrink-0 items-center border-b border-border bg-background/95 backdrop-blur-sm"
      role="status"
      aria-label="Loading workspace navigation"
    >
      <div className="flex h-full w-full items-center gap-3 px-3" aria-hidden="true">
        <div className="flex shrink-0 items-center">
          {/* Desktop button — mirrors DesktopUnifiedTrigger, without the hover affordances. */}
          <div className="hidden size-10 items-center justify-center rounded-md md:flex">
            <div className="flex shrink-0 items-center justify-center text-primary">
              <SimForgeLogo size={32} />
            </div>
          </div>

          {/* Mobile chip — the workspace name is per-request data, so it is omitted here. */}
          <div className="flex h-10 items-center gap-2 px-2 pr-2.5 md:hidden">
            <div className="flex aspect-square size-7 shrink-0 items-center justify-center text-primary">
              <SimForgeLogo size={24} />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
