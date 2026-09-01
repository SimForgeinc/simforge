import type { Accessor, Document, Material, Primitive, TextureInfo } from '@gltf-transform/core';
import type { Transform as TextureTransform } from '@gltf-transform/extensions';
import { listTextureInfoByMaterial } from '@gltf-transform/functions';

/**
 * Bakes per-slot `KHR_texture_transform` divergence into vertex UV sets.
 *
 * Bevy's `StandardMaterial` carries a single `uv_transform` taken from the
 * base-color slot and applies it to every texture slot (bevy_pbr
 * `pbr_fragment.wgsl` transforms both `uv` and `uv_b` with it). A material
 * whose slots disagree on their transform therefore cannot be represented and
 * bevy_gltf falls back to the base-color transform with only a warning.
 *
 * This pass rewrites exactly those divergent materials: every distinct
 * (source UV set, transform) sampling variant gets its transform baked into a
 * dedicated `TEXCOORD_{0,1}` attribute (spec matrix Translation * Rotation *
 * Scale), the slots are re-pointed at their variant's UV set, and all
 * `KHR_texture_transform` properties on the material are removed. Baking is
 * sampling-exact: wrap modes operate on transformed coordinates, which are
 * identical before and after.
 *
 * Materials whose slots all share the base-color transform on UV0/UV1 are
 * left alone — Bevy represents them natively via `uv_transform`. Materials
 * whose slots agree but sample UV2+ are baked into UV0 the same way. After
 * baking, TEXCOORD_2+ vertex attributes are removed from every primitive.
 *
 * Throws when a material would need more than two sampling variants (the
 * audited corpus maximum is two, and Bevy meshes carry at most UV0/UV1) or
 * when a referenced UV set is missing. Returns the number of materials baked.
 */
export function bakeDivergentTextureTransforms(document: Document): number {
  const root = document.getRoot();
  const primitivesByMaterial = new Map<Material, Primitive[]>();
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      if (material === null) continue;
      let list = primitivesByMaterial.get(material);
      if (list === undefined) primitivesByMaterial.set(material, (list = []));
      list.push(primitive);
    }
  }

  // Baked accessors are cached per (source accessor, transform) so shared
  // UV streams are transformed once and re-shared.
  const bakedCache = new Map<Accessor, Map<string, Accessor>>();
  const replacedSources = new Set<Accessor>();
  let bakedMaterials = 0;

  for (const material of root.listMaterials()) {
    const infos = listTextureInfoByMaterial(material);
    if (infos.length === 0) continue;

    const variantOf = (info: TextureInfo) => {
      const transform = info.getExtension<TextureTransform>('KHR_texture_transform');
      const texCoord = transform?.getTexCoord() ?? info.getTexCoord();
      const matrix = transformMatrix(transform);
      return { texCoord, matrix, key: `${texCoord}|${matrix.join(',')}` };
    };

    const baseInfo = material.getBaseColorTextureInfo();
    // Bevy derives uv_transform exclusively from the base-color slot; a
    // material without a base-color texture renders every slot untransformed.
    const baseKey = baseInfo !== null ? variantOf(baseInfo).key : `0|${IDENTITY.join(',')}`;
    const divergent = infos.some((info) => variantOf(info).key !== baseKey);
    // A material whose slots agree but all sample UV2+ is representable only
    // after its UV set is moved into UV0; route it through the same bake.
    const highUv = infos.some((info) => variantOf(info).texCoord > 1);
    if (!divergent && !highUv) {
      // Bevy reads the sampling UV set from the TextureInfo, not from the
      // transform's texCoord override; make the two agree.
      for (const info of infos) {
        const transform = info.getExtension<TextureTransform>('KHR_texture_transform');
        const override = transform?.getTexCoord() ?? null;
        if (transform && override !== null) {
          info.setTexCoord(override);
          transform.setTexCoord(null);
        }
      }
      continue;
    }

    // Deterministic variant order: the base-color variant claims UV0, the
    // remaining variants follow in sorted-key order.
    const variantSlots = new Map<string, number>([[baseKey, 0]]);
    const otherKeys = [...new Set(infos.map((info) => variantOf(info).key))].filter((key) => key !== baseKey).sort();
    for (const key of otherKeys) variantSlots.set(key, variantSlots.size);
    if (variantSlots.size > 2) {
      throw new Error(`material ${JSON.stringify(material.getName())} needs ${variantSlots.size} sampling variants; Bevy meshes carry at most two UV sets (UV0/UV1)`);
    }

    const primitives = primitivesByMaterial.get(material) ?? [];
    for (const primitive of primitives) {
      // Resolve each variant's baked accessor from this primitive's
      // attributes before reassigning any of them.
      const bakedBySlot = new Map<number, Accessor>();
      for (const info of infos) {
        const { texCoord, matrix, key } = variantOf(info);
        const slot = variantSlots.get(key)!;
        if (bakedBySlot.has(slot)) continue;
        const source = primitive.getAttribute(`TEXCOORD_${texCoord}`);
        if (source === null) {
          throw new Error(`material ${JSON.stringify(material.getName())} samples missing TEXCOORD_${texCoord} on primitive of mesh ${JSON.stringify(primitive.listParents().find((p) => p.propertyType === 'Mesh')?.getName() ?? '')}`);
        }
        bakedBySlot.set(slot, bakeAccessor(document, source, matrix, bakedCache, replacedSources));
      }
      for (const [slot, accessor] of bakedBySlot) {
        primitive.setAttribute(`TEXCOORD_${slot}`, accessor);
      }
    }

    for (const info of infos) {
      const { key } = variantOf(info);
      info.setTexCoord(variantSlots.get(key)!);
      info.setExtension('KHR_texture_transform', null);
    }
    bakedMaterials += 1;
  }

  // Drop source UV accessors that baking left unreferenced.
  for (const accessor of replacedSources) {
    if (accessor.listParents().every((parent) => parent.propertyType === 'Root')) accessor.dispose();
  }
  assertBevyRepresentableSampling(document);
  // No material samples UV2+ anymore; the attributes would only draw
  // "unsupported TEXCOORD_n" warnings from bevy_gltf and cost vertex bytes.
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      for (const semantic of primitive.listSemantics()) {
        if (!/^TEXCOORD_([2-9]|\d{2,})$/.test(semantic)) continue;
        const accessor = primitive.getAttribute(semantic)!;
        primitive.setAttribute(semantic, null);
        if (accessor.listParents().every((parent) => parent.propertyType === 'Root')) accessor.dispose();
      }
    }
  }
  return bakedMaterials;
}

/**
 * Post-condition: every material's slots share the base-color transform (the
 * only model Bevy's material-level `uv_transform` can express) and reference
 * only UV0/UV1. Fails loudly instead of allowing bevy_gltf's warn-and-ignore
 * fallback to lose fidelity silently at load time.
 */
export function assertBevyRepresentableSampling(document: Document): void {
  for (const material of document.getRoot().listMaterials()) {
    const infos = listTextureInfoByMaterial(material);
    if (infos.length === 0) continue;
    const baseInfo = material.getBaseColorTextureInfo();
    const baseTransform = baseInfo?.getExtension<TextureTransform>('KHR_texture_transform') ?? null;
    const baseMatrix = transformMatrix(baseTransform);
    for (const info of infos) {
      const transform = info.getExtension<TextureTransform>('KHR_texture_transform');
      const texCoord = transform?.getTexCoord() ?? info.getTexCoord();
      if (texCoord > 1) {
        throw new Error(`material ${JSON.stringify(material.getName())} still references TEXCOORD_${texCoord}; Bevy supports only UV0/UV1`);
      }
      if (transformMatrix(transform).join(',') !== baseMatrix.join(',')) {
        throw new Error(`material ${JSON.stringify(material.getName())} still has a per-slot texture transform diverging from its base-color slot`);
      }
    }
  }
}

const IDENTITY = [1, 0, 0, 1, 0, 0] as const;

/**
 * Row-major 2x3 affine matrix [a, b, c, d, tx, ty] for
 * u' = a*u + b*v + tx; v' = c*u + d*v + ty, from the KHR_texture_transform
 * spec composition Translation * Rotation * Scale with
 * R = [[cos r, sin r], [-sin r, cos r]].
 */
function transformMatrix(transform: TextureTransform | null | undefined): [number, number, number, number, number, number] {
  if (!transform) return [...IDENTITY];
  const [ox, oy] = transform.getOffset();
  const [sx, sy] = transform.getScale();
  const r = transform.getRotation();
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c * sx, s * sy, -s * sx, c * sy, ox, oy];
}

function bakeAccessor(
  document: Document,
  source: Accessor,
  matrix: [number, number, number, number, number, number],
  cache: Map<Accessor, Map<string, Accessor>>,
  replacedSources: Set<Accessor>,
): Accessor {
  if (matrix.join(',') === IDENTITY.join(',')) return source;
  let byMatrix = cache.get(source);
  if (byMatrix === undefined) cache.set(source, (byMatrix = new Map()));
  const key = matrix.join(',');
  const cached = byMatrix.get(key);
  if (cached !== undefined) return cached;

  const [a, b, c, d, tx, ty] = matrix;
  const count = source.getCount();
  const out = new Float32Array(count * 2);
  const element: [number, number] = [0, 0];
  for (let i = 0; i < count; i += 1) {
    source.getElement(i, element);
    const [u, v] = element;
    out[2 * i] = a * u + b * v + tx;
    out[2 * i + 1] = c * u + d * v + ty;
  }
  const baked = document
    .createAccessor(`${source.getName() || 'uv'}.baked`)
    .setType('VEC2')
    .setArray(out)
    .setBuffer(document.getRoot().listBuffers()[0] ?? null);
  byMatrix.set(key, baked);
  replacedSources.add(source);
  return baked;
}
