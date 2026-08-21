"use client";

import {
  Arch,
  Body,
  Glass,
  Grille,
  Ground,
  PALETTE,
  Seam,
  VehicleSvg,
  Wheel,
} from "./parts";

/**
 * Seven recognisable road cars, drawn to their real proportions so the
 * silhouette alone identifies the model at tile size:
 *
 *   Civic      compact fastback saloon, long roof taper into a short deck
 *   Camry      mid-size three-box saloon, upright cabin, long flat deck
 *   Model 3    cab-forward, one continuous glass arc, grille-less nose
 *   Mustang    long hood / short deck, fastback roof, tri-bar tail lamps
 *   Corvette   mid-engine wedge, cabin forward, huge rear haunch, side intake
 *   911        round-shouldered rear-engine fastback, ducktail, tail light bar
 *   Wrangler   flat vertical screen, boxy sides, square flares, spare on tailgate
 *
 * Geometry contract lives in ./parts: right-facing side elevation in a 96×48
 * box, ground at y = 41, wheel centres at y = 37, body in `currentColor`.
 *
 * Wheelbases and overhangs are scaled off the real cars (roughly 18 units per
 * metre), which is what keeps the Civic from turning into the Camry.
 */

/**
 * Swept headlamp. Road cars wear lamps far wider than they are tall, so these
 * are drawn per model rather than taken from the fleet's upright `Lamps` block;
 * the lens and highlight colours stay the shared ones.
 */
function WedgeLamp({ d, edge }: { d: string; edge?: string }) {
  return (
    <g>
      <path d={d} fill={PALETTE.lamp} />
      {edge ? (
        <path d={edge} fill="none" stroke="#fffdf2" strokeWidth=".9" opacity=".8" strokeLinecap="round" />
      ) : null}
    </g>
  );
}

/** Round headlamp: chrome rim, lens, highlight. The 911 and Wrangler wear these. */
function RoundLamp({ cx, cy, r = 2.4 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={PALETTE.chrome} />
      <circle cx={cx} cy={cy} r={r - 0.7} fill={PALETTE.lamp} />
      <circle cx={cx - r * 0.25} cy={cy - r * 0.3} r={r * 0.32} fill="#fffdf2" opacity=".9" />
    </g>
  );
}

/** Tail lamp block. `radius` carries the difference between a wing and a slab. */
function TailLamp({
  x,
  y,
  width,
  height,
  radius = 0.7,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}) {
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={radius} fill={PALETTE.tail} />
      <rect x={x} y={y} width={width} height={height * 0.3} rx={radius * 0.7} fill="#ffd0c4" opacity=".65" />
    </g>
  );
}

/** Door mirror on the A-pillar, stalk included. */
function Mirror({ x, y, size = 2.6 }: { x: number; y: number; size?: number }) {
  return (
    <g>
      <path d={`M${x} ${y} l${size * 0.5} -0.4`} stroke={PALETTE.bodyShade} strokeWidth=".9" strokeLinecap="round" />
      <path
        d={`M${x - size} ${y - 0.8} h${size} a${size * 0.45} ${size * 0.45} 0 0 1 0 1.8 h${-size} z`}
        fill={PALETTE.bodyShade}
        stroke={PALETTE.line}
        strokeWidth=".5"
      />
    </g>
  );
}

/** Door pull. `flush` draws the Model 3's near-invisible slot instead. */
function Handle({ x, y, width = 3.2, flush }: { x: number; y: number; width?: number; flush?: boolean }) {
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={flush ? 0.85 : 1.25}
      rx={flush ? 0.42 : 0.6}
      fill={PALETTE.chrome}
      opacity={flush ? 0.55 : 0.85}
    />
  );
}

/** Shaded rocker/underbody slab. Drawn before the shell so it reads as a sill. */
function Underbody({ d, opacity = 0.95 }: { d: string; opacity?: number }) {
  return <path d={d} fill={PALETTE.bodyShade} opacity={opacity} />;
}

/** Cooling intake or scoop: shaded mouth with a lit leading lip. */
function Intake({ d, lip }: { d: string; lip?: string }) {
  return (
    <g>
      <path d={d} fill={PALETTE.bodyShade} opacity=".9" />
      {lip ? <path d={lip} fill="none" stroke={PALETTE.chrome} strokeWidth=".7" opacity=".5" /> : null}
    </g>
  );
}

/** Twin tailpipe tips. */
function Exhaust({ x, y, gap = 4 }: { x: number; y: number; gap?: number }) {
  return (
    <g fill={PALETTE.bodyShade}>
      <rect x={x} y={y} width={3.2} height={1.5} rx={0.7} />
      <rect x={x + gap} y={y - 0.1} width={3.2} height={1.5} rx={0.7} />
    </g>
  );
}

/* ------------------------------------------------------------------ Civic */

export function HondaCivic() {
  const shell =
    "M9.4 33.2 C8.1 30.6 8.4 27.8 10.2 26.2 L15 25 " +
    "C22 20.8 30 15.2 39 13 C46 11.4 54 11.4 60.4 12.7 " +
    "C64.4 13.8 66.4 16.4 68.4 19.6 L74 20.7 " +
    "C80.6 21.2 86 23.2 89.6 26.8 C91 28.3 91 30.4 90.1 32.2 " +
    "L84.4 33.8 L16.4 34.4 Z";
  return (
    <VehicleSvg id="vehicle.honda_civic">
      <Ground x={11} width={74} />
      <Underbody d="M14.6 32.4 L85.4 31.8 L86 35.4 L15 35.8 Z" />
      <Body d={shell} />
      {/* raked screen, two door lights split by a B-pillar, beltline kicked up
          at the C-pillar, and the fastback's long rear-screen sliver */}
      <Glass d="M67.6 19.8 L61.2 13.8 L57.6 14 L64 20.3 Z" />
      <Glass d="M56.4 14.1 L47.4 14.6 L48.2 20.8 L62.8 20.5 Z" />
      <Glass d="M46 14.8 L37.2 16.2 C34 18.3 31.4 20 29.6 20.4 L46.9 20.9 Z" />
      <Glass d="M34.4 16.9 C30.2 19.6 26 22.3 22.5 24.3 L20 24.7 C24 21.8 28.8 18.3 32.2 15.9 Z" opacity={0.85} />
      <Seam d="M47.1 21 L47.5 33.9" />
      <Seam d="M29.6 20.8 L30.2 34.2" />
      <Seam d="M63.5 20.7 L64.2 33.6" />
      <Seam d="M13.6 27.6 C38 26.9 62 27.2 87 27.9" width={0.7} opacity={0.6} />
      <Underbody d="M17 31.8 C40 31.4 62 31.4 84 31.6 L84.4 33.4 L17.4 34 Z" opacity={0.7} />
      <Arch cx={24} r={6.9} />
      <Arch cx={73.4} r={6.9} />
      <Handle x={43} y={22} />
      <Handle x={56.6} y={21.9} />
      <Mirror x={67} y={20.4} size={2.4} />
      {/* slim swept lamp over a wide lower intake, wing-shaped tail lamp */}
      <WedgeLamp d="M83.6 24.4 L89.4 26.6 L88.8 28.4 L83 26.8 Z" edge="M83.8 24.7 L89.2 26.9" />
      <Grille x={84.6} y={29.4} width={5.4} height={2.6} bars={2} />
      <Seam d="M78.4 23.6 C82.6 24.2 86 25.4 88.6 27.2" width={0.65} opacity={0.5} />
      <TailLamp x={9.4} y={26.8} width={5.6} height={2} radius={0.9} />
      <TailLamp x={9.5} y={28.4} width={1.9} height={2.6} radius={0.8} />
      <rect x={12.6} y={32.4} width={3.4} height={1.5} rx={0.7} fill={PALETTE.bodyShade} />
      <Wheel cx={24} r={5.2} />
      <Wheel cx={73.4} r={5.2} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ Camry */

export function ToyotaCamry() {
  const shell =
    "M8.4 32.8 C7.2 30.2 7.6 27.4 9.6 26 L12.4 25.2 L22.4 23.2 " +
    "C27.6 19.2 32.2 14.4 38.4 12.2 C46 10.2 56 10.2 62.4 11.6 " +
    "C66.2 12.5 67.8 15.7 69.6 19.2 L75 20.4 " +
    "C81.6 21 87 22.8 90.4 26 C91.7 27.4 91.7 30 90.8 31.8 " +
    "L85 33.6 L15 34.6 Z";
  return (
    <VehicleSvg id="vehicle.toyota_camry">
      <Ground x={10} width={77} />
      <Underbody d="M13.4 32.6 L86 31.8 L86.6 35.6 L13.8 36 Z" />
      <Body d={shell} />
      {/* three-box saloon: tall upright glazing, near-flat roof, notched deck */}
      <Glass d="M68.8 19.4 L62.9 11.9 L59.4 12 L65.2 19.8 Z" />
      <Glass d="M58.2 12.1 L48.2 12.4 L48.8 20.3 L64 20.1 Z" />
      <Glass d="M46.8 12.5 L38.8 13.3 L35.4 20.5 L45.6 20.4 Z" />
      <Glass d="M37.2 13.9 C33.6 16.4 30 19.2 27.2 21.4 L24.6 22 C28.4 19 32.4 15.6 35.2 13 Z" opacity={0.85} />
      {/* chrome window surround and deck strip: the Camry's own signature */}
      <path
        d="M64.2 20.1 L48.2 20.3 L48.2 12.3 L59.4 12 L62.9 11.9"
        fill="none"
        stroke={PALETTE.chrome}
        strokeWidth=".6"
        opacity=".6"
      />
      <path d="M12 25.4 L21.8 23.7" stroke={PALETTE.chrome} strokeWidth=".7" opacity=".55" />
      <Seam d="M47.9 20.5 L48.4 34.2" />
      <Seam d="M35.4 20.7 L35.8 34.4" />
      <Seam d="M64.4 20.3 L65 33.8" />
      <Seam d="M11.6 26.6 C38 25.6 64 26.2 89 27.2" width={0.7} opacity={0.55} />
      <Seam d="M15.6 30.6 C40 30 64 30 86 30.4" width={0.7} opacity={0.45} />
      <Underbody d="M16 32 C42 31.6 66 31.6 85.4 31.8 L85.8 33.4 L16.4 34.2 Z" opacity={0.7} />
      <Arch cx={23.5} r={7} />
      <Arch cx={74} r={7} />
      <Handle x={43.4} y={21.7} />
      <Handle x={57.4} y={21.5} />
      <Mirror x={68.4} y={20} size={2.4} />
      {/* deep upright grille under a slim lamp; wrapped tail lamp on the corner */}
      <Grille x={86} y={24.8} width={4.2} height={3.8} bars={3} />
      <Grille x={84.4} y={29.8} width={5.6} height={2.6} bars={2} />
      <WedgeLamp d="M82.4 22.6 L88.2 24.2 L87.6 26.4 L81.8 25.2 Z" edge="M82.6 22.9 L88 24.5" />
      <TailLamp x={8.2} y={26.9} width={3.4} height={3.2} radius={1} />
      <Exhaust x={12.2} y={32.6} />
      <Wheel cx={23.5} r={5.3} />
      <Wheel cx={74} r={5.3} />
    </VehicleSvg>
  );
}

/* --------------------------------------------------------------- Model 3 */

export function TeslaModel3() {
  const shell =
    "M10 32.6 C8.8 30 9.2 27.2 11.2 25.8 L15.6 24.4 " +
    "C24 19.6 33 14.2 42.4 12 C50.4 10.4 58 10.7 64.4 12.3 " +
    "C69.2 13.7 72 16.3 74.2 19.3 L79 20.4 " +
    "C84 21.4 88 23.6 90.6 26.6 C91.7 28 91.6 30.2 90.6 31.8 " +
    "L85 33.4 L16.6 34.2 Z";
  /** One glass arc from cowl to deck: the Model 3's whole identity. */
  const canopy =
    "M74 19.6 C71.2 15.8 68 13.3 64.2 12.5 C57.2 11.2 49.8 11.5 42.6 13.1 " +
    "C34.4 15.3 26.6 19.7 21.4 23.5 L24.4 23.6 " +
    "C30 21.5 35 20.9 41 20.7 C50 20.4 60 20.3 68.6 20.1 Z";
  return (
    <VehicleSvg id="vehicle.tesla_model_3">
      <Ground x={11} width={75} />
      <Underbody d="M15 32.4 L86 31.6 L86.6 35.4 L15.4 35.8 Z" />
      <Body d={shell} />
      <Glass d={canopy} />
      {/* pillars drawn over the arc rather than breaking it */}
      <Seam d="M73.6 19.6 C71 16.2 68.2 13.9 65 12.8" width={1.1} opacity={0.8} />
      <Seam d="M49 11.5 L49.2 20.4" width={1} opacity={0.7} />
      <Seam d="M36.6 14.4 C34.8 17 33.6 19 32.6 20.8" width={1} opacity={0.7} />
      <Seam d="M48.9 20.6 L49.4 33.9" />
      <Seam d="M32.6 21 L33 34.1" />
      <Seam d="M69 20.3 L69.6 33.5" />
      <Seam d="M12.8 27.8 C38 27.2 64 27.4 88.6 28" width={0.7} opacity={0.5} />
      <Underbody d="M17.4 31.6 C42 31.2 66 31.2 85 31.4 L85.4 33.2 L17.8 33.9 Z" opacity={0.7} />
      <Arch cx={23} r={7} />
      <Arch cx={75} r={7} />
      <Handle x={41.6} y={22} flush />
      <Handle x={57} y={21.8} flush />
      <Mirror x={72.6} y={20.4} size={2.4} />
      {/* charge port on the rear quarter */}
      <circle cx={17.6} cy={28.4} r={1.7} fill={PALETTE.bodyShade} />
      <circle cx={17.6} cy={28.4} r={1.7} fill="none" stroke={PALETTE.chrome} strokeWidth=".55" opacity=".8" />
      <circle cx={17.6} cy={28.4} r={0.6} fill={PALETTE.chrome} opacity=".7" />
      {/* grille-less nose: one cooling slot low in the bumper, nothing above it */}
      <rect x={85.4} y={30.4} width={4.8} height={1.5} rx={0.7} fill={PALETTE.bodyShade} />
      <Seam d="M78.6 22.6 C83 23.4 86.8 25 89.4 27" width={0.65} opacity={0.5} />
      <WedgeLamp d="M83.4 24.2 L89.6 26.4 L89 28.2 L82.9 26.4 Z" edge="M83.6 24.5 L89.4 26.7" />
      <TailLamp x={10.2} y={26.6} width={3.2} height={2.8} radius={1} />
      <path d="M13.4 27.4 C15.4 27.6 16.8 27.7 18.4 27.6" stroke={PALETTE.tail} strokeWidth=".8" opacity=".7" />
      <Wheel cx={23} r={5.3} />
      <Wheel cx={75} r={5.3} />
    </VehicleSvg>
  );
}

/* -------------------------------------------------------------- Mustang */

export function FordMustang() {
  const shell =
    "M9.4 32.6 C8.3 30 8.3 26.6 10.2 24.4 L13.6 22.8 L17.6 23.6 " +
    "C23.8 19.8 28.6 15.4 34.4 13.3 C40 11.7 46 11.6 50.8 12.5 " +
    "C54.1 13.3 55.7 15.7 57.4 18.7 L62.4 19.7 " +
    "C70.4 20.1 79.8 21.1 87 23.5 C89.8 24.5 91 26.3 90.8 28.5 " +
    "L90.2 32 L84.6 33.6 L16 34.4 Z";
  return (
    <VehicleSvg id="vehicle.ford_mustang">
      <Ground x={11} width={75} />
      <Underbody d="M14.6 32.2 L85.4 31.4 L86 35.4 L15 35.8 Z" />
      <Body d={shell} />
      {/* coupe glazing: hard-raked screen, one long door light, quarter light */}
      <Glass d="M61.8 19.3 L51.6 13 L48.2 13.2 L57.8 19.7 Z" />
      <Glass d="M47 13.4 L38.8 14.6 L40 20.1 L56.8 19.8 Z" />
      <Glass d="M37.6 14.9 C34.4 17 31.4 19.1 29 20.5 L38 20.2 Z" opacity={0.85} />
      <Seam d="M39.8 20.3 L40.2 34.2" />
      <Seam d="M57.1 20 L57.8 33.8" />
      {/* long-hood cues: twin power-dome creases and the quarter scoop */}
      <Seam d="M63.8 21.5 C71.8 21.9 79.4 22.7 86 24.7" width={0.75} opacity={0.6} />
      <Seam d="M64.4 24.1 C72.4 24.5 79.8 25.3 85.6 26.9" width={0.7} opacity={0.4} />
      <Intake d="M27.4 26.8 L34.2 26 L35 28.6 L28 29.4 Z" lip="M27.4 26.8 L34.2 26" />
      <Seam d="M13.2 27.8 C38 27 63 27.4 88 28.4" width={0.7} opacity={0.5} />
      <Underbody d="M17 31.6 C42 31.2 66 31 84.6 31.2 L85 33.2 L17.4 34 Z" opacity={0.7} />
      <Arch cx={22.8} r={7.6} />
      <Arch cx={73.6} r={7.6} />
      <Handle x={51.8} y={21.5} />
      <Mirror x={61.2} y={20} size={2.4} />
      {/* wide slim lamp beside a deep grille; tri-bar tail lamps; quad pipes */}
      <WedgeLamp d="M81.6 23.4 L87.6 25 L87 27.4 L81 25.8 Z" edge="M81.8 23.7 L87.4 25.3" />
      <Grille x={86.6} y={25.6} width={3.8} height={4.8} bars={3} />
      <TailLamp x={9.4} y={25} width={1.3} height={4.2} radius={0.5} />
      <TailLamp x={11.1} y={24.7} width={1.3} height={4.2} radius={0.5} />
      <TailLamp x={12.8} y={24.4} width={1.3} height={4.2} radius={0.5} />
      <Exhaust x={14.6} y={32.4} gap={4.4} />
      <Wheel cx={22.8} r={5.9} />
      <Wheel cx={73.6} r={5.9} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------- Corvette */

export function ChevroletCorvette() {
  const shell =
    "M8.6 30.4 C7.2 28 7.6 24.2 9.8 22.6 L14.6 21.2 L18.6 22.4 " +
    "C25 22 30.6 21.2 35.6 19.8 C43 17.4 50.6 15.4 57.4 14.9 " +
    "C61 14.6 64.2 15.1 66.6 16.4 C69.4 18.8 71.6 21.8 73.6 24.4 L78.6 25.2 " +
    "C81.6 24.4 84.4 24.6 86.6 26 C89.2 27.6 90.6 30 90.2 32.6 " +
    "L89.4 34.6 L15.4 35.2 Z";
  return (
    <VehicleSvg id="vehicle.chevrolet_corvette">
      <Ground x={10} width={77} />
      <Underbody d="M14 33 L85 32.6 L85.6 36 L14.4 36.2 Z" />
      <Body d={shell} />
      {/* cabin pushed forward: hard-raked screen, wedge door light, solid buttress */}
      <Glass d="M73 24 L66.2 17 L62.4 15.7 L67.8 23.4 Z" />
      <Glass d="M61 15.8 L53.4 17.6 L55.8 22.6 L66 22.7 Z" />
      <path
        d="M52 17.8 C48.6 18.7 45.2 19.5 41.6 20.2 L47.8 21 C49.8 20.1 51.2 19.1 52 17.8 Z"
        fill={PALETTE.bodyShade}
        opacity=".45"
      />
      <Intake d="M45.6 18.6 L48.4 18 L49 19.6 L46.2 20.2 Z" />
      <Seam d="M55.6 22.7 L56.2 34.7" />
      <Seam d="M66.2 22.8 L67.2 34.5" />
      {/* mid-engine cues: rear-deck louvres, side intake into the engine bay,
          and a haunch crease that stands over the rear wheel */}
      <g transform="rotate(-12 24.7 23.6)">
        <Grille x={21.4} y={22.4} width={6.6} height={2.4} bars={2} />
      </g>
      <Intake d="M37.4 25.6 L45.8 24.7 L46.8 27.8 L38.2 28.8 Z" lip="M37.4 25.6 L45.8 24.7" />
      <Seam d="M31.4 22.8 C26.6 24.6 22.8 27.2 20.6 30.2" width={0.9} opacity={0.65} />
      <Seam d="M12.6 27.2 C36 26.4 62 27.4 87.4 30" width={0.7} opacity={0.5} />
      <Underbody d="M17 32 C42 31.4 66 31.6 83.6 32.6 L84 34.4 L17.4 34.8 Z" opacity={0.75} />
      <Arch cx={26} r={7.8} />
      <Arch cx={75.2} r={7.4} />
      <Handle x={59} y={23.7} width={2.8} />
      <Mirror x={72.6} y={24.4} size={2.4} />
      {/* low swept lamp, splitter, four tail lamps, centre exhaust */}
      <WedgeLamp d="M82 26.8 L88.4 28.6 L87.8 30.4 L81.4 28.6 Z" edge="M82.2 27.1 L88.2 28.9" />
      <rect x={82.6} y={32.6} width={7} height={1.7} rx={0.7} fill={PALETTE.bodyShade} />
      <TailLamp x={8.6} y={23.4} width={2.2} height={2.2} radius={0.6} />
      <TailLamp x={11.4} y={23} width={2.2} height={2.2} radius={0.6} />
      <TailLamp x={8.8} y={26.4} width={2.2} height={2.2} radius={0.6} />
      <TailLamp x={11.6} y={26.2} width={2.2} height={2.2} radius={0.6} />
      <rect x={14.8} y={31.2} width={3.8} height={1.8} rx={0.8} fill={PALETTE.bodyShade} />
      <Wheel cx={26} r={5.9} />
      <Wheel cx={75.2} r={5.5} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------- 911 */

export function Porsche911() {
  const shell =
    "M11.6 30.2 C10.2 28.6 10 26 11 24.4 C11.9 23.1 13.8 22.3 16.2 22.1 L20.4 23.4 " +
    "C26.6 21.6 33.6 18.4 40.2 15.6 C45.6 13.6 49.4 12.8 53 12.9 " +
    "C57 13.2 60.4 15.6 63.4 19.4 L68.6 21.4 " +
    "C73.4 20.8 78 20.4 81.6 21.4 C85.8 22.7 88.8 25.4 89.6 28.6 " +
    "C90 30.6 88.8 32.2 86.8 32.9 L16 33.6 Z";
  return (
    <VehicleSvg id="vehicle.porsche_911">
      <Ground x={12} width={73} />
      <Underbody d="M15 31.4 L85 30.6 L85.6 34.4 L15.4 34.8 Z" />
      <Body d={shell} />
      {/* short rounded cabin, then one unbroken slope over the engine to the tail */}
      <Glass d="M63 19.5 L57.2 13.6 L54 13.7 L60 19.8 Z" />
      <Glass d="M53 13.9 L45 15.5 L43 20.9 L59.2 20.2 Z" />
      <Glass d="M44.2 15.8 C42.2 16.6 40.6 17.4 39.2 18.2 L42 21 Z" opacity={0.85} />
      <Glass
        d="M24.5 22.3 C29 20.2 34.4 17.6 39.5 15.9 L40.6 17.9 C35.4 19.6 30.2 22.2 25.8 24.3 Z"
        opacity={0.8}
      />
      <Seam d="M42.8 21.1 L43.4 33.4" />
      <Seam d="M59.6 20.4 L60.4 33.2" />
      {/* ducktail lip, engine-lid louvres lying along the slope, dipped front lid */}
      <Seam d="M11.4 24.6 C12.6 23.2 14.2 22.4 16.3 22.3" width={1.1} opacity={0.9} />
      <g transform="rotate(-17 23 25.2)">
        <Grille x={19.6} y={24} width={7} height={2.4} bars={2} />
      </g>
      <Seam d="M68.8 22.8 C73.6 22.4 77.8 22.2 81.4 22.8" width={0.8} opacity={0.65} />
      <Seam d="M14 27 C38 26 62 26.6 87 28.4" width={0.7} opacity={0.5} />
      <Underbody d="M18 30.6 C42 30 66 30 84.4 30.6 L84.8 32.4 L18.4 33.2 Z" opacity={0.7} />
      {/* rear haunch stands proud of the tail taper */}
      <path d="M33.2 19.4 C29 21.6 26.4 25 25.8 28.6 L31.4 27.8 C31.4 24.4 32 21.6 33.2 19.4 Z" fill={PALETTE.bodyShade} opacity=".3" />
      <Arch cx={26} r={7.6} />
      <Arch cx={73} r={7.2} />
      <Handle x={47.4} y={22.4} width={2.8} />
      <Mirror x={62.6} y={20.4} size={2.4} />
      {/* round lamp high on the wing crest; full-width tail bar low on the tail */}
      <RoundLamp cx={84.8} cy={24.2} r={2.4} />
      <Grille x={85.4} y={29.2} width={4} height={2.4} bars={2} />
      <rect x={11.4} y={26.6} width={8.8} height={2} rx={0.9} fill={PALETTE.tail} />
      <rect x={11.4} y={26.6} width={8.8} height={0.7} rx={0.35} fill="#ffd0c4" opacity=".7" />
      <Exhaust x={13.6} y={30.2} gap={3.6} />
      <Wheel cx={26} r={5.6} />
      <Wheel cx={73} r={5.4} />
    </VehicleSvg>
  );
}

/* -------------------------------------------------------------- Wrangler */

export function JeepWrangler() {
  const shell =
    "M22.6 30.6 L22.2 11.2 L23.4 7.4 L62.4 7 L63.6 19.6 L85 19 " +
    "L86.4 25.8 L87 28.2 L84 30.2 L24.6 31.6 Z";
  return (
    <VehicleSvg id="vehicle.jeep_wrangler">
      <Ground x={14} width={71} />
      {/* live axle slung under the body: the ground clearance is the point */}
      <rect x={34} y={36.3} width={40} height={1.1} rx={0.5} fill={PALETTE.tireWall} />
      <Underbody d="M22.6 29.6 L85.4 27.8 L85.8 31.2 L23.2 32.8 Z" />
      <Body d={shell} />
      {/* the flat screen is seen edge-on as a sliver; door glass stays square */}
      <Glass d="M63.2 18.8 L62.2 8.6 L59.8 8.6 L60.8 18.8 Z" />
      <Glass d="M58.6 8.6 L45 8.8 L45.4 18.8 L59.6 18.7 Z" />
      <Glass d="M43.4 8.8 L27.6 9 L27.8 19 L43.8 18.9 Z" />
      {/* hardtop joint, removable roof panel seam, exposed door hinges */}
      <Seam d="M23.6 9.4 L62.8 9" width={0.8} opacity={0.6} />
      <Seam d="M44.4 7.2 L44.6 9.2" width={0.8} opacity={0.7} />
      <Seam d="M44.3 8.9 L44.7 31.2" />
      <Seam d="M27.2 9 L27.6 31.4" />
      <Seam d="M59.8 8.6 L60.4 30.8" />
      <rect x={59.6} y={10.6} width={1.8} height={1.6} rx={0.5} fill={PALETTE.chrome} opacity=".8" />
      <rect x={59.8} y={15.8} width={1.8} height={1.6} rx={0.5} fill={PALETTE.chrome} opacity=".8" />
      <rect x={62.4} y={19.4} width={2.2} height={1.4} rx={0.5} fill={PALETTE.chrome} opacity=".7" />
      <Handle x={47} y={20.8} />
      <Handle x={30} y={21} />
      <Mirror x={62.6} y={12.8} size={2.8} />
      <Seam d="M24.6 24.2 L84.8 22.4" width={0.7} opacity={0.5} />
      {/* square fender flares instead of the fleet's round arch */}
      <path
        d="M28 32.2 L28.6 27.6 L40.6 27.4 L41.4 31.9"
        fill="none"
        stroke={PALETTE.bodyShade}
        strokeWidth="1.6"
        strokeLinejoin="round"
        opacity=".85"
      />
      <path
        d="M67.2 31 L67.8 27 L79.4 26.6 L80.2 30.4"
        fill="none"
        stroke={PALETTE.bodyShade}
        strokeWidth="1.6"
        strokeLinejoin="round"
        opacity=".85"
      />
      {/* rock rail on two brackets rather than a slab rocker */}
      <rect x={43} y={31.4} width={22} height={1} rx={0.5} fill={PALETTE.bodyShade} opacity=".8" />
      <rect x={45.4} y={30.5} width={1.2} height={1.6} fill={PALETTE.bodyShade} opacity=".7" />
      <rect x={61.4} y={30.4} width={1.2} height={1.6} fill={PALETTE.bodyShade} opacity=".7" />
      {/* slotted grille, round headlamp, steel bumper */}
      <rect x={84.4} y={19.2} width={2.6} height={6.4} rx={0.5} fill={PALETTE.bodyShade} />
      <g stroke={PALETTE.rimShade} strokeWidth=".6">
        <line x1={85} y1={20} x2={85} y2={25} />
        <line x1={85.8} y1={20} x2={85.8} y2={25} />
        <line x1={86.6} y1={20} x2={86.6} y2={25} />
      </g>
      <RoundLamp cx={82.6} cy={22} r={2.6} />
      <rect x={81.6} y={26.8} width={6} height={2.4} rx={0.8} fill={PALETTE.tireWall} />
      <TailLamp x={23.6} y={13.8} width={2.4} height={3.4} radius={0.5} />
      {/* hood latches at the fender joint */}
      <rect x={65.6} y={20.2} width={2} height={1} rx={0.4} fill={PALETTE.chrome} opacity=".65" />
      {/* full-size spare centred on the swing gate, carrier arm and all */}
      <rect x={22} y={23.2} width={4.4} height={1.6} rx={0.7} fill={PALETTE.bodyShade} />
      <circle cx={21.6} cy={24} r={6.1} fill={PALETTE.bodyShade} />
      <Wheel cx={21.6} cy={24} r={5.6} />
      <Wheel cx={34.6} r={6} />
      <Wheel cx={74} r={6} />
    </VehicleSvg>
  );
}
