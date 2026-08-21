"use client";

import {
  Body,
  FILL,
  Ground,
  PALETTE,
  Seam,
  VehicleSvg,
} from "../vehicle-art/parts";
import {
  CONCRETE,
  HIVIS,
  Limb,
  ORANGE,
  ORANGE_DEEP,
  REFLECT,
  STOP_RED,
  Sandbag,
  StripedRail,
  strut,
} from "./work-zone-parts";

/**
 * Cones, drums, barriers and the signs that close a lane.
 *
 * Structure in `currentColor`, markings hardcoded: traffic control is
 * identified by its paint. Shared tones and helpers live in `work-zone-parts`.
 */

/* ------------------------------------------------------------------ */
/* Traffic cone                                                        */
/* ------------------------------------------------------------------ */

/** Slight shoulder under the tip, then a straight taper to the skirt. */
const CONE =
  "M48 7.2 C49.8 7.2 51 8.5 51.3 10.2 L58.6 36.4 L37.4 36.4 L44.7 10.2 " +
  "C45 8.5 46.2 7.2 48 7.2 Z";

/** Moulded cone: two retroreflective collars over a square base flange. */
export function TrafficCone() {
  return (
    <VehicleSvg id={"construction.traffic_cone"}>
      <Ground x={28} width={40} />

      {/* Base flange: bevelled front, lit top face. */}
      <path d="M30.6 41 L33 36.9 L63 36.9 L65.4 41 Z" fill="currentColor" />
      <path d="M30.6 41 L33 36.9 L63 36.9 L65.4 41 Z" fill={PALETTE.shadow} opacity=".22" />
      <path d="M33 36.9 L36.6 35.3 L59.4 35.3 L63 36.9 Z" fill="currentColor" />
      <path d="M33 36.9 L36.6 35.3 L59.4 35.3 L63 36.9 Z" fill="#fff" opacity=".14" />
      <path
        d="M30.6 41 L33 36.9 L63 36.9 L65.4 41"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".9"
        strokeLinejoin="round"
      />

      {/* Cone shell, then the paint scheme clipped inside it. */}
      <path d={CONE} fill="currentColor" />
      <clipPath id="ca-cone">
        <path d={CONE} />
      </clipPath>
      <g clipPath="url(#ca-cone)">
        <rect x="36" y="6" width="24" height="32" fill={ORANGE} opacity=".86" />
        <rect x="36" y="15.4" width="24" height="5.2" fill={REFLECT} opacity=".95" />
        <rect x="36" y="25.2" width="24" height="4.4" fill={REFLECT} opacity=".95" />
        <g fill={PALETTE.shadow} opacity=".22">
          <rect x="36" y="15.4" width="24" height=".7" />
          <rect x="36" y="20" width="24" height=".7" />
          <rect x="36" y="25.2" width="24" height=".7" />
          <rect x="36" y="29" width="24" height=".7" />
        </g>
        <path d="M45.9 10.6 L42.7 35 L45.1 35 L47.5 10.6 Z" fill="#fff" opacity=".2" />
        <path d="M52.2 10.6 L56.6 35 L59.4 35 L54 10.6 Z" fill={PALETTE.shadow} opacity=".2" />
        <path d="M36 33.4 L60 33.4 L60 36.4 L36 36.4 Z" fill={PALETTE.shadow} opacity=".18" />
      </g>
      <path d={CONE} fill={FILL.gloss} opacity=".5" />
      <path d={CONE} fill="none" stroke={PALETTE.line} strokeWidth="1.1" strokeLinejoin="round" />

      {/* Moulded tip, where the cone is grabbed. */}
      <path d="M46.2 9.8 C46.6 8.2 49.4 8.2 49.8 9.8 Z" fill={ORANGE_DEEP} opacity=".8" />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Channelizer drum                                                    */
/* ------------------------------------------------------------------ */

/** Barrel wall with the waist pulled in, the way a rolled drum sits. */
const DRUM =
  "M37.6 10.6 C36.4 18 36.1 29.4 37 37.2 L59 37.2 " +
  "C59.9 29.4 59.6 18 58.4 10.6 Z";

/** Plastic channelizer: four bands, ribbed lid with handle slots, ballast ring. */
export function ChannelizerDrum() {
  return (
    <VehicleSvg id={"construction.channelizer_drum"}>
      <Ground x={26} width={44} />

      {/* Ballast ring the drum drops into. */}
      <path d="M30 41 L33 36.6 L63 36.6 L66 41 Z" fill="currentColor" />
      <path d="M30 41 L33 36.6 L63 36.6 L66 41 Z" fill={PALETTE.shadow} opacity=".3" />
      <path d="M33 36.6 L63 36.6 L61.8 35.4 L34.2 35.4 Z" fill="#fff" opacity=".1" />
      <g fill={PALETTE.shadow} opacity=".55">
        <rect x="35.6" y="37.6" width="4.4" height="1.6" rx=".6" />
        <rect x="56" y="37.6" width="4.4" height="1.6" rx=".6" />
      </g>
      <path
        d="M30 41 L33 36.6 L63 36.6 L66 41"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".9"
        strokeLinejoin="round"
      />

      {/* Drum wall: alternating bands clipped to the barrel. */}
      <path d={DRUM} fill="currentColor" />
      <clipPath id="ca-drum">
        <path d={DRUM} />
      </clipPath>
      <g clipPath="url(#ca-drum)">
        <rect x="34" y="10" width="28" height="7.1" fill={ORANGE} opacity=".88" />
        <rect x="34" y="17.1" width="28" height="6.7" fill={REFLECT} opacity=".94" />
        <rect x="34" y="23.8" width="28" height="6.7" fill={ORANGE} opacity=".88" />
        <rect x="34" y="30.5" width="28" height="7" fill={REFLECT} opacity=".94" />
        <g fill={PALETTE.shadow} opacity=".24">
          <rect x="34" y="16.9" width="28" height=".8" />
          <rect x="34" y="23.6" width="28" height=".8" />
          <rect x="34" y="30.3" width="28" height=".8" />
        </g>
        <rect x="37.8" y="10" width="3" height="28" fill="#fff" opacity=".16" />
        <rect x="54.2" y="10" width="5" height="28" fill={PALETTE.shadow} opacity=".18" />
      </g>
      <path d={DRUM} fill={FILL.gloss} opacity=".45" />
      <path d={DRUM} fill="none" stroke={PALETTE.line} strokeWidth="1.1" strokeLinejoin="round" />

      {/* Lid: rolled rim, radial ribs, two handle cut-outs. */}
      <ellipse cx="48" cy="10.6" rx="10.6" ry="3" fill="currentColor" />
      <ellipse cx="48" cy="10.6" rx="10.6" ry="3" fill="#fff" opacity=".12" />
      <ellipse cx="48" cy="10.6" rx="10.6" ry="3" fill="none" stroke={PALETTE.line} strokeWidth="1" />
      <ellipse cx="48" cy="10.2" rx="8.2" ry="2" fill="none" stroke={PALETTE.line} strokeWidth=".7" opacity=".6" />
      <g stroke={PALETTE.shadow} strokeWidth=".7" opacity=".35">
        <line x1="40.2" y1="9.4" x2="39.2" y2="11.2" />
        <line x1="44.2" y1="8.4" x2="43.8" y2="10.4" />
        <line x1="51.8" y1="8.4" x2="52.2" y2="10.4" />
        <line x1="55.8" y1="9.4" x2="56.8" y2="11.2" />
      </g>
      <g fill={PALETTE.shadow} opacity=".7">
        <rect x="40.8" y="9.4" width="4.6" height="2" rx="1" />
        <rect x="50.6" y="9.4" width="4.6" height="2" rx="1" />
      </g>
      <g stroke={REFLECT} strokeWidth=".6" opacity=".4">
        <line x1="41.4" y1="9.2" x2="44.8" y2="9.2" />
        <line x1="51.2" y1="9.2" x2="54.6" y2="9.2" />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Type 3 barricade                                                    */
/* ------------------------------------------------------------------ */

/** Three striped rails on splayed A-frames, weighted down with sandbags. */
export function BarricadeType3() {
  return (
    <VehicleSvg id={"construction.barricade_type3"}>
      <Ground x={12} width={72} />

      {/* A-frames behind the rails: far leg first so the near one overlaps it. */}
      <g>
        <path d={strut(26.6, 7.8, 29.8, 39.6, 2.2, 2.8)} fill={PALETTE.bodyShade} />
        <path d={strut(70.6, 7.8, 73.8, 39.6, 2.2, 2.8)} fill={PALETTE.bodyShade} />
        <path d={strut(25.2, 7.8, 21.8, 40.4, 2.6, 3.2)} fill="currentColor" />
        <path d={strut(69.2, 7.8, 65.8, 40.4, 2.6, 3.2)} fill="currentColor" />
        <path d={strut(22.8, 35.8, 29.4, 35.8, 1.7)} fill="currentColor" />
        <path d={strut(66.8, 35.8, 73.4, 35.8, 1.7)} fill="currentColor" />
      </g>

      <StripedRail x={12} y={8.4} width={72} height={6.4} slot="bar-top" />
      <StripedRail x={12} y={18.4} width={72} height={6.4} slot="bar-mid" />
      <StripedRail x={12} y={28.4} width={72} height={6.4} slot="bar-low" />

      {/* Rail bolts where the frames pick up. */}
      <g fill={PALETTE.chrome} opacity=".85">
        <circle cx="26" cy="11.6" r=".8" />
        <circle cx="26" cy="21.6" r=".8" />
        <circle cx="26" cy="31.6" r=".8" />
        <circle cx="70" cy="11.6" r=".8" />
        <circle cx="70" cy="21.6" r=".8" />
        <circle cx="70" cy="31.6" r=".8" />
      </g>

      {/* Amber warning lamps on the frame heads. */}
      <g>
        <circle cx="25.4" cy="5.2" r="2.5" fill={PALETTE.amber} />
        <circle cx="25.4" cy="5.2" r="2.5" fill="none" stroke={PALETTE.line} strokeWidth=".7" />
        <circle cx="24.5" cy="4.3" r=".9" fill="#fffdf2" opacity=".85" />
        <circle cx="69.4" cy="5.2" r="2.5" fill={PALETTE.amber} />
        <circle cx="69.4" cy="5.2" r="2.5" fill="none" stroke={PALETTE.line} strokeWidth=".7" />
        <circle cx="68.5" cy="4.3" r=".9" fill="#fffdf2" opacity=".85" />
      </g>

      <Sandbag x={17.4} y={36.4} width={12.4} />
      <Sandbag x={61.6} y={36.4} width={12.4} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Pedestrian barrier                                                  */
/* ------------------------------------------------------------------ */

/** Interlocking plastic fence panel: bar grid, hook lugs, pinned feet. */
export function PedestrianBarrier() {
  return (
    <VehicleSvg id={"construction.pedestrian_barrier"}>
      <Ground x={10} width={76} />

      {/* Feet: splayed pads with the pin holes that stake them down. */}
      <g>
        <path d="M12.4 34.4 L26.4 34.4 L28.6 41 L10 41 Z" fill="currentColor" />
        <path d="M12.4 34.4 L26.4 34.4 L28.6 41 L10 41 Z" fill={PALETTE.shadow} opacity=".2" />
        <path d="M69.6 34.4 L83.6 34.4 L86 41 L67.4 41 Z" fill="currentColor" />
        <path d="M69.6 34.4 L83.6 34.4 L86 41 L67.4 41 Z" fill={PALETTE.shadow} opacity=".2" />
        <g fill={PALETTE.shadow} opacity=".7">
          <ellipse cx="15.4" cy="38.2" rx="1.5" ry="1.1" />
          <ellipse cx="23.2" cy="38.2" rx="1.5" ry="1.1" />
          <ellipse cx="72.6" cy="38.2" rx="1.5" ry="1.1" />
          <ellipse cx="80.4" cy="38.2" rx="1.5" ry="1.1" />
        </g>
        <g fill="none" stroke={PALETTE.line} strokeWidth=".8" strokeLinejoin="round">
          <path d="M12.4 34.4 L26.4 34.4 L28.6 41 L10 41 Z" />
          <path d="M69.6 34.4 L83.6 34.4 L86 41 L67.4 41 Z" />
        </g>
      </g>

      {/* Bar grid between the rails. */}
      <g fill="currentColor">
        {[15, 23.6, 32.2, 40.8, 49.4, 58, 66.6, 75.2].map((x) => (
          <rect key={x} x={x} y={17.6} width={2.7} height={14.4} rx=".9" />
        ))}
      </g>
      <g fill={PALETTE.shadow} opacity=".3">
        {[15, 23.6, 32.2, 40.8, 49.4, 58, 66.6, 75.2].map((x) => (
          <rect key={x} x={x + 1.8} y={17.6} width={0.9} height={14.4} />
        ))}
      </g>

      {/* End stiles, then the rails that tie the panel together. */}
      <g>
        <rect x="9.2" y="14.4" width="3.8" height="20.4" rx="1.2" fill="currentColor" />
        <rect x="83" y="14.4" width="3.8" height="20.4" rx="1.2" fill="currentColor" />
        <rect x="8.4" y="30.2" width="79.2" height="4.2" rx="1.4" fill="currentColor" />
        <rect x="8.4" y="14.4" width="79.2" height="4.8" rx="1.6" fill="currentColor" />
        <rect x="9" y="14.9" width="78" height="3.6" fill={ORANGE} opacity=".82" />
        <g fill={REFLECT} opacity=".92">
          <rect x="17" y="15.3" width="6.4" height="2.8" rx=".5" />
          <rect x="44.8" y="15.3" width="6.4" height="2.8" rx=".5" />
          <rect x="72.6" y="15.3" width="6.4" height="2.8" rx=".5" />
        </g>
        <rect x="9" y="14.8" width="78" height="1" rx=".5" fill="#fff" opacity=".3" />
        <rect x="8.8" y="33" width="78.4" height="1.4" fill={PALETTE.shadow} opacity=".26" />
        <g fill="none" stroke={PALETTE.line} strokeWidth=".85">
          <rect x="8.4" y="14.4" width="79.2" height="4.8" rx="1.6" />
          <rect x="8.4" y="30.2" width="79.2" height="4.2" rx="1.4" />
        </g>
      </g>

      {/* Interlock: socket cut into the left stile, hooks out of the right. */}
      <g fill={PALETTE.shadow} opacity=".6">
        <path d="M9 20.6 L12.6 20.6 L12.6 23.6 L9 23.6 Z" />
        <path d="M9 27.2 L12.6 27.2 L12.6 30.2 L9 30.2 Z" />
      </g>
      <g fill="currentColor">
        <path d="M86.4 20.6 L90 21 L90 23.6 L86.4 24 Z" />
        <path d="M86.4 27.2 L90 27.6 L90 30.2 L86.4 30.6 Z" />
      </g>
      <g fill="none" stroke={PALETTE.line} strokeWidth=".7">
        <path d="M86.4 20.6 L90 21 L90 23.6 L86.4 24" />
        <path d="M86.4 27.2 L90 27.6 L90 30.2 L86.4 30.6" />
      </g>
      <Seam d="M13.4 24.6 L82.6 24.6" width={0.7} opacity={0.4} />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Jersey barrier                                                      */
/* ------------------------------------------------------------------ */

/*
 * One precast unit from the traffic side, slightly above. Both ends carry the
 * section in silhouette — narrow crown, upright batter, knee, flared toe —
 * because that section is the only part of a jersey barrier anyone can name.
 * It is drawn as one unit rather than a length of wall (that is what
 * `JerseyBarrierRun` is for), and the face is banded light-to-dark from toe to
 * crown so the three planes of the section read at tile size.
 */
const JB_FACE =
  "M24 13 L76 15.6 L77 22.6 L77.8 30 L80.4 36.8 L80.8 39.4 " +
  "L19.2 41 L19.6 38.6 L22.6 30 L23.4 22.4 Z";
/** Crown, seen edge-on because the unit leans away from the eye. */
const JB_CROWN = "M24 13 L26.4 11.1 L78.4 13.7 L76 15.6 Z";
/** The flared toe: everything below the knee, tipped up to the sky. */
const JB_TOE = "M22.6 30 L77.8 30 L80.4 36.8 L80.8 39.4 L19.2 41 L19.6 38.6 Z";
/** The batter between knee and crown, the plane a car glances off. */
const JB_BATTER = "M23.4 22.4 L77 22.6 L77.8 30 L22.6 30 Z";

/** One precast barrier: profiled ends, lift pockets, weathered face. */
export function JerseyBarrier() {
  return (
    <VehicleSvg id={"construction.jersey_barrier"}>
      <Ground x={16} width={66} />

      {/* Crown first; the face overlaps its lower edge. */}
      <path d={JB_CROWN} fill="currentColor" />
      <path d={JB_CROWN} fill="#fff" opacity=".3" />
      <path d={JB_CROWN} fill="none" stroke={PALETTE.line} strokeWidth=".9" strokeLinejoin="round" />
      <g fill={PALETTE.shadow} opacity=".55">
        <path d="M37.6 13.7 L41 13.9 L43.4 12 L40 11.8 Z" />
        <path d="M56 14.9 L59.4 15.1 L61.8 13.2 L58.4 13 Z" />
      </g>

      {/* Face, banded by section plane: dark crown, mid batter, lit toe. */}
      <path d={JB_FACE} fill="currentColor" />
      <path d={JB_FACE} fill={CONCRETE} opacity=".2" />
      <path d={JB_FACE} fill={PALETTE.shadow} opacity=".22" />
      <path d={JB_BATTER} fill="#fff" opacity=".1" />
      <path d={JB_TOE} fill="#fff" opacity=".2" />
      <clipPath id="ca-jersey">
        <path d={JB_FACE} />
      </clipPath>
      <g clipPath="url(#ca-jersey)">
        {/* Rain streaks off the crown, road grime along the toe. */}
        <g fill={CONCRETE} opacity=".3">
          <path d="M33 14 L34.6 14.1 L33.8 29.6 L32.2 29.5 Z" />
          <path d="M48.4 14.8 L49.4 14.9 L49.6 28 L48.6 27.9 Z" />
          <path d="M64 15.6 L65.2 15.7 L66 29.4 L64.8 29.3 Z" />
        </g>
        <path d="M18 38 L82 36.8 L82 42 L18 42 Z" fill={PALETTE.shadow} opacity=".3" />
        <path d="M24 13 L76 15.6 L76 17 L24 14.4 Z" fill="#fff" opacity=".3" />
      </g>

      {/* Section break lines: batter at the top, knee below. */}
      <path d="M23.4 22.4 L77 22.6" fill="none" stroke={CONCRETE} strokeWidth=".8" opacity=".55" />
      <path d="M22.6 30 L77.8 30" fill="none" stroke={REFLECT} strokeWidth="1" opacity=".45" />
      <path d={JB_FACE} fill="none" stroke={PALETTE.line} strokeWidth="1.1" strokeLinejoin="round" />

      {/* Chipped crown corner, and the delineator plate the unit carries. */}
      <path d="M70.4 16.8 L72.8 17.1 L72.3 19.2 L70.2 18.9 Z" fill={PALETTE.shadow} opacity=".22" />
      <rect x="39" y="25" width="4.6" height="3.2" rx=".5" fill={REFLECT} opacity=".7" />
      <rect x="39" y="25" width="4.6" height="3.2" rx=".5" fill="none" stroke={PALETTE.line} strokeWidth=".6" />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Jersey barrier run                                                  */
/* ------------------------------------------------------------------ */

/**
 * Joints along the run. Top and base edges converge as the wall recedes, so a
 * joint carries the edge heights the panels either side of it have to share.
 */
const RUN_JOINTS = [7.4, 30, 49.4, 65.8, 79.2, 90].map((x) => {
  const away = (x - 7.4) / 82.6;
  const top = 16.8 + away * 8.9;
  const base = 41 - away * 2.9;
  return { x, top, base, knee: top + (base - top) * 0.62 };
});

/** Consecutive joints, one entry per barrier panel. */
const RUN_PANELS = RUN_JOINTS.slice(0, -1).map((near, index) => ({
  near,
  far: RUN_JOINTS[index + 1] ?? near,
}));

/** Top slab: a sliver that narrows as the wall leans away from the eye. */
const RUN_SLAB = "M7.4 16.8 L11 14 L91.2 24.6 L90 25.7 Z";

/** The near end's profile chain, from the top edge down to the flared toe. */
const RUN_END = "L4.6 41 L4.9 38.4 L5.9 31.4 L6.6 27.4 Z";

/** A line of barriers closing a lane, receding to the right with open joints. */
export function JerseyBarrierRun() {
  return (
    <VehicleSvg id={"construction.jersey_barrier_run"}>
      <Ground x={6} width={86} />

      {/* Top slab, seen edge-on above the wall. */}
      <path d={RUN_SLAB} fill="currentColor" />
      <path d={RUN_SLAB} fill="#fff" opacity=".2" />

      {/* Panels front to back. The first shows its profiled end. */}
      {RUN_PANELS.map(({ near, far }, index) => {
        const head = `M${near.x} ${near.top} L${far.x} ${far.top} L${far.x} ${far.base} `;
        const face = index === 0 ? head + RUN_END : `${head}L${near.x} ${near.base} Z`;
        return (
          <g key={near.x}>
            <path d={face} fill="currentColor" />
            <path d={face} fill={CONCRETE} opacity={0.2} />
            <path d={face} fill={PALETTE.shadow} opacity={0.1 + index * 0.07} />
            <path
              d={`M${near.x} ${near.knee} L${far.x} ${far.knee} L${far.x} ${far.base} L${index === 0 ? 4.6 : near.x} ${near.base} Z`}
              fill="#fff"
              opacity=".1"
            />
            <path
              d={`M${near.x} ${near.knee} L${far.x} ${far.knee}`}
              fill="none"
              stroke={CONCRETE}
              strokeWidth=".8"
              opacity=".6"
            />
            <path d={face} fill="none" stroke={PALETTE.line} strokeWidth={1 - index * 0.1} strokeLinejoin="round" />
          </g>
        );
      })}

      {/* Open joints between panels, and the shadow each one throws. */}
      <g>
        {RUN_JOINTS.slice(1, -1).map(({ x, top, base }) => (
          <g key={x}>
            <path
              d={`M${x - 0.6} ${top} L${x + 0.6} ${top} L${x + 0.6} ${base} L${x - 0.6} ${base} Z`}
              fill={PALETTE.shadow}
              opacity=".55"
            />
            <path
              d={`M${x + 0.6} ${top} L${x + 1.4} ${top} L${x + 1.4} ${base} L${x + 0.6} ${base} Z`}
              fill="#fff"
              opacity=".14"
            />
          </g>
        ))}
      </g>

      {/* Weathering on the two panels close enough to show it. */}
      <g fill={CONCRETE} opacity=".26">
        <path d="M15.4 18.6 L16.8 18.6 L16 32 L14.6 32 Z" />
        <path d="M23.6 19.4 L24.6 19.4 L24.2 30.4 L23.2 30.4 Z" />
        <path d="M38.4 21.6 L39.4 21.6 L39 30.6 L38 30.6 Z" />
      </g>
      <rect x="34.6" y="24.6" width="4" height="3" rx=".5" fill={REFLECT} opacity=".62" />
      <rect x="55.6" y="26.8" width="3.2" height="2.4" rx=".5" fill={REFLECT} opacity=".48" />
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Road work sign                                                      */
/* ------------------------------------------------------------------ */

/** Diamond blank, corners radiused the way a rolled sign panel is. */
const SIGN_DIAMOND =
  "M46.9 5.7 Q48 4.6 49.1 5.7 L61.3 17.9 Q62.4 19 61.3 20.1 " +
  "L49.1 32.3 Q48 33.4 46.9 32.3 L34.7 20.1 Q33.6 19 34.7 17.9 Z";
const SIGN_FACE =
  "M47 7.5 Q48 6.6 49 7.5 L59.5 18 Q60.4 19 59.5 20 " +
  "L49 30.5 Q48 31.4 47 30.5 L36.5 20 Q35.6 19 36.5 18 Z";
const SIGN_BORDER =
  "M47.2 8.7 Q48 8 48.8 8.7 L58.3 18.2 Q59 19 58.3 19.8 " +
  "L48.8 29.3 Q48 30 47.2 29.3 L37.7 19.8 Q37 19 37.7 18.2 Z";

/** W21-1: orange diamond, worker-and-shovel pictogram, flags, skid base. */
export function SignRoadWork() {
  return (
    <VehicleSvg id={"construction.sign_road_work"}>
      <Ground x={28} width={40} />

      {/* Skid base and the sandbags holding it down. */}
      <path d="M31.6 41 L36.2 36.4 L59.8 36.4 L64.4 41 Z" fill="currentColor" />
      <path d="M31.6 41 L36.2 36.4 L59.8 36.4 L64.4 41 Z" fill={PALETTE.shadow} opacity=".26" />
      <path d="M36.2 36.4 L59.8 36.4 L58.6 35.2 L37.4 35.2 Z" fill="#fff" opacity=".12" />
      <path
        d="M31.6 41 L36.2 36.4 L59.8 36.4 L64.4 41"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".9"
        strokeLinejoin="round"
      />

      {/* Perforated square post plus the rear stay. */}
      <path d={strut(50.2, 33.4, 57.8, 36, 1.6, 1.2)} fill={PALETTE.bodyShade} />
      <rect x="45.6" y="30" width="4.8" height="6.2" rx=".6" fill="currentColor" />
      <rect x="48.6" y="30" width="1.8" height="6.2" fill={PALETTE.shadow} opacity=".28" />
      <g fill={PALETTE.shadow} opacity=".6">
        <circle cx="47.8" cy="31.6" r=".7" />
        <circle cx="47.8" cy="34" r=".7" />
      </g>

      {/* Flag on the head, staff left proud of the panel. */}
      <path d={strut(48, 6.4, 47.4, 0.6, 1.2)} fill={PALETTE.chrome} />
      <path d="M48 1 L57 3.2 L48.4 5.6 Z" fill={ORANGE} />
      <path d="M48 1 L57 3.2 L48.4 5.6 Z" fill="none" stroke={PALETTE.line} strokeWidth=".6" />
      <path d="M48.4 3.3 L55.2 3.3" fill="none" stroke={ORANGE_DEEP} strokeWidth=".8" opacity=".8" />

      {/* Sign panel: blank, orange face, dark border, pictogram. */}
      <Body d={SIGN_DIAMOND} />
      <path d={SIGN_FACE} fill={ORANGE} opacity=".9" />
      <path d={SIGN_FACE} fill={FILL.gloss} opacity=".35" />
      <path d={SIGN_BORDER} fill="none" stroke="#15191f" strokeWidth="1.5" strokeLinejoin="round" opacity=".9" />
      <g fill="#12161d">
        <path d="M44.2 12.2 C44.5 9.4 47.6 8.4 49.2 10 C49.9 10.7 50 11.5 49.8 12.2 L50.8 12.6 L43.4 12.6 Z" />
        <circle cx="46.2" cy="14.2" r="1.9" />
        <path d="M44.6 16.2 L48 16.6 L49.8 22 L45.6 22.6 Z" />
        <path d="M45.8 22.4 L47.6 22.6 L46.7 27 L44.9 26.8 Z" />
        <path d="M48.2 22.2 L50 22.6 L51.4 26.6 L49.6 26.9 Z" />
        <path d={strut(47.2, 17.4, 52.2, 20.4, 1.8)} />
        <path d={strut(50.4, 18.6, 53.4, 22.4, 1.3)} />
        <path d="M52.2 21.6 L54.8 23.4 L53.2 25.2 L50.8 23.2 Z" />
      </g>
    </VehicleSvg>
  );
}

/* ------------------------------------------------------------------ */
/* Flagger                                                             */
/* ------------------------------------------------------------------ */

/** Skin tone, kept small: face, forearm gap, nothing else. */
const SKIN = "#c69a7c";
/** STOP paddle blank, octagonal, held out on a pole. */
const PADDLE =
  "M71.2 15.4 L67.2 19.4 L61.6 19.4 L57.6 15.4 L57.6 9.8 " +
  "L61.6 5.8 L67.2 5.8 L71.2 9.8 Z";
/** Face and jaw, seen three-quarter under the hat. */
const FLAGGER_HEAD =
  "M45.4 10.6 C45.4 8.1 47.2 6.8 49.2 7.2 C51 7.6 51.8 9.2 51.6 11 " +
  "L51.2 13.6 C50.8 15 48.6 15.4 47.2 14.6 C45.8 13.8 45.3 12.2 45.4 10.6 Z";

/** Traffic controller: hard hat, hi-vis vest, paddle held out to the road. */
export function Flagger() {
  return (
    <VehicleSvg id={"construction.flagger"}>
      <Ground x={36} width={24} />

      {/* Far side of the body first. */}
      <Limb d="M45.4 27.2 L43.6 33.8 L42.4 39.4" w={3.4} far />
      <path d="M41.6 38.6 L45.2 39 L45.4 41 L41 41 Z" fill="currentColor" opacity=".48" />
      <Limb d="M44 19.4 L42 24.6 L41.6 28.6" w={2.8} far />
      <ellipse cx="41.4" cy="29.4" rx="1.6" ry="1.9" fill={ORANGE} opacity=".75" />

      {/* Trousers and boots. */}
      <Limb d="M47.6 27.4 L49.4 33.8 L50.6 39.2" w={3.6} />
      <path d="M49.6 38.4 L53.8 39 L54 41 L48.8 41 Z" fill="currentColor" />
      <path d="M49.6 38.4 L53.8 39 L54 41 L48.8 41 Z" fill={PALETTE.shadow} opacity=".3" />
      <path d="M43.6 27.2 L52.4 27.6 L52 29.6 L44 29.2 Z" fill="currentColor" />

      {/* Torso, then the vest over it. */}
      <path d="M43.2 17.4 L52 17.6 L52.6 27.8 L43.8 28 Z" fill="currentColor" />
      <path d="M44.1 18.7 L51.2 18.8 L51.9 27.5 L44.6 27.6 Z" fill={HIVIS} />
      <g fill={PALETTE.chrome} opacity=".9">
        <path d="M44.3 20.9 L51.4 21 L51.5 22.4 L44.4 22.3 Z" />
        <path d="M44.5 24.3 L51.6 24.4 L51.7 25.8 L44.6 25.7 Z" />
        <path d="M47.6 18.8 L48.7 18.8 L49 27.5 L47.9 27.5 Z" />
      </g>
      <path d="M47.9 18.8 L48.3 27.5" fill="none" stroke={PALETTE.shadow} strokeWidth=".6" opacity=".4" />
      <path d="M44.1 18.7 L51.2 18.8 L51.9 27.5 L44.6 27.6 Z" fill="none" stroke={PALETTE.line} strokeWidth=".7" />

      {/* Paddle arm, out toward the road. */}
      <Limb d="M51.4 19.2 L56.2 21.6 L60.2 23.8" w={3.2} />
      <ellipse cx="60.7" cy="24.2" rx="1.9" ry="1.7" fill={ORANGE} />
      <path d={strut(60.6, 24.8, 63.4, 13.4, 1.7)} fill={PALETTE.chrome} />
      <path d={PADDLE} fill="currentColor" />
      <path
        d="M69.8 15 L66.6 18.2 L62.2 18.2 L59 15 L59 10.2 L62.2 7 L66.6 7 L69.8 10.2 Z"
        fill={STOP_RED}
      />
      <path
        d="M68.6 14.5 L65.9 17.2 L62.9 17.2 L60.2 14.5 L60.2 10.7 L62.9 8 L65.9 8 L68.6 10.7 Z"
        fill="none"
        stroke={REFLECT}
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d={PADDLE} fill="none" stroke={PALETTE.line} strokeWidth=".9" strokeLinejoin="round" />

      {/* Head: neck, face, hard hat with a brim and a chin strap. */}
      <rect x="46.4" y="14.6" width="3.4" height="3.4" rx="1" fill={SKIN} />
      <path d={FLAGGER_HEAD} fill={SKIN} />
      <path
        d="M44.4 9 C44.6 5.6 47.6 3.8 50.2 4.6 C52.4 5.3 53.1 7.3 52.7 9.2 L52.6 9.6 L44.5 9.6 Z"
        fill={PALETTE.amber}
      />
      <path d="M43.6 9.2 L53.6 9.2 L53.8 10.4 L43.4 10.4 Z" fill={PALETTE.amber} />
      <path d="M43.6 9.2 L53.6 9.2 L53.8 10.4 L43.4 10.4 Z" fill={PALETTE.shadow} opacity=".2" />
      <path d="M48.4 4.5 L48.8 9.2" fill="none" stroke={PALETTE.shadow} strokeWidth=".7" opacity=".3" />
      <path d="M52.4 10.4 L51.6 13.8" fill="none" stroke={PALETTE.shadow} strokeWidth=".7" opacity=".45" />
    </VehicleSvg>
  );
}
