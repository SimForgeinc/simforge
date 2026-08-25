/**
 * Trajectory executor tests (pure-pursuit trajectory execution through
 * policy_step): closed-loop S-curve tracking bounds on the fixed-step
 * dynamic-v1 sim, replan handover continuity, determinism of the executed
 * episode, and the 'speed-setpoint' regression option.
 *
 * The scripted planner is the acceptance oracle: it drives the ego with
 * *scripted* ego-frame trajectories (no model anywhere), replanned at
 * 0.5 Hz against 10 Hz decisions, exactly the Alpamayo replan cadence.
 */
import { createHash } from 'node:crypto';

import { encode } from '@msgpack/msgpack';
import { describe, expect, it } from 'vitest';

import { LANE_LEFT, scenario, syntheticGraph, vehicle } from '../fixture.js';
import { EnvServer } from '../env-server.js';
import { registerPolicySession, type PolicySessionOptions } from '../policy-session.js';
import { POLICY_STEP_PROTOCOL_VERSION, encodePolicyAction, toEnvAction, type PolicyAction } from '../policy-step.js';
import type { SimScenarioInput } from '@simforge/engine';

const graph = syntheticGraph();

/** Single ego cruising east on the straight fixture lane; nothing else. */
function soloInput(): SimScenarioInput {
  return scenario(graph, {
    physics: { mode: 'dynamic-v1' },
    metricSubject: 'ego',
    clipSeconds: 14,
    warmupSeconds: 1,
    actors: [vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 20, speedMps: 8, cruiseSpeedMps: 8 })],
  });
}

function makeServer(options: PolicySessionOptions = {}): EnvServer {
  const server = new EnvServer({
    episodes: [{ input: soloInput(), graph, mapId: null, xodrSha256: null }],
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

const TWO_PI = Math.PI * 2;

function wrap(a: number): number {
  const r = a % TWO_PI;
  return r > Math.PI ? r - TWO_PI : r <= -Math.PI ? r + TWO_PI : r;
}

/** S-curve path parameters: one full sine period over the 12 s rollout. */
const CURVE = { speedMps: 8, amplitudeM: 1.5, periodS: 10, horizonS: 4, sampleS: 0.4 };

/** Executor telemetry frame (`ex`) as attached by the pure-pursuit path. */
interface Ex {
  x: number; y: number; h: number; v: number;
  ct: number; at: number; age: number;
  sp: number; ax: number; dir: number;
  px: number; py: number; ph: number;
}

/**
 * Scripted planner: samples the analytic world-frame S-curve
 *   x(t) = x0 + V t,  y(t) = y0 + A sin(2π t / T)
 * over the next `horizonS`, then converts into the ego frame at the given
 * pose — the exact wire convention (x forward, y left, heading relative,
 * t seconds from issuance, strictly future).
 */
function scriptedPlan(
  origin: { x: number; y: number },
  pose: { tS: number; x: number; y: number; yawRad: number },
): PolicyAction {
  const points = [];
  const cos = Math.cos(pose.yawRad);
  const sin = Math.sin(pose.yawRad);
  for (let j = 1; j <= Math.round(CURVE.horizonS / CURVE.sampleS); j += 1) {
    const t = pose.tS + j * CURVE.sampleS;
    const phase = (TWO_PI * t) / CURVE.periodS;
    const wx = origin.x + CURVE.speedMps * t;
    const wy = origin.y + CURVE.amplitudeM * Math.sin(phase);
    const vy = ((CURVE.amplitudeM * TWO_PI) / CURVE.periodS) * Math.cos(phase);
    const wh = Math.atan2(vy, CURVE.speedMps);
    const dx = wx - pose.x;
    const dy = wy - pose.y;
    points.push({
      x: dx * cos + dy * sin,
      y: -dx * sin + dy * cos,
      heading: wrap(wh - pose.yawRad),
      speed: Math.hypot(CURVE.speedMps, vy),
      t: j * CURVE.sampleS,
    });
  }
  return { kind: 'trajectory', points };
}

/** 12 s scripted-trajectory rollout: 120 acts at 10 Hz, replans every 20 (0.5 Hz). */
function rollout(server: EnvServer): { frames: Record<string, unknown>[]; digest: string } {
  ok(server, 'policy.reset', { seed: 11, deadlineMs: 50, fallback: 'repeat-last' });
  const session = server.sessions[0]!;
  const start = session.egoPose()!;
  const origin = { x: start.x - CURVE.speedMps * start.tS, y: start.y };
  const chain = createHash('sha256');
  const frames: Record<string, unknown>[] = [];
  let action: PolicyAction | null = null;
  for (let step = 0; step < 120; step += 1) {
    if (step % 20 === 0) action = scriptedPlan(origin, session.egoPose()!);
    const r = ok(server, 'policy.act', { steps: [{ a: encodePolicyAction(action!), elapsedMs: 5 }] });
    const frame = (r['rs'] as Record<string, unknown>[])[0]!;
    frames.push(frame);
    chain.update(encode(frame));
    expect(frame['term']).toBe(0);
    expect(frame['trunc']).toBe(0);
  }
  return { frames, digest: chain.digest('hex') };
}

describe('pure-pursuit trajectory execution', () => {
  it('tracks a scripted S-curve within the documented cross-track bound', () => {
    const { frames } = rollout(makeServer());
    const ex = frames.map((f) => f['ex'] as unknown as Ex);
    expect(ex.every((e) => e && Number.isFinite(e.ct))).toBe(true);

    // Documented bound: |cross-track| <= 0.35 m after a 1 s settle-in
    // (A = 1.5 m, T = 10 s, 8 m/s S-curve; see docs/policy-step.md).
    const settled = ex.slice(10);
    const maxAbsCt = Math.max(...settled.map((e) => Math.abs(e.ct)));
    expect(maxAbsCt).toBeLessThanOrEqual(0.35);

    // The ego really swerves: world y sweeps both lobes of the sine
    // (the authored lane centerline is straight — route logic alone would
    // hold y ~ constant).
    const y0 = ex[0]!.y;
    const ys = ex.map((e) => e.y);
    expect(Math.max(...ys)).toBeGreaterThan(y0 + 1.0);
    expect(Math.min(...ys)).toBeLessThan(y0 - 1.0);
  });

  it('hands over between replans without action discontinuities', () => {
    const { frames } = rollout(makeServer());
    const ex = frames.map((f) => f['ex'] as unknown as Ex);
    for (const swap of [20, 40, 60, 80, 100]) {
      const before = ex[swap - 1]!;
      const after = ex[swap]!;
      // Documented handover bounds: speed setpoint jump <= 0.5 m/s,
      // preview heading jump <= 0.15 rad at a 0.5 Hz plan swap.
      expect(Math.abs(after.sp - before.sp)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(wrap(after.ph - before.ph))).toBeLessThanOrEqual(0.15);
      expect(after.age).toBeCloseTo(0, 9); // fresh anchor at the swap
      expect(before.age).toBeGreaterThan(1.8); // held plan aged ~2 s
    }
  });

  it('is deterministic: two scripted-trajectory episodes digest-identically', () => {
    const a = rollout(makeServer());
    const b = rollout(makeServer());
    expect(a.digest).toBe(b.digest);
  });

  it('reports the execution mode in policy.hello', () => {
    expect(ok(makeServer(), 'policy.hello', { v: POLICY_STEP_PROTOCOL_VERSION })['trajExec']).toBe('pure-pursuit');
    expect(
      ok(makeServer({ trajectoryExecution: 'speed-setpoint' }), 'policy.hello', { v: POLICY_STEP_PROTOCOL_VERSION })[
        'trajExec'
      ],
    ).toBe('speed-setpoint');
  });
});

describe("trajectoryExecution: 'speed-setpoint' regression option", () => {
  it('reproduces the v1 reduction byte-for-byte against core steps', () => {
    const live = makeServer({ trajectoryExecution: 'speed-setpoint' });
    const twin = makeServer(); // core ops only; execution mode irrelevant
    ok(live, 'policy.reset', { seed: 4 });
    ok(twin, 'reset', { s: 0, seed: 4 });
    for (let step = 0; step < 20; step += 1) {
      const action: PolicyAction = {
        kind: 'trajectory',
        points: [
          { x: 0.8 * step, y: 0, heading: 0, speed: 6 + (step % 4), t: 0.4 },
          { x: 1.6 * step, y: 0.3, heading: 0.1, speed: 5, t: 0.8 },
        ],
      };
      const l = ok(live, 'policy.act', { steps: [{ a: encodePolicyAction(action) }] });
      const frame = (l['rs'] as Record<string, unknown>[])[0]!;
      expect(frame['ex']).toBeUndefined(); // no executor telemetry on this path
      const reduced = toEnvAction(action);
      const t = ok(twin, 'step', {
        s: 0,
        a: { ts: reduced.targetSpeedMps, dir: reduced.motionDirection },
      });
      const { fb: _fb, dl: _dl, ...core } = frame;
      expect(encode(core)).toEqual(encode(t));
    }
  });
});
