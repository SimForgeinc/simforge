"use client";

import { FILL, GROUND, Ground, PALETTE, Seam, VehicleSvg } from "../vehicle-art/parts";

/**
 * The seven catalog pedestrians, drawn against the shared vehicle-art contract:
 * a right-facing three-quarter elevation in the 96×48 box, feet on GROUND.
 *
 *   adult  ~30 units tall, head ≈ 1/7 of it   (crown y ≈ 11, hip y ≈ 26)
 *   child  ~20 units tall, head ≈ 1/5 of it   (crown y ≈ 21, hip y ≈ 32)
 *
 * Clothing is `currentColor` so the panel can tint a pedestrian class; only what
 * identifies a person is hardcoded — skin, hair, hi-vis, a stop paddle, a
 * child's pack. Torsos are filled masses and limbs are round-capped polylines:
 * the joint of a polyline is the knee or elbow, and a limb carries a dark halo
 * under its rim light so an arm still separates from the torso once the tile
 * shrinks all of this to roughly fifteen CSS pixels of standing figure.
 */

const SKIN = "#e7b18d";
const SKIN_SHADE = "#a9714f";
const HAIR = "#33281f";
const HAIR_CHILD = "#6f4a2a";
const HIVIS = "#e4dc38";
const HIVIS_SHADE = "#9c9418";
const REFLECT = "#e3ebf3";
const LEATHER = "#8a6a4d";
const PACK = "#c9553f";
const PACK_SHADE = "#7d2f22";
const SCREEN = "#8fd0ff";
const WHITE = "#e9eff6";

/**
 * Sleeved or trousered limb: cast shadow, rim light, body tone, fleet gloss.
 * `back` pushes the limb behind the torso; `dim` softens that for a far limb
 * that still has to carry the read, like the leading leg of a stride.
 */
function Limb({ d, w = 2.2, back = false, dim = 0.46 }: { d: string; w?: number; back?: boolean; dim?: number }) {
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      {back ? null : <path d={d} stroke={PALETTE.shadow} strokeWidth={w + 2.1} opacity=".32" />}
      <path
        d={d}
        stroke={back ? PALETTE.shadow : PALETTE.line}
        strokeWidth={w + 1.0}
        opacity={back ? 0.5 : 0.55}
      />
      <path d={d} stroke="currentColor" strokeWidth={w} />
      <path d={d} stroke={back ? PALETTE.shadow : FILL.gloss} strokeWidth={w} opacity={back ? dim : 1} />
    </g>
  );
}

/** Bare arm, bare leg, forearm below a short sleeve. */
function Bare({ d, w = 1.6, back = false }: { d: string; w?: number; back?: boolean }) {
  return (
    <g fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} stroke={SKIN_SHADE} strokeWidth={w + 0.7} opacity={back ? 0.45 : 0.85} />
      <path d={d} stroke={SKIN} strokeWidth={w} opacity={back ? 0.74 : 1} />
    </g>
  );
}

/** Cloth panel: jacket, shorts, coat tail. Same lighting model as a car body. */
function Cloth({ d, back = false, outline = 0.65 }: { d: string; back?: boolean; outline?: number }) {
  return (
    <>
      <path d={d} fill="currentColor" />
      <path d={d} fill={back ? PALETTE.shadow : FILL.gloss} opacity={back ? 0.44 : 1} />
      <path d={d} fill="none" stroke={PALETTE.line} strokeWidth={outline} opacity={back ? 0.32 : 0.85} strokeLinejoin="round" />
    </>
  );
}

/** Hand or palm. */
function Hand({ cx, cy, r = 1.1, back = false }: { cx: number; cy: number; r?: number; back?: boolean }) {
  return (
    <>
      <ellipse cx={cx} cy={cy} rx={r} ry={r * 1.25} fill={SKIN} opacity={back ? 0.78 : 1} />
      <ellipse cx={cx} cy={cy} rx={r} ry={r * 1.25} fill="none" stroke={SKIN_SHADE} strokeWidth=".6" opacity={back ? 0.5 : 0.85} />
    </>
  );
}

/**
 * Head in three-quarter profile: skull, jaw shading, nose, ear. `tilt` pivots on
 * the chin so a figure can look down at what it is holding.
 */
function Face({ cx, cy, r, tilt = 0 }: { cx: number; cy: number; r: number; tilt?: number }) {
  const w = r * 0.84;
  return (
    <g transform={tilt ? `rotate(${tilt} ${cx} ${cy + r})` : undefined}>
      <ellipse cx={cx} cy={cy} rx={w} ry={r} fill={SKIN} />
      <path
        d={`M${cx - w} ${cy} C${cx - w * 0.5} ${cy + r * 0.8} ${cx + w * 0.3} ${cy + r} ${cx + w * 0.7} ${cy + r * 0.45}`}
        fill="none"
        stroke={SKIN_SHADE}
        strokeWidth={r * 0.3}
        opacity=".32"
        strokeLinecap="round"
      />
      <path
        d={`M${cx + w * 0.6} ${cy - r * 0.22} L${cx + w * 1.46} ${cy + r * 0.22} L${cx + w * 0.58} ${cy + r * 0.44} Z`}
        fill={SKIN}
      />
      <ellipse cx={cx} cy={cy} rx={w} ry={r} fill="none" stroke={SKIN_SHADE} strokeWidth=".6" opacity=".7" />
      <circle cx={cx - w * 0.52} cy={cy - r * 0.04} r={r * 0.24} fill={SKIN_SHADE} opacity=".5" />
    </g>
  );
}

/**
 * One foot. `x` is the ankle and the toe runs `dir` forward. `spin` rolls the
 * shoe on its heel at a negative angle (heel strike) or on its toe at a positive
 * one (push-off), which is what makes a stride read as motion rather than as a
 * figure standing in a wide stance.
 */
function Shoe({
  x,
  dir = 1,
  k = 1,
  back = false,
  sneaker = false,
  boot = false,
  spin = 0,
}: {
  x: number;
  dir?: number;
  k?: number;
  back?: boolean;
  sneaker?: boolean;
  boot?: boolean;
  spin?: number;
}) {
  const toe = 3.2 * k;
  const heel = 1.5 * k;
  const h = 2.2 * k;
  const y = GROUND;
  const d =
    `M${x - dir * heel} ${y - h} L${x + dir * 0.4} ${y - h}` +
    ` C${x + dir * toe * 0.72} ${y - h} ${x + dir * toe} ${y - h * 0.52} ${x + dir * toe} ${y - h * 0.18}` +
    ` C${x + dir * toe} ${y} ${x + dir * toe * 0.7} ${y} ${x + dir * toe * 0.45} ${y}` +
    ` L${x - dir * heel} ${y} Z`;
  const pivot = spin < 0 ? x - dir * heel : x + dir * toe;
  return (
    <g transform={spin ? `rotate(${spin} ${pivot} ${y})` : undefined}>
      {boot ? (
        <path
          d={`M${x - dir * heel * 0.9} ${y - h} L${x + dir * 1.5 * k} ${y - h} L${x + dir * 1.15 * k} ${y - h - 2.7 * k} L${x - dir * heel * 0.7} ${y - h - 2.7 * k} Z`}
          fill={back ? "#151b23" : "#28303c"}
        />
      ) : null}
      <path d={d} fill={back ? "#0a0e13" : PALETTE.tire} />
      {sneaker ? (
        <>
          <path
            d={
              `M${x + dir * toe * 0.28} ${y - h * 0.82} C${x + dir * toe * 0.85} ${y - h * 0.78} ${x + dir * toe} ${y - h * 0.5} ${x + dir * toe} ${y - h * 0.18}` +
              ` C${x + dir * toe} ${y} ${x + dir * toe * 0.7} ${y} ${x + dir * toe * 0.45} ${y} Z`
            }
            fill={WHITE}
            opacity={back ? 0.6 : 0.94}
          />
          <path
            d={`M${x - dir * heel} ${y - h * 0.34} L${x + dir * toe * 0.88} ${y - h * 0.3}`}
            stroke={WHITE}
            strokeWidth={0.8 * k}
            opacity={back ? 0.48 : 0.88}
            strokeLinecap="round"
          />
        </>
      ) : (
        <path
          d={`M${x - dir * heel} ${y - h * 0.32} L${x + dir * toe * 0.86} ${y - h * 0.28}`}
          stroke={PALETTE.chrome}
          strokeWidth={0.62 * k}
          opacity={back ? 0.3 : 0.4}
          strokeLinecap="round"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke={back ? PALETTE.tireWall : PALETTE.rimShade}
        strokeWidth=".6"
        opacity={back ? 0.5 : 0.85}
        strokeLinejoin="round"
      />
      {boot ? (
        <path
          d={`M${x - dir * heel * 0.8} ${y - h - 2.5 * k} L${x + dir * 1.3 * k} ${y - h - 2.5 * k}`}
          stroke={PALETTE.rimShade}
          strokeWidth={0.7 * k}
          opacity=".7"
          strokeLinecap="round"
        />
      ) : null}
    </g>
  );
}

/** A child's school pack: worn on the back, sticking out behind the shoulders. */
function Backpack({ x = 0, y = 0, tilt = 0 }: { x?: number; y?: number; tilt?: number }) {
  const shell =
    "M42.4 26.4 C42.4 25.4 43.0 24.9 44.0 24.9 L46.9 24.9 L46.9 32.0 L44.0 32.0 C43.0 32.0 42.4 31.5 42.4 30.5 Z";
  return (
    <g transform={`translate(${x} ${y})${tilt ? ` rotate(${tilt} 45.4 28.4)` : ""}`}>
      <path d={shell} fill={PACK} />
      <path d={shell} fill={FILL.gloss} />
      <path d="M42.6 28.7 L46.9 28.7" stroke={PACK_SHADE} strokeWidth=".8" opacity=".9" />
      <path d="M43.2 30.6 L45.6 30.6" stroke={PACK_SHADE} strokeWidth=".65" opacity=".7" />
      <path d="M43.6 24.9 C43.7 24.0 45.0 23.9 45.3 24.8" fill="none" stroke={PACK_SHADE} strokeWidth=".7" strokeLinecap="round" />
      <path d={shell} fill="none" stroke={PALETTE.line} strokeWidth=".6" opacity=".4" strokeLinejoin="round" />
    </g>
  );
}

/** Neutral standing adult: weight on the near leg, relaxed arms, folded jacket. */
export function Adult() {
  return (
    <VehicleSvg id={"pedestrian.adult"}>
      <Ground x={39} width={19} />
      {/* far side: relaxed leg, hanging arm */}
      <Limb d="M46.2 25.8 L44.9 32.6 L44.3 38.9" w={2.8} back />
      <Limb d="M46.1 17.8 L45.0 22.4 L44.6 26.8" w={2.1} back />
      <Hand cx={44.3} cy={28.3} back />
      {/* weight-bearing near leg */}
      <Limb d="M50.4 25.8 L50.6 32.6 L50.6 38.9" w={3.0} />
      <Seam d="M49.4 33.4 C50.2 33.8 51.2 33.8 51.8 33.4" width={0.6} opacity={0.3} />
      {/* jacket */}
      <Cloth d="M45.2 19.8 C45.4 17.8 46.5 16.5 48.2 16.3 C49.9 16.1 51.5 17.5 51.7 19.8 L51.4 23.2 C51.6 25.0 51.9 26.8 52.0 28.3 L44.8 28.3 C45.0 26.8 45.3 25.0 45.4 23.2 Z" />
      <Seam d="M44.9 26.9 C47.4 27.5 49.6 27.5 51.9 26.9" width={0.7} opacity={0.5} />
      <Seam d="M45.8 22.4 C46.9 23.2 48.4 23.4 49.6 23.0" width={0.62} opacity={0.38} />
      <Seam d="M51.1 20.6 C50.8 21.8 50.8 22.8 51.1 24.0" width={0.62} opacity={0.36} />
      {/* neck, head */}
      <path d="M47.4 14.4 L49.4 14.4 L49.5 17.2 L47.3 17.2 Z" fill={SKIN} />
      <path d="M47.4 14.4 L49.4 14.4 L49.5 17.2 L47.3 17.2 Z" fill={PALETTE.shadow} opacity=".2" />
      <Face cx={48.2} cy={12.9} r={2.05} />
      <path
        d="M45.9 13.2 C45.6 10.9 46.8 9.7 48.4 9.8 C49.8 9.9 50.6 10.8 50.7 11.9 C49.9 11.1 48.0 10.9 47.1 11.9 C46.6 12.5 46.4 13.5 46.3 14.3 Z"
        fill={HAIR}
      />
      {/* collar closing over the neck root */}
      <path
        d="M46.6 16.8 C47.4 18.0 48.0 18.9 48.5 19.6 C49.2 18.8 50.0 17.8 50.7 16.9 C49.4 16.1 47.7 16.1 46.6 16.8 Z"
        fill={PALETTE.bodyShade}
        opacity=".82"
      />
      <Seam d="M46.6 16.8 C47.4 18.0 48.0 18.9 48.5 19.6 C49.2 18.8 50.0 17.8 50.7 16.9" width={0.6} opacity={0.55} />
      <Seam d="M48.6 19.6 L49.0 27.2" width={0.6} opacity={0.42} />
      {/* near arm */}
      <Limb d="M50.7 17.8 L51.8 22.4 L51.6 26.8" w={2.2} />
      <Seam d="M50.7 25.9 L52.6 25.7" width={0.7} opacity={0.5} />
      <Hand cx={51.7} cy={28.3} />
      {/* rim light along the shoulders */}
      <path d="M46.4 17.4 C47.5 16.5 49.5 16.4 50.7 17.3" fill="none" stroke={PALETTE.line} strokeWidth=".7" opacity=".5" strokeLinecap="round" />
      <Shoe x={44.3} back />
      <Shoe x={50.6} />
    </VehicleSvg>
  );
}

/** Mid-stride: scissored legs, contralateral arm swing, coat tail lifting. */
export function AdultWalking() {
  return (
    <VehicleSvg id={"pedestrian.adult_walking"}>
      <Ground x={38} width={22} />
      {/* far arm swung back behind the hip */}
      <Limb d="M46.4 17.8 L44.5 21.8 L43.1 24.6" w={2.1} back />
      <Hand cx={42.4} cy={25.6} back />
      {/* leading leg, reaching out for the heel strike */}
      <Limb d="M48.4 25.6 L50.9 31.2 L52.8 38.2" w={2.9} back dim={0.24} />
      {/* coat hem kicked back and up by the stride */}
      <Cloth d="M45.0 25.2 C44.0 26.5 43.2 27.7 42.8 29.0 C44.2 29.5 45.6 29.4 46.8 28.9 L47.2 25.4 Z" back />
      <path
        d="M45.0 25.2 C44.0 26.5 43.2 27.7 42.8 29.0 C43.8 29.4 44.8 29.5 45.8 29.3"
        fill="none"
        stroke={PALETTE.line}
        strokeWidth=".7"
        opacity=".5"
        strokeLinecap="round"
      />
      {/* torso, pitched forward into the walk */}
      <Cloth d="M45.9 19.6 C46.1 17.6 47.3 16.3 49.0 16.1 C50.7 15.9 52.3 17.3 52.4 19.6 L52.1 23.0 C52.2 24.8 52.4 26.6 52.4 28.1 L45.0 27.7 C45.3 26.2 45.7 24.4 45.9 22.8 Z" />
      <Seam d="M45.2 26.4 C47.6 27.1 50.0 27.2 52.3 26.7" width={0.7} opacity={0.5} />
      <Seam d="M46.6 22.2 C47.8 23.0 49.4 23.2 50.6 22.6" width={0.62} opacity={0.38} />
      <Seam d="M51.8 20.4 C51.5 21.6 51.5 22.6 51.8 23.8" width={0.62} opacity={0.36} />
      {/* trailing leg, driving back off the toe */}
      <Limb d="M48.9 25.8 L46.6 31.6 L45.0 38.4" w={3.1} />
      <Seam d="M45.8 31.1 C46.4 31.6 47.2 31.9 47.9 31.9" width={0.62} opacity={0.4} />
      {/* neck, head leading the body */}
      <path d="M48.2 14.2 L50.2 14.2 L50.3 17.0 L48.1 17.0 Z" fill={SKIN} />
      <path d="M48.2 14.2 L50.2 14.2 L50.3 17.0 L48.1 17.0 Z" fill={PALETTE.shadow} opacity=".2" />
      <Face cx={49.0} cy={12.7} r={2.05} />
      <path
        d="M46.7 13.0 C46.4 10.7 47.6 9.5 49.2 9.6 C50.6 9.7 51.4 10.6 51.5 11.7 C50.7 10.9 48.8 10.7 47.9 11.7 C47.4 12.3 47.2 13.3 47.1 14.1 Z"
        fill={HAIR}
      />
      <path
        d="M47.4 16.6 C48.2 17.8 48.8 18.7 49.3 19.4 C50.0 18.6 50.8 17.6 51.5 16.7 C50.2 15.9 48.5 15.9 47.4 16.6 Z"
        fill={PALETTE.bodyShade}
        opacity=".82"
      />
      {/* near arm swung forward */}
      <Limb d="M51.2 17.8 L52.8 21.8 L54.8 24.2" w={2.2} />
      <Seam d="M52.0 22.6 L53.4 21.6" width={0.7} opacity={0.5} />
      <Hand cx={55.6} cy={24.9} />
      <path d="M47.2 17.2 C48.3 16.3 50.3 16.2 51.4 17.1" fill="none" stroke={PALETTE.line} strokeWidth=".7" opacity=".5" strokeLinecap="round" />
      {/* heel strike ahead, toe-off behind */}
      <Shoe x={52.6} spin={-18} back />
      <Shoe x={45.2} spin={24} />
    </VehicleSvg>
  );
}

/** Waiting at the kerb: feet together, phone up, bag on the far hip. */
export function AdultStanding() {
  return (
    <VehicleSvg id={"pedestrian.adult_standing"}>
      <Ground x={41} width={16} />
      <Limb d="M46.6 25.8 L46.2 32.6 L46.1 38.9" w={2.8} back />
      <Limb d="M45.9 17.8 L45.0 22.4 L44.8 26.8" w={2.1} back />
      <Hand cx={44.6} cy={28.3} back />
      <Limb d="M50.1 25.8 L50.2 32.6 L50.2 38.9" w={3.0} />
      <Cloth d="M45.2 19.8 C45.4 17.8 46.5 16.5 48.2 16.3 C49.9 16.1 51.5 17.5 51.7 19.8 L51.4 23.2 C51.6 25.0 51.9 26.8 52.0 28.3 L44.8 28.3 C45.0 26.8 45.3 25.0 45.4 23.2 Z" />
      <Seam d="M44.9 26.9 C47.4 27.5 49.6 27.5 51.9 26.9" width={0.7} opacity={0.5} />
      <Seam d="M45.6 23.6 C46.6 24.4 48.0 24.6 49.2 24.2" width={0.62} opacity={0.36} />
      {/* shoulder bag: strap over the near shoulder, body on the far hip */}
      <path d="M50.4 17.2 L45.6 25.4" fill="none" stroke={LEATHER} strokeWidth="1.3" strokeLinecap="round" />
      <path d="M50.4 17.2 L45.6 25.4" fill="none" stroke={PALETTE.shadow} strokeWidth="1.3" opacity=".26" strokeLinecap="round" />
      <path d="M42.6 25.2 L47.6 25.2 C48.0 25.2 48.2 25.5 48.2 26.0 L48.2 28.6 C48.2 29.3 47.8 29.7 47.1 29.7 L43.1 29.7 C42.4 29.7 42.0 29.3 42.0 28.6 L42.0 26.0 C42.0 25.5 42.2 25.2 42.6 25.2 Z" fill={LEATHER} />
      <path d="M42.6 25.2 L47.6 25.2 C48.0 25.2 48.2 25.5 48.2 26.0 L48.2 28.6 C48.2 29.3 47.8 29.7 47.1 29.7 L43.1 29.7 C42.4 29.7 42.0 29.3 42.0 28.6 L42.0 26.0 C42.0 25.5 42.2 25.2 42.6 25.2 Z" fill={FILL.gloss} />
      <path d="M42.0 26.9 L48.2 26.9 L48.2 25.9 C48.2 25.4 47.9 25.2 47.4 25.2 L42.8 25.2 C42.3 25.2 42.0 25.4 42.0 25.9 Z" fill={PALETTE.shadow} opacity=".38" />
      <rect x="44.5" y="26.4" width="1.4" height="1.2" rx=".3" fill={PALETTE.chrome} opacity=".8" />
      {/* neck and head, looking down at the screen */}
      <path d="M47.4 14.4 L49.4 14.4 L49.5 17.2 L47.3 17.2 Z" fill={SKIN} />
      <path d="M47.4 14.4 L49.4 14.4 L49.5 17.2 L47.3 17.2 Z" fill={PALETTE.shadow} opacity=".2" />
      <Face cx={48.2} cy={12.9} r={2.05} tilt={12} />
      <path
        d="M45.7 13.6 C45.3 11.2 46.6 9.9 48.2 10.0 C49.7 10.1 50.5 11.1 50.5 12.3 C49.7 11.4 47.8 11.2 46.9 12.3 C46.4 13.0 46.2 14.0 46.1 14.8 Z"
        fill={HAIR}
      />
      <path
        d="M46.6 16.8 C47.4 18.0 48.0 18.9 48.5 19.6 C49.2 18.8 50.0 17.8 50.7 16.9 C49.4 16.1 47.7 16.1 46.6 16.8 Z"
        fill={PALETTE.bodyShade}
        opacity=".82"
      />
      {/* near arm folded up, phone at chest height */}
      <Limb d="M50.8 17.8 L52.5 21.8 L49.9 21.4" w={2.1} />
      <Seam d="M51.1 22.4 L51.7 20.8" width={0.7} opacity={0.5} />
      <Hand cx={49.4} cy={20.8} r={1.0} />
      <g transform="rotate(-10 48.9 20.0)">
        <rect x="47.9" y="18.0" width="2.0" height="3.3" rx=".5" fill="#0d141d" />
        <rect x="48.2" y="18.4" width="1.4" height="2.4" rx=".25" fill={SCREEN} opacity=".9" />
      </g>
      {/* screen light spilling onto the face */}
      <path d="M48.6 18.2 L50.4 14.4 L47.2 14.8 Z" fill={SCREEN} opacity=".22" />
      <path d="M46.4 17.4 C47.5 16.5 49.5 16.4 50.7 17.3" fill="none" stroke={PALETTE.line} strokeWidth=".7" opacity=".5" strokeLinecap="round" />
      <Shoe x={46.0} back />
      <Shoe x={50.2} />
    </VehicleSvg>
  );
}

/** Child: shorter, bigger head for the body, backpack, shorts, sneakers. */
export function Child() {
  return (
    <VehicleSvg id={"pedestrian.child"}>
      <Ground x={41} width={16} />
      <Backpack />
      {/* far leg */}
      <Limb d="M46.4 31.6 L46.0 34.9" w={2.5} back />
      <Bare d="M46.0 34.9 L45.7 38.9" w={1.9} back />
      {/* near leg */}
      <Limb d="M49.6 31.6 L49.8 34.9" w={2.6} />
      <Bare d="M49.8 34.9 L49.9 38.9" w={2.0} />
      {/* t-shirt, cap sleeves over bare arms */}
      <Cloth d="M45.8 26.2 C46.4 25.6 47.1 25.5 47.9 25.5 C48.7 25.5 49.4 25.6 50.0 26.2 C50.7 26.8 51.0 27.7 50.9 28.5 C50.9 29.1 50.5 29.4 50.0 29.3 C50.2 30.4 50.4 31.5 50.5 32.2 L45.3 32.2 C45.4 31.5 45.6 30.4 45.8 29.3 C45.3 29.4 44.9 29.1 44.9 28.5 C44.8 27.7 45.1 26.8 45.8 26.2 Z" outline={0.6} />
      <Seam d="M45.2 30.9 C46.9 31.4 48.8 31.4 50.4 30.9" width={0.62} opacity={0.42} />
      {/* shorts */}
      <Cloth d="M45.6 31.4 L50.3 31.4 L50.6 34.2 C50.6 34.7 50.3 35.0 49.8 35.0 L48.5 35.0 L47.9 33.4 L47.3 35.0 L46.0 35.0 C45.5 35.0 45.2 34.7 45.2 34.2 Z" outline={0.6} />
      <path d="M45.6 31.4 L50.3 31.4 L50.4 32.4 L45.5 32.4 Z" fill={PALETTE.shadow} opacity=".22" />
      <Seam d="M45.5 33.3 C46.4 33.7 47.1 33.7 47.7 33.4" width={0.6} opacity={0.4} />
      {/* pack strap over the near shoulder */}
      <path d="M49.6 26.1 C50.2 27.4 50.4 28.6 50.2 29.8" fill="none" stroke={PACK} strokeWidth="1.0" strokeLinecap="round" />
      {/* neck and head */}
      <path d="M47.2 24.4 L49.0 24.4 L49.1 26.6 L47.1 26.6 Z" fill={SKIN} />
      <Face cx={47.9} cy={22.9} r={2.0} />
      <path
        d="M45.6 23.4 C45.2 20.8 46.6 19.6 48.1 19.7 C49.6 19.8 50.4 20.8 50.4 22.0 C49.9 21.2 49.0 21.0 48.2 21.4 C47.4 21.0 46.4 21.4 46.1 22.4 C45.9 23.0 45.8 23.8 45.9 24.4 Z"
        fill={HAIR_CHILD}
      />
      {/* bare arms out of the sleeves */}
      <Bare d="M45.2 29.1 L44.6 32.3" w={1.45} back />
      <Hand cx={44.5} cy={33.4} r={0.85} back />
      <Bare d="M50.6 29.1 L51.2 32.3" w={1.5} />
      <Hand cx={51.4} cy={33.4} r={0.9} />
      <path d="M46.0 26.6 C46.9 25.8 48.9 25.7 50.2 26.5" fill="none" stroke={PALETTE.line} strokeWidth=".65" opacity=".5" strokeLinecap="round" />
      <Shoe x={45.7} k={0.8} sneaker back />
      <Shoe x={49.9} k={0.8} sneaker />
    </VehicleSvg>
  );
}

/** Child mid-stride: one arm up front, one driving back, pack bouncing loose. */
export function ChildWalking() {
  return (
    <VehicleSvg id={"pedestrian.child_walking"}>
      <Ground x={39} width={20} />
      <Backpack x={0.4} y={-1.1} tilt={-11} />
      {/* the loose strap flapping off the bounce */}
      <path d="M46.6 29.2 C47.6 30.0 47.9 31.0 47.5 31.9" fill="none" stroke={PACK} strokeWidth="1.0" strokeLinecap="round" opacity=".85" />
      {/* trailing leg */}
      <Limb d="M46.4 31.8 L44.1 34.8" w={2.5} back />
      <Bare d="M44.1 34.8 L42.5 38.4" w={1.9} back />
      {/* leading leg */}
      <Limb d="M49.8 31.8 L52.1 34.8" w={2.6} />
      <Bare d="M52.1 34.8 L53.7 38.2" w={2.0} />
      <Cloth d="M46.2 26.0 C46.8 25.4 47.5 25.3 48.3 25.3 C49.1 25.3 49.8 25.4 50.4 26.0 C51.1 26.6 51.4 27.5 51.3 28.3 C51.3 28.9 50.9 29.2 50.4 29.1 C50.6 30.2 50.9 31.3 51.0 32.0 L45.4 31.9 C45.6 31.2 45.9 30.2 46.1 29.1 C45.6 29.2 45.3 28.9 45.3 28.3 C45.2 27.5 45.5 26.6 46.2 26.0 Z" outline={0.6} />
      <Seam d="M45.4 30.7 C47.1 31.2 49.0 31.2 50.7 30.7" width={0.62} opacity={0.42} />
      <Cloth d="M45.9 31.2 L50.7 31.4 L51.0 34.1 C51.0 34.6 50.7 34.9 50.2 34.9 L48.8 34.8 L48.3 33.2 L47.5 34.7 L46.2 34.6 C45.7 34.6 45.4 34.3 45.5 33.8 Z" outline={0.6} />
      <path d="M45.9 31.2 L50.7 31.4 L50.8 32.4 L45.8 32.3 Z" fill={PALETTE.shadow} opacity=".22" />
      <path d="M49.9 25.9 C50.5 27.2 50.7 28.4 50.5 29.6" fill="none" stroke={PACK} strokeWidth="1.0" strokeLinecap="round" />
      <path d="M47.6 24.2 L49.4 24.2 L49.5 26.4 L47.5 26.4 Z" fill={SKIN} />
      <Face cx={48.3} cy={22.7} r={2.0} />
      <path
        d="M46.0 23.2 C45.6 20.6 47.0 19.4 48.5 19.5 C50.0 19.6 50.8 20.6 50.8 21.8 C50.3 21.0 49.4 20.8 48.6 21.2 C47.8 20.8 46.8 21.2 46.5 22.2 C46.1 22.4 45.8 22.2 45.6 21.7 C45.4 22.4 45.7 23.0 46.2 23.6 Z"
        fill={HAIR_CHILD}
      />
      {/* bare arms: one driven back clear of the pack, one swung up in front */}
      <Bare d="M45.7 28.9 L43.4 29.6 L41.6 29.2" w={1.45} back />
      <Hand cx={40.8} cy={29.1} r={0.85} back />
      <Bare d="M50.8 28.9 L52.7 28.9 L54.3 26.5" w={1.5} />
      <Hand cx={54.9} cy={25.6} r={0.9} />
      <path d="M46.4 26.4 C47.3 25.6 49.3 25.5 50.5 26.3" fill="none" stroke={PALETTE.line} strokeWidth=".65" opacity=".5" strokeLinecap="round" />
      <Shoe x={42.7} k={0.8} sneaker spin={22} back />
      <Shoe x={53.6} k={0.8} sneaker spin={-16} />
    </VehicleSvg>
  );
}

/** Child standing with a hand up at adult-hand height, ball parked at the feet. */
export function ChildStanding() {
  return (
    <VehicleSvg id={"pedestrian.child_standing"}>
      <Ground x={40} width={22} />
      <Backpack />
      {/* far leg */}
      <Limb d="M46.5 31.6 L46.2 34.9" w={2.5} back />
      <Bare d="M46.2 34.9 L46.0 38.9" w={1.9} back />
      <Limb d="M49.4 31.6 L49.5 34.9" w={2.6} />
      <Bare d="M49.5 34.9 L49.6 38.9" w={2.0} />
      <Cloth d="M45.8 26.2 C46.4 25.6 47.1 25.5 47.9 25.5 C48.7 25.5 49.5 25.7 50.2 26.5 C50.4 27.8 50.5 30.0 50.6 32.2 L45.3 32.2 C45.4 31.5 45.6 30.4 45.8 29.3 C45.3 29.4 44.9 29.1 44.9 28.5 C44.8 27.7 45.1 26.8 45.8 26.2 Z" outline={0.6} />
      <Seam d="M45.2 30.9 C46.9 31.4 48.8 31.4 50.4 30.9" width={0.62} opacity={0.42} />
      <Cloth d="M45.6 31.4 L50.3 31.4 L50.6 34.2 C50.6 34.7 50.3 35.0 49.8 35.0 L48.5 35.0 L47.9 33.4 L47.3 35.0 L46.0 35.0 C45.5 35.0 45.2 34.7 45.2 34.2 Z" outline={0.6} />
      <path d="M45.6 31.4 L50.3 31.4 L50.4 32.4 L45.5 32.4 Z" fill={PALETTE.shadow} opacity=".22" />
      <path d="M49.5 26.1 C50.1 27.4 50.3 28.6 50.1 29.8" fill="none" stroke={PACK} strokeWidth="1.0" strokeLinecap="round" />
      <path d="M47.2 24.4 L49.0 24.4 L49.1 26.6 L47.1 26.6 Z" fill={SKIN} />
      <Face cx={47.9} cy={22.9} r={2.0} tilt={-7} />
      <path
        d="M45.6 23.4 C45.2 20.8 46.6 19.6 48.1 19.7 C49.6 19.8 50.4 20.8 50.4 22.0 C49.9 21.2 49.0 21.0 48.2 21.4 C47.4 21.0 46.4 21.4 46.1 22.4 C45.9 23.0 45.8 23.8 45.9 24.4 Z"
        fill={HAIR_CHILD}
      />
      {/* far arm hanging out of its sleeve */}
      <Bare d="M45.2 29.1 L44.5 32.3" w={1.45} back />
      <Hand cx={44.4} cy={33.4} r={0.85} back />
      {/* near arm reaching up to where an adult's hand would be */}
      <Limb d="M50.2 26.6 L52.3 24.9" w={1.9} />
      <Bare d="M52.3 24.9 L54.1 22.2" w={1.5} />
      <path
        d="M53.9 22.5 C54.4 21.0 55.5 20.4 56.2 20.9 C56.7 21.3 56.5 22.0 56.1 22.6 L55.1 24.0 C54.6 24.6 54.0 24.6 53.6 24.1 C53.3 23.7 53.4 23.2 53.9 22.5 Z"
        fill={SKIN}
      />
      <path
        d="M53.9 22.5 C54.4 21.0 55.5 20.4 56.2 20.9 C56.7 21.3 56.5 22.0 56.1 22.6 L55.1 24.0 C54.6 24.6 54.0 24.6 53.6 24.1 C53.3 23.7 53.4 23.2 53.9 22.5 Z"
        fill="none"
        stroke={SKIN_SHADE}
        strokeWidth=".6"
        opacity=".8"
      />
      <path d="M55.3 20.7 L55.9 21.4 M54.4 21.3 L55.0 22.0" stroke={SKIN_SHADE} strokeWidth=".6" opacity=".55" strokeLinecap="round" />
      <path d="M46.0 26.6 C46.9 25.8 48.9 25.7 50.2 26.5" fill="none" stroke={PALETTE.line} strokeWidth=".65" opacity=".5" strokeLinecap="round" />
      {/* ball parked at the feet */}
      <circle cx="57.6" cy="37.8" r="3.2" fill={WHITE} />
      <circle cx="57.6" cy="37.8" r="3.2" fill={FILL.gloss} />
      <path d="M56.4 35.2 L58.7 35.4 L59.3 37.1 L57.6 38.4 L55.9 37.1 Z" fill="#1d2734" opacity=".8" />
      <path d="M55.3 39.7 L56.7 39.1 L58.1 40.4" fill="none" stroke="#1d2734" strokeWidth=".8" opacity=".6" strokeLinecap="round" />
      <circle cx="57.6" cy="37.8" r="3.2" fill="none" stroke={PALETTE.line} strokeWidth=".65" opacity=".5" />
      <Shoe x={46.0} k={0.8} sneaker back />
      <Shoe x={49.6} k={0.8} sneaker />
    </VehicleSvg>
  );
}

/** Traffic marshal: hi-vis vest and bands, hard hat, stop paddle, work boots. */
export function TrafficMarshal() {
  return (
    <VehicleSvg id={"pedestrian.traffic_marshal"}>
      <Ground x={38} width={22} />
      {/* wide, planted stance */}
      <Limb d="M46.4 26.0 L45.0 32.6 L44.0 38.6" w={2.9} back />
      <Limb d="M50.4 26.0 L51.4 32.6 L52.0 38.6" w={3.1} />
      <path d="M50.8 34.5 L52.9 34.7" stroke={REFLECT} strokeWidth="1.0" opacity=".85" strokeLinecap="round" />
      {/* signalling arm, palm out beside the head */}
      <Limb d="M45.6 18.2 L42.9 21.2 L41.8 15.2" w={2.1} back />
      <path
        d="M40.6 14.6 C40.6 13.1 41.4 12.3 42.2 12.4 C43.1 12.5 43.4 13.4 43.3 14.6 L43.1 16.2 L41.0 16.2 Z"
        fill={SKIN}
        opacity=".84"
      />
      <path
        d="M40.6 14.6 C40.6 13.1 41.4 12.3 42.2 12.4 C43.1 12.5 43.4 13.4 43.3 14.6 L43.1 16.2 L41.0 16.2 Z"
        fill="none"
        stroke={SKIN_SHADE}
        strokeWidth=".6"
        opacity=".6"
      />
      <path d="M41.7 12.7 L41.6 14.4 M42.5 12.8 L42.5 14.4" stroke={SKIN_SHADE} strokeWidth=".6" opacity=".45" strokeLinecap="round" />
      {/* jacket under the vest */}
      <Cloth d="M44.6 20.0 C44.8 18.0 46.1 16.6 48.2 16.4 C50.3 16.2 52.0 17.8 52.2 20.0 L51.9 23.2 C52.1 25.0 52.4 26.8 52.5 28.4 L44.2 28.4 C44.4 26.8 44.6 25.0 44.8 23.2 Z" />
      <Seam d="M44.4 27.0 C47.2 27.7 49.8 27.7 52.4 27.0" width={0.7} opacity={0.5} />
      {/* hi-vis vest with two reflective bands */}
      <path d="M45.6 17.8 L47.7 17.5 L48.7 20.0 L49.9 17.5 L51.8 17.8 L52.0 22.4 L51.8 26.9 L45.5 26.9 L45.4 22.4 Z" fill={HIVIS} />
      <path d="M45.6 17.8 L47.7 17.5 L48.7 20.0 L49.9 17.5 L51.8 17.8 L52.0 22.4 L51.8 26.9 L45.5 26.9 L45.4 22.4 Z" fill={FILL.gloss} />
      <path d="M45.6 17.8 L47.7 17.5 L48.7 20.0 L49.9 17.5 L51.8 17.8 L52.0 22.4 L51.8 26.9 L45.5 26.9 L45.4 22.4 Z" fill="none" stroke={HIVIS_SHADE} strokeWidth=".7" strokeLinejoin="round" />
      <path d="M45.5 21.4 L52.0 21.4 M45.5 24.6 L51.9 24.6" stroke={REFLECT} strokeWidth="1.1" opacity=".92" />
      <path d="M46.7 17.7 L47.4 20.4 M50.8 17.7 L50.1 20.4" stroke={REFLECT} strokeWidth="1.0" opacity=".8" strokeLinecap="round" />
      <path d="M48.7 20.2 L48.8 26.8" stroke={HIVIS_SHADE} strokeWidth=".62" opacity=".7" />
      {/* neck, head, hard hat */}
      <path d="M47.4 15.4 L49.4 15.4 L49.5 18.0 L47.3 18.0 Z" fill={SKIN} />
      <path d="M47.4 15.4 L49.4 15.4 L49.5 18.0 L47.3 18.0 Z" fill={PALETTE.shadow} opacity=".22" />
      <Face cx={48.3} cy={14.4} r={1.95} />
      <path d="M46.3 13.6 C46.1 15.4 46.8 16.6 48.0 16.9" fill="none" stroke="#232b36" strokeWidth=".65" opacity=".9" strokeLinecap="round" />
      <ellipse cx="48.4" cy="12.7" rx="4.5" ry="1.05" fill={HIVIS} />
      <path d="M50.4 11.9 C52.6 11.8 53.7 12.3 53.5 13.0 C53.3 13.6 51.6 13.6 50.0 13.3 Z" fill={HIVIS} />
      <path d="M43.9 12.6 C45.0 13.6 51.8 13.6 52.9 12.6" fill="none" stroke={HIVIS_SHADE} strokeWidth=".65" opacity=".7" />
      <path d="M45.0 12.7 C45.0 10.0 46.4 8.8 48.3 8.8 C50.2 8.8 51.5 10.1 51.5 12.7 Z" fill={HIVIS} />
      <path d="M45.0 12.7 C45.0 10.0 46.4 8.8 48.3 8.8 C50.2 8.8 51.5 10.1 51.5 12.7 Z" fill={FILL.gloss} />
      <path d="M45.0 12.7 C45.0 10.0 46.4 8.8 48.3 8.8 C50.2 8.8 51.5 10.1 51.5 12.7 Z" fill="none" stroke={HIVIS_SHADE} strokeWidth=".65" />
      <path d="M46.6 12.5 C46.7 10.6 47.4 9.4 48.4 9.0" fill="none" stroke={HIVIS_SHADE} strokeWidth=".7" opacity=".8" strokeLinecap="round" />
      {/* paddle arm, extended */}
      <Limb d="M50.9 18.0 L55.4 17.6 L59.6 18.0" w={2.2} />
      <Seam d="M54.6 16.7 L54.8 18.6" width={0.7} opacity={0.5} />
      <Hand cx={60.3} cy={18.1} r={1.15} />
      <path d="M60.7 17.9 L61.3 14.6" fill="none" stroke={PALETTE.rim} strokeWidth="1.1" strokeLinecap="round" />
      <path d="M59.75 7.0 L63.05 7.0 L65.37 9.35 L65.37 12.65 L63.05 15.0 L59.75 15.0 L57.43 12.65 L57.43 9.35 Z" fill="#cf3a30" />
      <path d="M59.75 7.0 L63.05 7.0 L65.37 9.35 L65.37 12.65 L63.05 15.0 L59.75 15.0 L57.43 12.65 L57.43 9.35 Z" fill={FILL.gloss} />
      <path d="M60.25 7.9 L62.6 7.9 L64.25 9.8 L64.25 12.2 L62.6 14.1 L60.25 14.1 L58.55 12.2 L58.55 9.8 Z" fill="none" stroke="#f6f2ec" strokeWidth=".8" opacity=".9" />
      <path d="M59.75 7.0 L63.05 7.0 L65.37 9.35 L65.37 12.65 L63.05 15.0 L59.75 15.0 L57.43 12.65 L57.43 9.35 Z" fill="none" stroke="#8d1f18" strokeWidth=".65" strokeLinejoin="round" />
      <Shoe x={44.0} boot back />
      <Shoe x={52.0} boot />
    </VehicleSvg>
  );
}
