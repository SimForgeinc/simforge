"use client";

import {
  Body,
  FILL,
  Glass,
  Ground,
  PALETTE,
  Seam,
  VehicleSvg,
  Wheel,
} from "../vehicle-art/parts";
import {
  AWNING,
  AWNING_LIT,
  tube,
} from "./prop-parts";

/**
 * Fixed street furniture: the things a pedestrian uses or walks around.
 *
 * Same stage as the vehicle fleet: a 96x48 side elevation facing right, the
 * ground at `GROUND`, nothing below it but the contact shadow.
 */

/* ================================================================== */
/* Street furniture                                                   */
/* ================================================================== */

/* ------------------------------------------------------------------ */
/* Mailbox cluster                                                     */
/* ------------------------------------------------------------------ */

const MB_DOOR_W = 6.2;
const MB_DOOR_H = 5.4;

/** Four across, three down — the tenant doors. */
const MB_DOORS = [14.2, 20.4, 26.6].flatMap((y) =>
  [28.4, 35.4, 42.4, 49.4].map((x) => [x, y] as const),
);

/** Cluster box unit: tenant doors, two parcel lockers, rain hood, pedestal. */
export function MailboxCluster() {
  return (
    <VehicleSvg id={"street.mailbox_cluster"}>
      <Ground x={30} width={36} />

      {/* Pedestal and its bolted base plate. */}
      <path d="M41 39.6 L42.4 32.2 L53.6 32.2 L55 39.6 Z" fill={PALETTE.bodyShade} />
      <Seam d="M44.2 33 L43.4 39.4" width={0.7} opacity={0.5} />
      <path
        d="M37.4 39.2 L58.6 39.2 L59.8 41 L36.2 41 Z"
        fill={PALETTE.bodyShade}
        stroke={PALETTE.line}
        strokeWidth=".7"
      />
      <g fill={PALETTE.rimShade}>
        <circle cx="39.6" cy="40.1" r=".8" />
        <circle cx="56.4" cy="40.1" r=".8" />
      </g>

      <Body d="M26 32.6 L26.4 12.4 L69.6 12.4 L70 32.6 Z" />

      {/* Tenant doors: recessed pans, hinge highlight, lock each. */}
      {MB_DOORS.map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <rect x={x} y={y} width={MB_DOOR_W} height={MB_DOOR_H} rx=".8" fill={PALETTE.bodyShade} />
          <rect x={x} y={y} width={MB_DOOR_W} height="1.1" rx=".5" fill={FILL.metal} opacity=".35" />
          <circle cx={x + MB_DOOR_W - 1.3} cy={y + MB_DOOR_H / 2} r=".8" fill={PALETTE.chrome} />
        </g>
      ))}

      {/* Parcel lockers: twice the height, pull handle instead of a flap. */}
      <g>
        <rect x="57.4" y="14.2" width="10" height="8.2" rx=".9" fill={PALETTE.bodyShade} />
        <rect x="57.4" y="14.2" width="10" height="1.3" rx=".6" fill={FILL.metal} opacity=".35" />
        <rect x="59.2" y="19.6" width="5" height="1.3" rx=".6" fill={PALETTE.chrome} />
        <circle cx="65.8" cy="16.4" r=".9" fill={PALETTE.chrome} />
        <rect x="57.4" y="23.6" width="10" height="8.4" rx=".9" fill={PALETTE.bodyShade} />
        <rect x="57.4" y="23.6" width="10" height="1.3" rx=".6" fill={FILL.metal} opacity=".35" />
        <rect x="59.2" y="29.2" width="5" height="1.3" rx=".6" fill={PALETTE.chrome} />
        <circle cx="65.8" cy="25.9" r=".9" fill={PALETTE.chrome} />
      </g>
      <Seam d="M56.4 12.8 L56.4 32.2" width={0.8} opacity={0.6} />

      {/* Sloped rain hood with the outgoing-mail slot cut in its face. */}
      <path d="M23 12.8 L27 6.8 L69 6.8 L73 12.8 Z" fill="currentColor" />
      <path d="M23 12.8 L27 6.8 L69 6.8 L73 12.8 Z" fill={FILL.gloss} />
      <path
        d="M23 12.8 L27 6.8 L69 6.8 L73 12.8 Z"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <rect x="41" y="8.8" width="14" height="2.2" rx="1" fill={PALETTE.shadow} />
      <rect x="41" y="8.8" width="14" height=".8" rx=".4" fill={PALETTE.chrome} opacity=".5" />
      <Seam d="M25.2 10 L70.8 10" width={0.7} opacity={0.4} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Bus shelter                                                         */
/* ------------------------------------------------------------------ */

/** Cantilevered canopy: thin over the near post, deep over the far one. */
const BS_ROOF =
  "M5 12.8 L8.6 6.2 C9 5.4 9.8 5 10.6 5 L86 4.4 " +
  "C88.6 4.4 90.4 5.8 91.2 8 L92.6 11.8 Z";

/** Glazed passenger shelter: bench, timetable case, kerb. */
export function BusShelter() {
  return (
    <VehicleSvg id={"street.bus_shelter"}>
      <Ground x={6} width={84} />

      {/* Kerb the shelter stands behind. */}
      <path d="M4 38.4 L92 37.8 L92 40.4 L4 41 Z" fill={PALETTE.bodyShade} />
      <path d="M4 38.4 L92 37.8" stroke={PALETTE.line} strokeWidth=".8" opacity=".6" />
      <g stroke={PALETTE.shadow} strokeWidth=".8" opacity=".7">
        <line x1="30" y1="38.2" x2="30" y2="40.7" />
        <line x1="66" y1="38" x2="66" y2="40.6" />
      </g>

      {/* Frame: two end stanchions and the mid mullion behind the glass. */}
      <Body d="M11 38.4 L11.4 9.6 L14.4 9.6 L14.6 38.4 Z" outline={0.8} />
      <Body d="M83 38 L83.2 10.4 L85.8 10.4 L86 38 Z" outline={0.8} />
      <path d="M46 38 L46.2 13.6 L48.4 13.6 L48.6 38 Z" fill={PALETTE.bodyShade} />

      {/* Glazing and its frame. */}
      <Glass d="M16 15.6 L45.6 15.3 L45.6 33 L16 33.2 Z" opacity={0.9} />
      <Glass d="M48.8 15.3 L74 15 L74 32.8 L48.8 33 Z" opacity={0.9} />
      <g stroke={PALETTE.chrome} strokeWidth=".7" opacity=".45">
        <line x1="20" y1="16.4" x2="20" y2="32.6" />
        <line x1="62" y1="16.2" x2="62" y2="32.4" />
      </g>
      <Seam d="M16.2 24.4 L45.5 24.2" width={0.7} opacity={0.45} />
      <Seam d="M48.9 24.2 L73.9 24" width={0.7} opacity={0.45} />

      {/* Timetable case: lit panel and schedule rules, no type at this size. */}
      <rect
        x="75.6"
        y="16.2"
        width="6.6"
        height="14"
        rx=".9"
        fill={PALETTE.bodyShade}
        stroke={PALETTE.line}
        strokeWidth=".7"
      />
      <rect x="76.6" y="17.2" width="4.6" height="12" rx=".5" fill={PALETTE.glass} />
      <g stroke={PALETTE.seam} strokeWidth=".7" opacity=".75">
        {[19.2, 21.4, 23.6, 25.8, 28].map((y) => (
          <line key={y} x1="77.4" y1={y} x2="80.4" y2={y} />
        ))}
      </g>

      {/* Bench in front of the glass. */}
      <Body d="M20 29.4 L64 29 L64 31.4 L20 31.8 Z" outline={0.8} />
      <g stroke={PALETTE.seam} strokeWidth=".7" opacity=".6">
        <line x1="20.4" y1="30.2" x2="63.8" y2="29.8" />
        <line x1="20.4" y1="31" x2="63.8" y2="30.6" />
      </g>
      <path d={tube(24.4, 31.6, 25.4, 38.2, 1.8)} fill={PALETTE.rimShade} />
      <path d={tube(58.6, 31.2, 59.6, 38.1, 1.8)} fill={PALETTE.rimShade} />
      <path d={tube(20.4, 26.8, 63.8, 26.4, 1.6)} fill={PALETTE.rimShade} opacity=".8" />

      {/* Canopy last: it laps over the tops of the posts. */}
      <path d={BS_ROOF} fill="currentColor" />
      <path d={BS_ROOF} fill={FILL.gloss} />
      <path d={BS_ROOF} fill="none" stroke={PALETTE.line} strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M5 12.8 L92.6 11.8 L92.4 14.6 L5.2 15.4 Z" fill={PALETTE.bodyShade} />
      <path d="M9 14.4 L88 13.4" stroke={PALETTE.lamp} strokeWidth="1.2" opacity=".55" />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Food cart                                                           */
/* ------------------------------------------------------------------ */

const CART_AWNING =
  "M25 15 L30.4 5.4 C30.9 4.6 31.7 4.2 32.6 4.2 L81.6 5 " +
  "C82.9 5 83.9 5.9 84.2 7.2 L85.8 15.6 Z";

const CART_SCALLOP_COUNT = 8;
const CART_SCALLOP_STEP = (85.8 - 25) / CART_SCALLOP_COUNT;

/** Scalloped valance hanging off the awning hem. */
const CART_VALANCE =
  "M25 15" +
  Array.from({ length: CART_SCALLOP_COUNT }, (_, index) => {
    const x = 25 + CART_SCALLOP_STEP * (index + 1);
    const y = 15 + (0.6 / CART_SCALLOP_COUNT) * (index + 1);
    return ` Q${(x - CART_SCALLOP_STEP / 2).toFixed(1)} ${(y + 3.6).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join("") +
  " Z";

/** Street vending cart: awning, serving counter, flue, cooler, condiments. */
export function FoodCart() {
  return (
    <VehicleSvg id={"street.food_cart"}>
      <Ground x={16} width={64} />

      <Wheel cx={32} cy={36.4} r={4.6} />
      <Wheel cx={66} cy={36.4} r={4.6} />

      {/* Carcass, its open bay and the cooler stowed inside. */}
      <Body d="M23.6 36.6 L23 24.6 L74.8 24.2 L75.6 36.4 Z" />
      <rect x="26.6" y="26.8" width="18" height="8.4" rx="1" fill={PALETTE.shadow} opacity=".85" />
      <path
        d="M28 34.8 L28.4 28.2 L42.8 28 L43.2 34.6 Z"
        fill={PALETTE.glassLit}
        stroke={PALETTE.line}
        strokeWidth=".7"
      />
      <Seam d="M28.4 30 L43 29.8" width={0.8} opacity={0.7} />
      <rect x="34" y="30.6" width="3.4" height="1.4" rx=".6" fill={PALETTE.chrome} />
      <rect
        x="50"
        y="26.6"
        width="20"
        height="8.4"
        rx="1.2"
        fill="none"
        stroke={PALETTE.seam}
        strokeWidth=".8"
        opacity=".7"
      />
      <rect x="66.4" y="30" width="1.6" height="2.4" rx=".7" fill={PALETTE.chrome} />

      {/* Serving counter, overhanging front and back. */}
      <path
        d="M20.2 21.6 L78.2 21.2 L78.6 24.4 L19.8 24.8 Z"
        fill={FILL.metal}
        stroke={PALETTE.line}
        strokeWidth=".8"
      />
      <path d="M20.4 22 L78.1 21.6" stroke="#eef3fa" strokeWidth=".8" opacity=".6" />

      {/* Griddle flue, clear of the awning, steam coming off it. */}
      <path d={tube(18.8, 22, 18.8, 7, 2.3)} fill={PALETTE.rim} />
      <path d={tube(18.8, 22, 18.8, 7, 0.8)} fill="#eef3fa" opacity=".5" />
      <ellipse cx="18.8" cy="6.6" rx="3.2" ry="1.2" fill={PALETTE.chrome} />
      <g fill="#ffffff">
        <ellipse cx="17.2" cy="3.6" rx="3.4" ry="2.2" opacity=".18" />
        <ellipse cx="13.4" cy="1.6" rx="2.8" ry="1.8" opacity=".13" />
        <ellipse cx="21.6" cy="1.8" rx="2.4" ry="1.6" opacity=".1" />
      </g>

      {/* Awning: canvas, lighter panels, scalloped valance, tie poles. */}
      <path d={CART_AWNING} fill={AWNING} stroke={PALETTE.line} strokeWidth="1" strokeLinejoin="round" />
      <path d="M39.6 4.6 L44.6 4.7 L41.4 15.1 L35.4 15.1 Z" fill={AWNING_LIT} opacity=".85" />
      <path d="M57.6 4.9 L62.6 5 L61.6 15.3 L55.6 15.2 Z" fill={AWNING_LIT} opacity=".85" />
      <path d="M75.6 5.1 L80.4 5.2 L81.8 15.4 L75.8 15.4 Z" fill={AWNING_LIT} opacity=".85" />
      <path d={CART_AWNING} fill={FILL.gloss} opacity=".5" />
      <path d={CART_VALANCE} fill={AWNING} stroke={PALETTE.line} strokeWidth=".7" strokeLinejoin="round" />
      <path d={tube(27.6, 21.8, 27, 15.2, 1.3)} fill={PALETTE.chrome} />
      <path d={tube(77.6, 21.4, 78.6, 15.5, 1.3)} fill={PALETTE.chrome} />

      {/* Condiment shelf hung off the service end. */}
      <path
        d="M76.4 26 L87 25.8 L87.2 27.4 L76.4 27.6 Z"
        fill={FILL.metal}
        stroke={PALETTE.line}
        strokeWidth=".7"
      />
      <path d={tube(77.2, 27.6, 75.8, 31.4, 1)} fill={PALETTE.rimShade} />
      <path
        d="M78 26 L78.2 22.6 C78.2 21.8 79 21.4 79.8 21.6 L80.6 21.8 C81.2 22 81.4 22.6 81.3 23.2 L81 26 Z"
        fill={AWNING}
        stroke={PALETTE.line}
        strokeWidth=".6"
      />
      <path
        d="M83 26 L83.2 23.4 C83.2 22.6 83.9 22.3 84.6 22.5 L85.2 22.7 C85.7 22.9 85.8 23.4 85.7 23.9 L85.5 26 Z"
        fill={PALETTE.amber}
        stroke={PALETTE.line}
        strokeWidth=".6"
      />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Shopping cart                                                       */
/* ------------------------------------------------------------------ */

/** Basket taper: deeper at the front so a rank of them nests. */
const SC_BASKET = "M26.4 16.6 L74 18.4 L71.2 30.8 L33.6 29.2 Z";

/** Nine wires down and three across — the lattice is the object. */
const SC_MESH = [
  ...Array.from({ length: 9 }, (_, index) => {
    const t = (index + 1) / 10;
    return (
      `M${(26.4 + t * 47.6).toFixed(1)} ${(16.6 + t * 1.8).toFixed(1)} ` +
      `L${(33.6 + t * 37.6).toFixed(1)} ${(29.2 + t * 1.6).toFixed(1)}`
    );
  }),
  ...[0.25, 0.5, 0.75].map(
    (u) =>
      `M${(26.4 + u * 7.2).toFixed(1)} ${(16.6 + u * 12.6).toFixed(1)} ` +
      `L${(74 - u * 2.8).toFixed(1)} ${(18.4 + u * 12.4).toFixed(1)}`,
  ),
].join("");

/** Wire rack slung under the basket. */
const SC_TRAY_WIRES = Array.from({ length: 6 }, (_, index) => {
  const t = (index + 1) / 7;
  return (
    `M${(33.6 + t * 36.4).toFixed(1)} ${(33.2 + t).toFixed(1)} ` +
    `L${(33.2 + t * 36.4).toFixed(1)} ${(34.9 + t).toFixed(1)}`
  );
}).join("");

/** Supermarket trolley abandoned on the kerb, child seat flapped down. */
export function ShoppingCart() {
  return (
    <VehicleSvg id={"street.shopping_cart"}>
      <Ground x={24} width={52} />

      {/* Chassis: legs down to the casters, then the tray between them. */}
      <g fill={PALETTE.rimShade}>
        <path d={tube(34.4, 29.4, 36.2, 38.6, 1.7)} />
        <path d={tube(40, 29.6, 41.6, 38.6, 1.5)} />
        <path d={tube(69.6, 30.6, 64.6, 38.6, 1.5)} />
        <path d={tube(70.8, 30.8, 69.8, 38.6, 1.7)} />
      </g>
      <path
        d="M33.6 33.2 L70 34.2 L69.6 35.9 L33.2 34.9 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d={SC_TRAY_WIRES} stroke={PALETTE.rim} strokeWidth=".8" opacity=".8" />

      {/* Basket frame and its mesh. */}
      <path d={SC_BASKET} fill={PALETTE.glass} opacity=".28" />
      <path d={SC_MESH} stroke={PALETTE.rim} strokeWidth=".9" opacity=".8" />
      <path d={SC_BASKET} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
      <path d={SC_BASKET} fill="none" stroke={PALETTE.line} strokeWidth=".7" strokeLinejoin="round" />

      {/* Child seat, folded down into the basket, leg holes and all. */}
      <path d="M28.8 18.4 L41.6 19.6 L40.4 26.8 L29.6 25.6 Z" fill={PALETTE.bodyShade} opacity=".8" />
      <path
        d="M28.8 18.4 L41.6 19.6 L40.4 26.8 L29.6 25.6 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <g stroke={PALETTE.rim} strokeWidth=".7" opacity=".7">
        <line x1="33" y1="18.8" x2="32.2" y2="25.9" />
        <line x1="37.2" y1="19.2" x2="36.4" y2="26.3" />
        <line x1="29.2" y1="22" x2="41" y2="23.1" />
      </g>
      <g fill={PALETTE.shadow} opacity=".8">
        <ellipse cx="32.6" cy="22.6" rx="1.5" ry="1.1" />
        <ellipse cx="37.6" cy="23.1" rx="1.5" ry="1.1" />
      </g>

      {/* Push handle and its uprights. */}
      <path d={tube(21.6, 13.4, 28.4, 14.2, 1.6)} fill={PALETTE.rimShade} />
      <path d={tube(20.4, 12.6, 28, 13.4, 2.8)} fill="currentColor" />
      <path d={tube(20.4, 12.6, 28, 13.4, 1)} fill="#eef3fa" opacity=".4" />
      <path d={tube(22.6, 13.6, 26.8, 17.2, 1.5)} fill={PALETTE.rimShade} />
      <path d={tube(27, 14, 29.4, 17.6, 1.5)} fill={PALETTE.rimShade} />

      <Wheel cx={36} cy={39} r={2} spokes={false} />
      <Wheel cx={41.4} cy={39} r={2} spokes={false} />
      <Wheel cx={64.4} cy={39} r={2} spokes={false} />
      <Wheel cx={69.6} cy={39} r={2} spokes={false} />
    </VehicleSvg>
  );
}
