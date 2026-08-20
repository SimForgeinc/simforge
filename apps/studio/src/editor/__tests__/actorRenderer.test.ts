import { Group, Quaternion, Vector3, type Mesh } from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActorRenderer,
  disposePropTemplates,
  doorMatrix,
  doorOpenness,
  poseMatrix,
  renderIdentity,
  reverseLightMatrix,
  type ActorView,
} from '../actorRenderer';

const sedan: ActorView = {
  id: 'sedan',
  catalogId: 'vehicle.sedan',
  dims: { l: 9.4, w: 2.73, h: 2.9 },
  x: 12,
  y: 1.5,
  z: -7,
  headingRad: 0.4,
};

afterEach(() => disposePropTemplates());

describe('ActorRenderer semantic transforms', () => {
  it('scales catalog geometry to the simulation-authored dimensions', () => {
    const position = new Vector3();
    const scale = new Vector3();
    poseMatrix(sedan).decompose(position, new Quaternion(), scale);

    expect(position.toArray()).toEqual([12, 1.5, -7]);
    expect(scale.x).toBeCloseTo(2); // 9.4 / catalog length 4.7
    expect(scale.y).toBeCloseTo(2); // 2.9 / catalog height 1.45
    expect(scale.z).toBeCloseTo(1.5); // 2.73 / catalog width 1.82
  });

  it('retains semantic identity unless a catalog model was explicitly authored', () => {
    expect(renderIdentity({ ...sedan, kind: 'animal', catalogId: 'pedestrian.child_walking' }))
      .toEqual({ source: 'semantic', kind: 'animal' });
    expect(renderIdentity({ ...sedan, kind: 'scooter', catalogId: 'vehicle.bicycle' }))
      .toEqual({ source: 'semantic', kind: 'scooter' });
    expect(renderIdentity({ ...sedan, kind: 'static_object', catalogId: 'hazard.cardboard_box' }))
      .toEqual({ source: 'semantic', kind: 'static_object' });
    expect(renderIdentity({
      ...sedan,
      kind: 'static_object',
      catalogId: 'construction.traffic_cone',
      catalogIdAuthored: true,
    })).toEqual({ source: 'catalog', catalogId: 'construction.traffic_cone' });
    expect(renderIdentity({ ...sedan, kind: 'bicycle', catalogId: 'vehicle.bicycle' }))
      .toEqual({ source: 'catalog', catalogId: 'vehicle.bicycle' });
    expect(renderIdentity({ ...sedan, kind: 'bus', catalogId: 'vehicle.bus' }))
      .toEqual({ source: 'catalog', catalogId: 'vehicle.bus' });
  });

  it('presents reverse motion at the rear without flipping body heading', () => {
    const actor = {
      ...sedan,
      x: 0,
      y: 0,
      z: 0,
      headingRad: 0,
      dims: { l: 4.8, w: 2, h: 1.6 },
      reversing: true,
    };
    const position = new Vector3();
    reverseLightMatrix(actor).decompose(position, new Quaternion(), new Vector3());
    expect(position.x).toBeLessThan(-2.4);
    expect(poseMatrix(actor).elements).toEqual(poseMatrix({ ...actor, reversing: false }).elements);
  });

  it('rotates side and rear doors around fixed hinges', () => {
    const actor = { ...sedan, dims: { l: 4.8, w: 2, h: 1.6 } };
    expect(doorOpenness('closed')).toBe(0);
    expect(doorOpenness('opening')).toBe(0.5);
    expect(doorOpenness('closing')).toBe(0.5);
    expect(doorOpenness('open')).toBe(1);

    assertSamePoint(
      new Vector3(0.5, 0, 0).applyMatrix4(doorMatrix(actor, 'left', 'closed')),
      new Vector3(0.5, 0, 0).applyMatrix4(doorMatrix(actor, 'left', 'open')),
    );
    assertSamePoint(
      new Vector3(0, 0.5, 0).applyMatrix4(doorMatrix(actor, 'rear', 'closed')),
      new Vector3(0, 0.5, 0).applyMatrix4(doorMatrix(actor, 'rear', 'open')),
    );
  });

  it('uses stable actor-id slots and releases all renderer-owned objects', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        createElement: () => ({ width: 0, height: 0, getContext: () => null }),
      },
    });
    try {
      const renderer = new ActorRenderer();
      renderer.sync([
        {
          ...sedan,
          id: 'zebra',
          catalogId: 'construction.traffic_cone',
          dims: { l: 0.36, w: 0.36, h: 0.7 },
        },
        {
          ...sedan,
          id: 'alpha',
          catalogId: 'construction.traffic_cone',
          dims: { l: 0.36, w: 0.36, h: 0.7 },
        },
      ]);
      const body = renderer.pickables().find((object) => object.name.startsWith('actor-batch.'));
      expect(body?.userData.actorIds).toEqual(['alpha', 'zebra']);
      expect(renderer.group.children.find((object) => object.name === 'actor-contact-shadows')?.userData.uniscenariosRole).toBe('low-fidelity-hidden');

      renderer.sync([{ ...sedan, id: 'reverse-car', kind: 'car', reversing: true }]);
      const reverseLights = renderer.pickables().find((object) => object.name === 'actor-reverse-lights');
      expect(reverseLights?.userData).toMatchObject({ actorIds: ['reverse-car'], state: 'reversing' });

      renderer.sync([{
        ...sedan,
        id: 'ambulance',
        catalogId: 'vehicle.ambulance',
        dims: { l: 6.1, w: 2.1, h: 2.65 },
        emergency: 'flashing_siren',
        hornActive: true,
      }]);
      const beacon = renderer.group.children.find((object) => object.name === 'actor-emergency-red') as Mesh | undefined;
      expect((beacon?.material as { isMeshBasicMaterial?: boolean } | undefined)?.isMeshBasicMaterial).toBe(true);
      expect(beacon?.userData).toMatchObject({ actorIds: ['ambulance'], state: 'lights.emergency' });

      const parent = new Group();
      parent.add(renderer.group);
      renderer.dispose();
      renderer.dispose();
      expect(renderer.group.children).toHaveLength(0);
      expect(renderer.group.parent).toBeNull();
      expect(renderer.stats).toEqual({ batches: 0, drawCalls: 0 });
    } finally {
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: originalDocument,
      });
    }
  });

  it('keeps one renderer while switching editor, ambient, and playback layers', () => {
    const originalDocument = globalThis.document;
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => ({ width: 0, height: 0, getContext: () => null }) },
    });
    try {
      const renderer = new ActorRenderer();
      renderer.sync([{ ...sedan, id: 'authored' }]);
      renderer.syncLayer('ambient-preview', [{ ...sedan, id: 'ambient', x: 20 }]);
      expect(renderer.pickables().some((mesh) => (mesh.userData.actorIds as string[] | undefined)?.includes('ambient'))).toBe(true);
      renderer.setLayerVisible('editor', false);
      renderer.setLayerVisible('ambient-preview', false);
      renderer.syncLayer('playback', [{ ...sedan, id: 'authored', x: 30 }, { ...sedan, id: 'ambient', x: 40 }]);
      const actorIds = renderer.pickables().flatMap((mesh) => (mesh.userData.actorIds as string[] | undefined) ?? []);
      expect(new Set(actorIds)).toEqual(new Set(['authored', 'ambient']));
      renderer.clearLayer('playback');
      renderer.setLayerVisible('editor', true);
      renderer.setLayerVisible('ambient-preview', true);
      expect(renderer.pickables().some((mesh) => (mesh.userData.actorIds as string[] | undefined)?.includes('authored'))).toBe(true);
      renderer.dispose();
    } finally {
      Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
    }
  });
});

function assertSamePoint(a: Vector3, b: Vector3): void {
  expect(a.distanceTo(b)).toBeLessThan(1e-9);
}

describe('knocked-down bodies', () => {
  const walker: ActorView = {
    id: 'walker',
    catalogId: 'pedestrian.adult',
    dims: { l: 0.6, w: 0.6, h: 1.75 },
    x: 4,
    y: 0,
    z: 2,
    headingRad: 0,
  };

  it('leaves an upright body upright', () => {
    const upright = new Quaternion();
    poseMatrix(walker).decompose(new Vector3(), upright, new Vector3());
    const down = new Quaternion();
    poseMatrix({ ...walker, downProgress: 0 }).decompose(new Vector3(), down, new Vector3());
    expect(down.angleTo(upright)).toBeCloseTo(0, 9);
  });

  it('pitches a fully downed body flat and lifts it off its feet', () => {
    const upright = new Quaternion();
    const uprightPosition = new Vector3();
    poseMatrix(walker).decompose(uprightPosition, upright, new Vector3());

    const rotation = new Quaternion();
    const position = new Vector3();
    poseMatrix({ ...walker, downProgress: 1 }).decompose(position, rotation, new Vector3());

    // A quarter turn: standing to lying.
    expect(rotation.angleTo(upright)).toBeCloseTo(Math.PI / 2, 6);
    // Rotating about the ground-contact origin alone would bury or float it;
    // the body rises by half its narrow dimension so it rests on the surface.
    expect(position.y - uprightPosition.y).toBeCloseTo(0.3, 6);
    // It does not slide horizontally while falling.
    expect(position.x).toBeCloseTo(walker.x, 9);
    expect(position.z).toBeCloseTo(walker.z, 9);
  });

  it('falls monotonically and never past flat', () => {
    const upright = new Quaternion();
    poseMatrix(walker).decompose(new Vector3(), upright, new Vector3());
    const angles = [0, 0.25, 0.5, 0.75, 1].map((downProgress) => {
      const rotation = new Quaternion();
      poseMatrix({ ...walker, downProgress }).decompose(new Vector3(), rotation, new Vector3());
      return rotation.angleTo(upright);
    });
    for (let i = 1; i < angles.length; i += 1) {
      expect(angles[i]!).toBeGreaterThan(angles[i - 1]!);
    }
    expect(angles.at(-1)!).toBeCloseTo(Math.PI / 2, 6);
    // Out-of-range input cannot over-rotate the body.
    const clamped = new Quaternion();
    poseMatrix({ ...walker, downProgress: 4 }).decompose(new Vector3(), clamped, new Vector3());
    expect(clamped.angleTo(upright)).toBeCloseTo(Math.PI / 2, 6);
  });
});
