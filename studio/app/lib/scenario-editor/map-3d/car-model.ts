/**
 * Actor -> a shaped, procedural mesh description, in metres, with no three.js
 * anywhere near it.
 *
 * The renderer takes a `Map3DActorModel` and does nothing but instantiate boxes
 * and cylinders from it, which is what lets every proportion decision below be
 * asserted in a unit test: that wheels touch the ground, that nothing pokes out
 * of the declared bounding box, that a bus does not get a sports-car roofline.
 *
 * ## Why procedural and not GLB
 *
 * There is no vehicle model in this repository and no licensing decision behind
 * one. A rounded-off body with a cabin, wheels, glass and lamps is a very large
 * step up from the cuboid the docked viewport ships today, costs zero bytes of
 * download, and de-risks the frame bridge against geometry that cannot be
 * wrong. Swapping in category GLBs later is a change to the RENDERER, not to
 * this module's contract.
 *
 * ## Local frame
 *
 * Parts are positioned in the actor's own frame: **+X forward, +Y up, +Z to the
 * actor's right**. The renderer rotates the whole group by
 * `runtimeYawToSceneRotationY(yaw)` about +Y and translates it to the actor's
 * ground contact point, so `y = 0` here means "on the road".
 */

import {
  DEFAULT_VEHICLE_GEOMETRY,
  UE5_VEHICLE_GEOMETRY,
  type VehicleCategory,
} from "@/app/lib/scenario/renderer/actor-geometry";

/**
 * The shapes the 3D mode draws. Deliberately two: every part below is a box or
 * a cylinder, so the renderer holds exactly two shared geometries and every
 * per-actor difference is a scale.
 */
export type Map3DPartShape = "box" | "cylinder";

/**
 * Which material a part takes. `body` is the only one tinted by the actor's
 * authored colour; the rest are fixed so a bright red car still has black tyres
 * and dark glass.
 */
export type Map3DPartMaterial =
  | "body"
  | "bodyDark"
  | "glass"
  | "tyre"
  | "trim"
  | "lampFront"
  | "lampRear";

export interface Map3DPart {
  shape: Map3DPartShape;
  material: Map3DPartMaterial;
  /** Centre of the part in the actor's local frame, metres. */
  position: { x: number; y: number; z: number };
  /** Box extents along local X/Y/Z. Ignored for cylinders. */
  size: { x: number; y: number; z: number };
  /** Cylinder radius, metres. Ignored for boxes. */
  radius?: number;
  /** Cylinder length along its own axis, metres. Ignored for boxes. */
  length?: number;
  /**
   * Which local axis a cylinder's axis lies along. Three's cylinders are Y-up,
   * so the renderer rotates accordingly. Wheels are `"z"` (the axle), poles are
   * `"y"`.
   */
  axis?: "x" | "y" | "z";
}

/** Every category the 3D mode knows how to draw. */
export type Map3DActorCategory =
  | VehicleCategory
  | "bicycle"
  | "motorcycle"
  | "walker"
  | "prop";

export interface Map3DExtents {
  /** Along the actor's forward (+X) axis. */
  lengthM: number;
  /** Across it. */
  widthM: number;
  /** Off the ground. */
  heightM: number;
}

export interface Map3DActorModel {
  category: Map3DActorCategory;
  extents: Map3DExtents;
  parts: Map3DPart[];
}

const BICYCLE_HINTS = ["bicycle", "bike", "crossbike", "gazelle", "omafiets"];
const MOTORCYCLE_HINTS = [
  "motorcycle",
  "harley",
  "yamaha",
  "kawasaki",
  "vespa",
  "ninja",
  "zx125",
];

const TWO_WHEELER_EXTENTS: Record<"bicycle" | "motorcycle", Map3DExtents> = {
  bicycle: { lengthM: 1.8, widthM: 0.6, heightM: 1.7 },
  motorcycle: { lengthM: 2.3, widthM: 0.8, heightM: 1.5 },
};

const WALKER_EXTENTS: Map3DExtents = { lengthM: 0.55, widthM: 0.62, heightM: 1.75 };
const PROP_EXTENTS: Map3DExtents = { lengthM: 1.0, widthM: 1.0, heightM: 1.0 };

/**
 * Blueprint / kind / role -> the category the model is built from.
 *
 * Two-wheelers are detected by blueprint substring, the same way
 * `actor-svgs.tsx` picks its glyph, because neither the physics dump nor the
 * geometry table separates them from cars.
 */
export function resolveMap3DCategory(input: {
  kind?: string | null;
  role?: string | null;
  blueprint?: string | null;
}): Map3DActorCategory {
  const blueprint = (input.blueprint ?? "").toLowerCase();
  if (input.kind === "walker" || blueprint.startsWith("walker.")) return "walker";
  if (input.kind === "prop" || blueprint.startsWith("static.")) return "prop";
  if (BICYCLE_HINTS.some((hint) => blueprint.includes(hint))) return "bicycle";
  if (MOTORCYCLE_HINTS.some((hint) => blueprint.includes(hint))) return "motorcycle";
  return UE5_VEHICLE_GEOMETRY[blueprint]?.category ?? DEFAULT_VEHICLE_GEOMETRY.category;
}

/**
 * True-to-life extents for a category.
 *
 * Vehicles read `UE5_VEHICLE_GEOMETRY` — the only table in the repo carrying a
 * real per-blueprint HEIGHT, which a model needs and a top-down glyph never
 * did. `overrides` lets a caller pass CARLA-measured extents when the draft
 * carries them; nothing does yet, and the signature is here so that when
 * something does, it does not have to reach past this module.
 */
export function resolveMap3DExtents(
  category: Map3DActorCategory,
  blueprint: string | null | undefined,
  overrides?: Partial<Map3DExtents> | null,
): Map3DExtents {
  const base = ((): Map3DExtents => {
    if (category === "walker") return WALKER_EXTENTS;
    if (category === "prop") return PROP_EXTENTS;
    if (category === "bicycle" || category === "motorcycle") {
      return TWO_WHEELER_EXTENTS[category];
    }
    const entry = UE5_VEHICLE_GEOMETRY[(blueprint ?? "").toLowerCase()];
    const geometry = entry ?? DEFAULT_VEHICLE_GEOMETRY;
    return {
      lengthM: geometry.lengthM,
      widthM: geometry.widthM,
      heightM: geometry.heightM,
    };
  })();

  const positive = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

  return {
    lengthM: positive(overrides?.lengthM, base.lengthM),
    widthM: positive(overrides?.widthM, base.widthM),
    heightM: positive(overrides?.heightM, base.heightM),
  };
}

/**
 * Per-category proportions. Every number is a ratio of the actor's own extents,
 * so a Mini and a firetruck are the same code and visibly different vehicles.
 *
 * `cabinCenterRatio` is signed along +X: a car's greenhouse sits slightly
 * BEHIND centre, a cab-over truck's sits at the nose.
 */
interface VehicleProfile {
  /** Wheel radius as a fraction of overall height. */
  wheelRadiusRatio: number;
  /** Where the body's underside sits, as a fraction of wheel radius. */
  clearanceRatio: number;
  /** Beltline height, as a fraction of the span from underside to roof. */
  beltlineRatio: number;
  cabinLengthRatio: number;
  cabinCenterRatio: number;
  cabinWidthRatio: number;
  /** A third axle is drawn for the long categories. */
  axles: 2 | 3;
  /** Wheelbase half-span as a fraction of length. */
  axleSpreadRatio: number;
}

const VEHICLE_PROFILES: Record<VehicleCategory, VehicleProfile> = {
  // Two-wheelers. #459 added these to `VehicleCategory` when the two-wheeler
  // image un-shelved the bike families, but this Record was not extended, so the
  // editor's 3D preview failed to typecheck. Narrow bodies, tall wheels relative
  // to length, and a single "cabin" standing in for the rider.
  bicycle: {
    wheelRadiusRatio: 0.34,
    clearanceRatio: 0.42,
    beltlineRatio: 0.5,
    cabinLengthRatio: 0.34,
    cabinCenterRatio: -0.02,
    cabinWidthRatio: 0.55,
    axles: 2,
    axleSpreadRatio: 0.38,
  },
  motorbike: {
    wheelRadiusRatio: 0.3,
    clearanceRatio: 0.44,
    beltlineRatio: 0.52,
    cabinLengthRatio: 0.38,
    cabinCenterRatio: -0.02,
    cabinWidthRatio: 0.6,
    axles: 2,
    axleSpreadRatio: 0.36,
  },
  car: {
    wheelRadiusRatio: 0.23,
    clearanceRatio: 0.5,
    beltlineRatio: 0.58,
    cabinLengthRatio: 0.5,
    cabinCenterRatio: -0.04,
    cabinWidthRatio: 0.86,
    axles: 2,
    axleSpreadRatio: 0.31,
  },
  van: {
    wheelRadiusRatio: 0.18,
    clearanceRatio: 0.55,
    beltlineRatio: 0.42,
    cabinLengthRatio: 0.78,
    cabinCenterRatio: -0.06,
    cabinWidthRatio: 0.95,
    axles: 2,
    axleSpreadRatio: 0.33,
  },
  truck: {
    wheelRadiusRatio: 0.17,
    clearanceRatio: 0.7,
    beltlineRatio: 0.3,
    cabinLengthRatio: 0.34,
    cabinCenterRatio: 0.29,
    cabinWidthRatio: 0.97,
    axles: 3,
    axleSpreadRatio: 0.34,
  },
  bus: {
    wheelRadiusRatio: 0.16,
    clearanceRatio: 0.7,
    beltlineRatio: 0.26,
    cabinLengthRatio: 0.9,
    cabinCenterRatio: 0,
    cabinWidthRatio: 0.98,
    axles: 2,
    axleSpreadRatio: 0.35,
  },
};

function wheelParts(
  extents: Map3DExtents,
  profile: VehicleProfile,
  wheelRadius: number,
): Map3DPart[] {
  const tyreWidth = Math.max(0.14, extents.widthM * 0.13);
  const halfTrack = extents.widthM / 2 - tyreWidth * 0.42;
  const spread = extents.lengthM * profile.axleSpreadRatio;
  const axlePositions =
    profile.axles === 3 ? [spread, -spread * 0.62, -spread] : [spread, -spread];

  return axlePositions.flatMap((x) =>
    [halfTrack, -halfTrack].map((z): Map3DPart => ({
      shape: "cylinder",
      material: "tyre",
      axis: "z",
      radius: wheelRadius,
      length: tyreWidth,
      position: { x, y: wheelRadius, z },
      size: { x: wheelRadius * 2, y: wheelRadius * 2, z: tyreWidth },
    })),
  );
}

function vehicleParts(
  extents: Map3DExtents,
  category: VehicleCategory,
): Map3DPart[] {
  const profile = VEHICLE_PROFILES[category];
  const { lengthM: L, widthM: W, heightM: H } = extents;

  const wheelRadius = Math.min(H * profile.wheelRadiusRatio, L * 0.13);
  const underside = wheelRadius * profile.clearanceRatio;
  const beltline = underside + (H - underside) * profile.beltlineRatio;

  const lowerHeight = beltline - underside;
  const cabinHeight = H - beltline;
  const cabinLength = L * profile.cabinLengthRatio;
  const cabinCenter = L * profile.cabinCenterRatio;
  const cabinWidth = W * profile.cabinWidthRatio;

  const parts: Map3DPart[] = [
    // Lower body. Full length and width — this is the silhouette that reads at
    // 20 px, so it is the one part that never shrinks.
    {
      shape: "box",
      material: "body",
      position: { x: 0, y: underside + lowerHeight / 2, z: 0 },
      size: { x: L, y: lowerHeight, z: W },
    },
    // A slightly inset dark sill, so the body reads as having a shoulder rather
    // than as a single slab from any angle.
    {
      shape: "box",
      material: "bodyDark",
      position: { x: 0, y: underside + lowerHeight * 0.18, z: 0 },
      size: { x: L * 0.985, y: lowerHeight * 0.34, z: W * 1.012 },
    },
    // Cabin / greenhouse.
    {
      shape: "box",
      material: "body",
      position: { x: cabinCenter, y: beltline + cabinHeight / 2, z: 0 },
      size: { x: cabinLength, y: cabinHeight, z: cabinWidth },
    },
    // Glazing: a band inset into the cabin on all four sides, slightly wider
    // than the cabin so it reads as glass rather than as a decal.
    {
      shape: "box",
      material: "glass",
      position: {
        x: cabinCenter,
        y: beltline + cabinHeight * 0.58,
        z: 0,
      },
      size: {
        x: cabinLength * 0.94,
        y: cabinHeight * 0.56,
        z: cabinWidth * 1.015,
      },
    },
  ];

  parts.push(...wheelParts(extents, profile, wheelRadius));

  const lampY = underside + lowerHeight * 0.62;
  const lampZ = W * 0.34;
  const lampSize = {
    x: Math.min(0.16, L * 0.035),
    y: Math.min(0.22, lowerHeight * 0.3),
    z: Math.min(0.42, W * 0.2),
  };
  for (const z of [lampZ, -lampZ]) {
    parts.push({
      shape: "box",
      material: "lampFront",
      position: { x: L / 2 - lampSize.x / 2, y: lampY, z },
      size: lampSize,
    });
    parts.push({
      shape: "box",
      material: "lampRear",
      position: { x: -L / 2 + lampSize.x / 2, y: lampY, z },
      size: lampSize,
    });
  }

  return parts;
}

function twoWheelerParts(
  extents: Map3DExtents,
  category: "bicycle" | "motorcycle",
): Map3DPart[] {
  const { lengthM: L, widthM: W, heightM: H } = extents;
  const wheelRadius = category === "bicycle" ? H * 0.19 : H * 0.21;
  const tyreWidth = category === "bicycle" ? 0.06 : 0.14;
  const frameY = wheelRadius + (H * 0.42 - wheelRadius) / 2;

  return [
    {
      shape: "box",
      material: "body",
      position: { x: 0, y: frameY, z: 0 },
      size: { x: L * 0.62, y: H * 0.22, z: W * 0.42 },
    },
    // The rider: what actually makes a two-wheeler readable from above.
    {
      shape: "box",
      material: "bodyDark",
      position: { x: -L * 0.05, y: H * 0.72, z: 0 },
      size: { x: L * 0.28, y: H * 0.44, z: W * 0.62 },
    },
    {
      shape: "box",
      material: "trim",
      position: { x: L * 0.3, y: H * 0.62, z: 0 },
      size: { x: L * 0.06, y: H * 0.05, z: W * 0.92 },
    },
    // Wheels sit as far apart as the wheels themselves allow, so the wheelbase
    // reads long without either tyre hanging past the declared length.
    ...[L / 2 - wheelRadius, -(L / 2 - wheelRadius)].map((x): Map3DPart => ({
      shape: "cylinder",
      material: "tyre",
      axis: "z",
      radius: wheelRadius,
      length: tyreWidth,
      position: { x, y: wheelRadius, z: 0 },
      size: { x: wheelRadius * 2, y: wheelRadius * 2, z: tyreWidth },
    })),
  ];
}

function walkerParts(extents: Map3DExtents): Map3DPart[] {
  const { widthM: W, heightM: H } = extents;
  const headRadius = Math.min(0.12, H * 0.07);
  const torsoHeight = H * 0.46;
  const legHeight = H * 0.44;

  return [
    {
      shape: "cylinder",
      material: "bodyDark",
      axis: "y",
      radius: W * 0.17,
      length: legHeight,
      position: { x: 0, y: legHeight / 2, z: 0 },
      size: { x: W * 0.34, y: legHeight, z: W * 0.34 },
    },
    {
      shape: "box",
      material: "body",
      position: { x: 0, y: legHeight + torsoHeight / 2, z: 0 },
      size: { x: W * 0.42, y: torsoHeight, z: W * 0.72 },
    },
    {
      shape: "cylinder",
      material: "trim",
      axis: "y",
      radius: headRadius,
      length: headRadius * 2,
      position: { x: 0, y: H - headRadius, z: 0 },
      size: { x: headRadius * 2, y: headRadius * 2, z: headRadius * 2 },
    },
  ];
}

function propParts(extents: Map3DExtents): Map3DPart[] {
  return [
    {
      shape: "box",
      material: "trim",
      position: { x: 0, y: extents.heightM / 2, z: 0 },
      size: { x: extents.lengthM, y: extents.heightM, z: extents.widthM },
    },
  ];
}

/**
 * Models are immutable and there are eleven blueprints, so the same handful of
 * models is rebuilt for every actor on every playback frame unless they are
 * cached. At 20 Hz with 30 actors that is a few hundred thousand throwaway part
 * objects a minute for no reason.
 */
const modelCache = new Map<string, Map3DActorModel>();

/** Build the full model for one actor. Pure, and memoised on its inputs. */
export function buildMap3DActorModel(input: {
  kind?: string | null;
  role?: string | null;
  blueprint?: string | null;
  extentOverrides?: Partial<Map3DExtents> | null;
}): Map3DActorModel {
  const cacheKey = input.extentOverrides
    ? null
    : `${input.kind ?? ""}|${input.role ?? ""}|${input.blueprint ?? ""}`;
  if (cacheKey) {
    const cached = modelCache.get(cacheKey);
    if (cached) return cached;
  }

  const category = resolveMap3DCategory(input);
  const extents = resolveMap3DExtents(category, input.blueprint, input.extentOverrides);

  const parts =
    category === "walker"
      ? walkerParts(extents)
      : category === "prop"
        ? propParts(extents)
        : category === "bicycle" || category === "motorcycle"
          ? twoWheelerParts(extents, category)
          : vehicleParts(extents, category);

  const model = { category, extents, parts };
  if (cacheKey) modelCache.set(cacheKey, model);
  return model;
}

/**
 * The ground shadow disc's real-world radius for an actor — half its diagonal
 * footprint. The renderer floors this in PIXELS (`locator-scale.ts`) so a
 * zoomed-out actor keeps a visible locator without its model being scaled up.
 */
export function actorFootprintRadiusMeters(extents: Map3DExtents): number {
  return Math.hypot(extents.lengthM, extents.widthM) / 2;
}
