"use client";

import {
  Body,
  FILL,
  Glass,
  Grille,
  Ground,
  PALETTE,
  Seam,
  VehicleSvg,
  Wheel,
} from "../vehicle-art/parts";
import {
  SOIL,
  SOIL_LIT,
  STONE,
  TIMBER,
  TIMBER_LIT,
  tube,
} from "./prop-parts";

/**
 * Construction leftovers: the machine and the material a work zone leaves on the kerb.
 *
 * Same stage as the vehicle fleet: a 96x48 side elevation facing right, the
 * ground at `GROUND`, nothing below it but the contact shadow.
 */

/* ================================================================== */
/* Construction leftovers                                             */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Excavator                                                           */
/* ------------------------------------------------------------------ */

/** Track belt: a stadium round the drive sprocket and the front idler. */
const EXC_TRACK =
  "M19.6 29.4 L48.4 29.4 A5.8 5.8 0 0 1 48.4 41 L19.6 41 A5.8 5.8 0 0 1 19.6 29.4 Z";

/** Upper structure: counterweight tail, engine deck, then the raised cab. */
const EXC_HOUSE =
  "M13.4 30.6 C12.6 27 13.1 23.4 14.6 22.4 L34.4 21.2 " +
  "L35.2 13.4 C35.3 12.4 36.1 11.8 37.2 11.8 L50.4 12 " +
  "C51.5 12.1 52.2 12.8 52.2 13.9 L52.4 30.8 Z";

/** Booms are curved castings, not straight bars — that curve is the read. */
const EXC_BOOM =
  "M50 22.6 C55.6 16.2 61.8 11.4 67 9 L70.4 12.6 " +
  "C65.4 15.2 59.6 20 54.8 26.4 Z";

const EXC_DIPPER = "M66.4 9.4 L71.6 8.2 L79.8 26 L75.4 28.2 Z";

const EXC_BUCKET =
  "M74 26.8 L80.8 24.8 C84.4 27.2 86 31.6 84.8 35.4 " +
  "L76.6 36.6 C73.8 34.2 73 29.8 74 26.8 Z";

/** Bucket teeth, walked along the cutting edge. */
const EXC_TEETH: readonly (readonly [number, number])[] = [
  [77.6, 36.4],
  [80, 36.1],
  [82.4, 35.8],
  [84.5, 35.4],
];

/** Tracked 20-tonne excavator, boom out and bucket curled ready to dig. */
export function Excavator() {
  return (
    <VehicleSvg id={"construction.excavator"}>
      <Ground x={12} width={50} />

      {/* Undercarriage: belt, grousers, track frame, bottom rollers. */}
      <path d={EXC_TRACK} fill={PALETTE.tire} stroke={PALETTE.line} strokeWidth="1" />
      <g stroke={PALETTE.tireWall} strokeWidth="1.3">
        {[21, 25, 29, 33, 37, 41, 45].map((x) => (
          <line key={x} x1={x} y1="38.2" x2={x} y2="41" />
        ))}
      </g>
      <rect x="23" y="31.4" width="22" height="5.4" rx="2" fill={FILL.metal} opacity=".45" />
      <g fill={PALETTE.rimShade}>
        {[27, 32, 37, 42].map((x) => (
          <circle key={x} cx={x} cy="38.2" r="1.7" />
        ))}
      </g>
      <Wheel cx={19.6} cy={35.2} r={3.6} />
      <Wheel cx={48.4} cy={35.2} r={3.6} />

      {/* Slew ring the house turns on. */}
      <rect x="17" y="29.8" width="34" height="2.6" rx="1.2" fill={PALETTE.bodyShade} />

      {/* Counterweight, house, radiator, exhaust, deck rail. */}
      <path d="M13.2 30.4 C12.5 27 13 23.6 14.5 22.5 L19.2 22.2 L19.4 30.6 Z" fill={PALETTE.bodyShade} />
      <Body d={EXC_HOUSE} />
      <Seam d="M19.6 22.4 L19.8 30.4" />
      <Seam d="M14.2 26.6 L34.6 26" width={0.7} opacity={0.5} />
      <Grille x={22.4} y={22.8} width={8.6} height={6.2} bars={4} />
      <rect x="31.8" y="15.4" width="2.8" height="6" rx="1.2" fill={PALETTE.rimShade} />
      <ellipse cx="33.2" cy="15.2" rx="2.1" ry=".9" fill={PALETTE.chrome} />
      <path d="M20.4 20.9 L34.4 20.4" stroke={PALETTE.chrome} strokeWidth=".8" opacity=".85" />

      {/* Cab: two-pane glazing, door cut, step. */}
      <Glass d="M37.4 13.9 L49.7 14.1 L49.9 24.8 L37.4 24.6 Z" />
      <Seam d="M44 14 L44 24.7" width={0.7} />
      <Seam d="M37.6 20 L49.8 20.1" width={0.6} opacity={0.5} />
      <rect x="36.6" y="26" width="14.6" height="3.6" rx="1.2" fill={PALETTE.bodyShade} />
      <rect x="38.4" y="30.2" width="6.4" height="1.4" rx=".6" fill={PALETTE.rimShade} />

      {/* Boom, dipper and their rams. */}
      <circle cx="51.4" cy="24.6" r="2.4" fill={FILL.metal} stroke={PALETTE.rimShade} strokeWidth=".7" />
      <path d={tube(49.6, 27.8, 60.6, 17.6, 2.8)} fill={PALETTE.rimShade} />
      <path d={tube(56.6, 21.8, 61.4, 17.4, 1.5)} fill={PALETTE.chrome} />
      <Body d={EXC_BOOM} outline={1} />
      <Seam d="M52.4 22.4 C57.4 17.4 62.6 13.6 67.2 11.4" width={0.7} opacity={0.55} />
      <path d={tube(60.4, 13.4, 70.6, 15.8, 2.4)} fill={PALETTE.rimShade} />
      <circle cx="68.6" cy="9.8" r="2.3" fill={FILL.metal} stroke={PALETTE.rimShade} strokeWidth=".7" />
      <Body d={EXC_DIPPER} outline={1} />
      <path d={tube(71.8, 12.6, 76.6, 24.4, 1.7)} fill={PALETTE.chrome} opacity=".75" />

      {/* Bucket, curled back, teeth on the cutting edge. */}
      <path d={tube(76.8, 25.4, 79.2, 28.6, 2.1)} fill={PALETTE.rimShade} />
      <path d={EXC_BUCKET} fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth="1" strokeLinejoin="round" />
      <path d={EXC_BUCKET} fill={FILL.gloss} />
      <g fill={PALETTE.chrome}>
        {EXC_TEETH.map(([x, y]) => (
          <path key={x} d={`M${x - 1.1} ${y - 0.3} L${x + 1.1} ${y - 0.5} L${x + 0.2} ${y + 2.5} Z`} />
        ))}
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Portable toilet                                                     */
/* ------------------------------------------------------------------ */

const PT_CABIN = "M33.6 39.4 L34.6 9 L64.2 8.2 L65.8 39.6 Z";
const PT_ROOF = "M30.2 9.2 L34.8 4.8 L64.4 4 L67.8 8.6 Z";
const PT_DOOR = "M38.4 37.4 L39 12.6 L59.8 12 L60.6 37.6 Z";

/** Site cabin, seen a shade off-axis so the door face and one flank both read. */
export function PortableToilet() {
  return (
    <VehicleSvg id={"construction.portable_toilet"}>
      <Ground x={26} width={46} />

      {/* Receding flank, corrugated like the front. */}
      <path d="M29.4 9.4 L33.8 9.2 L33.6 39.4 L29 39.2 Z" fill={PALETTE.bodyShade} />
      <g stroke={PALETTE.seam} strokeWidth=".6" opacity=".45">
        <line x1="30.6" y1="10" x2="30.6" y2="38.9" />
        <line x1="32.2" y1="9.8" x2="32.2" y2="39.1" />
      </g>

      <Body d={PT_CABIN} />
      <g stroke={PALETTE.seam} strokeWidth=".7" opacity=".5">
        {[35.4, 36.8, 62.2, 63.6].map((x) => (
          <line key={x} x1={x} y1="9.4" x2={x} y2="39.2" />
        ))}
      </g>
      <Seam d="M34.2 30.4 L65.6 30.8" width={0.8} opacity={0.55} />

      {/* Door: recessed panel, louvre head, latch and grab rail. */}
      <path d={PT_DOOR} fill={PALETTE.bodyShade} />
      <path d={PT_DOOR} fill={FILL.gloss} opacity=".6" />
      <path d={PT_DOOR} fill="none" stroke={PALETTE.line} strokeWidth=".9" strokeLinejoin="round" />
      <g stroke={PALETTE.rimShade} strokeWidth="1.1" strokeLinecap="round">
        {[15.2, 17.2, 19.2, 21.2].map((y) => (
          <line key={y} x1="42" y1={y} x2="57" y2={y - 0.4} />
        ))}
      </g>
      <rect x="57.2" y="22.4" width="2.6" height="5.6" rx="1.2" fill={PALETTE.chrome} />
      <circle cx="58.5" cy="25.2" r="1.1" fill={PALETTE.rimShade} />
      <path d="M40.8 23.8 L40.8 28.8" stroke={PALETTE.chrome} strokeWidth="1.5" strokeLinecap="round" />
      <Seam d="M39.4 33.6 L60.2 33.9" width={0.7} opacity={0.5} />

      {/* Overhanging roof, then the vent stack standing on it. */}
      <path d={PT_ROOF} fill="currentColor" />
      <path d={PT_ROOF} fill={FILL.gloss} />
      <path d={PT_ROOF} fill="none" stroke={PALETTE.line} strokeWidth="1" strokeLinejoin="round" />
      <rect x="56.4" y="1.8" width="5.6" height="3.6" rx="1.4" fill={PALETTE.rimShade} />
      <ellipse cx="59.2" cy="1.8" rx="3.6" ry="1.2" fill={PALETTE.chrome} />
      <ellipse cx="59.2" cy="1.8" rx="1.6" ry=".6" fill={PALETTE.shadow} opacity=".7" />

      {/* Skid base with fork slots. */}
      <path d="M30 38.8 L68 39 L69.2 41 L28.8 41 Z" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".8" />
      <g fill={PALETTE.shadow} opacity=".8">
        <rect x="36" y="39.4" width="8" height="1.4" rx=".6" />
        <rect x="54" y="39.5" width="8" height="1.4" rx=".6" />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Spoil pile                                                          */
/* ------------------------------------------------------------------ */

/** Irregular heap: two shoulders and an off-centre peak, never a cone. */
const SP_MOUND =
  "M7 41 C11.6 36.2 16.4 32.6 21.4 30.4 C24.6 29 26.6 29.6 29 27.8 " +
  "C33 24.8 35.6 20.2 40.4 17.4 C43.6 15.6 46.6 16.4 49.2 18.4 " +
  "C53.2 21.4 55.4 25.4 59.6 26.8 C64.2 28.2 68 26.4 71.8 28.6 " +
  "C77.6 32 82.8 36 88.6 41 Z";

/** Stones turned up with the dirt: seat, lit facet. */
const SP_STONES: readonly (readonly [number, number, number])[] = [
  [23.6, 33.4, 2.4],
  [45.6, 25.8, 2.8],
  [62.4, 31.6, 2.2],
  [77.4, 37, 2.6],
  [35, 37.4, 2],
];

/** Excavated heap with a shovel left standing in the flank. */
export function SpoilPile() {
  return (
    <VehicleSvg id={"construction.spoil_pile"}>
      <Ground x={4} width={88} />
      <ellipse cx="48" cy="39.6" rx="43" ry="4.6" fill={SOIL} opacity=".22" />

      <Body d={SP_MOUND} />

      {/* Soil facets over the tinted mass: lit slopes, shaded troughs. */}
      <path d="M7.4 41 C12 36.2 17.4 32.4 22.4 30.2 L28.6 41 Z" fill={SOIL} opacity=".7" />
      <path d="M28.8 28.2 C33 24.6 36.2 20 40.6 17.5 L47.4 24.4 L34.2 33.6 Z" fill={SOIL_LIT} opacity=".62" />
      <path d="M41 17.6 C44.2 15.8 46.8 16.5 49.2 18.5 C52.6 21.2 54.6 24.6 57.8 26.4 L48 30 Z" fill={SOIL} opacity=".55" />
      <path d="M59.6 26.9 C64.2 28.3 68 26.5 71.8 28.7 L78.2 41 L56.8 41 Z" fill={SOIL} opacity=".7" />
      <path d="M72 28.8 C77.6 32.2 82.6 36.2 88.4 41 L76.4 41 Z" fill={SOIL_LIT} opacity=".5" />

      {/* Shovel: blade bitten into the flank, shaft leaning downhill. */}
      <path d={tube(63.4, 27.2, 77, 8.8, 1.9)} fill={TIMBER} />
      <path d={tube(63.4, 27.2, 77, 8.8, 0.7)} fill={TIMBER_LIT} opacity=".7" />
      <path
        d="M76 10.6 C79 8 81.4 9.4 80.4 12 C79.8 13.6 77.6 13.8 76.4 12.4 Z"
        fill={TIMBER_LIT}
        stroke={PALETTE.line}
        strokeWidth=".6"
      />
      <path d={tube(62.2, 29.4, 65.4, 25, 3.2)} fill={PALETTE.rimShade} />
      <path
        d="M56.6 29.8 L63.2 25.8 L67.2 32.2 L60.6 36.4 Z"
        fill={FILL.metal}
        stroke={PALETTE.line}
        strokeWidth=".7"
        strokeLinejoin="round"
      />
      <path d="M58.6 31.8 L64.4 28.4" stroke={PALETTE.rimShade} strokeWidth=".7" opacity=".8" />
      {/* Dirt heaped back over the buried corner of the blade. */}
      <path d="M56 32.4 C58.6 34 61 35.8 62.4 38 L54 38.6 Z" fill={SOIL} opacity=".85" />

      {/* Stones and crumbs. */}
      {SP_STONES.map(([cx, cy, r]) => (
        <g key={cx}>
          <path
            d={`M${cx - r} ${cy + r * 0.7} L${cx - r * 0.6} ${cy - r * 0.7} L${cx + r * 0.5} ${cy - r} ` +
              `L${cx + r} ${cy + r * 0.3} L${cx + r * 0.3} ${cy + r} Z`}
            fill={STONE}
            opacity=".9"
          />
          <path
            d={`M${cx - r * 0.6} ${cy - r * 0.7} L${cx + r * 0.5} ${cy - r} L${cx + r * 0.2} ${cy - r * 0.1} Z`}
            fill="#c3cbd3"
            opacity=".7"
          />
        </g>
      ))}
      <g fill={SOIL} opacity=".85">
        {[
          [12, 39.8],
          [17.6, 40.6],
          [31, 40.2],
          [50, 40.6],
          [69, 39.8],
          [84, 40.4],
        ].map(([cx, cy]) => (
          <ellipse key={cx} cx={cx} cy={cy} rx="2.4" ry="1.1" />
        ))}
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Long pipe                                                           */
/* ------------------------------------------------------------------ */

/** Barrel tapering to the right: the same diameter, further away. */
const LP_BARREL =
  "M16 18 L79.6 20.4 C82.6 21 83.6 23.6 83.6 27 C83.6 30.4 82.6 33 79.6 33.6 L16 36 Z";

/** Concrete culvert section on timber cradles, near bore open to camera. */
export function LongPipe() {
  return (
    <VehicleSvg id={"construction.long_pipe"}>
      <Ground x={10} width={78} />

      {/* Sleeper and the two cradles the barrel sits in. */}
      <path d="M20 38.4 L76 38 L76.4 40.4 L19.6 40.8 Z" fill={TIMBER} stroke={PALETTE.line} strokeWidth=".7" />
      <path d="M22 38.6 L26.2 34 L31.8 34 L35.8 38.5 Z" fill={TIMBER} stroke={PALETTE.line} strokeWidth=".8" />
      <path d="M62 38.2 L65.6 33 L70.4 33 L74 38.2 Z" fill={TIMBER} stroke={PALETTE.line} strokeWidth=".8" />

      <Body d={LP_BARREL} />
      <Seam d="M20 19 L79 21.4" width={0.8} opacity={0.5} />
      <Seam d="M20 34.9 L79 32.7" width={0.8} opacity={0.4} />

      {/* Coupling band with its bolts. */}
      <path d="M52 19.3 L56.6 19.5 L56.6 34.5 L52 34.7 Z" fill={FILL.metal} stroke={PALETTE.line} strokeWidth=".7" />
      <g fill={PALETTE.rimShade}>
        <circle cx="54.3" cy="22.4" r=".9" />
        <circle cx="54.3" cy="27" r=".9" />
        <circle cx="54.3" cy="31.6" r=".9" />
      </g>

      {/* Near end: wall thickness ring, then the bore falling away inside. */}
      <ellipse cx="16" cy="27" rx="4.6" ry="9" fill={FILL.metal} stroke={PALETTE.line} strokeWidth="1" />
      <ellipse cx="16" cy="27" rx="3.9" ry="7.9" fill="none" stroke={PALETTE.rimShade} strokeWidth=".7" opacity=".8" />
      <ellipse cx="16.7" cy="27" rx="3" ry="6.5" fill="#05090e" />
      <path
        d="M15.4 20.9 A3 6.5 0 0 0 15.4 33.1"
        fill="none"
        stroke={PALETTE.rimShade}
        strokeWidth="1.1"
        opacity=".65"
      />
      <path
        d="M18.4 21.6 A3 6.5 0 0 1 18.4 32.4"
        fill="none"
        stroke={PALETTE.shadow}
        strokeWidth="1.4"
        opacity=".8"
      />

      {/* Far rim, and a rolling chock kicked in at the near foot. */}
      <path
        d="M83.6 21.4 C84.4 23 84.4 31 83.6 32.6"
        fill="none"
        stroke={PALETTE.seam}
        strokeWidth=".8"
        opacity=".7"
      />
      <path d="M12.4 41 L16.6 35.4 L20.4 41 Z" fill={TIMBER_LIT} stroke={PALETTE.line} strokeWidth=".7" />
      <path d="M14.6 39.8 L18.2 39.7" stroke={TIMBER} strokeWidth=".7" opacity=".9" />
      <g stroke={TIMBER_LIT} strokeWidth=".6" opacity=".7">
        <line x1="24" y1="37.4" x2="34" y2="37.2" />
        <line x1="63.6" y1="36.6" x2="72.2" y2="36.5" />
      </g>
    </VehicleSvg>
  );
}
