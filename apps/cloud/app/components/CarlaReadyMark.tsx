import Image from "next/image";

import { cn } from "@/app/lib/utils";

/**
 * The CARLA wordmark, used as the single visual signal that an actor has a
 * measured CARLA blueprint. One definition so the timeline, the add-actor
 * panel, and anything added later cannot drift apart on asset path or sizing.
 */
export const CARLA_MARK_SRC = "/scenario-editor/carla-mark.png";

export function CarlaReadyMark({
  className,
  size = 14,
  testId,
  title,
}: {
  className?: string;
  size?: number;
  testId?: string;
  title?: string;
}) {
  return (
    <Image
      alt=""
      aria-hidden="true"
      className={cn("shrink-0 object-contain invert", className)}
      data-testid={testId}
      height={size}
      src={CARLA_MARK_SRC}
      title={title}
      unoptimized
      width={size}
    />
  );
}
