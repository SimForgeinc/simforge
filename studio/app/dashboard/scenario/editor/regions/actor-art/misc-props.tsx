"use client";

import { Body, FILL, GROUND, Ground, PALETTE, Seam, VehicleSvg } from "../vehicle-art/parts";

/**
 * The three hazards the panel never listed in a category, plus the fallback for
 * a catalog id nobody has drawn yet — a user-uploaded gallery model, or an
 * entry added to the prop catalog after this file. The old artwork answered
 * every unknown id with a generic block; answering with a crash instead would
 * take the editor down over a picture, so the fallback stays.
 */

/** `hazard.ladder` — extension ladder dropped flat across the lane. */
export function Ladder() {
  const rungs = [0, 1, 2, 3, 4, 5, 6];
  return (
    <VehicleSvg id="hazard.ladder">
      <Ground x={12} width={72} />
      {/* Lower section, lying flat and turned slightly toward the viewer. */}
      <Body d="M13 36.4 82 34.2v3.1L13 39.5Z" outline={0.9} />
      <Body d="M15 32.6 80 30.6v2.9L15 35.5Z" outline={0.9} />
      {rungs.map((index) => {
        const x = 19 + index * 9;
        return (
          <path
            key={index}
            d={`M${x} 35.6 ${x + 1.6} 32.2`}
            stroke={PALETTE.rim}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        );
      })}
      {/* Fly section slid part way out, its foot lifted off the road. */}
      <Body d="M40 29.6 88 26.8v2.6L40 32.1Z" outline={0.9} />
      <Body d="M42 26.2 86 23.6v2.4L42 28.6Z" outline={0.9} />
      {[0, 1, 2, 3, 4].map((index) => {
        const x = 46 + index * 8.6;
        return (
          <path
            key={index}
            d={`M${x} 29 ${x + 1.3} 26`}
            stroke={PALETTE.rim}
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        );
      })}
      <ellipse cx="12.6" cy={GROUND - 1.4} rx="2.2" ry="1.5" fill={PALETTE.tire} />
      <ellipse cx="88.4" cy="27.8" rx="1.9" ry="1.4" fill={PALETTE.tire} />
      <Seam d="M15 33.2 80 31.2" opacity={0.35} />
    </VehicleSvg>
  );
}

/** `hazard.mattress` — shed mattress, folded and slumped. */
export function Mattress() {
  return (
    <VehicleSvg id="hazard.mattress">
      <Ground x={16} width={66} />
      {/* Slab bent over itself: near face, lifted fold, compressed tail. */}
      <Body d="M18 40.6q-2-7 5-9.6l38-9q7-2.2 10 2.4 3 4.6-1.6 7l-33 9.2Z" />
      <Body d="M62 24.4q6-1.4 8.6 2.6 2.6 4-1.4 6.4l-9 2.6q4-3.6 3-7-1-3.4-1.2-4.6Z" outline={0.9} />
      <path
        d="M19 40.4q-1.4-6 4.6-8.4l37-8.8"
        fill="none"
        stroke={FILL.gloss.replace("url(#va-gloss)", PALETTE.line)}
        strokeWidth=".8"
        opacity=".55"
      />
      {/* Quilting: tuft dimples and the piped seam along the edge. */}
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <circle
          key={index}
          cx={26 + index * 6.4}
          cy={35.6 - index * 0.9}
          r=".9"
          fill={PALETTE.bodyShade}
          opacity=".7"
        />
      ))}
      <Seam d="M20 38.6 58 28.6" width={0.9} opacity={0.5} />
      <Seam d="M21.5 41 60 30.4" width={0.7} opacity={0.35} />
      {/* Torn cover corner with the foam showing through. */}
      <path d="M31 30.6q3-2.4 6-.6-2.6 1.4-3 3.4Z" fill={PALETTE.chrome} opacity=".55" />
    </VehicleSvg>
  );
}

/** `hazard.debris` — unsorted scatter of road debris. */
export function Debris() {
  return (
    <VehicleSvg id="hazard.debris">
      <Ground x={14} width={70} />
      {/* Largest chunk: a broken slab of panel or concrete, tipped up. */}
      <Body d="M22 40.4 27 28.6l14 2.6 3 9.4Z" outline={0.9} />
      <Seam d="M28 29.6 41.6 32" opacity={0.5} />
      {/* Mid pieces at different angles so the pile does not read as one mass. */}
      <Body d="M46 40.4 52 33l10 1.4 2 6Z" outline={0.85} />
      <Body d="M62 40.4 66 35.6l8 .8 1.6 4Z" outline={0.8} />
      <Body d="M13.6 40.4 17 34.8l6 1.2 1 4.4Z" outline={0.8} />
      {/* Splintered stick and a shed strip of trim. */}
      <path d="M33 40.2 68 31.4" stroke={PALETTE.rimShade} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M40 40.2 78 36.8" stroke={PALETTE.chrome} strokeWidth="1" strokeLinecap="round" opacity=".7" />
      {/* Grit trail. */}
      {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
        <circle
          key={index}
          cx={17 + index * 9}
          cy={GROUND - 0.6 - (index % 3) * 0.8}
          r={index % 2 ? 0.9 : 1.3}
          fill={PALETTE.bodyShade}
        />
      ))}
    </VehicleSvg>
  );
}

/**
 * Fallback for an id with no drawing: a strapped shipping crate. Neutral enough
 * to stand in for a user-uploaded model without pretending to be one.
 */
export function UnknownProp({ id }: { id: string }) {
  return (
    <VehicleSvg id={id as never}>
      <Ground x={22} width={52} />
      <Body d="M26 40.4V16.6l22-5.2 22 5.2v23.8Z" />
      {/* Lid plane and the two strapping bands that make it read as a crate. */}
      <path d="M26 16.6 48 11.4l22 5.2-22 4.4Z" fill={PALETTE.bodyShade} opacity=".55" />
      <Seam d="M48 21v19.4" opacity={0.5} />
      <path d="M34 18.4v22M62 18.4v22" stroke={PALETTE.chrome} strokeWidth="1.4" opacity=".65" />
      <rect x="42" y="24" width="12" height="8" rx="1" fill={PALETTE.bodyShade} opacity=".7" />
      <path d="M44 28h8" stroke={PALETTE.rim} strokeWidth=".8" opacity=".8" />
    </VehicleSvg>
  );
}
