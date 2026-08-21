"use client";

import { CarlaReadyMark } from "../carla-ready-mark";
import {
  CARLA_COMPATIBILITY_LABEL,
  type CarlaCompatibility,
} from "../carla-compatibility";

const UNAVAILABLE_DOT_COLOR: Record<
  Exclude<CarlaCompatibility["status"], "native">,
  string
> = {
  "generated-pack": "hsl(45 97% 77%)",
  "browser-only": "hsl(215 16% 62%)",
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
      className="ueui-timeline-carla-marker"
      data-carla-compatibility={compatibility.status}
      role="img"
      title={`${label}: ${detail}`}
    >
      {compatibility.status === "native" ? (
        <CarlaReadyMark className="ueui-timeline-carla-logo" size={14} testId="timeline-carla-ready-logo" />
      ) : (
        <span
          aria-hidden="true"
          className="ueui-timeline-carla-dot"
          style={{ background: UNAVAILABLE_DOT_COLOR[compatibility.status] }}
        />
      )}
    </span>
  );
}
