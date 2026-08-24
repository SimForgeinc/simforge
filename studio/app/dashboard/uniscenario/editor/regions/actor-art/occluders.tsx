"use client";

import {
  Body,
  FILL,
  GROUND,
  Ground,
  PALETTE,
  Seam,
  VehicleSvg,
  Wheel,
} from "../vehicle-art/parts";
import {
  HORIZON,
  LEAF,
  LEAF_DEEP,
  LEAF_LIT,
  RUST,
  SOIL,
  STRAP,
  TIMBER,
  tube,
} from "./prop-parts";

/**
 * Sight-line blockers. The two "run" props are drawn in one-point perspective with the vanishing point off to the right at `HORIZON`, so they read as a length of boundary rather than one object.
 *
 * Same stage as the vehicle fleet: a 96x48 side elevation facing right, the
 * ground at `GROUND`, nothing below it but the contact shadow.
 */

/* ================================================================== */
/* Occluders                                                          */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Dumpster                                                            */
/* ------------------------------------------------------------------ */

/** Skip profile: tall at the hinge end, raked hard down to the low front lip. */
const DP_BODY = "M16.4 38.4 L15 17.4 L47.6 16.8 L79.6 26.4 L79 38.6 Z";

/** Looking into it: the near rim, and the far rim standing higher behind. */
const DP_MOUTH = "M15 17.4 L47.6 16.8 L79.6 26.4 L79.8 24.2 L48 14.4 L15.2 15 Z";

/** Lid hinged at the rear, thrown right back past vertical. */
const DP_LID = tube(15.6, 17.2, 7.4, 4.2, 4.2);

/** Corrugation: folded panels with a lit return, not hairlines. */
const DP_RIBS: readonly (readonly [number, number])[] = [
  [21, 17.3],
  [27, 17.2],
  [33, 17.1],
  [39, 17],
  [45, 16.9],
  [51, 17.9],
  [57, 19.7],
  [63, 21.5],
  [69, 23.3],
  [75, 25.1],
];

const DP_RIB_SHADE = DP_RIBS.map(
  ([x, y]) => `M${x} ${y + 1.6} L${x + 1.4} ${y + 1.6} L${x + 1.4} 36 L${x} 36 Z`,
).join("");

const DP_RIB_LIT = DP_RIBS.map(
  ([x, y]) => `M${x + 1.4} ${y + 1.6} L${x + 2.2} ${y + 1.6} L${x + 2.2} 36 L${x + 1.4} 36 Z`,
).join("");

/** Steel skip stood open: lid thrown back, mouth dark, rusted at the sill. */
export function Dumpster() {
  return (
    <VehicleSvg id={"occluder.dumpster"}>
      <Ground x={12} width={74} />

      {/* Casters on their brackets. */}
      <g fill={PALETTE.bodyShade}>
        {[22, 32, 63, 73].map((x) => (
          <rect key={x} x={x - 2} y="35.4" width="4" height="3.4" rx="1" />
        ))}
      </g>
      <Wheel cx={22} cy={38.4} r={2.6} spokes={false} />
      <Wheel cx={32} cy={38.4} r={2.6} spokes={false} />
      <Wheel cx={63} cy={38.4} r={2.6} spokes={false} />
      <Wheel cx={73} cy={38.4} r={2.6} spokes={false} />

      {/* The open mouth: far rim above the near one, dark between. */}
      <path d={DP_MOUTH} fill={PALETTE.shadow} />
      <path
        d="M15.2 15 L48 14.4 L79.8 24.2"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".9"
        opacity=".7"
      />

      <Body d={DP_BODY} />

      {/* Corrugated flank: folded panel, then its lit return. */}
      <path d={DP_RIB_SHADE} fill={PALETTE.bodyShade} opacity=".5" />
      <path d={DP_RIB_LIT} fill={PALETTE.chrome} opacity=".1" />

      {/* Top rail and the diagonal brace across the rear panel. */}
      <path
        d="M15.4 19.2 L47.6 18.6 L79.4 28.2 L79.3 29.8 L47.6 20.2 L15.4 20.8 Z"
        fill={FILL.metal}
        opacity=".3"
      />
      <path d={tube(19.6, 34.8, 44.6, 20.2, 1.9)} fill={PALETTE.bodyShade} opacity=".8" />

      {/* Fork pockets, sunk into the flank. */}
      <g>
        <rect x="24" y="27.6" width="14" height="5" rx="1" fill={PALETTE.shadow} />
        <rect x="24" y="31.2" width="14" height="1.4" rx=".6" fill={FILL.metal} opacity=".35" />
        <rect x="56" y="30.2" width="14" height="5" rx="1" fill={PALETTE.shadow} />
        <rect x="56" y="33.8" width="14" height="1.4" rx=".6" fill={FILL.metal} opacity=".35" />
      </g>

      {/* Rust blooming out of the sill and weeping from the pockets. */}
      <g fill={RUST}>
        <path d="M17 32.4 C20.4 33.6 23.4 35 26.4 35.4 L26.6 36.2 L17.2 36.1 Z" opacity=".4" />
        <path d="M40 34 C44.4 34.8 48.4 35.4 52 35.6 L52 36.3 L40 36.2 Z" opacity=".32" />
        <path d="M61 35 C65 35.4 69.4 35.7 74 35.8 L74 36.4 L61 36.3 Z" opacity=".28" />
        <path d="M30.4 32.8 C30.8 34.2 30.4 35.2 30.8 36.2 L32.2 36.2 C32.4 35 32 34 32.4 32.8 Z" opacity=".5" />
        <path d="M62.6 35.4 C63 36.4 62.8 37.4 63 38.3 L64.2 38.3 C64.4 37.4 64.2 36.4 64.4 35.4 Z" opacity=".45" />
      </g>

      {/* Bottom rail and hinge knuckles. */}
      <path d="M16 35.8 L79.2 35.6 L79 38.6 L16.4 38.4 Z" fill={PALETTE.bodyShade} />
      <path d="M16.2 36.2 L79.1 36" stroke={PALETTE.line} strokeWidth=".7" opacity=".5" />

      {/* Lid: outer skin, shaded underside, stiffening ribs, lip. */}
      <Body d={DP_LID} outline={1} />
      <path d={tube(15.6, 17.2, 7.4, 4.2, 1.7)} fill={PALETTE.bodyShade} opacity=".75" />
      <g stroke={PALETTE.seam} strokeWidth=".8" opacity=".65">
        <line x1="11.2" y1="9.6" x2="14.6" y2="12.4" />
        <line x1="8.8" y1="12.6" x2="12.2" y2="15.4" />
      </g>
      <path d={tube(5.6, 6.2, 9.2, 2.8, 2)} fill={FILL.metal} opacity=".6" />
      <g fill={FILL.metal} stroke={PALETTE.rimShade} strokeWidth=".5">
        <circle cx="15.4" cy="17.4" r="1.6" />
        <circle cx="15.4" cy="17.4" r=".5" fill={PALETTE.shadow} />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Covered car                                                         */
/* ------------------------------------------------------------------ */

/**
 * A fitted cover reads as a car only if the hem cuts up over both arches and
 * the roofline stays soft — no hard corners anywhere in this silhouette.
 */
const CC_COVER =
  "M9.6 36 C8.4 31.8 10.4 28.8 14 27.4 L24.4 24.8 " +
  "C27.2 22.2 31 18.6 34.8 16.6 C37.6 15.1 40.8 14.5 44.2 14.5 " +
  "L58.4 14.8 C62.4 15 65.8 16.5 68.6 19.1 L75.8 25.9 L84.6 28.3 " +
  "C88.2 29.5 89.4 32.6 88.2 36 " +
  "C85.8 36.8 82.6 36.2 80.6 34.4 " +
  "C79.4 31.4 75.6 30.2 72 30.8 C68.4 31.4 65.6 33.8 65.2 36.8 " +
  "C56 37.8 42 37.8 33.4 36.8 " +
  "C33 33.4 30 31 26.4 31.2 C22.8 31.4 19.8 33.8 18.8 36.6 " +
  "C15.6 37 12.2 36.8 9.6 36 Z";

/** Car put away under a fitted cover: arches, folds, straps, tyres below. */
export function CoveredCar() {
  return (
    <VehicleSvg id={"occluder.covered_car"}>
      <Ground x={6} width={84} />

      <Wheel cx={26.6} cy={35.4} r={5.6} />
      <Wheel cx={71.2} cy={35.4} r={5.6} />

      <Body d={CC_COVER} />

      {/* Folds: one long slack fold along the flank, creases off the arches. */}
      <Seam d="M18 31.4 C34 34.6 60 34.8 80 31.8" width={1} opacity={0.5} />
      <Seam d="M36.4 17.4 C44 19 56 19.2 66.4 18.2" width={0.9} opacity={0.55} />
      <Seam d="M24.8 24.9 C28 26.6 30.4 28.6 31.8 31" width={0.8} opacity={0.5} />
      <Seam d="M75.6 26 C74.2 27.6 73 29.2 72.4 30.8" width={0.8} opacity={0.5} />
      <Seam d="M46 15 C45.2 20.4 45.4 26.4 46.4 31.2" width={0.7} opacity={0.4} />

      {/* The mirror pushing a bump into the fabric — the cue that says "car". */}
      <path
        d="M35.2 19.6 C33 19.2 31.6 20.4 31.8 22 C32 23.2 33.4 23.6 34.6 23 Z"
        fill="currentColor"
        stroke={PALETTE.line}
        strokeWidth=".7"
      />

      {/* Tie-down straps under the sills, with their buckles. */}
      <g fill={STRAP}>
        <path d={tube(31.4, 18.6, 29.2, 36.4, 2.4)} />
        <path d={tube(63.6, 17.4, 63.4, 37.2, 2.2)} />
        <rect x="28.2" y="28.4" width="3.4" height="2.6" rx=".7" fill={PALETTE.rimShade} />
        <rect x="62" y="27.6" width="3.2" height="2.6" rx=".7" fill={PALETTE.rimShade} />
      </g>

      {/* Hem: elastic edge with the drape puckering along it. */}
      <path
        d="M9.8 35.6 C22 37.6 40 38.4 52 38.4 C66 38.4 79 37.6 88 35.8"
        fill="none"
        stroke={PALETTE.bodyShade}
        strokeWidth="1.4"
        opacity=".8"
      />
      <g stroke={PALETTE.seam} strokeWidth=".6" opacity=".45">
        {[38, 44, 50, 56, 62].map((x) => (
          <line key={x} x1={x} y1="34.6" x2={x} y2="37.9" />
        ))}
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Hedge run                                                           */
/* ------------------------------------------------------------------ */

const HR_BUMPS = 11;

/** Lumpy clipped top: scallops shrink with distance, so the run recedes. */
const HR_TOP = Array.from({ length: HR_BUMPS }, (_, index) => {
  const from = index / HR_BUMPS;
  const to = (index + 1) / HR_BUMPS;
  const sx = 8 + 79 * from;
  const ex = 8 + 79 * to;
  const sy = 13.6 + 6.4 * from;
  const ey = 13.6 + 6.4 * to;
  const lift = 3.4 * (1 - from * 0.7);
  return (
    ` C${(sx + (ex - sx) * 0.22).toFixed(1)} ${(sy - lift).toFixed(1)} ` +
    `${(sx + (ex - sx) * 0.78).toFixed(1)} ${(ey - lift).toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`
  );
}).join("");

/** Skirt broken by stem gaps, so the base is foliage and not a ruled line. */
const HR_BASE =
  " C78 36.2 70 34.6 62 35.8 C54 37 46 35.4 38 36.8 " +
  "C30 38.2 22 36.6 14 38.4 C11 39 9 39.2 7.6 39.2 Z";

const HR_MASS = `M7.6 39.2 L8 13.6${HR_TOP} L86.6 34.4${HR_BASE}`;

/** Three staggered rows of clumps, each shrinking down the run. */
const HR_CLUMPS = Array.from({ length: 24 }, (_, index) => {
  const row = index % 3;
  const s = Math.min((Math.floor(index / 3) + row * 0.34) / 8, 1);
  const r = (5.6 - 3.5 * s) * (row === 1 ? 0.9 : 1);
  return [8.4 + 78 * s + row * 1.8, 16.8 + 6 * s + row * r * 1.55, r] as const;
});

/** Trunks standing in the gaps under the skirt, thinning with distance. */
const HR_TRUNKS: readonly (readonly [number, number, number])[] = [
  [14, 38.6, 1.8],
  [33, 37.6, 1.4],
  [53, 36.6, 1.1],
  [70, 35.8, 0.9],
];

/** Clipped boundary hedge running away to the right. */
export function HedgeRun() {
  return (
    <VehicleSvg id={"occluder.hedge_run"}>
      <Ground x={4} width={88} />

      {/* Soil and the bare stems in the shadow under the skirt. */}
      <path d="M8 39.6 L87 34.8 L87 36.4 L8 41 Z" fill={SOIL} opacity=".85" />
      <path d="M8.4 37.4 L86.8 33.2 L86.8 35.4 L8.4 39.6 Z" fill={PALETTE.shadow} opacity=".6" />
      {HR_TRUNKS.map(([x, base, w]) => (
        <path key={x} d={tube(x, base, x + 0.6, base - 6, w)} fill={TIMBER} />
      ))}

      {/* Mass: tinted shell sunk to a deep green, so clumps have somewhere to sit. */}
      <path d={HR_MASS} fill="currentColor" />
      <path d={HR_MASS} fill={LEAF_DEEP} opacity=".62" />
      <path d={HR_MASS} fill={FILL.gloss} />

      {/* Mid-green clumps break the silhouette; lit crowns sit on top of them. */}
      <g fill={LEAF} opacity=".92">
        {HR_CLUMPS.map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
        ))}
      </g>
      <g fill={LEAF_LIT} opacity=".85">
        {HR_CLUMPS.filter((_, index) => index % 2 === 0).map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx - r * 0.34} cy={cy - r * 0.44} r={r * 0.54} />
        ))}
      </g>
      <g fill={LEAF_DEEP} opacity=".7">
        <circle cx="21" cy="36.4" r="3.4" />
        <circle cx="43" cy="35.2" r="2.8" />
        <circle cx="66" cy="34.2" r="2.2" />
        <circle cx="80" cy="33.4" r="1.8" />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Fence run                                                           */
/* ------------------------------------------------------------------ */

/*
 * Projective spacing. `u` walks the run evenly in world space; `s` is where
 * that lands on screen, so pickets bunch up and shrink toward the right and
 * every horizontal converges on HORIZON. The far end is 42% of near size.
 */
const FENCE_NEAR_X = 8;
const FENCE_FAR_X = 88;
const FENCE_FAR_SCALE = 0.42;
const FENCE_NEAR_TOP = 12;
const FENCE_NEAR_BASE = 40.8;
const FENCE_FAR_TOP = HORIZON - (HORIZON - FENCE_NEAR_TOP) * FENCE_FAR_SCALE;
const FENCE_FAR_BASE = HORIZON + (FENCE_NEAR_BASE - HORIZON) * FENCE_FAR_SCALE;

/** Screen parameter for a point `u` (0 near, 1 far) along the run. */
function fenceAt(u: number) {
  const s = (2.2 * u) / (1 + 1.2 * u);
  return {
    s,
    x: FENCE_NEAR_X + (FENCE_FAR_X - FENCE_NEAR_X) * s,
    top: FENCE_NEAR_TOP + (FENCE_FAR_TOP - FENCE_NEAR_TOP) * s,
    base: FENCE_NEAR_BASE + (FENCE_FAR_BASE - FENCE_NEAR_BASE) * s,
    w: 4.2 * (1 - s) + 4.2 * FENCE_FAR_SCALE * s,
  };
}

const FENCE_PICKET_COUNT = 17;

/** Every dog-eared picket as one path: 22 boards for the price of one node. */
const FENCE_PICKETS = Array.from({ length: FENCE_PICKET_COUNT + 1 }, (_, index) => {
  const { x, top, base, w } = fenceAt(index / FENCE_PICKET_COUNT);
  return (
    `M${x.toFixed(1)} ${(top + w * 0.55).toFixed(1)} ` +
    `L${(x + w * 0.5).toFixed(1)} ${top.toFixed(1)} ` +
    `L${(x + w).toFixed(1)} ${(top + w * 0.55).toFixed(1)} ` +
    `L${(x + w).toFixed(1)} ${base.toFixed(1)} ` +
    `L${x.toFixed(1)} ${base.toFixed(1)} Z`
  );
}).join("");

/** Nail heads on both rails, one per picket, again as a single path. */
const FENCE_NAILS = Array.from({ length: FENCE_PICKET_COUNT + 1 }, (_, index) => {
  const { s, x, w } = fenceAt(index / FENCE_PICKET_COUNT);
  const cx = x + w * 0.5;
  const r = (0.55 * (1 - s) + 0.28 * s).toFixed(2);
  const upper = (17.4 + (23 - 17.4) * s).toFixed(1);
  const lower = (32.5 + (29.3 - 32.5) * s).toFixed(1);
  return (
    `M${cx.toFixed(1)} ${upper} m-${r} 0 a${r} ${r} 0 1 0 ${Number(r) * 2} 0 a${r} ${r} 0 1 0 -${Number(r) * 2} 0 ` +
    `M${cx.toFixed(1)} ${lower} m-${r} 0 a${r} ${r} 0 1 0 ${Number(r) * 2} 0 a${r} ${r} 0 1 0 -${Number(r) * 2} 0`
  );
}).join("");

/** Posts stand proud of the boards, spaced four pickets apart. */
const FENCE_POSTS = [0, 0.22, 0.45, 0.68, 0.9] as const;

/** One dark edge per board, so a run of them reads as separate timber. */
const FENCE_BOARD_SHADE = Array.from({ length: FENCE_PICKET_COUNT + 1 }, (_, index) => {
  const { x, top, base, w } = fenceAt(index / FENCE_PICKET_COUNT);
  return (
    `M${(x + w * 0.7).toFixed(1)} ${(top + w * 0.5).toFixed(1)} ` +
    `L${(x + w).toFixed(1)} ${(top + w * 0.55).toFixed(1)} ` +
    `L${(x + w).toFixed(1)} ${base.toFixed(1)} ` +
    `L${(x + w * 0.7).toFixed(1)} ${base.toFixed(1)} Z`
  );
}).join("");

/** Timber picket fence marching off to the right over uneven ground. */
export function FenceRun() {
  return (
    <VehicleSvg id={"occluder.fence_run"}>
      <Ground x={4} width={88} />

      {/* Ground plane running back with the fence. */}
      <path d={`M2 ${GROUND} L89.8 32.4 L93 32.6 L93 ${GROUND} Z`} fill={SOIL} opacity=".4" />
      <path
        d={`M2 ${GROUND} C14 39.4 26 38 38 36.6 C56 34.6 74 33.4 89.8 32.4`}
        fill="none"
        stroke={SOIL}
        strokeWidth="1.2"
        opacity=".9"
      />

      {/* Rails, converging on the horizon, lit enough to read in the gaps. */}
      <path d="M8 16 L88 22.4 L88 23.6 L8 18.8 Z" fill={TIMBER} />
      <path d="M8 18.8 L88 23.6 L88 24.3 L8 19.9 Z" fill={PALETTE.shadow} opacity=".55" />
      <path d="M8 31 L88 28.7 L88 29.9 L8 34 Z" fill={TIMBER} />
      <path d="M8 34 L88 29.9 L88 30.6 L8 35.1 Z" fill={PALETTE.shadow} opacity=".55" />

      {/* Posts stand proud of the boards, four pickets apart. */}
      {FENCE_POSTS.map((u) => {
        const { x, top, base, w } = fenceAt(u);
        const pw = w * 1.8;
        const head = top - w * 1.1;
        return (
          <g key={u}>
            <path
              d={
                `M${(x - pw * 0.15).toFixed(1)} ${(head + w * 0.9).toFixed(1)} ` +
                `L${(x + pw * 0.5).toFixed(1)} ${head.toFixed(1)} ` +
                `L${(x + pw * 1.15).toFixed(1)} ${(head + w * 0.9).toFixed(1)} ` +
                `L${(x + pw).toFixed(1)} ${(base + w * 0.3).toFixed(1)} ` +
                `L${x.toFixed(1)} ${(base + w * 0.3).toFixed(1)} Z`
              }
              fill={TIMBER}
              stroke={PALETTE.line}
              strokeWidth=".7"
              strokeLinejoin="round"
            />
            <path
              d={
                `M${(x + pw * 0.66).toFixed(1)} ${(head + w * 1.3).toFixed(1)} ` +
                `L${(x + pw * 0.78).toFixed(1)} ${(base + w * 0.1).toFixed(1)}`
              }
              stroke={PALETTE.shadow}
              strokeWidth={w * 0.5}
              opacity=".45"
            />
          </g>
        );
      })}

      {/* Boards: tinted shell, timber wash, gloss, shaded edge, faint cut line. */}
      <path d={FENCE_PICKETS} fill="currentColor" />
      <path d={FENCE_PICKETS} fill={TIMBER} opacity=".5" />
      <path d={FENCE_PICKETS} fill={FILL.gloss} />
      <path d={FENCE_BOARD_SHADE} fill={PALETTE.shadow} opacity=".4" />
      <path
        d={FENCE_PICKETS}
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".5"
        strokeLinejoin="round"
        opacity=".5"
      />
      <path d={FENCE_NAILS} fill={PALETTE.rimShade} opacity=".9" />

      {/* One board sprung loose at the foot and leaning off its nails. */}
      <path
        d="M20.6 13.4 L24.6 13.6 L26.6 40.4 L22.4 40.6 Z"
        fill="currentColor"
        stroke={PALETTE.line}
        strokeWidth=".5"
        strokeLinejoin="round"
        opacity=".95"
      />
      <path d="M20.6 13.4 L24.6 13.6 L26.6 40.4 L22.4 40.6 Z" fill={TIMBER} opacity=".5" />
      <path d="M24.1 13.6 L26.6 40.4 L24.7 40.5 L22.9 13.5 Z" fill={PALETTE.shadow} opacity=".35" />

      {/* And one snapped off, leaving a hole you can see the dark through. */}
      <path d="M47.9 15.9 L50.6 15.9 L50.6 36.4 L47.9 36.4 Z" fill={PALETTE.shadow} opacity=".85" />
      <path
        d="M47.9 31.8 L48.9 33.2 L49.8 31.2 L50.6 31.8 L50.6 36.4 L47.9 36.4 Z"
        fill={TIMBER}
        stroke={PALETTE.line}
        strokeWidth=".5"
        strokeLinejoin="round"
      />

      {/* Grass at the foot of the run, shrinking with everything else. */}
      <path
        d={
          "M11.6 41 L13.4 36.6 L14.4 41 M31 39 L32.4 35.4 L33.4 38.8 " +
          "M53 37 L54 34.2 L54.8 36.8 M71 35.4 L71.8 33.4 L72.6 35.2"
        }
        fill="none"
        stroke={LEAF}
        strokeWidth="1.1"
        strokeLinejoin="round"
        opacity=".85"
      />
    </VehicleSvg>
  );
}
