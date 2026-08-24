"use client";

import type { ReactNode } from "react";

import type { CatalogId } from "@simforge/asset-catalog";

/**
 * Shared drawing vocabulary for the vehicle catalog artwork.
 *
 * Every vehicle is a right-facing side elevation in a 96×48 viewBox. The
 * numbers below are the contract each model draws against, so thirty-six
 * separately authored vehicles still line up as one fleet: same ground line,
 * same wheel centre, same glazing tone, same lamp colours.
 *
 *   x = 0 … 96        rear of the vehicle at low x, nose at high x
 *   y = 0 … 48        roof around y = 4…14, ground at y = 41
 *   wheel centre      y = 37, radius 5…6 for cars, 5.5…6.5 for heavy trucks
 *   body colour       `currentColor`, tinted by the catalog's class colour
 *
 * A model may leave the roof band (y < 4) for light bars and exhaust stacks,
 * and may cross y = 41 only with its shadow.
 *
 * The tile renders this at roughly 50×32 CSS pixels, so detail has to survive a
 * 2× downscale: shapes carry the read, hairlines below 0.6 units do not.
 */

/** Ground line every wheel rests on. */
export const GROUND = 41;
/** Wheel centre line. */
export const AXLE = 37;

export const PALETTE = {
  /** Deepened body tone for sills, wheel arches and shaded panels. */
  bodyShade: "#0f1620",
  glass: "#1b2b3f",
  glassLit: "#33526f",
  tire: "#0f1318",
  tireWall: "#1b2129",
  rim: "#93a1b2",
  rimShade: "#5f6c7c",
  line: "#b9d6ff",
  seam: "#6c9bd3",
  chrome: "#c9d6e6",
  lamp: "#f7e4a2",
  tail: "#fa796f",
  beaconBlue: "#4d8ff7",
  beaconRed: "#ff5a55",
  amber: "#ffbe4d",
  shadow: "#03060b",
} as const;

/**
 * Gradient ids are fixed rather than per-instance: every definition below is
 * byte-identical, so when several icons mount at once the browser resolves all
 * references to the first one and the result is the same picture. Namespaced
 * with `va-` so nothing else in the editor collides.
 */
export const FILL = {
  gloss: "url(#va-gloss)",
  glass: "url(#va-glass)",
  metal: "url(#va-metal)",
  shadow: "url(#va-shadow)",
} as const;

function ArtDefs() {
  return (
    <defs>
      {/* Body gloss: sky reflection on the upper panels, ground bounce below. */}
      <linearGradient id="va-gloss" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#fff" stopOpacity=".22" />
        <stop offset=".45" stopColor="#fff" stopOpacity=".04" />
        <stop offset=".72" stopColor="#000" stopOpacity=".12" />
        <stop offset="1" stopColor="#000" stopOpacity=".34" />
      </linearGradient>
      <linearGradient id="va-glass" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={PALETTE.glassLit} />
        <stop offset=".55" stopColor={PALETTE.glass} />
        <stop offset="1" stopColor="#0d1622" />
      </linearGradient>
      <linearGradient id="va-metal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={PALETTE.chrome} />
        <stop offset=".5" stopColor={PALETTE.rim} />
        <stop offset="1" stopColor={PALETTE.rimShade} />
      </linearGradient>
      <radialGradient id="va-shadow" cx=".5" cy=".5" r=".5">
        <stop offset="0" stopColor={PALETTE.shadow} stopOpacity=".55" />
        <stop offset="1" stopColor={PALETTE.shadow} stopOpacity="0" />
      </radialGradient>
    </defs>
  );
}

/**
 * Frame for one catalog drawing — vehicle, animal, robot, person or prop.
 * Keeps the test-visible identity attributes and the shared gradient defs in
 * one place so no model can forget either.
 */
export function VehicleSvg({
  id,
  children,
}: {
  id: CatalogId;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 96 48"
      width="100%"
      height="100%"
      fill="none"
      role="img"
      aria-label={`${id.slice(id.indexOf(".") + 1).replaceAll("_", " ")} model`}
      data-vehicle-icon={id}
      data-catalog-icon={id}
      style={{ display: "block", overflow: "visible" }}
    >
      <ArtDefs />
      {children}
    </svg>
  );
}

/** Contact shadow. Draw it first, under the wheels. */
export function Ground({ x = 10, width = 76 }: { x?: number; width?: number }) {
  return (
    <ellipse
      cx={x + width / 2}
      cy={GROUND + 1.5}
      rx={width / 2}
      ry="3.2"
      fill={FILL.shadow}
    />
  );
}

/**
 * One road wheel: tire, sidewall, five-spoke rim, hub. `spokes={false}` for the
 * small caster wheels where spokes would turn to mush at tile size.
 */
export function Wheel({
  cx,
  cy = AXLE,
  r = 5.4,
  spokes = true,
}: {
  cx: number;
  cy?: number;
  r?: number;
  spokes?: boolean;
}) {
  const rim = r * 0.56;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={PALETTE.tire} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={PALETTE.tireWall} strokeWidth={r * 0.28} />
      <circle cx={cx} cy={cy} r={rim} fill={FILL.metal} />
      {spokes ? (
        <g stroke={PALETTE.rimShade} strokeWidth={rim * 0.24} strokeLinecap="round">
          {[0, 72, 144, 216, 288].map((angle) => {
            const radians = (angle * Math.PI) / 180;
            return (
              <line
                key={angle}
                x1={cx}
                y1={cy}
                x2={cx + Math.cos(radians) * rim * 0.82}
                y2={cy + Math.sin(radians) * rim * 0.82}
              />
            );
          })}
        </g>
      ) : null}
      <circle cx={cx} cy={cy} r={rim * 0.3} fill={PALETTE.chrome} />
    </g>
  );
}

/** Twin wheels of a heavy axle, drawn as one offset pair. */
export function DualWheel({ cx, r = 5.8 }: { cx: number; r?: number }) {
  return (
    <g>
      <Wheel cx={cx - r * 0.55} r={r} spokes={false} />
      <Wheel cx={cx + r * 0.55} r={r} />
    </g>
  );
}

/** Wheel arch cut over a wheel, for bodies that sit low over their tires. */
export function Arch({ cx, r = 7.4 }: { cx: number; r?: number }) {
  return (
    <path
      d={`M${cx - r} ${AXLE} a${r} ${r} 0 0 1 ${r * 2} 0`}
      fill="none"
      stroke={PALETTE.bodyShade}
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  );
}

/** Glazing. Pass the outline of the glass area; the gloss comes for free. */
export function Glass({ d, opacity = 1 }: { d: string; opacity?: number }) {
  return (
    <>
      <path d={d} fill={FILL.glass} opacity={opacity} />
      <path d={d} fill="none" stroke={PALETTE.seam} strokeWidth=".7" opacity=".7" />
    </>
  );
}

/** Forward lamp cluster; `rear` adds the tail lamp at the same time. */
export function Lamps({
  front,
  frontY = 27,
  rear,
  rearY = 26,
  size = 3.2,
}: {
  front?: number;
  frontY?: number;
  rear?: number;
  rearY?: number;
  size?: number;
}) {
  return (
    <>
      {front === undefined ? null : (
        <g>
          <rect x={front} y={frontY} width={size} height={size * 1.5} rx={size * 0.4} fill={PALETTE.lamp} />
          <rect x={front} y={frontY} width={size} height={size * 0.5} rx={size * 0.25} fill="#fffdf2" opacity=".85" />
        </g>
      )}
      {rear === undefined ? null : (
        <rect x={rear} y={rearY} width={size * 0.9} height={size * 1.7} rx={size * 0.4} fill={PALETTE.tail} />
      )}
    </>
  );
}

/** Emergency light bar. Two-tone by default, single colour when `solid` is set. */
export function LightBar({
  x,
  y = 3,
  width = 20,
  height = 4.6,
  solid,
}: {
  x: number;
  y?: number;
  width?: number;
  height?: number;
  solid?: string;
}) {
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={height * 0.45} fill={solid ?? PALETTE.beaconBlue} />
      {solid ? null : (
        <rect x={x} y={y} width={width / 2} height={height} rx={height * 0.45} fill={PALETTE.beaconRed} />
      )}
      <rect x={x + 1} y={y + 0.6} width={width - 2} height={height * 0.3} rx={height * 0.2} fill="#fff" opacity=".5" />
    </g>
  );
}

/** Panel seam, door cut, or body crease. */
export function Seam({ d, width = 0.8, opacity = 0.75 }: { d: string; width?: number; opacity?: number }) {
  return <path d={d} stroke={PALETTE.seam} strokeWidth={width} opacity={opacity} strokeLinecap="round" />;
}

/** Louvred vent or radiator grille block. */
export function Grille({
  x,
  y,
  width,
  height,
  bars = 3,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  bars?: number;
}) {
  const step = height / (bars + 1);
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx="1" fill={PALETTE.bodyShade} />
      {Array.from({ length: bars }, (_, index) => (
        <line
          key={index}
          x1={x + 0.6}
          y1={y + step * (index + 1)}
          x2={x + width - 0.6}
          y2={y + step * (index + 1)}
          stroke={PALETTE.rimShade}
          strokeWidth=".6"
        />
      ))}
    </g>
  );
}

/**
 * Body shell: the silhouette in `currentColor`, its gloss, and its outline.
 * Every vehicle starts here so the fleet shares one lighting model.
 */
export function Body({ d, outline = 1.1 }: { d: string; outline?: number }) {
  return (
    <>
      <path d={d} fill="currentColor" />
      <path d={d} fill={FILL.gloss} />
      <path d={d} fill="none" stroke={PALETTE.line} strokeWidth={outline} strokeLinejoin="round" />
    </>
  );
}
