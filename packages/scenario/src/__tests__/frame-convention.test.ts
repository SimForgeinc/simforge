/**
 * Guards the heading convention documented in `schema/v1.ts`.
 *
 * `@simforge/maps/opendrive` maps OpenDRIVE-local (z-up, x-east, y-north) to
 * the scene frame (y-up) with `scene = (x, z, -y)` and no translation
 * (`CoordinateFrame.localToScene`). The transform is reproduced here rather
 * than imported so this package keeps zero runtime dependencies on the renderer
 * side of the tree — if xodr-tools ever changes its axis map, this test is the
 * tripwire that says the scenario schema's heading claim needs revisiting.
 *
 * The claim: an entity's `headingRad` is numerically equal to the OpenDRIVE
 * heading of the same direction, so nothing has to convert it at the frame
 * boundary.
 */

import { describe, expect, it } from 'vitest';

/** Mirror of `CoordinateFrame.localToScene` with a zero scene origin. */
function localToScene(x: number, y: number, z = 0): [number, number, number] {
  return [x, z, -y];
}

/** Rotate `+X` by `heading` radians CCW about `+Y` (right-hand rule): three.js `rotation.y`. */
function forwardFromSceneHeading(heading: number): [number, number, number] {
  return [Math.cos(heading), 0, -Math.sin(heading)];
}

/** OpenDRIVE heading: CCW about `+Z` from `+X`, in the z-up local frame. */
function forwardFromLocalHeading(heading: number): [number, number, number] {
  return [Math.cos(heading), Math.sin(heading), 0];
}

describe('heading convention', () => {
  it('is invariant under the local -> scene transform', () => {
    for (const heading of [0, 0.3, Math.PI / 2, 2.5, Math.PI, -Math.PI / 3, -3]) {
      const local = forwardFromLocalHeading(heading);
      const expected = localToScene(local[0], local[1], local[2]);
      const actual = forwardFromSceneHeading(heading);
      for (let i = 0; i < 3; i++) expect(actual[i]!).toBeCloseTo(expected[i]!, 12);
    }
  });

  it('points +X at OpenDRIVE east and -Z at OpenDRIVE north', () => {
    // heading 0 = east
    expect(forwardFromSceneHeading(0)).toEqual([1, 0, -0]);
    // heading pi/2 = north, which is scene -Z
    const north = forwardFromSceneHeading(Math.PI / 2);
    expect(north[0]).toBeCloseTo(0, 12);
    expect(north[2]).toBeCloseTo(-1, 12);
    expect(localToScene(0, 1, 0)).toEqual([0, 0, -1]);
  });

  it('keeps positions y-up: OpenDRIVE elevation becomes scene y', () => {
    expect(localToScene(10, 20, 3)).toEqual([10, 3, -20]);
  });
});
