"use client";

import {
  Arch,
  Body,
  DualWheel,
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
 * Transit and commercial slice: three buses that must not share a nose, an
 * articulated tram that runs on bogies, a liveried saloon taxi and a step-in
 * parcel van.
 *
 * Livery colours are the only hues allowed to escape `currentColor`, and they
 * are painted as inset panels so the catalog's class tint still reads along the
 * roof, sills and pillars of every vehicle.
 */
const LIVERY = {
  schoolYellow: "#f0bd22",
  taxiYellow: "#f7c62b",
  rubRail: "#161b22",
  chequerDark: "#12171f",
  chequerLight: "#eef3fa",
  decal: "#e8eef7",
} as const;

/**
 * A run of window bays as one path: rounded rectangles at a shared height so a
 * bus flank reads as bays and pillars rather than one long slot.
 */
function bays(
  xs: readonly number[],
  y: number,
  width: number,
  height: number,
  r = 1,
) {
  const w = width - 2 * r;
  const h = height - 2 * r;
  return xs
    .map(
      (x) =>
        `M${x + r} ${y}h${w}a${r} ${r} 0 0 1 ${r} ${r}v${h}` +
        `a${r} ${r} 0 0 1 ${-r} ${r}h${-w}a${r} ${r} 0 0 1 ${-r} ${-r}v${-h}` +
        `a${r} ${r} 0 0 1 ${r} ${-r}Z`,
    )
    .join("");
}

/** Alternating chequer squares, taxi flank. */
function Chequer({
  x,
  y,
  size,
  count,
}: {
  x: number;
  y: number;
  size: number;
  count: number;
}) {
  return (
    <g>
      {Array.from({ length: count }, (_, index) => (
        <rect
          key={index}
          x={x + index * size}
          y={y}
          width={size}
          height={size * 0.92}
          fill={index % 2 === 0 ? LIVERY.chequerDark : LIVERY.chequerLight}
          opacity={index % 2 === 0 ? 0.92 : 0.82}
        />
      ))}
    </g>
  );
}

/** Rail-vehicle running gear: frame, two small wheels, no road tire stance. */
function Bogie({ cx }: { cx: number }) {
  return (
    <g>
      <path
        d={`M${cx - 9.6} 33.2h19.2a1.8 1.8 0 0 1 1.8 1.8v3.6a1.8 1.8 0 0 1-1.8 1.8h-19.2a1.8 1.8 0 0 1-1.8-1.8V35a1.8 1.8 0 0 1 1.8-1.8Z`}
        fill={PALETTE.bodyShade}
      />
      <path
        d={`M${cx - 8.4} 34.4h16.8`}
        stroke={PALETTE.rimShade}
        strokeWidth="0.7"
        opacity="0.8"
      />
      <path
        d={`M${cx - 2.2} 33.6h4.4v3.2h-4.4Z`}
        fill={FILL.metal}
        opacity="0.75"
      />
      <Wheel cx={cx - 5.4} cy={38.8} r={3.6} spokes={false} />
      <Wheel cx={cx + 5.4} cy={38.8} r={3.6} spokes={false} />
    </g>
  );
}

/** Flat-front low-floor city transit bus. */
export function Bus() {
  return (
    <VehicleSvg id="vehicle.bus">
      <Ground x={6} width={86} />
      {/* roof HVAC hump, sitting proud of the roof skin */}
      <Body d="M25 8.4V6q0-1.4 1.6-1.4h23.8q1.6 0 1.6 1.4v2.4Z" outline={0.7} />
      {/* flat front, flat rear, straight low-floor sill */}
      <Body d="M4 36V11.2Q4 7.6 7.6 7.6H88.4Q92 7.6 92 11.2V33.4L89.6 36Z" />
      <path d="M5 32.6h84.4V35.2H5Z" fill={PALETTE.bodyShade} opacity="0.5" />
      {/* glazing: bays, two passenger doors, driver pane, deep windscreen */}
      <Glass d={bays([7.4, 16.4, 25.4], 12.4, 7.6, 11.8)} />
      <Glass d={bays([44, 53, 62], 12.4, 7.6, 11.8)} />
      <Glass d={bays([33.6, 69.6], 12.4, 8, 13.8)} />
      <Glass d={bays([78.8], 12.6, 3.4, 8.4)} />
      <Glass d="M82.8 12.4H90.2q1 0 1 1v12.4h-8.4Z" />
      {/* destination blind above the screen */}
      <rect
        x="82.6"
        y="8.4"
        width="8.8"
        height="3.4"
        rx="0.8"
        fill={PALETTE.bodyShade}
      />
      <rect
        x="83.6"
        y="9.2"
        width="6.8"
        height="1.8"
        rx="0.5"
        fill={PALETTE.amber}
        opacity="0.85"
      />
      {/* door apertures and their centre split */}
      <Seam d="M33.2 12v22.2M42 12v22.2M69.2 12v22.2M78 12v22.2" width={0.9} />
      <Seam
        d="M37.6 12.6v21.2M73.6 12.6v21.2"
        width={0.6}
        opacity={0.5}
      />
      <Seam d="M6.4 26.6h75.4" />
      <Seam d="M7.4 11.2h74.4" width={0.6} opacity={0.45} />
      {/* ramp lip at the centre door, the low-floor giveaway */}
      <path
        d="M33.4 34.4h8.6v1.6h-8.6Z"
        fill={PALETTE.chrome}
        opacity="0.55"
      />
      {/* front mirror arm */}
      <path d="M92 13.6 94.9 12.2" stroke={PALETTE.chrome} strokeWidth="0.8" />
      <rect
        x="94"
        y="10.6"
        width="1.8"
        height="4"
        rx="0.6"
        fill={PALETTE.chrome}
      />
      <circle cx="5.8" cy="10" r="0.8" fill={PALETTE.amber} opacity="0.85" />
      <circle cx="9" cy="10" r="0.8" fill={PALETTE.amber} opacity="0.85" />
      <Lamps front={87.4} frontY={29} rear={4.6} rearY={28.4} size={3} />
      <Arch cx={22} r={6.8} />
      <Arch cx={68} r={6.8} />
      <DualWheel cx={22} r={5.8} />
      <Wheel cx={68} r={5.8} />
    </VehicleSvg>
  );
}

/** Conventional bonneted school bus: hood ahead of the screen, yellow flanks. */
export function SchoolBus() {
  return (
    <VehicleSvg id="vehicle.school_bus">
      <Ground x={6} width={84} />
      <Body d="M5 34V10.2Q5 7.6 8 7.6H69Q71.4 7.6 71.4 10.4L77.6 20.4H88.2Q91 20.6 91 23.4V32.2L88.6 34Z" />
      {/* yellow livery: flank and hood side, roof and sill keep the class tint */}
      <path
        d="M6.8 9.6H69.6V32.6H6.8Z"
        fill={LIVERY.schoolYellow}
        opacity="0.93"
      />
      <path
        d="M78.6 21.8H89.6V31.4H78.6Z"
        fill={LIVERY.schoolYellow}
        opacity="0.93"
      />
      {/* black rub rails */}
      <path
        d="M6.8 27h62.8M6.8 31.2h62.8"
        stroke={LIVERY.rubRail}
        strokeWidth="1.4"
      />
      {/* five passenger bays, entrance door, wrap cab glass */}
      <Glass d={bays([8.6, 17.6, 26.6, 35.6, 44.6], 12, 7.6, 11.6)} />
      <Glass d={bays([54.8], 11.8, 7.6, 14.2)} />
      <Glass d="M64.4 11.8H71.2L76.8 19.8H64.4Z" />
      <Seam d="M70.8 12.2v7.2" width={0.7} opacity={0.6} />
      <Seam d="M54.6 11.8v22.2M62.6 11.8v22.2M58.6 12.4v21.4" width={0.8} />
      {/* stop arm folded on the flank */}
      <path d="M31.4 28.9h4.4" stroke={PALETTE.bodyShade} strokeWidth="1.7" />
      <path
        d="M36.8 25.5h2.6l1.9 1.9v2.6l-1.9 1.9h-2.6l-1.9-1.9v-2.6Z"
        fill={PALETTE.beaconRed}
        stroke="#fff"
        strokeWidth="0.75"
      />
      {/* warning lamps at all four roof corners */}
      <circle cx="8.8" cy="9.6" r="1.4" fill={PALETTE.beaconRed} />
      <circle cx="12.8" cy="9.6" r="1.4" fill={PALETTE.amber} />
      <circle cx="63.4" cy="9.6" r="1.4" fill={PALETTE.amber} />
      <circle cx="67.4" cy="9.6" r="1.4" fill={PALETTE.beaconRed} />
      <path
        d="M8.4 9.1h0.9M12.4 9.1h0.9M63 9.1h0.9M67 9.1h0.9"
        stroke="#fff"
        strokeWidth="0.7"
        opacity="0.8"
      />
      {/* nose: grille, lamps, black bumpers, folded crossing gate */}
      <Grille x={83.4} y={22.8} width={6.8} height={4.6} bars={3} />
      <Lamps front={84.6} frontY={28.4} rear={5.4} rearY={27.8} size={3} />
      <rect
        x="76.4"
        y="31.8"
        width="14.8"
        height="2.6"
        rx="0.8"
        fill={PALETTE.bodyShade}
      />
      <rect
        x="4"
        y="31.8"
        width="12"
        height="2.8"
        rx="0.8"
        fill={PALETTE.bodyShade}
      />
      <path
        d="M79.4 35.8h11.4"
        stroke={PALETTE.chrome}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M81.4 35.8h2.6M86.2 35.8h2.6"
        stroke={PALETTE.beaconRed}
        strokeWidth="1.6"
      />
      <circle
        cx="90.8"
        cy="34.2"
        r="1.3"
        fill={PALETTE.bodyShade}
        stroke={PALETTE.chrome}
        strokeWidth="0.55"
      />
      <Arch cx={24} r={7} />
      <Arch cx={73} r={7} />
      <DualWheel cx={24} r={5.8} />
      <Wheel cx={73} r={5.8} />
    </VehicleSvg>
  );
}

/** Cutaway shuttle: van cab and bonnet, taller boxy body grafted behind it. */
export function ShuttleBus() {
  return (
    <VehicleSvg id="vehicle.shuttle_bus">
      <Ground x={7} width={82} />
      {/* roof vent pod */}
      <Body d="M27 8V5.8q0-1.2 1.4-1.2h9.4q1.4 0 1.4 1.2V8Z" outline={0.7} />
      {/* cutaway step: tall cabin roof at 8, van cab roof at 13.4 */}
      <Body d="M5 35V10.4Q5 8 7.6 8H60V13.4H70.4L77 20.4H85L89.6 23.2Q91.4 24.4 91.4 26.8V32.8L89 35Z" />
      <path d="M6 32.4h82.4V34.4H6Z" fill={PALETTE.bodyShade} opacity="0.45" />
      {/* four passenger bays, then the wide wheelchair lift door */}
      <Glass d={bays([8.8, 17.8, 26.8, 35.8], 12.2, 7.6, 10.4)} />
      {/* wheelchair lift door: recessed frame, split glazing, mullion */}
      <path
        d="M44.6 11.2h13.6v22.2H44.6Z"
        fill={PALETTE.bodyShade}
        opacity="0.85"
      />
      <Glass d={bays([45.8], 12.2, 11.2, 9)} />
      <Glass d={bays([62.4], 14.6, 6.4, 6.4)} />
      <Glass d="M70.6 14.2H73.6L76.8 20.2H70.6Z" />
      {/* lift door frame, centre mullion, platform lip */}
      <Seam d="M44.6 11.2v22.2M58.2 11.2v22.2M51.4 12.2v20.8" width={0.9} />
      <rect
        x="44.2"
        y="33"
        width="14.2"
        height="1.8"
        rx="0.6"
        fill={PALETTE.bodyShade}
      />
      <path
        d="M45.6 33.9h11.4"
        stroke={PALETTE.chrome}
        strokeWidth="0.7"
        opacity="0.7"
      />
      {/* luggage bay line along the flank */}
      <Seam d="M6.6 29.4h52.6" />
      <path
        d="M11 29.6h17.4v4.2H11Z"
        fill={PALETTE.bodyShade}
        opacity="0.4"
      />
      <Seam d="M11 29.4v4.4M28.4 29.4v4.4" width={0.7} opacity={0.6} />
      <Seam d="M6.6 22.8h53" width={0.6} opacity={0.45} />
      {/* rear cap marker lamps */}
      <circle cx="9.2" cy="10.2" r="0.8" fill={PALETTE.amber} opacity="0.9" />
      <circle cx="12.4" cy="10.2" r="0.8" fill={PALETTE.amber} opacity="0.9" />
      <circle cx="15.6" cy="10.2" r="0.8" fill={PALETTE.amber} opacity="0.9" />
      {/* cab mirror on the A-pillar */}
      <path d="M70.2 16.4 67 15.4" stroke={PALETTE.chrome} strokeWidth="0.8" />
      <rect
        x="65.4"
        y="14"
        width="2"
        height="3.4"
        rx="0.6"
        fill={PALETTE.chrome}
        opacity="0.9"
      />
      <Grille x={85.4} y={24.4} width={5} height={4} bars={2} />
      <Lamps front={87.6} frontY={26.4} rear={5.4} rearY={27.4} size={2.9} />
      <Arch cx={26} r={7.2} />
      <Arch cx={74.5} r={6.8} />
      <DualWheel cx={26} r={5.6} />
      <Wheel cx={74.5} r={5.4} />
    </VehicleSvg>
  );
}

/** Articulated light-rail vehicle: pantograph, bellows, bogies, rail. */
export function Tram() {
  return (
    <VehicleSvg id="vehicle.tram">
      <Ground x={4} width={88} />
      {/* running rail, drawn with the ground so the bogies sit on it */}
      <rect x="0" y="42" width="96" height="1.4" fill={FILL.metal} opacity="0.8" />
      <path
        d="M0 43.4h96"
        stroke={PALETTE.shadow}
        strokeWidth="0.9"
        opacity="0.7"
      />
      <path
        d="M12 42.1v1.3M34 42.1v1.3M56 42.1v1.3M78 42.1v1.3"
        stroke={PALETTE.shadow}
        strokeWidth="0.8"
        opacity="0.5"
      />
      {/* couplers at both ends */}
      <rect
        x="0.4"
        y="31.2"
        width="3.4"
        height="2.8"
        rx="0.8"
        fill={PALETTE.bodyShade}
      />
      <rect
        x="92.2"
        y="31.2"
        width="3.4"
        height="2.8"
        rx="0.8"
        fill={PALETTE.bodyShade}
      />
      {/* roof pods */}
      <Body d="M16 6.4V4.8q0-1 1.2-1h12q1.2 0 1.2 1v1.6Z" outline={0.6} />
      <Body d="M58 6.4V4.8q0-1 1.2-1h13q1.2 0 1.2 1v1.6Z" outline={0.6} />
      {/* double-ended shell, raked cab faces at both extremities */}
      <Body d="M2.6 33.4V14.8L8.6 7.4Q9.6 6.2 11.6 6.2H84.6Q86.6 6.2 87.6 7.4L93.4 14.8V33.4Z" />
      <path d="M3.4 30.4h89.2v3H3.4Z" fill={PALETTE.bodyShade} opacity="0.45" />
      {/* cab screens at each end */}
      <Glass d="M11.8 9.6H8L3.8 15.2V21.6H11.8Z" />
      <Glass d="M84.2 9.6H88L92.2 15.2V21.6H84.2Z" />
      {/* window bays either side of the articulation */}
      <Glass d={bays([13.6, 22, 30.4], 11.6, 7.4, 9.8)} />
      <Glass d={bays([52.4, 60.8, 69.2], 11.6, 7.4, 9.8)} />
      {/* doors between the bays */}
      <Glass d={bays([38.8, 77.8], 11.6, 5.6, 13.4)} />
      <Seam d="M38.6 11.2v21.8M44.6 11.2v21.8M77.6 11.2v21.8M83.6 11.2v21.8" width={0.9} />
      <Seam d="M41.6 11.8v20.8M80.6 11.8v20.8" width={0.6} opacity={0.5} />
      {/* articulation bellows */}
      <path d="M45 6.6h6v26.6h-6Z" fill={PALETTE.bodyShade} />
      <path
        d="M46.2 7.4v25M47.6 7.4v25M49 7.4v25M50.4 7.4v25"
        stroke={PALETTE.rimShade}
        strokeWidth="0.6"
        opacity="0.75"
      />
      <Seam d="M4 23.4h40.6M51.4 23.4h40.6" width={0.7} opacity={0.55} />
      {/* single-arm pantograph, folded */}
      <path
        d="M33.4 6.2 44.6 2.7M44.6 2.7 37.2 1.8M44.6 2.7 45.4 6.2"
        stroke={PALETTE.chrome}
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <rect
        x="33"
        y="0.8"
        width="11.4"
        height="1.5"
        rx="0.7"
        fill={FILL.metal}
      />
      <rect
        x="32.4"
        y="5"
        width="2.2"
        height="1.6"
        rx="0.5"
        fill={PALETTE.rimShade}
      />
      <rect
        x="43.4"
        y="5"
        width="2.2"
        height="1.6"
        rx="0.5"
        fill={PALETTE.rimShade}
      />
      <Lamps front={89.8} frontY={24.6} rear={3.4} rearY={24.6} size={2.6} />
      <rect
        x="85.6"
        y="25"
        width="2.6"
        height="2"
        rx="0.6"
        fill={PALETTE.lamp}
        opacity="0.75"
      />
      <Bogie cx={15} />
      <Bogie cx={48} />
      <Bogie cx={81} />
    </VehicleSvg>
  );
}

/** Liveried saloon taxi: roof sign, chequer band, door decal, meter aerial. */
export function Taxi() {
  return (
    <VehicleSvg id="vehicle.taxi">
      <Ground x={8} width={82} />
      {/* three-box saloon: long bonnet, upright greenhouse, notch boot */}
      <Body d="M6.6 34V26.6L10 24.6L20 23.4L28.4 14.6Q29.4 13.4 31.4 13.4H56.6Q58.6 13.4 60 14.8L68.6 23.6L85.6 24.6L90 26.6Q92 27.4 92 29.6V32.4L90 34Z" />
      {/* yellow flank livery under the beltline */}
      <path
        d="M8 26.8 20 25.2H68L86 26L89.6 27.8V31.8H8Z"
        fill={LIVERY.taxiYellow}
        opacity="0.92"
      />
      {/* glazing split by the B-pillar */}
      <Glass d="M31.6 15.4 22.8 23.2H44.4V15.4Z" />
      <Glass d="M46.6 15.4V23.2H67.2L58.6 15.4Z" />
      {/* rear door decal panel and the chequer band */}
      <rect
        x="30"
        y="25.4"
        width="15.6"
        height="2.6"
        rx="0.5"
        fill={LIVERY.decal}
        opacity="0.9"
      />
      <Chequer x={22} y={28.4} size={3.6} count={9} />
      {/* door cuts, handles, sill and crease */}
      <Seam d="M29.4 24.4v9M52 24.2v9.2" width={0.85} />
      <rect
        x="35.6"
        y="23.9"
        width="3.2"
        height="1"
        rx="0.5"
        fill={PALETTE.chrome}
        opacity="0.9"
      />
      <rect
        x="55.6"
        y="23.9"
        width="3.2"
        height="1"
        rx="0.5"
        fill={PALETTE.chrome}
        opacity="0.9"
      />
      <Seam d="M10.4 32.6h78.4" width={0.7} opacity={0.5} />
      <Seam d="M21 24.6h46.4" width={0.6} opacity={0.4} />
      {/* roof sign, its feet, and the meter aerial */}
      <rect
        x="39"
        y="8.8"
        width="13.6"
        height="4.8"
        rx="1.2"
        fill={LIVERY.taxiYellow}
        stroke={PALETTE.line}
        strokeWidth="0.7"
      />
      <rect
        x="40.6"
        y="9.9"
        width="10.4"
        height="1.7"
        rx="0.5"
        fill={PALETTE.bodyShade}
        opacity="0.85"
      />
      <rect
        x="40.6"
        y="12.1"
        width="10.4"
        height="0.8"
        rx="0.4"
        fill="#fff"
        opacity="0.45"
      />
      <path
        d="M33.4 13.4 31.8 6.2"
        stroke={PALETTE.chrome}
        strokeWidth="0.7"
      />
      <circle cx="31.7" cy="5.6" r="1" fill={PALETTE.chrome} />
      {/* mirror on the A-pillar */}
      <path d="M60.6 17.8 63.4 17.2" stroke={PALETTE.chrome} strokeWidth="0.8" />
      <rect
        x="62.8"
        y="16.2"
        width="2.6"
        height="2.6"
        rx="0.8"
        fill={PALETTE.chrome}
        opacity="0.9"
      />
      <Grille x={85.8} y={29.6} width={5.6} height={3.2} bars={2} />
      <rect
        x="7"
        y="32.2"
        width="2.6"
        height="1.4"
        rx="0.6"
        fill={PALETTE.bodyShade}
      />
      <Lamps front={88.8} frontY={27.2} rear={7} rearY={26.8} size={3} />
      <rect
        x="85.8"
        y="27.4"
        width="2.2"
        height="1.8"
        rx="0.5"
        fill={PALETTE.amber}
        opacity="0.85"
      />
      <Arch cx={24} r={7.6} />
      <Arch cx={76} r={7.6} />
      <Wheel cx={24} r={5.4} />
      <Wheel cx={76} r={5.4} />
    </VehicleSvg>
  );
}

/** Step-in parcel van: tall blank cargo box, snub nose, open cab doorway. */
export function DeliveryVan() {
  return (
    <VehicleSvg id="vehicle.delivery_van">
      <Ground x={5} width={86} />
      {/* tall box body, short bonnet, deeply raked screen */}
      <Body d="M4 35V9Q4 6.4 6.8 6.4H79.2Q80.8 6.4 81.6 7.6L88.4 18.4Q89.2 19.6 90.4 20.3Q92.2 21.4 92.2 23.6V32.6L89.8 35Z" />
      {/* roof rack: rail plus cross members */}
      <path
        d="M12 4.8h48"
        stroke={PALETTE.chrome}
        strokeWidth="0.9"
        strokeLinecap="round"
        opacity="0.9"
      />
      <path
        d="M17 4.9v1.6M29 4.9v1.6M41 4.9v1.6M53 4.9v1.6"
        stroke={PALETTE.chrome}
        strokeWidth="0.7"
        opacity="0.7"
      />
      {/* roll-up rear door: shutter slats, pull handle, step bumper */}
      <path
        d="M5.2 9.8h8.4v23.4H5.2Z"
        fill={PALETTE.bodyShade}
        opacity="0.7"
      />
      <path
        d="M5.2 12.6h8.4M5.2 15.4h8.4M5.2 18.2h8.4M5.2 21h8.4M5.2 23.8h8.4M5.2 26.6h8.4M5.2 29.4h8.4M5.2 32.2h8.4"
        stroke={PALETTE.chrome}
        strokeWidth="0.6"
        opacity="0.4"
      />
      <Seam d="M13.8 9.8v23.4" width={0.8} opacity={0.6} />
      <rect
        x="7.4"
        y="31.8"
        width="3"
        height="1.1"
        rx="0.5"
        fill={PALETTE.chrome}
        opacity="0.8"
      />
      <rect
        x="3.6"
        y="33.4"
        width="11.4"
        height="2.4"
        rx="0.8"
        fill={PALETTE.bodyShade}
      />
      {/* blank flank: panel seams, rub rail, filler */}
      <Seam d="M20 8.6v24.4M36 8.6v24.4M52 8.6v24.4" width={0.6} opacity={0.35} />
      <Seam d="M6 20h54" width={0.7} opacity={0.45} />
      <path
        d="M6 27.6h54"
        stroke={LIVERY.rubRail}
        strokeWidth="1.3"
        opacity="0.9"
      />
      <circle cx="45" cy="30.6" r="1.5" fill={PALETTE.bodyShade} opacity="0.85" />
      <circle
        cx="45"
        cy="30.6"
        r="1.5"
        fill="none"
        stroke={PALETTE.chrome}
        strokeWidth="0.5"
        opacity="0.55"
      />
      {/* open sliding cab doorway with its step */}
      <path d="M61 12.4h8.4v20.8H61Z" fill={PALETTE.bodyShade} />
      <path d="M62.4 14h5.6v18.2h-5.6Z" fill={PALETTE.shadow} opacity="0.75" />
      <Seam d="M60.6 11.6h9.2" width={0.8} opacity={0.6} />
      <path
        d="M69.2 13.4v18"
        stroke={PALETTE.chrome}
        strokeWidth="0.7"
        opacity="0.75"
      />
      <rect
        x="60.6"
        y="33"
        width="9.4"
        height="1.8"
        rx="0.5"
        fill={PALETTE.bodyShade}
      />
      <path
        d="M62 33.9h6.6"
        stroke={PALETTE.chrome}
        strokeWidth="0.7"
        opacity="0.65"
      />
      {/* cab glazing */}
      <Glass d={bays([72], 10.4, 5.8, 7.4)} />
      <Glass d="M78.4 9.6H81L87.6 18.6H78.4Z" />
      {/* forward mirror, past the nose as step vans carry them */}
      <path d="M88.6 15.6 91.6 14.4" stroke={PALETTE.chrome} strokeWidth="0.8" />
      <rect
        x="90.6"
        y="12.6"
        width="2.4"
        height="4.2"
        rx="0.7"
        fill={PALETTE.chrome}
        opacity="0.9"
      />
      <circle cx="6.8" cy="8.6" r="0.75" fill={PALETTE.amber} opacity="0.9" />
      <circle cx="9.6" cy="8.6" r="0.75" fill={PALETTE.amber} opacity="0.9" />
      <circle cx="12.4" cy="8.6" r="0.75" fill={PALETTE.amber} opacity="0.9" />
      <Grille x={88.2} y={24.4} width={3.6} height={3.6} bars={2} />
      <Lamps front={88.4} frontY={28.4} rear={4.4} rearY={28} size={2.9} />
      <Arch cx={24} r={7.4} />
      <Arch cx={76.5} r={7} />
      <DualWheel cx={24} r={5.7} />
      <Wheel cx={76.5} r={5.5} />
    </VehicleSvg>
  );
}
