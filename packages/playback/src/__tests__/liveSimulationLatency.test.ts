import { describe, expect, it } from 'vitest';
import { createFixedStepSimulation, parseSimScenarioInput } from '@uniscenarios/sim-engine';
import { initialLiveTickBudget, liveBatchTickBudget } from '../liveSimulationPlan';

function dynamicActors(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const z = index * 8;
    return {
      id: `car-${String(index).padStart(2, '0')}`,
      kind: 'vehicle' as const,
      dims: { l: 4.5, w: 1.9, h: 1.5 },
      initial: { pose: { x: 0, z, headingRad: 0 }, speedMps: 12 },
      behavior: {
        route: { kind: 'polyline' as const, points: [{ x: 0, z }, { x: 1_000, z }] },
        cruiseSpeedMps: 12,
      },
      presentAtStart: true,
    };
  });
}

describe('32-actor live startup budget', () => {
  it('resumes the warmed dynamic world within the warm Play latency budget', () => {
    const input = parseSimScenarioInput({
      mapId: 'latency-fixture', clipSeconds: 2, warmupSeconds: 1, dt: 0.05,
      seed: 'latency-fixture', physics: { mode: 'dynamic-v1' }, actors: dynamicActors(32),
    });
    const graph = {
      topologyDigest: 'latency-fixture',
      route: () => { throw new Error('polyline fixture does not route on a lane graph'); },
      nearestLane: () => null,
    } as never;
    const session = createFixedStepSimulation(input, { graph, guards: 'throw' });
    session.advance(Math.round(input.warmupSeconds / input.dt) + 1);
    const started = performance.now();
    const firstMovement = session.advance(1);
    const startupMs = performance.now() - started;

    expect(firstMovement.recordedUntil).toBeCloseTo(input.dt);
    expect(session.peek().actors).toHaveLength(32);
    expect(startupMs).toBeLessThan(100);
  });

  it('keeps cold fallback bounded and yields between catch-up batches', () => {
    const dt = 0.05;
    expect(initialLiveTickBudget(1, dt)).toBe(22);
    expect(liveBatchTickBudget(dt, 1)).toBe(20);
  });
});
