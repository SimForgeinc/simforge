import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SCORING_CONFIG,
  collisionFromReward,
  goalFromReward,
  parseTraceJsonl,
  rewardViewFromStep,
  scoreEpisode,
  stepMinTtcS,
  type ParsedTrace,
  type ScenarioScoringContext,
  type TraceObj,
  type TraceStepRecord,
} from '../scoring.js';

/** decisionHz 10 everywhere: dt = 0.1 s per decision. */
const CTX: ScenarioScoringContext = {
  decisionHz: 10,
  actorKinds: { car: 'vehicle', walker: 'pedestrian', bike: 'bicycle' },
  speedLimitMps: 10,
  expectedRouteM: 100,
};

interface StepOverrides {
  readonly speed?: number;
  readonly accel?: number;
  readonly latOff?: number;
  readonly routeS?: number;
  readonly objs?: readonly TraceObj[];
  readonly rw?: number;
  readonly terms?: readonly number[];
  readonly term?: number;
  readonly trunc?: number;
  readonly miss?: number;
  readonly sig?: TraceStepRecord['sig'];
}

function mkStep(step: number, o: StepOverrides = {}): TraceStepRecord {
  const routeS = o.routeS ?? 10 + step;
  return {
    step,
    t: (step + 1) / 10,
    a: { k: 'c', c: [0.3, 0, 0] },
    miss: o.miss ?? 0,
    applied: 'policy',
    rw: o.rw ?? 0,
    term: o.term ?? 0,
    trunc: o.trunc ?? 0,
    sv: [routeS, 0, 1, 0, o.speed ?? 5, o.accel ?? 0, o.latOff ?? 0, 0, routeS, 1e6],
    terms: o.terms ?? [0, 0, 0],
    objs: o.objs ?? [],
    ...(o.sig !== undefined ? { sig: o.sig } : {}),
  };
}

function mkTrace(steps: TraceStepRecord[], resetRouteS = 10): ParsedTrace {
  return {
    reset: {
      seed: 1,
      session: 0,
      t: 0,
      sv: [resetRouteS, 0, 1, 0, 5, 0, 0, 0, resetRouteS, 1e6],
      objs: [],
    },
    steps,
    summary: null,
  };
}

describe('terminal reward classification (shared with eval-server)', () => {
  it('classifies an explicit collision term and the deep-negative fallback identically', () => {
    expect(collisionFromReward({ terminated: true, reward: -9.9, rewardTerms: { collision: -10, progress: 0.1, proximity: 0, comfort: 0 } })).toBe(true);
    expect(collisionFromReward({ terminated: true, reward: -9.9, rewardTerms: { progress: 0.1, proximity: 0, comfort: 0 } })).toBe(true);
    expect(collisionFromReward({ terminated: true, reward: 10.1, rewardTerms: { goal: 10, progress: 0.1, proximity: 0, comfort: 0 } })).toBe(false);
    expect(collisionFromReward({ terminated: false, reward: -2, rewardTerms: { progress: 0, proximity: 0, comfort: 0 } })).toBe(false);
    expect(goalFromReward({ terminated: true, reward: 10.1, rewardTerms: { goal: 10, progress: 0.1, proximity: 0, comfort: 0 } })).toBe(true);
  });

  it('recovers terminal terms from the wire residual', () => {
    const collision = rewardViewFromStep(mkStep(3, { term: 1, rw: -9.9, terms: [0.1, 0, 0] }));
    expect(collision.rewardTerms['collision']).toBeCloseTo(-10, 9);
    const goal = rewardViewFromStep(mkStep(3, { term: 1, rw: 10.05, terms: [0.05, 0, 0] }));
    expect(goal.rewardTerms['goal']).toBeCloseTo(10, 9);
    // Non-terminal residuals never invent terms.
    const plain = rewardViewFromStep(mkStep(3, { rw: 0.05, terms: [0.05, 0, 0] }));
    expect('collision' in plain.rewardTerms).toBe(false);
    expect('goal' in plain.rewardTerms).toBe(false);
  });
});

describe('collision penalty by partner type', () => {
  const terminalCollision = (objs: readonly TraceObj[]) =>
    scoreEpisode(mkTrace([mkStep(0), mkStep(1, { term: 1, rw: -10, objs })]), CTX);

  it('vehicle partner → collision-vehicle × 0.6', () => {
    const score = terminalCollision([['car', 1.1, 0, -4, 1]]);
    expect(score.infractions['collision-vehicle']).toBe(1);
    expect(score.terminal.collision).toBe(true);
    expect(score.penaltyProduct).toBeCloseTo(0.6, 12);
    const event = score.events.find((e) => e.type === 'collision-vehicle')!;
    expect(event.tick).toBe(1);
    expect(event.position).toEqual({ x: 11, y: 0 });
  });

  it('pedestrian partner → collision-pedestrian × 0.5', () => {
    const score = terminalCollision([['walker', 0.8, 0, -2, 1]]);
    expect(score.infractions['collision-pedestrian']).toBe(1);
    expect(score.penaltyProduct).toBeCloseTo(0.5, 12);
  });

  it('bicycle partner counts as vehicle collision', () => {
    const score = terminalCollision([['bike', 0.8, 0, -2, 1]]);
    expect(score.infractions['collision-vehicle']).toBe(1);
  });

  it('no perceived partner → collision-static × 0.65', () => {
    const score = terminalCollision([]);
    expect(score.infractions['collision-static']).toBe(1);
    expect(score.penaltyProduct).toBeCloseTo(0.65, 12);
  });
});

describe('off-road', () => {
  it('does not fire at exactly the threshold (strict >)', () => {
    const score = scoreEpisode(mkTrace([mkStep(0, { latOff: 3.0 }), mkStep(1, { latOff: -3.0 })]), CTX);
    expect(score.infractions['off-road']).toBe(0);
  });

  it('fires once per excursion with hysteresis at threshold − clear margin', () => {
    const steps = [
      mkStep(0, { latOff: 3.01 }), // enter → event
      mkStep(1, { latOff: 3.4 }), // still out → no new event
      mkStep(2, { latOff: 2.6 }), // above 2.5 → still active
      mkStep(3, { latOff: 3.2 }), // no re-entry event (never cleared)
      mkStep(4, { latOff: 2.5 }), // == 3.0 − 0.5 → clears (<=)
      mkStep(5, { latOff: -3.01 }), // re-enter (sign-independent) → second event
    ];
    const score = scoreEpisode(mkTrace(steps), CTX);
    expect(score.infractions['off-road']).toBe(2);
    expect(score.events.filter((e) => e.type === 'off-road').map((e) => e.tick)).toEqual([0, 5]);
    expect(score.penaltyProduct).toBeCloseTo(0.75 ** 2, 12);
  });
});

describe('wrong-way', () => {
  it('fires exactly when cumulative reverse progress reaches the threshold (>=)', () => {
    const steps = [
      mkStep(0, { routeS: 10, speed: 2 }),
      mkStep(1, { routeS: 9.5, speed: 2 }), // reverse 0.5
      mkStep(2, { routeS: 9.0, speed: 2 }), // reverse 1.0 → fires here
      mkStep(3, { routeS: 8.5, speed: 2 }), // still active → no second event
    ];
    const score = scoreEpisode(mkTrace(steps, 10), CTX);
    expect(score.infractions['wrong-way']).toBe(1);
    expect(score.events.find((e) => e.type === 'wrong-way')!.tick).toBe(2);
  });

  it('ignores reverse drift below the speed gate and resets on forward progress', () => {
    const slow = [
      mkStep(0, { routeS: 10, speed: 0.5 }), // == gate → not counted (strict >)
      mkStep(1, { routeS: 8, speed: 0.5 }),
      mkStep(2, { routeS: 6, speed: 0.5 }),
    ];
    expect(scoreEpisode(mkTrace(slow, 10), CTX).infractions['wrong-way']).toBe(0);

    const resetByForward = [
      mkStep(0, { routeS: 9.4, speed: 2 }), // reverse 0.6
      mkStep(1, { routeS: 9.6, speed: 2 }), // forward → accumulator resets
      mkStep(2, { routeS: 9.0, speed: 2 }), // reverse 0.6 again → still < 1.0
    ];
    expect(scoreEpisode(mkTrace(resetByForward, 10), CTX).infractions['wrong-way']).toBe(0);
  });
});

describe('stuck', () => {
  const stopped = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => mkStep(from + i, { speed: 0.29, routeS: 10 }));

  it('fires at exactly the timeout (>=), not one decision earlier', () => {
    expect(scoreEpisode(mkTrace(stopped(79)), CTX).infractions['stuck']).toBe(0);
    const score = scoreEpisode(mkTrace(stopped(80)), CTX);
    expect(score.infractions['stuck']).toBe(1);
    expect(score.events.find((e) => e.type === 'stuck')!.tick).toBe(79);
  });

  it('requires speed strictly below the stopped threshold', () => {
    const crawling = Array.from({ length: 90 }, (_, i) => mkStep(i, { speed: 0.3, routeS: 10 }));
    expect(scoreEpisode(mkTrace(crawling), CTX).infractions['stuck']).toBe(0);
  });

  it('a movement break restarts the clock', () => {
    const steps = [...stopped(79), mkStep(79, { speed: 1 }), ...stopped(79, 80)];
    expect(scoreEpisode(mkTrace(steps), CTX).infractions['stuck']).toBe(0);
  });
});

describe('speeding', () => {
  it('tolerance boundary is on-limit: speed == limit × 1.1 never fires', () => {
    const steps = Array.from({ length: 30 }, (_, i) => mkStep(i, { speed: 11 }));
    expect(scoreEpisode(mkTrace(steps), CTX).infractions['speeding']).toBe(0);
  });

  it('fires after exactly the sustain duration (>=)', () => {
    const over = (n: number) => Array.from({ length: n }, (_, i) => mkStep(i, { speed: 11.01 }));
    expect(scoreEpisode(mkTrace(over(9)), CTX).infractions['speeding']).toBe(0);
    const score = scoreEpisode(mkTrace(over(10)), CTX);
    expect(score.infractions['speeding']).toBe(1);
    expect(score.events.find((e) => e.type === 'speeding')!.tick).toBe(9);
  });

  it('is inert without an authored limit', () => {
    const steps = Array.from({ length: 30 }, (_, i) => mkStep(i, { speed: 50 }));
    const score = scoreEpisode(mkTrace(steps), { ...CTX, speedLimitMps: null });
    expect(score.infractions['speeding']).toBe(0);
  });
});

describe('red light', () => {
  it('fires on a stop-line crossing while red (dist > 0 → <= 0)', () => {
    const steps = [
      mkStep(0, { sig: { state: 'red', distM: 2 } }),
      mkStep(1, { sig: { state: 'red', distM: 0 } }), // crossing (<= 0)
    ];
    const score = scoreEpisode(mkTrace(steps), CTX);
    expect(score.infractions['red-light']).toBe(1);
    expect(score.events.find((e) => e.type === 'red-light')!.tick).toBe(1);
  });

  it('does not fire when crossing on green, nor without a crossing', () => {
    const green = [
      mkStep(0, { sig: { state: 'green', distM: 2 } }),
      mkStep(1, { sig: { state: 'green', distM: -1 } }),
    ];
    expect(scoreEpisode(mkTrace(green), CTX).infractions['red-light']).toBe(0);

    const waiting = [
      mkStep(0, { sig: { state: 'red', distM: 2 } }),
      mkStep(1, { sig: { state: 'red', distM: 0.5 } }),
    ];
    expect(scoreEpisode(mkTrace(waiting), CTX).infractions['red-light']).toBe(0);

    // Already at/past the line before the window → no crossing observed.
    const past = [
      mkStep(0, { sig: { state: 'red', distM: 0 } }),
      mkStep(1, { sig: { state: 'red', distM: -1 } }),
    ];
    expect(scoreEpisode(mkTrace(past), CTX).infractions['red-light']).toBe(0);
  });
});

describe('ttc minima', () => {
  it('computes min TTC across closing objects only', () => {
    const objs: TraceObj[] = [
      ['a', 8, 0, -4, 1], // ttc 2.0
      ['b', 9, 0, -6, 1], // ttc 1.5
      ['c', 3, 0, 2, 1], // opening → ignored
      ['d', 5, 0, 0, 1], // holding → ignored
    ];
    expect(stepMinTtcS(objs)).toBeCloseTo(1.5, 12);
    expect(stepMinTtcS([['c', 3, 0, 2, 1]])).toBeNull();
  });

  it('ttc-critical is strict < with per-excursion debounce', () => {
    const at = (ttcRange: number) => [['car', ttcRange, 0, -4, 1] as TraceObj];
    const steps = [
      mkStep(0, { objs: at(6) }), // ttc 1.5 == threshold → no event
      mkStep(1, { objs: at(5.9) }), // ttc 1.475 → event
      mkStep(2, { objs: at(5.0) }), // still critical → debounced
      mkStep(3, { objs: at(8) }), // recovered
      mkStep(4, { objs: at(4) }), // ttc 1.0 → second event
    ];
    const score = scoreEpisode(mkTrace(steps), CTX);
    expect(score.ttc.criticalCount).toBe(2);
    expect(score.ttc.minTtcS).toBeCloseTo(1.0, 12);
    // warnings, not infractions: no score impact
    expect(score.penaltyProduct).toBe(1);
  });
});

describe('comfort bounds', () => {
  it('accel bound is strict >', () => {
    const atBound = Array.from({ length: 5 }, (_, i) => mkStep(i, { accel: 3.5 }));
    const over = [mkStep(0, { accel: 3.6 })];
    expect(scoreEpisode(mkTrace(atBound), CTX).comfort.accelViolations).toBe(0);
    const score = scoreEpisode(mkTrace(over), CTX);
    expect(score.comfort.accelViolations).toBe(1);
    expect(score.comfort.maxAbsAccelMps2).toBeCloseTo(3.6, 12);
    expect(score.events.some((e) => e.type === 'accel-bound')).toBe(true);
  });

  it('jerk bound is a decision-rate finite difference, strict >', () => {
    const atBound = [mkStep(0, { accel: 0 }), mkStep(1, { accel: 0.8 })]; // jerk 8.0
    expect(scoreEpisode(mkTrace(atBound), CTX).comfort.jerkViolations).toBe(0);
    const over = [mkStep(0, { accel: 0 }), mkStep(1, { accel: -0.81 })]; // |jerk| 8.1
    const score = scoreEpisode(mkTrace(over), CTX);
    expect(score.comfort.jerkViolations).toBe(1);
    expect(score.comfort.maxAbsJerkMps3).toBeCloseTo(8.1, 9);
    expect(score.events.some((e) => e.type === 'jerk-bound')).toBe(true);
    // comfort is reported, never multiplied into the score
    expect(score.penaltyProduct).toBe(1);
  });
});

describe('score composition', () => {
  it('drivingScore = routeCompletion × Π penalties', () => {
    const steps = [
      mkStep(0, { routeS: 35, latOff: 3.2 }), // off-road (0.75)
      mkStep(1, { routeS: 60, term: 1, rw: -10, objs: [['car', 1, 0, -3, 1]] }), // collision-vehicle (0.6)
    ];
    const score = scoreEpisode(mkTrace(steps, 10), CTX); // Δs = 50 of expected 100
    expect(score.routeCompletion).toBeCloseTo(0.5, 12);
    expect(score.penaltyProduct).toBeCloseTo(0.75 * 0.6, 12);
    expect(score.drivingScore).toBeCloseTo(0.5 * 0.75 * 0.6, 12);
  });

  it('route completion clamps to [0, 1] and goal forces 1', () => {
    const overshoot = [mkStep(0, { routeS: 250 })];
    expect(scoreEpisode(mkTrace(overshoot, 10), CTX).routeCompletion).toBe(1);

    const backward = [mkStep(0, { routeS: 4, speed: 0.1 })];
    expect(scoreEpisode(mkTrace(backward, 10), CTX).routeCompletion).toBe(0);

    const goal = [mkStep(0, { routeS: 20, term: 1, rw: 10 })];
    const score = scoreEpisode(mkTrace(goal, 10), CTX);
    expect(score.terminal.goal).toBe(true);
    expect(score.routeCompletion).toBe(1);
    expect(score.events.some((e) => e.type === 'goal-reached')).toBe(true);
  });

  it('deadline misses are informational events and counted', () => {
    const steps = [mkStep(0, { miss: 1 }), mkStep(1), mkStep(2, { miss: 1 })];
    const score = scoreEpisode(mkTrace(steps), CTX);
    expect(score.deadlineMisses).toBe(2);
    expect(score.events.filter((e) => e.type === 'deadline-miss')).toHaveLength(2);
    expect(score.penaltyProduct).toBe(1);
  });

  it('every default penalty factor is a real discount in (0, 1)', () => {
    for (const factor of Object.values(DEFAULT_SCORING_CONFIG.penalties)) {
      expect(factor).toBeGreaterThan(0);
      expect(factor).toBeLessThan(1);
    }
  });
});

describe('parseTraceJsonl', () => {
  it('separates reset, steps and summary; tolerates unknown keys and blank lines', () => {
    const text = [
      JSON.stringify({ reset: { seed: 7, t: 0, sv: [0, 0, 1, 0, 5, 0, 0, 0, 0, 1e6], objs: [] }, digest: 'x' }),
      '',
      JSON.stringify({ step: 1, t: 0.2, miss: 0, rw: 0, term: 0, trunc: 0, sv: null, objs: [], reasoning: 'later' }),
      JSON.stringify({ step: 0, t: 0.1, miss: 0, rw: 0, term: 0, trunc: 0, sv: null, objs: [] }),
      JSON.stringify({ summary: { episode_digest: 'abc' } }),
    ].join('\n');
    const trace = parseTraceJsonl(text);
    expect(trace.reset?.seed).toBe(7);
    expect(trace.steps.map((s) => s.step)).toEqual([0, 1]); // sorted
    expect(trace.summary?.['episode_digest']).toBe('abc');
  });
});
