"use client";

import {
  AXLE,
  Body,
  FILL,
  Glass,
  Grille,
  Ground,
  Lamps,
  PALETTE,
  Seam,
  VehicleSvg,
  Wheel,
} from "./parts";

/**
 * Micro mobility: motorcycle, bicycle, mobility scooter.
 *
 * These three have almost no bodywork to carry the read, so the silhouette is
 * made of frame, machinery and rider instead. Three rules keep them apart at
 * tile size:
 *
 *   - wheel diameter — fat 11.8u motorcycle, thin 12.8u bicycle, tiny 6-7u
 *     scooter casters — is the first thing the eye sorts them by;
 *   - the mass sits in a different place on each one: engine block low and
 *     central, open diamond triangles, seat-and-tiller bracketing a low deck;
 *   - the rider posture differs — tucked forward, folded over the bars,
 *     upright and seated back.
 *
 * The fleet contact line is `AXLE + 5.4…5.9`; small wheels drop their centre
 * rather than float, which is what `Wheel`'s `cy` is for.
 */

/** Where every tire in this file meets the road, matching the car wheels. */
const CONTACT = AXLE + 5.9;

/** Rider tones. Near limbs lit, far limbs sunk, both from the fleet palette. */
const SUIT = PALETTE.glassLit;
const SUIT_FAR = PALETTE.glass;

/** A straight tube of width `w` as a filled quad — frames are not strokes. */
function tube(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const nx = ((-dy / length) * w) / 2;
  const ny = ((dx / length) * w) / 2;
  return (
    `M${(x1 + nx).toFixed(2)} ${(y1 + ny).toFixed(2)}L${(x2 + nx).toFixed(2)} ${(y2 + ny).toFixed(2)}` +
    `L${(x2 - nx).toFixed(2)} ${(y2 - ny).toFixed(2)}L${(x1 - nx).toFixed(2)} ${(y1 - ny).toFixed(2)}Z`
  );
}

/** One rider limb: a round-capped stroke, sunk a tone when it is the far side. */
function Limb({ d, w = 2.8, far = false }: { d: string; w?: number; far?: boolean }) {
  return (
    <path
      d={d}
      fill="none"
      stroke={far ? SUIT_FAR : SUIT}
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/* ------------------------------------------------------------------ */
/* Motorcycle                                                          */
/* ------------------------------------------------------------------ */

const MOTO_R = 5.9;
const MOTO_REAR = 35;
const MOTO_FRONT = 63;

/**
 * Tank, saddle and kicked-up tail as one shell: a slim tail and seat so the
 * teardrop tank stays the tallest thing on the frame.
 */
const MOTO_SHELL =
  "M35.4 25.8 C38.2 26.2 41.4 27 44.2 27.6 " +
  "C47.2 27.6 48.6 26 50.4 23.9 C52.8 21.1 56.4 20.1 59.8 20.9 " +
  "L61.4 22.4 L60.4 26.8 " +
  "C57.6 28.2 53.8 29 50.2 29.3 L44.4 29.8 L38.4 29 L36.4 28.4 Z";

/** Front mudguard, drawn clear of the tire so the wheel still sits on top. */
const MOTO_FENDER =
  "M57.2 33.4 C58.2 30 61.4 28.2 64.8 28.4 C66.6 28.5 68 29.2 68.8 30.2 " +
  "L68 31.8 C66.8 30.4 65 29.8 63.2 30 C60.6 30.4 58.8 31.8 58.4 34 Z";

/** Crankcase: the mass a bike is recognised by, lit rather than blacked out. */
const MOTO_CRANKCASE =
  "M45.8 30 L57.8 29.2 C59.2 30.4 59.4 33.4 58.4 34.8 L55.6 37.2 L48.2 37.4 " +
  "C45 37 44 33.4 44.8 31.2 Z";

const MOTO_HELMET =
  "M46.4 9.4 C46.6 6 49.2 4.1 51.8 4.7 C54.2 5.3 55.2 7.7 54.6 10.2 " +
  "L54.2 12.4 C53.8 14.2 51.8 15.2 49.8 14.6 L47.4 13.6 C46.4 12.4 46.2 10.8 46.4 9.4 Z";

const MOTO_VISOR =
  "M50.4 7.5 C52.2 7.3 54 7.9 54.7 9.1 L54.4 11.5 C52.8 12.3 50.8 12.1 49.6 11.1 Z";

/** Naked standard: exposed engine, telescopic fork, tucked rider. */
export function Motorcycle() {
  return (
    <VehicleSvg id="vehicle.motorcycle">
      <Ground x={28} width={42} />

      {/* Running gear behind the shell: swingarm, shock, engine, exhaust. */}
      <path d={tube(48.4, 35.2, MOTO_REAR, 37, 2.8)} fill={FILL.metal} opacity=".9" />
      <path d={tube(46.8, 29.4, 42.6, 34.6, 2.4)} fill={PALETTE.rimShade} />
      <g stroke={PALETTE.chrome} strokeWidth=".6" opacity=".8">
        <line x1="44.5" y1="30.2" x2="46.5" y2="31.8" />
        <line x1="43.5" y1="31.5" x2="45.5" y2="33.1" />
        <line x1="42.4" y1="32.8" x2="44.4" y2="34.4" />
      </g>
      <path d={MOTO_CRANKCASE} fill={PALETTE.rimShade} />
      <path d={MOTO_CRANKCASE} fill={FILL.gloss} />
      <path
        d={MOTO_CRANKCASE}
        fill="none"
        stroke={PALETTE.shadow}
        strokeWidth=".8"
        opacity=".65"
      />
      <Grille x={49.4} y={29.6} width={9} height={3.4} bars={3} />
      <circle cx="53.8" cy="34" r="2.8" fill={FILL.metal} opacity=".55" />
      <circle cx="53.8" cy="34" r="2.8" fill="none" stroke={PALETTE.shadow} strokeWidth=".6" opacity=".7" />
      <path
        d="M56.8 31.4 C59.6 33.6 58.4 36.6 54.6 37 L50.4 36.8"
        fill="none"
        stroke={PALETTE.rim}
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <path
        d="M49.8 34.8 L43.4 35.4 A1.75 1.75 0 0 0 43.4 38.9 L49.8 37.8 Z"
        fill={FILL.metal}
        stroke={PALETTE.rimShade}
        strokeWidth=".5"
      />
      <ellipse cx="43.4" cy="37.15" rx=".8" ry="1.75" fill={PALETTE.shadow} />
      <path d="M44.2 36 L49.2 35.7" stroke={PALETTE.chrome} strokeWidth=".7" opacity=".8" />
      <path d={tube(59.2, 26.2, 49.2, 32.8, 2)} fill={PALETTE.rimShade} />

      <Body d={MOTO_SHELL} />
      <Seam d="M50.8 26.4 C54 24.6 57.2 24 60 24.4" />
      <Seam d="M45.4 27.9 L50.2 27.1" width={0.7} opacity={0.6} />
      <rect x="48.4" y="34.6" width="2.8" height="1.1" rx=".5" fill={PALETTE.rimShade} />

      {/* Front end: raked fork, clamp, guard, round lamp, bars. */}
      <path d={tube(60.2, 22.2, 63.2, 30.6, 2.4)} fill={FILL.metal} />
      <path d={tube(62.9, 29.4, 63.9, 36.6, 2.9)} fill={PALETTE.rimShade} />
      <rect x="58.6" y="21" width="4.4" height="2.6" rx=".9" fill={PALETTE.bodyShade} />
      <Body d={MOTO_FENDER} outline={0.8} />
      <circle cx="64.6" cy="24.6" r="3.4" fill={PALETTE.lamp} />
      <circle cx="64.6" cy="24.6" r="3.4" fill="none" stroke={PALETTE.chrome} strokeWidth=".8" />
      <circle cx="63.6" cy="23.4" r="1.2" fill="#fffdf2" opacity=".85" />
      <path
        d="M59.8 21.8 C58.4 20.2 57.2 19.4 56 19.2"
        fill="none"
        stroke={PALETTE.rimShade}
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <rect x="54.6" y="18.1" width="3.6" height="2.2" rx="1.1" fill={PALETTE.bodyShade} />
      <Lamps rear={34.4} rearY={25.6} size={1.9} />

      {/* Rider, tucked forward over the tank. */}
      <Limb d="M44.4 27.4 L49.2 31.4 L46.6 35" w={3} far />
      <Limb d="M49.2 16.4 C51.2 16.6 53 17.8 54.6 18.9" w={2.4} far />
      <path
        d="M42.2 27 C42.6 22 45.4 17.4 48.2 14.6 L52.4 16.2 C50.2 19.8 48.6 23.6 48 27.4 Z"
        fill={SUIT}
        stroke={PALETTE.seam}
        strokeWidth=".6"
      />
      <Limb d="M45 27.6 L50.4 31.2 L47.6 35.4" w={3.2} />
      <rect x="45.8" y="34.4" width="3.6" height="2.2" rx="1" fill={SUIT} />
      <Limb d="M50.6 16.2 C52.6 16.4 54 17.8 55.2 18.9" w={2.6} />
      <path d={MOTO_HELMET} fill={FILL.metal} stroke={PALETTE.line} strokeWidth=".7" />
      <Glass d={MOTO_VISOR} />
      <path d={tube(58, 19.6, 57.4, 15.4, 1.1)} fill={PALETTE.rimShade} />
      <ellipse
        cx="57"
        cy="14.4"
        rx="1.9"
        ry="1.3"
        fill={FILL.metal}
        stroke={PALETTE.line}
        strokeWidth=".6"
      />

      <Wheel cx={MOTO_REAR} r={MOTO_R} />
      <Wheel cx={MOTO_FRONT} r={MOTO_R} />
      <circle
        cx={MOTO_FRONT}
        cy={AXLE}
        r="4.3"
        fill="none"
        stroke={PALETTE.rimShade}
        strokeWidth=".9"
        opacity=".85"
      />
      <path
        d="M59.6 33.2 L61.4 33.9 L60.6 35.8 L58.8 35.1 Z"
        fill={PALETTE.chrome}
        opacity=".9"
      />
      <g stroke={PALETTE.rimShade} strokeWidth=".8" opacity=".9">
        <line x1={MOTO_REAR} y1="34.5" x2="47.4" y2="33.6" />
        <line x1={MOTO_REAR} y1="39.5" x2="47.4" y2="36.2" />
      </g>
      <circle cx={MOTO_REAR} cy={AXLE} r="2.5" fill="none" stroke={PALETTE.chrome} strokeWidth="1" opacity=".9" />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Bicycle                                                             */
/* ------------------------------------------------------------------ */

const BIKE_R = 6.4;
const BIKE_AXLE = CONTACT - BIKE_R;
const BIKE_REAR = 33;
const BIKE_FRONT = 57;

/** Diamond frame: two open triangles, drawn as tubes so the voids read. */
const BIKE_FRAME =
  tube(41.4, 23, 44, 34.2, 2) + // seat tube
  tube(41.7, 23.2, 55.4, 22.6, 1.9) + // top tube
  tube(56.3, 26.2, 44.2, 34.2, 2.2) + // down tube
  tube(55.2, 21.8, 57, 26.8, 2.6) + // head tube
  tube(41.5, 23.6, BIKE_REAR, 36.4, 1.5) + // seat stay
  tube(44, 34.6, BIKE_REAR, 36.5, 1.5) + // chain stay
  tube(56.7, 26.6, 57, 32, 1.7) + // fork crown
  tube(57, 32, 57.6, 36.5, 1.6); // fork blade

const BIKE_HELMET =
  "M44.4 8.8 C44.6 5.5 47.1 3.7 49.7 4.3 C52.1 4.9 52.8 7.2 52 9 " +
  "L51.2 10.4 L45.5 10.8 C44.7 10.4 44.3 9.6 44.4 8.8 Z";

const SPOKES = [0, 30, 60, 90, 120, 150];

/** Thin-section wheel: tire, rim, a suggestion of spokes, small hub. */
function BikeWheel({ cx }: { cx: number }) {
  return (
    <g>
      <circle cx={cx} cy={BIKE_AXLE} r={BIKE_R} fill="none" stroke={PALETTE.tire} strokeWidth="1.45" />
      <circle
        cx={cx}
        cy={BIKE_AXLE}
        r={BIKE_R - 1.15}
        fill="none"
        stroke={PALETTE.rim}
        strokeWidth=".8"
        opacity=".9"
      />
      <g stroke={PALETTE.rimShade} strokeWidth=".6" opacity=".55">
        {SPOKES.map((angle) => {
          const radians = (angle * Math.PI) / 180;
          const dx = Math.cos(radians) * (BIKE_R - 1.5);
          const dy = Math.sin(radians) * (BIKE_R - 1.5);
          return (
            <line key={angle} x1={cx - dx} y1={BIKE_AXLE - dy} x2={cx + dx} y2={BIKE_AXLE + dy} />
          );
        })}
      </g>
      <circle cx={cx} cy={BIKE_AXLE} r="1.4" fill={FILL.metal} />
      <circle cx={cx} cy={BIKE_AXLE} r=".5" fill={PALETTE.chrome} />
    </g>
  );
}

/** Diamond-frame road bike with a rider folded onto the drops. */
export function Bicycle() {
  return (
    <VehicleSvg id="vehicle.bicycle">
      <Ground x={26} width={38} />

      {/* Drivetrain under the frame. */}
      <circle cx="44" cy="34.2" r="2.9" fill={PALETTE.bodyShade} />
      <circle cx="44" cy="34.2" r="2.9" fill="none" stroke={PALETTE.chrome} strokeWidth=".7" />
      <g stroke={PALETTE.rimShade} strokeWidth=".6" opacity=".8">
        <line x1="44" y1="31.6" x2="44" y2="36.8" />
        <line x1="41.5" y1="34.2" x2="46.5" y2="34.2" />
      </g>
      <g stroke={PALETTE.rimShade} strokeWidth=".8" fill="none">
        <path d={`M${BIKE_REAR} 34.9 L44.6 31.4`} />
        <path d={`M${BIKE_REAR} 38.2 Q38.8 39 44.4 37.1`} />
      </g>
      <path d={tube(44, 34.2, 46.2, 31.2, 1.4)} fill={SUIT_FAR} />
      <rect x="45.4" y="30.4" width="3" height="1.4" rx=".6" fill={PALETTE.bodyShade} />

      <Body d={BIKE_FRAME} outline={0.6} />

      {/* Saddle, post, bars. */}
      <path d={tube(41.3, 21.4, 41.6, 24, 1.5)} fill={PALETTE.bodyShade} />
      <path
        d="M37.2 20.2 C38.8 19.2 41 19.2 42.4 19.8 L44.6 20.4 C44.8 21 44.2 21.4 43.2 21.3 
           L39.4 21.9 C37.6 22 36.6 21 37.2 20.2 Z"
        fill={PALETTE.bodyShade}
      />
      <Seam d="M38 20.2 C39.8 19.6 42 19.7 43.6 20.4" width={0.6} opacity={0.6} />
      <path d={tube(55.6, 22.2, 58, 21.4, 1.6)} fill={FILL.metal} />
      <path
        d="M57.8 21.2 C60.6 21 61 24.6 58.6 25.8"
        fill="none"
        stroke={PALETTE.bodyShade}
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M57.8 21.2 C60.6 21 61 24.6 58.6 25.8"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".6"
        opacity=".45"
        strokeLinecap="round"
      />
      <Lamps front={59.8} frontY={20.6} rear={36.4} rearY={20.1} size={1.8} />

      {/* Cranks and pedals: near side back and down, far side up and forward. */}
      <path d={tube(44, 34.2, 41.8, 37.2, 1.6)} fill={PALETTE.bodyShade} />
      <rect x="40.2" y="37" width="3.6" height="1.5" rx=".6" fill={PALETTE.rimShade} />

      {/* Rider. */}
      <Limb d="M40.6 21.6 L46.4 26.6 L46.2 31.4" w={2.9} far />
      <Limb d="M45.2 14.2 C49.4 16.4 54 19.4 56.6 21.2" w={2.3} far />
      <path
        d="M38.8 21 C39.6 17 42 13.6 44.4 11.6 L48.2 13.4 C46 16.2 44.4 19.4 43.8 22.6 Z"
        fill={SUIT}
        stroke={PALETTE.seam}
        strokeWidth=".6"
      />
      <Limb d="M41.8 22.4 L47 28.6 L42.6 36.2" w={3.1} />
      <rect x="40.4" y="35.8" width="3.6" height="1.8" rx=".8" fill={SUIT_FAR} />
      <Limb d="M46.6 13.8 C50.6 16 55 19.2 57.2 21.2" w={2.5} />
      <circle cx="57.4" cy="21.4" r="1.3" fill={SUIT} />
      <path
        d="M46.6 10.4 C47.6 12.4 50 12.6 51.2 11 L51.4 10.4 L46.8 10.5 Z"
        fill={PALETTE.chrome}
        opacity=".85"
      />
      <path d={BIKE_HELMET} fill={FILL.metal} stroke={PALETTE.line} strokeWidth=".7" />
      <g stroke={PALETTE.rimShade} strokeWidth=".6" opacity=".7">
        <line x1="46.4" y1="5.6" x2="46" y2="9.6" />
        <line x1="49" y1="5" x2="48.8" y2="9.4" />
      </g>
      <Glass d="M50.2 8.7 L52.5 8.5 L52 10.3 L50 10.4 Z" />

      <BikeWheel cx={BIKE_REAR} />
      <BikeWheel cx={BIKE_FRONT} />
      <circle cx={BIKE_REAR} cy={BIKE_AXLE} r="1.8" fill={PALETTE.bodyShade} />
      <circle
        cx={BIKE_REAR}
        cy={BIKE_AXLE}
        r="1.8"
        fill="none"
        stroke={PALETTE.chrome}
        strokeWidth=".6"
      />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Mobility scooter                                                    */
/* ------------------------------------------------------------------ */

const SCOOT_REAR_R = 3.4;
const SCOOT_FRONT_R = 3;
const SCOOT_REAR = 35;
const SCOOT_FRONT = 60;

const SCOOT_DECK = "M38.4 34.2 L57.6 34.4 L58.8 36 L57.4 37.8 L39.2 37.6 L37.4 36 Z";

const SCOOT_REAR_SHROUD =
  "M30.6 30 C30.6 28.4 31.8 27.6 33.4 27.6 L40 27.8 C41.8 28 42.6 29.4 42.6 31 " +
  "L42.4 36.2 L31.4 36 C29.8 34.4 29.9 31.8 30.6 30 Z";

const SCOOT_FRONT_SHROUD =
  "M54.6 34 L56 29.8 C56.4 28.6 57.4 27.8 58.8 27.8 L62.6 28 " +
  "C64 28.2 64.8 29.2 64.6 30.6 L63.8 35.8 L55 36 Z";

const SCOOT_SEAT =
  "M29.4 21 L44 20.6 C45.4 20.6 45.8 21.8 45.2 22.8 L43.8 24.8 L31 25 " +
  "C29 24.8 28.4 21.8 29.4 21 Z";

const SCOOT_BACKREST =
  "M28.6 12 C28.6 10.6 29.6 10 30.8 10.1 L33 10.4 C34.2 10.6 34.6 11.6 34.4 12.8 " +
  "L33.2 21.4 L29.2 21.2 Z";

const SCOOT_TILLER_HEAD =
  "M50.6 12.6 L60.4 12.2 C61.6 12.2 62.2 13.2 61.8 14.2 L61 16.6 L51.4 17 " +
  "C50 17 49.4 15.8 49.8 14.6 Z";

const SCOOT_CAP =
  "M35 7 C35.2 4.6 37.6 3.4 39.8 4 C41.4 4.4 42 5.6 41.8 7 L44.4 7.5 L44.3 8.4 L35.4 8.1 Z";

/** Four-wheel pavement scooter: high seat, leaning tiller, front basket. */
export function MobilityScooter() {
  return (
    <VehicleSvg id="vehicle.mobility_scooter">
      <Ground x={27} width={42} />

      {/* Far-side pair, sunk behind the shrouds: this is a four-wheeler. */}
      <circle cx="32.8" cy={CONTACT - 3.2} r="3.2" fill={PALETTE.tire} opacity=".5" />
      <circle cx="57.8" cy={CONTACT - 2.8} r="2.8" fill={PALETTE.tire} opacity=".5" />

      <Body d={SCOOT_REAR_SHROUD} />
      <Body d={SCOOT_FRONT_SHROUD} />
      <Body d={SCOOT_DECK} />
      <Seam d="M41.4 35.6 L47 35.6" width={0.7} opacity={0.6} />
      <Seam d="M49 35.7 L54.6 35.7" width={0.7} opacity={0.6} />
      <Seam d="M32 31.4 L41.4 31.6" width={0.7} opacity={0.55} />
      <Grille x={57.4} y={30.2} width={5.6} height={3.4} bars={3} />

      {/* Seat column, pan, backrest. */}
      <path d={tube(37.4, 24.4, 37.8, 30.4, 2.6)} fill={PALETTE.rimShade} />
      <Body d={SCOOT_SEAT} />
      <path
        d="M30.2 20.3 L43.4 19.9 C44.4 19.9 44.6 21 43.4 21.1 L30.6 21.7 
           C29.4 21.7 29.4 20.4 30.2 20.3 Z"
        fill={PALETTE.bodyShade}
      />
      <Body d={SCOOT_BACKREST} />
      <Seam d="M30.4 12.6 L32.8 12.9" width={0.7} opacity={0.6} />
      <Seam d="M30.2 16 L32.5 16.2" width={0.7} opacity={0.6} />

      {/* Tiller: the stance cue. Column leans back to the rider's hands. */}
      <Body d={tube(60.4, 31, 56.4, 16.4, 3.2)} outline={0.9} />
      <Body d={SCOOT_TILLER_HEAD} outline={0.9} />
      <Glass d="M54.4 13.4 L58.6 13.2 L58.2 15.5 L54 15.7 Z" />
      <rect x="61" y="13" width="2.6" height="2.4" rx="1.2" fill={PALETTE.bodyShade} opacity=".7" />
      <rect x="48.6" y="13.4" width="3.8" height="2.6" rx="1.3" fill={PALETTE.bodyShade} />

      {/* Front basket. */}
      <path
        d="M62.6 16.6 L70.8 16.6 L69.8 23.8 L63.6 23.8 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <g stroke="currentColor" strokeWidth=".7" opacity=".7">
        <line x1="65.2" y1="16.6" x2="64.8" y2="23.8" />
        <line x1="67.8" y1="16.6" x2="67.2" y2="23.8" />
        <line x1="62.9" y1="20.2" x2="70.3" y2="20.2" />
      </g>
      <path d={tube(63.4, 23.4, 60.2, 26.4, 1.4)} fill={PALETTE.rimShade} />
      <Lamps front={62.8} frontY={28.8} rear={29.8} rearY={28.6} size={2.4} />

      {/* Rider, upright and seated back. */}
      <Limb d="M35 22 L45.4 26.4 L50.4 32.8" w={2.9} far />
      <Limb d="M37.4 14 C42 15.6 46.6 15.8 49.6 15.2" w={2.3} far />
      <path
        d="M32.6 21.2 C32.6 17 34 13.8 35.8 11.8 L39.6 13.2 C38.2 15.6 37.4 18.4 37.2 21.4 Z"
        fill={SUIT}
        stroke={PALETTE.seam}
        strokeWidth=".6"
      />
      <Limb d="M35.8 22.6 L47 26.8 L52.2 33.6" w={3.2} />
      <path d="M51 32.8 L56.2 34 L56 35.6 L51.4 35.2 Z" fill={SUIT_FAR} />
      <path d={tube(37.2, 10.4, 37.8, 12.6, 2.2)} fill={SUIT} />
      <circle cx="38.4" cy="7.8" r="3.4" fill={FILL.metal} stroke={PALETTE.line} strokeWidth=".6" />
      <path d={SCOOT_CAP} fill={SUIT_FAR} />
      <Limb d="M38.4 13.6 C43 15.4 47 15.6 50 14.8" w={2.6} />
      <circle cx="50.2" cy="14.8" r="1.4" fill={SUIT} />

      {/* Near armrest sits in front of the rider. */}
      <path d={tube(34, 17.6, 33.6, 21.2, 1.3)} fill={PALETTE.rimShade} />
      <rect x="33" y="16" width="11" height="1.9" rx=".95" fill={PALETTE.bodyShade} />
      <path d="M33.6 16.5 L43.4 16.5" stroke={PALETTE.chrome} strokeWidth=".6" opacity=".7" />

      <Wheel cx={SCOOT_REAR} cy={CONTACT - SCOOT_REAR_R} r={SCOOT_REAR_R} spokes={false} />
      <Wheel cx={SCOOT_FRONT} cy={CONTACT - SCOOT_FRONT_R} r={SCOOT_FRONT_R} spokes={false} />
    </VehicleSvg>
  );
}
