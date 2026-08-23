"use client";

import {
  Body,
  FILL,
  GROUND,
  Glass,
  Grille,
  Ground,
  PALETTE,
  Seam,
  VehicleSvg,
} from "../vehicle-art/parts";

/**
 * The five humanoid sidewalk robots.
 *
 * They all come off one production line, so they share a chassis language and
 * only the role kit and the pose change:
 *
 *   - segmented limbs, each segment a capsule with an exposed actuator disc at
 *     the shoulder, elbow, hip, knee and ankle
 *   - a visored sensor head over a conduit neck and a collar plate
 *   - a torso whose lit front plane faces right and whose narrow back plane is
 *     sunk two tones, which is what turns the figure three-quarters to camera
 *   - a pelvis casting the legs hang from, and a flat sole pad on the ground
 *
 * Vertical contract: sole on `GROUND`, ankle 38, knee 34, hip 29.5, shoulder 17,
 * head 6…13. Every unit therefore stands the same height and reads as the same
 * product family in one row of tiles, and the pose alone carries the role.
 */

/** Far-side limbs and back panels: class tint kept, two tones down. */
function Far({ d }: { d: string }) {
  return (
    <>
      <path d={d} fill="currentColor" />
      <path d={d} fill={PALETTE.shadow} opacity=".5" />
      <path d={d} fill="none" stroke={PALETTE.seam} strokeWidth=".6" opacity=".85" />
    </>
  );
}

/** Hi-vis and identity colours. Everything else is `currentColor`. */
const HIVIS = "#d9ef4f";
const HIVIS_SHADE = "#9fb42a";
const REFLECT = "#eaf4ff";
const HAT = "#f2b13c";
const HAT_SHADE = "#bd8218";
const CARTON = "#c2986a";
const CARTON_TOP = "#dbb387";
const CARTON_SIDE = "#8d6d49";

/** Rounded panel as a path, so plates can go through `Body` like any shell. */
function box(x: number, y: number, w: number, h: number, r = 1.2): string {
  return (
    `M${(x + r).toFixed(2)} ${y.toFixed(2)}H${(x + w - r).toFixed(2)}` +
    `A${r} ${r} 0 0 1 ${(x + w).toFixed(2)} ${(y + r).toFixed(2)}` +
    `V${(y + h - r).toFixed(2)}A${r} ${r} 0 0 1 ${(x + w - r).toFixed(2)} ${(y + h).toFixed(2)}` +
    `H${(x + r).toFixed(2)}A${r} ${r} 0 0 1 ${x.toFixed(2)} ${(y + h - r).toFixed(2)}` +
    `V${(y + r).toFixed(2)}A${r} ${r} 0 0 1 ${(x + r).toFixed(2)} ${y.toFixed(2)}Z`
  );
}

/** One limb segment: a capsule, so the round ends read as sockets. */
function bone(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const r = w / 2;
  const nx = (-dy / length) * r;
  const ny = (dx / length) * r;
  return (
    `M${(x1 + nx).toFixed(2)} ${(y1 + ny).toFixed(2)}L${(x2 + nx).toFixed(2)} ${(y2 + ny).toFixed(2)}` +
    `A${r} ${r} 0 0 0 ${(x2 - nx).toFixed(2)} ${(y2 - ny).toFixed(2)}` +
    `L${(x1 - nx).toFixed(2)} ${(y1 - ny).toFixed(2)}` +
    `A${r} ${r} 0 0 0 ${(x1 + nx).toFixed(2)} ${(y1 + ny).toFixed(2)}Z`
  );
}

const SOLE = GROUND - 0.1;

/** Sole pad: heel behind the ankle, toe ramp ahead of it, flat on the road. */
function foot(x: number, y = 37.5, len = 5, heel = 2.4): string {
  return (
    `M${(x - heel).toFixed(2)} ${y.toFixed(2)}L${(x + len - 1.2).toFixed(2)} ${(y + 0.4).toFixed(2)}` +
    `C${(x + len).toFixed(2)} ${(y + 0.7).toFixed(2)} ${(x + len + 0.5).toFixed(2)} ${(y + 1.7).toFixed(2)} ` +
    `${(x + len + 0.2).toFixed(2)} ${(y + 2.5).toFixed(2)}` +
    `L${(x + len).toFixed(2)} ${SOLE.toFixed(2)}L${(x - heel + 0.3).toFixed(2)} ${SOLE.toFixed(2)}` +
    `C${(x - heel - 0.9).toFixed(2)} ${(y + 2.4).toFixed(2)} ${(x - heel - 0.8).toFixed(2)} ${(y + 0.8).toFixed(2)} ` +
    `${(x - heel).toFixed(2)} ${y.toFixed(2)}Z`
  );
}

/** One limb segment, lit on the near side and sunk on the far side. */
function Bone({
  x1,
  y1,
  x2,
  y2,
  w,
  far = false,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  far?: boolean;
}) {
  const d = bone(x1, y1, x2, y2, w);
  return far ? <Far d={d} /> : <Body d={d} outline={0.75} />;
}

/** Exposed actuator at a shoulder, elbow, hip, knee or ankle. */
function Joint({
  cx,
  cy,
  r = 2,
  far = false,
}: {
  cx: number;
  cy: number;
  r?: number;
  far?: boolean;
}) {
  return (
    <>
      <circle cx={cx} cy={cy} r={r} fill={far ? PALETTE.bodyShade : FILL.metal} />
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={far ? PALETTE.seam : PALETTE.rimShade}
        strokeWidth=".6"
        opacity={far ? 0.75 : 1}
      />
      {far ? null : <circle cx={cx} cy={cy} r={Math.max(r * 0.32, 0.55)} fill={PALETTE.chrome} />}
    </>
  );
}

/** Three-finger gripper. `rotate` 0 points the fingers at the ground. */
function Hand({
  x,
  y,
  rotate = 0,
  far = false,
}: {
  x: number;
  y: number;
  rotate?: number;
  far?: boolean;
}) {
  const palm = box(x - 1.5, y - 2.2, 3, 2.8, 0.9);
  const digit = far ? PALETTE.bodyShade : FILL.metal;
  return (
    <g transform={`rotate(${rotate} ${x} ${y})`}>
      {far ? <Far d={palm} /> : <Body d={palm} outline={0.7} />}
      <path d={bone(x - 0.85, y + 0.2, x - 1.05, y + 2.1, 1.1)} fill={digit} />
      <path d={bone(x + 0.85, y + 0.2, x + 1.05, y + 2.1, 1.1)} fill={digit} />
      <path d={bone(x + 1.5, y - 0.9, x + 2.3, y + 0.5, 1)} fill={digit} />
    </g>
  );
}

/** Sensor head: shell, wraparound visor, mono lens, side comm pod. */
function SensorHead({ x, y, w = 10.6, h = 7.6 }: { x: number; y: number; w?: number; h?: number }) {
  const lensX = x + w - 2.5;
  const lensY = y + h * 0.45;
  return (
    <>
      <Body d={box(x, y, w, h, h * 0.32)} outline={0.95} />
      <Glass d={box(x + 2.1, y + h * 0.22, w - 2.4, h * 0.44, 1.3)} />
      <circle cx={lensX} cy={lensY} r={h * 0.19} fill={PALETTE.glass} />
      <circle cx={lensX} cy={lensY} r={h * 0.19} fill="none" stroke={PALETTE.chrome} strokeWidth=".55" />
      <circle cx={lensX - 0.5} cy={lensY - 0.5} r={h * 0.07} fill="#f2f8ff" opacity=".9" />
      <rect x={x - 1} y={y + h * 0.34} width="1.9" height={h * 0.38} rx=".75" fill={FILL.metal} />
      <Seam d={`M${x + 1.5} ${y + 1} L${x + w - 1.7} ${y + 1.3}`} width={0.6} opacity={0.55} />
    </>
  );
}

/** Conduit neck: two cable runs and the collar plate they disappear into. */
function Neck({ x, y }: { x: number; y: number }) {
  return (
    <>
      <path d={bone(x - 1.6, y, x - 2.2, y + 2.9, 1.4)} fill={PALETTE.rimShade} />
      <path d={bone(x + 0.7, y + 0.1, x + 0.4, y + 3, 1.4)} fill={PALETTE.rimShade} />
      <g stroke={PALETTE.chrome} strokeWidth=".55" opacity=".75">
        <line x1={x - 2.6} y1={y + 0.9} x2={x - 1.1} y2={y + 0.8} />
        <line x1={x - 2.7} y1={y + 1.9} x2={x - 1.2} y2={y + 1.8} />
        <line x1={x - 0.3} y1={y + 1} x2={x + 1.2} y2={y + 1} />
        <line x1={x - 0.4} y1={y + 2} x2={x + 1.1} y2={y + 2} />
      </g>
      <path d={box(x - 3, y + 2.3, 6, 1.9, 0.8)} fill={FILL.metal} />
      <path d={box(x - 3, y + 2.3, 6, 1.9, 0.8)} fill="none" stroke={PALETTE.rimShade} strokeWidth=".55" />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* General purpose                                                     */
/* ------------------------------------------------------------------ */

const GP_TORSO =
  "M45.2 16.6 C45.4 14.7 46.9 13.9 48.7 13.9 L54.5 14.1 " +
  "C56.5 14.3 57.3 15.6 57.1 17.4 L56.4 24.6 " +
  "C56.2 26.4 55.1 27.3 53.3 27.2 L47.6 27 " +
  "C45.8 26.9 45 25.9 45.1 24.1 Z";

const GP_BACK =
  "M41.9 17.2 C42.1 15.3 43.3 14.3 45.1 14 L45.5 13.9 L45.3 27.1 L44.3 26.9 " +
  "C42.7 26.6 41.9 25.6 42 23.8 Z";

/** Near shoulder cap, shared by the standing builds. */
const PAULDRON =
  "M54.6 14.3 C57.6 13.7 59.9 15.3 60.1 18.1 L59.8 20.8 " +
  "C58.2 21.7 56.2 21.4 55 20.2 Z";

/** Baseline unit: bare chassis, neutral stance, status panel on the chest. */
export function HumanoidGeneralPurpose() {
  return (
    <VehicleSvg id={"sidewalk_robot.humanoid_general_purpose"}>
      <Ground x={42} width={20} />

      {/* Far arm and far leg, behind the torso and sunk two tones. */}
      <Bone x1={42.4} y1={18} x2={41.2} y2={23.4} w={3} far />
      <Joint cx={41.2} cy={23.6} r={1.6} far />
      <Bone x1={41.2} y1={23.8} x2={41.9} y2={29.2} w={2.6} far />
      <Hand x={41.9} y={30.6} rotate={-4} far />
      <Bone x1={47.2} y1={29.4} x2={46.6} y2={34.2} w={4} far />
      <Joint cx={46.6} cy={34.4} r={1.9} far />
      <Bone x1={46.6} y1={34.6} x2={46.4} y2={37.8} w={3.2} far />
      <Far d={foot(46.4, 37.5, 4.6, 2.2)} />

      {/* Torso: sunk back plane, then the lit front plane. */}
      <Far d={GP_BACK} />
      <Joint cx={42.6} cy={17} r={2.2} far />
      <Body d={GP_TORSO} />
      <Seam d="M53.6 14.3 L53 26.9" width={0.7} opacity={0.55} />
      <path
        d="M46.4 15.8 C46.9 19.6 46.8 23.4 46.7 25.9"
        fill="none"
        stroke={REFLECT}
        strokeWidth=".7"
        opacity=".3"
      />

      {/* Chest status panel and the cooling stack under it. */}
      <path d={box(48.4, 16.4, 6.8, 5.6, 1)} fill={PALETTE.bodyShade} />
      <path d={box(48.4, 16.4, 6.8, 5.6, 1)} fill="none" stroke={PALETTE.seam} strokeWidth=".55" />
      <rect x="49.2" y="17.3" width="5.2" height="1" rx=".4" fill={PALETTE.lamp} opacity=".95" />
      <rect x="49.2" y="18.8" width="3.6" height="1" rx=".4" fill={PALETTE.beaconBlue} opacity=".9" />
      <rect x="49.2" y="20.3" width="2.4" height="1" rx=".4" fill={PALETTE.amber} opacity=".85" />
      <Grille x={48.8} y={22.9} width={6} height={3} bars={3} />

      <Neck x={50.6} y={12.4} />
      <SensorHead x={45.6} y={5.4} />
      <circle cx="47.6" cy="4.6" r="1.1" fill={FILL.metal} />
      <circle cx="47.6" cy="4.6" r="1.1" fill="none" stroke={PALETTE.line} strokeWidth=".5" />

      {/* Near arm, hanging relaxed. */}
      <Body d={PAULDRON} outline={0.85} />
      <Joint cx={58.4} cy={18.6} r={2.4} />
      <Bone x1={58.4} y1={18.9} x2={59.4} y2={24.2} w={3.4} />
      <Joint cx={59.4} cy={24.4} r={1.9} />
      <Bone x1={59.4} y1={24.6} x2={58.6} y2={30.2} w={2.9} />
      <Hand x={58.5} y={31.5} rotate={4} />

      {/* Pelvis and near leg last, on the ground. */}
      <Body d={box(45.4, 26.2, 11.6, 4.6, 1.7)} outline={0.95} />
      <Seam d="M45.9 28.7 L56.6 29" width={0.7} opacity={0.5} />
      <Joint cx={54.6} cy={29.8} r={2.2} />
      <Bone x1={54.6} y1={30} x2={55} y2={34.4} w={4.4} />
      <Joint cx={55} cy={34.6} r={2.1} />
      <Bone x1={55} y1={34.8} x2={55.2} y2={38} w={3.6} />
      <Joint cx={55.2} cy={38} r={1.4} />
      <Body d={foot(55.2, 37.5, 5, 2.4)} outline={0.9} />
      <path d="M53.2 40.2 L59.9 40.3" stroke={PALETTE.chrome} strokeWidth=".6" opacity=".65" />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Delivery                                                            */
/* ------------------------------------------------------------------ */

const DL_TORSO =
  "M46 16.4 C46.5 14.6 48 13.7 49.8 13.8 L55.3 14.2 " +
  "C57.2 14.5 57.8 15.9 57.4 17.7 L56.1 24.7 " +
  "C55.7 26.4 54.5 27.2 52.7 27 L47.2 26.6 " +
  "C45.5 26.4 45 25.4 45.4 23.6 Z";

const DL_BACK =
  "M42.6 17.4 C43 15.5 44.2 14.4 46 14 L46.4 13.9 L45.6 27 L44.6 26.8 " +
  "C43 26.4 42.3 25.3 42.6 23.4 Z";

/** Rear foot at toe-off: heel lifted, only the toe pad still down. */
const DL_REAR_FOOT =
  "M41.5 37.6 C41.2 36.8 42.1 36.1 42.9 36.5 L47.6 38.6 " +
  "C48.7 39.1 48.9 40.1 48.4 40.9 L46 40.9 " +
  "C44 40.1 42.4 39 41.5 37.6 Z";

/** Courier unit mid-stride, carton hugged to the chest, battery on its back. */
export function HumanoidDelivery() {
  return (
    <VehicleSvg id={"sidewalk_robot.humanoid_delivery"}>
      <Ground x={40} width={22} />

      {/* Trailing leg, pushing off. */}
      <Bone x1={47.4} y1={29.2} x2={45.6} y2={33.8} w={3.8} far />
      <Joint cx={45.6} cy={34} r={1.9} far />
      <Bone x1={45.6} y1={34.2} x2={44.2} y2={37.2} w={3.1} far />
      <Far d={DL_REAR_FOOT} />

      {/* Backpack battery: fins, charge strip, shoulder strap. */}
      <Far d={box(37.6, 15.4, 7, 11, 1.8)} />
      <g stroke={PALETTE.chrome} strokeWidth=".6" opacity=".55">
        <line x1="38.4" y1="17.6" x2="43.8" y2="17.8" />
        <line x1="38.4" y1="19.4" x2="43.8" y2="19.6" />
        <line x1="38.4" y1="21.2" x2="43.8" y2="21.4" />
      </g>
      <rect x="38.4" y="23.2" width="4.6" height="1.5" rx=".6" fill={PALETTE.beaconBlue} opacity=".85" />
      <circle cx="43.4" cy="16.9" r=".9" fill={PALETTE.lamp} opacity=".9" />

      {/* Far arm, reaching round the carton. */}
      <Joint cx={45.6} cy={16.6} r={2.1} far />
      <Bone x1={45.6} y1={17} x2={46.8} y2={22.4} w={2.9} far />
      <Joint cx={46.8} cy={22.6} r={1.7} far />
      <Bone x1={46.8} y1={22.8} x2={52.6} y2={23.8} w={2.6} far />

      <Far d={DL_BACK} />
      <path d={bone(44.2, 16.2, 48.6, 14.8, 1.9)} fill={PALETTE.bodyShade} />
      <Body d={DL_TORSO} />
      <Seam d="M53.9 14.4 L53.2 26.7" width={0.7} opacity={0.5} />
      <path d={box(47.4, 16.6, 4.4, 3.4, 0.9)} fill={PALETTE.bodyShade} />
      <rect x="48.2" y="17.6" width="2.8" height="1.2" rx=".5" fill={PALETTE.beaconBlue} opacity=".8" />

      <Neck x={51.4} y={12.5} />
      <SensorHead x={46.4} y={5.5} w={10.4} h={7.4} />

      {/* Hip pouch on the near side, flap buckled down. */}
      <Body d={box(55.4, 26.9, 3.4, 4.1, 0.9)} outline={0.7} />
      <path d="M55.2 26.9 L59 27.1 L58.9 28.7 L55.3 28.5 Z" fill={PALETTE.bodyShade} />
      <rect x="56.6" y="28.2" width="1.4" height="1" rx=".3" fill={PALETTE.chrome} opacity=".8" />

      {/* Carton: front face, top and outer side, tape and label. */}
      <path d="M52 18.4 L54.4 16.4 L64.8 16.8 L62.4 18.6 Z" fill={CARTON_TOP} />
      <path d="M62.4 18.6 L64.8 16.8 L65 24.4 L62.4 26.5 Z" fill={CARTON_SIDE} />
      <path d={box(51.9, 18.4, 10.6, 8.1, 0.7)} fill={CARTON} />
      <path d={box(51.9, 18.4, 10.6, 8.1, 0.7)} fill={FILL.gloss} opacity=".55" />
      <path
        d="M52 18.4 L54.4 16.4 L64.8 16.8 L65 24.4 L62.4 26.5 L52 26.5 Z"
        fill="none"
        stroke={CARTON_SIDE}
        strokeWidth=".8"
        strokeLinejoin="round"
      />
      <path d="M57.4 18.5 L57.4 26.4" stroke={REFLECT} strokeWidth="1.1" opacity=".75" />
      <path d="M57.4 18.5 L59.8 16.6" stroke={REFLECT} strokeWidth="1" opacity=".55" />
      <rect x="58.6" y="20.4" width="3.2" height="2.6" rx=".4" fill={REFLECT} opacity=".55" />
      <g stroke={CARTON_SIDE} strokeWidth=".6" opacity=".8">
        <line x1="52.2" y1="21.6" x2="56.6" y2="21.6" />
        <line x1="52.4" y1="24.4" x2="61.8" y2="24.5" />
      </g>

      {/* Near arm clamping the carton from underneath. */}
      <Joint cx={57.8} cy={17.6} r={2.5} />
      <Bone x1={57.8} y1={18} x2={58.8} y2={23.6} w={3.3} />
      <Joint cx={58.7} cy={24} r={1.9} />
      <Bone x1={58.4} y1={25.6} x2={63.4} y2={25.2} w={2.9} />
      <Hand x={64.6} y={24} rotate={-104} />

      {/* Leading leg, planted. */}
      <Body d={box(45.2, 26, 11.8, 4.6, 1.7)} outline={0.95} />
      <Seam d="M45.7 28.5 L56.4 28.8" width={0.7} opacity={0.5} />
      <Joint cx={53.8} cy={29.4} r={2.2} />
      <Bone x1={53.8} y1={29.6} x2={56} y2={33.6} w={4.4} />
      <Joint cx={56} cy={33.8} r={2.1} />
      <Bone x1={56} y1={34} x2={56.6} y2={37.6} w={3.6} />
      <Joint cx={56.6} cy={37.7} r={1.4} />
      <Body d={foot(56.6, 37.4, 4.8, 2.3)} outline={0.9} />
      <path d="M54.7 40.2 L61.2 40.3" stroke={PALETTE.chrome} strokeWidth=".6" opacity=".65" />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Warehouse                                                           */
/* ------------------------------------------------------------------ */

const WH_TORSO =
  "M41.4 16.6 C41.8 14.2 43.6 13 46.2 13 L55 13.4 " +
  "C57.7 13.8 58.9 15.3 58.7 17.7 L58 25 " +
  "C57.8 27 56.4 28 53.9 27.8 L45 27.4 " +
  "C42.5 27.2 41.3 26.2 41.5 23.8 Z";

/** Load-spreading yoke across the shoulders. */
const WH_YOKE =
  "M41.8 15.8 C43.4 13.1 46 12 49.4 12.1 L54.4 12.4 " +
  "C57.6 12.8 59.2 14.2 59.2 16.6 L58.6 18 " +
  "C57.4 16.2 55.4 15.2 52.6 15 L47 14.7 " +
  "C44.6 14.6 43 15 41.9 16.7 Z";

/** Stackable tote: walls flared out to the rim, rounded base corners. */
const WH_TOTE =
  "M50.8 1.6 L64.6 2 L63.7 7.2 C63.6 7.7 63.2 8 62.7 8 L52.6 7.7 " +
  "C52.1 7.7 51.8 7.4 51.7 6.9 Z";

/** Knee guard: a wrap plate over the near knee. */
function KneeGuard({ cx, cy, s = 1 }: { cx: number; cy: number; s?: number }) {
  return (
    <g transform={`translate(${cx} ${cy}) scale(${s})`}>
      <path
        d="M-2.6 -1.7 C-0.6 -2.6 2 -2 2.7 -0.2 L2.1 2.1 C0.5 2.8 -1.6 2.3 -2.7 1.1 Z"
        fill={FILL.metal}
        stroke={PALETTE.rimShade}
        strokeWidth=".6"
      />
      <path d="M-2 -0.3 L2.3 0" stroke={PALETTE.chrome} strokeWidth=".6" opacity=".8" />
    </g>
  );
}

/** Heavy lifter: exo waist, load yoke, tote raised clear overhead. */
export function HumanoidWarehouse() {
  return (
    <VehicleSvg id={"sidewalk_robot.humanoid_warehouse"}>
      <Ground x={38} width={26} />

      {/* Far leg, braced wide. */}
      <Bone x1={45.4} y1={29.2} x2={43.6} y2={34} w={4.6} far />
      <Joint cx={43.6} cy={34.2} r={2.1} far />
      <Bone x1={43.6} y1={34.4} x2={43} y2={37.9} w={3.6} far />
      <Far d={foot(43, 37.5, 4.6, 2.6)} />
      <KneeGuard cx={43.4} cy={34.1} s={0.85} />

      {/* Far arm, hanging outside the broad torso so it still reads. */}
      <Joint cx={42} cy={16.8} r={2.3} far />
      <Bone x1={42} y1={17.2} x2={39.6} y2={22.4} w={3.2} far />
      <Joint cx={39.6} cy={22.6} r={1.8} far />
      <Bone x1={39.6} y1={22.8} x2={40.2} y2={28.6} w={2.8} far />
      <Hand x={40.2} y={30} rotate={-8} far />

      <Body d={WH_TORSO} />
      <Body d={WH_YOKE} outline={0.8} />
      <Seam d="M54 13.6 L53.4 27.4" width={0.8} opacity={0.5} />
      <Seam d="M42.2 20.4 L57.9 21" width={0.7} opacity={0.45} />

      {/* Load read-out: four bars, three lit. */}
      <path d={box(46.6, 16.6, 7.6, 3.2, 0.8)} fill={PALETTE.bodyShade} />
      <g>
        <rect x="47.4" y="17.4" width="1.4" height="1.6" rx=".3" fill={PALETTE.amber} />
        <rect x="49.2" y="17.4" width="1.4" height="1.6" rx=".3" fill={PALETTE.amber} />
        <rect x="51" y="17.5" width="1.4" height="1.6" rx=".3" fill={PALETTE.amber} opacity=".8" />
        <rect x="52.8" y="17.5" width="1.4" height="1.6" rx=".3" fill={PALETTE.chrome} opacity=".3" />
      </g>
      <Grille x={46.6} y={22.2} width={8} height={3.4} bars={4} />

      {/* Exo lift harness: lumbar band, hip pivots, thigh struts. */}
      <path d={box(41.2, 24.4, 17.6, 3.4, 1.2)} fill={FILL.metal} opacity=".55" />
      <path d={box(41.2, 24.4, 17.6, 3.4, 1.2)} fill="none" stroke={PALETTE.rimShade} strokeWidth=".7" />
      <g fill={PALETTE.chrome} opacity=".85">
        <circle cx="44" cy="26.1" r=".7" />
        <circle cx="50" cy="26.2" r=".7" />
        <circle cx="56" cy="26.3" r=".7" />
      </g>
      <path d={bone(44.2, 15.2, 41.8, 24.6, 1.5)} fill={PALETTE.rimShade} />
      <path d={bone(41.9, 25.4, 42.4, 33.4, 1.6)} fill={PALETTE.rimShade} />
      <path d={bone(57.8, 25.4, 57.4, 33.6, 1.6)} fill={PALETTE.rimShade} />
      <circle cx="42.1" cy="29.4" r="1.4" fill={FILL.metal} stroke={PALETTE.rimShade} strokeWidth=".5" />
      <circle cx="57.6" cy="29.5" r="1.4" fill={FILL.metal} stroke={PALETTE.rimShade} strokeWidth=".5" />

      <Neck x={51.4} y={12.2} />
      <SensorHead x={46.6} y={6.2} w={10} h={7} />
      <rect x="47.9" y="5.6" width="1.4" height="1.4" rx=".4" fill={PALETTE.rimShade} />
      <ellipse cx="48.6" cy="5.1" rx="1.7" ry="1.3" fill={PALETTE.amber} />
      <ellipse cx="48.6" cy="5.1" rx="1.7" ry="1.3" fill="none" stroke={PALETTE.chrome} strokeWidth=".5" />

      {/* Tote held overhead: flared crate walls, rim lip, ribs, base rail. */}
      <path d={WH_TOTE} fill="currentColor" />
      <path d={WH_TOTE} fill={PALETTE.shadow} opacity=".2" />
      <path d={WH_TOTE} fill={FILL.gloss} opacity=".85" />
      <path d={WH_TOTE} fill="none" stroke={PALETTE.line} strokeWidth=".9" strokeLinejoin="round" />
      <path d="M51.2 1.9 L64.5 2.3 L64.4 3.2 L51.3 2.8 Z" fill={PALETTE.shadow} opacity=".45" />
      <path d="M50.8 1.6 L52.8 0.5 L66.6 0.9 L64.6 2 Z" fill={FILL.metal} opacity=".85" />
      <path
        d="M50.8 1.6 L52.8 0.5 L66.6 0.9 L64.6 2 Z"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".6"
        opacity=".8"
      />
      <g stroke={PALETTE.chrome} strokeWidth=".9" opacity=".5">
        <line x1="54.2" y1="3.2" x2="54.4" y2="7.1" />
        <line x1="57.6" y1="3.3" x2="57.7" y2="7.2" />
        <line x1="61" y1="3.4" x2="61" y2="7.2" />
      </g>
      <path d="M61.6 3.8 L64.1 3.9 L64 5.3 L61.6 5.2 Z" fill={PALETTE.shadow} opacity=".85" />
      <rect x="52.2" y="6.8" width="11.2" height="1.1" rx=".4" fill={PALETTE.rimShade} />

      {/* Near arm pressed up under the tote. */}
      <Joint cx={58.4} cy={16.8} r={3} />
      <Bone x1={58.4} y1={16.6} x2={62.4} y2={11.6} w={3.6} />
      <Joint cx={62.5} cy={11.4} r={2.2} />
      <Bone x1={62.4} y1={11.2} x2={59.8} y2={7.4} w={3.1} />
      <Hand x={59.6} y={6.4} rotate={186} />

      {/* Near leg, planted wide. */}
      <Body d={box(43.8, 26.6, 12.4, 4.6, 1.7)} outline={0.95} />
      <Joint cx={54.6} cy={29.4} r={2.3} />
      <Bone x1={54.6} y1={29.6} x2={56} y2={34.2} w={5} />
      <Joint cx={56} cy={34.4} r={2.2} />
      <Bone x1={56} y1={34.6} x2={56.2} y2={38} w={4} />
      <KneeGuard cx={56.1} cy={34.4} />
      <Joint cx={56.2} cy={38} r={1.5} />
      <Body d={foot(56.2, 37.5, 5, 2.6)} outline={0.9} />
      <path d="M54 40.2 L60.9 40.3" stroke={PALETTE.chrome} strokeWidth=".6" opacity=".65" />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Public safety                                                       */
/* ------------------------------------------------------------------ */

const PS_TORSO =
  "M45.8 15.8 C46 14 47.3 13.2 49 13.2 L54 13.4 " +
  "C55.8 13.6 56.7 14.8 56.6 16.6 L56.1 24.4 " +
  "C56 26.2 55 27.1 53.3 27 L48 26.8 " +
  "C46.3 26.7 45.6 25.7 45.7 23.9 Z";

const PS_BACK =
  "M42.8 16.4 C43 14.6 44 13.8 45.7 13.5 L46 13.4 L45.9 26.9 L45 26.7 " +
  "C43.4 26.4 42.7 25.4 42.8 23.6 Z";

/** Patrol unit: shoulder beacon, chest camera, hi-vis band, arms at its sides. */
export function HumanoidPublicSafety() {
  return (
    <VehicleSvg id={"sidewalk_robot.humanoid_public_safety"}>
      <Ground x={44} width={17} />

      {/* Far arm and far leg, held straight in the parade stance. */}
      <Bone x1={43.6} y1={17.4} x2={42.6} y2={22.8} w={2.9} far />
      <Joint cx={42.6} cy={23} r={1.6} far />
      <Bone x1={42.6} y1={23.2} x2={43} y2={28.8} w={2.5} far />
      <Hand x={43} y={30.2} far />
      <Bone x1={47.6} y1={29.4} x2={47.4} y2={34} w={3.8} far />
      <Joint cx={47.4} cy={34.2} r={1.8} far />
      <Bone x1={47.4} y1={34.4} x2={47.4} y2={37.8} w={3.1} far />
      <Far d={foot(47.4, 37.5, 4.4, 2.2)} />

      <Far d={PS_BACK} />
      <path d="M42.7 19 L46 19.2 L45.9 21.9 L42.7 21.7 Z" fill={HIVIS_SHADE} opacity=".85" />
      <Joint cx={43.6} cy={16.4} r={2.1} far />

      <Body d={PS_TORSO} />
      <Seam d="M53.4 13.6 L52.9 26.6" width={0.7} opacity={0.5} />

      {/* Hi-vis duty band with two reflective lines. */}
      <path d="M45.8 19.1 L56.4 19.6 L56.2 22.5 L45.7 22 Z" fill={HIVIS} />
      <path d="M45.8 19.1 L56.4 19.6 L56.2 22.5 L45.7 22 Z" fill={FILL.gloss} opacity=".4" />
      <g stroke={REFLECT} strokeWidth=".8" opacity=".8">
        <line x1="45.8" y1="19.9" x2="56.35" y2="20.4" />
        <line x1="45.75" y1="21.4" x2="56.25" y2="21.9" />
      </g>
      <path
        d="M45.8 19.1 L56.4 19.6 L56.2 22.5 L45.7 22 Z"
        fill="none"
        stroke={HIVIS_SHADE}
        strokeWidth=".55"
      />

      {/* Chest camera and its record light. */}
      <circle cx="52.2" cy="16.4" r="2.2" fill={PALETTE.bodyShade} />
      <circle cx="52.2" cy="16.4" r="2.2" fill="none" stroke={PALETTE.chrome} strokeWidth=".7" />
      <circle cx="52.2" cy="16.4" r="1.1" fill={PALETTE.glass} />
      <circle cx="51.7" cy="15.9" r=".5" fill="#f2f8ff" opacity=".9" />
      <circle cx="48.4" cy="16.2" r=".8" fill={PALETTE.beaconRed} opacity=".9" />
      <path d={box(47.2, 23.6, 7.6, 2.6, 0.8)} fill={PALETTE.bodyShade} />
      <rect x="48" y="24.4" width="4.4" height="1" rx=".4" fill={PALETTE.beaconBlue} opacity=".85" />

      <Neck x={50.6} y={12.2} />
      <SensorHead x={46} y={5} w={10.2} h={7.4} />

      {/* Comm mast, then the blue beacon clear above the shoulder cap. */}
      <path d={bone(46.6, 5.2, 44.8, 1.6, 1)} fill={PALETTE.rimShade} />
      <circle cx="44.7" cy="1.4" r=".9" fill={PALETTE.amber} />
      <Body d={PAULDRON} outline={0.85} />
      <circle cx="60.2" cy="10.4" r="3.7" fill={PALETTE.beaconBlue} opacity=".16" />
      <rect x="59.1" y="11.4" width="2.2" height="4.2" rx=".7" fill={PALETTE.rimShade} />
      <ellipse cx="60.2" cy="10.3" rx="2.5" ry="1.9" fill={PALETTE.beaconBlue} />
      <ellipse cx="60.2" cy="10.3" rx="2.5" ry="1.9" fill="none" stroke={PALETTE.chrome} strokeWidth=".55" />
      <ellipse cx="59.5" cy="9.7" rx="1" ry=".7" fill="#dbe9ff" opacity=".85" />

      {/* Near arm at the side. */}
      <Joint cx={58.2} cy={18.4} r={2.4} />
      <Bone x1={58.2} y1={18.6} x2={58.9} y2={24.2} w={3.3} />
      <Joint cx={58.9} cy={24.4} r={1.9} />
      <Bone x1={58.9} y1={24.6} x2={58.6} y2={30.2} w={2.8} />
      <Hand x={58.6} y={31.5} />

      {/* Duty belt, pouches, then the near leg. */}
      <Body d={box(45.6, 26.2, 11.4, 4.6, 1.7)} outline={0.95} />
      <path d={box(45.4, 26.4, 11.8, 2.6, 0.9)} fill={PALETTE.bodyShade} />
      <rect x="50.4" y="27" width="2.4" height="1.5" rx=".4" fill={PALETTE.chrome} opacity=".8" />
      <Body d={box(56.2, 27.4, 2.6, 3.6, 0.8)} outline={0.7} />
      <Far d={box(44.2, 27.2, 2.2, 3.2, 0.8)} />
      <Joint cx={53.8} cy={29.6} r={2.2} />
      <Bone x1={53.8} y1={29.8} x2={54.2} y2={34.2} w={4.3} />
      <Joint cx={54.2} cy={34.4} r={2.1} />
      <Bone x1={54.2} y1={34.6} x2={54.4} y2={38} w={3.5} />
      <Joint cx={54.4} cy={38} r={1.4} />
      <Body d={foot(54.4, 37.5, 4.8, 2.4)} outline={0.9} />
      <path d="M52.4 40.2 L58.9 40.3" stroke={PALETTE.chrome} strokeWidth=".6" opacity=".65" />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Construction                                                        */
/* ------------------------------------------------------------------ */

const CN_TORSO =
  "M45 16.4 C45.2 14.4 46.7 13.5 48.7 13.5 L54.6 13.8 " +
  "C56.6 14 57.4 15.3 57.2 17.2 L56.5 24.6 " +
  "C56.3 26.5 55.2 27.4 53.3 27.3 L47.4 27 " +
  "C45.6 26.9 44.8 25.9 44.9 24 Z";

const CN_BACK =
  "M41.7 17 C41.9 15 43.1 14 45 13.7 L45.2 13.6 L45.1 27.1 L44.1 26.9 " +
  "C42.5 26.6 41.7 25.6 41.8 23.6 Z";

/** Hi-vis vest, open at the throat so the chassis still reads through it. */
const CN_VEST =
  "M46 14.7 L49.6 13.9 L51.8 17.6 L54.2 14.1 L56.9 14.8 " +
  "C57.6 17.2 57.2 22.6 56.4 26.5 L47 26.1 " +
  "C45.9 22.4 45.4 17.1 46 14.7 Z";

/** Hard hat crown, and the brim it wears over the sensor visor. */
const CN_HAT = "M44.4 7 C44.8 2.9 47.6 1 50.9 1.1 C54.5 1.3 56.7 3.4 56.9 7.1 Z";

const CN_BRIM =
  "M43.4 6.5 L58.6 6.9 C59.9 7 60 8.2 58.7 8.4 L43.2 8 C42.1 7.9 42.2 6.6 43.4 6.5 Z";

/** Site unit: hard hat, hi-vis vest, tool belt, driver in the gripper. */
export function HumanoidConstruction() {
  return (
    <VehicleSvg id={"sidewalk_robot.humanoid_construction"}>
      <Ground x={38} width={26} />

      {/* Rear leg, straight and braced. */}
      <Bone x1={46.4} y1={29.2} x2={44.4} y2={34} w={4.1} far />
      <Joint cx={44.4} cy={34.2} r={1.9} far />
      <Bone x1={44.4} y1={34.4} x2={43.4} y2={37.9} w={3.3} far />
      <Far d={foot(43.4, 37.5, 4.6, 2.4)} />

      {/* Far arm, hanging clear of the tool. */}
      <Bone x1={42.4} y1={17.6} x2={41.4} y2={23} w={2.9} far />
      <Joint cx={41.4} cy={23.2} r={1.6} far />
      <Bone x1={41.4} y1={23.4} x2={42.2} y2={28.8} w={2.5} far />
      <Hand x={42.2} y={30.2} rotate={-6} far />

      <Far d={CN_BACK} />
      <path d="M41.8 18.6 L45.2 18.8 L45.1 20.6 L41.8 20.4 Z" fill={HIVIS_SHADE} opacity=".8" />
      <Joint cx={42.6} cy={16.8} r={2.2} far />

      <Body d={CN_TORSO} />
      <Seam d="M53.7 13.9 L53.1 27" width={0.7} opacity={0.5} />

      {/* Vest: shell, shoulder strap, two reflective bands. */}
      <path d={CN_VEST} fill={HIVIS} />
      <path d={CN_VEST} fill={FILL.gloss} opacity=".38" />
      <path d={CN_VEST} fill="none" stroke={HIVIS_SHADE} strokeWidth=".65" strokeLinejoin="round" />
      <path d="M46 18.5 L57.1 19 L57 20.4 L45.9 19.9 Z" fill={REFLECT} opacity=".85" />
      <path d="M46.3 21.9 L56.9 22.4 L56.8 23.8 L46.2 23.3 Z" fill={REFLECT} opacity=".8" />
      <path d="M49.4 14.1 L50.7 13.8 L52.2 17.3 L51.1 17.9 Z" fill={REFLECT} opacity=".7" />
      <path d="M54.3 14.2 L55.5 14.5 L54.2 17.4 L53.2 17 Z" fill={REFLECT} opacity=".65" />
      <circle cx="47.6" cy="17.2" r=".9" fill={PALETTE.lamp} opacity=".9" />

      <Neck x={50.8} y={13} />
      <SensorHead x={46} y={6.9} w={10.2} h={6.8} />

      {/* Hard hat: crown shell, ridge, and a brim clear of the visor. */}
      <path d={CN_HAT} fill={HAT} />
      <path d={CN_HAT} fill={FILL.gloss} opacity=".5" />
      <path d={CN_HAT} fill="none" stroke={HAT_SHADE} strokeWidth=".7" strokeLinejoin="round" />
      <path d="M50.7 1.2 C50.3 3 50.2 5.2 50.4 7" stroke={HAT_SHADE} strokeWidth=".7" opacity=".8" />
      <path d={CN_BRIM} fill={HAT} />
      <path d={CN_BRIM} fill={FILL.gloss} opacity=".3" />
      <path d={CN_BRIM} fill="none" stroke={HAT_SHADE} strokeWidth=".6" strokeLinejoin="round" />

      {/* Tool belt with pouches and a hammer on the far hip. */}
      <Body d={box(44.8, 26.2, 12.2, 4.6, 1.7)} outline={0.95} />
      <path d={box(44.6, 26.1, 12.6, 2.8, 0.9)} fill={PALETTE.bodyShade} />
      <rect x="50" y="26.8" width="2.6" height="1.6" rx=".4" fill={PALETTE.chrome} opacity=".85" />
      <Body d={box(56, 26.9, 3.2, 4.4, 0.9)} outline={0.7} />
      <path d="M55.9 26.9 L59.3 27.1 L59.2 28.4 L55.9 28.2 Z" fill={PALETTE.bodyShade} />
      <Far d={box(43.4, 26.8, 2.6, 3.9, 0.8)} />
      <path d={bone(44.4, 30.4, 43.6, 34.4, 1.3)} fill={PALETTE.rimShade} />
      <path d={box(42.8, 29.2, 2.8, 1.7, 0.4)} fill={FILL.metal} />

      {/* Near arm, driver held muzzle-down at the work. */}
      <Joint cx={57.6} cy={17.4} r={2.5} />
      <Bone x1={57.6} y1={17.8} x2={59.6} y2={22} w={3.4} />
      <Joint cx={59.7} cy={22.2} r={1.9} />
      <Bone x1={59.6} y1={22.4} x2={60.6} y2={26.4} w={2.9} />
      <path d={box(59.2, 24.4, 4.6, 3.6, 1)} fill={PALETTE.bodyShade} />
      <path d={box(59.2, 24.4, 4.6, 3.6, 1)} fill="none" stroke={PALETTE.line} strokeWidth=".7" />
      <path d={bone(63.6, 25.7, 67.4, 25.4, 2.2)} fill={FILL.metal} />
      <path d={bone(67.2, 25.5, 69.8, 25.4, 0.9)} fill={PALETTE.chrome} />
      <path d={box(58.7, 28.1, 4.2, 2.7, 0.8)} fill={PALETTE.bodyShade} />
      <rect x="59.4" y="29" width="2.6" height=".9" rx=".3" fill={PALETTE.amber} opacity=".9" />
      <path d={bone(60.6, 26.2, 60.2, 28.6, 2.6)} fill={PALETTE.rimShade} />
      <Hand x={60.8} y={27.4} rotate={12} />

      {/* Forward leg, weight on it. */}
      <Joint cx={54.4} cy={29.6} r={2.2} />
      <Bone x1={54.4} y1={29.8} x2={56} y2={34} w={4.4} />
      <Joint cx={56} cy={34.2} r={2.1} />
      <Bone x1={56} y1={34.4} x2={56.6} y2={38} w={3.6} />
      <Joint cx={56.6} cy={38} r={1.4} />
      <Body d={foot(56.6, 37.5, 5, 2.4)} outline={0.9} />
      <path d="M54.6 40.2 L61.3 40.3" stroke={PALETTE.chrome} strokeWidth=".6" opacity=".65" />
    </VehicleSvg>
  );
}
