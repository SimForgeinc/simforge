/**
 * Tones and geometry helpers shared by the street, occluder, hazard and
 * site-leftover drawings. Structure stays `currentColor` so the panel can tint
 * it; these are the cases where the tone *is* the identity — soil, foliage,
 * rust, cardboard, awning canvas — plus the two path builders every one of
 * those families needs.
 */

/** Identity tones. Everything structural stays `currentColor`. */
export const SOIL = "#6f5334";
export const SOIL_LIT = "#93714a";
export const STONE = "#8d949c";
export const RUST = "#8d4526";
export const TIMBER = "#7a5636";
export const TIMBER_LIT = "#a37a4b";
export const LEAF = "#4a7442";
export const LEAF_LIT = "#719f58";
export const LEAF_DEEP = "#2c4a2a";
export const CARD = "#a8794a";
export const CARD_LIT = "#c89e6c";
export const CARD_DEEP = "#6d4c2d";
export const AWNING = "#c4483c";
export const AWNING_LIT = "#e0705f";
export const STRAP = "#3b4452";

/** Eye level. Every receding edge in this file converges on it. */
export const HORIZON = 27;

/** A straight strut of width `w` as a filled quad — posts are solids, not strokes. */
export function tube(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (w / 2);
  const ny = (dx / len) * (w / 2);
  return (
    `M${(x1 + nx).toFixed(2)} ${(y1 + ny).toFixed(2)} L${(x2 + nx).toFixed(2)} ${(y2 + ny).toFixed(2)} ` +
    `L${(x2 - nx).toFixed(2)} ${(y2 - ny).toFixed(2)} L${(x1 - nx).toFixed(2)} ${(y1 - ny).toFixed(2)} Z`
  );
}

/** A pointed leaf blade centred on (cx,cy) with its tip along `deg`. */
export function leaf(cx: number, cy: number, len: number, deg: number): string {
  const a = (deg * Math.PI) / 180;
  const ux = Math.cos(a) * len * 0.5;
  const uy = Math.sin(a) * len * 0.5;
  const vx = -Math.sin(a) * len * 0.34;
  const vy = Math.cos(a) * len * 0.34;
  return (
    `M${(cx - ux).toFixed(1)} ${(cy - uy).toFixed(1)} ` +
    `Q${(cx + vx).toFixed(1)} ${(cy + vy).toFixed(1)} ${(cx + ux).toFixed(1)} ${(cy + uy).toFixed(1)} ` +
    `Q${(cx - vx).toFixed(1)} ${(cy - vy).toFixed(1)} ${(cx - ux).toFixed(1)} ${(cy - uy).toFixed(1)} Z`
  );
}

