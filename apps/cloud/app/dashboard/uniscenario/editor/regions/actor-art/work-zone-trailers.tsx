"use client";

import {
  Body,
  FILL,
  Grille,
  Ground,
  PALETTE,
  Seam,
  VehicleSvg,
  Wheel,
} from "../vehicle-art/parts";
import {
  GREEN,
  REFLECT,
  STOP_RED,
  Sandbag,
  strut,
} from "./work-zone-parts";

/**
 * Towed and stood-up work-zone equipment: arrow board, portable stop sign, portable signal.
 *
 * Structure in `currentColor`, markings hardcoded: traffic control is
 * identified by its paint. Shared tones and helpers live in `work-zone-parts`.
 */

/* ------------------------------------------------------------------ */
/* Arrow board                                                         */
/* ------------------------------------------------------------------ */

const BOARD_FRAME =
  "M22.8 5 L71.4 5 A2.2 2.2 0 0 1 73.6 7.2 L73.6 25.8 " +
  "A2.2 2.2 0 0 1 71.4 28 L22.8 28 A2.2 2.2 0 0 1 20.6 25.8 " +
  "L20.6 7.2 A2.2 2.2 0 0 1 22.8 5 Z";

/** Lit lamps: shaft, both chevron arms, tip. */
const ARROW_LAMPS: readonly [number, number][] = [
  [27.4, 16.5],
  [32, 16.5],
  [36.6, 16.5],
  [41.2, 16.5],
  [45.8, 16.5],
  [50.4, 16.5],
  [52.4, 11.4],
  [56.8, 13.1],
  [61.2, 14.8],
  [52.4, 21.6],
  [56.8, 19.9],
  [61.2, 18.2],
  [65.4, 16.5],
];

/** Unlit cells, so the panel reads as a matrix rather than a painted arrow. */
const DARK_LAMPS: readonly [number, number][] = [
  [27.4, 11],
  [36.6, 11],
  [45.8, 11],
  [27.4, 22],
  [36.6, 22],
  [45.8, 22],
];

/** Towable arrow board: lamp matrix on a mast over a single-axle trailer. */
export function ArrowBoard() {
  return (
    <VehicleSvg id={"construction.arrow_board"}>
      <Ground x={18} width={70} />

      {/* Trailer frame with the tongue drawn out to the coupler. */}
      <path d="M22 32.2 L68 32.2 L86.2 33.9 L86.4 35.5 L68 36 L22 36 Z" fill="currentColor" />
      <path d="M22 34.6 L68 34.6 L86.3 34.9 L86.4 35.5 L68 36 L22 36 Z" fill={PALETTE.shadow} opacity=".3" />
      <path
        d="M22 32.2 L68 32.2 L86.2 33.9 L86.4 35.5 L68 36 L22 36 Z"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".9"
        strokeLinejoin="round"
      />
      <path d="M85.4 32.8 L89.6 33.2 L89.6 36.4 L85.4 36 Z" fill={PALETTE.rimShade} />
      <circle cx="88" cy="36.6" r="1.7" fill={PALETTE.shadow} />
      <path
        d="M80 36.4 C81.4 38.4 83.6 38.6 85.2 37"
        fill="none"
        stroke={PALETTE.rim}
        strokeWidth=".6"
        opacity=".8"
      />

      {/* Jack stand under the tongue. */}
      <path d={strut(79.4, 35.8, 79.4, 39.8, 2)} fill="currentColor" />
      <rect x="76.6" y="39.6" width="5.8" height="1.4" rx=".6" fill={PALETTE.rimShade} />
      <circle cx="79.4" cy="34.2" r="1.5" fill={PALETTE.rim} />
      <path d="M79.4 34.2 L82.4 32.8" fill="none" stroke={PALETTE.rim} strokeWidth=".9" strokeLinecap="round" />

      {/* Mast and its braces. */}
      <path d={strut(47.4, 26.6, 47.4, 33.4, 5.6)} fill="currentColor" />
      <path d={strut(47.4, 26.6, 47.4, 33.4, 5.6)} fill={FILL.gloss} opacity=".6" />
      <path d={strut(44.8, 29.6, 32.6, 32.8, 1.5)} fill="currentColor" opacity=".55" />
      <path d={strut(50, 29.6, 62.4, 32.8, 1.5)} fill="currentColor" opacity=".55" />
      <circle cx="47.4" cy="29.4" r="1.6" fill={PALETTE.rim} />
      <circle cx="47.4" cy="29.4" r=".6" fill={PALETTE.rimShade} />

      {/* Control cabinet on the frame. */}
      <rect x="24.4" y="28.6" width="7.6" height="3.8" rx=".9" fill="currentColor" />
      <rect x="24.4" y="28.6" width="7.6" height="3.8" rx=".9" fill="none" stroke={PALETTE.line} strokeWidth=".7" />
      <path d="M28.2 28.6 L28.2 32.4" fill="none" stroke={PALETTE.seam} strokeWidth=".6" opacity=".7" />

      {/* Panel: frame, dark matrix face, lamps. */}
      <Body d={BOARD_FRAME} />
      <rect x="22.6" y="7" width="49" height="19" rx="1.4" fill={PALETTE.tire} />
      <rect x="22.6" y="7" width="49" height="6" rx="1.4" fill="#fff" opacity=".05" />
      <g fill="#1b2331">
        {DARK_LAMPS.map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.1" />
        ))}
      </g>
      <g fill={PALETTE.amber} stroke="#fff6da" strokeWidth=".45" strokeOpacity=".55">
        {ARROW_LAMPS.map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.5" />
        ))}
      </g>
      <rect x="22.6" y="7" width="49" height="19" rx="1.4" fill="none" stroke={PALETTE.seam} strokeWidth=".7" opacity=".6" />

      {/* Corner beacons. */}
      <g>
        <rect x="23.4" y="3.6" width="2.6" height="2" fill={PALETTE.bodyShade} />
        <circle cx="24.7" cy="3" r="2.2" fill={PALETTE.amber} />
        <circle cx="23.9" cy="2.3" r=".8" fill="#fffdf2" opacity=".85" />
        <rect x="68.4" y="3.6" width="2.6" height="2" fill={PALETTE.bodyShade} />
        <circle cx="69.7" cy="3" r="2.2" fill={PALETTE.amber} />
        <circle cx="68.9" cy="2.3" r=".8" fill="#fffdf2" opacity=".85" />
      </g>

      {/* Road wheel and its fender, last so they sit on the frame. */}
      <path
        d="M35.6 34.2 C36.6 29.8 40.4 27.8 44 28 L44 30 C41 30 38.4 31.8 37.6 34.6 Z"
        fill="currentColor"
      />
      <Wheel cx={42} cy={36.8} r={4.2} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Temporary stop sign                                                 */
/* ------------------------------------------------------------------ */

const STOP_BLANK =
  "M56 21.5 L49 28.5 L39 28.5 L32 21.5 L32 11.5 L39 4.5 L49 4.5 L56 11.5 Z";
const STOP_FACE =
  "M54.4 20.8 L48.4 26.8 L39.6 26.8 L33.6 20.8 L33.6 12.2 L39.6 6.2 L48.4 6.2 L54.4 12.2 Z";

/** Portable stop sign: octagon on a sprung stand, sandbagged and braced. */
export function TemporaryStopSign() {
  return (
    <VehicleSvg id={"construction.temporary_stop_sign"}>
      <Ground x={24} width={48} />

      {/* Splayed stand legs: far leg sunk, near legs lit. */}
      <path d={strut(44, 36.4, 44.6, 40.6, 2.2, 3)} fill={PALETTE.bodyShade} />
      <path d={strut(43.4, 36.2, 29.8, 40.4, 2.4, 1.8)} fill="currentColor" />
      <path d={strut(44.6, 36.2, 58.4, 40.4, 2.4, 1.8)} fill="currentColor" />
      <g fill={PALETTE.rimShade}>
        <rect x="26.8" y="39.8" width="6.4" height="1.4" rx=".6" />
        <rect x="55.4" y="39.8" width="6.4" height="1.4" rx=".6" />
      </g>

      {/* Rear brace up to the back of the panel. */}
      <path d={strut(58.2, 39.4, 51.6, 24.4, 1.6, 1.2)} fill={PALETTE.bodyShade} />

      {/* Coil spring between stand and post: the "portable" part. */}
      <path
        d="M42.6 36 C46.4 35.4 41.6 34.2 45.4 33.6 C41.6 33 46.4 31.8 42.6 31.2 C46.4 30.6 41.6 29.4 45.4 28.8"
        fill="none"
        stroke={PALETTE.rim}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <rect x="41.4" y="27.4" width="5.4" height="2.2" rx=".7" fill={PALETTE.rimShade} />
      <rect x="41.4" y="35.4" width="5.4" height="2.2" rx=".7" fill={PALETTE.rimShade} />

      {/* Panel: blank, red face, reflective ring, edge rivets. */}
      <Body d={STOP_BLANK} />
      <path d={STOP_FACE} fill={STOP_RED} />
      <path d={STOP_FACE} fill={FILL.gloss} opacity=".4" />
      <path
        d="M52.8 20.2 L47.8 25.2 L40.2 25.2 L35.2 20.2 L35.2 12.8 L40.2 7.8 L47.8 7.8 L52.8 12.8 Z"
        fill="none"
        stroke={REFLECT}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <g fill={PALETTE.chrome} opacity=".8">
        <circle cx="44" cy="6" r=".8" />
        <circle cx="44" cy="27" r=".8" />
      </g>
      <path d={STOP_BLANK} fill="none" stroke={PALETTE.line} strokeWidth="1" strokeLinejoin="round" />

      <Sandbag x={25.4} y={36.8} width={10} height={4.1} />
      <Sandbag x={54.2} y={36.8} width={10} height={4.1} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Portable signal                                                     */
/* ------------------------------------------------------------------ */

const SIGNAL_HEAD =
  "M43.6 1.4 L54.2 1.4 A2.2 2.2 0 0 1 56.4 3.6 L56.4 16.8 " +
  "A2.2 2.2 0 0 1 54.2 19 L43.6 19 A2.2 2.2 0 0 1 41.4 16.8 " +
  "L41.4 3.6 A2.2 2.2 0 0 1 43.6 1.4 Z";

/** One lamp with its hood, so the three-aspect head reads at tile size. */
function SignalLamp({ cy, colour }: { cy: number; colour: string }) {
  return (
    <g>
      <circle cx="48.9" cy={cy} r="2.6" fill={colour} />
      <circle cx="48" cy={cy - 0.9} r=".9" fill="#fff" opacity=".5" />
      <circle cx="48.9" cy={cy} r="2.6" fill="none" stroke={PALETTE.shadow} strokeWidth=".7" opacity=".7" />
      <path
        d={`M45.6 ${cy - 2.4} A3.4 3.4 0 0 1 52.2 ${cy - 2.4} L53 ${cy - 1.8} L44.8 ${cy - 1.8} Z`}
        fill={PALETTE.bodyShade}
      />
    </g>
  );
}

/** Solar-powered signal trailer: three-aspect head on a telescopic mast. */
export function PortableSignal() {
  return (
    <VehicleSvg id={"construction.portable_signal"}>
      <Ground x={20} width={58} />

      {/* Outriggers with screw jacks and pads. */}
      <path d={strut(34.4, 35.4, 23.2, 39.8, 2.6, 1.8)} fill="currentColor" />
      <path d={strut(64.6, 35.4, 75.8, 39.8, 2.6, 1.8)} fill="currentColor" />
      <g fill={PALETTE.rimShade}>
        <rect x="20.4" y="39.6" width="6.4" height="1.4" rx=".6" />
        <rect x="72.2" y="39.6" width="6.4" height="1.4" rx=".6" />
      </g>
      <g stroke={PALETTE.rim} strokeWidth=".9" strokeLinecap="round">
        <line x1="24.4" y1="37.6" x2="27.4" y2="36.6" />
        <line x1="74.6" y1="37.6" x2="71.6" y2="36.6" />
      </g>

      {/* Battery box and skid. */}
      <path d="M29.6 38.2 L68.4 38.2 L69.6 40.8 L28.4 40.8 Z" fill="currentColor" />
      <path d="M29.6 38.2 L68.4 38.2 L69.6 40.8 L28.4 40.8 Z" fill={PALETTE.shadow} opacity=".34" />
      <path d="M33 32.4 L65 32.4 L66.6 38.4 L31.4 38.4 Z" fill="currentColor" />
      <path d="M33 32.4 L65 32.4 L66.6 38.4 L31.4 38.4 Z" fill={FILL.gloss} opacity=".7" />
      <path
        d="M33 32.4 L65 32.4 L66.6 38.4 L31.4 38.4 Z"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <Seam d="M34 34.4 L65.4 34.4" width={0.7} opacity={0.6} />
      <rect x="38.6" y="35.2" width="4.4" height="2.2" rx=".6" fill={PALETTE.rimShade} />
      <Grille x={54} y={34.8} width={8} height={3} bars={3} />

      {/* Telescopic mast: lower section, clamp collar, upper section. */}
      <path d={strut(48.4, 32.6, 48.4, 21.4, 5)} fill="currentColor" />
      <path d={strut(48.4, 32.6, 48.4, 21.4, 5)} fill={FILL.gloss} opacity=".6" />
      <path d={strut(48.9, 22.4, 48.9, 14, 3.2)} fill={PALETTE.rim} />
      <rect x="45.4" y="20.4" width="6.6" height="2.4" rx=".8" fill={PALETTE.rimShade} />
      <circle cx="52.2" cy="21.6" r=".9" fill={PALETTE.chrome} />

      {/* Solar array on its arm, wired down to the battery box. */}
      <path d={strut(45.6, 17.6, 38.6, 16.2, 1.6)} fill={PALETTE.bodyShade} />
      <path d="M25.6 18.4 L38.8 13.6 L40.6 16.4 L27.4 21.4 Z" fill={PALETTE.glass} />
      <path d="M25.6 18.4 L38.8 13.6 L40.6 16.4 L27.4 21.4 Z" fill={FILL.glass} opacity=".7" />
      <g stroke={PALETTE.seam} strokeWidth=".6" opacity=".6">
        <line x1="29.8" y1="16.8" x2="31.6" y2="19.7" />
        <line x1="34" y1="15.3" x2="35.8" y2="18.2" />
      </g>
      <path
        d="M25.6 18.4 L38.8 13.6 L40.6 16.4 L27.4 21.4 Z"
        fill="none"
        stroke={PALETTE.chrome}
        strokeWidth=".8"
        strokeLinejoin="round"
      />
      <path
        d="M27.8 21.2 C29.6 26 31.4 30 34.4 32.6"
        fill="none"
        stroke={PALETTE.shadow}
        strokeWidth=".8"
        opacity=".6"
      />

      {/* Controller on the mast. */}
      <rect x="50.6" y="24.4" width="6" height="4.6" rx=".9" fill="currentColor" />
      <rect x="50.6" y="24.4" width="6" height="4.6" rx=".9" fill="none" stroke={PALETTE.line} strokeWidth=".7" />
      <circle cx="53.6" cy="26.6" r=".8" fill={GREEN} />

      {/* Three-aspect head, hooded. */}
      <Body d={SIGNAL_HEAD} />
      <rect x="42.8" y="2.6" width="12.2" height="15.2" rx="1.4" fill={PALETTE.bodyShade} opacity=".8" />
      <SignalLamp cy={6} colour={PALETTE.beaconRed} />
      <SignalLamp cy={10.4} colour={PALETTE.amber} />
      <SignalLamp cy={14.8} colour={GREEN} />
      <path d="M41.4 12 L41.4 16.8 A2.2 2.2 0 0 0 43.6 19 L45 19" fill="none" stroke={PALETTE.seam} strokeWidth=".7" opacity=".6" />
    </VehicleSvg>
  );
}
