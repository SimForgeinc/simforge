"use client";

import { cn } from "./cn";

/** Aspect ratio of the built-in CARLA wordmark viewBox (64 × 20). */
const CARLA_WORDMARK_ASPECT = 64 / 20;

/**
 * The CARLA wordmark, used as the single visual signal that an actor has a
 * measured CARLA blueprint. One definition so the timeline, the add-actor
 * panel, and anything added later cannot drift apart on asset path or sizing.
 *
 * The SimCloud original renders a hosted PNG through `next/image`; the portable
 * package draws the same inverted wordmark inline so no product asset is
 * required. A consumer can still point `src` at its own square mark.
 */
export function CarlaReadyMark({
  className,
  size = 14,
  src,
  testId,
  title,
}: {
  className?: string;
  size?: number;
  /** Serve the product's own CARLA mark instead of the built-in wordmark. */
  src?: string;
  testId?: string;
  title?: string;
}) {
  if (src) {
    return (
      <img
        alt=""
        aria-hidden="true"
        className={cn("ueui-carla-mark", className)}
        data-testid={testId}
        height={size}
        src={src}
        title={title}
        width={size}
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      className={cn("ueui-carla-mark", className)}
      data-testid={testId}
      fill="currentColor"
      height={size}
      viewBox="0 0 64 20"
      width={size * CARLA_WORDMARK_ASPECT}
    >
      {title ? <title>{title}</title> : null}
      <text
        fontFamily="system-ui, sans-serif"
        fontSize="16"
        fontWeight="700"
        letterSpacing="1"
        x="0"
        y="15"
      >
        CARLA
      </text>
    </svg>
  );
}
