/**
 * The geometry behind the 2D candidate glyph (plan 2026-07-26, section 5).
 *
 * A dot says "something is here". The junction's SHAPE says "this one" — so the
 * candidate glyph draws the junction's real approach structure at its real size,
 * and the maths for that lives here rather than in the layer so it can be
 * asserted without a map.
 *
 * ## Bearings and screen space
 *
 * `approachBearingsDeg` is the direction of travel ENTERING the junction, in the
 * runtime frame (CARLA basis, +x east, +y south). The LEG a movement arrives on
 * therefore lies at `bearing + 180` — the convention `MovementDiagram` already
 * draws with (`approachLegs`, MovementDiagram.tsx:117).
 *
 * That frame maps onto SVG with no flip: +x is east is right, +y is south is
 * down. So a leg's screen offset is plainly `(cos θ, sin θ)` with θ in the same
 * degrees, and the marker is rendered with `rotationAlignment="map"` so a
 * rotated map rotates the fan with it.
 */

/** Below this the fan is a mat of overlapping spokes; the glyph collapses. */
export const CANDIDATE_DETAIL_MIN_ZOOM = 13;
/** The collapsed ring's radius, in CSS pixels. */
export const CANDIDATE_COLLAPSED_RADIUS_PX = 5;
/** In 3D the ghost heads carry the weight; the badge is only the card's anchor. */
export const CANDIDATE_BADGE_RADIUS_PX = 9;

const MIN_RING_RADIUS_PX = 18;
const MAX_RING_RADIUS_PX = 64;
/** How far a leg stub runs past the ring. */
const SPOKE_LENGTH_PX = 10;
/** Past this many pips the ring is a dotted line, so the rest become "+N". */
const MAX_PIPS = 8;

export type IntersectionCandidateGlyphInput = {
  radiusM: number;
  metersPerPixel: number;
  zoom: number;
  /** Leg bearings, degrees, in the runtime frame's ENTERING convention. */
  approachBearingsDeg: readonly number[];
  /** Head bearings from the centroid, degrees, same frame. */
  lightBearingsDeg: readonly number[];
  /** 3D mode: the fan gives way to a small badge (plan §5.1). */
  compact?: boolean;
  markerScale?: number;
};

export type GlyphPoint = { x: number; y: number };

export type IntersectionCandidateGlyph = {
  /** Side of the square SVG box, CSS pixels. */
  sizePx: number;
  /** Centre of that box — every offset below is already absolute within it. */
  center: GlyphPoint;
  ringRadiusPx: number;
  /** One stub per approach leg: from the ring outward. `[]` when collapsed. */
  spokes: Array<{ from: GlyphPoint; to: GlyphPoint }>;
  /** Head positions on the ring. `[]` when collapsed. */
  pips: GlyphPoint[];
  /** Heads beyond {@link MAX_PIPS}, for the `+N` chip. `0` when none. */
  overflowPips: number;
  /** True once the glyph has dropped its detail — no spokes, no pips. */
  collapsed: boolean;
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function pointOnCircle(
  center: GlyphPoint,
  bearingDeg: number,
  radius: number,
): GlyphPoint {
  const radians = (bearingDeg * Math.PI) / 180;
  return {
    x: center.x + Math.cos(radians) * radius,
    y: center.y + Math.sin(radians) * radius,
  };
}

/**
 * The glyph for one candidate at the current zoom.
 *
 * The ring maps the junction's REAL `radius_m` through metres-per-pixel, so a
 * big city intersection reads bigger than a small one and overlap between two
 * glyphs is proportional to overlap between two real junctions. The clamp keeps
 * it clickable when zoomed out and stops a 60 m junction from swallowing the
 * viewport when zoomed in.
 */
export function intersectionCandidateGlyph({
  radiusM,
  metersPerPixel,
  zoom,
  approachBearingsDeg,
  lightBearingsDeg,
  compact = false,
  markerScale = 1,
}: IntersectionCandidateGlyphInput): IntersectionCandidateGlyph {
  const collapsed = compact || !(zoom >= CANDIDATE_DETAIL_MIN_ZOOM);
  const scale = Number.isFinite(markerScale) && markerScale > 0 ? markerScale : 1;

  if (collapsed) {
    const ringRadiusPx =
      (compact ? CANDIDATE_BADGE_RADIUS_PX : CANDIDATE_COLLAPSED_RADIUS_PX) * scale;
    const sizePx = ringRadiusPx * 2 + 6;
    return {
      sizePx,
      center: { x: sizePx / 2, y: sizePx / 2 },
      ringRadiusPx,
      spokes: [],
      pips: [],
      overflowPips: 0,
      collapsed: true,
    };
  }

  const perPixel =
    Number.isFinite(metersPerPixel) && metersPerPixel > 0 ? metersPerPixel : 1;
  const ringRadiusPx =
    clamp(radiusM / perPixel, MIN_RING_RADIUS_PX, MAX_RING_RADIUS_PX) * scale;
  const spokeLength = SPOKE_LENGTH_PX * scale;
  const sizePx = (ringRadiusPx + spokeLength) * 2 + 4;
  const center = { x: sizePx / 2, y: sizePx / 2 };

  return {
    sizePx,
    center,
    ringRadiusPx,
    // `+ 180`: the bearing is where the traffic is HEADED, the leg is where it
    // comes FROM. Four spokes at 90° is a four-way, and it reads instantly.
    spokes: approachBearingsDeg
      .filter((bearing) => Number.isFinite(bearing))
      .map((bearing) => ({
        from: pointOnCircle(center, bearing + 180, ringRadiusPx),
        to: pointOnCircle(center, bearing + 180, ringRadiusPx + spokeLength),
      })),
    pips: lightBearingsDeg
      .filter((bearing) => Number.isFinite(bearing))
      .slice(0, MAX_PIPS)
      .map((bearing) => pointOnCircle(center, bearing, ringRadiusPx)),
    overflowPips: Math.max(0, lightBearingsDeg.length - MAX_PIPS),
    collapsed: false,
  };
}
