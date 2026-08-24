import { describe, expect, it } from 'vitest';

import { computeRealizedPet } from '../trace/realized-pet.js';
import type { SimTrace } from '../trace/trace.js';

/**
 * Two actors crossing at the origin. `a` clears the point, then `b` arrives.
 * dt = 0.1 s; both footprints 4.8 x 1.9 m so half-length is 2.4 m.
 */
function crossingTrace(bOffsetM: number): SimTrace {
  const n = 120;
  const t: number[] = [];
  const ax: number[] = []; const ay: number[] = [];
  const bx: number[] = []; const by: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const time = i * 0.1;
    t.push(Number(time.toFixed(4)));
    ax.push(-30 + 10 * time); ay.push(0);      // a drives +x at 10 m/s through (0,0)
    bx.push(0); by.push(-30 - bOffsetM + 10 * time); // b drives +y at 10 m/s through (0,0)
  }
  const track = (x: number[], y: number[], headingRad: number) => ({
    x, y,
    headingRad: new Array(n).fill(headingRad),
    speedMps: new Array(n).fill(10),
    lateralOffsetM: new Array(n).fill(0),
    laneRsl: new Array(n).fill(null),
    s: x.map((_, i) => i),
    present: new Array(n).fill(1),
  });
  return {
    header: {
      traceVersion: 4, engineVersion: 'test', inputHash: 'h', seed: '1', mapId: 'test',
      engineGraphDigest: 'd', topologyDigest: 'd', dt: 0.1, clipSeconds: 12, warmupSeconds: 0,
      frame: 'xodr-local', actorIds: ['a', 'b'],
      actorMetadata: {
        a: { kind: 'car', dims: { l: 4.8, w: 1.9, h: 1.5 }, static: false, tags: [] },
        b: { kind: 'car', dims: { l: 4.8, w: 1.9, h: 1.5 }, static: false, tags: [] },
      },
    },
    ticks: { t, actors: { a: track(ax, ay, 0), b: track(bx, by, Math.PI / 2) } },
    events: [],
    metrics: {
      collisions: [], minDistance: [], minTTC: null, triggerNeverFired: [],
      minPET: null, minPathTTC: null,
      requiredDecelMax: 0, invariantResiduals: [],
    },
  } as unknown as SimTrace;
}

describe('computeRealizedPet', () => {
  it('measures the gap between the first actor clearing and the second entering', () => {
    // b starts 30 m further back, so it reaches the origin 3 s later than a.
    const status = computeRealizedPet(crossingTrace(30), 'a', 'b', { x: 0, y: 0 });
    expect(status.kind).toBe('ok');
    if (status.kind !== 'ok') return;
    expect(status.result.firstActor).toBe('a');
    expect(status.result.secondActor).toBe('b');
    // a clears (0,0) when its rear half-length passes: +2.4 m => t = 3.24 s.
    // b enters when its front reaches -2.4 m of the point => t = 5.76 s.
    expect(status.result.value).toBeGreaterThan(2.4);
    expect(status.result.value).toBeLessThan(2.7);
  });

  it('reports encroachment (PET undefined) when both occupy the area at once', () => {
    const status = computeRealizedPet(crossingTrace(0), 'a', 'b', { x: 0, y: 0 });
    expect(status.kind).toBe('encroachment');
  });

  it('reports not_reached when an actor never enters the conflict area', () => {
    const status = computeRealizedPet(crossingTrace(30), 'a', 'b', { x: 5_000, y: 5_000 });
    expect(status.kind).toBe('not_reached');
  });

  it('is deterministic', () => {
    const trace = crossingTrace(30);
    const one = computeRealizedPet(trace, 'a', 'b', { x: 0, y: 0 });
    const two = computeRealizedPet(trace, 'a', 'b', { x: 0, y: 0 });
    expect(JSON.stringify(one)).toBe(JSON.stringify(two));
  });
});
