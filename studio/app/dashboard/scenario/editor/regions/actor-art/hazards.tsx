"use client";

import {
  Body,
  FILL,
  Ground,
  PALETTE,
  Seam,
  VehicleSvg,
} from "../vehicle-art/parts";
import {
  CARD,
  CARD_DEEP,
  CARD_LIT,
  LEAF,
  LEAF_DEEP,
  LEAF_LIT,
  TIMBER,
  TIMBER_LIT,
  leaf,
  tube,
} from "./prop-parts";

/**
 * Loose road hazards — shed, dropped or blown into the lane.
 *
 * Same stage as the vehicle fleet: a 96x48 side elevation facing right, the
 * ground at `GROUND`, nothing below it but the contact shadow.
 */

/* ================================================================== */
/* Hazards                                                            */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Tire debris                                                         */
/* ------------------------------------------------------------------ */

/**
 * The carcass: a band of tread peeled off the casing and still holding a bit
 * of its old radius. Lopsided on purpose — a symmetric arch reads as a croissant.
 */
const TD_CURL =
  "M18.4 40.8 C15.8 32 19.4 23.6 26.8 20 C34 16.6 42.6 18.4 48.4 23.6 " +
  "C52.4 27.2 55 31.4 57.6 35.2 L50.8 36.8 " +
  "C48.4 32.8 46.2 29.2 43 26.8 C38.4 23.4 32.4 24 28.8 27.8 " +
  "C25.2 31.6 24.8 36.2 26.2 40.8 Z";

/**
 * Tread notches, cut into the outer band only. Full-thickness bars turn the
 * whole carcass into a candy stripe; these stop short and read as tread.
 */
const TD_NOTCHES: readonly (readonly [number, number, number, number])[] = [
  [18.6, 37.4, 21.1, 36.9],
  [17.8, 32.4, 21.2, 32.7],
  [19.6, 27.4, 21.6, 28.1],
  [23.4, 23.2, 26.2, 25.4],
  [28.6, 20.2, 29.6, 21.9],
  [34.6, 18.4, 35.2, 22.1],
  [40.8, 19.4, 40.3, 21.5],
  [46.2, 22.6, 44.2, 25.1],
  [50.6, 27, 48.7, 28],
  [54.4, 31.4, 51.2, 31.9],
];

/** Steel belt wire, sprung out of every torn end. */
const TD_FRAYS =
  "M74.4 36.6 L79.6 34.8 M74.8 38 L80.6 38.2 M73.8 39.4 L78.4 41 " +
  "M73.4 30.8 L78.6 28.6 M73.2 32.4 L79 32.6 " +
  "M39.2 12.4 L43.6 9.6 M39.6 13.8 L45 13.2 M39 15.2 L43.4 16.4";

/** Shredded truck retread: curled carcass, flailing strips, crumb rubber. */
export function TireDebris() {
  return (
    <VehicleSvg id={"hazard.tire_debris"}>
      <Ground x={14} width={70} />

      {/* Strips torn off the carcass, behind it. */}
      <g>
        <Body
          d="M27.4 19.8 C29.6 15.4 33.6 12.4 38.4 11.6 L39.6 14.4 C35.8 15.4 32.6 17.8 30.6 21.6 Z"
          outline={0.7}
        />
        <Body
          d="M55.6 31 C61.6 28.4 68.4 28.6 73.6 31.4 L72.2 34 C67.6 31.8 62 31.8 57 34.2 Z"
          outline={0.7}
        />
        <Body
          d="M57.4 35 C63.6 32.8 70 34 74.6 37.4 L72.4 40.2 C68.4 37.4 63.6 36.6 58.8 38.4 Z"
          outline={0.7}
        />
      </g>
      <path d={TD_FRAYS} stroke={PALETTE.chrome} strokeWidth=".7" opacity=".65" strokeLinecap="round" />

      {/* The curl, sunk to rubber so the notches read as tread and not stripes. */}
      <Body d={TD_CURL} />
      <path d={TD_CURL} fill={PALETTE.tire} opacity=".5" />
      <g stroke={PALETTE.shadow} strokeWidth="1.5" opacity=".85" strokeLinecap="round">
        {TD_NOTCHES.map(([x1, y1, x2, y2]) => (
          <line key={`${x1}-${y1}`} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
      <path
        d="M21.4 34.4 C21 28.4 25 23.2 30.8 21 C36.8 18.8 43.6 20.6 48 25.2 C50.8 28.2 53 31.6 54.8 34.8"
        fill="none"
        stroke={PALETTE.tireWall}
        strokeWidth="1.1"
        opacity=".8"
        strokeLinecap="round"
      />
      <Seam
        d="M26.6 39.6 C25.4 33 28.8 27.6 34.6 25.8 C40.6 24 46.2 26.6 49.8 31.4"
        width={0.8}
        opacity={0.4}
      />

      {/* Crumb rubber flung across the lane. */}
      <g fill={PALETTE.tire} stroke={PALETTE.tireWall} strokeWidth=".5">
        <path d="M14.6 39.4 L16.8 38.8 L17.2 40.4 L15 40.8 Z" />
        <path d="M32.6 39.8 L35 39.4 L35.4 40.9 L33 41 Z" />
        <path d="M42 38.4 L44.4 37.8 L45 39.4 L42.6 39.8 Z" />
        <path d="M62.4 40 L64.8 39.6 L65.2 41 L62.6 41 Z" />
        <path d="M81.6 36.4 L84 35.8 L84.6 37.4 L82 37.8 Z" />
        <path d="M85.8 39.6 L88.4 39 L88.8 40.6 L86.2 41 Z" />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Cardboard box                                                       */
/* ------------------------------------------------------------------ */

/** Front face: taller than it is wide-open, with the right corner stoved in. */
const CB_FRONT =
  "M28.6 40.2 L29 17.6 L67.4 17.4 L67.6 24.8 " +
  "C63.8 26.8 63.4 30 66.4 32.2 L68 40.2 Z";

/** The receding right wall, and the dark you can see down inside. */
const CB_SIDE = "M67.4 17.4 L72.4 13.6 L73.8 35 L68 40.2 Z";
const CB_MOUTH = "M29 17.6 L34 13.8 L72.4 13.6 L67.4 17.4 Z";

/** Three flaps sprung open, each a full flap face rather than a stick. */
const CB_FLAP_NEAR = "M29.2 17.8 L33.6 13.6 L21.8 2.6 L17.2 6.6 Z";
const CB_FLAP_FAR = "M34 13.8 L72.4 13.6 L74.6 5.2 L37.6 5.6 Z";
const CB_FLAP_RIGHT = "M67.6 17.2 L72.4 13.6 L84.2 20.2 L79.6 24.4 Z";

/** Fluting exposed along the cut edge of the near flap. */
const CB_FLUTING =
  "M17.2 6.6 L18.1 7 L18.6 5.9 L19.5 6.3 L20 5.2 " +
  "L20.9 5.6 L21.4 4.5 L21.8 2.6";

/** Crushed shipping carton dumped on the kerb, flaps sprung open. */
export function CardboardBox() {
  return (
    <VehicleSvg id={"hazard.cardboard_box"}>
      <Ground x={18} width={62} />

      {/* Far flap leaning back, behind everything. */}
      <path d={CB_FLAP_FAR} fill={CARD} stroke={PALETTE.line} strokeWidth=".8" strokeLinejoin="round" />
      <path d={CB_FLAP_FAR} fill={FILL.gloss} opacity=".5" />
      <path d="M46.2 13.7 L50.4 13.7 L50.8 5.5 L46.6 5.5 Z" fill="#d5dce7" opacity=".28" />

      {/* Open mouth and the receding side wall. */}
      <path d={CB_MOUTH} fill={PALETTE.shadow} />
      <path d={CB_SIDE} fill={CARD_DEEP} stroke={PALETTE.line} strokeWidth=".8" strokeLinejoin="round" />
      <path d={CB_SIDE} fill={FILL.gloss} opacity=".5" />

      {/* Front face: tinted shell, kraft wash, gloss, cut edge. */}
      <path d={CB_FRONT} fill="currentColor" />
      <path d={CB_FRONT} fill={CARD} opacity=".45" />
      <path d={CB_FRONT} fill={FILL.gloss} />
      <path d={CB_FRONT} fill="none" stroke={PALETTE.line} strokeWidth="1" strokeLinejoin="round" />
      <path d="M29 17.7 L67.4 17.5" stroke={CARD_LIT} strokeWidth="1" opacity=".8" />

      {/* The crush, and the creases running out of it. */}
      <path
        d="M67.6 24.8 C63.8 26.8 63.4 30 66.4 32.2 L59.6 31.6 L60.4 26.2 Z"
        fill={PALETTE.shadow}
        opacity=".4"
      />
      <Seam d="M64.6 28.8 C57.6 28 50 27.8 43.2 28.4" width={0.8} opacity={0.5} />
      <Seam d="M37.4 18 C38.6 25.6 38.4 32.8 36.8 39.8" width={0.7} opacity={0.4} />
      <Seam d="M55 17.6 C56.2 24.4 56.4 32 55.4 39.9" width={0.7} opacity={0.35} />

      {/* Split tape, still stuck to both rims. */}
      <path d="M45.6 17.5 L49.8 17.5 L50 23 L45.8 23 Z" fill="#d5dce7" opacity=".3" />
      <path
        d="M45.8 23 C44 25.4 43.6 27.6 44.4 29.8 L47.6 29 C47 27.2 47.4 25.4 49.2 23.6 Z"
        fill="#d5dce7"
        opacity=".22"
      />

      {/* Near flap sprung up, fluting showing on its cut edge. */}
      <path d={CB_FLAP_NEAR} fill={CARD_LIT} stroke={PALETTE.line} strokeWidth=".8" strokeLinejoin="round" />
      <path d={CB_FLAP_NEAR} fill={FILL.gloss} opacity=".45" />
      <path d="M17.2 6.6 L29.2 17.8" stroke={CARD_DEEP} strokeWidth=".7" opacity=".7" />
      <path d={CB_FLUTING} fill="none" stroke={CARD_DEEP} strokeWidth=".8" strokeLinejoin="round" />

      {/* Right flap folded out over the kerb. */}
      <path d={CB_FLAP_RIGHT} fill={CARD_LIT} stroke={PALETTE.line} strokeWidth=".8" strokeLinejoin="round" />
      <path d={CB_FLAP_RIGHT} fill={FILL.gloss} opacity=".45" />
      <path d="M79.6 24.4 L67.6 17.2" stroke={CARD_DEEP} strokeWidth=".7" opacity=".7" />

      {/* Soggy foot where it has sat in the gutter. */}
      <path
        d="M28.8 37.6 C40 38.8 56 38.8 68 37.6 L68 40.2 L28.6 40.2 Z"
        fill={CARD_DEEP}
        opacity=".5"
      />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Trash bags                                                          */
/* ------------------------------------------------------------------ */

const TB_LEFT =
  "M17.6 40.8 C14.4 32.6 17 22.8 24.8 17.8 L22.8 13.4 " +
  "C22.4 12.4 23 11.6 24 11.8 L29.8 13 C30.8 13.2 31.2 14.1 30.6 14.8 " +
  "L28 17.8 C36.6 22.4 39.6 32 37.2 40.8 Z";

const TB_MIDDLE =
  "M35.6 40.8 C33 33.4 36.2 25.6 43.6 21.6 L42 17.8 " +
  "C41.6 16.9 42.2 16.2 43.2 16.4 L48.6 17.6 C49.6 17.8 49.9 18.7 49.2 19.3 " +
  "L46.8 21.6 C54.8 25.6 57.6 33.4 55.8 40.8 Z";

const TB_RIGHT =
  "M54.8 40.8 C53.2 34.8 56.2 28 62.8 24.6 L61.6 21.4 " +
  "C61.2 20.6 61.8 20 62.6 20.2 L67.2 21.2 C68 21.4 68.2 22.2 67.6 22.7 " +
  "L65.6 24.6 C72.2 28.2 74.6 34.8 73.2 40.8 Z";

/** Three bin bags propped against each other, one of them already split. */
export function TrashBags() {
  return (
    <VehicleSvg id={"hazard.trash_bags"}>
      <Ground x={12} width={70} />

      <Body d={TB_LEFT} />
      <Seam d="M22 22.6 C18.8 28.4 18 34.6 19.4 39.8" width={1} opacity={0.45} />
      <Seam d="M31.4 23.4 C34.4 28.4 35.4 34.4 34.6 39.8" width={0.9} opacity={0.4} />
      <path
        d="M24.4 21.4 C21.6 26.2 20.6 31.6 21.4 36.6"
        fill="none"
        stroke="#c9d6e6"
        strokeWidth="1.2"
        opacity=".22"
        strokeLinecap="round"
      />
      <path
        d="M23.2 13.2 L20.4 10.6 M30.2 14.2 L33.6 12.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />

      <Body d={TB_MIDDLE} />
      <Seam d="M41.4 25.4 C38.4 30.4 37.6 35.8 38.6 39.8" width={0.9} opacity={0.45} />
      <Seam d="M49.6 25.8 C52.4 30.4 53.4 35.4 52.8 39.8" width={0.8} opacity={0.4} />
      <path
        d="M43.8 24.6 C41.4 28.6 40.6 33 41.2 37"
        fill="none"
        stroke="#c9d6e6"
        strokeWidth="1.1"
        opacity=".2"
        strokeLinecap="round"
      />
      <path
        d="M42.4 17.6 L39.8 15.4 M48.8 18.6 L51.8 17.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />

      <Body d={TB_RIGHT} />
      <Seam d="M60.6 27.8 C58 32 57.4 36.4 58.2 39.8" width={0.8} opacity={0.45} />
      <path
        d="M62 21.2 L59.6 19.2 M67.4 22.1 L70 20.9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />

      {/* Split seam on the right-hand bag, with the contents coming out. */}
      <path d="M62 28.6 L67 31.4 L62.6 35 Z" fill="#05090e" />
      <path d="M62.8 29.8 L66.2 31 L65 33.8 L62.4 32.6 Z" fill="#c9d2de" opacity=".85" />
      <path d="M64.8 32.4 L67.8 33.6 L66.8 36 L64 34.8 Z" fill={PALETTE.chrome} opacity=".8" />
      <path d="M66.2 30 L69.6 29.2 L69.2 31.4 L66.6 31.6 Z" fill={PALETTE.amber} opacity=".7" />
      <g fill="#c9d2de" opacity=".7">
        <path d="M74.6 38.6 L78.4 37.8 L78.8 40.4 L75 40.8 Z" />
        <path d="M12.8 39.4 L15.8 38.8 L16.2 40.8 L13.2 41 Z" />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Downed branch                                                       */
/* ------------------------------------------------------------------ */

/** The limb: bowed, thick and splintered at the butt, whippy at the tip. */
const DB_LIMB =
  "M10.6 41 C9.4 38.2 9.4 35.8 10.4 34 " +
  "C21 32.2 33 30 45.6 27.6 C60 24.8 74 22.4 86.2 20.6 " +
  "L86.4 23.2 C74.2 25.4 60.4 28 46.2 30.8 " +
  "C34 33.2 22.4 35.6 13.4 38 C12.6 39 12 40 11.9 41 Z";

/** Underside, sunk a tone so the limb turns instead of reading as a plank. */
const DB_UNDERSIDE =
  "M86.4 23.2 C74.2 25.4 60.4 28 46.2 30.8 " +
  "C34 33.2 22.4 35.6 13.4 38 C12.6 39 12 40 11.9 41 " +
  "L13.8 41 C14.6 39.4 15.6 38.4 17 37.8 C30 35 58 29.2 86.4 24.8 Z";

/** Swollen knuckles where each fork leaves the limb. */
const DB_KNUCKLES: readonly (readonly [number, number, number])[] = [
  [25.6, 32.8, -11],
  [47.4, 28.8, -10],
  [68.6, 24.8, -9],
];

/** Fresh splinters where it tore off the trunk. */
const DB_SPLINTERS =
  "M10.4 34 L4.6 32.2 L9.4 35.2 L3.2 35.8 L9.6 37.2 L4 39.4 " +
  "L10.2 38.8 L7.6 41 L11.4 41 L11 34.2 Z";

/** Bark: short strokes running with the grain, never a cross-hatch. */
const DB_BARK =
  "M15 36.4 C20 35.4 25 34.4 30 33.4 M16.6 38 C21 37.2 25.6 36.4 30 35.6 " +
  "M34 32.4 C39 31.4 44 30.4 49 29.4 M35.4 34 C40 33.2 44.6 32.4 49 31.6 " +
  "M53 28.4 C59 27.2 65 26.2 71 25 M54 29.8 C60 28.8 66 27.8 72 26.6 " +
  "M75 24.2 C79 23.6 83 23 86 22.4";

/** Leaf clusters left on the forks. */
const DB_FOLIAGE = (
  [
    [17.4, 15.6, 7, 205],
    [14.2, 19.2, 6.4, 250],
    [20.4, 19.8, 6, 160],
    [15.8, 13, 5.4, 285],
    [21.4, 14.4, 5.6, 335],
    [52.4, 10.4, 6.6, 250],
    [48.6, 13, 6, 200],
    [56, 13.2, 5.8, 320],
    [51.4, 6.6, 5.2, 285],
    [78.6, 11.6, 6.2, 210],
    [82.4, 14.6, 5.6, 340],
    [75.4, 15.2, 5.4, 160],
  ] as const
)
  .map(([cx, cy, len, deg]) => leaf(cx, cy, len, deg))
  .join("");

/** The lit half of the same clusters, a size down and offset into the light. */
const DB_FOLIAGE_LIT = (
  [
    [16.4, 14.2, 4.6, 205],
    [19.6, 18.2, 4, 165],
    [51.2, 9.4, 4.4, 250],
    [54.8, 12.2, 3.8, 320],
    [77.6, 10.6, 4.2, 210],
    [81.2, 13.6, 3.6, 340],
  ] as const
)
  .map(([cx, cy, len, deg]) => leaf(cx, cy, len, deg))
  .join("");

/** Storm-dropped limb lying across the lane, still in leaf. */
export function DownedBranch() {
  return (
    <VehicleSvg id={"hazard.downed_branch"}>
      <Ground x={6} width={84} />

      {/* Secondary forks, under the main limb so they grow out of it. */}
      <g fill={TIMBER}>
        <path d={tube(26, 32.4, 18.4, 18.6, 3.4)} />
        <path d={tube(18.4, 18.6, 15.4, 12.4, 1.8)} />
        <path d={tube(20.4, 22.4, 24.6, 17.6, 1.4)} />
        <path d={tube(48, 29, 52.2, 12.6, 3)} />
        <path d={tube(52.2, 12.6, 50.8, 7, 1.6)} />
        <path d={tube(50.4, 19.6, 55.8, 15.4, 1.3)} />
        <path d={tube(69, 24.8, 78.4, 13.6, 2.6)} />
        <path d={tube(78.4, 13.6, 82.6, 10.4, 1.4)} />
        <path d={tube(58.4, 27, 62.8, 34.6, 2)} />
        <path d={tube(62.8, 34.6, 66.4, 38.4, 1.2)} />
      </g>

      {/* Foliage on the fork ends. */}
      <path d={DB_FOLIAGE} fill={LEAF} stroke={LEAF_DEEP} strokeWidth=".5" strokeLinejoin="round" />
      <path d={DB_FOLIAGE_LIT} fill={LEAF_LIT} opacity=".9" />

      {/* Main limb: bowed shell, timber wash, gloss, then a soft cut edge. */}
      <path d={DB_LIMB} fill="currentColor" />
      <path d={DB_LIMB} fill={TIMBER} opacity=".45" />
      <path d={DB_LIMB} fill={FILL.gloss} />
      <path d={DB_UNDERSIDE} fill={PALETTE.shadow} opacity=".4" />
      <path d={DB_LIMB} fill="none" stroke={PALETTE.line} strokeWidth=".8" strokeLinejoin="round" opacity=".8" />
      {DB_KNUCKLES.map(([cx, cy, deg]) => (
        <ellipse
          key={cx}
          cx={cx}
          cy={cy}
          rx="3.6"
          ry="2.5"
          transform={`rotate(${deg} ${cx} ${cy})`}
          fill={TIMBER}
          stroke={CARD_DEEP}
          strokeWidth=".6"
        />
      ))}
      <path d={DB_BARK} fill="none" stroke={CARD_DEEP} strokeWidth=".7" opacity=".8" strokeLinecap="round" />
      <path
        d="M12 35.2 L47.2 28.6 L85.8 21.6"
        fill="none"
        stroke={TIMBER_LIT}
        strokeWidth=".8"
        opacity=".55"
      />

      {/* Splintered break at the butt, fresh wood showing. */}
      <path d={DB_SPLINTERS} fill={TIMBER_LIT} stroke={PALETTE.line} strokeWidth=".6" strokeLinejoin="round" />
      <path d="M9.4 36 L6.4 35.8 M9.6 38.2 L6.8 39" stroke={CARD_DEEP} strokeWidth=".6" opacity=".8" />

      {/* Twigs, and a few leaves knocked off in the fall. */}
      <g stroke={TIMBER} strokeWidth="1" strokeLinecap="round" fill="none">
        <path d="M33.4 30.6 C34.6 27.4 36.6 25.4 39.4 24.4" />
        <path d="M64.4 26.4 C63.4 29 63.6 31.4 64.8 33.4" />
      </g>
      <path
        d={leaf(39.8, 23.4, 4.4, 300) + leaf(30.8, 39.2, 4, 20) + leaf(72, 38, 4.2, 340)}
        fill={LEAF}
        opacity=".9"
      />
    </VehicleSvg>
  );
}
