"use client";

import {
  Arch,
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
 * The six generic body styles. These are the defaults the panel falls back to,
 * so they carry the heaviest read: a person has to tell saloon from hatch from
 * SUV from pickup from minivan from panel van in a 50×32 tile.
 *
 * The distinctions are drawn into the envelope, not into the trim:
 *
 *   sedan      82 long, roof 12.9, notch deck, four side windows
 *   hatchback  68 long, roof 12.3, tail cut off vertically, small quarter glass
 *   suv        81 long, roof  8.9, tall glass, 6.2 tires, flared arches, rails
 *   pickup     86 long, cab-only greenhouse over a 31-long open bed
 *   minivan    81 long, one box, 11-deep glass, sliding-door track, low sill
 *   van        82 long, roof  7.8, blank flank, cab glazing only, short nose
 *
 * Body paths live at module scope because each one is used twice: once for the
 * shell and once as the clip that keeps the wheel-arch cuts inside the
 * silhouette. Clip ids are fixed and namespaced, so two copies of the same
 * icon on screen resolve to one identical definition.
 */

const SEDAN_BODY =
  "M9.2 35 L8.3 29.2 Q8.4 26.6 11.2 26.1 L27.6 25.2 Q28.4 25.1 28.9 24.3 " +
  "L36.6 14.2 Q37.4 13.1 40.2 12.9 L60 12.9 Q62.2 13.1 63 14.8 L67.6 23 " +
  "Q68.8 24.8 71.8 25.2 L85.4 25.9 Q89.2 26.6 90.1 29.4 L90.4 32.8 " +
  "Q90.4 35 87.8 35 Z";

const HATCHBACK_BODY =
  "M17.4 35 L16.2 27 Q16 24.6 17.6 23.4 L21.9 13.6 Q22.8 12.4 25 12.3 " +
  "L53.4 12.3 Q55.6 12.5 56.8 14 L62 22.8 Q63.2 24.6 66.2 25 L78.6 25.4 " +
  "Q83.4 26.2 84.4 29 L84.6 32.6 Q84.6 35 82 35 Z";

const SUV_BODY =
  "M10.6 33.6 L9.6 22.2 Q9.4 12.4 12.2 10.4 Q13.6 9 17 8.9 L57.6 8.9 " +
  "Q60 9 61.2 10.6 L67.4 20.4 Q68.6 22.4 71.6 22.9 L85.6 24.4 " +
  "Q89.6 25.2 90.4 28 L90.6 31.4 Q90.6 33.6 88 33.6 Z";

const PICKUP_BODY =
  "M6.6 34.6 L5.8 26 Q5.8 24 7.8 23.8 L37.2 23.4 L38.4 13.6 Q38.8 12.6 41.4 12.5 " +
  "L58.6 12.5 Q61 12.7 62 14.2 L67.4 22.8 Q68.6 24.2 71.6 24.6 L86.4 25.4 " +
  "Q90.4 26 91.4 28.6 L91.6 32.6 Q91.6 34.6 89 34.6 Z";

const MINIVAN_BODY =
  "M10 34.9 L8.8 23.4 Q8.6 13 12.4 11.4 Q14.2 10.4 17.8 10.3 L52.6 10.3 " +
  "Q55.4 10.4 56.8 12 L67 23.6 Q68.2 25.2 71.2 25.6 L84.6 26.4 " +
  "Q88.6 27 89.6 29.8 L89.8 32.8 Q89.8 34.9 87.2 34.9 Z";

const VAN_BODY =
  "M9.6 34.2 L8.6 11.6 Q8.6 8 12.2 7.8 L64.4 7.8 Q66.6 8 67.8 9.6 " +
  "L73.8 18.6 Q75 20.4 78 20.9 L85.8 21.8 Q89.4 22.4 90.2 25.2 " +
  "L90.5 31.8 Q90.5 34.2 88 34.2 Z";

/**
 * Wheel-opening cut. `Arch` runs from axle height, which is below every sill
 * here, so it is clipped to the shell: the cut then ends exactly on the sill
 * line the way a real wheel opening does.
 */
function ArchCut({ id, body, cuts }: { id: string; body: string; cuts: readonly { cx: number; r: number }[] }) {
  return (
    <>
      <defs>
        <clipPath id={id}>
          <path d={body} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id})`}>
        {cuts.map((cut) => (
          <Arch key={cut.cx} cx={cut.cx} r={cut.r} />
        ))}
      </g>
    </>
  );
}

/** Chunky plastic arch surround, for a body riding too high to just cut an arch. */
function Flare({ cx, r = 8.3, thickness = 1.7 }: { cx: number; r?: number; thickness?: number }) {
  const inner = r - thickness;
  const y = AXLE - 0.6;
  return (
    <path
      d={`M${cx - r} ${y} a${r} ${r} 0 0 1 ${r * 2} 0 h${-thickness} a${inner} ${inner} 0 0 0 ${-inner * 2} 0 Z`}
      fill={PALETTE.bodyShade}
    />
  );
}

/** Door pull, drawn as a shape because a line this small disappears. */
function Handle({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width={3.4} height={1.2} rx={0.6} fill={PALETTE.bodyShade} />
      <rect x={x + 0.4} y={y + 0.2} width={2.6} height={0.5} rx={0.25} fill={PALETTE.chrome} opacity=".55" />
    </g>
  );
}

/** Door mirror hung off the A-pillar. `x` is its trailing edge. */
function Mirror({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <path d={`M${x} ${y} h3.6 l-.8 2.4 h-2.4 z`} fill={PALETTE.bodyShade} />
      <path d={`M${x + 0.5} ${y + 0.4} h2.4 l-.5 1 h-1.9 z`} fill={PALETTE.chrome} opacity=".4" />
    </g>
  );
}

export function Sedan() {
  return (
    <VehicleSvg id="vehicle.sedan">
      <Ground x={10} width={78} />
      {/* Rocker and underbody in shadow, plus the tailpipe that dates the class. */}
      <rect x={14} y={34.2} width={68} height={1.8} rx={0.9} fill={PALETTE.bodyShade} />
      <rect x={16.6} y={34.4} width={4.2} height={1.7} rx={0.85} fill={PALETTE.shadow} />
      <rect x={16.8} y={34.7} width={1.9} height={1.1} rx={0.55} fill={PALETTE.chrome} opacity=".7" />
      <Body d={SEDAN_BODY} />
      {/* Four side windows: rear screen, rear door, front door, windscreen. */}
      <Glass d="M30.9 23.6 L37.4 15 L40.4 15 L33.9 23.6 Z" />
      <Glass d="M35.7 23.6 L42.2 15 L48.6 15 L48.6 23.6 Z" />
      <Glass d="M50.4 23.6 L50.4 15 L54.2 15 L59.4 23.6 Z" />
      <Glass d="M56 15 L59.2 15 L64.4 23.6 L61.2 23.6 Z" />
      {/* Notch: boot shutline across the deck, then down the rear panel. */}
      <Seam d="M11.6 26.6 L27.4 25.8" opacity={0.55} />
      <Seam d="M12.6 26.9 L12.4 29.8" opacity={0.45} />
      {/* Door cuts and the single crease that runs the length of the flank. */}
      <Seam d="M34.4 24.8 L34.9 33.6" />
      <Seam d="M49.5 23.9 L49.5 33.9" />
      <Seam d="M60.4 24.2 L59.9 33.8" />
      <Seam d="M12.2 29.4 C36 28.2 60 28.7 85.6 29.9" width={0.7} opacity={0.45} />
      <Seam d="M15 33.2 L84 33.8" width={0.7} opacity={0.3} />
      <Handle x={44.2} y={26.4} />
      <Handle x={54.6} y={26.6} />
      <Mirror x={61.6} y={22.4} />
      {/* Fuel filler on the rear quarter. */}
      <circle cx={20.6} cy={27} r={1.3} fill={PALETTE.bodyShade} />
      <Grille x={86.2} y={27.6} width={3.6} height={2.6} bars={2} />
      <rect x={83.6} y={31.6} width={6.4} height={2.3} rx={1} fill={PALETTE.bodyShade} />
      <Lamps front={83.2} frontY={26.4} rear={10.2} rearY={27.4} size={2.9} />
      <ArchCut
        id="va-ec-sedan"
        body={SEDAN_BODY}
        cuts={[
          { cx: 24, r: 7.4 },
          { cx: 72, r: 7.4 },
        ]}
      />
      <Wheel cx={24} r={5.4} />
      <Wheel cx={72} r={5.4} />
    </VehicleSvg>
  );
}

export function Hatchback() {
  return (
    <VehicleSvg id="vehicle.hatchback">
      <Ground x={17} width={67} />
      <rect x={21} y={34.2} width={57} height={1.8} rx={0.9} fill={PALETTE.bodyShade} />
      <rect x={20.4} y={34.4} width={3.4} height={1.6} rx={0.8} fill={PALETTE.shadow} />
      {/* Roof spoiler over the tailgate — the hatch's own silhouette tell. */}
      <path d="M22.8 12.7 L28.6 12.4 L28.2 10.9 L23.2 11.2 Z" fill={PALETTE.bodyShade} />
      <Body d={HATCHBACK_BODY} />
      {/* Steep tailgate glass, then the small rear quarter light. */}
      <Glass d="M18.8 22.6 L22.3 14.6 L24.9 14.6 L21.4 22.6 Z" />
      <Glass d="M23.2 22.6 L26.7 14.6 L28.4 14.6 L28.4 22.6 Z" />
      <Glass d="M30.2 22.6 L30.6 14.6 L41.6 14.6 L41.6 22.6 Z" />
      <Glass d="M43.4 22.6 L43.4 14.6 L50.7 14.6 L55.4 22.6 Z" />
      <Glass d="M52.5 14.6 L55.7 14.6 L60.4 22.6 L57.2 22.6 Z" />
      {/* Tailgate: the whole rear end is one panel, cut vertically. */}
      <Seam d="M20.6 24.8 L20.2 31.8" />
      <rect x={17.9} y={30.2} width={3} height={1.2} rx={0.6} fill={PALETTE.bodyShade} />
      <Seam d="M29.4 23.4 L29.6 33.2" />
      <Seam d="M42.6 23.6 L42.6 33.6" />
      <Seam d="M56.4 24 L55.8 33.4" />
      <Seam d="M17.8 28.8 C38 27.8 60 28.4 83.6 29.6" width={0.7} opacity={0.45} />
      <Seam d="M21.4 33.2 L80.4 33.6" width={0.7} opacity={0.3} />
      <Handle x={35.2} y={25.6} />
      <Handle x={47.6} y={25.9} />
      <Mirror x={56.6} y={22} />
      <circle cx={24} cy={28} r={1.3} fill={PALETTE.bodyShade} />
      <Grille x={80.6} y={27.4} width={3.4} height={2.4} bars={2} />
      <rect x={77.8} y={31.4} width={6.6} height={2.3} rx={1} fill={PALETTE.bodyShade} />
      <Lamps front={77.4} frontY={26.2} rear={17.6} rearY={24.8} size={2.9} />
      <ArchCut
        id="va-ec-hatchback"
        body={HATCHBACK_BODY}
        cuts={[
          { cx: 29, r: 7.2 },
          { cx: 69.8, r: 7.2 },
        ]}
      />
      <Wheel cx={29} r={5.3} />
      <Wheel cx={69.8} r={5.3} />
    </VehicleSvg>
  );
}

export function Suv() {
  return (
    <VehicleSvg id="vehicle.suv">
      <Ground x={10} width={78} />
      {/* High ride: a rock rail bridges the gap the tall body leaves open. */}
      <rect x={28} y={33.4} width={42} height={2} rx={1} fill={PALETTE.bodyShade} />
      <rect x={29} y={33.7} width={40} height={0.7} rx={0.35} fill={PALETTE.chrome} opacity=".35" />
      {/* Roof rails, feet first. */}
      <rect x={19} y={7.4} width={2} height={1.8} fill={PALETTE.bodyShade} />
      <rect x={51} y={7.4} width={2} height={1.8} fill={PALETTE.bodyShade} />
      <rect x={17.6} y={6.2} width={37} height={1.5} rx={0.75} fill={PALETTE.bodyShade} />
      <rect x={18.4} y={6.5} width={35.4} height={0.6} rx={0.3} fill={PALETTE.chrome} opacity=".45" />
      <Body d={SUV_BODY} />
      {/* Tall glazing, near-upright D-pillar. */}
      <Glass d="M11.6 20 L13.6 10.4 L18 10.4 L16 20 Z" />
      <Glass d="M20.4 20 L21.2 10.4 L39 10.4 L39 20 Z" />
      <Glass d="M41 20 L41 10.4 L54.4 10.4 L60.4 20 Z" />
      <Glass d="M56.4 10.4 L59.8 10.4 L65.8 20 L62.4 20 Z" />
      <Seam d="M19.6 21.2 L19.2 32.6" />
      <Seam d="M40.2 20.9 L40.2 32.8" />
      <Seam d="M61.4 21.4 L60.6 32.6" />
      {/* Beltline crease and the lower body cladding line. */}
      <Seam d="M11.4 22.6 C36 21.6 62 22.4 85.4 24.6" width={0.8} opacity={0.5} />
      <Seam d="M12 30.4 C38 29.6 64 30.2 89.4 31" width={0.8} opacity={0.35} />
      <Handle x={31.8} y={22.9} />
      <Handle x={51.2} y={23.4} />
      <Mirror x={61.8} y={19.6} />
      <circle cx={17.4} cy={25.6} r={1.4} fill={PALETTE.bodyShade} />
      {/* Tall rear lamp stack, upright grille, skid plate. */}
      <rect x={9.9} y={21.4} width={2.6} height={6.4} rx={1} fill={PALETTE.tail} />
      <rect x={10.1} y={21.7} width={2.2} height={1.6} rx={0.7} fill="#ffd0c6" opacity=".6" />
      <Grille x={84.6} y={25} width={5.6} height={3.4} bars={3} />
      <rect x={82.6} y={29.6} width={7.8} height={2.6} rx={1} fill={PALETTE.bodyShade} />
      <rect x={83.4} y={30.2} width={6.2} height={0.8} rx={0.4} fill={PALETTE.chrome} opacity=".4" />
      <Lamps front={81.6} frontY={24.2} size={3.4} />
      <Flare cx={24.5} r={8.6} />
      <Flare cx={73.5} r={8.6} />
      <Wheel cx={24.5} r={6.2} />
      <Wheel cx={73.5} r={6.2} />
    </VehicleSvg>
  );
}

export function Pickup() {
  return (
    <VehicleSvg id="vehicle.pickup">
      <Ground x={8} width={82} />
      <rect x={26} y={34} width={44} height={1.9} rx={0.95} fill={PALETTE.bodyShade} />
      {/* Step bumper behind, tailpipe ahead of the rear axle. */}
      <rect x={4.4} y={31.6} width={4} height={3.2} rx={1} fill={PALETTE.bodyShade} />
      <rect x={26.4} y={34.2} width={4} height={1.6} rx={0.8} fill={PALETTE.shadow} />
      <Body d={PICKUP_BODY} />
      {/* Cab only: rear window, door glass, windscreen. */}
      <Glass d="M39 22.2 L40 14.2 L44 14.2 L43 22.2 Z" />
      <Glass d="M45 22.2 L45.6 14.2 L56 14.2 L61 22.2 Z" />
      <Glass d="M57.8 14.2 L61 14.2 L66 22.2 L62.8 22.2 Z" />
      {/* Bed rail cap, tailgate shutline and handle, bed side stamping. */}
      <rect x={7.2} y={23.2} width={29.8} height={1.5} rx={0.7} fill={PALETTE.bodyShade} />
      <rect x={8} y={23.5} width={28.2} height={0.6} rx={0.3} fill={PALETTE.chrome} opacity=".4" />
      <Seam d="M9.4 24.9 L9 32.4" />
      <rect x={9} y={27.4} width={3.6} height={1.3} rx={0.65} fill={PALETTE.bodyShade} />
      <Seam d="M11.4 27.4 L36.4 27.4" width={0.7} opacity={0.4} />
      <Seam d="M36.6 25 L36.4 33.2" />
      <Seam d="M62.2 23.6 L61.4 33.4" />
      <Seam d="M38.6 25.6 C48 25.2 60 25.6 62 25.8" width={0.7} opacity={0.4} />
      <Seam d="M69 28.4 C76 28.2 84 28.6 90.6 29.2" width={0.7} opacity={0.4} />
      <Handle x={49.4} y={25.4} />
      <Mirror x={62.8} y={21.6} />
      <circle cx={31.6} cy={29} r={1.5} fill={PALETTE.bodyShade} />
      {/* Big upright grille, chrome bumper, tall rear lamp. */}
      <Grille x={85.6} y={26.4} width={5.8} height={3.6} bars={3} />
      <rect x={83.8} y={31} width={7.8} height={2.8} rx={0.8} fill={FILL.metal} opacity=".55" />
      <rect x={6.6} y={25.4} width={2.4} height={4.8} rx={0.9} fill={PALETTE.tail} />
      <Lamps front={82.4} frontY={25.6} size={3.4} />
      <ArchCut
        id="va-ec-pickup"
        body={PICKUP_BODY}
        cuts={[
          { cx: 20.5, r: 7.8 },
          { cx: 74.5, r: 7.8 },
        ]}
      />
      <Wheel cx={20.5} r={5.8} />
      <Wheel cx={74.5} r={5.8} />
    </VehicleSvg>
  );
}

export function Minivan() {
  return (
    <VehicleSvg id="vehicle.minivan">
      <Ground x={10} width={78} />
      <rect x={14} y={34.4} width={70} height={1.6} rx={0.8} fill={PALETTE.bodyShade} />
      <rect x={12.4} y={34.4} width={4} height={1.6} rx={0.8} fill={PALETTE.shadow} />
      <Body d={MINIVAN_BODY} />
      {/* One-box glazing: the deepest windows in the fleet. */}
      <Glass d="M11 23 L14.4 11.8 L19.6 11.8 L16.2 23 Z" />
      <Glass d="M18.4 23 L19 11.8 L38 11.8 L38 23 Z" />
      <Glass d="M40 23 L40 11.8 L47.4 11.8 L57.3 23 Z" />
      <Glass d="M49.4 11.8 L52.4 11.8 L62.3 23 L59.3 23 Z" />
      {/* Sliding door: rear track along the flank, then the two door cuts. */}
      <Seam d="M20.4 25.2 L44.6 25.2" width={0.9} opacity={0.6} />
      <Seam d="M17.6 24.2 L17.2 33.4" />
      <Seam d="M39.2 24 L39.2 33.6" />
      <Seam d="M58.6 25.4 L57.6 33.4" />
      <Seam d="M11.6 28.8 C36 28 62 28.8 88.4 30.2" width={0.7} opacity={0.4} />
      <Seam d="M15.4 33.2 L86 33.6" width={0.7} opacity={0.3} />
      <Handle x={33.4} y={25.9} />
      <Handle x={49.6} y={27} />
      <Mirror x={59.2} y={22} />
      <circle cx={16.2} cy={27.6} r={1.4} fill={PALETTE.bodyShade} />
      <Grille x={85.4} y={28} width={4.2} height={2.6} bars={2} />
      <rect x={82.6} y={31.6} width={7} height={2.4} rx={1} fill={PALETTE.bodyShade} />
      <Lamps front={81.4} frontY={27} rear={9.4} rearY={24.2} size={3.2} />
      <ArchCut
        id="va-ec-minivan"
        body={MINIVAN_BODY}
        cuts={[
          { cx: 24, r: 7.4 },
          { cx: 74, r: 7.4 },
        ]}
      />
      <Wheel cx={24} r={5.4} />
      <Wheel cx={74} r={5.4} />
    </VehicleSvg>
  );
}

export function Van() {
  return (
    <VehicleSvg id="vehicle.van">
      <Ground x={10} width={78} />
      <rect x={13} y={33.8} width={72} height={1.8} rx={0.9} fill={PALETTE.bodyShade} />
      <rect x={12} y={34} width={4} height={1.6} rx={0.8} fill={PALETTE.shadow} />
      <Body d={VAN_BODY} />
      {/* Cab glazing only — the flank behind it is a blank cargo panel. */}
      <Glass d="M52 18.2 L52 9.6 L61.2 9.6 L67 18.2 Z" />
      <Glass d="M63.2 9.6 L66.4 9.6 L72.2 18.2 L69 18.2 Z" />
      {/* Rear door shutline plus hinges, then the pressed flank ribs. */}
      <Seam d="M12.8 10.4 L12.8 32.8" />
      <rect x={9.6} y={13.6} width={2.6} height={1.6} rx={0.6} fill={PALETTE.bodyShade} />
      <rect x={9.6} y={28.4} width={2.6} height={1.6} rx={0.6} fill={PALETTE.bodyShade} />
      <Seam d="M14.6 22.4 L50 22.4" width={0.9} opacity={0.45} />
      <Seam d="M14.6 27.4 C40 27.2 58 27.6 66.6 28.4" width={0.9} opacity={0.35} />
      {/* Sliding cargo door and the step below it. */}
      <Seam d="M30.4 19.4 L30.4 33" />
      <Seam d="M50.2 19 L50.2 33.2" />
      <rect x={33} y={33.6} width={14} height={1.5} rx={0.7} fill={PALETTE.bodyShade} />
      <Handle x={45.6} y={24} />
      <Mirror x={67.4} y={16.6} />
      {/* Roof ribs. */}
      <Seam d="M20 8.8 L20 10.6" width={0.7} opacity={0.35} />
      <Seam d="M34 8.8 L34 10.6" width={0.7} opacity={0.35} />
      <Seam d="M48 8.8 L48 10.6" width={0.7} opacity={0.35} />
      <circle cx={34.4} cy={30.4} r={1.4} fill={PALETTE.bodyShade} />
      {/* Full-height rear lamp, short-nose grille, amber marker. */}
      <rect x={9.9} y={22.4} width={2.4} height={7.4} rx={0.9} fill={PALETTE.tail} />
      <rect x={10.1} y={22.7} width={2} height={1.8} rx={0.7} fill="#ffd0c6" opacity=".55" />
      <Grille x={85.2} y={23.6} width={4.8} height={3} bars={2} />
      <rect x={83} y={28.4} width={7.4} height={2.6} rx={1} fill={PALETTE.bodyShade} />
      <Lamps front={81.4} frontY={22.6} size={3.2} />
      <rect x={80.6} y={26.8} width={1.8} height={1.4} rx={0.6} fill={PALETTE.amber} />
      <ArchCut
        id="va-ec-van"
        body={VAN_BODY}
        cuts={[
          { cx: 23, r: 7.6 },
          { cx: 75, r: 7.6 },
        ]}
      />
      <Wheel cx={23} r={5.6} />
      <Wheel cx={75} r={5.6} />
    </VehicleSvg>
  );
}
