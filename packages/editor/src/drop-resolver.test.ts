import { describe, expect, it } from 'vitest';
import { DROP_SNAP_RADIUS_M, resolveVehicleDrop } from './drop-resolver';
import type { LaneAnchor } from './document';
import type { LaneIndex } from './laneIndex';

/**
 * A one-lane world: a straight lane along +X at z = 0, 3.5 m wide, 100 m long.
 * Only the three LaneIndex members the resolver touches are implemented; the
 * cast is the boundary between this fixture and the full uniform-grid index.
 */
function straightLaneIndex(): LaneIndex {
  const lane = {
    rsl: 'r1:0:-1',
    roadId: 'r1',
    section: 0,
    laneId: -1,
    length: 100,
    widthM: 3.5,
  };
  const stub = {
    nearestForVehiclePlacement(x: number, z: number, maxRadius = 30) {
      const s = Math.min(100, Math.max(0, x));
      const distance = Math.abs(z);
      if (distance > maxRadius) return null;
      return { lane, s, t: -z, distance, x: s, z: 0, headingRad: 0 };
    },
    lateralLimit(_lane: unknown, bodyWidth = 0) {
      return Math.max(0, 3.5 / 2 - bodyWidth / 2);
    },
    poseAt(_lane: unknown, s: number, t = 0) {
      return { x: s, z: -t, headingRad: 0 };
    },
  };
  // Structural fixture for the three members under test; see docstring.
  return stub as unknown as LaneIndex;
}

describe('resolveVehicleDrop', () => {
  it('snaps within the drop radius: position on lane, heading to travel, offset preserved', () => {
    const resolved = resolveVehicleDrop(straightLaneIndex(), 40, 5, {
      preferredLateralM: 0.5,
      fallbackHeadingRad: 1.2,
      bodyWidthM: 1.8,
    });
    expect(resolved.outcome).toBe('snapped');
    expect(resolved.laneRef).toMatchObject({ roadId: 'r1', laneId: -1, s: 40, t: 0.5, headingOffsetRad: 0 });
    expect(resolved.x).toBe(40);
    expect(resolved.z).toBeCloseTo(-0.5, 6);
    // Heading comes from lane travel, never from the drag.
    expect(resolved.headingRad).toBe(0);
  });

  it('clamps the preserved lateral offset to what the lane can hold', () => {
    const resolved = resolveVehicleDrop(straightLaneIndex(), 40, 0, {
      preferredLateralM: 5,
      bodyWidthM: 1.5,
    });
    expect(resolved.outcome).toBe('snapped');
    expect(resolved.laneRef!.t).toBeCloseTo(1.0, 6); // 3.5/2 − 1.5/2
  });

  it(`places free beyond ${DROP_SNAP_RADIUS_M} m — never refuses`, () => {
    const resolved = resolveVehicleDrop(straightLaneIndex(), 40, DROP_SNAP_RADIUS_M + 1, {
      fallbackHeadingRad: 1.2,
    });
    expect(resolved.outcome).toBe('free');
    expect(resolved.laneRef).toBeNull();
    // The exact drop point and the drag heading survive.
    expect(resolved.x).toBe(40);
    expect(resolved.z).toBe(DROP_SNAP_RADIUS_M + 1);
    expect(resolved.headingRad).toBe(1.2);
  });

  it('places free when the lane anchor cannot start a runtime route', () => {
    const rejected: LaneAnchor[] = [];
    const resolved = resolveVehicleDrop(straightLaneIndex(), 40, 1, {
      fallbackHeadingRad: 0.7,
      routeUsable: (anchor) => {
        rejected.push(anchor);
        return false;
      },
    });
    expect(rejected).toHaveLength(1);
    expect(resolved.outcome).toBe('free');
    expect(resolved.laneRef).toBeNull();
    expect(resolved.x).toBe(40);
    expect(resolved.z).toBe(1);
  });

  it('honours an explicit radius override (one-click re-snap)', () => {
    const resolved = resolveVehicleDrop(straightLaneIndex(), 40, 20, { radiusM: 30 });
    expect(resolved.outcome).toBe('snapped');
    expect(resolved.laneRef!.s).toBe(40);
  });
});
