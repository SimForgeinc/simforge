"use client";

import {
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
} from "../vehicle-art/parts";

/**
 * Sidewalk robots: delivery rover, cooler bot, quadruped courier.
 *
 * All three are machines rather than bodywork, so the read is carried by
 * structure — how many contact points there are, where the mass sits, and what
 * the thing is looking at:
 *
 *   - the rover is long and low on six small wheels, mass in a rounded cargo
 *     lid, eyes on a short mast that stands clear above the roofline;
 *   - the cooler bot is a tall upright insulated box on four chunky tyres,
 *     mass squared off under a thick overhanging lid, eyes in a dome sitting
 *     flat on that lid — no mast at all;
 *   - the courier has no wheels: four articulated legs, two visible joints
 *     each, caught mid-trot with the near pair extended and the far pair
 *     tucked under the body.
 *
 * Contact line is the fleet's `AXLE + 5.9`, so tyres and foot pads land where
 * every vehicle tyre lands. Panel lines, joints and sensors are the only
 * detail small enough to survive a 50x32 tile; anything thinner is dropped.
 */

/** Where every tyre and foot pad in this file meets the pavement. */
const CONTACT = AXLE + 5.9;

/** Far-side limbs sink a tone so the near side keeps the silhouette. */
const FAR = PALETTE.glass;

/** A straight strut of width `w` as a filled quad — structure, not strokes. */
function tube(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const nx = (-dy / length) * (w / 2);
  const ny = (dx / length) * (w / 2);
  return `M${x1 + nx} ${y1 + ny} L${x2 + nx} ${y2 + ny} L${x2 - nx} ${y2 - ny} L${x1 - nx} ${y1 - ny} Z`;
}

/** A tapered limb segment: thick at the joint it hangs from, thin at the next. */
function bone(x1: number, y1: number, x2: number, y2: number, w1: number, w2: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const ux = -dy / length;
  const uy = dx / length;
  return (
    `M${x1 + ux * (w1 / 2)} ${y1 + uy * (w1 / 2)} ` +
    `L${x2 + ux * (w2 / 2)} ${y2 + uy * (w2 / 2)} ` +
    `L${x2 - ux * (w2 / 2)} ${y2 - uy * (w2 / 2)} ` +
    `L${x1 - ux * (w1 / 2)} ${y1 - uy * (w1 / 2)} Z`
  );
}

/** Actuator at a limb joint: metal barrel, dark bore, lit edge. */
function Joint({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill={FILL.metal} stroke={PALETTE.line} strokeWidth=".6" />
      <circle cx={cx} cy={cy} r={r * 0.36} fill={PALETTE.bodyShade} />
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Delivery rover                                                      */
/* ------------------------------------------------------------------ */

const ROVER_R = 4;
const ROVER_AXLE = CONTACT - ROVER_R;
const ROVER_FAR_R = 3.5;
const ROVER_FAR_AXLE = CONTACT - ROVER_FAR_R;
const ROVER_NEAR_WHEELS = [25.8, 44.6, 63.4];
const ROVER_FAR_WHEELS = [30.4, 49.2, 68];

/** Low chassis tub the whole drivetrain hangs off. */
const ROVER_CHASSIS =
  "M20.6 27.4 L72 26.8 C75 26.8 77 28.6 77 31 " +
  "L76.6 33.8 C76.5 35.1 75.6 35.8 74.2 35.9 L22.4 36.2 " +
  "C20.9 36.2 20.1 35.1 20.1 33.6 Z";

/** Cargo lid: crowned, hinged at the rear, its rear wall dropping vertically. */
const ROVER_LID =
  "M23.9 27.2 L23.6 22.6 C23.6 18.7 27.3 15.4 32.8 14.6 " +
  "C43.2 13.1 56 13 65.2 14.6 C69.8 15.4 72.1 18.5 72.3 22.3 L72.7 27 Z";

/** Rubber nose bumper wrapped round the front of the chassis. */
const ROVER_BUMPER =
  "M73.8 30.2 L75.6 30.2 C77.2 30.5 77.9 31.7 77.9 32.7 " +
  "L77.7 34 C77.6 35.1 76.6 35.5 75.4 35.5 L73.8 35.5 Z";

/** Lidar puck: a squat cylinder read side-on, window band across the middle. */
const ROVER_PUCK =
  "M54.9 6 C54.9 4.8 55.7 4.1 57.1 4.1 L64.6 4 C66 4 66.8 4.8 66.8 6 " +
  "L66.8 8.8 C66.8 9.8 66 10.4 64.6 10.4 L57.1 10.5 " +
  "C55.7 10.5 54.9 9.8 54.9 8.6 Z";

/** Camera cluster bolted to the front face of the mast. */
const ROVER_CAMERAS =
  "M63 10.6 L69.4 10.4 C70.4 10.4 71 11 71 12 L71 14.6 " +
  "C71 15.6 70.4 16.2 69.4 16.2 L63.2 16.4 C62.2 16.4 61.6 15.8 61.6 14.8 " +
  "L61.6 11.8 C61.6 11 62 10.6 63 10.6 Z";

/** Six-wheel pavement rover: hinged cargo lid, sensor mast, rocker bogies. */
export function DeliveryRover() {
  return (
    <VehicleSvg id={"sidewalk_robot.delivery_rover"}>
      <Ground x={16} width={66} />

      {/* Far wheel row, sunk behind the chassis: this is a six-wheeler. */}
      {ROVER_FAR_WHEELS.map((cx) => (
        <circle key={cx} cx={cx} cy={ROVER_FAR_AXLE} r={ROVER_FAR_R} fill={PALETTE.tire} opacity=".62" />
      ))}
      {ROVER_FAR_WHEELS.map((cx) => (
        <circle key={cx} cx={cx} cy={ROVER_FAR_AXLE} r={ROVER_FAR_R * 0.42} fill={PALETTE.rimShade} opacity=".5" />
      ))}

      <Body d={ROVER_CHASSIS} />
      <Body d={ROVER_LID} />

      {/* Lid parting line: dark gasket, lit lip above it. */}
      <rect x="24.6" y="26.4" width="47.4" height="1.2" rx=".6" fill={PALETTE.bodyShade} opacity=".9" />
      <Seam d="M25 26.6 L71.6 26.2" width={0.7} opacity={0.5} />

      {/* Rear hinge: barrel and knuckles, the cue that the lid actually opens. */}
      <rect x="24.4" y="21.4" width="5.6" height="2.3" rx="1.15" fill={FILL.metal} />
      <circle cx="25.9" cy="22.55" r=".85" fill={PALETTE.bodyShade} />
      <circle cx="28.5" cy="22.55" r=".85" fill={PALETTE.bodyShade} />
      <Seam d="M26.6 19.8 L26.2 21.4" width={0.7} opacity={0.6} />

      {/* Front latch clasped over the gasket. */}
      <path
        d="M68.2 23.6 L72 23.4 L72.3 27.9 L68.4 28.1 Z"
        fill={FILL.metal}
        stroke={PALETTE.line}
        strokeWidth=".7"
      />
      <path d="M69.2 25.8 L71.3 25.7" stroke={PALETTE.bodyShade} strokeWidth=".9" />

      {/* Lid ribs and chassis panel splits. */}
      <Seam d="M30.4 19.8 C42 17.9 57 17.8 67 19.4" width={0.75} opacity={0.55} />
      <Seam d="M27.6 23.4 C40 21.9 57 21.8 69.2 23" width={0.65} opacity={0.4} />
      <Seam d="M23.2 31.6 L44 31.4" width={0.8} opacity={0.6} />
      <Seam d="M46.8 31.3 L74.4 30.9" width={0.8} opacity={0.6} />
      <Seam d="M45.4 27.2 L45.2 36.1" width={0.8} opacity={0.5} />
      <Grille x={52.6} y={28.4} width={8.4} height={5.6} bars={3} />
      <Body d={ROVER_BUMPER} outline={0.8} />

      {/* Side reflectors along the flank. */}
      <rect x="29.4" y="32.7" width="4.6" height="1.7" rx=".85" fill={PALETTE.amber} opacity=".9" />
      <rect x="36.6" y="32.7" width="4.6" height="1.7" rx=".85" fill={PALETTE.amber} opacity=".9" />
      <rect x="66.4" y="32.5" width="4" height="1.7" rx=".85" fill="#fff" opacity=".4" />
      <Lamps front={72.6} frontY={28.4} rear={20.7} rearY={28.6} size={2.5} />

      {/* Sensor mast: short, standing clear of the lid, puck on top. */}
      <rect x="56.8" y="12.8" width="7.4" height="2.2" rx="1.1" fill={PALETTE.bodyShade} />
      <Body d={tube(60, 14.4, 60.8, 8.6, 3)} outline={0.85} />
      <Body d={ROVER_PUCK} outline={0.9} />
      <Glass d="M55.7 6.4 L66 6.3 L66 8.5 L55.7 8.6 Z" />
      <path d="M56.2 5.2 L65.4 5.1" stroke={PALETTE.chrome} strokeWidth=".8" opacity=".55" />
      <circle cx="65.2" cy="7.5" r=".95" fill={PALETTE.line} opacity=".9" />
      <Body d={ROVER_CAMERAS} outline={0.9} />
      <circle cx="69" cy="12.6" r="1.45" fill={FILL.glass} stroke={PALETTE.chrome} strokeWidth=".6" />
      <circle cx="68.6" cy="12.1" r=".45" fill="#fff" opacity=".7" />
      <circle cx="69" cy="14.8" r="1.05" fill={FILL.glass} stroke={PALETTE.chrome} strokeWidth=".55" />
      <Seam d="M63.2 11.4 L63 15.4" width={0.65} opacity={0.5} />

      {/* Safety whip and pennant, rear of the lid where it clears the mast. */}
      <path
        d="M28.4 14.8 C26.8 10.4 27.4 5.8 30.2 2.6"
        fill="none"
        stroke={PALETTE.chrome}
        strokeWidth=".9"
        strokeLinecap="round"
      />
      <circle cx="28.6" cy="15.2" r="1.1" fill={PALETTE.rimShade} />
      <path d="M30.1 2.6 L38.2 4.7 L30.5 7.4 Z" fill={PALETTE.amber} />
      <path d="M30.6 3.6 L36 5 L30.8 6.4 Z" fill="#fff" opacity=".2" />

      {/* Rocker-bogie linkage carries the six wheels; drawn under them. */}
      <g stroke={PALETTE.rimShade} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d={`M25.8 ${ROVER_AXLE} L34.6 34.4 L44.6 ${ROVER_AXLE}`} />
        <path d={`M52.6 34.2 L63.4 ${ROVER_AXLE}`} />
        <path d="M34.6 34.4 L52.6 34.2" />
      </g>
      <circle cx="34.6" cy="34.4" r="1.5" fill={FILL.metal} stroke={PALETTE.line} strokeWidth=".5" />
      <circle cx="52.6" cy="34.2" r="1.5" fill={FILL.metal} stroke={PALETTE.line} strokeWidth=".5" />

      {ROVER_NEAR_WHEELS.map((cx) => (
        <Wheel key={cx} cx={cx} cy={ROVER_AXLE} r={ROVER_R} spokes={false} />
      ))}
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Cooler bot                                                          */
/* ------------------------------------------------------------------ */

const COOLER_R = 4.8;
const COOLER_AXLE = CONTACT - COOLER_R;
const COOLER_FAR_R = 4.3;
const COOLER_FAR_AXLE = CONTACT - COOLER_FAR_R;

/** Insulated box, walls flaring very slightly toward the base. */
const COOLER_BOX =
  "M27.6 18.6 C27.6 16.2 29.2 14.8 31.8 14.8 L68 14.6 " +
  "C70.8 14.6 72.4 16.2 72.6 18.8 L73 32.4 " +
  "C73.1 34 72 34.9 70.2 34.9 L29.8 35.1 C28.2 35.1 27.2 34.2 27.2 32.6 Z";

/** Thick lid, overhanging both ends the way a cool box lid does. */
const COOLER_LID =
  "M25.6 12.4 C25.6 10 27.2 8.8 29.6 8.8 L70.4 8.6 " +
  "C72.8 8.6 74.4 9.8 74.4 12.2 L74.6 15.7 L25.7 15.9 Z";

/** Sensor dome, sitting flat on the lid — no mast on this one. */
const COOLER_DOME = "M43 8.7 C43 4.5 46.3 2.3 50 2.3 C53.8 2.3 57.1 4.7 57.1 8.7 Z";

/** Hazard chevron slugs along the base, leaning the way the bot travels. */
const COOLER_CHEVRONS = [28.6, 34.2, 39.8, 45.4, 51];

/** Four-wheel insulated cooler: latched lid, vent grille, hazard skirt. */
export function CoolerBot() {
  return (
    <VehicleSvg id={"sidewalk_robot.cooler_bot"}>
      <Ground x={24} width={52} />

      {/* Far axle pair, sunk: four chunky tyres, not six small ones. */}
      <circle cx="38.6" cy={COOLER_FAR_AXLE} r={COOLER_FAR_R} fill={PALETTE.tire} opacity=".55" />
      <circle cx="67.8" cy={COOLER_FAR_AXLE} r={COOLER_FAR_R} fill={PALETTE.tire} opacity=".55" />

      <Body d={COOLER_BOX} />
      <Body d={COOLER_LID} />

      {/* Lid gasket: the thick seam that says insulated, not just a box. */}
      <rect x="25.9" y="15.2" width="48.5" height="1.5" rx=".75" fill={PALETTE.bodyShade} />
      <Seam d="M27.4 12.2 L72.8 12" width={0.8} opacity={0.5} />
      <Seam d="M27 15.5 L73.2 15.3" width={0.7} opacity={0.45} />

      {/* Lid hinge at the rear, latch at the front: it opens like a cool box. */}
      <rect x="26.2" y="9.6" width="4.8" height="2" rx="1" fill={FILL.metal} />
      <circle cx="27.6" cy="10.6" r=".7" fill={PALETTE.bodyShade} />
      <circle cx="29.7" cy="10.6" r=".7" fill={PALETTE.bodyShade} />
      <path
        d="M69.8 13.2 L74.4 13 L74.6 19.6 L70 19.8 Z"
        fill={FILL.metal}
        stroke={PALETTE.line}
        strokeWidth=".7"
      />
      <circle cx="72.2" cy="16.4" r=".95" fill={PALETTE.bodyShade} />
      <path d="M70.8 18.4 L73.6 18.3" stroke={PALETTE.bodyShade} strokeWidth=".8" />

      {/* Handle recess, sunk into the near wall with a grab bar inside. */}
      <rect x="32.8" y="19.2" width="14.6" height="4.8" rx="2.4" fill={PALETTE.bodyShade} />
      <rect x="34.2" y="20.4" width="11.8" height="1.7" rx=".85" fill={FILL.metal} />
      <Seam d="M34 23.2 L46.2 23.1" width={0.6} opacity={0.4} />

      {/* Compressor vent, rubbing strake and insulation panel splits. */}
      <Grille x={60} y={24.2} width={9.6} height={7.4} bars={4} />
      <Seam d="M52.4 17 L52.2 31.6" width={0.8} opacity={0.5} />
      <Seam d="M29.4 27.4 L49.6 27.2" width={0.8} opacity={0.55} />
      <rect x="26.8" y="28.4" width="46.4" height="2.2" rx="1.1" fill={PALETTE.bodyShade} opacity=".8" />
      <circle cx="31.4" cy="24.6" r="1.5" fill={PALETTE.bodyShade} />
      <circle cx="31.4" cy="24.6" r=".7" fill={PALETTE.chrome} opacity=".8" />
      <Seam d="M29.8 31.9 L29.8 34.4" width={0.7} opacity={0.35} />

      {/* Hazard chevrons on the skirt. */}
      <rect x="28.2" y="31.4" width="29.2" height="3.3" fill={PALETTE.bodyShade} />
      {COOLER_CHEVRONS.map((x) => (
        <path key={x} d={`M${x} 34.7 L${x + 2.9} 31.4 L${x + 5.5} 31.4 L${x + 2.6} 34.7 Z`} fill={PALETTE.amber} />
      ))}

      {/* Dome sensor and its collar, flat on the lid. */}
      <rect x="42.2" y="8.2" width="15.6" height="1.7" rx=".85" fill={PALETTE.bodyShade} />
      <Body d={COOLER_DOME} outline={0.9} />
      <Glass d="M44.6 8.3 C44.7 5.5 47.1 3.8 50 3.8 C53 3.8 55.4 5.6 55.5 8.3 Z" />
      <path
        d="M46.2 7.4 C46.6 5.6 48 4.7 49.6 4.7"
        fill="none"
        stroke="#fff"
        strokeWidth=".9"
        opacity=".35"
        strokeLinecap="round"
      />
      <circle cx="55.8" cy="10.6" r="1" fill={PALETTE.beaconBlue} />

      {/* Stub antenna: a nub, so it never reads as the rover's mast. */}
      <path d="M33.4 8.7 L33 4.2" stroke={PALETTE.chrome} strokeWidth=".9" strokeLinecap="round" />
      <circle cx="33" cy="3.7" r="1" fill={PALETTE.rimShade} />

      <Lamps front={70.2} frontY={20.6} rear={27.9} rearY={20.8} size={2.8} />

      {/* Mudguard lips, then the tyres on top of them. */}
      <path
        d="M28 34.6 a6.4 6.4 0 0 1 12.8 0"
        fill="none"
        stroke={PALETTE.bodyShade}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path
        d="M57.2 34.6 a6.4 6.4 0 0 1 12.8 0"
        fill="none"
        stroke={PALETTE.bodyShade}
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <Wheel cx={34.4} cy={COOLER_AXLE} r={COOLER_R} />
      <Wheel cx={63.6} cy={COOLER_AXLE} r={COOLER_R} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Quadruped courier                                                   */
/* ------------------------------------------------------------------ */

/** Body pod: the trunk the four legs hang off, held well clear of the ground. */
const DOG_POD =
  "M32.4 22 C32.4 19 34.4 17.4 37.4 17.4 L65 17.2 " +
  "C68.4 17.2 70.6 19.2 70.8 22.4 L70.6 25.6 " +
  "C70.6 27.8 69 29 66.4 29 L36.4 29.2 C33.8 29.2 32.2 27.8 32.2 25.2 Z";

/** Sensor head on a short forward neck. */
const DOG_HEAD =
  "M72.4 12.8 C72.4 11.4 73.4 10.6 74.8 10.6 L81.4 10.6 " +
  "C82.8 10.6 83.6 11.6 83.6 13 L83.6 18.4 " +
  "C83.6 19.8 82.6 20.6 81 20.6 L74.2 20.6 C72.8 20.6 72.2 19.6 72.2 18.2 Z";

/** Lidar cylinder on the crown of the head. */
const DOG_LIDAR =
  "M74.2 7.2 C74.2 6 75 5.4 76.2 5.4 L81.4 5.4 C82.6 5.4 83.4 6.2 83.4 7.4 " +
  "L83.4 9.4 C83.4 10.3 82.6 10.8 81.4 10.8 L76 10.8 " +
  "C74.8 10.8 74.2 10.2 74.2 9.3 Z";

/** Strapped-down payload crate riding on the pod. */
const DOG_CRATE =
  "M37.4 9.6 C37.4 8.5 38.2 7.9 39.4 7.9 L57.6 7.7 " +
  "C58.9 7.7 59.7 8.4 59.7 9.6 L59.9 17.7 L37.3 17.9 Z";

/**
 * Near pair, extended: hind leg trailing in push-off, front leg reaching. The
 * far pair below is the opposite phase, tucked under the pod, so the stance
 * reads as a trot rather than a four-legged trestle.
 */
const DOG_NEAR_LEGS = [
  bone(37.6, 27.2, 32.2, 32.2, 4.4, 3.1),
  bone(32.2, 32.2, 30.4, 37.6, 3.1, 2.5),
  bone(30.4, 37.6, 26.6, 41.9, 2.5, 2.1),
  bone(64.4, 27, 70.4, 33.2, 4.4, 3.1),
  bone(70.4, 33.2, 69.8, 38.4, 3.1, 2.5),
  bone(69.8, 38.4, 73.4, 41.9, 2.5, 2.1),
];

/** Only the thigh and shin take the gloss; the short pastern stays flat. */
const DOG_NEAR_LIT = [DOG_NEAR_LEGS[0], DOG_NEAR_LEGS[1], DOG_NEAR_LEGS[3], DOG_NEAR_LEGS[4]];

const DOG_FAR_LEGS = [
  bone(41, 27, 43.8, 32.8, 3.6, 2.6),
  bone(43.8, 32.8, 41.2, 37.8, 2.6, 2.1),
  bone(41.2, 37.8, 43.8, 41.9, 2.1, 1.8),
  bone(61, 27, 58.4, 32.8, 3.6, 2.6),
  bone(58.4, 32.8, 60.8, 37.8, 2.6, 2.1),
  bone(60.8, 37.8, 58.2, 41.9, 2.1, 1.8),
];

/** One foot pad, flat on the pavement. */
function Paw({ cx }: { cx: number }) {
  return (
    <g>
      <rect x={cx - 2.7} y={40.8} width="5.4" height="2.2" rx="1" fill={PALETTE.tire} />
      <rect x={cx - 2.1} y={41.1} width="4.2" height=".7" rx=".35" fill={PALETTE.tireWall} />
    </g>
  );
}

/** Legged courier mid-trot: near legs extended, far legs tucked under. */
export function QuadrupedCourier() {
  return (
    <VehicleSvg id={"sidewalk_robot.quadruped_courier"}>
      <Ground x={26} width={50} />

      {/* Far pair first, sunk, so the near legs read in front of them. */}
      <g fill={FAR} opacity=".92">
        {DOG_FAR_LEGS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g fill={PALETTE.rimShade} opacity=".7">
        <circle cx="43.8" cy="32.8" r="1.5" />
        <circle cx="41.2" cy="37.8" r="1.2" />
        <circle cx="58.4" cy="32.8" r="1.5" />
        <circle cx="60.8" cy="37.8" r="1.2" />
      </g>
      <g opacity=".55">
        <Paw cx={43.8} />
        <Paw cx={58.2} />
      </g>

      <Body d={DOG_POD} />

      {/* Underslung battery pack. */}
      <rect x="43.6" y="28.4" width="17" height="3.4" rx="1.5" fill={PALETTE.bodyShade} />
      <Grille x={45.4} y={28.9} width={13.4} height={2.6} bars={2} />

      {/* Shell splits and a rear-facing camera in the tail plate. */}
      <Seam d="M35.6 20.9 L48 20.5" width={0.8} opacity={0.6} />
      <Seam d="M50.2 20.5 L66.4 20.7" width={0.8} opacity={0.6} />
      <Seam d="M55 17.6 L54.8 28.9" width={0.75} opacity={0.4} />
      <Glass d="M31.7 22.6 L33.8 22.4 L34 25.4 L31.9 25.6 Z" />
      <circle cx="34.9" cy="21.4" r="1.1" fill={PALETTE.beaconBlue} />

      {/* Cable runs clipped along the flank. */}
      <path
        d="M40.4 25.8 C46.4 24.5 54.4 24.3 62.8 25.6"
        fill="none"
        stroke={PALETTE.seam}
        strokeWidth=".9"
        opacity=".85"
        strokeLinecap="round"
      />
      <path
        d="M40.6 27.3 C46.6 26.1 54.4 25.9 62.6 27.1"
        fill="none"
        stroke={PALETTE.rimShade}
        strokeWidth=".8"
        opacity=".7"
        strokeLinecap="round"
      />
      <g fill={PALETTE.chrome} opacity=".8">
        <circle cx="45.4" cy="25" r=".8" />
        <circle cx="52.4" cy="24.6" r=".8" />
        <circle cx="59.4" cy="25.2" r=".8" />
      </g>

      {/* Payload crate, corner-reinforced and strapped down over the pod. */}
      <Body d={DOG_CRATE} outline={0.95} />
      <Seam d="M38.4 11.4 L58.8 11.2" width={0.8} opacity={0.6} />
      <Seam d="M48.6 11.6 L48.6 17.6" width={0.7} opacity={0.4} />
      <path
        d="M37.6 9.4 L37.6 12.4 M59.6 9.2 L59.6 12.2"
        stroke={PALETTE.bodyShade}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <g fill={PALETTE.bodyShade} opacity=".85">
        <rect x="41.8" y="7.4" width="1.9" height="14.4" rx=".5" />
        <rect x="53.4" y="7.3" width="1.9" height="14.3" rx=".5" />
      </g>
      <g stroke="#fff" strokeWidth=".5" opacity=".22">
        <path d="M42 7.6 L42 21.4" />
        <path d="M53.6 7.5 L53.6 21.3" />
      </g>
      <rect x="41.2" y="19.4" width="3.1" height="2.1" rx=".6" fill={FILL.metal} />
      <rect x="52.8" y="19.3" width="3.1" height="2.1" rx=".6" fill={FILL.metal} />

      {/* Neck, head, lidar crown. */}
      <Body d={tube(68.2, 20.6, 74.6, 17.6, 4.2)} outline={0.9} />
      <Body d={DOG_HEAD} outline={0.95} />
      <Glass d="M78.8 12.6 L83.2 12.8 L83.4 18 L79 18.2 Z" />
      <Seam d="M74 13.4 L77.8 13.2" width={0.7} opacity={0.5} />
      <Seam d="M74 16.6 L77.6 16.4" width={0.7} opacity={0.5} />
      <Body d={DOG_LIDAR} outline={0.85} />
      <Glass d="M75 7.4 L82.6 7.4 L82.6 9.1 L75 9.1 Z" />
      <circle cx="82" cy="8.2" r=".85" fill={PALETTE.line} opacity=".9" />

      {/* Hip actuators: the joints the near legs swing from. */}
      <Joint cx={37.6} cy={27.2} r={3.2} />
      <Joint cx={64.4} cy={27} r={3.2} />

      {/* Near legs last: they are this robot's contact points. */}
      <g fill="currentColor">
        {DOG_NEAR_LEGS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <g fill={FILL.gloss}>
        {DOG_NEAR_LIT.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <Joint cx={32.2} cy={32.2} r={2} />
      <Joint cx={30.4} cy={37.6} r={1.6} />
      <Joint cx={70.4} cy={33.2} r={2} />
      <Joint cx={69.8} cy={38.4} r={1.6} />
      <Paw cx={26.6} />
      <Paw cx={73.4} />
    </VehicleSvg>
  );
}
