"use client";

import {
  PALETTE,
} from "../vehicle-art/parts";

/**
 * Work-zone traffic control: the cones, drums, barriers, signs and trailers a
 * scenario uses to close a lane.
 *
 * These share the fleet's frame — 96×48, ground at y = 41, light from above —
 * so a cone dropped next to a sedan reads at the same scale. What they do not
 * share is the fleet's single-colour body: traffic control is *identified* by
 * its paint, so every prop is built as a `currentColor` structure with the
 * work-zone palette laid over it. The tint still carries the actor class; the
 * orange, the retroreflective white and the amber lamps carry the object.
 *
 * Rules of the road for this file:
 *
 *   - structure in `currentColor`, markings hardcoded
 *   - one silhouette per id: a drum is not a cone, a run is not a barrier
 *   - nothing crosses y = 41 but a shadow and a tire's contact patch
 */

/** Work-zone orange, warm enough to survive over a cool body tint. */
export const ORANGE = "#f07a22";
/** The shaded face of anything orange. */
export const ORANGE_DEEP = "#b3500e";
/** Retroreflective sheeting: never pure white, it would punch a hole in the tile. */
export const REFLECT = "#f1f5fa";
/** Hi-vis vest / hard hat yellow. */
export const HIVIS = "#dfe94b";
/** Sandbag ballast, laid over `currentColor` so the class tint still shows. */
export const SAND = "#9a8763";
/** Concrete weathering wash for the jersey barriers. */
export const CONCRETE = "#aab4c0";
/** Signal green. Red and amber come from the fleet palette. */
export const GREEN = "#4bd08f";
/** Stop-sign red, a shade deeper than the emergency beacon. */
export const STOP_RED = "#d2372f";

/* ------------------------------------------------------------------ */
/* Shared work-zone parts                                              */
/* ------------------------------------------------------------------ */

/** A tapered member — leg, mast, strut, arm — as a filled quad. */
export function strut(x1: number, y1: number, x2: number, y2: number, w1: number, w2 = w1): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const a = w1 / 2;
  const b = w2 / 2;
  return (
    `M${(x1 + nx * a).toFixed(2)} ${(y1 + ny * a).toFixed(2)} ` +
    `L${(x2 + nx * b).toFixed(2)} ${(y2 + ny * b).toFixed(2)} ` +
    `L${(x2 - nx * b).toFixed(2)} ${(y2 - ny * b).toFixed(2)} ` +
    `L${(x1 - nx * a).toFixed(2)} ${(y1 - ny * a).toFixed(2)} Z`
  );
}

/**
 * Striped rail: reflective ground with orange bars leaning the way traffic is
 * meant to pass, clipped so the bars stop dead at the rail ends. `slot` keeps
 * the clip ids distinct where two rails differ in size.
 */
export function StripedRail({
  x,
  y,
  width,
  height,
  slot,
  bars = 6,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  slot: string;
  bars?: number;
}) {
  const clip = `ca-stripe-${slot}`;
  const lean = height * 0.8;
  const step = (width + lean) / bars;
  const barWidth = step * 0.46;
  return (
    <g>
      <clipPath id={clip}>
        <rect x={x} y={y} width={width} height={height} rx={height * 0.2} />
      </clipPath>
      <rect x={x} y={y} width={width} height={height} rx={height * 0.2} fill="currentColor" />
      <g clipPath={`url(#${clip})`}>
        <rect x={x} y={y} width={width} height={height} fill={REFLECT} opacity=".9" />
        <g fill={ORANGE}>
          {Array.from({ length: bars }, (_, index) => {
            const left = x - lean + step * index;
            return <path key={index} d={`M${left} ${y} h${barWidth} l${-lean} ${height} h${-barWidth} Z`} />;
          })}
        </g>
        <rect x={x} y={y + height * 0.7} width={width} height={height * 0.3} fill={PALETTE.shadow} opacity=".2" />
      </g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={height * 0.2}
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".85"
      />
    </g>
  );
}

/** Ballast sandbag: a slumped bag, tinted rather than repainted. */
export function Sandbag({ x, y, width = 10, height = 4.4 }: { x: number; y: number; width?: number; height?: number }) {
  const d =
    `M${x} ${y + height} C${x - 0.7} ${y + height * 0.34} ${x + width * 0.16} ${y - 0.5} ` +
    `${x + width * 0.5} ${y + 0.2} C${x + width * 0.84} ${y - 0.4} ${x + width + 0.7} ${y + height * 0.36} ` +
    `${x + width} ${y + height} Z`;
  return (
    <g>
      <path d={d} fill="currentColor" />
      <path d={d} fill={SAND} opacity=".52" />
      <path
        d={`M${x + 1.6} ${y + height * 0.62} C${x + width * 0.5} ${y + height * 0.42} ${x + width * 0.7} ${y + height * 0.5} ${x + width - 1.4} ${y + height * 0.7}`}
        fill="none"
        stroke={PALETTE.shadow}
        strokeWidth=".7"
        opacity=".45"
      />
      <path d={d} fill="none" stroke={PALETTE.line} strokeWidth=".7" opacity=".75" />
    </g>
  );
}

/** One rider/worker limb: round-capped stroke, sunk a tone on the far side. */
export function Limb({ d, w = 3, far = false }: { d: string; w?: number; far?: boolean }) {
  return (
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      opacity={far ? 0.48 : 1}
    />
  );
}
