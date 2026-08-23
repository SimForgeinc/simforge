/**
 * Per-actor color resolution shared by the 2D map and the 3D city viewer.
 *
 * Why a shared helper: the 2D actor markers (`RuntimeActorLayers`) and the
 * 3D actor trajectories (`actor-trajectory`/`scenario-trajectories`) used to
 * derive color independently, with both falling back to a single accent for
 * unauthored actors. In diagnostic flows (auto-scenario builder output),
 * every traffic actor came out the same orange/cyan, which made multi-NPC
 * collisions impossible to read.
 *
 * Contract: every distinct `actorId` deterministically maps to a distinct
 * hex color, and the SAME id resolves to the SAME color in both views — so
 * a vehicle that's "the magenta one" on the map is also magenta in 3D.
 */

const SUBJECT_COLOR_HEX = "#f2c94c"; // existing subject-yellow
const PROP_COLOR_HEX = "#8b8b8b";
const STATIC_COLOR_HEX = "#4a4a4a";

/**
 * Hue wedges to skip when assigning a per-actor hue, so traffic colors stay
 * visually distinct from:
 *   - subject (yellow, around 50°) — the AV under test, conventionally yellow
 *   - the collision-point red X (around 0°)
 * Each wedge is `[centerDeg, halfWidthDeg]`.
 */
const RESERVED_HUE_WEDGES: Array<[number, number]> = [
  [0, 18], // red — collision marker
  [50, 14], // yellow — subject
];

function isInReservedWedge(hueDeg: number): boolean {
  for (const [center, halfWidth] of RESERVED_HUE_WEDGES) {
    // Smallest circular distance between two hues — clamp the absolute
    // difference back across the 360° wraparound (e.g. 345° is 15° from
    // 0°, not 345°).
    let d = Math.abs(hueDeg - center) % 360;
    if (d > 180) d = 360 - d;
    if (d <= halfWidth) return true;
  }
  return false;
}

/**
 * Stable djb2-style string hash. Same value across all platforms; only the
 * `& 0xffffffff` mask matters for cross-runtime parity (V8 vs JSC vs Hermes).
 */
function djb2(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (((h << 5) + h) ^ input.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

/**
 * Hash `actorId` to a hue degree in [0, 360), skipping the reserved wedges.
 * Visited via a small linear probe so two ids that hash to the same wedge
 * land on different shoulders rather than colliding.
 */
function hueForActorId(actorId: string): number {
  const base = djb2(actorId) % 360;
  for (let step = 0; step < 24; step++) {
    const candidate = (base + step * 15) % 360;
    if (!isInReservedWedge(candidate)) return candidate;
  }
  // Every wedge would have to cover the circle — guaranteed not the case
  // with the current `RESERVED_HUE_WEDGES`, but keep a safe fallback.
  return base;
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) {
    r = c;
    g = x;
  } else if (hp >= 1 && hp < 2) {
    r = x;
    g = c;
  } else if (hp >= 2 && hp < 3) {
    g = c;
    b = x;
  } else if (hp >= 3 && hp < 4) {
    g = x;
    b = c;
  } else if (hp >= 4 && hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/**
 * Parse the draft's `r,g,b` CSV color string into a hex string. Returns
 * null when absent or malformed so the caller can fall through to the
 * derived color.
 */
function parseAuthoredRgb(color: string | null | undefined): string | null {
  if (!color || !color.trim()) return null;
  const parts = color.split(",").map((s) => Number(s.trim()));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [r, g, b] = parts;
  return `#${[r, g, b]
    .map((n) =>
      Math.max(0, Math.min(255, Math.round(n!))).toString(16).padStart(2, "0"),
    )
    .join("")}`;
}

export interface DeriveActorColorInput {
  /** Stable actor id — the hash input for the deterministic per-actor color. */
  actorId: string;
  /** Actor kind. Props stay neutral gray; walkers + vehicles get hashed hues. */
  kind: "vehicle" | "walker" | "prop";
  /** Actor role. Subject keeps its conventional yellow regardless of id. */
  role: "subject" | "traffic" | "pedestrian" | "prop" | string;
  /** Static actors (e.g. parked vehicles) stay dark gray. */
  isStatic: boolean;
  /** Optional authored draft color (`"r,g,b"`). Wins over the derived color
   *  when present and well-formed. */
  authoredColor?: string | null;
}

/**
 * Resolve an actor's display color to a `#rrggbb` hex string.
 *
 * Order of precedence:
 *   1. `authoredColor` (the draft's explicit `r,g,b` value), when present.
 *   2. Role-specific defaults that carry diagnostic meaning — subject yellow,
 *      prop / static gray. These wedges are intentionally NOT hashed-into
 *      so the eye can always pick the subject out at a glance.
 *   3. A deterministic hue derived from `actorId`, skipping the red and
 *      yellow wedges so traffic actors stay distinct from subject + the
 *      collision-point red X marker.
 *
 * Same actorId → same hex, every time, on every platform.
 */
export function deriveActorColor(input: DeriveActorColorInput): string {
  const authored = parseAuthoredRgb(input.authoredColor);
  if (authored) return authored;
  if (input.kind === "prop" || input.role === "prop") return PROP_COLOR_HEX;
  if (input.role === "subject") return SUBJECT_COLOR_HEX;
  if (input.isStatic) return STATIC_COLOR_HEX;
  const hue = hueForActorId(input.actorId);
  // Walkers a touch lighter so they read as separate from vehicles at small
  // marker sizes; same hash → same hue → same actor.
  const lightness = input.kind === "walker" ? 0.62 : 0.55;
  return hslToHex(hue, 0.7, lightness);
}

/**
 * Color reserved for the AI-validated collision-point marker. Exported so
 * the rendering layers (2D MapLibre and 3D Three.js) reference one source
 * of truth and the `RESERVED_HUE_WEDGES` red wedge above stays in sync
 * with what's actually drawn on screen.
 */
export const COLLISION_MARKER_COLOR_HEX = "#ef4444";

// Re-exports for callers that need the canonical role-specific defaults.
export const SUBJECT_ACTOR_COLOR_HEX = SUBJECT_COLOR_HEX;
export const PROP_ACTOR_COLOR_HEX = PROP_COLOR_HEX;
export const STATIC_ACTOR_COLOR_HEX = STATIC_COLOR_HEX;
