/**
 * Degenerate-primitive prune in the corpus decode step.
 *
 * Published map tiles can contain a mesh primitive whose POSITION accessor has
 * count 0. glTF requires `accessor.count >= 1`, and such an accessor's bounds
 * serialize as `min:[null,null,null]` / `max:[null,null,null]`, which Bevy's
 * loader rejects — taking the entire scene down, not just the empty mesh. Three
 * Easterbrook LOD0 tiles ship this defect (e.g. mesh `21_18_B_01` in
 * `tile_0_1.lod0`), which is why native full-scene renders could only use
 * `road.glb`.
 *
 * An empty primitive draws nothing, so dropping it is lossless. These tests pin
 * that the decode step prunes it, keeps real geometry untouched, and emits no
 * null bounds.
 */

import { Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { decodeGlb } from '../commands/corpus.js';

/**
 * One mesh with a real triangle plus a sibling primitive whose POSITION
 * accessor is empty — the shape of the defect observed in published tiles.
 */
async function makeGlbWithEmptyPrimitive(io: NodeIO): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();

  const solidPosition = doc
    .createAccessor('solid-position')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]))
    .setBuffer(buffer);
  const solid = doc.createPrimitive().setAttribute('POSITION', solidPosition);

  const emptyPosition = doc
    .createAccessor('empty-position')
    .setType('VEC3')
    .setArray(new Float32Array([]))
    .setBuffer(buffer);
  const empty = doc.createPrimitive().setAttribute('POSITION', emptyPosition);

  const mesh = doc.createMesh('21_18_B_01').addPrimitive(solid).addPrimitive(empty);
  const node = doc.createNode('tile').setMesh(mesh);
  doc.createScene('scene').addChild(node);

  return io.writeBinary(doc);
}

/**
 * A degenerate-only mesh beside a valid one. Written this way because a GLB
 * whose every primitive is empty cannot round-trip through our own writer at
 * all; real defective tiles always carry valid geometry alongside the empty
 * primitive, which is the case worth pinning.
 */
async function makeGlbWithEmptyOnlyMesh(io: NodeIO): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();

  const solidPosition = doc
    .createAccessor('solid-position')
    .setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]))
    .setBuffer(buffer);
  const solidMesh = doc
    .createMesh('solid')
    .addPrimitive(doc.createPrimitive().setAttribute('POSITION', solidPosition));

  const emptyPosition = doc
    .createAccessor('empty-position')
    .setType('VEC3')
    .setArray(new Float32Array([]))
    .setBuffer(buffer);
  const emptyMesh = doc
    .createMesh('empty-only')
    .addPrimitive(doc.createPrimitive().setAttribute('POSITION', emptyPosition));

  const scene = doc.createScene('scene');
  scene.addChild(doc.createNode('solid-tile').setMesh(solidMesh));
  scene.addChild(doc.createNode('empty-tile').setMesh(emptyMesh));
  return io.writeBinary(doc);
}

describe('corpus decode: degenerate primitive prune', () => {
  it('drops a zero-vertex primitive and keeps its real sibling', async () => {
    const io = new NodeIO();
    const { doc, prunedPrimitives } = await decodeGlb(Buffer.from(await makeGlbWithEmptyPrimitive(io)), io);

    expect(prunedPrimitives).toBe(1);

    const meshes = doc.getRoot().listMeshes();
    expect(meshes).toHaveLength(1);

    const primitives = meshes[0]!.listPrimitives();
    expect(primitives).toHaveLength(1);
    expect(primitives[0]!.getAttribute('POSITION')!.getCount()).toBe(3);
  });

  it('drops a mesh left with no primitives', async () => {
    const io = new NodeIO();
    const { doc, prunedPrimitives } = await decodeGlb(Buffer.from(await makeGlbWithEmptyOnlyMesh(io)), io);

    expect(prunedPrimitives).toBe(1);

    const names = doc
      .getRoot()
      .listMeshes()
      .map((mesh) => mesh.getName());
    expect(names).toEqual(['solid']);
  });

  it('emits no null accessor bounds after decode', async () => {
    const io = new NodeIO();
    const { doc } = await decodeGlb(Buffer.from(await makeGlbWithEmptyPrimitive(io)), io);
    const written = JSON.parse(Buffer.from(await io.writeJSON(doc).then((j) => JSON.stringify(j.json))).toString()) as {
      accessors?: { min?: (number | null)[]; max?: (number | null)[] }[];
    };

    for (const accessor of written.accessors ?? []) {
      for (const bound of [...(accessor.min ?? []), ...(accessor.max ?? [])]) {
        expect(bound).not.toBeNull();
      }
    }
  });

  it('leaves a clean GLB untouched', async () => {
    const io = new NodeIO();
    const doc = new Document();
    const buffer = doc.createBuffer();
    const position = doc
      .createAccessor('position')
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer);
    const mesh = doc.createMesh('clean').addPrimitive(doc.createPrimitive().setAttribute('POSITION', position));
    doc.createScene('scene').addChild(doc.createNode('tile').setMesh(mesh));

    const { doc: decoded, prunedPrimitives } = await decodeGlb(Buffer.from(await io.writeBinary(doc)), io);

    expect(prunedPrimitives).toBe(0);
    expect(decoded.getRoot().listMeshes()).toHaveLength(1);
    expect(decoded.getRoot().listMeshes()[0]!.listPrimitives()).toHaveLength(1);
  });
});
