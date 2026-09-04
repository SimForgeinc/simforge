import { createHash } from 'node:crypto';

import type { Accessor, Document, Material, Node } from '@gltf-transform/core';

import { canonicalJson, sha256 } from './closure.js';

/**
 * Content identity of glTF documents, independent of property indices and
 * buffer layout: what a renderer would sample. Used to prove that a master
 * written from a source export is equivalent to it.
 */

export function accessorDigest(accessor: Accessor): string {
  const array = accessor.getArray();
  const hash = createHash('sha256');
  hash.update(`${accessor.getType()}\0${accessor.getComponentType()}\0${accessor.getNormalized() ? 1 : 0}\0${accessor.getCount()}\0`);
  if (array) hash.update(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  return hash.digest('hex');
}

/** Digest of every image, in `images[]` order, from a serialized document. */
export function jsonImageDigests(json: Record<string, unknown>, bin: Buffer, resources?: Record<string, Uint8Array>): string[] {
  const images = (json['images'] ?? []) as Array<Record<string, unknown>>;
  const views = (json['bufferViews'] ?? []) as Array<Record<string, number>>;
  return images.map((image, index) => {
    if (typeof image['bufferView'] === 'number') {
      const view = views[image['bufferView']]!;
      return sha256(bin.subarray(view['byteOffset'] ?? 0, (view['byteOffset'] ?? 0) + view['byteLength']!));
    }
    const uri = image['uri'];
    if (typeof uri === 'string' && resources && resources[uri]) return sha256(Buffer.from(resources[uri]));
    throw new Error(`image ${index} has neither an embedded bufferView nor a resolvable uri`);
  });
}

/**
 * Sampling-function signature of one material, computed from serialized glTF
 * JSON so that core factors and every extension property are covered without
 * per-extension code. Texture references are replaced by the image digest,
 * sampler, and texture-level extensions so the signature is independent of
 * texture/image/sampler indices. `KHR_texture_basisu` sources are ignored:
 * they are a derived encoding of the same image.
 */
export function materialSignature(json: Record<string, unknown>, material: Record<string, unknown>, imageDigests: string[]): string {
  const textures = (json['textures'] ?? []) as Array<Record<string, unknown>>;
  const samplers = (json['samplers'] ?? []) as Array<Record<string, unknown>>;
  const describeTexture = (index: number): unknown => {
    const texture = textures[index];
    if (!texture) throw new Error(`material references missing texture ${index}`);
    const extensions = { ...((texture['extensions'] as Record<string, unknown> | undefined) ?? {}) };
    delete extensions['KHR_texture_basisu'];
    let image = typeof texture['source'] === 'number' ? (texture['source'] as number) : null;
    for (const [name, value] of Object.entries(extensions)) {
      const source = (value as Record<string, unknown> | null)?.['source'];
      if (typeof source === 'number') {
        image = source;
        extensions[name] = { ...(value as Record<string, unknown>), source: imageDigests[source] };
      }
    }
    if (image === null || imageDigests[image] === undefined) throw new Error(`texture ${index} has no resolvable image`);
    const sampler = typeof texture['sampler'] === 'number' ? samplers[texture['sampler'] as number] ?? null : null;
    return { image: imageDigests[image], sampler, extensions };
  };
  const walk = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((entry) => walk(entry, key));
    if (value === null || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(record)) {
      if (childKey === 'index' && /Texture$/i.test(key) && typeof child === 'number') {
        output['texture'] = describeTexture(child);
      } else {
        output[childKey] = walk(child, childKey);
      }
    }
    return output;
  };
  const { name: _name, ...rest } = material;
  return sha256(canonicalJson(walk(rest, 'material')));
}

export interface PrimitiveSignature {
  mode: number;
  material: string | null;
  indices: string | null;
  attributes: Record<string, string>;
}

export interface NodeSignature {
  name: string;
  matrix: number[];
  primitives: PrimitiveSignature[];
}

export function matricesEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const scale = Math.max(1, Math.abs(left[i]!), Math.abs(right[i]!));
    if (Math.abs(left[i]! - right[i]!) > 1e-5 * scale) return false;
  }
  return true;
}

/**
 * Every mesh-bearing node reachable from the scenes, in traversal order, as
 * (name, world matrix, primitive signatures). `materialDigest` may return
 * `null` for a primitive without a material.
 */
export function sceneNodeSignatures(document: Document, materialDigest: (material: Material | null) => string | null): NodeSignature[] {
  const out: NodeSignature[] = [];
  const visit = (node: Node): void => {
    const mesh = node.getMesh();
    if (mesh !== null) {
      out.push({
        name: node.getName(),
        matrix: [...node.getWorldMatrix()],
        primitives: mesh.listPrimitives().map((primitive) => {
          const indices = primitive.getIndices();
          const attributes: Record<string, string> = {};
          for (const semantic of [...primitive.listSemantics()].sort()) {
            attributes[semantic] = accessorDigest(primitive.getAttribute(semantic)!);
          }
          return { mode: primitive.getMode(), material: materialDigest(primitive.getMaterial()), indices: indices ? accessorDigest(indices) : null, attributes };
        }),
      });
    }
    for (const child of node.listChildren()) visit(child);
  };
  for (const scene of document.getRoot().listScenes()) for (const child of scene.listChildren()) visit(child);
  return out;
}

/**
 * Compares two signature lists after sorting both by a canonical key, so the
 * proof holds regardless of node order. Throws on the first difference.
 */
export function assertSignaturesEquivalent(label: string, expected: NodeSignature[], actual: NodeSignature[]): void {
  if (expected.length !== actual.length) throw new Error(`${label}: ${actual.length} mesh nodes, expected ${expected.length}`);
  const key = (signature: NodeSignature): string =>
    `${signature.name}\0${signature.matrix.map((value) => value.toFixed(4)).join(',')}\0${canonicalJson(signature.primitives)}`;
  const sortedExpected = [...expected].sort((a, b) => key(a).localeCompare(key(b)));
  const sortedActual = [...actual].sort((a, b) => key(a).localeCompare(key(b)));
  for (let i = 0; i < sortedExpected.length; i += 1) {
    const want = sortedExpected[i]!;
    const got = sortedActual[i]!;
    const where = `${label} node ${JSON.stringify(want.name)}`;
    if (want.name !== got.name) throw new Error(`${where}: node set differs (got ${JSON.stringify(got.name)})`);
    if (!matricesEqual(want.matrix, got.matrix)) throw new Error(`${where}: world transform changed`);
    if (want.primitives.length !== got.primitives.length) throw new Error(`${where}: primitive count ${got.primitives.length} != ${want.primitives.length}`);
    for (let p = 0; p < want.primitives.length; p += 1) {
      const a = want.primitives[p]!;
      const b = got.primitives[p]!;
      if (a.mode !== b.mode) throw new Error(`${where} primitive ${p}: mode changed`);
      if (a.indices !== b.indices) throw new Error(`${where} primitive ${p}: index data changed`);
      if (a.material !== b.material) throw new Error(`${where} primitive ${p}: material sampling function changed`);
      const semantics = Object.keys(a.attributes);
      if (semantics.length !== Object.keys(b.attributes).length) throw new Error(`${where} primitive ${p}: vertex attribute set changed`);
      for (const semantic of semantics) {
        if (a.attributes[semantic] !== b.attributes[semantic]) throw new Error(`${where} primitive ${p}: ${semantic} data changed`);
      }
    }
  }
}
