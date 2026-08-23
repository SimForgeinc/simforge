import {
  Color,
  DoubleSide,
  FrontSide,
  Material,
  Mesh,
  MeshBasicMaterial,
  type Side,
} from 'three';
import { isLowFidelityHiddenHelper } from './roads-only';

export type UltraLowLayer = 'road' | 'city' | 'vegetation' | 'actor';

type ColorMaterial = Material & {
  color?: Color;
  opacity?: number;
  transparent?: boolean;
  alphaTest?: number;
  side?: Side;
  vertexColors?: boolean;
};

const PALETTE = {
  asphalt: new Color(0x2f363d),
  grass: new Color(0x47733f),
  concrete: new Color(0x8a8d8d),
  building: new Color(0x9a826c),
  roof: new Color(0x51463f),
  vegetation: new Color(0x356331),
  bark: new Color(0x59402b),
  markingWhite: new Color(0xd7d4c7),
  markingYellow: new Color(0xd4ae45),
  metal: new Color(0x666d72),
  unknown: new Color(0x777f86),
} as const;

export function classifyUltraLowColor(name: string, layer: UltraLowLayer): Color {
  const value = name.toLowerCase();
  if (/yellow/.test(value)) return PALETTE.markingYellow;
  if (/lane.?mark|marking|white.?line/.test(value)) return PALETTE.markingWhite;
  if (/asphalt|road|oilpath|crack/.test(value)) return PALETTE.asphalt;
  if (/grass|groundcover/.test(value)) return PALETTE.grass;
  if (/leaf|bush|foliage|vegetation|pine|oak|maple|cypress/.test(value)) return PALETTE.vegetation;
  if (/bark|trunk|wood/.test(value)) return PALETTE.bark;
  if (/sidewalk|curb|gutter|concrete|cement|pavement/.test(value)) return PALETTE.concrete;
  if (/roof|shingle/.test(value)) return PALETTE.roof;
  if (/building|wall|home|house|stucco|brick/.test(value)) return PALETTE.building;
  if (/metal|steel|signal|lamp|tower|fence/.test(value)) return PALETTE.metal;
  if (layer === 'road') return PALETTE.asphalt;
  if (layer === 'vegetation') return PALETTE.vegetation;
  return PALETTE.unknown;
}

function usableColor(material: ColorMaterial, layer: UltraLowLayer): Color | null {
  if (!material.color?.isColor) return null;
  // Actor paint can legitimately be white. Offline geometry-only materials
  // carry representative texture colors in `color`, so only replace default
  // white when it has no bake marker and is part of the static map.
  const baked = Boolean(material.userData?.uniscenariosGeometryOnly);
  const almostWhite = material.color.r > 0.94 && material.color.g > 0.94 && material.color.b > 0.94;
  return layer !== 'actor' && almostWhite && !baked ? null : material.color;
}

function rounded(value: number): string {
  return Math.max(0, Math.min(1, value)).toFixed(4);
}

/**
 * Converts source PBR materials to cached, texture-free unlit materials.
 * Geometry and mesh groups are untouched, including vertex-color attributes.
 */
export class UltraLowMaterialCache {
  private readonly cache = new Map<string, MeshBasicMaterial>();

  materialFor(mesh: Mesh, source: Material, layer: UltraLowLayer): MeshBasicMaterial {
    const original = source as ColorMaterial;
    const semanticName = `${mesh.name} ${source.name}`;
    const color = usableColor(original, layer)?.clone() ?? classifyUltraLowColor(semanticName, layer).clone();
    const opacity = Math.max(0, Math.min(1, original.opacity ?? 1));
    const alphaTest = Math.max(0, Math.min(1, original.alphaTest ?? 0));
    const side = original.side === DoubleSide ? DoubleSide : FrontSide;
    const vertexColors = Boolean(original.vertexColors || mesh.geometry.getAttribute('color'));
    const key = [color.getHexString(), rounded(opacity), rounded(alphaTest), side, vertexColors ? 1 : 0].join('|');
    let result = this.cache.get(key);
    if (!result) {
      result = new MeshBasicMaterial({
        color,
        opacity,
        transparent: Boolean(original.transparent || opacity < 1),
        alphaTest,
        side,
        vertexColors,
        depthWrite: !(original.transparent || opacity < 1),
        toneMapped: false,
      });
      result.name = `ultra-low:${key}`;
      this.cache.set(key, result);
    }
    return result;
  }

  apply(root: import('three').Object3D, layer: UltraLowLayer, originals: Map<import('three').Object3D, Material | Material[]>): void {
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      // Transparent contact-shadow helpers are disabled by the viewer in low
      // fidelity. Never replace their alpha texture with an opaque flat quad.
      if (isLowFidelityHiddenHelper(mesh)) return;
      if (!originals.has(mesh)) originals.set(mesh, mesh.material);
      const source = originals.get(mesh) ?? mesh.material;
      mesh.material = Array.isArray(source)
        ? source.map((material) => this.materialFor(mesh, material, layer))
        : this.materialFor(mesh, source, layer);
    });
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    this.cache.clear();
  }
}
