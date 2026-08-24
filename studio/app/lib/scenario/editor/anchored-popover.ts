"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The one anchoring implementation behind every floating editor card.
 *
 * Extracted from `FloatingDetailPanel`'s actor popover so the clip card and the
 * actor card cannot drift: they share this flip rule, this clamp, this pointer
 * placement and this fast path. The two real differences between them — a fixed
 * height versus a content height, and what a clipped anchor means — are options
 * rather than forks, because they are differences in kind, not accidents.
 *
 * Position is written IMPERATIVELY to `panel.style` inside the rAF. That is the
 * load-bearing detail: it is why a card tracks a panning map at 60 fps without
 * re-rendering a 1600-line panel body. React state only changes when the side
 * flips; everything else settles on an 80 ms debounce.
 */

export type AnchoredPopoverSide = "above" | "below" | "right";

export type AnchoredPopoverPlacement = {
  left: number;
  maxHeight: number;
  pointerLeft: number;
  /** Only meaningful for `side: "right"`, where the tail is on the left edge. */
  pointerTop: number;
  side: AnchoredPopoverSide;
  top: number;
  width: number;
};

/** The subset of a `DOMRect` the geometry actually reads. */
export type AnchoredPopoverRect = {
  bottom: number;
  left: number;
  top: number;
  width: number;
  /** Only read by the sideways placement, which needs the anchor's mid-height. */
  height?: number;
};

/** Viewport inset kept clear on every side. */
export const ANCHORED_POPOVER_MARGIN = 16;
/** Gap between the anchor and the card, sized for the 20 px pointer square. */
export const ANCHORED_POPOVER_POINTER_GAP = 18;
/** Half the pointer square plus its border — the tail's clamp inset. */
const POINTER_INSET = 28;
/** A card shorter than this is useless, so it overflows the margin instead. */
const ABSOLUTE_MIN_HEIGHT = 180;
/** How often to look again for an anchor that was not in the DOM yet. */
const ANCHOR_RETRY_MS = 120;

export type AnchoredPopoverGeometryInput = {
  anchor: AnchoredPopoverRect;
  viewport: { height: number; width: number };
  /** Ideal width; narrowed only when the viewport cannot hold it. */
  preferredWidth: number;
  /** Ceiling on the card's height regardless of available space. */
  maxPreferredHeight: number;
  /** Below this much room above, the card flips down instead. */
  minimumUsefulHeight: number;
  /** The height the card will actually occupy, before the `maxHeight` cap. */
  panelHeight: number;
  /**
   * Viewport y the card must stay above — the top of the bottom dock.
   *
   * Without it the card is placed against its ANCHOR, and a clip's anchor is a
   * segment inside the dock, so "above the clip" still meant on top of the
   * dock's own header, ruler and neighbouring lanes. The card covered the
   * controls the author was using to drive it. `null` when nothing obstructs.
   */
  keepClearBelow?: number | null;
  /**
   * A region to place the card INSIDE, hugging its left edge — the map stage.
   *
   * Set for cards whose anchor lives in the left sidebar. Placing such a card
   * above or below its anchor keeps it in the sidebar's own column, on top of
   * the lanes it was opened from; this puts it over the map instead, in a
   * stable column beside the panel rather than a position that moves with
   * whichever clip was clicked.
   *
   * It is a region and not just an x because the map does not start at the top
   * of the viewport — the toolbar sits above it, and a card centred on a clip
   * near the top of the timeline would otherwise cover the buttons. `null` for
   * map-anchored cards, which are already over the map.
   */
  placeWithin?: { left: number; top: number; bottom: number } | null;
  margin?: number;
  pointerGap?: number;
};

/**
 * Pure placement math, split out so it is testable: jsdom reports zero for
 * every `getBoundingClientRect`, so the only way to assert anchoring is to feed
 * synthetic rects to this function.
 *
 * The side rule prefers "above" and only flips down when there is neither
 * enough room above nor more room above than below. Both callers want that
 * bias — the dock is bottom-anchored, and a map marker usually sits below the
 * card that describes it — so it is the rule rather than an option.
 */
export function computeAnchoredPopoverPlacement({
  anchor,
  viewport,
  preferredWidth,
  maxPreferredHeight,
  minimumUsefulHeight,
  panelHeight,
  keepClearBelow = null,
  placeWithin = null,
  margin = ANCHORED_POPOVER_MARGIN,
  pointerGap = ANCHORED_POPOVER_POINTER_GAP,
}: AnchoredPopoverGeometryInput): AnchoredPopoverPlacement {
  const width = Math.min(preferredWidth, viewport.width - margin * 2);

  /**
   * Inside the map, hugging its left edge — not above the clip.
   *
   * The column is fixed to the region's edge rather than the anchor's, so the
   * card lands in the same place for every clip instead of sliding along the
   * track. Vertically it centres on the anchor, which is what keeps the tail
   * pointing at the clip that opened it, then clamps into the region so it
   * cannot ride up over the toolbar.
   */
  if (placeWithin) {
    const left = Math.max(
      margin,
      Math.min(placeWithin.left + pointerGap, viewport.width - width - margin),
    );
    const regionHeight = Math.max(0, placeWithin.bottom - placeWithin.top);
    const maxHeight = Math.max(
      Math.min(ABSOLUTE_MIN_HEIGHT, viewport.height - margin * 2),
      Math.min(maxPreferredHeight, regionHeight - margin * 2),
    );
    const occupiedHeight = Math.min(panelHeight, maxHeight);
    const anchorMiddle = anchor.top + (anchor.height ?? 0) / 2;
    // A card taller than the region it is placed in would invert this clamp, so
    // the floor wins: better to overflow the bottom than to be pushed up under
    // the toolbar.
    const top = Math.max(
      placeWithin.top + margin,
      Math.min(
        anchorMiddle - occupiedHeight / 2,
        placeWithin.bottom - occupiedHeight - margin,
      ),
    );
    return {
      left,
      maxHeight,
      // The tail is on the left edge, so it is `pointerTop` that tracks the
      // anchor; `pointerLeft` just pins it to that edge.
      pointerLeft: 0,
      pointerTop: Math.max(
        POINTER_INSET,
        Math.min(anchorMiddle - top, occupiedHeight - POINTER_INSET),
      ),
      side: "right",
      top,
      width,
    };
  }
  /**
   * A card placed "above" stops at the higher of its anchor and the obstruction
   * — which for a clip is always the obstruction, since the anchor is inside it.
   * A map marker sits above the dock already, so the min() is a no-op there and
   * both cards go on obeying one rule.
   */
  const ceilingForAbove =
    keepClearBelow == null ? anchor.top : Math.min(anchor.top, keepClearBelow);
  const availableAbove = ceilingForAbove - margin - pointerGap;
  const availableBelow = viewport.height - anchor.bottom - margin - pointerGap;
  const side: AnchoredPopoverSide =
    availableAbove >= minimumUsefulHeight || availableAbove >= availableBelow
      ? "above"
      : "below";
  const availableHeight = side === "above" ? availableAbove : availableBelow;
  const maxHeight = Math.max(
    Math.min(ABSOLUTE_MIN_HEIGHT, viewport.height - margin * 2),
    Math.min(maxPreferredHeight, availableHeight),
  );
  const occupiedHeight = Math.min(panelHeight, maxHeight);
  const anchorCenter = anchor.left + anchor.width / 2;
  const left = Math.max(
    margin,
    Math.min(anchorCenter - width / 2, viewport.width - width - margin),
  );

  return {
    left,
    maxHeight,
    // Re-clamped after the horizontal clamp so the tail still points at the
    // anchor when the card is pinned to a viewport edge.
    pointerLeft: Math.max(
      POINTER_INSET,
      Math.min(anchorCenter - left, width - POINTER_INSET),
    ),
    pointerTop: 0,
    side,
    top:
      side === "above"
        ? ceilingForAbove - pointerGap - occupiedHeight
        : anchor.bottom + pointerGap,
    width,
  };
}

export type AnchoredPopoverOptions = {
  /** CSS selector for the anchor node, or `null` when nothing is anchored. */
  anchorSelector: string | null;
  panelRef: RefObject<HTMLElement | null>;
  pointerRef: RefObject<HTMLElement | null>;
  preferredWidth: number;
  maxPreferredHeight: number;
  minimumUsefulHeight: number;
  /**
   * `fixed` pins the card to `fixedHeight` (a tabbed body must not jump on
   * every tab switch); `content` lets it size itself and caps it at
   * `maxPreferredHeight` with internal scroll.
   */
  heightMode: "fixed" | "content";
  fixedHeight?: number;
  /**
   * What a vanished or scrolled-away anchor means. `hide` fades the card out —
   * right for a world object that legitimately leaves the viewport. `pin`
   * freezes the card where it is and drops only the tail — right for a form,
   * which holds focus and half-typed values that a fade would discard.
   */
  onClippedAnchor: "hide" | "pin";
  /** Scroll viewport that can clip the anchor without unmounting it. */
  clipContainerSelector?: string;
  /**
   * An element the card must never cover — the bottom dock. Measured every
   * update, so the card re-places itself when the dock is expanded, collapsed
   * or resized rather than being sized once against a stale height.
   */
  keepClearSelector?: string;
  /**
   * An element whose box the card should sit INSIDE, hugging its left edge,
   * rather than above or below its anchor — the map stage, for cards whose
   * anchor is in the left sidebar. Measured every update, so the card follows
   * the sidebar's resize handle.
   */
  placeWithinSelector?: string;
  observe?: {
    /** Watch the anchor's own style/class churn (map marker transforms). */
    mutations?: boolean;
    /** Watch the anchor and the panel for size changes. */
    resize?: boolean;
  };
};

export type AnchoredPopoverState = {
  placement: AnchoredPopoverPlacement | null;
  /** False while the anchor is gone; the tail hides and `hide` fades the card. */
  anchorVisible: boolean;
};

export function useAnchoredPopoverPosition({
  anchorSelector,
  panelRef,
  pointerRef,
  preferredWidth,
  maxPreferredHeight,
  minimumUsefulHeight,
  heightMode,
  fixedHeight = 300,
  onClippedAnchor,
  clipContainerSelector,
  keepClearSelector,
  placeWithinSelector,
  observe,
}: AnchoredPopoverOptions): AnchoredPopoverState {
  const placementRef = useRef<AnchoredPopoverPlacement | null>(null);
  const [placement, setPlacement] = useState<AnchoredPopoverPlacement | null>(
    null,
  );
  const [anchorVisible, setAnchorVisible] = useState(false);

  const observeMutations = observe?.mutations ?? false;
  const observeResize = observe?.resize ?? false;

  useEffect(() => {
    if (!anchorSelector) {
      placementRef.current = null;
      setPlacement(null);
      setAnchorVisible(false);
      return;
    }

    let frame = 0;
    let settleTimer = 0;
    let retryTimer = 0;
    let mutationObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const anchorEl = document.querySelector(
          anchorSelector,
        ) as HTMLElement | null;
        if (!anchorEl) {
          setAnchorVisible(false);
          if (onClippedAnchor === "hide") {
            placementRef.current = null;
            setPlacement(null);
          }
          // Both observers below hang off the anchor, so a first pass that
          // misses it — a segment painted a frame late, a marker still
          // mounting — would never be retried and the card would sit at its
          // fallback position forever. Poll until it shows up; the listener is
          // torn down the moment it does.
          window.clearTimeout(retryTimer);
          retryTimer = window.setTimeout(update, ANCHOR_RETRY_MS);
          return;
        }
        window.clearTimeout(retryTimer);

        const anchorRect = anchorEl.getBoundingClientRect();
        // Scrolled out of the lane list: the clip has not moved, it is just no
        // longer painted. Freeze rather than chase it off-screen.
        if (clipContainerSelector) {
          const viewportEl = document.querySelector(clipContainerSelector);
          const viewportRect = viewportEl?.getBoundingClientRect();
          if (
            viewportRect &&
            viewportRect.height > 0 &&
            (anchorRect.bottom <= viewportRect.top ||
              anchorRect.top >= viewportRect.bottom)
          ) {
            setAnchorVisible(false);
            if (onClippedAnchor === "hide") {
              placementRef.current = null;
              setPlacement(null);
            }
            return;
          }
        }

        const panel = panelRef.current;
        const measuredHeight =
          heightMode === "content" && panel
            ? panel.getBoundingClientRect().height || fixedHeight
            : fixedHeight;

        const keepClearRect = keepClearSelector
          ? document.querySelector(keepClearSelector)?.getBoundingClientRect()
          : undefined;

        const withinRect = placeWithinSelector
          ? document
              .querySelector(placeWithinSelector)
              ?.getBoundingClientRect()
          : undefined;

        const next = computeAnchoredPopoverPlacement({
          anchor: anchorRect,
          viewport: {
            height: window.innerHeight,
            width: window.innerWidth,
          },
          preferredWidth,
          maxPreferredHeight,
          minimumUsefulHeight,
          panelHeight: measuredHeight,
          // A zero-height rect is a dock mid-mount, not a dock at the top of
          // the screen — clamping to it would pin every card into the margin.
          keepClearBelow:
            keepClearRect && keepClearRect.height > 0
              ? keepClearRect.top
              : null,
          // Same zero-rect guard as above: a map stage mid-mount measures 0×0,
          // and hugging its left edge would put the card back over the sidebar.
          placeWithin:
            withinRect && withinRect.width > 0 && withinRect.height > 0
              ? {
                  left: withinRect.left,
                  top: withinRect.top,
                  bottom: withinRect.bottom,
                }
              : null,
        });

        if (panel) {
          panel.style.bottom = "auto";
          panel.style.height =
            heightMode === "fixed"
              ? `${Math.min(fixedHeight, next.maxHeight)}px`
              : "auto";
          panel.style.left = "0";
          panel.style.maxHeight = `${next.maxHeight}px`;
          panel.style.top = "0";
          panel.style.translate = `${next.left}px ${next.top}px`;
          panel.style.transformOrigin =
            next.side === "right"
              ? `left ${next.pointerTop}px`
              : `${next.pointerLeft}px ${
                  next.side === "above" ? "bottom" : "top"
                }`;
          panel.style.width = `${next.width}px`;
        }

        const pointer = pointerRef.current;
        if (pointer) {
          if (next.side === "right") {
            // On the card's LEFT edge, pointing back at the clip, so it is the
            // vertical offset that tracks the anchor.
            pointer.style.left = "-11px";
            pointer.style.top = `${next.pointerTop - 10}px`;
            pointer.style.bottom = "auto";
            pointer.style.borderBottom = "2px solid #E8E044";
            pointer.style.borderLeft = "2px solid #E8E044";
            pointer.style.borderRight = "0";
            pointer.style.borderTop = "0";
          } else {
            pointer.style.left = `${next.pointerLeft - 10}px`;
            if (next.side === "above") {
              pointer.style.bottom = "-11px";
              pointer.style.top = "auto";
              pointer.style.borderBottom = "2px solid #E8E044";
              pointer.style.borderRight = "2px solid #E8E044";
              pointer.style.borderLeft = "0";
              pointer.style.borderTop = "0";
            } else {
              pointer.style.bottom = "auto";
              pointer.style.top = "-11px";
              pointer.style.borderBottom = "0";
              pointer.style.borderRight = "0";
              pointer.style.borderLeft = "2px solid #E8E044";
              pointer.style.borderTop = "2px solid #E8E044";
            }
          }
        }

        setAnchorVisible(true);
        const previous = placementRef.current;
        placementRef.current = next;
        if (!previous || previous.side !== next.side) {
          setPlacement(next);
        } else {
          window.clearTimeout(settleTimer);
          settleTimer = window.setTimeout(() => {
            setPlacement(placementRef.current);
          }, 80);
        }

        if (observeMutations && !mutationObserver) {
          // A map marker's transform lives on the maplibre wrapper; a timeline
          // segment is its own style carrier, so `closest` degrades to itself.
          const target = anchorEl.closest(".maplibregl-marker") ?? anchorEl;
          mutationObserver = new MutationObserver(update);
          mutationObserver.observe(target, {
            attributeFilter: ["style", "class"],
            attributes: true,
          });
        }
        if (
          observeResize &&
          !resizeObserver &&
          typeof ResizeObserver !== "undefined"
        ) {
          resizeObserver = new ResizeObserver(update);
          // The anchor catches drag-resize and container reflow; the panel
          // catches a content-height change (a 4-row clip becoming 14 rows).
          resizeObserver.observe(anchorEl);
          if (panel) resizeObserver.observe(panel);
        }
      });
    };

    update();
    window.addEventListener("resize", update);
    // Capture phase: scroll does not bubble, and the anchor can live inside the
    // dock's own lane list as easily as inside the page.
    window.addEventListener("scroll", update, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(settleTimer);
      window.clearTimeout(retryTimer);
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [
    anchorSelector,
    clipContainerSelector,
    fixedHeight,
    heightMode,
    keepClearSelector,
    maxPreferredHeight,
    minimumUsefulHeight,
    observeMutations,
    observeResize,
    onClippedAnchor,
    panelRef,
    pointerRef,
    placeWithinSelector,
    preferredWidth,
  ]);

  return { anchorVisible, placement };
}
