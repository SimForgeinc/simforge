/**
 * TrajectoryFollower unit tests: ego-frame anchoring, signed cross-track
 * projection, lookahead preview marching, the time-indexed speed profile,
 * and reverse-travel setpoints. Closed-loop tracking bounds live in
 * packages/training-env (trajectory-executor.test.ts) where the executor
 * drives the dynamic-v1 backend.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TRAJECTORY_FOLLOWER_CONFIG,
  TrajectoryFollower,
  anchorPlanToWorld,
  type TrajectoryPlanPoint,
} from '../sim/trajectory-follower.js';

/** Straight world-frame plan along +x at y = 0: 8 samples, 5 m/s, 0.5 s apart. */
function straightPlan(speedMps = 5): TrajectoryPlanPoint[] {
  const points: TrajectoryPlanPoint[] = [];
  for (let i = 1; i <= 8; i += 1) {
    points.push({ x: i * speedMps * 0.5, y: 0, headingRad: 0, speedMps, tS: i * 0.5 });
  }
  return points;
}

describe('anchorPlanToWorld', () => {
  it('maps ego-frame FLU samples (x forward, y left) onto the anchor pose', () => {
    const anchor = { x: 10, y: 5, yawRad: Math.PI / 2 };
    const [forward, left] = anchorPlanToWorld(
      [
        { x: 2, y: 0, headingRad: 0, speedMps: 3, tS: 0.1 },
        { x: 0, y: 1, headingRad: 0.2, speedMps: 3, tS: 0.2 },
      ],
      anchor,
    );
    // Facing north (+y): forward = +y, left = -x.
    expect(forward!.x).toBeCloseTo(10, 12);
    expect(forward!.y).toBeCloseTo(7, 12);
    expect(left!.x).toBeCloseTo(9, 12);
    expect(left!.y).toBeCloseTo(5, 12);
    expect(left!.headingRad).toBeCloseTo(Math.PI / 2 + 0.2, 12);
    expect(forward!.speedMps).toBe(3);
    expect(forward!.tS).toBe(0.1);
  });
});

describe('TrajectoryFollower', () => {
  it('projects the pose with a signed cross-track error (+left of the plan)', () => {
    const follower = new TrajectoryFollower();
    follower.setPlan(straightPlan(), 0);
    const left = follower.command({ x: 10, y: 0.8, yawRad: 0, speedMps: 5 }, 0.1);
    expect(left.crossTrackErrorM).toBeCloseTo(0.8, 9);
    expect(left.alongTrackM).toBeCloseTo(7.5, 9); // plan starts at x = 2.5
    const right = follower.command({ x: 10, y: -0.8, yawRad: 0, speedMps: 5 }, 0.1);
    expect(right.crossTrackErrorM).toBeCloseTo(-0.8, 9);
  });

  it('previews the plan a speed-scaled lookahead ahead of the projection', () => {
    const follower = new TrajectoryFollower();
    follower.setPlan(straightPlan(), 0);
    const cmd = follower.command({ x: 10, y: 0, yawRad: 0, speedMps: 5 }, 0.1);
    const { lookaheadBaseM, lookaheadGainS } = DEFAULT_TRAJECTORY_FOLLOWER_CONFIG;
    const expectedArc = 7.5 + lookaheadBaseM + lookaheadGainS * 5;
    expect(cmd.previewPoint.x).toBeCloseTo(2.5 + expectedArc, 9);
    expect(cmd.previewPoint.y).toBeCloseTo(0, 9);
    expect(cmd.previewHeadingRad).toBeCloseTo(0, 9);
  });

  it('clamps the preview at the end of the plan', () => {
    const follower = new TrajectoryFollower();
    const plan = straightPlan();
    follower.setPlan(plan, 0);
    const last = plan[plan.length - 1]!;
    const cmd = follower.command({ x: last.x - 1, y: 0, yawRad: 0, speedMps: 20 }, 0.1);
    expect(cmd.previewPoint).toEqual({ x: last.x, y: last.y });
    expect(cmd.previewHeadingRad).toBe(last.headingRad);
  });

  it('samples the speed profile by plan age with a feedforward slope', () => {
    const follower = new TrajectoryFollower();
    follower.setPlan(
      [
        { x: 1, y: 0, headingRad: 0, speedMps: 2, tS: 1 },
        { x: 9, y: 0, headingRad: 0, speedMps: 6, tS: 3 },
      ],
      10, // plan issued at tS = 10
    );
    const mid = follower.command({ x: 0, y: 0, yawRad: 0, speedMps: 2 }, 12);
    expect(mid.planAgeS).toBeCloseTo(2, 12);
    expect(mid.targetSpeedMps).toBeCloseTo(4, 9);
    expect(mid.targetAccelerationMps2).toBeCloseTo(2, 9);
    const before = follower.command({ x: 0, y: 0, yawRad: 0, speedMps: 2 }, 10.5);
    expect(before.targetSpeedMps).toBeCloseTo(2, 9);
    expect(before.targetAccelerationMps2).toBe(0);
    const after = follower.command({ x: 0, y: 0, yawRad: 0, speedMps: 2 }, 13.5);
    expect(after.targetSpeedMps).toBeCloseTo(6, 9);
    expect(after.targetAccelerationMps2).toBe(0);
  });

  it('flips the motion direction for reverse plans and keeps travel-frame accel', () => {
    const follower = new TrajectoryFollower();
    follower.setPlan(
      [
        { x: -1, y: 0, headingRad: 0, speedMps: -1, tS: 1 },
        { x: -5, y: 0, headingRad: 0, speedMps: -3, tS: 3 },
      ],
      0,
    );
    const cmd = follower.command({ x: 0, y: 0, yawRad: 0, speedMps: 1 }, 2);
    expect(cmd.motionDirection).toBe(-1);
    expect(cmd.targetSpeedMps).toBeCloseTo(2, 9);
    // Signed profile slope -1 m/s²; in the travel frame the body speeds up.
    expect(cmd.targetAccelerationMps2).toBeCloseTo(1, 9);
  });

  it('replaces the held plan on setPlan (zero-order hold until then)', () => {
    const follower = new TrajectoryFollower();
    follower.setPlan(straightPlan(), 0);
    const held = follower.command({ x: 5, y: 0, yawRad: 0, speedMps: 5 }, 1);
    expect(held.targetSpeedMps).toBeCloseTo(5, 12);
    follower.setPlan(straightPlan(9), 1);
    const replaced = follower.command({ x: 5, y: 0, yawRad: 0, speedMps: 5 }, 1.5);
    expect(replaced.targetSpeedMps).toBeCloseTo(9, 12);
    expect(replaced.planAgeS).toBeCloseTo(0.5, 12);
  });

  it('is a pure function of its inputs (bit-identical command streams)', () => {
    const run = (): string => {
      const follower = new TrajectoryFollower();
      follower.setPlan(straightPlan(), 0);
      const out: unknown[] = [];
      for (let i = 0; i < 40; i += 1) {
        out.push(follower.command({ x: i * 0.5, y: Math.sin(i / 3) * 0.4, yawRad: 0.01 * i, speedMps: 5 }, i * 0.1));
      }
      return JSON.stringify(out);
    };
    expect(run()).toBe(run());
  });
});
