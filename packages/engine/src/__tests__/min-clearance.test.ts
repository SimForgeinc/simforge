import { describe, expect, it } from 'vitest';

import { computeMinClearance } from '../trace/min-clearance.js';
import type { SimTrace } from '../trace/trace.js';

/** Car on the x axis; pedestrian parked `lateralM` to the side at x = 0. */
function passTrace(lateralM: number): SimTrace {
  const n = 60;
  const t: number[] = []; const cx: number[] = [];
  for (let i = 0; i < n; i += 1) { t.push(Number((i * 0.1).toFixed(4))); cx.push(-20 + 10 * (i * 0.1)); }
  const fill = (v: number) => new Array(n).fill(v);
  const track = (x: number[], y: number[], h: number) => ({
    x, y, headingRad: fill(h), speedMps: fill(10), lateralOffsetM: fill(0),
    laneRsl: new Array(n).fill(null), s: x.map((_, i) => i), present: fill(1),
  });
  return {
    header: {
      traceVersion: 4, engineVersion: 'test', inputHash: 'h', seed: '1', mapId: 'test',
      engineGraphDigest: 'd', topologyDigest: 'd', dt: 0.1, clipSeconds: 6, warmupSeconds: 0,
      frame: 'xodr-local', actorIds: ['car', 'ped'],
      actorMetadata: {
        car: { kind: 'car', dims: { l: 4.8, w: 1.9, h: 1.5 }, static: false, tags: [] },
        ped: { kind: 'pedestrian', dims: { l: 0.6, w: 0.6, h: 1.75 }, static: true, tags: [] },
      },
    },
    ticks: { t, actors: { car: track(cx, fill(0), 0), ped: track(fill(0), fill(lateralM), 0) } },
    events: [],
    metrics: { collisions: [], minDistance: [], minTTC: null, triggerNeverFired: [], requiredDecelMax: 0, invariantResiduals: [] },
  } as unknown as SimTrace;
}

describe('computeMinClearance', () => {
  it('measures true footprint separation where circumscribed circles report zero', () => {
    // Lateral 1.55 m. Half-widths are 0.95 (car) + 0.30 (ped) = 1.25 -> true gap 0.30 m.
    // Circumscribed radii are 2.58 + 0.42 = 3.00 m, so the engine's broad-phase gap clamps to 0.
    const result = computeMinClearance(passTrace(1.55), 'car', 'ped');
    expect(result).not.toBeNull();
    expect(result!.minClearanceM).toBeCloseTo(0.3, 2);
  });

  it('returns 0 when the footprints actually overlap', () => {
    expect(computeMinClearance(passTrace(0.5), 'car', 'ped')!.minClearanceM).toBe(0);
  });

  it('returns null for an unknown actor', () => {
    expect(computeMinClearance(passTrace(1.55), 'car', 'nope')).toBeNull();
  });

  it('is deterministic', () => {
    const trace = passTrace(1.55);
    expect(JSON.stringify(computeMinClearance(trace, 'car', 'ped')))
      .toBe(JSON.stringify(computeMinClearance(trace, 'car', 'ped')));
  });
});
