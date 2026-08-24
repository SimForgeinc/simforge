import { Color, DoubleSide, MeshStandardMaterial } from 'three';

/**
 * One small shared palette for the whole library.
 *
 * Every prop is built from these materials so that a scene assembled out of
 * twenty different props still reads as one set. The look is deliberately
 * flat-ish: `MeshStandardMaterial`, no textures, no metalness except where a
 * surface really is bare metal, and flat shading on everything but glass so the
 * low-segment cylinders and extrusions read as intentional facets rather than
 * as a bad smooth model.
 */
export const PALETTE = {
  /** Default car paint if a caller does not override it. */
  paint: 0x4a6b8a,
  glass: 0x2c3339,
  tire: 0x1d1e20,
  rim: 0x9aa1a8,
  chrome: 0xb9c0c6,
  metal: 0x8d949a,
  steel: 0x6f767c,
  darkPlastic: 0x2a2d31,
  headlight: 0xf6f2e2,
  taillight: 0xc0392b,
  amber: 0xe8892b,
  concrete: 0xb9b6ae,
  asphalt: 0x3c3f43,
  safetyOrange: 0xe2571f,
  safetyWhite: 0xe9e9e6,
  safetyGreen: 0x8fd14f,
  signOrange: 0xf07d1a,
  signWhite: 0xeeeeea,
  wood: 0x8a6a45,
  foliage: 0x4f7a43,
  dirt: 0x7d6a53,
  cardboard: 0xb08a5a,
  fabric: 0xc9c6bd,
  skin: 0xc99a72,
  hair: 0x3b2c22,
  shirt: 0x3f6ea8,
  pants: 0x39404a,
  vest: 0xd8e33a,
  fur: 0x9c7b52,
  mattress: 0xdcd8cc,
} as const;

export type MaterialKey = keyof typeof MATERIAL_SPECS;

interface MaterialSpec {
  color: number;
  roughness: number;
  metalness: number;
  /** Self-lit surfaces (lamps, lit signs) get a matching emissive term. */
  emissiveIntensity?: number;
  smooth?: boolean;
  transparent?: number;
}

const MATERIAL_SPECS = {
  paint: { color: PALETTE.paint, roughness: 0.45, metalness: 0.05 },
  glass: { color: PALETTE.glass, roughness: 0.12, metalness: 0.0, smooth: true },
  tire: { color: PALETTE.tire, roughness: 0.92, metalness: 0.0 },
  rim: { color: PALETTE.rim, roughness: 0.4, metalness: 0.5 },
  chrome: { color: PALETTE.chrome, roughness: 0.28, metalness: 0.7 },
  metal: { color: PALETTE.metal, roughness: 0.5, metalness: 0.45 },
  steel: { color: PALETTE.steel, roughness: 0.6, metalness: 0.35 },
  plastic: { color: PALETTE.darkPlastic, roughness: 0.75, metalness: 0.0 },
  headlight: { color: PALETTE.headlight, roughness: 0.2, metalness: 0.0, emissiveIntensity: 0.35, smooth: true },
  taillight: { color: PALETTE.taillight, roughness: 0.25, metalness: 0.0, emissiveIntensity: 0.3, smooth: true },
  lamp: { color: PALETTE.amber, roughness: 0.3, metalness: 0.0, emissiveIntensity: 0.8, smooth: true },
  concrete: { color: PALETTE.concrete, roughness: 0.95, metalness: 0.0 },
  asphalt: { color: PALETTE.asphalt, roughness: 1.0, metalness: 0.0 },
  safetyOrange: { color: PALETTE.safetyOrange, roughness: 0.7, metalness: 0.0 },
  safetyWhite: { color: PALETTE.safetyWhite, roughness: 0.6, metalness: 0.0 },
  signOrange: { color: PALETTE.signOrange, roughness: 0.55, metalness: 0.0 },
  signWhite: { color: PALETTE.signWhite, roughness: 0.55, metalness: 0.0 },
  wood: { color: PALETTE.wood, roughness: 0.9, metalness: 0.0 },
  foliage: { color: PALETTE.foliage, roughness: 1.0, metalness: 0.0 },
  dirt: { color: PALETTE.dirt, roughness: 1.0, metalness: 0.0 },
  cardboard: { color: PALETTE.cardboard, roughness: 0.95, metalness: 0.0 },
  fabric: { color: PALETTE.fabric, roughness: 0.95, metalness: 0.0 },
  skin: { color: PALETTE.skin, roughness: 0.8, metalness: 0.0, smooth: true },
  hair: { color: PALETTE.hair, roughness: 0.9, metalness: 0.0, smooth: true },
  shirt: { color: PALETTE.shirt, roughness: 0.9, metalness: 0.0, smooth: true },
  pants: { color: PALETTE.pants, roughness: 0.9, metalness: 0.0, smooth: true },
  vest: { color: PALETTE.vest, roughness: 0.8, metalness: 0.0, smooth: true },
  /** Animal coat. Faceted like everything else; colour is per-species. */
  fur: { color: PALETTE.fur, roughness: 0.95, metalness: 0.0 },
  mattress: { color: PALETTE.mattress, roughness: 0.98, metalness: 0.0 },
  chainlink: {
    color: 0xa8adb2,
    roughness: 0.6,
    metalness: 0.4,
    transparent: 0.35,
    smooth: true,
  },
  tarp: { color: PALETTE.fabric, roughness: 0.98, metalness: 0.0, smooth: true },
  /** Architectural glazing — see-through, unlike a car's dark cabin glass. */
  glassPanel: {
    color: 0xbcd2da,
    roughness: 0.08,
    metalness: 0.0,
    transparent: 0.4,
    smooth: true,
  },
} satisfies Record<string, MaterialSpec>;

const cache = new Map<string, MeshStandardMaterial>();

function colorKey(color: number | string): string {
  return typeof color === 'number' ? color.toString(16) : color;
}

/**
 * Fetch a shared material. Passing `color` gives a per-instance override that
 * keeps the palette's shading response — this is how vehicles get their paint
 * without every builder inventing its own material settings. Materials are
 * cached per (key, colour) pair, so a hundred blue sedans share one material.
 */
export function material(key: MaterialKey, color?: number | string): MeshStandardMaterial {
  const spec: MaterialSpec = MATERIAL_SPECS[key];
  const cacheKey = color === undefined ? key : `${key}:${colorKey(color)}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const resolved = new Color(color === undefined ? spec.color : (color as number));
  const mat = new MeshStandardMaterial({
    color: resolved,
    roughness: spec.roughness,
    metalness: spec.metalness,
    flatShading: spec.smooth !== true,
  });
  if (spec.emissiveIntensity) {
    mat.emissive = resolved.clone();
    mat.emissiveIntensity = spec.emissiveIntensity;
  }
  if (spec.transparent !== undefined) {
    mat.transparent = true;
    mat.opacity = spec.transparent;
    mat.side = DoubleSide;
    mat.depthWrite = false;
  }
  mat.name = cacheKey;
  cache.set(cacheKey, mat);
  return mat;
}

/** Drop every cached material (tests / hot reload). */
export function disposeMaterials(): void {
  for (const mat of cache.values()) mat.dispose();
  cache.clear();
}

/** A pleasant, deliberately unsaturated spread of real car colours. */
export const VEHICLE_COLORS = [
  '#e8e9ea', // white
  '#25282c', // black
  '#8d9298', // silver
  '#5a6068', // grey
  '#2f4f74', // blue
  '#8f2f2f', // red
  '#2f5b45', // green
  '#b0885a', // beige
  '#7a4b8c', // plum
  '#c9762a', // orange
] as const;

/** Deterministic colour pick, for parked rows and other generated groups. */
export function vehicleColor(index: number): string {
  const list = VEHICLE_COLORS;
  return list[((index % list.length) + list.length) % list.length] as string;
}
