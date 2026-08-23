'use client';

import { Children, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/app/lib/utils';
import { useDevHudHidden } from './dev-hud-visibility';

/**
 * Whether a section is dev-only (subject to the Shift+H hide chord) or
 * customer-facing (always visible). Default `'customer'` makes new sections
 * safe-by-default — a section that forgets the prop can't accidentally
 * inherit the dev hide rule.
 */
export type ViewerAccordionSectionKind = 'customer' | 'dev';

interface ViewerAccordionSectionProps {
  /** Stable identifier for the section. Used as a debugging hook in the DOM. */
  id: string;
  /** Section header label. */
  title: string;
  /** Initial open state. Each section is independently collapsible. */
  defaultOpen?: boolean;
  /**
   * Optional trailing element rendered as a sibling of the toggle button (a
   * status pill, an action button, etc.). Rendered outside the toggle button
   * so interactive adornments don't violate the no-nested-buttons rule.
   */
  headerAdornment?: ReactNode;
  /**
   * Dev vs customer scoping for the Shift+H hide chord (ABH-69). `'dev'`
   * sections unmount when `useDevHudHidden()` is true so Stats / Audit /
   * Visual config disappear together; `'customer'` sections render
   * unconditionally. Defaulting to `'customer'` keeps a forgotten prop safe.
   */
  kind?: ViewerAccordionSectionKind;
  children: ReactNode;
}

/**
 * Single collapsible section inside the right-side viewer accordion. Each
 * section owns its own open/closed state so dev sections can be expanded
 * independently.
 *
 * When `kind="dev"`, the section subscribes to the dev-hud visibility
 * singleton and unmounts on Shift+H. The visibility rule lives here — not
 * scattered across each HUD's render — so adding a new section only requires
 * declaring what it is, not re-wiring the chord.
 */
export function ViewerAccordionSection({
  id,
  title,
  defaultOpen = true,
  headerAdornment,
  kind = 'customer',
  children,
}: ViewerAccordionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const devHudHidden = useDevHudHidden();
  if (kind === 'dev' && devHudHidden) return null;
  return (
    <div data-section-id={id} className="border-b border-border/60 last:border-b-0">
      <div className="flex w-full items-center hover:bg-muted/40 transition-colors">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-1.5 px-3 py-2 text-left"
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-muted-foreground transition-transform duration-150',
              !open && '-rotate-90',
            )}
          />
          <span className="text-xs font-semibold flex-1">{title}</span>
        </button>
        {headerAdornment ? <div className="pr-3">{headerAdornment}</div> : null}
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

interface ViewerAccordionProps {
  children?: ReactNode;
}

/**
 * Right-side accordion shell for the 3D viewer. Hosts dev-only sections
 * (Stats / Viewer audit / Visual config — added by ABH-66/67/68). The shell
 * is a fixed panel anchored to the top-right of the canvas — not a draggable
 * overlay.
 *
 * When no children render (initial state in this issue, and the production
 * state after the NEXT_PUBLIC_ENV gates constant-fold every dev section to
 * `false`), the `<aside>` is omitted entirely. Production never ships empty
 * accordion chrome.
 *
 * Positioning (ABH-88): the reset-view control in MapDetailPageClient sits at
 * `top-3 right-3 z-20` with an `h-8` row, so its bottom edge is
 * 0.75rem + 2rem = 2.75rem (~44px) below the canvas top. This `<aside>`
 * uses `top-14` (3.5rem ≈ 56px) to sit ~12px below that bottom edge in the
 * shared positioning context, eliminating the visual overlap that surfaced
 * after ABH-65 landed (test-ralph rejection of ABH-68, 2026-05-10). The
 * `max-h` clamp reserves the new top offset (3.5rem) plus a 0.75rem bottom
 * buffer so the panel still respects the canvas at small viewport heights.
 */
export function ViewerAccordion({ children }: ViewerAccordionProps) {
  // `Children.toArray` already strips `null`, `undefined`, and `boolean`
  // entries (e.g. the `false` produced by a `Hud && <Section>` short-circuit
  // in production), so an empty result means "no real children to render" —
  // bail out before emitting any `<aside>` chrome.
  if (Children.toArray(children).length === 0) return null;
  return (
    <aside
      data-testid="viewer-accordion"
      aria-label="3D Viewer Controls"
      className="absolute top-14 right-3 z-10 w-72 max-h-[calc(100%-4.25rem)] overflow-y-auto rounded-lg border border-border bg-background/90 backdrop-blur-sm shadow-md"
    >
      {children}
    </aside>
  );
}
