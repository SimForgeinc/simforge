"use client";

import {
  Body,
  FILL,
  GROUND,
  Ground,
  PALETTE,
  Seam,
  VehicleSvg,
} from "../vehicle-art/parts";

/**
 * Animal catalog artwork: dog, cat, deer, raccoon, goose.
 *
 * Same contract as the fleet — right-facing side elevation in a 96×48 box, feet
 * on `GROUND`, coat mass in `currentColor` so the panel can tint per class. What
 * replaces bodywork here is skeletal proportion, so the five are pinned to a
 * measured skeleton before any fur is drawn:
 *
 *   back line     deer 17.6 · dog 19 · goose 22.6 · cat 26.2 · raccoon 26.4
 *   silhouette    deer 0 (antler tips) · dog 5.8 (ear tips) · goose 6.2
 *     top         (crown) · cat 17.2 (tail tip) · raccoon 23.9 (ear tips)
 *   leg length    deer 11.5u straight · dog 9.6u · cat 6.3u folded ·
 *                 goose 3.8u scaled tarsus · raccoon 2.8u plantigrade
 *   body ratio    dog 2.2:1 · raccoon 2.2:1 · deer 2.4:1 · goose 2.4:1 ·
 *                 cat 3.1:1 — the cat is the only long tube in the set
 *   tail          deer flicked stub · dog raised sabre · cat upward curl ·
 *                 raccoon ringed club · goose pointed feather stack
 *
 * Stance carries the rest: the dog stands square and alert, the cat walks low
 * with its shoulder blade up, the deer braces on straight legs, the raccoon
 * hunches over an arched spine, the goose stands upright over a folded wing.
 *
 * Only markings are hardcoded — pale muzzle and rump fur, bone antlers, the
 * raccoon's mask and tail bands, the goose's chin strap, the dog's collar.
 */

/** Pale fur: muzzles, chests, rump patch, tail underside. */
const FUR_PALE = "#e0d2b6";
/**
 * Far-side wash. `PALETTE.bodyShade` is within a shade of the tile glass, so a
 * flat dark fill would erase the off limbs entirely; instead every far mass is
 * the coat colour dimmed and darkened, which reads on any tint.
 */
const FAR_COAT = 0.62;
const FAR_WASH = 0.28;
/** Deep fur used for eye sockets, hooves and nose leather. */
const FUR_DARK = "#111823";
/** Bone antler, warm against the cool fleet palette. */
const ANTLER = "#c3a678";
const ANTLER_SHADE = "#7e6844";
/** Raccoon bandit mask and tail bands. */
const MASK = "#141a22";
/** Dog collar. */
const COLLAR = "#c4544a";
const COLLAR_EDGE = "#7d2f28";
/** Goose head and bill, with the chin strap that identifies the species. */
const GOOSE_DARK = "#161e28";
const GOOSE_STRAP = "#f0ece2";

/** Where a foot shape rests: just clear of the fleet ground line. */
const FOOT = GROUND - 2.4;

/**
 * One limb: outline, coat, shared gloss — three elements, so legs are lit like
 * the bodies they hang from. Far-side limbs lose the outline and take the wash.
 */
function Leg({ d, w = 2.4, far = false }: { d: string; w?: number; far?: boolean }) {
  if (far) {
    return (
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth={w}>
        <path d={d} stroke="currentColor" opacity={FAR_COAT} />
        <path d={d} stroke={FUR_DARK} opacity={FAR_WASH} />
      </g>
    );
  }
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} stroke={PALETTE.line} strokeWidth={w + 1.1} opacity=".9" />
      <path d={d} stroke="currentColor" strokeWidth={w} />
      <path d={d} stroke={FILL.gloss} strokeWidth={w} />
    </g>
  );
}

/** Any far-side mass that is not a limb: off ears, off wings, off tail lobes. */
function Sunk({ d }: { d: string }) {
  return (
    <g>
      <path d={d} fill="currentColor" opacity={FAR_COAT} />
      <path d={d} fill={FUR_DARK} opacity={FAR_WASH} />
    </g>
  );
}

/** Padded foot. `toes` splits the front edge; `far` sinks it behind the body. */
function Paw({
  x,
  y = FOOT,
  w,
  h = 2.1,
  toes = 0,
  far = false,
}: {
  x: number;
  y?: number;
  w: number;
  h?: number;
  toes?: number;
  far?: boolean;
}) {
  const step = w / (toes + 1);
  return (
    <g>
      {far ? (
        <>
          <rect x={x} y={y} width={w} height={h} rx={h / 2} fill="currentColor" opacity={FAR_COAT} />
          <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={FUR_DARK} opacity={FAR_WASH} />
        </>
      ) : (
        <>
          <rect x={x} y={y} width={w} height={h} rx={h / 2} fill="currentColor" />
          <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={FILL.gloss} />
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            rx={h / 2}
            fill="none"
            stroke={PALETTE.line}
            strokeWidth=".8"
          />
          {Array.from({ length: toes }, (_, index) => (
            <line
              key={index}
              x1={x + step * (index + 1)}
              y1={y + h * 0.4}
              x2={x + step * (index + 1)}
              y2={y + h}
              stroke={FUR_DARK}
              strokeWidth=".6"
            />
          ))}
        </>
      )}
    </g>
  );
}

/** Cloven hoof: a dark block with the split showing, edged so it reads. */
function Hoof({ x, far = false }: { x: number; far?: boolean }) {
  const d = `M${x} 38.7 L${x + 2.5} 38.7 L${x + 2.1} 40.6 L${x + 0.4} 40.6 Z`;
  return (
    <g>
      <path d={d} fill={FUR_DARK} />
      <path
        d={d}
        fill="none"
        stroke={PALETTE.rimShade}
        strokeWidth=".55"
        opacity={far ? 0.45 : 0.8}
      />
      {far ? null : (
        <line
          x1={x + 1.25}
          y1="39.4"
          x2={x + 1.25}
          y2="40.5"
          stroke={PALETTE.rimShade}
          strokeWidth=".55"
        />
      )}
    </g>
  );
}

/** Socket, pupil and catch-light. Small enough to survive the downscale. */
function Eye({ cx, cy, r = 1.5 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <ellipse cx={cx} cy={cy} rx={r} ry={r * 0.88} fill={FUR_DARK} />
      <circle cx={cx} cy={cy} r={r * 0.52} fill="#080d14" />
      <circle cx={cx - r * 0.3} cy={cy - r * 0.32} r={r * 0.3} fill="#f4f7fb" opacity=".85" />
    </g>
  );
}

/** Eye that has to read against a dark marking: pale ring instead of a socket. */
function PaleEye({ cx, cy, r = 1.15 }: { cx: number; cy: number; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="#e9e1cf" />
      <circle cx={cx + r * 0.1} cy={cy + r * 0.1} r={r * 0.54} fill="#080d14" />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Dog                                                                 */
/* ------------------------------------------------------------------ */

/** Deep chest at the shoulder, waist tucked up hard behind the ribs. */
const DOG_TORSO =
  "M36.6 23.8 C37.4 20.2 40.8 18.8 45.4 19 " +
  "C50.6 19.2 55.4 19.4 59.6 20.4 " +
  "C63.2 21.4 65.8 23.2 67 26.2 " +
  "C68.2 29.2 67.2 31.6 64.4 32.8 " +
  "C61.2 34.2 57.2 33.4 53.2 32.2 " +
  "C48.8 30.8 44.4 29.4 40.8 29.4 " +
  "C38.8 29.4 37.4 30.2 36.6 31 " +
  "C34.8 28.6 35.2 25.4 36.6 23.8 Z";

const DOG_NECK =
  "M59.6 20.8 C61 17.2 63.8 14.8 67.6 13.8 " +
  "L72 16.8 C68.8 18 66.4 20.4 65.4 24 " +
  "C64 26.4 61 26.4 59.6 24.4 Z";

const DOG_HEAD =
  "M67.4 18 C67 14.4 69.4 11.8 73 11.6 " +
  "C76.6 11.4 79.2 13.6 79.6 17 " +
  "L80.8 18.4 C82.8 18.8 84.2 19.8 84.2 20.9 " +
  "C84.2 22 82.6 22.6 80.6 22.6 " +
  "L78.8 22.8 C76.6 24.2 73.2 24.6 70.6 23.6 " +
  "C68.4 22.8 67.6 20.4 67.4 18 Z";

/** Raised sabre tail, tapered off the croup. */
const DOG_TAIL =
  "M37 27 C32.8 25.4 29.2 22 27.2 16.8 " +
  "L30 15.9 C31.8 20.6 34.6 23.4 38 25 Z";

/** Band around the neck rather than a bib: quad cut across the neck axis. */
const DOG_COLLAR = "M65.18 18.34 L71.02 22.52 L69.62 24.46 L63.78 20.28 Z";

/** Mid-size standing dog: square alert stance, pricked ears, tail up, collared. */
export function Dog() {
  return (
    <VehicleSvg id={"animal.dog"}>
      <Ground x={28} width={44} />

      {/* Far side first: off legs stepped back so both pairs read, then the
          off ear behind the skull. */}
      <Leg d="M34.8 29.8 C37 31.8 37.4 33.8 36 35.6 L33 37 L34 38.6" w={2.5} far />
      <Leg d="M57 31 C57.8 33.4 58 35.8 57.4 38.4" w={2.5} far />
      <Paw x={32.4} w={3.2} h={2} far />
      <Paw x={55.2} w={3.2} h={2} far />
      <Sunk d="M68.6 13.2 L65.4 6.6 L71 11.6 Z" />

      <Body d={DOG_TAIL} outline={0.8} />
      <Body d={DOG_TORSO} />
      {/* Last rib and the sweep of the haunch. */}
      <Seam d="M57.8 21.4 C59.4 24.8 59.4 28.4 58 31.4" width={0.85} opacity={0.55} />
      <Seam d="M42 20 C40.2 22.6 40 25.6 41.2 28.6" width={0.8} opacity={0.5} />
      {/* Pale brisket under the deep chest. */}
      <path
        d="M60.6 30.4 C63 30.8 65.2 31 66.6 30.6 C65.6 32.6 62.4 33.6 58.6 33 Z"
        fill={FUR_PALE}
        opacity=".5"
      />

      <Body d={DOG_NECK} />
      <Body d={DOG_HEAD} />
      {/* Pricked near ear with an inner shade. */}
      <Body d="M72.6 12.4 L71 5.8 L76.4 11 Z" outline={0.8} />
      <path d="M73 11.8 L72.2 8 L75 11.2 Z" fill={FUR_DARK} opacity=".5" />
      {/* Pale muzzle band, nose leather, lip line. */}
      <path
        d="M79.4 18.4 C81.2 18.8 83.2 19.6 83.5 20.8 C83 21.9 80.8 22.4 79 22.6 Z"
        fill={FUR_PALE}
        opacity=".7"
      />
      <ellipse cx="82.8" cy="20.8" rx="1.4" ry="1.15" fill={FUR_DARK} />
      <Seam d="M79.8 22.1 L82.2 21.9" width={0.7} opacity={0.6} />
      <Eye cx={76.6} cy={16.8} r={1.5} />

      {/* Collar band with a hanging tag. */}
      <path d={DOG_COLLAR} fill={COLLAR} />
      <path d={DOG_COLLAR} fill="none" stroke={COLLAR_EDGE} strokeWidth=".6" opacity=".85" />
      <circle cx="70.3" cy="25.3" r="1.15" fill={PALETTE.chrome} />

      {/* Near legs, hocks and feet last. */}
      <Leg d="M39.8 29.2 C42.2 31.2 42.6 33.6 41.2 35.6 L37.8 37.4 L38.8 38.8" w={2.8} />
      <Leg d="M62.6 31.6 C63.4 34 63.6 36.4 63 38.8" w={2.8} />
      <Paw x={37.2} w={3.8} toes={2} />
      <Paw x={61.2} w={3.8} toes={2} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Cat                                                                 */
/* ------------------------------------------------------------------ */

/** Compact tube, level back, shoulder blade proud where the foreleg plants. */
const CAT_TORSO =
  "M36.8 30.6 C36.8 27.8 38.8 26.4 41.8 26.2 " +
  "C46 26 50.4 26.6 54.4 26.2 " +
  "C57 25.6 59.4 26.4 61.2 28 " +
  "C63.2 29.6 63.8 31.6 62.6 33.4 " +
  "C61.2 35.2 58 35.4 54.6 34.8 " +
  "C50 34 45.6 33.6 42 33.6 " +
  "C39.2 33.6 37.6 32.6 36.8 31.6 Z";

const CAT_NECK =
  "M60 27.6 C60.8 25.2 62.8 23.6 65.4 23.2 " +
  "L68.2 25.8 C66 26.6 64.4 28.2 63.8 30.6 Z";

const CAT_HEAD =
  "M63.4 27.4 C63.2 24.2 65.4 22.2 68.4 22 " +
  "C71.6 21.8 73.8 23.6 74.2 26.2 " +
  "L76 27.2 C77.4 27.8 77.4 29 76 29.4 " +
  "L74 29.6 C71.8 31.2 68.2 31.4 66 30 " +
  "C64.2 29 63.4 28.4 63.4 27.4 Z";

/** Long tail sweeping back low, then curling up well above the spine. */
const CAT_TAIL =
  "M37.4 30.4 C32.4 31 27.2 29.4 24.2 25.2 " +
  "C22 22 22.6 18.6 25.6 17.2 " +
  "L26.8 19.4 C24.8 20.4 24.6 22.8 26.2 25.2 " +
  "C28.6 28.8 32.8 29.6 37.4 28.6 Z";

/** Cat mid slow-walk: low crouch, folded hocks, tail curled up behind. */
export function Cat() {
  return (
    <VehicleSvg id={"animal.cat"}>
      <Ground x={28} width={40} />

      {/* Off legs a stride behind the near pair, so the walk reads. */}
      <Leg d="M35.6 32.2 C37.8 33.6 38 35.2 36.6 36.4 L34.6 37.4 L35.6 38.4" w={1.9} far />
      <Leg d="M55.8 33 C56.4 34.8 56.6 36.6 56 38.4" w={1.9} far />
      <Sunk d="M34.1 39.3 a1.7 1.1 0 1 0 3.4 0 a1.7 1.1 0 1 0 -3.4 0" />
      <Sunk d="M54.4 39.2 a1.6 1.1 0 1 0 3.2 0 a1.6 1.1 0 1 0 -3.2 0" />
      <Sunk d="M70.8 21.8 L72.6 17.6 L74 23.2 Z" />

      <Body d={CAT_TAIL} outline={0.8} />
      {/* Faint tabby banding up the tail. */}
      <g stroke={FUR_DARK} strokeWidth="1" opacity=".35" strokeLinecap="round">
        <line x1="33.6" y1="29.2" x2="33.2" y2="30.8" />
        <line x1="29.2" y1="28.2" x2="28.4" y2="29.8" />
        <line x1="25.2" y1="24.2" x2="23.8" y2="24.8" />
      </g>

      <Body d={CAT_TORSO} />
      {/* Shoulder blade riding high, flank crease behind the ribs. */}
      <Seam d="M56.6 26.2 C58.4 27.2 59.2 28.8 59 30.6" width={0.9} opacity={0.6} />
      <Seam d="M43.4 26.6 C42 28.2 41.8 30.2 42.6 31.8" width={0.8} opacity={0.45} />
      <path
        d="M42.4 32.8 C47 33.4 51.6 33.9 55.4 34.2 C52.6 35.2 47.4 34.9 43.4 34.3 Z"
        fill={FUR_PALE}
        opacity=".4"
      />

      <Body d={CAT_NECK} />
      <Body d={CAT_HEAD} />
      {/* Small triangular near ear with its inner shade. */}
      <Body d="M65.2 22.8 L63.8 17.8 L68 21.8 Z" outline={0.7} />
      <path d="M65.6 22.2 L65 19.4 L67 21.8 Z" fill={FUR_DARK} opacity=".55" />
      <path
        d="M73.8 26.6 C75.4 27 76.8 27.6 76.6 28.6 C75.4 29.4 73.2 29.7 71.6 29.3 Z"
        fill={FUR_PALE}
        opacity=".65"
      />
      <ellipse cx="75.8" cy="28" rx="1.1" ry=".85" fill="#d98d96" />
      <Eye cx={71.2} cy={25.4} r={1.7} />
      {/* Whisker suggestion: three sweeps, kept above the hairline threshold. */}
      <g stroke={PALETTE.chrome} strokeWidth=".65" opacity=".5" strokeLinecap="round" fill="none">
        <path d="M76.4 26.8 C79 25.6 81.4 24.8 83.2 24.6" />
        <path d="M76.8 28 C79.6 27.8 82 27.8 83.8 28" />
        <path d="M76.2 29 C78.8 29.6 80.8 30.4 82 31.2" />
      </g>

      <Leg d="M40.2 32.6 C42.6 34.2 42.8 35.8 41.4 37 L38.8 38 L39.8 38.9" w={2.1} />
      <Leg d="M60.6 33.6 C61.2 35.4 61.4 37.2 60.8 38.9" w={2.1} />
      <g fill="currentColor" stroke={PALETTE.line} strokeWidth=".7">
        <ellipse cx="40.2" cy="39.6" rx="1.9" ry="1.15" />
        <ellipse cx="61" cy="39.7" rx="1.9" ry="1.15" />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Deer                                                                */
/* ------------------------------------------------------------------ */

/** Short barrel over long legs, haunch riding higher than the withers. */
const DEER_TORSO =
  "M37.6 22.2 C38 18.8 41 17.2 44.8 17.6 " +
  "C49.4 18.1 54 19.4 58 20.2 " +
  "C61 20.8 63.2 22 64.4 24.2 " +
  "C65.6 26.2 64.8 28.2 62.4 28.9 " +
  "C58.4 30.1 53.2 29.4 48.2 28.4 " +
  "C44 27.6 40.4 27.6 38.4 26.8 " +
  "C37 25.4 37.2 23.4 37.6 22.2 Z";

/** Long neck, arched forward off the shoulder. */
const DEER_NECK =
  "M60.8 22 C60.4 16.8 62.2 12 66.2 8.8 " +
  "L70.6 11.4 C67.4 14 65.2 18 65 23.4 " +
  "C63.4 25 61.4 24.6 60.8 23 Z";

const DEER_HEAD =
  "M65.6 10.6 C65.4 8 67.2 6.2 69.8 6.2 " +
  "C72.2 6.2 73.8 7.6 74.2 9.6 " +
  "L78.8 12.8 C80.2 13.8 80 15.2 78.4 15.5 " +
  "C76.8 15.8 75 15 73.6 13.8 " +
  "L71.8 14 C68.4 14.2 65.8 13 65.6 10.6 Z";

/** Four-point rack: beam sweeping back, three tines forward off the beam. */
const DEER_ANTLER = [
  "M70.8 5.8 C69.4 3.6 67.2 2 64.6 1.2",
  "M69.6 4 C71.8 3 73.8 2.1 75.2 1.5",
  "M67.8 2.4 C69.2 1.4 70.6 0.8 71.8 0.6",
  "M70.9 5.6 C72.8 5.4 74.8 4.8 76.2 4",
];

/** Tall leggy deer, alert: arched neck, four-tine rack, white rump patch. */
export function Deer() {
  return (
    <VehicleSvg id={"animal.deer"}>
      <Ground x={30} width={40} />

      {/* Off legs a half-stride behind, thin as the near pair. */}
      <Leg d="M35.4 27.4 C37.6 29.6 38.2 32.2 36.8 34.2 L34 36.4 L35.2 38.4" w={1.9} far />
      <Leg d="M55.6 27.8 C56.4 31.2 56.6 34.6 56 38.4" w={1.9} far />
      <Hoof x={33.8} far />
      <Hoof x={54.8} far />
      {/* Off antler and off ear, sunk behind the skull. */}
      <g
        fill="none"
        stroke={ANTLER_SHADE}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {DEER_ANTLER.map((d) => (
          <path key={d} d={d} transform="translate(-2.6 1.8)" />
        ))}
      </g>
      <Sunk d="M72.8 7 C74.8 4.4 77.4 3 79.2 3.4 C79.4 5.6 77.4 8 74.6 8.6 Z" />

      {/* Short tail, flicked up over the rump patch. */}
      <Body d="M38.8 20.8 L35.4 16.6 L40.2 19.2 Z" outline={0.7} />
      <path d="M38.6 20.2 L36.8 17.8 L39.6 19.4 Z" fill={FUR_PALE} opacity=".85" />

      <Body d={DEER_TORSO} />
      <path
        d="M37.9 21.6 C39.2 20.2 41.2 20 42.4 21 L41.9 26.6 C40.2 27.1 38.6 26.4 38 25.3 Z"
        fill={FUR_PALE}
        opacity=".55"
      />
      <Seam d="M57.6 21 C59.2 23.4 59.4 26.2 58.4 28.8" width={0.85} opacity={0.55} />
      <Seam d="M44 18.4 C42.2 20.8 42 24 43.2 26.8" width={0.8} opacity={0.5} />
      <path
        d="M46 27.8 C51 28.6 56.4 29.4 61.4 29 C56.8 30.4 51 29.8 46.6 29 Z"
        fill={FUR_PALE}
        opacity=".35"
      />

      <Body d={DEER_NECK} />
      {/* Near ear: broad leaf swept back off the crown. */}
      <Body d="M70.2 7.2 C68 5 65 3.8 63 4.4 C62.6 6.6 64.8 8.8 67.8 9.2 Z" outline={0.7} />
      <path
        d="M69.2 7.6 C67.4 6 65.4 5.2 64 5.4 C64 6.6 65.8 8 68 8.4 Z"
        fill={FUR_DARK}
        opacity=".45"
      />
      <Body d={DEER_HEAD} />
      <g fill="none" stroke={ANTLER} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {DEER_ANTLER.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <circle cx="70.9" cy="6" r="1.1" fill={ANTLER} />
      {/* Pale muzzle band with a dark nose. */}
      <path
        d="M74 12.2 C76.2 12.8 78.8 13.8 79.6 14.9 C78.6 15.9 76 15.4 74 14 Z"
        fill={FUR_PALE}
        opacity=".8"
      />
      <ellipse cx="78.8" cy="14.2" rx="1.4" ry="1.1" fill={FUR_DARK} />
      <Eye cx={71.8} cy={10.4} r={1.5} />

      <Leg d="M40.6 27.2 C43 29.6 43.6 32.4 42.2 34.6 L38.8 37.2 L40 38.7" w={2.1} />
      <Leg d="M61 28.4 C61.8 32 62 35.4 61.4 38.7" w={2.1} />
      <Hoof x={38.8} />
      <Hoof x={60.2} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Raccoon                                                             */
/* ------------------------------------------------------------------ */

/** Hunched spine: the arch peaks over the hips and falls away forward. */
const COON_TORSO =
  "M39.2 34.4 C37.6 29.8 40.6 26.6 45.2 26.4 " +
  "C49.6 26.2 53.6 27.8 57 29.6 " +
  "C60 31.2 62.2 32.4 63 34.2 " +
  "C63.8 35.8 62.8 37 60.6 37.2 " +
  "C55.2 37.8 49.6 37.6 45 37 " +
  "C41.6 36.5 39.8 35.6 39.2 35 Z";

/** Short blunt muzzle carried low, the way a raccoon forages. */
const COON_HEAD =
  "M61 31.4 C61 28.4 63.4 26.6 66.4 26.6 " +
  "C69.4 26.6 71.6 28.4 72.2 31 " +
  "L74.6 32.2 C76 32.9 76 34.1 74.6 34.6 " +
  "C73.4 35 72 34.8 70.9 34.3 " +
  "C69 35.8 65.8 36 63.4 34.8 " +
  "C61.6 33.8 60.9 32.8 61 31.4 Z";

/** Bushy club of a tail, held low behind the hips. */
const COON_TAIL =
  "M39.6 29.8 C34 27.8 27 26.8 21.6 28.2 " +
  "C17 29.4 15.2 32.4 17.4 34.8 " +
  "C20 37.6 26 37.6 31.6 36.2 " +
  "C35.2 35.3 38 34 39.8 32.6 Z";

/** Tail bands as shapes clipped to the tail, not strokes laid over it. */
const COON_BANDS = [
  "M18 25 L21 25 L22 39 L18.6 39 Z",
  "M24 25 L26.8 25 L28 39 L25 39 Z",
  "M30.2 25 L32.8 25 L34.2 39 L31.6 39 Z",
  "M36 25 L38.2 25 L39.4 39 L37.2 39 Z",
];

/** Low hunched raccoon: arched back, ringed tail, bandit mask, flat paws. */
export function Raccoon() {
  return (
    <VehicleSvg id={"animal.raccoon"}>
      <Ground x={18} width={60} />

      <defs>
        <clipPath id="aa-coon-tail">
          <path d={COON_TAIL} />
        </clipPath>
      </defs>

      <Leg d="M40.6 35.4 C41.8 36.6 41.6 37.6 40.8 38.4" w={2.3} far />
      <Leg d="M56.6 35.8 L57 38.4" w={2.3} far />
      <Paw x={38.4} w={4} h={2} far />
      <Paw x={55} w={4} h={2} far />
      {/* Off ear peeking over the skull, drawn before the head. */}
      <Sunk d="M69.8 28.2 C69 25.8 70.4 24.6 72.1 25.2 C73.5 25.7 73.8 27.3 73.2 28.8 Z" />

      <Body d={COON_TAIL} outline={0.9} />
      <g clipPath="url(#aa-coon-tail)">
        {COON_BANDS.map((d) => (
          <path key={d} d={d} fill={MASK} opacity=".82" />
        ))}
        <path d={COON_TAIL} fill={FILL.gloss} />
      </g>
      <path d={COON_TAIL} fill="none" stroke={PALETTE.line} strokeWidth=".9" opacity=".85" />

      <Body d={COON_TORSO} />
      <Seam d="M47 27 C45.2 29.8 45 33.2 46.4 36.2" width={0.85} opacity={0.45} />
      <Seam d="M55 29.2 C53.8 31.6 53.8 34.4 55 36.8" width={0.8} opacity={0.4} />
      <path
        d="M43.4 35.8 C48.8 36.8 54.6 37.3 60.4 37.1 C54.8 38 47.8 37.7 44 37.1 Z"
        fill={FUR_DARK}
        opacity=".4"
      />

      <Body d={COON_HEAD} />
      {/* Small rounded near ear with a pale rim. */}
      <Body
        d="M64.6 28 C63.6 25.3 65.2 23.9 67.1 24.5 C68.8 25.1 69.2 26.9 68.4 28.5 Z"
        outline={0.7}
      />
      <path
        d="M65.4 27.6 C65 26 65.9 25.3 66.8 25.6 C67.7 25.9 67.9 26.9 67.5 27.9 Z"
        fill={FUR_PALE}
        opacity=".55"
      />
      {/* Pale brow, bandit mask, pale snout ridge, nose leather. */}
      <path
        d="M63.2 29.4 C66 27.8 69.8 28.1 72.7 30 L72.2 31.1 C69.4 29.4 66.2 29.1 63.6 30.6 Z"
        fill={FUR_PALE}
        opacity=".85"
      />
      <path
        d="M63.2 30.4 C65.8 29 69.6 29.3 72.4 31 L71.6 33.4 C68.6 31.7 65.6 31.5 63.4 33 Z"
        fill={MASK}
      />
      <path
        d="M71.8 32 C73 32.4 74.2 32.9 75.2 33.5"
        stroke={FUR_PALE}
        strokeWidth="1"
        opacity=".7"
      />
      <PaleEye cx={68} cy={31.1} />
      <ellipse cx="75.2" cy="33.8" rx="1.3" ry="1.05" fill={FUR_DARK} />

      {/* Plantigrade feet: barely any leg, long flat paws. */}
      <Leg d="M43.4 35.8 C44.8 37 44.6 37.9 43.8 38.6" w={2.6} />
      <Leg d="M60.2 36.2 L60.6 38.6" w={2.6} />
      <Paw x={41.2} w={4.6} toes={3} />
      <Paw x={58.6} w={4.6} toes={3} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Goose                                                               */
/* ------------------------------------------------------------------ */

/** Deep bulky body, breast forward, carried high on short scaled legs. */
const GOOSE_BODY =
  "M33 28.4 C34.4 24.8 39.6 22.6 46 22.6 " +
  "C52.6 22.6 58.4 24.6 62 27.8 " +
  "C64.6 30.2 64.6 32.8 61.6 34.4 " +
  "C57 36.8 49.4 36.9 43 35.8 " +
  "C37.2 34.8 33 32.6 32.2 30 " +
  "C31.9 29.2 32.4 28.8 33 28.4 Z";

/** Folded wing over the flank, coverts high and primaries trailing back. */
const GOOSE_WING =
  "M39 27.6 C44.6 25.8 51.4 26.6 56.6 29.2 " +
  "C59 30.4 59.4 32.2 57.2 33.2 " +
  "C52.8 35 46 34.6 41.2 32.6 " +
  "C38 31.4 36.8 29 39 27.6 Z";

/** Long S-curve: back off the shoulder, up, then forward into the head. */
const GOOSE_NECK =
  "M58.6 28.6 C57.6 22.8 59 17 63 13.2 " +
  "C65.2 11.2 68 10 70.4 10.2 " +
  "L70.6 13.6 C67.8 13.8 65.4 15.2 63.8 17.8 " +
  "C61.8 21 61.8 25 62.8 29.4 Z";

const GOOSE_HEAD =
  "M65.4 11.2 C65.2 8.2 67.2 6.2 70.2 6.2 " +
  "C73 6.2 74.8 8.2 74.8 10.8 " +
  "L74.6 13.2 C73.4 14.6 71 15.2 69 14.4 " +
  "C66.8 13.6 65.5 12.7 65.4 11.2 Z";

/** Flat spatulate bill with a nail at the tip. */
const GOOSE_BILL =
  "M74.2 9.2 C77.4 9.2 80.6 9.9 82.4 10.7 " +
  "C83.5 11.2 83.4 12.3 82.2 12.8 " +
  "C80.2 13.5 76.8 13.8 74.4 13.4 Z";

/** Stack of three pointed tail feathers, cocked up off the rump. */
const GOOSE_TAIL =
  "M34 27.4 C31 25.6 27.6 24 24.2 23.2 " +
  "C25 25 26.4 26.6 28.2 27.8 " +
  "C25.4 27.6 23.2 27.2 21.8 26.6 " +
  "C23 28.6 25 30 27.4 30.8 " +
  "C25.4 31.2 23.6 31.2 22.4 30.8 " +
  "C25 32.6 29.4 33 33.6 32 Z";

/** One webbed foot: three toes joined by the web, flat on the ground. */
function Web({ x, far = false }: { x: number; far?: boolean }) {
  return (
    <g opacity={far ? 0.65 : 1}>
      <path
        d={`M${x} 38.7 L${x + 7.2} 40 L${x + 0.4} 40.8 Z`}
        fill={far ? PALETTE.rim : PALETTE.chrome}
        stroke={PALETTE.rimShade}
        strokeWidth=".5"
      />
      {far ? null : (
        <g stroke={PALETTE.rimShade} strokeWidth=".55">
          <line x1={x + 0.9} y1="39.3" x2={x + 6.1} y2="40" />
          <line x1={x + 0.9} y1="40.1" x2={x + 5.7} y2="40.3" />
        </g>
      )}
    </g>
  );
}

/** Standing goose: S-neck, bulky body, dark head with a pale chin strap. */
export function Goose() {
  return (
    <VehicleSvg id={"animal.goose"}>
      <Ground x={24} width={44} />

      <path
        d="M46.6 34.8 L45.6 38.8"
        stroke={PALETTE.rimShade}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <Web x={43.4} far />

      <Body d={GOOSE_TAIL} outline={0.8} />
      <Seam d="M25.6 24.6 C28 26.4 30.4 27.8 32.6 28.6" width={0.7} opacity={0.55} />
      <Body d={GOOSE_NECK} />
      <Body d={GOOSE_BODY} />

      {/* Pale breast, then the folded wing over the flank. */}
      <path
        d="M60.4 26.8 C63 28.8 64.6 31 64.4 33 C62.6 34.6 59.8 35.4 57 35.6 C59.4 33 60.4 30 60.4 26.8 Z"
        fill={GOOSE_STRAP}
        opacity=".3"
      />
      <path d={GOOSE_WING} fill={FILL.gloss} />
      <path d={GOOSE_WING} fill="none" stroke={PALETTE.line} strokeWidth=".9" opacity=".85" />
      {/* Primaries, laid back toward the tail. */}
      <g fill="none" stroke={PALETTE.seam} strokeWidth=".75" opacity=".7">
        <path d="M39.4 30 C43.2 31.8 47.6 33 51.6 33.4" />
        <path d="M40.6 27.6 C44.6 28.8 49 30.4 52.6 32.6" />
        <path d="M46.4 26.6 C50.2 27.8 54 29.6 57 32" />
      </g>
      <Seam d="M34.6 28.6 C33.6 29.8 33.6 31.2 34.6 32.4" width={0.8} opacity={0.5} />

      {/* Neck feather grain, dark head, chin strap, flat bill. */}
      <g fill="none" stroke={PALETTE.seam} strokeWidth=".6" opacity=".5">
        <path d="M60.6 27.8 C60 22.8 61.4 18.4 64.6 15" />
        <path d="M63 28.6 C62.4 24.2 63.6 20.4 66.4 17.2" />
      </g>
      <path d={GOOSE_HEAD} fill={GOOSE_DARK} />
      <path d={GOOSE_HEAD} fill="none" stroke={PALETTE.line} strokeWidth=".9" />
      <path
        d="M68.4 10.4 C69.6 11.6 70.8 13.4 71.2 14.9 L68.6 14.4 C67.4 13.4 67 11.6 67.4 10.4 Z"
        fill={GOOSE_STRAP}
      />
      <path d={GOOSE_BILL} fill={GOOSE_DARK} stroke={PALETTE.line} strokeWidth=".7" />
      <path d="M75.6 11.2 L81 11.5" stroke={PALETTE.chrome} strokeWidth=".6" opacity=".4" />
      <circle cx="82.2" cy="11.6" r=".7" fill={PALETTE.chrome} opacity=".65" />
      <PaleEye cx={72} cy={9.8} r={1.1} />

      <path d="M51.4 35.2 L50.8 39" stroke={PALETTE.rim} strokeWidth="2.2" strokeLinecap="round" />
      <Web x={48.8} />
    </VehicleSvg>
  );
}
