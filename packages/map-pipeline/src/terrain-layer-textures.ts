import { open, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Document, GLTF, Material, Texture, TextureInfo } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';

/**
 * RoadRunner terrain reaches us from Unreal's glTF exporter as one material per
 * landscape layer (`Grass1_Ground_Terrain_Ground_Layer0_10`, ...). The exporter
 * resolves the layered landscape material for only some of those layers; the
 * rest are emitted as a flat base-colour factor with no textures, so whole
 * fields render as a single olive or concrete-grey sheet.
 *
 * Every layer of one RoadRunner material shares the same texture set and the
 * same world-scaled UV convention, and the textured siblings are usually in the
 * map - just in another tile. This pass scans the canonical closure once for a
 * textured donor per terrain material base name and gives every untextured
 * sibling that donor's colour/normal/roughness/occlusion textures, samplers,
 * texCoord and KHR_texture_transform, resetting the tint factor to white.
 *
 * Presentation-only: derived closures only, the canonical stays verbatim.
 */

const TERRAIN_MATERIAL = /_Terrain_/;
const LAYER_SUFFIX = /_Layer\d+(?:_\d+)?$/;
const DONOR_SLOTS = ['baseColorTexture', 'normalTexture', 'metallicRoughnessTexture', 'occlusionTexture'] as const;
type DonorSlot = (typeof DONOR_SLOTS)[number];

interface DonorImage {
  mimeType: string;
  bytes: Uint8Array;
  sampler: { magFilter?: GLTF.TextureMagFilter; minFilter?: GLTF.TextureMinFilter; wrapS?: GLTF.TextureWrapMode; wrapT?: GLTF.TextureWrapMode };
}

interface DonorTextureRef {
  image: DonorImage;
  texCoord: number;
  transform?: { offset?: [number, number]; rotation?: number; scale?: [number, number] };
}

export interface TerrainDonor {
  /** Tile the textures were taken from; keeps the choice explainable. */
  source: string;
  material: string;
  slots: Partial<Record<DonorSlot, DonorTextureRef>>;
  metallicFactor: number;
  roughnessFactor: number;
}

export type TerrainDonorPool = Map<string, TerrainDonor>;

export function terrainLayerBase(name: string): string | null {
  if (!TERRAIN_MATERIAL.test(name)) return null;
  return name.replace(LAYER_SUFFIX, '');
}

interface GlbJson {
  materials?: Array<Record<string, unknown>>;
  textures?: Array<{ source?: number; sampler?: number }>;
  images?: Array<{ bufferView?: number; mimeType?: string; uri?: string }>;
  samplers?: Array<DonorImage['sampler']>;
  bufferViews?: Array<{ byteOffset?: number; byteLength: number }>;
}

/** Header + JSON chunk only; the BIN chunk is read lazily per donor image. */
async function readGlbJson(file: string): Promise<{ json: GlbJson; binOffset: number } | null> {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(20);
    await handle.read(header, 0, 20, 0);
    if (header.readUInt32LE(0) !== 0x46546c67) return null;
    const jsonLength = header.readUInt32LE(12);
    const jsonBytes = Buffer.alloc(jsonLength);
    await handle.read(jsonBytes, 0, jsonLength, 20);
    return { json: JSON.parse(jsonBytes.toString('utf8')) as GlbJson, binOffset: 20 + jsonLength + 8 };
  } finally {
    await handle.close();
  }
}

function textureInfoOf(material: Record<string, unknown>, slot: DonorSlot): Record<string, unknown> | undefined {
  if (slot === 'baseColorTexture' || slot === 'metallicRoughnessTexture') {
    return (material.pbrMetallicRoughness as Record<string, unknown> | undefined)?.[slot] as Record<string, unknown> | undefined;
  }
  return material[slot] as Record<string, unknown> | undefined;
}

/**
 * One scan of every tile in the closure: the first textured layer (by tile
 * path, then material index - deterministic) becomes the donor for its base
 * name. Returns only bases that also have at least one untextured layer, so
 * maps without the export gap allocate nothing.
 */
export async function collectTerrainLayerDonors(contentDir: string): Promise<TerrainDonorPool> {
  const tilesDir = path.join(contentDir, '3d', 'tiles');
  const files = (await readdir(tilesDir).catch(() => [] as string[])).filter((name) => name.toLowerCase().endsWith('.glb')).sort();
  const candidates = new Map<string, { file: string; json: GlbJson; binOffset: number; index: number }>();
  const untextured = new Set<string>();
  for (const file of files) {
    const parsed = await readGlbJson(path.join(tilesDir, file));
    if (!parsed) continue;
    (parsed.json.materials ?? []).forEach((material, index) => {
      const base = terrainLayerBase(String(material.name ?? ''));
      if (base === null) return;
      if (textureInfoOf(material, 'baseColorTexture') === undefined) {
        untextured.add(base);
      } else if (!candidates.has(base)) {
        candidates.set(base, { file, json: parsed.json, binOffset: parsed.binOffset, index });
      }
    });
  }
  const pool: TerrainDonorPool = new Map();
  for (const base of untextured) {
    const candidate = candidates.get(base);
    if (!candidate) continue;
    const material = candidate.json.materials![candidate.index]!;
    const handle = await open(path.join(tilesDir, candidate.file), 'r');
    try {
      const slots: TerrainDonor['slots'] = {};
      const imageCache = new Map<number, DonorImage>();
      for (const slot of DONOR_SLOTS) {
        const info = textureInfoOf(material, slot);
        if (info === undefined) continue;
        const texture = candidate.json.textures?.[info.index as number];
        const image = texture?.source === undefined ? undefined : candidate.json.images?.[texture.source];
        if (!texture || !image || image.bufferView === undefined || !image.mimeType) continue;
        let donorImage = imageCache.get(texture.source!);
        if (!donorImage) {
          const view = candidate.json.bufferViews![image.bufferView]!;
          const bytes = Buffer.alloc(view.byteLength);
          await handle.read(bytes, 0, view.byteLength, candidate.binOffset + (view.byteOffset ?? 0));
          donorImage = { mimeType: image.mimeType, bytes, sampler: texture.sampler === undefined ? {} : (candidate.json.samplers?.[texture.sampler] ?? {}) };
          imageCache.set(texture.source!, donorImage);
        }
        const transform = (info.extensions as Record<string, unknown> | undefined)?.KHR_texture_transform as DonorTextureRef['transform'];
        slots[slot] = { image: donorImage, texCoord: (info.texCoord as number | undefined) ?? 0, transform };
      }
      if (slots.baseColorTexture === undefined) continue;
      const pbr = (material.pbrMetallicRoughness ?? {}) as Record<string, number | undefined>;
      pool.set(base, {
        source: candidate.file,
        material: String(material.name),
        slots,
        metallicFactor: pbr.metallicFactor ?? 1,
        roughnessFactor: pbr.roughnessFactor ?? 1,
      });
    } finally {
      await handle.close();
    }
  }
  return pool;
}

export interface TerrainLayerReport {
  retextured: number;
  byBase: Record<string, number>;
}

/** Apply the pool to one tile document; textures are created once per image per document. */
export function borrowTerrainLayerTextures(document: Document, pool: TerrainDonorPool): TerrainLayerReport {
  const report: TerrainLayerReport = { retextured: 0, byBase: {} };
  if (pool.size === 0) return report;
  const textures = new Map<DonorImage, Texture>();
  const transformExtension = document.createExtension(KHRTextureTransform);
  const textureFor = (image: DonorImage): Texture => {
    let texture = textures.get(image);
    if (!texture) {
      texture = document.createTexture().setMimeType(image.mimeType).setImage(image.bytes);
      textures.set(image, texture);
    }
    return texture;
  };
  const bind = (info: TextureInfo | null, ref: DonorTextureRef): void => {
    if (info === null) return;
    info.setTexCoord(ref.texCoord);
    const { sampler } = ref.image;
    if (sampler.magFilter !== undefined) info.setMagFilter(sampler.magFilter);
    if (sampler.minFilter !== undefined) info.setMinFilter(sampler.minFilter);
    if (sampler.wrapS !== undefined) info.setWrapS(sampler.wrapS);
    if (sampler.wrapT !== undefined) info.setWrapT(sampler.wrapT);
    if (ref.transform) {
      const transform = transformExtension.createTransform();
      if (ref.transform.offset) transform.setOffset(ref.transform.offset);
      if (ref.transform.rotation !== undefined) transform.setRotation(ref.transform.rotation);
      if (ref.transform.scale) transform.setScale(ref.transform.scale);
      info.setExtension('KHR_texture_transform', transform);
    }
  };
  for (const material of document.getRoot().listMaterials()) {
    if (material.getBaseColorTexture() !== null) continue;
    const base = terrainLayerBase(material.getName());
    const donor = base === null ? undefined : pool.get(base);
    if (!donor) continue;
    applyDonor(material, donor, textureFor, bind);
    report.retextured += 1;
    report.byBase[base!] = (report.byBase[base!] ?? 0) + 1;
  }
  if (textures.size === 0) transformExtension.dispose();
  return report;
}

function applyDonor(
  material: Material,
  donor: TerrainDonor,
  textureFor: (image: DonorImage) => Texture,
  bind: (info: TextureInfo | null, ref: DonorTextureRef) => void,
): void {
  const { slots } = donor;
  material.setBaseColorTexture(textureFor(slots.baseColorTexture!.image)).setBaseColorFactor([1, 1, 1, 1]);
  bind(material.getBaseColorTextureInfo(), slots.baseColorTexture!);
  if (slots.normalTexture) {
    material.setNormalTexture(textureFor(slots.normalTexture.image));
    bind(material.getNormalTextureInfo(), slots.normalTexture);
  }
  if (slots.metallicRoughnessTexture) {
    material.setMetallicRoughnessTexture(textureFor(slots.metallicRoughnessTexture.image)).setMetallicFactor(donor.metallicFactor).setRoughnessFactor(donor.roughnessFactor);
    bind(material.getMetallicRoughnessTextureInfo(), slots.metallicRoughnessTexture);
  }
  if (slots.occlusionTexture) {
    material.setOcclusionTexture(textureFor(slots.occlusionTexture.image));
    bind(material.getOcclusionTextureInfo(), slots.occlusionTexture);
  }
}
