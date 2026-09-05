import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Document, GLTF, Material, Texture, TextureInfo } from '@gltf-transform/core';
import { KHRTextureTransform } from '@gltf-transform/extensions';
import type { Transform as TextureTransform } from '@gltf-transform/extensions';

/**
 * RoadRunner terrain reaches us from Unreal's glTF exporter as one material per
 * landscape layer (`Grass1_Ground_Terrain_Ground_Layer0_10`, ...). The exporter
 * resolves the layered landscape material for only some of those layers; the
 * rest are emitted as a flat base-colour factor with no textures, so whole
 * fields render as a single olive or concrete-grey sheet.
 *
 * Every layer of one RoadRunner material shares the same texture set and the
 * same world-scaled UV convention, and a textured sibling is usually in the
 * map. This pass gives every untextured layer its sibling's colour, normal,
 * roughness and occlusion textures, sampler, texCoord and
 * KHR_texture_transform, resetting the tint factor to white. Bases the map
 * cannot donate itself may come from a library of other maps' masters:
 * RoadRunner library materials share one texture set across every export.
 *
 * Applied to the master as a JSON-level edit; the source export stays verbatim
 * in the registry and every retextured material is listed in the report.
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
  /** Master the textures were taken from; keeps the choice explainable. */
  source: string;
  material: string;
  slots: Partial<Record<DonorSlot, DonorTextureRef>>;
  metallicFactor: number;
  roughnessFactor: number;
}

export type TerrainDonorPool = Map<string, TerrainDonor>;

/** `SIMFORGE_TERRAIN_DONOR_MASTERS`: path-separated `master.gltf` files used as a donor library. */
export function terrainDonorLibrary(): string[] {
  const raw = process.env['SIMFORGE_TERRAIN_DONOR_MASTERS'];
  if (!raw) return [];
  return raw.split(path.delimiter).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** Content identity of a pool: what was retextured with which bytes. */
export function terrainDonorPoolDigest(pool: TerrainDonorPool): string {
  const hash = createHash('sha256');
  for (const base of [...pool.keys()].sort()) {
    const donor = pool.get(base)!;
    hash.update(base).update('\0').update(donor.material).update('\0');
    for (const slot of DONOR_SLOTS) {
      const ref = donor.slots[slot];
      if (!ref) continue;
      hash.update(slot).update('\0').update(createHash('sha256').update(ref.image.bytes).digest()).update(JSON.stringify([ref.texCoord, ref.transform ?? null, ref.image.sampler])).update('\0');
    }
    hash.update(JSON.stringify([donor.metallicFactor, donor.roughnessFactor])).update('\0');
  }
  return hash.digest('hex');
}

export function terrainLayerBase(name: string): string | null {
  if (!TERRAIN_MATERIAL.test(name)) return null;
  return name.replace(LAYER_SUFFIX, '');
}

/** Terrain bases with at least one untextured layer in the document. */
function untexturedBases(document: Document): Set<string> {
  const bases = new Set<string>();
  for (const material of document.getRoot().listMaterials()) {
    const base = terrainLayerBase(material.getName());
    if (base !== null && material.getBaseColorTexture() === null) bases.add(base);
  }
  return bases;
}

interface MasterJson {
  materials?: Array<Record<string, unknown>>;
  textures?: Array<{ source?: number; sampler?: number }>;
  images?: Array<{ mimeType?: string; uri?: string }>;
  samplers?: Array<DonorImage['sampler']>;
}

function textureInfoOf(material: Record<string, unknown>, slot: DonorSlot): Record<string, unknown> | undefined {
  if (slot === 'baseColorTexture' || slot === 'metallicRoughnessTexture') {
    return (material['pbrMetallicRoughness'] as Record<string, unknown> | undefined)?.[slot] as Record<string, unknown> | undefined;
  }
  return material[slot] as Record<string, unknown> | undefined;
}

/**
 * Donors for `bases` from a library of other maps' masters, in order; the
 * first textured layer per base wins. Only the referenced PNGs are read.
 */
export async function collectLibraryDonors(bases: ReadonlySet<string>, library: readonly string[] = terrainDonorLibrary()): Promise<TerrainDonorPool> {
  const pool: TerrainDonorPool = new Map();
  for (const masterPath of library) {
    if (bases.size === pool.size) break;
    const json = JSON.parse(await readFile(masterPath, 'utf8')) as MasterJson;
    const directory = path.dirname(masterPath);
    const images = new Map<number, DonorImage>();
    for (const [index, material] of (json.materials ?? []).entries()) {
      const base = terrainLayerBase(String(material['name'] ?? ''));
      if (base === null || !bases.has(base) || pool.has(base)) continue;
      const slots: TerrainDonor['slots'] = {};
      for (const slot of DONOR_SLOTS) {
        const info = textureInfoOf(material, slot);
        if (info === undefined) continue;
        const texture = json.textures?.[info['index'] as number];
        const image = texture?.source === undefined ? undefined : json.images?.[texture.source];
        if (!texture || !image?.uri || !image.mimeType) continue;
        let donorImage = images.get(texture.source!);
        if (!donorImage) {
          donorImage = { mimeType: image.mimeType, bytes: await readFile(path.join(directory, decodeURIComponent(image.uri))), sampler: texture.sampler === undefined ? {} : (json.samplers?.[texture.sampler] ?? {}) };
          images.set(texture.source!, donorImage);
        }
        slots[slot] = { image: donorImage, texCoord: (info['texCoord'] as number | undefined) ?? 0, transform: (info['extensions'] as Record<string, unknown> | undefined)?.['KHR_texture_transform'] as DonorTextureRef['transform'] };
      }
      if (slots.baseColorTexture === undefined) continue;
      const pbr = (material['pbrMetallicRoughness'] ?? {}) as Record<string, number | undefined>;
      pool.set(base, { source: `${masterPath}#materials/${index}`, material: String(material['name']), slots, metallicFactor: pbr.metallicFactor ?? 1, roughnessFactor: pbr.roughnessFactor ?? 1 });
    }
  }
  return pool;
}

export interface TerrainLayerReport {
  retextured: number;
  byBase: Record<string, { donor: string; materials: string[] }>;
  /** Bases with untextured layers that no donor could be found for. */
  undonated: string[];
}

function copyTextureInfo(from: TextureInfo, to: TextureInfo, transforms: ReturnType<Document['createExtension']>): void {
  to.setTexCoord(from.getTexCoord()).setMagFilter(from.getMagFilter()).setMinFilter(from.getMinFilter()).setWrapS(from.getWrapS()).setWrapT(from.getWrapT());
  const transform = from.getExtension<TextureTransform>('KHR_texture_transform');
  if (transform) {
    to.setExtension('KHR_texture_transform', (transforms as KHRTextureTransform).createTransform().setOffset(transform.getOffset()).setRotation(transform.getRotation()).setScale(transform.getScale()).setTexCoord(transform.getTexCoord()));
  }
}

/**
 * Retexture every untextured terrain layer of `document`. In-map donors (the
 * first textured layer of the same base, by material order) win; `library`
 * donors fill the rest. Returns what was changed and what could not be.
 */
export function borrowTerrainLayerTextures(document: Document, library: TerrainDonorPool = new Map()): TerrainLayerReport {
  const report: TerrainLayerReport = { retextured: 0, byBase: {}, undonated: [] };
  const bases = untexturedBases(document);
  if (bases.size === 0) return report;
  const root = document.getRoot();
  const inMap = new Map<string, Material>();
  for (const material of root.listMaterials()) {
    const base = terrainLayerBase(material.getName());
    if (base !== null && bases.has(base) && material.getBaseColorTexture() !== null && !inMap.has(base)) inMap.set(base, material);
  }
  const transforms = document.createExtension(KHRTextureTransform);
  const libraryTextures = new Map<DonorImage, Texture>();
  const textureFor = (image: DonorImage): Texture => {
    let texture = libraryTextures.get(image);
    if (!texture) libraryTextures.set(image, (texture = document.createTexture().setMimeType(image.mimeType).setImage(image.bytes)));
    return texture;
  };
  const bindLibrary = (info: TextureInfo | null, ref: DonorTextureRef): void => {
    if (info === null) return;
    info.setTexCoord(ref.texCoord);
    const { sampler } = ref.image;
    if (sampler.magFilter !== undefined) info.setMagFilter(sampler.magFilter);
    if (sampler.minFilter !== undefined) info.setMinFilter(sampler.minFilter);
    if (sampler.wrapS !== undefined) info.setWrapS(sampler.wrapS);
    if (sampler.wrapT !== undefined) info.setWrapT(sampler.wrapT);
    if (ref.transform) {
      const transform = transforms.createTransform();
      if (ref.transform.offset) transform.setOffset(ref.transform.offset);
      if (ref.transform.rotation !== undefined) transform.setRotation(ref.transform.rotation);
      if (ref.transform.scale) transform.setScale(ref.transform.scale);
      info.setExtension('KHR_texture_transform', transform);
    }
  };

  for (const material of root.listMaterials()) {
    if (material.getBaseColorTexture() !== null) continue;
    const base = terrainLayerBase(material.getName());
    if (base === null) continue;
    const sibling = inMap.get(base);
    const donor = sibling ? undefined : library.get(base);
    if (!sibling && !donor) {
      if (!report.undonated.includes(base)) report.undonated.push(base);
      continue;
    }
    if (sibling) {
      material.setBaseColorTexture(sibling.getBaseColorTexture()).setBaseColorFactor([1, 1, 1, 1]);
      copyTextureInfo(sibling.getBaseColorTextureInfo()!, material.getBaseColorTextureInfo()!, transforms);
      if (sibling.getNormalTexture()) {
        material.setNormalTexture(sibling.getNormalTexture()).setNormalScale(sibling.getNormalScale());
        copyTextureInfo(sibling.getNormalTextureInfo()!, material.getNormalTextureInfo()!, transforms);
      }
      if (sibling.getMetallicRoughnessTexture()) {
        material.setMetallicRoughnessTexture(sibling.getMetallicRoughnessTexture()).setMetallicFactor(sibling.getMetallicFactor()).setRoughnessFactor(sibling.getRoughnessFactor());
        copyTextureInfo(sibling.getMetallicRoughnessTextureInfo()!, material.getMetallicRoughnessTextureInfo()!, transforms);
      }
      if (sibling.getOcclusionTexture()) {
        material.setOcclusionTexture(sibling.getOcclusionTexture()).setOcclusionStrength(sibling.getOcclusionStrength());
        copyTextureInfo(sibling.getOcclusionTextureInfo()!, material.getOcclusionTextureInfo()!, transforms);
      }
    } else {
      const { slots } = donor!;
      material.setBaseColorTexture(textureFor(slots.baseColorTexture!.image)).setBaseColorFactor([1, 1, 1, 1]);
      bindLibrary(material.getBaseColorTextureInfo(), slots.baseColorTexture!);
      if (slots.normalTexture) {
        material.setNormalTexture(textureFor(slots.normalTexture.image));
        bindLibrary(material.getNormalTextureInfo(), slots.normalTexture);
      }
      if (slots.metallicRoughnessTexture) {
        material.setMetallicRoughnessTexture(textureFor(slots.metallicRoughnessTexture.image)).setMetallicFactor(donor!.metallicFactor).setRoughnessFactor(donor!.roughnessFactor);
        bindLibrary(material.getMetallicRoughnessTextureInfo(), slots.metallicRoughnessTexture);
      }
      if (slots.occlusionTexture) {
        material.setOcclusionTexture(textureFor(slots.occlusionTexture.image));
        bindLibrary(material.getOcclusionTextureInfo(), slots.occlusionTexture);
      }
    }
    const entry = (report.byBase[base] ??= { donor: sibling ? `material:${sibling.getName()}` : donor!.source, materials: [] });
    entry.materials.push(material.getName());
    report.retextured += 1;
  }
  report.undonated.sort();
  if (transforms.listProperties().length === 0) transforms.dispose();
  return report;
}
