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
} from "../vehicle-art/parts";

/**
 * Multirotors: delivery quadcopter, camera quadcopter, emergency responder.
 *
 * These are the only actors in the catalog that never touch the road, so the
 * fleet contract is honoured from the air: the shadow still sits on `GROUND`
 * (that is what `Ground` draws, and a shadow is the one thing allowed to cross
 * it), while the aircraft itself hangs well above it. Three cues carry the
 * "airborne, not parked" read at tile size:
 *
 *   - the whole airframe is tilted nose-down about the tile centre, the pose a
 *     multirotor takes when it is translating forwards;
 *   - the skids stop 5-8 units short of the shadow, and the shadow is far
 *     narrower than the rotor span, which reads as altitude;
 *   - the props are blur discs, not blades — a flat ellipse with two swept tip
 *     streaks. Solid blades would freeze the machine.
 *
 * Depth comes from the offside rotors: every arm is drawn twice, the far pair
 * inset, raised and sunk to `bodyShade`, so a side elevation still counts four
 * or six motors. Rotor count, body box and payload are what separate the three:
 *
 *   delivery   4 rotors, 34x11 body, parcel slung in a cradle, wide skids
 *   camera     4 rotors, 27x7 body, gimbal ball on a yoke, compact skids
 *   emergency  6 rotors, 44x16 body, beacons/flood/horn/turret, tall gear
 */

/** Nose-down attitude, in degrees, about the tile centre. */
const TILT = { delivery: 6.5, camera: 8, emergency: 5 } as const;

/** A straight boom of width `w` as a filled quad — arms are mass, not strokes. */
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

/**
 * Rotor boom, landing leg or payload stub. Near side gets the full body
 * treatment; `far` sinks it behind the fuselage.
 */
function Beam({
  x1,
  y1,
  x2,
  y2,
  w = 2.8,
  far = false,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w?: number;
  far?: boolean;
}) {
  const d = tube(x1, y1, x2, y2, w);
  if (far) {
    return <path d={d} fill={PALETTE.bodyShade} opacity=".9" />;
  }
  return (
    <>
      <path d={d} fill="currentColor" />
      <path d={d} fill={FILL.gloss} />
      <path d={d} fill="none" stroke={PALETTE.line} strokeWidth=".8" strokeLinejoin="round" />
    </>
  );
}

/** Brushless motor can with its output shaft, the mount the disc spins on. */
function Motor({
  cx,
  cy,
  w = 4.8,
  far = false,
}: {
  cx: number;
  cy: number;
  w?: number;
  far?: boolean;
}) {
  const h = w * 0.85;
  return (
    <g opacity={far ? 0.62 : 1}>
      <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={w * 0.3} fill={far ? PALETTE.rimShade : FILL.metal} />
      <rect x={cx - w / 2 + 0.4} y={cy - h / 2 + 0.3} width={w - 0.8} height={h * 0.3} rx={h * 0.15} fill="#fff" opacity=".24" />
      <rect x={cx - w * 0.17} y={cy - h / 2 - 1.5} width={w * 0.34} height={1.8} rx=".7" fill={PALETTE.chrome} />
    </g>
  );
}

/** One swept tip streak on the prop disc, as a quadratic through the arc mid. */
function streak(cx: number, cy: number, rx: number, ry: number, from: number, to: number): string {
  const at = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as const;
  };
  const [ax, ay] = at(from);
  const [mx, my] = at((from + to) / 2);
  const [bx, by] = at(to);
  const qx = 2 * mx - (ax + bx) / 2;
  const qy = 2 * my - (ay + by) / 2;
  return `M${ax.toFixed(2)} ${ay.toFixed(2)}Q${qx.toFixed(2)} ${qy.toFixed(2)} ${bx.toFixed(2)} ${by.toFixed(2)}`;
}

/** Spinning propeller: the blur ellipse plus two blade streaks. */
function PropDisc({
  cx,
  cy,
  rx,
  far = false,
}: {
  cx: number;
  cy: number;
  rx: number;
  far?: boolean;
}) {
  const ry = Math.max(1.15, rx * 0.145);
  return (
    <g opacity={far ? 0.55 : 1}>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={PALETTE.line} opacity=".1" />
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={PALETTE.line} strokeWidth=".6" opacity=".4" />
      <path d={streak(cx, cy, rx, ry, 150, 244)} fill="none" stroke={PALETTE.line} strokeWidth="1.5" strokeLinecap="round" opacity=".55" />
      <path d={streak(cx, cy, rx, ry, -20, 64)} fill="none" stroke={PALETTE.line} strokeWidth="1.4" strokeLinecap="round" opacity=".4" />
    </g>
  );
}

/** Fore-aft landing skid tube, seen end-on from the side. */
function SkidTube({ x, y, width }: { x: number; y: number; width: number }) {
  return (
    <g>
      <rect x={x} y={y} width={width} height="2" rx="1" fill={PALETTE.rimShade} />
      <rect x={x + 0.8} y={y + 0.35} width={width - 1.6} height=".7" rx=".35" fill={PALETTE.chrome} opacity=".7" />
    </g>
  );
}

/** Arm-tip navigation light: red aft, white forward. */
function NavLight({ cx, cy, colour }: { cx: number; cy: number; colour: string }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r="2.6" fill={colour} opacity=".18" />
      <circle cx={cx} cy={cy} r="1.15" fill={colour} />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Delivery quadcopter                                                 */
/* ------------------------------------------------------------------ */

/** Deep parcel bay fuselage: flat battery deck on top, open belly below. */
const DELIVERY_BODY =
  "M33.4 19.2 C33.4 17.4 34.8 16.2 36.8 16.2 L57.4 16.2 " +
  "C61.2 16.2 64.4 18.1 66.2 21.2 L67.4 23.4 " +
  "C68.1 24.7 67.4 26.1 65.9 26.5 L58.6 27.4 L37.2 27.2 " +
  "C34.8 27.2 33.4 25.9 33.4 24.1 Z";

/** Slide-in battery brick, the tallest thing on the airframe. */
const DELIVERY_BATTERY =
  "M40.2 11.6 L55.8 11.6 C57 11.6 57.6 12.4 57.6 13.4 L57.6 16.4 " +
  "L38.4 16.4 L38.4 13.4 C38.4 12.4 39 11.6 40.2 11.6 Z";

/** Sling cradle: two straps down to a U the parcel rides in, paid out low. */
const DELIVERY_CRADLE =
  "M41.2 30.8 L41.2 36.6 Q41.2 38.4 43 38.4 L55.6 38.4 " +
  "Q57.4 38.4 57.4 36.6 L57.4 30.8";

export function DeliveryQuadcopter() {
  return (
    <VehicleSvg id={"drone.delivery_quadcopter"}>
      <Ground x={31} width={34} />
      <ellipse cx="48" cy="42.4" rx="9" ry="1.9" fill={PALETTE.shadow} opacity=".4" />

      <g transform={`rotate(${TILT.delivery} 48 24)`}>
        {/* Offside rotor pair and offside gear, sunk behind the fuselage. */}
        <Beam x1={39} y1={18.6} x2={28.6} y2={14.6} w={2.2} far />
        <Beam x1={60} y1={19.2} x2={70.4} y2={15.4} w={2.2} far />
        <Motor cx={27.4} cy={14.2} w={4} far />
        <Motor cx={71.4} cy={15} w={4} far />
        <PropDisc cx={27.4} cy={10.1} rx={11} far />
        <PropDisc cx={71.4} cy={10.9} rx={11} far />
        <Beam x1={40} y1={26.6} x2={34.4} y2={31.6} w={1.6} far />
        <Beam x1={59.4} y1={27} x2={65} y2={31.8} w={1.6} far />

        <Body d={DELIVERY_BODY} />
        <Body d={DELIVERY_BATTERY} outline={0.8} />
        <Seam d="M43.4 12.6 V16.1" />
        <Seam d="M47.6 12.6 V16.1" />
        <Seam d="M51.8 12.6 V16.1" />
        <rect x="54.2" y="13.2" width="2.6" height="1.3" rx=".65" fill={PALETTE.amber} />

        {/* Avionics window, cooling louvres and the fuselage centre seam. */}
        <Glass d="M53.4 17.6 C57.6 17.9 60.8 19.6 62.6 22.4 L54.4 22.4 C52.8 22.4 52.2 21.4 52.4 19.4 Z" />
        <Grille x={38.6} y={22.6} width={6.6} height={3.4} bars={2} />
        <Seam d="M46.4 23.4 H63.2" opacity={0.6} />
        <Seam d="M45.4 17 V21.8" opacity={0.55} />

        {/* Near rotor pair. */}
        <Beam x1={37} y1={20.4} x2={20.4} y2={17} w={3} />
        <Beam x1={62.4} y1={21.6} x2={77.6} y2={18.8} w={3} />
        <Motor cx={19} cy={16.6} w={5} />
        <Motor cx={79} cy={18.4} w={5} />
        <PropDisc cx={19} cy={12.2} rx={13.5} />
        <PropDisc cx={79} cy={14} rx={13.5} />
        <NavLight cx={19} cy={19.6} colour={PALETTE.tail} />
        <NavLight cx={79} cy={21.4} colour="#eaf4ff" />

        {/* Winch drum in the belly bay, line paying out over the parcel face. */}
        <rect x="46.9" y="24.6" width="4.6" height="2.9" rx=".9" fill={PALETTE.bodyShade} />
        <circle cx="49.2" cy="26.1" r="1.5" fill={FILL.metal} />
        <circle cx="49.2" cy="26.1" r=".5" fill={PALETTE.bodyShade} />
        <path d="M49.2 27.4 V37.6" stroke={PALETTE.chrome} strokeWidth=".8" />
        <path d="M47.9 37.4 h2.6" stroke={PALETTE.chrome} strokeWidth="1" strokeLinecap="round" />

        {/* Slung parcel: cardboard tones are this drone's one identity colour. */}
        <path d="M42.4 26.8 L41.8 31.2" stroke={PALETTE.chrome} strokeWidth="1.2" strokeLinecap="round" />
        <path d="M56.4 27.2 L57 31.4" stroke={PALETTE.chrome} strokeWidth="1.2" strokeLinecap="round" />
        <rect x="42" y="31.2" width="14.6" height="6.6" rx=".9" fill="#c3a179" />
        <rect x="42" y="31.2" width="14.6" height="2.1" rx=".9" fill="#dcc39d" />
        <path d="M42.6 33.3 H56" stroke="#8d6f4c" strokeWidth=".6" />
        <rect x="42" y="34.4" width="14.6" height="1.5" fill="#ece0c8" opacity=".75" />
        <path d={DELIVERY_CRADLE} fill="none" stroke={PALETTE.chrome} strokeWidth="1.5" strokeLinejoin="round" />

        {/* Wide-set skids, splayed clear of the parcel. Contact points last. */}
        <Beam x1={37.6} y1={26.8} x2={30.4} y2={33.6} w={2} />
        <Beam x1={61.8} y1={27.2} x2={69} y2={34} w={2} />
        <SkidTube x={26.4} y={33.1} width={8.8} />
        <SkidTube x={64.8} y={33.5} width={8.8} />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Camera quadcopter                                                   */
/* ------------------------------------------------------------------ */

/** Slim wedge shell — a third the depth of the delivery pod. */
const CAMERA_BODY =
  "M38.8 21.4 C38.8 20.4 39.7 19.7 41 19.7 L54.4 19.7 " +
  "C58.2 19.7 61.6 21 63.9 23.2 L65.2 24.4 L63 25.5 " +
  "C60.2 26.4 57 26.7 53.6 26.7 L41 26.5 " +
  "C39.6 26.5 38.8 25.8 38.8 24.8 Z";

/** Gimbal ball, slung low enough that the yoke legs stay visible above it. */
const CAMERA_BALL = "M56 31 a3.2 3.2 0 0 1 6.4 0 a3.2 3.2 0 0 1 -6.4 0 Z";

export function CameraQuadcopter() {
  return (
    <VehicleSvg id={"drone.camera_quadcopter"}>
      <Ground x={36} width={24} />
      <ellipse cx="48" cy="42.4" rx="6.4" ry="1.6" fill={PALETTE.shadow} opacity=".35" />

      <g transform={`rotate(${TILT.camera} 48 24)`}>
        {/* Offside folding arms. */}
        <Beam x1={42.4} y1={20.6} x2={34.8} y2={16.4} w={1.8} far />
        <Beam x1={58.6} y1={21} x2={66.6} y2={17.2} w={1.8} far />
        <Motor cx={33.6} cy={16.1} w={3.4} far />
        <Motor cx={67.8} cy={16.9} w={3.4} far />
        <PropDisc cx={33.6} cy={12.8} rx={9} far />
        <PropDisc cx={67.8} cy={13.6} rx={9} far />

        {/* Whip antenna pair, swept back off the tail deck. */}
        <path d="M40.6 20.2 L34.6 12.7" stroke={PALETTE.chrome} strokeWidth=".9" strokeLinecap="round" />
        <path d="M43.2 19.8 L38.6 11.6" stroke={PALETTE.chrome} strokeWidth=".9" strokeLinecap="round" />
        <circle cx="34.4" cy="12.4" r=".95" fill={PALETTE.line} />
        <circle cx="38.4" cy="11.3" r=".95" fill={PALETTE.line} />

        <Body d={CAMERA_BODY} />
        <Glass d="M42.2 20.9 L52.6 20.9 C55.6 21 58 21.9 59.8 23.4 L44 23.4 C42.6 23.4 42 22.6 42.2 20.9 Z" />
        <Seam d="M43.8 24.4 H60" opacity={0.6} />
        <Seam d="M49.6 20.6 V24.2" opacity={0.5} />
        <rect x="61.4" y="22.9" width="2.8" height="1.7" rx=".7" fill={PALETTE.glass} />
        <circle cx="62.2" cy="23.75" r=".45" fill={PALETTE.chrome} />
        <circle cx="63.4" cy="23.75" r=".45" fill={PALETTE.chrome} />
        <circle cx="40.6" cy="24.7" r="1.1" fill={PALETTE.beaconBlue} />

        {/* Near folding arms: hinge knuckle, then the swept outer section. */}
        <Beam x1={40.2} y1={22.2} x2={33.6} y2={21.2} w={2.4} />
        <Beam x1={62.6} y1={23.4} x2={69.2} y2={22.2} w={2.4} />
        <Beam x1={33.8} y1={21.2} x2={22.6} y2={17.8} w={2.2} />
        <Beam x1={69} y1={22.2} x2={79.6} y2={19} w={2.2} />
        <circle cx="33.6" cy="21.2" r="1.6" fill={FILL.metal} />
        <circle cx="33.6" cy="21.2" r=".55" fill={PALETTE.bodyShade} />
        <circle cx="69.2" cy="22.2" r="1.6" fill={FILL.metal} />
        <circle cx="69.2" cy="22.2" r=".55" fill={PALETTE.bodyShade} />
        <Motor cx={21.4} cy={17.5} w={4} />
        <Motor cx={80.8} cy={18.7} w={4} />
        <PropDisc cx={21.4} cy={13.7} rx={10.5} />
        <PropDisc cx={80.8} cy={14.9} rx={10.5} />
        <NavLight cx={21.4} cy={20.3} colour={PALETTE.tail} />
        <NavLight cx={80.8} cy={21.5} colour="#eaf4ff" />

        {/* Gimbal: yoke legs, roll pivots, ball, wide lens. */}
        <path d="M55.8 26.1 L55.8 30.8" stroke={PALETTE.chrome} strokeWidth="1.3" strokeLinecap="round" />
        <path d="M62.6 25.7 L62.6 30.4" stroke={PALETTE.chrome} strokeWidth="1.3" strokeLinecap="round" />
        <path d="M55.8 26.4 L62.6 25.9" stroke={PALETTE.chrome} strokeWidth="1.2" />
        <Body d={CAMERA_BALL} outline={0.8} />
        <circle cx="62.6" cy="30.4" r=".95" fill={PALETTE.chrome} />
        <circle cx="55.8" cy="30.8" r=".95" fill={PALETTE.chrome} />
        <circle cx="60.5" cy="31.9" r="1.9" fill={FILL.glass} />
        <circle cx="60.5" cy="31.9" r="1.9" fill="none" stroke={PALETTE.chrome} strokeWidth=".6" />
        <path d="M59.4 30.9 a1.5 1.5 0 0 1 1.8 -.3" stroke="#dceaff" strokeWidth=".6" strokeLinecap="round" opacity=".7" />

        {/* Compact skids, inboard of the gimbal. */}
        <Beam x1={42.8} y1={26.3} x2={41.2} y2={30.1} w={1.5} />
        <Beam x1={51} y1={26.5} x2={52.6} y2={30.2} w={1.5} />
        <SkidTube x={38.2} y={29.8} width={6} />
        <SkidTube x={48.6} y={29.9} width={6} />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Emergency responder                                                 */
/* ------------------------------------------------------------------ */

/** Heavy-lift hull: 44 units long, 16 deep, with a payload chin. */
const EMERGENCY_BODY =
  "M28.6 18.4 C28.6 15.8 30.6 14.2 33.4 14.2 L59.4 14.2 " +
  "C64.6 14.2 69.2 16.9 71.6 21.2 L73 23.8 " +
  "C73.9 25.6 73 27.6 71 28.2 L63.6 30 L36 30.2 " +
  "C31.6 30.2 28.6 27.8 28.6 24.6 Z";

/** Hi-vis band, held inside the hull outline so it never breaks the edge. */
const EMERGENCY_BAND = "M30.2 21.5 L70.4 22.7 L71 25.6 L30.8 25.3 Z";

/**
 * Public-address horn: a steep flare with a lit lip and a dark throat, so it
 * reads as a cone rather than a hole punched in the belly.
 */
const EMERGENCY_HORN = "M36.4 29 L41.8 29.2 L45.6 33.6 L31.8 33.4 Z";

/** Floodlight pod, slung under the nose along the hull's lower chine. */
const EMERGENCY_FLOOD =
  "M63.2 30.2 L70.8 28.8 C72.1 28.6 73 29.4 72.9 30.6 L72.6 32.2 " +
  "C72.4 33.4 71.4 34.2 70.2 34.3 L64.4 34.6 " +
  "C63 34.7 62.2 33.9 62.3 32.6 L62.5 31.2 C62.6 30.6 62.7 30.3 63.2 30.2 Z";

/** Dual-sensor thermal turret ball. */
const EMERGENCY_TURRET = "M46.8 33 a3.8 3.8 0 0 1 7.6 0 a3.8 3.8 0 0 1 -7.6 0 Z";

/** One strobe dome. */
function Beacon({ cx, cy, colour }: { cx: number; cy: number; colour: string }) {
  return (
    <g>
      <circle cx={cx} cy={cy - 1} r="4.6" fill={colour} opacity=".16" />
      <path d={`M${cx - 2.6} ${cy} a2.6 2.6 0 0 1 5.2 0 Z`} fill={colour} />
      <path d={`M${cx - 1.7} ${cy - 1.1} a1.7 1.7 0 0 1 3.4 0`} fill="#fff" opacity=".55" />
    </g>
  );
}

export function EmergencyResponder() {
  return (
    <VehicleSvg id={"drone.emergency_responder"}>
      <Ground x={26} width={44} />
      <ellipse cx="48" cy="42.4" rx="12" ry="2.2" fill={PALETTE.shadow} opacity=".42" />

      <g transform={`rotate(${TILT.emergency} 48 24)`}>
        {/* Offside three of the six rotors. */}
        <Beam x1={33} y1={17.4} x2={24} y2={12.6} w={2.4} far />
        <Beam x1={66} y1={17.8} x2={75.6} y2={13.2} w={2.4} far />
        <Beam x1={50.4} y1={15.2} x2={52.8} y2={10.6} w={2} far />
        <Motor cx={23} cy={12} w={4.4} far />
        <Motor cx={76.6} cy={12.6} w={4.4} far />
        <Motor cx={53.4} cy={9.8} w={3.8} far />
        <PropDisc cx={23} cy={7.8} rx={11.5} far />
        <PropDisc cx={76.6} cy={8.4} rx={11.5} far />
        <PropDisc cx={53.4} cy={5.8} rx={10.5} far />
        <Beam x1={40} y1={29.8} x2={35.6} y2={33.4} w={1.8} far />
        <Beam x1={52.6} y1={29.8} x2={57.6} y2={33.4} w={1.8} far />

        <Body d={EMERGENCY_BODY} />

        {/* Hi-vis band with chevrons; hull outline re-struck over its edges. */}
        <path d={EMERGENCY_BAND} fill={PALETTE.amber} />
        <g fill={PALETTE.bodyShade} opacity=".45">
          <path d="M36.4 21.6 L39.6 21.7 L36 25.4 L32.8 25.35 Z" />
          <path d="M47 22 L50.2 22.1 L46.6 25.5 L43.4 25.45 Z" />
          <path d="M57.6 22.3 L60.8 22.4 L57.2 25.55 L54 25.5 Z" />
        </g>
        <path d={EMERGENCY_BODY} fill="none" stroke={PALETTE.line} strokeWidth="1.1" strokeLinejoin="round" />

        {/* Deck: strobes, GPS puck, cooling louvres, hull seams. */}
        <Beacon cx={37.2} cy={14.4} colour={PALETTE.beaconBlue} />
        <Beacon cx={57} cy={14.5} colour={PALETTE.beaconRed} />
        <ellipse cx="47.6" cy="13.5" rx="3" ry="1.2" fill={FILL.metal} />
        <ellipse cx="47.6" cy="13.2" rx="1.2" ry=".5" fill={PALETTE.chrome} />
        <Grille x={31.4} y={16} width={7} height={4} bars={2} />
        <Seam d="M40.4 15.6 V20.8" opacity={0.55} />
        <Seam d="M62.4 17.6 V21.8" opacity={0.55} />
        <Seam d="M31.8 27.6 H68.4" opacity={0.5} />
        <Glass d="M63.4 18.2 C66.6 19.2 69 21.2 70.4 24 L64.2 23.6 C62.8 23.4 62.2 22.4 62.4 20 Z" opacity={0.9} />

        {/* Nearside three rotors: the long fore/aft booms plus a raised stub. */}
        <Beam x1={31} y1={20.4} x2={17.6} y2={16.6} w={3.4} />
        <Beam x1={69.6} y1={22.4} x2={81.4} y2={18.6} w={3.4} />
        <Beam x1={45.6} y1={15.4} x2={43.2} y2={11.6} w={2.6} />
        <Motor cx={16.2} cy={16.2} w={5.4} />
        <Motor cx={82.8} cy={18.2} w={5.4} />
        <Motor cx={43} cy={10.8} w={4.6} />
        <PropDisc cx={16.2} cy={11.4} rx={14} />
        <PropDisc cx={82.8} cy={13.4} rx={12.4} />
        <PropDisc cx={43} cy={6.6} rx={12} />
        <NavLight cx={16.2} cy={19.6} colour={PALETTE.tail} />
        <NavLight cx={82.8} cy={21.6} colour="#eaf4ff" />

        {/* Public-address horn, aft belly. */}
        <Body d={EMERGENCY_HORN} outline={0.9} />
        <ellipse cx="38.7" cy="33.5" rx="6.3" ry="1.75" fill="none" stroke={PALETTE.line} strokeWidth=".9" opacity=".9" />
        <ellipse cx="38.7" cy="33.5" rx="5.2" ry="1.3" fill={PALETTE.bodyShade} />
        <ellipse cx="38.7" cy="33.6" rx="3.2" ry=".75" fill="#070b12" />
        <path d="M34.6 31.4 H43.2" stroke={PALETTE.seam} strokeWidth=".7" opacity=".45" />

        {/* Thermal turret: collar, ball, wide-angle lens and thermal window. */}
        <Body d="M46.4 29.6 L54.8 29.8 L54.6 32.2 L46.6 32 Z" outline={0.8} />
        <Body d={EMERGENCY_TURRET} outline={0.8} />
        <circle cx="52.4" cy="33.6" r="1.7" fill={FILL.glass} />
        <circle cx="52.4" cy="33.6" r="1.7" fill="none" stroke={PALETTE.chrome} strokeWidth=".55" />
        <circle cx="49" cy="34" r="1.25" fill={PALETTE.amber} opacity=".85" />
        <circle cx="49" cy="34" r=".5" fill="#2b1c05" />

        {/* Floodlight pod and its short spill cone. */}
        <path d="M63.6 34.6 L70.4 34.2 L73.2 36.6 L61.6 37 Z" fill={PALETTE.lamp} opacity=".16" />
        <Body d={EMERGENCY_FLOOD} outline={0.9} />
        <g>
          <circle cx="64.6" cy="33.2" r="1.35" fill={PALETTE.lamp} />
          <circle cx="64.6" cy="33.2" r=".6" fill="#fffdf2" />
          <circle cx="67.2" cy="32.8" r="1.35" fill={PALETTE.lamp} />
          <circle cx="67.2" cy="32.8" r=".6" fill="#fffdf2" />
          <circle cx="69.8" cy="32.2" r="1.35" fill={PALETTE.lamp} />
          <circle cx="69.8" cy="32.2" r=".6" fill="#fffdf2" />
        </g>

        {/* Tall skid gear, set clear of the horn mouth and the flood pod. */}
        <Beam x1={33.4} y1={30.1} x2={28.2} y2={35.9} w={2.2} />
        <Beam x1={56} y1={30.1} x2={61.8} y2={35.9} w={2.2} />
        <SkidTube x={23.6} y={35.6} width={9.6} />
        <SkidTube x={56.8} y={35.7} width={9.6} />
      </g>
    </VehicleSvg>
  );
}
