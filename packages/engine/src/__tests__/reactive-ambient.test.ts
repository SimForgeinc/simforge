/**
 * Phase 2.5 — reactive ambient traffic.
 *
 * A policy-controlled ego may deviate arbitrarily from the authored
 * choreography, so generated background traffic must respond to the world as
 * it IS each planning tick, not as the authored world said it would be. This
 * suite pins the four contracts that gate trusting any Phase-3 RL result:
 *
 *  1. an ego stopped mid-lane is queued behind with IDM-like gap control and a
 *     held minimum following distance;
 *  2. default (`scripted`) runs remain byte-identical to pre-change reference
 *     digests — reactivity is strictly opt-in;
 *  3. reactive runs are byte-deterministic across repeated runs of one seed;
 *  4. the reactive leader observation covers bodies whose pose no longer
 *     resolves through lane storage (a deviating dynamic/polyline ego), which
 *     the scripted scan physically drives into.
 */
import { describe, expect, it } from 'vitest';

import { applyAmbientTraffic, runSimulation } from '../index.js';
import { createFixedStepSimulation } from '../sim/engine.js';
import type { RunOptions } from '../sim/engine.js';
import { canonicalJson, sha256 } from '../core/hash.js';
import { serializeTrace } from '../trace/gzip.js';
import type { SimTrace } from '../trace/trace.js';
import { quantizeTrace } from '../trace/trace.js';
import { LANE_LEFT, scenario, syntheticGraph, vehicle, poseOnLane } from './fixtures/scenarios.js';

const graph = syntheticGraph();
const DT = 0.02;

/** Digest of the quantized state channels only — header metadata such as
 * engineVersion must not churn a behavioral identity pin. */
function stateDigest(trace: SimTrace): string {
  return sha256(canonicalJson(quantizeTrace(trace).ticks));
}

function runToCompletion(input: Parameters<typeof createFixedStepSimulation>[0], opts: RunOptions): SimTrace {
  const session = createFixedStepSimulation(input, opts);
  let progress = session.advance(50);
  while (!progress.done) progress = session.advance(50);
  return progress.trace!;
}

/** Ambient follower approaching from behind on the ego's lane. */
function follower(id: string, s: number) {
  return {
    ...vehicle(graph, { id, rsl: LANE_LEFT, s, speedMps: 12, cruiseSpeedMps: 12 }),
    tags: ['ambient'],
  };
}

/** Authored subject stopped dead mid-lane — the simplest ego deviation. */
function stoppedMidLaneEgo() {
  return {
    ...vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 130, speedMps: 0, cruiseSpeedMps: 0 }),
    tags: ['subject'],
  };
}

function egoStopScenario() {
  return scenario(graph, {
    actors: [follower('amb-1', 90), follower('amb-2', 70), stoppedMidLaneEgo()],
    clipSeconds: 15,
    warmupSeconds: 2,
  });
}

/**
 * A subject whose pose cannot be resolved through lane storage at all: a
 * polyline-authored body standing across the follower's lane. This is what a
 * deviating dynamic ego degrades to once it leaves its authored route.
 */
function deviatedPolylineEgo() {
  const pose = poseOnLane(graph, LANE_LEFT, 130);
  return {
    id: 'ego',
    kind: 'vehicle' as const,
    dims: { l: 4.5, w: 1.9, h: 1.5 },
    initial: { pose: { x: pose.x, z: pose.z, headingRad: pose.headingRad }, speedMps: 0 },
    behavior: {
      route: { kind: 'polyline' as const, points: [{ x: pose.x, z: pose.z }, { x: pose.x + 1, z: pose.z }] },
      cruiseSpeedMps: 0,
    },
    presentAtStart: true,
    tags: ['subject'],
  };
}

function deviationScenario() {
  return scenario(graph, {
    actors: [follower('amb-1', 90), deviatedPolylineEgo()],
    clipSeconds: 12,
    warmupSeconds: 2,
  });
}

/** Bumper-to-bumper gap from `followerId` to the stopped ego at s=130. */
function gapsBehindStoppedEgo(trace: SimTrace): number[] {
  const f = trace.ticks.actors['amb-1']!;
  const halves = 4.5;
  return f.s.map((s) => 130 - s - halves);
}

describe('reactive ambient traffic', () => {
  it('queues followers behind an ego stopped mid-lane, holding a minimum following distance', () => {
    const trace = runToCompletion(egoStopScenario(), { graph, guards: 'skip', ambientReactivity: 'reactive' });
    const v = trace.ticks.actors['amb-1']!.speedMps;
    const gaps = gapsBehindStoppedEgo(trace);

    // The follower comes to rest and stays there.
    const tailTicks = Math.round(2 / DT);
    for (let i = v.length - tailTicks; i < v.length; i++) expect(v[i]).toBeLessThanOrEqual(0.05);
    // IDM-like approach: it brakes from cruise well before contact, never
    // penetrating the jam-distance floor.
    const minGap = Math.min(...gaps.slice(Math.round(1 / DT)));
    expect(minGap).toBeGreaterThanOrEqual(1.5);
    // No contact with the stopped ego (or anyone else).
    expect(trace.metrics.collisions).toHaveLength(0);
    // The second follower queues behind the first rather than shoving through.
    const v2 = trace.ticks.actors['amb-2']!.speedMps;
    expect(v2[v2.length - 1]).toBeLessThanOrEqual(0.05);
  }, 30_000);

  it('observes a lane-storage-deviating ego that the scripted scan drives into', () => {
    const scripted = runToCompletion(deviationScenario(), { graph, guards: 'skip' });
    const reactive = runToCompletion(deviationScenario(), { graph, guards: 'skip', ambientReactivity: 'reactive' });

    // Scripted: the follower's leader scan resolves nothing through lane
    // storage, so it cruises into the deviating ego.
    const scriptedContact =
      scripted.metrics.collisions.length > 0 || Math.min(...gapsBehindStoppedEgo(scripted)) < 0.5;
    expect(scriptedContact).toBe(true);

    // Reactive: the projection fallback sees the physical body where it stands
    // and queues behind it.
    expect(reactive.metrics.collisions).toHaveLength(0);
    const reactiveMinGap = Math.min(...gapsBehindStoppedEgo(reactive).slice(Math.round(1 / DT)));
    expect(reactiveMinGap).toBeGreaterThanOrEqual(1.5);
    const v = reactive.ticks.actors['amb-1']!.speedMps;
    expect(v[v.length - 1]).toBeLessThanOrEqual(0.05);
  }, 30_000);

  it('keeps default scripted runs byte-identical to the pre-change references', () => {
    // References captured BEFORE the reactive mode landed (see the capture
    // helper used to produce them: ambient city population + authored ego,
    // and a plain authored two-car scene).
    const base = scenario(graph, {
      clipSeconds: 8,
      warmupSeconds: 0,
      seed: 'ambient-ref',
      actors: [vehicle(graph, { id: 'ego', s: 200, speedMps: 8, cruiseSpeedMps: 8 })],
      metricSubject: 'ego',
    });
    const ambientInput = applyAmbientTraffic(base, graph, { version: 1, preset: 'city', seed: 'ambient-1' }).input;
    const ambientRun = runSimulation(ambientInput, { graph, guards: 'skip' });
    expect(stateDigest(ambientRun.trace)).toBe(
      '3d010235455c89167fa8c4b716b7458fdf8e114d0fb226d28227a9dcbf6c5e72',
    );

    const twoCar = scenario(graph, {
      actors: [
        vehicle(graph, { id: 'lead', rsl: LANE_LEFT, s: 120, speedMps: 9, cruiseSpeedMps: 9 }),
        vehicle(graph, { id: 'subj', rsl: LANE_LEFT, s: 90, speedMps: 11, cruiseSpeedMps: 11 }),
      ],
      metricSubject: 'subj',
    });
    const twoCarRun = runSimulation(twoCar, { graph, guards: 'skip' });
    expect(stateDigest(twoCarRun.trace)).toBe(
      '8f6bdc41b5b39c6bbc2cf64a3fcb20df56e99e42875d96eebc16481ed838f575',
    );
  }, 30_000);

  it('is byte-deterministic across repeated reactive runs of one seed', () => {
    const first = serializeTrace(runToCompletion(egoStopScenario(), {
      graph,
      guards: 'skip',
      ambientReactivity: 'reactive',
    }));
    const second = serializeTrace(runToCompletion(egoStopScenario(), {
      graph,
      guards: 'skip',
      ambientReactivity: 'reactive',
    }));
    expect(first.length).toBe(second.length);
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  }, 60_000);
});
