import { CarlaReadyMark } from "@/app/components/CarlaReadyMark";
import {
  CARLA_COMPATIBILITY_LABEL,
  type CarlaCompatibility,
} from "@/app/lib/scenario/carla-compatibility";
import { cn } from "@/app/lib/utils";

const UNAVAILABLE_DOT_CLASS: Record<
  Exclude<CarlaCompatibility["status"], "native">,
  string
> = {
  "generated-pack": "bg-amber-300",
  "browser-only": "bg-slate-400",
};

/**
 * Per-actor CARLA readiness marker in the timeline identity column.
 *
 * CARLA-ready actors show the CARLA logo; this is the only CARLA-ready
 * indication in the editor, so the details panel deliberately shows none.
 * Actors that cannot render in CARLA keep a muted status dot.
 */
export function TimelineCarlaCompatibilityMarker({
  actorLabel,
  compatibility,
}: {
  actorLabel: string;
  compatibility: CarlaCompatibility;
}) {
  const label = CARLA_COMPATIBILITY_LABEL[compatibility.status];
  const detail = compatibility.status === "native"
    ? compatibility.blueprintId
    : compatibility.reason;
  return (
    <span
      aria-label={`${actorLabel}: ${label}`}
      className="pointer-events-none inline-flex size-3.5 shrink-0 items-center justify-center"
      data-carla-compatibility={compatibility.status}
      role="img"
      title={`${label}: ${detail}`}
    >
      {compatibility.status === "native" ? (
        <CarlaReadyMark className="size-3.5" testId="timeline-carla-ready-logo" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full ring-1 ring-black/40",
            UNAVAILABLE_DOT_CLASS[compatibility.status],
          )}
        />
      )}
    </span>
  );
}
