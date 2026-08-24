"use client";

import {
  Arch,
  Body,
  DualWheel,
  FILL,
  GROUND,
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
 * Heavy commercial vehicles: nine work trucks that share one chassis language
 * and are told apart entirely by what sits on the frame rails.
 *
 * Shared conventions for this slice, on top of the contract in `parts.tsx`:
 *
 *   frame rails      y = 29…33, drawn before the superstructure
 *   cab roof         y = 10…13 (cab-over sits higher and further forward)
 *   steer axle       cx ≈ 85, r = 5.4 — under the cab on the cab-overs
 *   drive axles      `DualWheel`, r = 5.5, tandem spacing 17.2 so the outer
 *                    tires kiss the way a close-coupled bogie really does
 *
 * Every superstructure is a different mass: a box, a tipped bed, a stepped
 * hopper, a flat deck, a tilted drum, a folded boom, a cylinder, a bare deck.
 */

/** Chassis rail with its lit top edge. Drawn under every superstructure. */
function Rail({
  x1,
  x2,
  y = 30.6,
  height = 2.8,
}: {
  x1: number;
  x2: number;
  y?: number;
  height?: number;
}) {
  return (
    <g>
      <rect x={x1} y={y} width={x2 - x1} height={height} rx="0.6" fill={PALETTE.bodyShade} />
      <line
        x1={x1}
        y1={y + 0.55}
        x2={x2}
        y2={y + 0.55}
        stroke={PALETTE.rimShade}
        strokeWidth=".6"
        opacity=".85"
      />
    </g>
  );
}

/** Rubber mudflap hanging behind an axle. */
function Flap({ x, y = 32.2, width = 3.2, height = 7.4 }: { x: number; y?: number; width?: number; height?: number }) {
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx=".6" fill="#0a0d12" />
      <rect x={x} y={y} width={width} height="1.1" rx=".5" fill={PALETTE.rimShade} opacity=".7" />
    </g>
  );
}

/** Mirror arm on the cab's front pillar. */
function Mirror({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <line x1={x} y1={y + 1.8} x2={x + 2.2} y2={y + 0.8} stroke={PALETTE.rimShade} strokeWidth=".7" />
      <rect
        x={x + 1.8}
        y={y - 1.4}
        width="1.9"
        height="4.6"
        rx=".8"
        fill={PALETTE.bodyShade}
        stroke={PALETTE.line}
        strokeWidth=".5"
      />
    </g>
  );
}

/** Roof marker lamps. Reads as the cab's clearance-lamp row. */
function MarkerRow({ x, y, count = 3, step = 3.4 }: { x: number; y: number; count?: number; step?: number }) {
  return (
    <g fill={PALETTE.amber}>
      {Array.from({ length: count }, (_, index) => (
        <rect key={index} x={x + index * step} y={y} width="1.7" height="1.1" rx=".5" />
      ))}
    </g>
  );
}

/** Rear step bumper on a straight-truck tail. */
function StepBumper({ x, width = 9.6, y = 32.6 }: { x: number; width?: number; y?: number }) {
  return (
    <g>
      <rect x={x} y={y} width={width} height="2.4" rx=".8" fill={FILL.metal} />
      <line x1={x + 1.4} y1={y} x2={x + 1.4} y2={y - 1.8} stroke={PALETTE.rimShade} strokeWidth="1" />
      <line x1={x + width - 1.4} y1={y} x2={x + width - 1.4} y2={y - 1.8} stroke={PALETTE.rimShade} strokeWidth="1" />
    </g>
  );
}

/** Outrigger leg with its ground pad, for the bucket truck. */
function Outrigger({ x, lean }: { x: number; lean: number }) {
  return (
    <g>
      <path
        d={`M${x} 30.2 H${x + 3.6} L${x + 3.6 + lean} 39.2 H${x + lean} Z`}
        fill={FILL.metal}
        stroke={PALETTE.bodyShade}
        strokeWidth=".6"
      />
      <rect x={x + lean - 1.4} y={GROUND - 1.8} width="6.4" height="1.8" rx=".7" fill={PALETTE.rimShade} />
    </g>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * Sleeper tractor with a box trailer: high-roof sleeper, one chrome stack, the
 * saddle tank between the axles, the fifth wheel under the trailer nose, and a
 * skirted trailer on a tandem bogie.
 */
export function SemiTruck() {
  return (
    <VehicleSvg id="vehicle.semi_truck">
      <Ground x={4} width={90} />

      {/* trailer underframe, side skirt and bogie */}
      <Rail x1={8} x2={52} y={29.2} height={2.4} />
      <path d="M15 31.4 H46.4 V35 H15 Z" fill={PALETTE.bodyShade} opacity=".92" />
      <Seam d="M20 31.8 V34.6 M27 31.8 V34.6 M34 31.8 V34.6 M41 31.8 V34.6" width={0.6} opacity={0.45} />
      <rect x={11} y={30.4} width={32} height="2.6" rx=".6" fill="#0a0d12" />
      <Flap x={6.2} y={31.6} />
      {/* landing gear, retracted */}
      <rect x={43.4} y={29.4} width="1.6" height="4.2" fill={PALETTE.rimShade} />
      <rect x={46.4} y={29.4} width="1.6" height="4.2" fill={PALETTE.rimShade} />
      {/* fifth wheel */}
      <path d="M48 28.4 H58.6 V30.6 H48 Z" fill={FILL.metal} />
      <circle cx={52.2} cy={28.8} r="1.3" fill={PALETTE.chrome} />

      {/* trailer box */}
      <Body d="M6.6 5.2 H51.4 Q54 5.2 54 7.8 V29.4 H6.6 Z" />
      <Seam d="M17 6.2 V28.6 M27 6.2 V28.6 M36 6.2 V28.6 M45 6.6 V28.6" width={0.6} opacity={0.4} />
      <Seam d="M6.8 7.2 H53.2" width={0.7} opacity={0.55} />
      {/* rear swing doors */}
      <path d="M6.6 5.2 H11.6 V29.4 H6.6 Z" fill={PALETTE.bodyShade} opacity=".55" />
      <Seam d="M11.4 5.8 V29" width={0.9} opacity={0.8} />
      <circle cx={7.8} cy={11.4} r=".8" fill={PALETTE.chrome} />
      <circle cx={7.8} cy={25.6} r=".8" fill={PALETTE.chrome} />
      <MarkerRow x={8.2} y={4.1} count={2} step={3} />

      {/* tractor: frame, sleeper cab, stack, saddle tank */}
      <Rail x1={55} x2={90} y={29.8} height={2.8} />
      <rect x={54.8} y={3.4} width="2.2" height="13.4" rx=".9" fill={FILL.metal} />
      <rect x={54.4} y={2.4} width="3" height="1.8" rx=".8" fill={PALETTE.chrome} />
      <Seam d="M55 6.8 H57 M55 9.2 H57 M55 11.6 H57" width={0.6} opacity={0.5} />
      <Body d="M57.4 30.4 V10 Q57.4 6.8 60.8 6.8 H74 V8.4 H86.2 L88.8 15.8 H91.2 Q93.2 15.8 93.2 18 V30.4 Z" />
      <Glass d="M84.4 9 H86.4 L88.2 15 H85.8 Z" />
      <Glass d="M77.6 9 H83.4 L84.2 15 H77.6 Z" />
      <Glass d="M60.8 10.4 H66.8 V15.2 H60.8 Z" opacity={0.9} />
      <Seam d="M76.4 8.8 V15.6 M74.8 15.8 V30" width={0.7} opacity={0.6} />
      <Seam d="M58 16.6 H88.4" width={0.8} opacity={0.5} />
      <Mirror x={86.6} y={12.4} />
      <MarkerRow x={62} y={5.7} count={3} step={3.4} />
      {/* chrome saddle tank + step */}
      <rect x={75} y={28.8} width={6.8} height="6.2" rx="3.1" fill={FILL.metal} />
      <line x1={75.8} y1={30.4} x2={81} y2={30.4} stroke={PALETTE.chrome} strokeWidth=".7" opacity=".9" />
      <rect x={75.6} y={35} width="5.6" height="1.4" rx=".6" fill={PALETTE.rimShade} />
      <Grille x={89.4} y={19.6} width={3.6} height={6} bars={3} />
      <Lamps front={89.2} frontY={26} rear={6.8} rearY={25.6} size={2.8} />
      <Arch cx={86.6} r={6.6} />

      <DualWheel cx={18} r={5.2} />
      <DualWheel cx={34.2} r={5.2} />
      <DualWheel cx={66} r={5.6} />
      <Wheel cx={86.6} r={5.2} />
    </VehicleSvg>
  );
}

/**
 * Cab-over box truck: flat-fronted cab under a taller plain box, roll-up rear
 * shutter with its roller housing, and open chassis rails between them.
 */
export function BoxTruck() {
  return (
    <VehicleSvg id="vehicle.box_truck">
      <Ground x={4} width={90} />

      <Rail x1={8} x2={88} y={29.8} height={2.9} />
      <Seam d="M16 32.6 V34.4 M28 32.6 V34.4 M40 32.6 V34.4 M52 32.6 V34.4 M64 32.6 V34.4" width={0.7} opacity={0.45} />
      <Flap x={18.8} y={32.6} width={3} height={6.6} />
      <StepBumper x={5.4} width={9.4} />

      {/* box body — taller than the cab, square corners */}
      <Body d="M5.6 6.6 Q5.6 5.4 7 5.4 H70.6 V29.6 H5.6 Z" />
      <Seam d="M5.8 7.6 H70.2" width={0.7} opacity={0.5} />
      <Seam d="M22 8.4 V28.8 M38 8.4 V28.8 M54 8.4 V28.8" width={0.6} opacity={0.35} />
      <Seam d="M5.8 27.6 H70.2" width={0.7} opacity={0.45} />
      {/* roll-up shutter: roller housing, door track, slats */}
      <rect x={5.6} y={5.6} width={8.6} height="3.2" rx=".8" fill={PALETTE.bodyShade} />
      <Seam d="M14 5.8 V29.2" width={0.9} opacity={0.85} />
      <g stroke={PALETTE.rimShade} strokeWidth=".65" opacity=".85">
        <line x1={6.2} y1={11.4} x2={13.4} y2={11.4} />
        <line x1={6.2} y1={14.6} x2={13.4} y2={14.6} />
        <line x1={6.2} y1={17.8} x2={13.4} y2={17.8} />
        <line x1={6.2} y1={21} x2={13.4} y2={21} />
        <line x1={6.2} y1={24.2} x2={13.4} y2={24.2} />
      </g>
      <rect x={8.6} y={25.8} width="2.4" height="1.4" rx=".6" fill={PALETTE.chrome} />
      <MarkerRow x={16.4} y={4.3} count={3} step={4.6} />

      {/* cab-over */}
      <Body d="M71 30 V12.6 Q71 10.2 73.6 10.2 H89.8 L92.6 13.6 V29.4 Q92.6 30.8 91 30.8 Z" />
      <Glass d="M84.6 11.6 H89.4 L91.6 14.2 V20 H84.6 Z" />
      <Glass d="M74.2 11.8 H83.4 V20 H74.2 Z" />
      <Seam d="M73.8 20.8 V29.8 M83.9 11.6 V20.2" width={0.7} opacity={0.6} />
      <Seam d="M72 22.6 H92" width={0.8} opacity={0.45} />
      <Mirror x={92.2} y={14.6} />
      <Grille x={87.4} y={22.4} width={5} height={5.4} bars={3} />
      <Lamps front={88.6} frontY={28} rear={6.4} rearY={29.9} size={2.4} />
      <Arch cx={83} r={6.9} />

      <DualWheel cx={31} r={5.6} />
      <Wheel cx={83} r={5.4} />
    </VehicleSvg>
  );
}

/**
 * Dump truck caught mid-tip: bed rotated up off its rear hinge, tailgate
 * swinging free, hydraulic ram extended, cab guard shading the roof.
 */
export function DumpTruck() {
  return (
    <VehicleSvg id="vehicle.dump_truck">
      <Ground x={6} width={88} />

      <Rail x1={13} x2={90} y={30.4} height={3} />
      <Flap x={20.4} y={33.4} width={3} height={6.2} />

      {/* hydraulic ram: barrel then chromed rod */}
      <line x1={43.6} y1={32.4} x2={50.6} y2={26.6} stroke={PALETTE.rimShade} strokeWidth="3.6" strokeLinecap="round" />
      <line x1={50} y1={27.2} x2={57.6} y2={21} stroke={PALETTE.chrome} strokeWidth="1.8" strokeLinecap="round" />
      <circle cx={43.4} cy={32.6} r="1.5" fill={PALETTE.rim} />

      {/* tipped bed */}
      <Body d="M12.6 31.8 L62.6 20.6 L63.4 9.4 L13.4 20.6 Z" />
      <Seam d="M23 18.3 V29.5 M33 16.1 V27.3 M43 13.8 V25 M53 11.6 V22.8" width={0.7} opacity={0.5} />
      <Seam d="M13.2 22.4 L62.8 11.2" width={0.8} opacity={0.6} />
      <path d="M13.4 20.6 L63.4 9.4 L63.6 11.2 L13.6 22.4 Z" fill={PALETTE.chrome} opacity=".22" />
      {/* tailgate hanging off its top hinge */}
      <Body d="M13.2 20.4 L16.6 21.2 L12.8 33.6 L9.4 32.6 Z" outline={0.9} />
      <Seam d="M12.2 22.4 L15 23" width={0.7} opacity={0.6} />
      <circle cx={14.8} cy={20.8} r="1.2" fill={PALETTE.chrome} />

      {/* cab guard over the roof */}
      <path
        d="M62.4 12.4 L80.8 8.4 L81.2 10.6 L62.8 14.6 Z"
        fill={PALETTE.bodyShade}
        stroke={PALETTE.line}
        strokeWidth=".7"
      />
      <Seam d="M67 13.6 L66.6 11.4 M72 12.5 L71.6 10.3 M77 11.4 L76.6 9.2" width={0.7} opacity={0.6} />

      {/* cab */}
      <Body d="M65.8 30.4 V13.2 Q65.8 11 68.2 11 H78.8 V12.4 L82.6 21.4 H90.8 Q92.8 21.4 92.8 23.4 V30.4 Z" />
      <Glass d="M76.6 12.8 H78.6 L81.4 20.6 H79 Z" />
      <Glass d="M68.6 12.9 H75.6 V20.6 H68.6 Z" />
      <Seam d="M76.1 12.8 V20.8 M68.2 21.6 V30 M66.4 24.6 H82" width={0.7} opacity={0.55} />
      <Mirror x={79.4} y={14.4} />
      <Grille x={89} y={22.8} width={3.6} height={5.6} bars={3} />
      <Lamps front={88.8} frontY={26.4} rear={13.4} rearY={30.6} size={3} />
      <Arch cx={85.4} r={7.4} />

      <DualWheel cx={30} r={5.5} />
      <DualWheel cx={47.2} r={5.5} />
      <Wheel cx={85.4} r={5.4} />
    </VehicleSvg>
  );
}

/**
 * Rear-loading refuse truck: cab-over, packer body stepping down into an open
 * hopper, tipper arms folded against the tail, amber beacon.
 */
export function GarbageTruck() {
  return (
    <VehicleSvg id="vehicle.garbage_truck">
      <Ground x={5} width={89} />

      <Rail x1={11} x2={88} y={30.4} height={2.9} />
      <Flap x={20.2} y={33.2} width={3} height={6.2} />
      <StepBumper x={8.4} width={8.6} y={33} />

      {/* packer body stepping down to the hopper */}
      <Body d="M9.4 19.6 V30.6 H69 V8.4 Q69 7.2 67.4 7.2 H31.2 L20.8 18.4 Z" />
      <Seam d="M40 9.4 V29.4 M48.4 9.4 V29.4 M57 9.4 V29.4" width={0.6} opacity={0.4} />
      <Seam d="M10 27.8 H68.4" width={0.7} opacity={0.5} />
      {/* packer blade + tailgate joint */}
      <Seam d="M31.4 8.4 L23.8 20.8" width={1} opacity={0.85} />
      <Seam d="M35.2 8.6 L27.6 21" width={0.7} opacity={0.5} />
      <Seam d="M23.6 21 L23.6 29.8" width={0.8} opacity={0.6} />
      {/* hopper mouth */}
      <path d="M10 19.8 L20.6 18.6 L20.6 20.6 L10 21.8 Z" fill={PALETTE.chrome} opacity=".28" />
      <path d="M11.4 21.4 H19.4 L17.6 26.4 H12.6 Z" fill="#080b10" />
      <Seam d="M12.6 22.8 H18.4" width={0.6} opacity={0.5} />
      {/* tipper arms and their ram */}
      <path d="M24 21.8 Q16.4 22.8 11.4 27.6" fill="none" stroke={PALETTE.rim} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M24 21.8 Q17.6 23.6 13.8 28.8" fill="none" stroke={PALETTE.rimShade} strokeWidth="1.4" strokeLinecap="round" />
      <line x1={11.6} y1={27.4} x2={8.6} y2={29.2} stroke={PALETTE.rim} strokeWidth="2" strokeLinecap="round" />
      <circle cx={24.2} cy={21.6} r="1.6" fill={PALETTE.chrome} />
      <line x1={28.2} y1={19.4} x2={20.8} y2={25.4} stroke={PALETTE.rimShade} strokeWidth="2.4" strokeLinecap="round" />
      <line x1={24.8} y1={22.2} x2={20.6} y2={25.6} stroke={PALETTE.chrome} strokeWidth="1.1" strokeLinecap="round" />

      {/* cab-over */}
      <Body d="M69.4 30.2 V14 Q69.4 11.6 72 11.6 H89.4 L92.6 15.4 V29.2 Q92.6 30.6 91 30.6 Z" />
      <Glass d="M83.4 13 H89 L91.4 15.8 V21.4 H83.4 Z" />
      <Glass d="M72.6 13.2 H82.2 V21.4 H72.6 Z" />
      <Seam d="M82.7 13 V21.6 M72.2 22.2 V30 M70.2 24.4 H92" width={0.7} opacity={0.55} />
      <Mirror x={92.2} y={16.2} />
      <LightBar x={74.4} y={9.2} width={9.4} height={2.6} solid={PALETTE.amber} />
      <Grille x={87.6} y={23.4} width={4.6} height={5} bars={3} />
      <Lamps front={88.4} frontY={28.2} rear={9.6} rearY={30.8} size={3} />
      <Arch cx={84.6} r={7.2} />

      <DualWheel cx={32} r={5.5} />
      <DualWheel cx={49.2} r={5.5} />
      <Wheel cx={84.6} r={5.4} />
    </VehicleSvg>
  );
}

/**
 * Wrecker: low rollback deck, A-frame boom raked back over it, winch drum on
 * the mast, wheel-lift stowed under the tail, amber bar on the roof.
 */
export function TowTruck() {
  return (
    <VehicleSvg id="vehicle.tow_truck">
      <Ground x={4} width={90} />

      <Rail x1={10} x2={88} y={29.4} height={2.8} />
      <Flap x={17.6} y={32.2} width={3} height={6.6} />
      {/* underbody tool lockers */}
      <rect x={15.4} y={27.8} width={15.6} height="4.6" rx=".8" fill={PALETTE.bodyShade} />
      <rect x={35} y={27.8} width={17} height="4.6" rx=".8" fill={PALETTE.bodyShade} />
      <Seam d="M23.2 28.2 V32 M43.6 28.2 V32" width={0.6} opacity={0.5} />
      <circle cx={20.4} cy={30.2} r=".8" fill={PALETTE.chrome} />
      <circle cx={40} cy={30.2} r=".8" fill={PALETTE.chrome} />

      {/* wheel-lift, stowed under the tail */}
      <path d="M14.2 29.2 L5.4 30.8 L5.4 32.4 L14.2 31.4 Z" fill={FILL.metal} stroke={PALETTE.bodyShade} strokeWidth=".6" />
      <rect x={3.6} y={29.4} width="2.4" height="6.8" rx=".9" fill={PALETTE.rimShade} />
      <rect x={2.4} y={34.8} width="4.6" height="1.6" rx=".7" fill={PALETTE.rim} />

      {/* rollback deck */}
      <Body d="M8.4 24.2 H62.8 V27.9 H8.4 Z" outline={0.9} />
      <rect x={8.2} y={23} width={54.8} height="1.5" rx=".6" fill={FILL.metal} />
      <g fill={PALETTE.bodyShade} opacity=".85">
        <rect x={16} y={23.2} width="2.4" height="1.2" />
        <rect x={28} y={23.2} width="2.4" height="1.2" />
        <rect x={40} y={23.2} width="2.4" height="1.2" />
        <rect x={52} y={23.2} width="2.4" height="1.2" />
      </g>
      <Seam d="M8.6 28.2 H62.6" width={0.9} opacity={0.35} />

      {/* boom mast, winch, raked boom, cable and hook */}
      <rect x={55.4} y={14.2} width={4.6} height={10.4} rx=".9" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />
      <path d="M56.4 16.4 L25.6 9.4 L25.6 12.2 L56.4 19.4 Z" fill={FILL.metal} stroke={PALETTE.bodyShade} strokeWidth=".6" />
      <Seam d="M46 13.6 L46 16.9 M36 11.3 L36 14.6" width={0.6} opacity={0.5} />
      <circle cx={53.8} cy={20.4} r="2.9" fill={FILL.metal} stroke={PALETTE.bodyShade} strokeWidth=".7" />
      <circle cx={53.8} cy={20.4} r="1" fill={PALETTE.chrome} />
      <circle cx={25} cy={10.8} r="1.7" fill={PALETTE.chrome} />
      <line x1={25} y1={12.2} x2={21.6} y2={19.2} stroke={PALETTE.chrome} strokeWidth=".7" />
      <path d="M21.6 19.2 q-1.8 1.8 .6 2.8" fill="none" stroke={PALETTE.rim} strokeWidth="1.3" strokeLinecap="round" />

      {/* cab */}
      <Body d="M63.8 30 V15 Q63.8 12.8 66.2 12.8 H77 L80.6 21.4 H90.6 Q92.6 21.4 92.6 23.4 V30 Z" />
      <Glass d="M74.8 13.2 H76.8 L79.6 20.8 H77.2 Z" />
      <Glass d="M66.6 13.3 H73.8 V20.8 H66.6 Z" />
      <Seam d="M74.3 13.2 V21 M66.2 21.6 V29.6 M64.4 24.8 H80.4" width={0.7} opacity={0.55} />
      <Mirror x={77.6} y={14.6} />
      <LightBar x={67.6} y={10.2} width={11.4} height={2.6} solid={PALETTE.amber} />
      <Grille x={88.8} y={22.8} width={3.6} height={5.6} bars={3} />
      <g fill={PALETTE.amber}>
        <rect x={8.8} y={25} width="2.6" height="2" rx=".7" />
        <rect x={57.4} y={25} width="2.6" height="2" rx=".7" />
      </g>
      <Lamps front={88.6} frontY={26.4} rear={9.8} rearY={28.6} size={2.6} />
      <Arch cx={84.6} r={7.4} />

      <DualWheel cx={30} r={5.7} />
      <Wheel cx={84.6} r={5.4} />
    </VehicleSvg>
  );
}

/**
 * Concrete mixer: the drum is the vehicle. Tilted ribbed barrel, high rear
 * mouth with its charge funnel and swing chute, roller frame, three axles.
 */
export function CementMixer() {
  return (
    <VehicleSvg id="vehicle.cement_mixer">
      <Ground x={6} width={88} />

      <Rail x1={12} x2={90} y={30.4} height={2.9} />
      <Flap x={23.4} y={33.3} width={3} height={6} />

      {/* drum roller frame and rear pedestal */}
      <path d="M21.4 30.4 L26.6 17.4 L29.4 18.4 L25.4 30.4 Z" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />
      <path d="M30 30.4 L33.4 21.4 L35.6 22.2 L33.4 30.4 Z" fill={PALETTE.bodyShade} opacity=".9" />
      <rect x={57.4} y={26} width={7.2} height="4.8" rx=".8" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />
      <Seam d="M23.6 24 H28 M24.8 20.6 H29" width={0.7} opacity={0.6} />

      {/* mixing drum */}
      <Body d="M66.4 23.5 L62.1 17.5 L53.5 12.9 L40.6 9.4 L27.7 9.7 L20.9 9.1 L19.1 15.7 L25.3 18.6 L36.2 25.6 L49.1 29.1 L58.8 29.5 L65.6 26.5 Z" />
      <Seam d="M58.5 16.4 Q59.3 23.2 55.1 28.6" width={1} opacity={0.75} />
      <Seam d="M52.2 13.9 Q52.9 21.4 48.5 27.6" width={1} opacity={0.75} />
      <Seam d="M45.8 12.1 Q46.4 19.7 42.1 25.8" width={1} opacity={0.75} />
      <Seam d="M39.3 10.5 Q40 17.9 35.6 24" width={1} opacity={0.75} />
      <Seam d="M32.4 10.5 Q33.6 16.1 29.7 20.4" width={1} opacity={0.7} />
      <Seam d="M20.9 9.1 L19.1 15.7" width={1.1} opacity={0.9} />
      <Seam d="M62.1 17.5 L58.8 29.5" width={0.9} opacity={0.6} />

      {/* charge funnel over the drum mouth, then the swing chute */}
      <path
        d="M14.6 7.4 H26.6 L22.8 14.2 H18.6 Z"
        fill={PALETTE.bodyShade}
        stroke={PALETTE.line}
        strokeWidth=".7"
      />
      <Seam d="M17.6 9.8 H24" width={0.7} opacity={0.6} />
      <path
        d="M19.6 14.8 L6.6 21.4 L7.2 24.8 L20.8 18.4 Z"
        fill={PALETTE.bodyShade}
        stroke={PALETTE.line}
        strokeWidth=".7"
      />
      <Seam d="M13.4 19.6 L14 23" width={0.7} opacity={0.55} />
      <circle cx={20.6} cy={16.6} r="1.3" fill={PALETTE.chrome} />
      {/* mixer control station on the rear of the frame */}
      <rect x={12.4} y={24.6} width={7.4} height="6" rx=".8" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />
      <Seam d="M13.6 26.6 H18.6 M13.6 28.6 H18.6" width={0.7} opacity={0.6} />
      <line x1={19.4} y1={24.8} x2={21.6} y2={22.4} stroke={PALETTE.chrome} strokeWidth="1" strokeLinecap="round" />

      {/* cab */}
      <Body d="M67.6 30.4 V14.8 Q67.6 12.6 70 12.6 H80.2 L83.6 21 H91 Q92.8 21 92.8 23 V30.4 Z" />
      <Glass d="M78 13 H79.8 L82.6 20.4 H80.2 Z" />
      <Glass d="M70.4 13.1 H77 V20.4 H70.4 Z" />
      <Seam d="M77.5 13 V20.6 M70 21.4 V30 M68.2 24.4 H83.4" width={0.7} opacity={0.55} />
      <Mirror x={80.8} y={14.2} />
      <MarkerRow x={71.6} y={11.5} count={3} step={3.2} />
      <Grille x={89.2} y={22.4} width={3.6} height={5.6} bars={3} />
      <Lamps front={89} frontY={26} rear={12.8} rearY={29.6} size={2.6} />
      <Arch cx={85.4} r={7.4} />

      <DualWheel cx={34.8} r={5.5} />
      <DualWheel cx={52} r={5.5} />
      <Wheel cx={85.4} r={5.4} />
    </VehicleSvg>
  );
}

/**
 * Line truck: utility body of tool lockers, telescopic boom folded back with
 * the person basket over the tail, outriggers down on their pads.
 */
export function UtilityBucketTruck() {
  return (
    <VehicleSvg id="vehicle.utility_bucket_truck">
      <Ground x={6} width={88} />

      <Rail x1={12} x2={90} y={30.8} height={2.8} />
      <Flap x={22.4} y={33.6} width={3} height={5.8} />
      <Outrigger x={54.4} lean={2.8} />
      <Outrigger x={16.4} lean={-2.8} />

      {/* utility body with locker doors */}
      <Body d="M9.4 22.8 H63.6 V31 H9.4 Z" outline={0.9} />
      <rect x={9} y={21.6} width={55} height="1.6" rx=".7" fill={FILL.metal} />
      <g fill={PALETTE.bodyShade} opacity=".55">
        <rect x={11.6} y={24} width={11.4} height="6" rx=".7" />
        <rect x={25.6} y={24} width={11.4} height="6" rx=".7" />
        <rect x={39.6} y={24} width={11.4} height="6" rx=".7" />
      </g>
      <g fill={PALETTE.chrome}>
        <rect x={20.4} y={26.4} width="1.8" height="1.1" rx=".5" />
        <rect x={34.4} y={26.4} width="1.8" height="1.1" rx=".5" />
        <rect x={48.4} y={26.4} width="1.8" height="1.1" rx=".5" />
      </g>
      <Seam d="M24.4 23.6 V30.4 M38.4 23.6 V30.4 M52.4 23.6 V30.4" width={0.7} opacity={0.55} />

      {/* turntable pedestal and folded boom */}
      <rect x={55.6} y={14.4} width={8} height="8.4" rx="1" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />
      <circle cx={59.6} cy={15.4} r="2.6" fill={FILL.metal} stroke={PALETTE.bodyShade} strokeWidth=".6" />
      <path d="M58.6 16 L22.4 11.2 L22.4 8.2 L58.6 12.2 Z" fill={FILL.metal} stroke={PALETTE.bodyShade} strokeWidth=".6" />
      <Seam d="M46 10.5 V13.5 M34 9.2 V12.2" width={0.6} opacity={0.5} />
      <line x1={54.6} y1={17.4} x2={43.4} y2={14} stroke={PALETTE.rimShade} strokeWidth="2.2" strokeLinecap="round" />
      <line x1={49.4} y1={15.8} x2={43.2} y2={14} stroke={PALETTE.chrome} strokeWidth="1" strokeLinecap="round" />

      {/* person basket over the tail */}
      <path d="M22.6 9.2 L20.4 8.6 L20.4 12 L22.6 12.4 Z" fill={PALETTE.rimShade} />
      <Body d="M10.6 6.4 H20.2 Q21.4 6.4 21.4 7.6 V11.6 Q21.4 12.8 20.2 12.8 H11.8 Q10.6 12.8 10.6 11.6 Z" outline={0.9} />
      <rect x={10} y={5.4} width={12} height="1.5" rx=".7" fill={PALETTE.chrome} />
      <Seam d="M14 7.4 V12.2 M18 7.4 V12.2" width={0.7} opacity={0.6} />
      <rect x={11.8} y={13} width="1.4" height="2.4" fill={PALETTE.rimShade} />

      {/* cab */}
      <Body d="M66.6 30.6 V14.6 Q66.6 12.4 69 12.4 H81 L84.4 21.2 H91 Q92.8 21.2 92.8 23.2 V30.6 Z" />
      <Glass d="M79.2 12.8 H80.8 L83.4 20.6 H81 Z" />
      <Glass d="M74.6 12.9 H78.4 V20.6 H74.6 Z" />
      <Glass d="M69.4 12.9 H73.6 V20.6 H69.4 Z" opacity={0.9} />
      <Seam d="M74.1 12.8 V20.8 M69 21.4 V30.2 M67.2 24.6 H84.2" width={0.7} opacity={0.55} />
      <Mirror x={81.6} y={14.4} />
      <LightBar x={70.6} y={10} width={10.4} height={2.4} solid={PALETTE.amber} />
      <Grille x={89.2} y={22.6} width={3.6} height={5.6} bars={3} />
      <rect x={9.8} y={20.2} width="3" height="1.8" rx=".7" fill={PALETTE.amber} />
      <Lamps front={89} frontY={26.2} rear={10.2} rearY={27.4} size={2.6} />
      <Arch cx={85.4} r={7.4} />

      <DualWheel cx={34} r={5.6} />
      <Wheel cx={85.4} r={5.4} />
    </VehicleSvg>
  );
}

/**
 * Fuel tanker: welded cylinder with domed heads, catwalk rail and rollover
 * guard on the crown, rear ladder, placard diamond, spill-guard sump.
 */
export function TankerTruck() {
  return (
    <VehicleSvg id="vehicle.tanker_truck">
      <Ground x={4} width={90} />

      <Rail x1={12} x2={90} y={29.6} height={3} />
      <Flap x={21.8} y={32.4} width={3} height={6.4} />
      {/* discharge pipe, valve cabinet and spill guard */}
      <line x1={15.4} y1={31.2} x2={44} y2={31.2} stroke={PALETTE.rim} strokeWidth="1.5" strokeLinecap="round" />
      <rect x={29.4} y={29} width={12.4} height="4.4" rx=".8" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />
      <Seam d="M35.6 29.4 V33" width={0.7} opacity={0.6} />
      <circle cx={45.4} cy={31.2} r="1.6" fill={FILL.metal} />

      {/* tank barrel with domed heads */}
      <Body d="M13.4 12.6 H60.6 Q66.8 12.6 66.8 21 Q66.8 29.4 60.6 29.4 H13.4 Q7.2 29.4 7.2 21 Q7.2 12.6 13.4 12.6 Z" />
      <Seam d="M13.4 12.9 Q8 13.6 8 21 Q8 28.4 13.4 29.1" width={0.9} opacity={0.8} />
      <Seam d="M60.6 12.9 Q66 13.6 66 21 Q66 28.4 60.6 29.1" width={0.9} opacity={0.7} />
      <Seam d="M26 13 Q24.4 21 26 29" width={0.8} opacity={0.5} />
      <Seam d="M46 13 Q44.4 21 46 29" width={0.8} opacity={0.5} />
      <Seam d="M12 16 H62" width={0.8} opacity={0.45} />

      {/* crown: manhole, rollover guard, catwalk rail */}
      <rect x={33.4} y={9.6} width={9.6} height="3.4" rx="1.2" fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".6" />
      <path d="M31.4 12.4 Q38.2 6.2 45 12.4" fill="none" stroke={PALETTE.chrome} strokeWidth="1.2" />
      <line x1={16.4} y1={8.6} x2={56.4} y2={8.6} stroke={PALETTE.chrome} strokeWidth=".8" />
      <g stroke={PALETTE.rimShade} strokeWidth=".7">
        <line x1={18} y1={8.6} x2={18} y2={13.4} />
        <line x1={29} y1={8.6} x2={29} y2={11.6} />
        <line x1={47} y1={8.6} x2={47} y2={11.6} />
        <line x1={55} y1={8.6} x2={55} y2={13.6} />
      </g>

      {/* hazard placard + rear ladder */}
      <path d="M20.6 18 L24.6 22 L20.6 26 L16.6 22 Z" fill={PALETTE.amber} stroke={PALETTE.bodyShade} strokeWidth=".7" />
      <path d="M20.6 20.2 L22.4 22 L20.6 23.8 L18.8 22 Z" fill={PALETTE.bodyShade} />
      <rect x={5.4} y={19.2} width="1.8" height="13.8" fill={PALETTE.rimShade} />
      <rect x={9.2} y={19.2} width="1.8" height="13.8" fill={PALETTE.rimShade} />
      <g stroke={PALETTE.rim} strokeWidth=".8">
        <line x1={5.6} y1={22} x2={10.8} y2={22} />
        <line x1={5.6} y1={25.4} x2={10.8} y2={25.4} />
        <line x1={5.6} y1={28.8} x2={10.8} y2={28.8} />
        <line x1={5.6} y1={32.2} x2={10.8} y2={32.2} />
      </g>

      {/* long-nose cab */}
      <Body d="M68.8 29.8 V14.2 Q68.8 11.8 71.4 11.8 H79.6 L82.6 19.4 H91.2 Q93.2 19.4 93.2 21.4 V29.8 Z" />
      <Glass d="M77.6 12.2 H79.4 L81.8 18.8 H79.6 Z" />
      <Glass d="M71.8 12.3 H76.8 V18.8 H71.8 Z" />
      <Seam d="M77.1 12.2 V19 M71.4 20 V29.4 M69.4 23.4 H82.6" width={0.7} opacity={0.55} />
      <Mirror x={80} y={13.6} />
      <MarkerRow x={72.6} y={10.7} count={3} step={3} />
      <Grille x={89.4} y={20.8} width={3.6} height={6} bars={4} />
      <Lamps front={89.2} frontY={25.4} rear={12.4} rearY={30} size={3} />
      <Arch cx={85.4} r={7.4} />

      <DualWheel cx={33.4} r={5.5} />
      <DualWheel cx={50.6} r={5.5} />
      <Wheel cx={85.4} r={5.4} />
    </VehicleSvg>
  );
}

/**
 * Flatbed: ribbed headboard behind the cab, bare timber deck with stake
 * pockets and D-rings, a low strapped bundle so the tie-downs read as used.
 */
export function FlatbedTruck() {
  return (
    <VehicleSvg id="vehicle.flatbed_truck">
      <Ground x={4} width={90} />

      <Rail x1={10} x2={88} y={28.6} height={2.9} />
      <Seam d="M16 31.5 V33.4 M26 31.5 V33.4 M36 31.5 V33.4 M46 31.5 V33.4 M56 31.5 V33.4" width={0.7} opacity={0.45} />
      <Flap x={17.6} y={31.6} width={3} height={7} />
      <StepBumper x={5.6} width={8.6} y={33} />

      {/* deck */}
      <Body d="M6.2 25.4 H60.6 V28.4 H6.2 Z" outline={0.9} />
      <rect x={6} y={24.4} width={54.8} height="1.4" rx=".5" fill={PALETTE.chrome} opacity=".45" />
      <path d="M6.2 28.4 H60.6 V29.6 H6.2 Z" fill={PALETTE.shadow} opacity=".55" />
      {/* stake pockets */}
      <g fill={PALETTE.bodyShade} stroke={PALETTE.line} strokeWidth=".5">
        <rect x={10.4} y={23.2} width="2.2" height="2.4" rx=".4" />
        <rect x={22.4} y={23.2} width="2.2" height="2.4" rx=".4" />
        <rect x={34.4} y={23.2} width="2.2" height="2.4" rx=".4" />
        <rect x={46.4} y={23.2} width="2.2" height="2.4" rx=".4" />
        <rect x={56} y={23.2} width="2.2" height="2.4" rx=".4" />
      </g>
      {/* D-ring tie-downs */}
      <g fill="none" stroke={PALETTE.chrome} strokeWidth=".8">
        <circle cx={16.4} cy={27} r="1.1" />
        <circle cx={28.4} cy={27} r="1.1" />
        <circle cx={40.4} cy={27} r="1.1" />
        <circle cx={52.4} cy={27} r="1.1" />
      </g>

      {/* low strapped bundle */}
      <Body d="M18.4 21.2 H47.6 V25.4 H18.4 Z" outline={0.8} />
      <Seam d="M18.6 23.2 H47.4 M18.6 22.2 H47.4" width={0.6} opacity={0.4} />
      <g fill="#0a0d12">
        <rect x={24.4} y={20.8} width="1.8" height="6.6" rx=".4" />
        <rect x={40} y={20.8} width="1.8" height="6.6" rx=".4" />
      </g>
      <g fill={PALETTE.chrome}>
        <rect x={24} y={25.8} width="2.6" height="1.6" rx=".5" />
        <rect x={39.6} y={25.8} width="2.6" height="1.6" rx=".5" />
      </g>

      {/* headboard */}
      <Body d="M59.8 13.6 H64.8 V26.4 H59.8 Z" outline={0.9} />
      <Seam d="M60.6 15.6 H64 M60.6 19.6 H64 M60.6 23.6 H64" width={0.7} opacity={0.6} />
      <rect x={59.2} y={12.6} width="6.2" height="1.5" rx=".6" fill={FILL.metal} />

      {/* cab */}
      <Body d="M65 30 V15.4 Q65 13.2 67.4 13.2 H79 L82 21.8 H90.8 Q92.6 21.8 92.6 23.8 V30 Z" />
      <Glass d="M77 13.6 H78.8 L81.2 21.2 H78.8 Z" />
      <Glass d="M67.8 13.7 H76.2 V21.2 H67.8 Z" />
      <Seam d="M76.5 13.6 V21.4 M67.4 22 V29.6 M65.6 25 H81.8" width={0.7} opacity={0.55} />
      <Mirror x={79.6} y={15} />
      <MarkerRow x={68.6} y={12.1} count={3} step={3.2} />
      <Grille x={89} y={23.2} width={3.6} height={5.4} bars={3} />
      <Lamps front={88.8} frontY={26.6} rear={7} rearY={29} size={2.4} />
      <Arch cx={84.6} r={7.4} />

      <DualWheel cx={30} r={5.7} />
      <Wheel cx={84.6} r={5.4} />
    </VehicleSvg>
  );
}
