process.env.SCEN_DEV_ASSETS = '/home/path/UniScenarios-training-grade/dev-assets';
import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { loadEpisodeSpec } from '../env-server.js';
import {
  createFixedStepSimulation,
  obbOverlap,
  type ActionHook,
  type ActionOverride,
} from '@simforge/engine';

const DECISION_TICKS = 10;

describe('scratch: tick-level engine probe', () => {
  it('checks OBB overlap at closest approach', async () => {
    const specPath =
      '/home/path/UniScenarios/scripts/rl/episodes/dartout-yale-street-5913fada2fca9e8a-eval.json';
    const { episodes } = await loadEpisodeSpec(specPath);
    const actions: Array<{ targetSpeedMps: number; targetAccelerationMps2: number }> = JSON.parse(
      readFileSync('/tmp/actions_end.json', 'utf8'),
    );
    const input = episodes[0]!.input;
    const hook: ActionHook = ({ actorId, tS }): ActionOverride | undefined => {
      if (actorId !== 'ego' || tS < 0) return undefined;
      const decision = Math.min(Math.floor(tS / 0.2), actions.length - 1);
      return actions[decision];
    };
    const session = createFixedStepSimulation(input, {
      graph: episodes[0]!.graph,
      guards: 'collect',
      ambientReactivity: 'reactive',
      actionHook: hook,
    });
    session.advance(Math.round(input.warmupSeconds / input.dt) + 1);
    let minD = Infinity;
    let best: { ego: unknown; ped: unknown; overlap: boolean; t: number } | null = null;
    while (!session.done) {
      session.advance(1);
      const snap = session.peek();
      const ego = snap.actors.find((a) => a.id === 'ego');
      const ped = snap.actors.find((a) => a.id === 'ped');
      if (!ego || !ped) continue;
      const d = Math.hypot(ego.x - ped.x, ego.y - ped.y);
      if (d < minD) {
        minD = d;
        const overlap = obbOverlap(
          { center: { x: ego.x, y: ego.y }, lengthM: 4.7, widthM: 1.82, headingRad: ego.headingRad },
          { center: { x: ped.x, y: ped.y }, lengthM: 0.6, widthM: 0.6, headingRad: ped.headingRad },
        );
        best = { ego, ped, overlap, t: snap.tS };
      }
    }
    console.log('MIN d', minD.toFixed(4), 'at t', best?.t, 'OBB overlap at that pose:', best?.overlap);
    console.log('input actor kinds:', input.actors.map((a) => `${a.id}:${a.kind}`).join(','));
    expect(best).not.toBeNull();
    expect(typeof best!.overlap).toBe('boolean');
  });
});
