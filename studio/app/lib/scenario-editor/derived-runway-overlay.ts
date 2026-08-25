import type { MapAsset } from "@simforge/studio-shared";
import { runtimePointToLngLat } from "@/app/lib/editor-map/coordinates";

/**
 * The faint continuation of the lane: where a placed car will actually go.
 *
 * ## Why this has to be drawn
 *
 * The one-motion model deletes route anchors, and anchors were at least visible.
 * "Place it and it drives" without a drawing is a promise the author has to take
 * on faith, and the first time the derivation stops early — a junction whose
 * movements the compiler could not verify, a lane that leaves the map — an
 * undrawn runway is indistinguishable from a working one
 * (`plans/2026-07-29-one-motion-model.md` §2.6).
 *
 * ## Why it looks the way it does
 *
 * Dashed and dim, under everything authored. It is not content: nobody clicked
 * it, nothing about the draft changes if the map is recooked and it moves. A
 * runway drawn as boldly as an authored path would invite exactly the mistake
 * this model removes — treating it as something to adjust point by point.
 *
 * The END is marked, and carries WHY it ended. A runway that stops after 20 m is
 * a fact about the map and the author needs to be able to tell "the road ends
 * here" from "the junction ahead is unverified", which is the difference between
 * nothing to fix and a map to republish.
 */

export type DerivedRunwayAnchorPoint = {
  x: number;
  y: number;
  yaw?: number;
};

export type DerivedRunwayOverlayInput = {
  actorId: string;
  anchors: readonly DerivedRunwayAnchorPoint[];
  travelledM: number;
  /** From `DerivedRunwayStopReason`; drives the end-cap label. */
  stopReason: string;
  /** Indices of authored turns the walk never reached a junction for. */
  unmetTurns?: readonly number[];
  /** Actor tint, so the runway reads as belonging to its car. */
  color?: string | null;
};

export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "LineString" | "Point"; coordinates: unknown };
    properties: Record<string, unknown>;
  }>;
};

const DEFAULT_COLOR = "#E8E044";

/** What the end cap says. Absent from the map when the runway ran its budget. */
const STOP_LABELS: Record<string, string> = {
  budget_reached: "",
  no_continuation: "road ends here",
  junction_unbound: "junction ahead is unverified",
  cycle_guard: "loops back here",
  unplaced: "not on a road",
};

export function stopReasonLabel(stopReason: string): string {
  return STOP_LABELS[stopReason] ?? "";
}

/**
 * GeoJSON for one actor's derived runway, or `null` when there is nothing to
 * draw.
 *
 * `null` rather than an empty collection for a single-anchor runway: one point is
 * not a line, and rendering it as a zero-length dash draws a mark at the car that
 * reads as a route rather than as the absence of one.
 */
export function buildDerivedRunwayOverlay(
  input: DerivedRunwayOverlayInput,
  mapAsset: MapAsset | null | undefined,
): GeoJsonFeatureCollection | null {
  if (!mapAsset || input.anchors.length < 2) return null;
  const coordinates: Array<[number, number]> = [];
  for (const anchor of input.anchors) {
    const projected = runtimePointToLngLat({ x: anchor.x, y: anchor.y }, mapAsset);
    if (projected) coordinates.push(projected);
  }
  if (coordinates.length < 2) return null;
  const color = input.color ?? DEFAULT_COLOR;
  const label = stopReasonLabel(input.stopReason);
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "LineString", coordinates },
        properties: {
          kind: "derived-runway",
          actorId: input.actorId,
          color,
          travelledM: input.travelledM,
          stopReason: input.stopReason,
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: coordinates[coordinates.length - 1]! },
        properties: {
          kind: "derived-runway-end",
          actorId: input.actorId,
          color,
          stopReason: input.stopReason,
          label,
          // An unmet turn is the one case where the author DID ask for something
          // the runway could not deliver, so it is flagged separately from a
          // runway that merely ran out of road.
          unmetTurnCount: input.unmetTurns?.length ?? 0,
        },
      },
    ],
  };
}
