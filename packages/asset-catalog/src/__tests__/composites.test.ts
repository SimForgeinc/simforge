import { Box3, type Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { getEntry } from '../catalog.js';
import { buildParkedRow, buildWorkZone } from '../composites.js';

function countById(group: Object3D, id: string): number {
  return group.children.filter((child) => child.userData.catalogId === id).length;
}

describe('buildWorkZone', () => {
  it('produces the device counts it reports', () => {
    const zone = buildWorkZone();
    const counts = zone.userData.counts as {
      cones: number;
      drums: number;
      signs: number;
      arrowBoards: number;
      total: number;
    };
    expect(countById(zone, 'construction.traffic_cone')).toBe(counts.cones);
    expect(countById(zone, 'construction.channelizer_drum')).toBe(counts.drums);
    expect(countById(zone, 'construction.sign_road_work')).toBe(counts.signs);
    expect(countById(zone, 'construction.arrow_board')).toBe(counts.arrowBoards);
    expect(zone.children).toHaveLength(counts.total);
  });

  it('spaces taper devices at the requested interval', () => {
    // 60 m taper at 12 m spacing = 6 devices, plus 3 termination cones.
    const zone = buildWorkZone({ taperLength: 60, deviceSpacing: 12, length: 45, drumSpacing: 15 });
    const counts = zone.userData.counts as { cones: number; drums: number };
    expect(counts.cones).toBe(6 + 3);
    expect(counts.drums).toBe(4);
  });

  it('never emits fewer than three taper cones, however short the taper', () => {
    const zone = buildWorkZone({ taperLength: 4, deviceSpacing: 12 });
    expect((zone.userData.counts as { cones: number }).cones).toBe(3 + 3);
  });

  it('lays the taper out from the kerb to the lane line', () => {
    const zone = buildWorkZone({ side: 'right', laneWidth: 3.6, taperLength: 48, length: 30 });
    const cones = zone.children
      .filter((child) => child.userData.catalogId === 'construction.traffic_cone')
      .sort((a, b) => a.position.x - b.position.x);
    const first = cones[0] as Object3D;
    const taperEnd = cones.find((cone) => cone.position.x > 47 && cone.position.x < 49);

    expect(first.position.x).toBeCloseTo(0, 5);
    expect(first.position.z).toBeCloseTo(3.6, 5);
    expect(taperEnd).toBeDefined();
    expect((taperEnd as Object3D).position.z).toBeCloseTo(0, 5);

    // Drums continue along the lane line through the work area.
    const drums = zone.children.filter(
      (child) => child.userData.catalogId === 'construction.channelizer_drum',
    );
    for (const drum of drums) expect(drum.position.z).toBeCloseTo(0, 5);
    expect(Math.max(...drums.map((drum) => drum.position.x))).toBeCloseTo(78, 5);
  });

  it('mirrors the layout for a left-lane closure and flips the arrow', () => {
    const left = buildWorkZone({ side: 'left', laneWidth: 3.6 });
    const cones = left.children.filter(
      (child) => child.userData.catalogId === 'construction.traffic_cone',
    );
    expect(Math.min(...cones.map((cone) => cone.position.z))).toBeLessThan(0);
    expect(Math.max(...cones.map((cone) => cone.position.z))).toBeLessThanOrEqual(0);

    const board = left.children.find(
      (child) => child.userData.catalogId === 'construction.arrow_board',
    );
    expect((board?.userData.params as { direction: string }).direction).toBe('right');
    const rightZone = buildWorkZone({ side: 'right' });
    const rightBoard = rightZone.children.find(
      (child) => child.userData.catalogId === 'construction.arrow_board',
    );
    expect((rightBoard?.userData.params as { direction: string }).direction).toBe('left');
  });

  it('puts the advance warning sign upstream, facing oncoming traffic', () => {
    const zone = buildWorkZone({ advanceWarning: 60 });
    const sign = zone.children.find(
      (child) => child.userData.catalogId === 'construction.sign_road_work',
    );
    expect(sign?.position.x).toBeCloseTo(-60, 5);
    expect(sign?.rotation.y).toBeCloseTo(Math.PI, 5);
  });
});

describe('buildParkedRow', () => {
  it('builds the requested number of vehicles', () => {
    for (const count of [0, 1, 5, 12]) {
      const row = buildParkedRow({ count });
      expect(row.children).toHaveLength(count);
      expect((row.userData.counts as { vehicles: number }).vehicles).toBe(count);
    }
  });

  it('spaces vehicles bumper-to-bumper by the gap and centres the row', () => {
    const gap = 1.2;
    const row = buildParkedRow({ count: 6, gap, seed: 3 });
    row.updateMatrixWorld(true);

    const spans = row.userData.spans as number[];
    const expectedLength = spans.reduce((sum, l) => sum + l, 0) + gap * (spans.length - 1);
    expect(row.userData.rowLength as number).toBeCloseTo(expectedLength, 5);

    const sorted = [...row.children].sort((a, b) => a.position.x - b.position.x);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1] as Object3D;
      const cur = sorted[i] as Object3D;
      const prevHalf = getEntry(prev.userData.catalogId as never).dims.l / 2;
      const curHalf = getEntry(cur.userData.catalogId as never).dims.l / 2;
      const clearance = cur.position.x - curHalf - (prev.position.x + prevHalf);
      expect(clearance).toBeCloseTo(gap, 5);
    }

    const centre = new Box3().setFromObject(row).getCenter(new Vector3());
    expect(Math.abs(centre.x)).toBeLessThan(0.25);
  });

  it('is deterministic for a given seed and varies with it', () => {
    const idsOf = (seed: number): string[] =>
      buildParkedRow({ count: 5, seed }).children.map((child) => String(child.userData.catalogId));
    expect(idsOf(2)).toEqual(idsOf(2));
    expect(idsOf(2)).not.toEqual(idsOf(3));
  });

  it('can face the row the other way', () => {
    const row = buildParkedRow({ count: 3, facing: 'reverse' });
    for (const child of row.children) expect(child.rotation.y).toBeCloseTo(Math.PI, 5);
  });

  it('honours a custom vehicle mix', () => {
    const row = buildParkedRow({ count: 4, mix: ['vehicle.van'] });
    for (const child of row.children) expect(child.userData.catalogId).toBe('vehicle.van');
  });
});
