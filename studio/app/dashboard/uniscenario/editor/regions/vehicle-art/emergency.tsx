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
  LightBar,
  PALETTE,
  Seam,
  VehicleSvg,
  Wheel,
} from "./parts";

/**
 * Emergency fleet: ambulance, police cruiser, police SUV, fire command SUV,
 * fire pumper.
 *
 * Livery is the identity of these five, so unlike the rest of the fleet they
 * carry fixed hues — but only as markings *over* the `currentColor` shell, so
 * the catalog's class tint still reads through. Everything else follows the
 * shared geometry contract in `parts.tsx`.
 */

/** Livery hues. Only these five vehicles are allowed fixed colour. */
const LIVERY = {
  cross: "#e2352c",
  fire: "#c92f28",
  stripe: "#eaf2fc",
  gold: "#e6c469",
} as const;

/** Amber/marker lamp pip. Too small for `Lamps`, too common to repeat inline. */
function Marker({
  x,
  y,
  width = 2.6,
  height = 1.8,
  fill = PALETTE.amber,
}: {
  x: number;
  y: number;
  width?: number;
  height?: number;
  fill?: string;
}) {
  return <rect x={x} y={y} width={width} height={height} rx={height * 0.4} fill={fill} />;
}

/** Antenna whip with its roof base. */
function Whip({ d, base }: { d: string; base?: [number, number] }) {
  return (
    <g>
      {base ? <circle cx={base[0]} cy={base[1]} r=".9" fill={PALETTE.rimShade} /> : null}
      <path d={d} fill="none" stroke={PALETTE.chrome} strokeWidth=".8" strokeLinecap="round" opacity=".85" />
    </g>
  );
}

/** Tubular push bumper: two uprights, two cross rails. */
function PushBar({ x, top, bottom }: { x: number; top: number; bottom: number }) {
  const height = bottom - top;
  return (
    <g fill={FILL.metal}>
      <rect x={x} y={top} width="1.7" height={height} rx=".8" />
      <rect x={x + 2.6} y={top + 1} width="1.7" height={height - 1} rx=".8" />
      <rect x={x - 1} y={top + height * 0.28} width="6.3" height="1.4" rx=".7" />
      <rect x={x - 1} y={top + height * 0.72} width="6.3" height="1.4" rx=".7" />
    </g>
  );
}

/** Five-point department star. */
function Star({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const points = Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? r : r * 0.42;
    const radians = ((-90 + index * 36) * Math.PI) / 180;
    return `${(cx + Math.cos(radians) * radius).toFixed(2)} ${(cy + Math.sin(radians) * radius).toFixed(2)}`;
  });
  return <path d={`M${points.join("L")}Z`} fill={LIVERY.gold} opacity=".92" />;
}

/* ------------------------------------------------------------------ */

const AMBULANCE_SHELL =
  "M6 33.6 L6 8.6 Q6 6.6 8 6.6 L55.4 6.6 L55.4 13.2 L69.4 13.2 " +
  "Q71.4 13.2 72.6 15 L76.8 20.6 L88.4 22.6 Q91.4 23.2 91.6 26.2 " +
  "L91.6 31.4 L90.2 33.6 L85.6 33.6 A6.6 6.6 0 0 0 72.4 33.6 " +
  "L28.6 33.6 A6.6 6.6 0 0 0 15.4 33.6 Z";

export function Ambulance() {
  return (
    <VehicleSvg id="vehicle.ambulance">
      <Ground x={4} width={88} />
      {/* Chassis rails under the box, and the rear step bumper. */}
      <rect x="10" y="32.8" width="76" height="3" fill={PALETTE.bodyShade} opacity=".9" />
      <rect x="2.8" y="33.2" width="6.2" height="2.8" rx=".9" fill={PALETTE.bodyShade} />
      <rect x="2.8" y="33.2" width="6.2" height=".9" rx=".4" fill={PALETTE.rimShade} opacity=".8" />

      <Body d={AMBULANCE_SHELL} />

      {/* Cab glazing, then the frosted window in the box side door. */}
      <Glass d="M72 15.4 L76.2 20.2 L72 20.2 Z" />
      <Glass d="M70.4 14 L70.4 20.2 L58.2 20.2 L58.2 14 Z" />
      <Glass d="M44.4 10.8 L53.2 10.8 L53.2 17 L44.4 17 Z" opacity={0.82} />

      {/* Box panel joints: rear door, side door, cab bulkhead, roof rail. */}
      <Seam d="M8.6 9.4 L54.6 9.4" width={0.7} opacity={0.5} />
      <Seam d="M17.8 7.4 L17.8 33" />
      <Seam d="M42.6 7.6 L42.6 33" />
      <Seam d="M54.6 7.6 L54.6 33" />
      <Seam d="M58.4 21.4 L70.2 21.4" width={0.7} opacity={0.5} />
      <path d="M43.4 25.6 h11.2" stroke={PALETTE.chrome} strokeWidth=".9" opacity=".7" strokeLinecap="round" />

      {/* Livery: full red cross on the box flank, low stripe broken by the arches. */}
      <g fill={LIVERY.cross}>
        <rect x="27" y="18" width="12.2" height="3.8" rx=".5" />
        <rect x="31.2" y="14.2" width="3.8" height="11.4" rx=".5" />
        <rect x="7" y="27.4" width="8" height="3.2" />
        <rect x="29" y="27.4" width="43.2" height="3.2" />
        <rect x="86" y="27.4" width="4.4" height="2.4" />
      </g>

      {/* Roof light bar over the cab, rear dome, amber markers on the box corners. */}
      <LightBar x={57.8} y={8.8} width={12.4} height={4.4} />
      <path d="M7.8 6.6 a2.7 2.4 0 0 1 5.4 0 Z" fill={PALETTE.beaconRed} />
      <Marker x={7.4} y={7.8} />
      <Marker x={51.2} y={7.8} />
      <Marker x={20} y={7.8} />
      <Marker x={6.2} y={30.8} width={2.2} height={1.6} fill={PALETTE.tail} />

      {/* Cab front end. */}
      <Grille x={85.2} y={28.4} width={5.4} height={3.4} bars={2} />
      <Lamps front={87.2} frontY={23.4} rear={6.3} rearY={22.6} size={3} />
      <path d="M72.8 15.8 L76.6 16.8 L76.6 18.6 L72.8 17.4 Z" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />

      <Arch cx={22} r={6.6} />
      <Arch cx={79} r={6.6} />
      <Wheel cx={22} r={5.9} />
      <Wheel cx={79} r={5.9} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */

const CRUISER_SHELL =
  "M8.6 30.4 Q7.6 24.8 10 23.6 L15 23 L30.2 22.8 L37.2 16.2 Q38.6 15 40.6 15 " +
  "L60.6 15 Q62.8 15 64 16.4 L70.8 22.6 L86.4 23.4 Q90.6 23.8 91.4 26.6 " +
  "L91.8 30.6 L90.2 33.2 L79.8 33.2 A6.6 6.6 0 0 0 66.6 33.2 " +
  "L31.4 33.2 A6.6 6.6 0 0 0 18.2 33.2 L10 33.2 Q8.4 32.4 8.6 30.4 Z";

export function PoliceCruiser() {
  return (
    <VehicleSvg id="vehicle.police_cruiser">
      <Ground x={8} width={82} />
      <rect x="20" y="32.4" width="52" height="2.4" fill={PALETTE.bodyShade} opacity=".85" />

      <Body d={CRUISER_SHELL} />

      {/* Low saloon greenhouse: raked screen, two door panes, notchback backlight. */}
      <Glass d="M64.6 16.6 L70 22.2 L64.6 22.2 Z" />
      <Glass d="M63 16.4 L63 22.2 L52.6 22.2 L52.6 16.4 Z" />
      <Glass d="M51 16.4 L51 22.2 L41.6 22.2 L41.6 16.4 Z" />
      <Glass d="M40.2 16.4 L40.2 22.4 L34.8 22.4 Z" />

      {/* Two-tone: black door skins over a light shell. */}
      <path d="M41 23.6 L63.4 23.6 L63.4 32.6 L41 32.6 Z" fill={PALETTE.bodyShade} opacity=".92" />
      <path d="M41 23.6 L63.4 23.6" stroke={PALETTE.chrome} strokeWidth=".7" opacity=".6" />
      <Star cx={52.2} cy={27.9} r={2.7} />

      <Seam d="M41 23.4 L41 32.6" />
      <Seam d="M51.8 23.6 L51.8 32.4" />
      <Seam d="M63.4 23.6 L63.4 32.6" />
      <Seam d="M12.4 23.4 L30 23.2" width={0.7} opacity={0.5} />
      <Seam d="M71.6 23.6 L86 24.4" width={0.7} opacity={0.5} />
      <Seam d="M32 32.4 L66 32.4" width={0.7} opacity={0.45} />
      <g stroke={PALETTE.chrome} strokeWidth=".8" opacity=".55" strokeLinecap="round">
        <path d="M53 24.6 h7.6" />
        <path d="M42.4 24.6 h7" />
      </g>

      {/* Roof bar, A-pillar spotlight, trunk-lid whip. */}
      <LightBar x={43} y={10.4} width={16.4} height={4.6} />
      <g>
        <rect x="62.4" y="16.2" width="4" height="1.5" rx=".7" fill={FILL.metal} />
        <circle cx="66.8" cy="17" r="1.9" fill={PALETTE.lamp} stroke={PALETTE.chrome} strokeWidth=".5" />
      </g>
      <Whip d="M16.6 23 Q14.8 13.4 14.2 5.4" base={[16.6, 23]} />

      <Grille x={85} y={27.8} width={5.4} height={3} bars={2} />
      <Lamps front={85.8} frontY={24.4} rear={9.4} rearY={24.2} size={3} />
      <PushBar x={90.6} top={24.4} bottom={33} />
      <ellipse cx="11.6" cy="32.6" rx="1.5" ry=".9" fill={PALETTE.bodyShade} />

      <Arch cx={24.8} r={6.6} />
      <Arch cx={73} r={6.6} />
      <Wheel cx={24.8} r={5.7} />
      <Wheel cx={73} r={5.7} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */

const POLICE_SUV_SHELL =
  "M18 32.2 L21.6 14 Q22 11.4 24.6 11.4 L63.4 11.4 Q65.8 11.4 67 13 " +
  "L71.8 20.4 L87.6 21.8 Q91.2 22.2 91.8 25.2 L92.1 29.4 L90.8 32.2 " +
  "L81.4 32.2 A7.4 7.4 0 0 0 66.6 32.2 L34.4 32.2 A7.4 7.4 0 0 0 19.6 32.2 Z";

export function PoliceSuv() {
  return (
    <VehicleSvg id="vehicle.police_suv">
      <Ground x={13} width={80} />
      <rect x="21" y="31.4" width="52" height="3.2" fill={PALETTE.bodyShade} opacity=".85" />

      <Body d={POLICE_SUV_SHELL} />

      {/* Deep flank under a shallow greenhouse, raked D-pillar: SUV, not a van. */}
      <Glass d="M67.2 13.2 L71.2 19 L67.2 19 Z" />
      <Glass d="M65.6 12.4 L65.6 19 L52.4 19 L52.4 12.4 Z" />
      <Glass d="M50.8 12.4 L50.8 19 L38 19 L38 12.4 Z" />
      <Glass d="M36.4 12.4 L36.4 19 L25.4 19 L26.6 12.4 Z" />

      {/* Reflective stripe, then blacked-out rocker cladding and arch flares. */}
      <rect x="20.6" y="20.6" width="63" height="1.7" fill={LIVERY.stripe} opacity=".5" />
      <rect x="20.6" y="22.3" width="63" height=".8" fill={PALETTE.beaconBlue} opacity=".75" />
      <rect x="34.6" y="29.6" width="32" height="2.6" fill={PALETTE.bodyShade} opacity=".92" />
      <rect x="81.6" y="29.6" width="9.4" height="2.6" fill={PALETTE.bodyShade} opacity=".8" />
      <g fill="none" stroke={PALETTE.bodyShade} strokeWidth="2.8" strokeLinecap="round" opacity=".95">
        <path d="M19.6 32.2 a7.4 7.4 0 0 1 14.8 0" />
        <path d="M66.6 32.2 a7.4 7.4 0 0 1 14.8 0" />
      </g>

      <Seam d="M37.4 19.6 L37.4 29.6" />
      <Seam d="M51.6 19.6 L51.6 29.6" />
      <Seam d="M25.8 19.6 L25.8 29.6" />
      <Seam d="M72.4 20.9 L87.4 22.2" width={0.7} opacity={0.5} />
      <Seam d="M69.8 21.6 L71.8 20.6" width={0.7} opacity={0.6} />
      <path d="M39 25 h9.4" stroke={PALETTE.chrome} strokeWidth=".8" opacity=".5" strokeLinecap="round" />
      <path d="M53.4 25 h8.8" stroke={PALETTE.chrome} strokeWidth=".8" opacity=".5" strokeLinecap="round" />

      {/* Roof kit: bar plus a bank of antennas — no spotlight, unlike the cruiser. */}
      <LightBar x={44} y={6.8} width={18} height={4.6} />
      <Whip d="M28 11.4 Q27.2 7.4 26.8 4" base={[28, 11.4]} />
      <Whip d="M32.4 11.4 Q32 8.2 31.8 5.6" base={[32.4, 11.4]} />
      <Whip d="M37.4 11.4 Q38 7.8 38.4 3.4" base={[37.4, 11.4]} />
      <path d="M25.6 11.4 h1.2 M63.8 11.4 h1.4" stroke={PALETTE.rimShade} strokeWidth="1.2" strokeLinecap="round" />

      <path d="M67.6 13.6 L71.6 14.6 L71.6 16.6 L67.6 15.4 Z" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />
      <Grille x={85.8} y={26} width={5.2} height={3.4} bars={3} />
      <Lamps front={86.6} frontY={22.6} rear={19} rearY={22} size={3.1} />
      <PushBar x={90.8} top={22.4} bottom={32} />

      <Arch cx={27} r={7.4} />
      <Arch cx={74} r={7.4} />
      <Wheel cx={27} r={6.4} />
      <Wheel cx={74} r={6.4} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */

const FIRE_COMMAND_SHELL =
  "M17.2 29.8 L18.8 12.4 Q19.2 10.6 21.2 10.6 L58.4 10.6 Q60.8 10.6 62.2 12.6 " +
  "L68.6 19.8 L84.6 20.8 Q89 21.2 89.8 24.2 L90.2 27.8 L88.8 29.8 " +
  "L79.9 29.8 A7.4 7.4 0 0 0 65.1 29.8 L31.7 29.8 A7.4 7.4 0 0 0 16.9 29.8 Z";

/** Tapered roof cargo box — sloped leading edge so it never reads as a raised roof. */
const COMMAND_CARGO_BOX = "M27.6 10.6 L27.6 7.2 Q27.6 5.6 29.2 5.6 L46.2 5.6 Q48.8 5.6 50 7.4 L51.2 10.6 Z";

export function FireCommandSuv() {
  return (
    <VehicleSvg id="vehicle.fire_command_suv">
      <Ground x={13} width={80} />
      {/* Lifted chassis: frame rail and axle stay visible under the sill. */}
      <rect x="21" y="29.4" width="52" height="2.4" fill={PALETTE.bodyShade} />
      <rect x="30" y="30.2" width="34" height="1.4" fill={PALETTE.rimShade} opacity=".55" />

      <Body d={FIRE_COMMAND_SHELL} />

      {/* Short two-door-glass command rig: the rear quarter is blanked for kit. */}
      <Glass d="M62.6 13 L67.8 19.4 L62.6 19.4 Z" />
      <Glass d="M61 11.8 L61 18.4 L47.4 18.4 L47.4 11.8 Z" />
      <Glass d="M45.8 11.8 L45.8 18.4 L32.8 18.4 L32.8 11.8 Z" />
      <Seam d="M21.2 12.6 L21.2 22.6" />
      <Seam d="M31.2 11.8 L31.2 22.6" />
      <path d="M22.6 15 h8" stroke={PALETTE.chrome} strokeWidth=".8" opacity=".45" strokeLinecap="round" />

      {/* Roof cargo box on its rack — the silhouette cue. */}
      <path d={COMMAND_CARGO_BOX} fill="currentColor" />
      <path d={COMMAND_CARGO_BOX} fill={FILL.gloss} />
      <path d={COMMAND_CARGO_BOX} fill="none" stroke={PALETTE.line} strokeWidth="1" strokeLinejoin="round" />
      <Seam d="M28.4 8.6 L49.6 8.6" width={0.7} opacity={0.6} />
      <path d="M23.6 10.3 h32" stroke={PALETTE.rimShade} strokeWidth="1" strokeLinecap="round" />

      {/* Reflective flank stripe with a red pinstripe below it. */}
      <rect x="19.2" y="19.2" width="65" height="1.8" fill={LIVERY.stripe} opacity=".5" />
      <rect x="19.2" y="21" width="65" height=".9" fill={LIVERY.fire} opacity=".9" />
      <circle cx="54" cy="24.6" r="2.6" fill={LIVERY.gold} opacity=".9" />
      <path d="M53.1 22.5 h1.8 v1.2 h1.2 v1.8 h-1.2 v1.2 h-1.8 v-1.2 h-1.2 v-1.8 h1.2 Z" fill={LIVERY.fire} />

      <Seam d="M32.4 18.8 L32.4 29.2" />
      <Seam d="M46.8 18.8 L46.8 29.2" />
      <Seam d="M69.4 19.2 L84.4 20.2" width={0.7} opacity={0.5} />
      {/* Flank equipment locker. */}
      <Grille x={35} y={23.6} width={10} height={4.8} bars={3} />
      {/* Running boards, slung under the lifted body. */}
      <rect x="33" y="31.2" width="31" height="1.8" rx=".8" fill={PALETTE.bodyShade} />
      <rect x="33" y="31.2" width="31" height=".7" rx=".3" fill={PALETTE.rimShade} opacity=".8" />
      <path d="M35.4 33 L35.4 31.4 M61.6 33 L61.6 31.4" stroke={PALETTE.bodyShade} strokeWidth="1.1" />

      {/* Single red beacon plus a radio antenna farm. */}
      <LightBar x={52.6} y={7} width={7.6} height={3.6} solid={PALETTE.beaconRed} />
      <Marker x={22.4} y={7.8} width={3} height={2} />
      <Whip d="M23.6 10.6 Q22.4 5.8 21.8 2.4" base={[23.6, 10.6]} />
      <Whip d="M54.6 10.6 Q55.8 6.2 56.2 2.8" base={[54.6, 10.6]} />
      <Whip d="M57.6 10.8 Q58.4 8 58.8 5.6" base={[57.6, 10.8]} />

      <path d="M63.2 13.2 L67 14.2 L67 16.2 L63.2 15 Z" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />
      <Grille x={83.8} y={24.2} width={5} height={3.2} bars={3} />
      <Lamps front={84.4} frontY={21} rear={18.2} rearY={21.2} size={3.1} />
      {/* Winch bumper instead of a police push bar. */}
      <rect x="87.2" y="24.8" width="6.2" height="4.8" rx="1.1" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".7" />
      <circle cx="90.3" cy="27.2" r="1.6" fill={FILL.metal} />

      <Arch cx={24.3} r={7.4} />
      <Arch cx={72.5} r={7.4} />
      <Wheel cx={24.3} r={6.4} />
      <Wheel cx={72.5} r={6.4} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */

const FIRE_ENGINE_SHELL =
  "M5 30.4 L5 13.6 Q5 12.4 6.4 12.4 L54.6 12.4 L54.6 7.8 Q54.6 6.2 56.4 6.2 " +
  "L88 6.2 Q91.2 6.2 91.8 9.4 L92.6 15.4 L92.8 28.4 L91.6 30.4 " +
  "L83 30.4 A7 7 0 0 0 69 30.4 L34 30.4 L34 28.8 L14 28.8 L14 30.4 Z";

const HOSE_BED = "M6.6 12.4 L6.6 9.6 Q6.6 8.4 7.9 8.4 L31.4 8.4 Q32.6 8.4 32.6 9.6 L32.6 12.4 Z";

export function FireEngine() {
  return (
    <VehicleSvg id="vehicle.fire_engine">
      <Ground x={2} width={92} />
      {/* Frame rails and rear step. */}
      <rect x="8" y="29.6" width="80" height="3.2" fill={PALETTE.bodyShade} opacity=".9" />
      <rect x="2.2" y="29.8" width="5.6" height="3.2" rx=".8" fill={PALETTE.bodyShade} />
      <rect x="2.2" y="29.8" width="5.6" height=".9" rx=".4" fill={PALETTE.rimShade} opacity=".8" />

      <Body d={FIRE_ENGINE_SHELL} />
      {/* Deep red livery over the tinted shell, then the gloss again on top. */}
      <path d={FIRE_ENGINE_SHELL} fill={LIVERY.fire} opacity=".64" />
      <path d={FIRE_ENGINE_SHELL} fill={FILL.gloss} />

      {/* Hose bed coaming above the pump body, packed hose inside. */}
      <path d={HOSE_BED} fill="currentColor" />
      <path d={HOSE_BED} fill={LIVERY.fire} opacity=".64" />
      <path d={HOSE_BED} fill={FILL.gloss} />
      <path d={HOSE_BED} fill="none" stroke={PALETTE.line} strokeWidth="1" strokeLinejoin="round" />
      <rect x="8.2" y="9.2" width="22.8" height="2.6" rx=".6" fill={PALETTE.bodyShade} />
      <path d="M9 10.6 h21.2 M9 11.4 h21.2" stroke={PALETTE.rimShade} strokeWidth=".6" opacity=".8" />

      {/* Crew-cab glazing: flat cab-over screen plus two door panes. */}
      <Glass d="M86.6 7.8 L91.2 9.4 L91.8 18.6 L86.6 17.8 Z" />
      <Glass d="M84.6 8.4 L84.6 17.6 L74.4 17.6 L74.4 8.4 Z" />
      <Glass d="M72.8 8.8 L72.8 17.6 L64 17.6 L64 8.8 Z" />
      <Seam d="M73.6 17.8 L73.6 29.6" />
      <Seam d="M63.4 8.6 L63.4 29.6" />
      <Seam d="M54.6 8.4 L54.6 29.6" />
      <path d="M65.4 19 h7.2 M75.6 19 h8.4" stroke={PALETTE.chrome} strokeWidth=".9" opacity=".6" strokeLinecap="round" />
      <rect x="57.4" y="18.2" width="29" height="1.3" fill={LIVERY.gold} opacity=".85" />
      <path d="M85.4 9.6 L89.4 10.8 L89.4 12.8 L85.4 11.4 Z" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />

      {/* Roof ladder along the pump body flank. */}
      <g stroke={PALETTE.chrome} strokeWidth=".8" strokeLinecap="round" opacity=".9">
        <line x1="6.6" y1="13.7" x2="50.4" y2="13.7" />
        <line x1="6.6" y1="16.3" x2="50.4" y2="16.3" />
        <g strokeWidth=".7" opacity=".75">
          {[10, 16, 22, 28, 34, 40, 46].map((x) => (
            <line key={x} x1={x} y1="13.9" x2={x} y2="16.1" />
          ))}
        </g>
      </g>

      {/* Roll-up equipment shutters. */}
      <Grille x={7} y={18} width={12} height={11} bars={4} />
      <Grille x={21} y={18} width={12} height={11} bars={4} />
      <Grille x={35} y={18} width={10} height={11} bars={4} />

      {/* Pump operator panel: gauges and the suction intake. */}
      <rect x="46.6" y="17" width="7.2" height="12.2" rx=".8" fill={PALETTE.bodyShade} />
      <g fill={FILL.metal}>
        <circle cx="48.6" cy="19.2" r="1" />
        <circle cx="51.8" cy="19.2" r="1" />
        <circle cx="48.6" cy="22" r="1" />
        <circle cx="51.8" cy="22" r="1" />
      </g>
      <circle cx="50.2" cy="25.8" r="2.2" fill={FILL.metal} />
      <circle cx="50.2" cy="25.8" r="1.1" fill={PALETTE.shadow} opacity=".75" />

      {/* Big beacons front and rear. */}
      <LightBar x={62} y={2.4} width={22} height={4} />
      <path d="M7.6 8.4 a2.8 2.4 0 0 1 5.6 0 Z" fill={PALETTE.beaconRed} />
      <Marker x={27.6} y={6.4} width={3.2} height={2} />
      <Marker x={57.2} y={7} width={3.2} height={2} fill={PALETTE.beaconRed} />

      <Lamps front={87.2} frontY={21.6} rear={5.4} rearY={20.4} size={3.2} />
      <rect x="89.4" y="26.6" width="5.4" height="3.6" rx=".9" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".7" />
      <rect x="90" y="27.2" width="4.2" height="1.1" rx=".5" fill={PALETTE.chrome} opacity=".85" />

      <Arch cx={76} r={7.6} />
      <Wheel cx={76} r={6.3} />
      <DualWheel cx={24} r={6.1} />
    </VehicleSvg>
  );
}
