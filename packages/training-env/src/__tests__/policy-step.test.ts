/**
 * policy_step protocol tests (F3): codec round trips, deadline fallback
 * semantics (unit + wire), recurrent state-token echo, frame-bundle refs,
 * and the seed-reproducibility identity — two servers fed the same seed and
 * action stream must produce byte-identical policy.act frames.
 */
import { createHash } from 'node:crypto';

import { encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';

import { LANE_LEFT, LANE_RIGHT, scenario, syntheticGraph, vehicle } from '../fixture.js';
import { EnvServer, type WireResponse } from '../env-server.js';
import { registerPolicySession, type PolicySessionOptions } from '../policy-session.js';
import {
  POLICY_STEP_PROTOCOL_VERSION,
  ZERO_CONTROL,
  decodeDeadlineReport,
  decodeFrameBundleRef,
  decodePolicyAction,
  encodeDeadlineReport,
  encodeFrameBundleRef,
  encodePolicyAction,
  resolveDeadline,
  toEnvAction,
  type FrameBundleRef,
  type PolicyAction,
} from '../policy-step.js';
import type { SimScenarioInput } from '@simforge-oss/engine';

const graph = syntheticGraph();

function twoCarInput(): SimScenarioInput {
  return scenario(graph, {
    physics: { mode: 'dynamic-v1' },
    metricSubject: 'ego',
    clipSeconds: 4,
    warmupSeconds: 1,
    actors: [
      vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 10, cruiseSpeedMps: 10 }),
      vehicle(graph, { id: 'other', rsl: LANE_RIGHT, s: 40, speedMps: 8, cruiseSpeedMps: 8 }),
    ],
  });
}

/** In-process server with policy ops registered; no transport needed. */
function makeServer(options: PolicySessionOptions = {}): EnvServer {
  const server = new EnvServer({
    episodes: [{ input: twoCarInput(), graph, mapId: null, xodrSha256: null }],
    episode: { decisionHz: 10 },
  });
  registerPolicySession(server, options);
  return server;
}

let nextId = 1;
function ok(server: EnvServer, op: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const response = server.handle({ i: nextId++, op, ...fields });
  expect(response.ok, `op ${op}: ${String(response.e)}`).toBe(1);
  return response.r as Record<string, unknown>;
}

function err(server: EnvServer, op: string, fields: Record<string, unknown> = {}): WireResponse {
  const response = server.handle({ i: nextId++, op, ...fields });
  expect(response.ok).toBe(0);
  return response;
}

const CONTROL_A: PolicyAction = { kind: 'control', throttle: 0.6, brake: 0, steer: 0.05 };
const CONTROL_B: PolicyAction = { kind: 'control', throttle: 0, brake: 0.9, steer: -0.3 };

/** One policy.act with a single entry; returns the lone step frame. */
function actOne(
  server: EnvServer,
  action: PolicyAction,
  extra: { elapsedMs?: number; deadlineMs?: number } = {},
): Record<string, unknown> {
  const step: Record<string, unknown> = { a: encodePolicyAction(action) };
  if (extra.elapsedMs !== undefined) step['elapsedMs'] = extra.elapsedMs;
  const fields: Record<string, unknown> = { steps: [step] };
  if (extra.deadlineMs !== undefined) fields['deadlineMs'] = extra.deadlineMs;
  const r = ok(server, 'policy.act', fields);
  return (r['rs'] as Record<string, unknown>[])[0]!;
}

/** Drop the policy-layer extras so frames compare against core step frames. */
function coreFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const { fb: _fb, dl: _dl, ...rest } = frame;
  return rest;
}

describe('policy-step codecs', () => {
  it('round-trips trajectory and control actions', () => {
    const trajectory: PolicyAction = {
      kind: 'trajectory',
      points: [
        { x: 1.5, y: -2, heading: 0.1, speed: 8, t: 0 },
        { x: 9, y: -2.5, heading: 0.12, speed: 9.5, t: 0.5 },
      ],
    };
    expect(decodePolicyAction(encodePolicyAction(trajectory))).toEqual(trajectory);
    expect(decodePolicyAction(encodePolicyAction(CONTROL_A))).toEqual(CONTROL_A);
    expect(() => decodePolicyAction({ k: 'x' })).toThrow();
    expect(() => decodePolicyAction({ k: 't', p: [] })).toThrow();
  });

  it('round-trips deadline reports and frame-bundle refs', () => {
    const report = { limitMs: 40, elapsedMs: 55.5, miss: true, applied: 'repeat-last' as const };
    expect(decodeDeadlineReport(encodeDeadlineReport(report))).toEqual(report);

    const ref: FrameBundleRef = {
      shmName: '/dev/shm/simforge-frames-0',
      simTick: 173,
      cameras: [
        { id: 'front', digest: 'deadbeef', byteOffset: 4224, byteLength: 1638400, width: 1600, height: 256, format: 'rgba8' },
        { id: 'bev', digest: '00c0ffee', byteOffset: 1646848, byteLength: 262144, width: 256, height: 256, format: 'depth32f' },
      ],
    };
    expect(decodeFrameBundleRef(encodeFrameBundleRef(ref))).toEqual(ref);
  });

  it('reduces trajectories to speed setpoints and passes control through', () => {
    expect(toEnvAction(CONTROL_A)).toEqual({ control: { throttle: 0.6, brake: 0, steer: 0.05 } });
    const forward = toEnvAction({
      kind: 'trajectory',
      points: [
        { x: 0, y: 0, heading: 0, speed: 5, t: 0 },
        { x: 4, y: 0, heading: 0, speed: 7, t: 0.4 },
      ],
    });
    expect(forward).toEqual({ targetSpeedMps: 7, motionDirection: 1 });
    const reverse = toEnvAction({ kind: 'trajectory', points: [{ x: 0, y: 0, heading: 0, speed: -2, t: 0 }] });
    expect(reverse).toEqual({ targetSpeedMps: 2, motionDirection: -1 });
  });
});

describe('resolveDeadline', () => {
  const base = { action: CONTROL_A, lastApplied: CONTROL_B };

  it('applies the policy action without a limit or without a report', () => {
    for (const input of [
      { ...base, elapsedMs: 999, limitMs: null, fallback: 'zero-control' as const },
      { ...base, elapsedMs: null, limitMs: 10, fallback: 'zero-control' as const },
      { ...base, elapsedMs: 10, limitMs: 10, fallback: 'zero-control' as const }, // boundary: on-time
    ]) {
      const { report, apply } = resolveDeadline(input);
      expect(report.miss).toBe(false);
      expect(report.applied).toBe('policy');
      expect(apply).toEqual(CONTROL_A);
    }
  });

  it('selects each fallback on a miss', () => {
    const miss = { ...base, elapsedMs: 50, limitMs: 40 };
    expect(resolveDeadline({ ...miss, fallback: 'zero-control' })).toEqual({
      report: { limitMs: 40, elapsedMs: 50, miss: true, applied: 'zero-control' },
      apply: ZERO_CONTROL,
    });
    expect(resolveDeadline({ ...miss, fallback: 'scripted' })).toEqual({
      report: { limitMs: 40, elapsedMs: 50, miss: true, applied: 'scripted' },
      apply: null,
    });
    expect(resolveDeadline({ ...miss, fallback: 'repeat-last' })).toEqual({
      report: { limitMs: 40, elapsedMs: 50, miss: true, applied: 'repeat-last' },
      apply: CONTROL_B,
    });
    // No applied action yet: repeat-last degrades to scripted.
    expect(resolveDeadline({ ...miss, fallback: 'repeat-last', lastApplied: null })).toEqual({
      report: { limitMs: 40, elapsedMs: 50, miss: true, applied: 'scripted' },
      apply: null,
    });
  });
});

describe('policy session ops', () => {
  it('answers policy.hello and rejects version mismatches', () => {
    const server = makeServer();
    const hello = ok(server, 'policy.hello', { v: POLICY_STEP_PROTOCOL_VERSION });
    expect(hello['proto']).toBe(POLICY_STEP_PROTOCOL_VERSION);
    expect(hello['actions']).toEqual(['trajectory', 'control']);
    expect(hello['fallbacks']).toEqual(['repeat-last', 'zero-control', 'scripted']);
    expect((hello['obs'] as Record<string, unknown>)['frameBundle']).toBe(false);
    expect(err(server, 'policy.hello', { v: 999 }).e).toMatch(/protocol mismatch/);
  });

  it('refuses policy.act before policy.reset and unknown ops still throw', () => {
    const server = makeServer();
    expect(err(server, 'policy.act', { steps: [{ a: encodePolicyAction(CONTROL_A) }] }).e).toMatch(
      /policy\.act before policy\.reset/,
    );
    expect(err(server, 'policy.nope').e).toMatch(/unknown op/);
  });

  it('repeat-last miss reproduces the previous action byte-for-byte', () => {
    const [live, twin] = [makeServer(), makeServer()];
    ok(live, 'policy.reset', { seed: 7, deadlineMs: 40, fallback: 'repeat-last' });
    ok(twin, 'policy.reset', { seed: 7, deadlineMs: 40, fallback: 'repeat-last' });

    // Step 1 identical and on time.
    const l1 = actOne(live, CONTROL_A, { elapsedMs: 10 });
    const t1 = actOne(twin, CONTROL_A, { elapsedMs: 10 });
    expect(encode(coreFrame(l1))).toEqual(encode(coreFrame(t1)));

    // Step 2: live misses with B (fallback repeats A); twin sends A on time.
    const l2 = actOne(live, CONTROL_B, { elapsedMs: 120 });
    const t2 = actOne(twin, CONTROL_A, { elapsedMs: 10 });
    expect(decodeDeadlineReport(l2['dl'])).toEqual({ limitMs: 40, elapsedMs: 120, miss: true, applied: 'repeat-last' });
    expect(decodeDeadlineReport(t2['dl'])).toEqual({ limitMs: 40, elapsedMs: 10, miss: false, applied: 'policy' });
    expect(encode(coreFrame(l2))).toEqual(encode(coreFrame(t2)));
  });

  it('zero-control miss steps exactly like an explicit zero control', () => {
    const [live, twin] = [makeServer(), makeServer()];
    ok(live, 'policy.reset', { seed: 'z', fallback: 'zero-control' });
    ok(twin, 'policy.reset', { seed: 'z', fallback: 'zero-control' });
    // Per-request deadline override triggers the miss on live only.
    const l1 = actOne(live, CONTROL_A, { elapsedMs: 90, deadlineMs: 25 });
    const t1 = actOne(twin, ZERO_CONTROL, { elapsedMs: 1, deadlineMs: 25 });
    expect(decodeDeadlineReport(l1['dl']).applied).toBe('zero-control');
    expect(encode(coreFrame(l1))).toEqual(encode(coreFrame(t1)));
  });

  it('scripted miss steps exactly like the core no-action step', () => {
    const [live, twin] = [makeServer(), makeServer()];
    ok(live, 'policy.reset', { seed: 3, deadlineMs: 30, fallback: 'scripted' });
    ok(twin, 'reset', { s: 0, seed: 3 });
    const l1 = actOne(live, CONTROL_B, { elapsedMs: 55 });
    const t1 = ok(twin, 'step', { s: 0, a: null });
    expect(decodeDeadlineReport(l1['dl']).applied).toBe('scripted');
    expect(encode(coreFrame(l1))).toEqual(encode(t1));
  });

  it('echoes the recurrent state token across acts and clears it on reset', () => {
    const server = makeServer();
    const reset = ok(server, 'policy.reset', { seed: 1 });
    expect(reset['st']).toEqual(new Uint8Array(0));
    const token = new Uint8Array([1, 2, 3, 250]);
    const withToken = ok(server, 'policy.act', { steps: [{ a: encodePolicyAction(CONTROL_A) }], st: token });
    expect(new Uint8Array(withToken['st'] as Uint8Array)).toEqual(token);
    const without = ok(server, 'policy.act', { steps: [{ a: encodePolicyAction(CONTROL_A) }] });
    expect(new Uint8Array(without['st'] as Uint8Array)).toEqual(token);
    const again = ok(server, 'policy.reset', { seed: 1 });
    expect(again['st']).toEqual(new Uint8Array(0));
  });

  it('attaches frame-bundle refs from the provider seam', () => {
    const ref: FrameBundleRef = {
      shmName: '/dev/shm/sf-ring',
      simTick: 0,
      cameras: [{ id: 'front', digest: 'aabbccdd', byteOffset: 128, byteLength: 4096, width: 32, height: 32, format: 'rgba8' }],
    };
    const ticks: number[] = [];
    const server = makeServer({
      frameBundleProvider: (sessionIndex, simTick) => {
        expect(sessionIndex).toBe(0);
        ticks.push(simTick);
        return { ...ref, simTick };
      },
    });
    expect((ok(server, 'policy.hello', { v: 1 })['obs'] as Record<string, unknown>)['frameBundle']).toBe(true);
    const reset = ok(server, 'policy.reset', { seed: 5 });
    expect(decodeFrameBundleRef((reset['ob'] as Record<string, unknown>)['fb'])).toEqual({ ...ref, simTick: ticks[0]! });
    const frame = actOne(server, CONTROL_A);
    // 10 Hz decisions on a 50 Hz engine: the first decision lands 5 ticks in.
    expect(ticks[1]! - ticks[0]!).toBe(5);
    expect(decodeFrameBundleRef(frame['fb'])).toEqual({ ...ref, simTick: ticks[1]! });
  });

  it('two identical seeded episodes produce identical trace digests', () => {
    const rollout = (seed: number | string, throttleBias = 0): string => {
      const server = makeServer();
      const digest = createHash('sha256');
      const reset = ok(server, 'policy.reset', { seed, deadlineMs: 50, fallback: 'repeat-last' });
      digest.update(encode(reset['ob'] as Record<string, unknown>));
      for (let step = 0; step < 20; step += 1) {
        // Scripted mix of action kinds, all deterministic in `step`;
        // step 13 deliberately misses its deadline (fallback path included).
        const action: PolicyAction =
          step % 3 === 2
            ? { kind: 'trajectory', points: [{ x: 0, y: 0, heading: 0, speed: 6 + (step % 5), t: 0.1 }] }
            : { kind: 'control', throttle: 0.3 + throttleBias + 0.02 * (step % 7), brake: 0, steer: 0.01 * (step % 4) };
        const frame = actOne(server, action, { elapsedMs: step === 13 ? 200 : 5 });
        digest.update(encode(frame));
      }
      return digest.digest('hex');
    };
    const first = rollout(42);
    expect(rollout(42)).toBe(first);
    // The digest covers content: a perturbed action stream diverges. (The
    // synthetic fixture is fully authored, so the seed alone is inert here.)
    expect(rollout(42, 0.05)).not.toBe(first);
  });
});
