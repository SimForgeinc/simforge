import {
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import { describe, expect, it } from 'vitest';
import {
  applyStaticSemantics,
  parseStaticSemantics,
  STATIC_SEMANTIC_CLASSES,
  STATIC_SEMANTICS_CAPABILITY,
  staticSemanticsCapabilities,
} from './static-semantics';
import { buildVegetation } from './vegetation';

function semanticsRaw(objects: unknown[] = []) {
  return {
    schema: 'uniscenario.static-semantics/v1',
    classes: [...STATIC_SEMANTIC_CLASSES],
    objects,
  };
}

function mesh(name: string): Mesh {
  const result = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  result.name = name;
  return result;
}

describe('static semantic tagging', () => {
  it('tags static layers, streamed tiles, and vegetation with the same authored-name rules', () => {
    const semantics = parseStaticSemantics(semanticsRaw([
      { node: 'Road Segment', class: 'road', instanceId: 1 },
      { node: 'Building01', class: 'building', instanceId: 2 },
      { node: 'Leaves.Mesh', class: 'vegetation', instanceId: 0xffffff },
    ]));

    // GLTFLoader sanitizes the authored space before the static layer reaches us.
    const staticLayer = new Group();
    const roadNode = new Group();
    roadNode.name = 'Road_Segment';
    const roadPrimitive = mesh('road-primitive');
    roadNode.add(roadPrimitive);
    staticLayer.add(roadNode);

    const tile = new Group();
    const building = mesh('Building01');
    tile.add(building);

    const vegetationPrototype = new Group();
    vegetationPrototype.name = 'TreePrototype';
    // The authored period has already been stripped by GLTFLoader.
    vegetationPrototype.add(mesh('LeavesMesh'));
    const vegetation = buildVegetation(vegetationPrototype, {
      prototypes: ['TreePrototype'],
      counts: [1],
      transforms: [...new Matrix4().elements],
      lodKeepCounts: [[1]],
    }, [0]);

    expect(applyStaticSemantics(staticLayer, semantics)).toBe(1);
    expect(applyStaticSemantics(tile, semantics)).toBe(1);
    expect(applyStaticSemantics(vegetation.object, semantics)).toBe(1);

    expect(roadPrimitive.userData).toMatchObject({ semanticClass: 'road', semanticInstanceId: 1 });
    expect(building.userData).toMatchObject({ semanticClass: 'building', semanticInstanceId: 2 });
    expect(vegetation.prototypes[0]?.meshes[0]?.name).toBe('LeavesMesh_instanced');
    expect(vegetation.prototypes[0]?.meshes[0]?.userData).toMatchObject({
      semanticClass: 'vegetation',
      semanticInstanceId: 0xffffff,
    });
  });

  it('does not partially tag when no validated metadata is available', () => {
    const group = new Group();
    const object = mesh('Building01');
    group.add(object);
    expect(applyStaticSemantics(group, null)).toBe(0);
    expect(object.userData.semanticClass).toBeUndefined();
    expect(object.userData.semanticInstanceId).toBeUndefined();
  });
});

describe('static semantic validation', () => {
  it('requires the canonical ordered taxonomy and nonzero RGB24 instance ids', () => {
    const reversedTaxonomy = semanticsRaw([]);
    reversedTaxonomy.classes.reverse();
    expect(() => parseStaticSemantics(reversedTaxonomy)).toThrow(/classes\.0/);

    for (const instanceId of [0, 0x1000000, 1.5, Number.NaN]) {
      expect(() => parseStaticSemantics(semanticsRaw([
        { node: 'Building', class: 'building', instanceId },
      ]))).toThrow(/nonzero RGB24 integer/);
    }
    expect(() => parseStaticSemantics(semanticsRaw([
      { node: 'Building', class: 'vehicle', instanceId: 1 },
    ]))).toThrow(/objects\.0\.class/);
  });

  it('rejects duplicate ids, duplicate nodes, and authored names that GLTFLoader collapses', () => {
    expect(() => parseStaticSemantics(semanticsRaw([
      { node: 'A', class: 'other', instanceId: 1 },
      { node: 'B', class: 'other', instanceId: 1 },
    ]))).toThrow('Duplicate static semantic instanceId: 1');
    expect(() => parseStaticSemantics(semanticsRaw([
      { node: 'A', class: 'other', instanceId: 1 },
      { node: 'A', class: 'other', instanceId: 2 },
    ]))).toThrow('Duplicate static semantic node: A');
    expect(() => parseStaticSemantics(semanticsRaw([
      { node: 'A.B', class: 'other', instanceId: 1 },
      { node: 'AB', class: 'other', instanceId: 2 },
    ]))).toThrow('Static semantic nodes collide in the viewer: A.B and AB');
  });

  it('rejects a malformed semantics file rather than producing partial metadata', () => {
    expect(() => parseStaticSemantics(null)).toThrow(/expected an object/);
    expect(() => parseStaticSemantics({ ...semanticsRaw(), schema: 'wrong' })).toThrow(/schema/);
    expect(() => parseStaticSemantics({ ...semanticsRaw(), objects: 'not-an-array' })).toThrow(/objects/);
    expect(() => parseStaticSemantics(semanticsRaw([
      { node: '', class: 'road', instanceId: 1 },
    ]))).toThrow(/objects\.0\.node/);
  });

  it('reports the map capability only for validated metadata', () => {
    expect(staticSemanticsCapabilities(null)).toEqual([]);
    const semantics = parseStaticSemantics(semanticsRaw([]));
    expect(staticSemanticsCapabilities(semantics)).toEqual([STATIC_SEMANTICS_CAPABILITY]);
  });
});
