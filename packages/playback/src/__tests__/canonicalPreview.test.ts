import { describe, expect, it } from 'vitest';
import { buildLaneGraph, parseSimScenarioInput } from '@simforge/engine';
import { clearCanonicalPreviewCache, runCanonicalPreview } from '../canonicalPreview';

describe('canonical native authoring preview', () => {
  it('runs the complete fixed-step episode and reuses the exact hash-cached result', () => {
    const graph = buildLaneGraph({ schemaVersion: 1, mapName: 'preview', source: { xodrSha256: 'preview' }, lanes: {}, gates: [], junctions: {} });
    const input = parseSimScenarioInput({
      mapId: 'preview', clipSeconds: 3, warmupSeconds: 0, dt: .02, physics: { mode: 'kinematic-v1' },
      actors: [{
        id: 'ego', kind: 'car', initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 2 },
        behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 20, z: 0 }] }, cruiseSpeedMps: 2 },
      }],
      interactions: [{
        id: 'stop', actorId: 'ego', trigger: { kind: 'at', t: 1.001 }, verb: 'speed', target: { mode: 'stop' },
        dynamics: { shape: 'linear', constraint: 'time', value: .5 },
      }],
    });
    clearCanonicalPreviewCache();
    const first = runCanonicalPreview(input, graph, undefined);
    const second = runCanonicalPreview(input, graph, undefined);
    expect(first).toBe(second);
    expect(first.trace.ticks.t.at(-1)).toBe(3);
    expect(first.trace.events.find((event) => event.kind === 'trigger_fired' && event.interactionId === 'stop')?.t).toBe(1.02);
  });
});
