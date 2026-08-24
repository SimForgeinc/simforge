/** Exact semantic and runtime closure for audited Belmont longitudinal cases. */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateMetrics, runSimulation } from '@simforge/engine';

import { checkInvariants } from '../invariants.js';
import { REPO_ROOT, artifactPresence } from '@simforge/compiler/node';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

const MAP = 'belmont-research-center';
const TEMPLATE_DIR = path.join(REPO_ROOT, 'examples', 'mechanisms', 'corridor');
const present = artifactPresence(MAP);
const haveArtifacts = present.topologyIndex && present.derivedTopology && present.locations;

const acceptedCases = [
  {
    name: 'lead-hard-brake',
    siteId: '30349e95cc444cb2',
    seed: 'c3adb6d9e6cc69896fdd455734bf31b68edfc37434ed66f0c01c7a80c5d4e96c',
  },
  {
    name: 'cutout-reveals-stopped',
    siteId: '5eed516b2897949c',
    seed: 'fcae9ad903195c6becb5087de190fbba02b4405aa35f2bbd2e8faf2afaea2a49',
  },
  {
    name: 'cut-in-brake',
    siteId: '4e6a7c2e681baa06',
    seed: '182bffecfd1f780c5bd46fc30f47b6214acdc6b34bb8b4c9e73bb8ff9ed5fdf6',
  },
] as const;

describe.skipIf(!haveArtifacts)('Belmont longitudinal — exact audited runtimes', () => {
  it.each(acceptedCases)('$name holds every required invariant without collision', async ({ name, siteId, seed }) => {
    const template = await readTemplate(path.join(TEMPLATE_DIR, `${name}.template.json`));
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === siteId);
    expect(site, `audited Belmont site ${siteId}`).toBeDefined();

    const { input, manifest } = materialize(template, matched.bundle, site!, { drawIndex: 0, seed });
    expect(manifest.feasible).toBe(true);
    expect(manifest.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    expect(trace.metrics.collisions).toEqual([]);

    const speedLimitKph = matched.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null;
    const residuals = checkInvariants({
      template,
      trace,
      scope: {
        params: manifest.params.values,
        clip: { seconds: template.choreography.clipSeconds },
        lane: speedLimitKph === null ? {} : { speedLimitKph },
      },
      arrival: manifest.arrival,
      speedLimitKph,
    });
    expect(residuals.every((residual) => residual.status === 'held'), JSON.stringify(residuals)).toBe(true);

    if (name === 'lead-hard-brake') {
      expect(trace.metrics.minTTC).toMatchObject({ value: expect.closeTo(2.724, 2) });
    } else if (name === 'cutout-reveals-stopped') {
      expect(input.actors.find((actor) => actor.id === 'stopped')).toMatchObject({ static: true });
      expect(trace.metrics.minTTC).toMatchObject({ pair: expect.arrayContaining(['ego', 'stopped']) });
    } else {
      const ego = input.actors.find((actor) => actor.id === 'ego')!;
      const cutIn = input.actors.find((actor) => actor.id === 'cut-in')!;
      const forwardLead = (cutIn.initial.pose.x - ego.initial.pose.x) * Math.cos(ego.initial.pose.headingRad)
        + (cutIn.initial.pose.z - ego.initial.pose.z) * Math.sin(ego.initial.pose.headingRad);
      expect(forwardLead).toBeGreaterThan(0);
      // A real adjacent-lane merge is completed before the lead brakes. The
      // governed response remains enabled; the short TTC is an observed
      // challenge, never a collision manufactured by disabling safety.
      expect(ego.behavior.rules.collisionAvoidance).toBe(true);
      expect(cutIn.behavior.rules.collisionAvoidance).toBe(true);
      expect(trace.events.filter((event) => event.kind === 'trigger_fired').map((event) => event.interactionId))
        .toEqual(['cut-in-enters', 'cut-in-brakes', 'ego-brakes']);
      expect(trace.metrics.minTTC).toMatchObject({
        pair: expect.arrayContaining(['ego', 'cut-in']),
        value: expect.any(Number),
      });
      expect(trace.metrics.minTTC!.value).toBeGreaterThanOrEqual(0.5);
      expect(trace.metrics.minTTC!.value).toBeLessThanOrEqual(3);
      expect(trace.metrics.criticalitySamples?.ttc.some((sample) =>
        sample.pair.includes('ego') && sample.pair.includes('cut-in') && sample.t.some((t) => t >= 3.5 && t <= 7),
      )).toBe(true);

      const extendedInput = { ...input, clipSeconds: 20 };
      const { trace: extendedTrace } = runSimulation(extendedInput, { graph: matched.bundle.graph, guards: 'collect' });
      expect(extendedTrace.ticks.t).toHaveLength(1001);
      expect(extendedTrace.ticks.t.at(-1)).toBe(20);
      expect(extendedTrace.metrics.collisions).toEqual([]);
      expect(extendedTrace.events.filter((event) => event.kind === 'trigger_fired').map((event) => event.interactionId))
        .toEqual(['cut-in-enters', 'cut-in-brakes', 'ego-brakes']);
    }
  }, 90_000);

  it('keeps focused deterministic cut-in draws collision-free and critical', async () => {
    const template = await readTemplate(path.join(TEMPLATE_DIR, 'cut-in-brake.template.json'));
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === '4e6a7c2e681baa06');
    expect(site).toBeDefined();

    for (const drawIndex of [-1, 0, 1, 2]) {
      const { input, manifest } = materialize(template, matched.bundle, site!, { drawIndex });
      expect(manifest.feasible).toBe(true);
      const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
      expect(trace.metrics.collisions).toEqual([]);
      expect(trace.metrics.minTTC?.value).toBeGreaterThanOrEqual(0.5);
      expect(trace.metrics.minTTC?.value).toBeLessThanOrEqual(3);
      expect(evaluateMetrics(trace.metrics, template.choreography.clipSeconds, { rejectCollisions: true }).findings).toEqual([]);

      const residuals = checkInvariants({
        template,
        trace,
        scope: { params: manifest.params.values, clip: { seconds: template.choreography.clipSeconds } },
        arrival: manifest.arrival,
        speedLimitKph: matched.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null,
      });
      expect(residuals.every((residual) => residual.status === 'held'), JSON.stringify(residuals)).toBe(true);
    }
  }, 90_000);

  it('rejects the audited opposing-road queue binding', async () => {
    const template = await readTemplate(path.join(TEMPLATE_DIR, 'queue-tail.template.json'));
    const matched = await matchOnMap(template, MAP);
    const rejected = matched.report.rejected.find((candidate) => candidate.siteId === '2aa55508a96f3e0e');
    expect(rejected).toBeDefined();
    expect(rejected!.bindings).toContainEqual(expect.objectContaining({
      role: 'queue-tail',
      status: 'failed',
      notes: expect.arrayContaining([expect.stringMatching(/requires same road section as ego/)]),
    }));
  }, 90_000);

  it('retains an executable same-lane stopped queue with physical spacing', async () => {
    const template = await readTemplate(path.join(TEMPLATE_DIR, 'queue-tail.template.json'));
    const matched = await matchOnMap(template, MAP);
    const site = matched.report.sites.find((candidate) => candidate.siteId === '450377435bfb2d85');
    expect(site).toBeDefined();
    const { input, manifest } = materialize(template, matched.bundle, site!, { drawIndex: -1 });
    const tail = input.actors.find((actor) => actor.id === 'queue-tail')!;
    const lead = input.actors.find((actor) => actor.id === 'queue-lead')!;
    expect(tail).toMatchObject({ static: true, initial: { speedMps: 0 } });
    expect(lead).toMatchObject({ static: true, initial: { speedMps: 0 } });
    expect(tail.initial.laneRef?.rsl).toBe(lead.initial.laneRef?.rsl);
    expect(Math.hypot(
      tail.initial.pose.x - lead.initial.pose.x,
      tail.initial.pose.z - lead.initial.pose.z,
    )).toBeCloseTo(manifest.params.values.queueSpacingM!, 1);

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    const egoTrack = trace.ticks.actors.ego!;
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.events.filter((event) => event.kind === 'trigger_fired')).toEqual([
      expect.objectContaining({ interactionId: 'ego-brakes-on-reveal', actorId: 'ego', t: expect.closeTo(1.9, 5) }),
    ]);
    expect(input.actors.find((actor) => actor.id === 'ego')).toMatchObject({
      initial: { speedMps: expect.closeTo(14.577778, 5) },
      behavior: { rules: { collisionAvoidance: false } },
    });
    const observedDecel = egoTrack.speedMps.slice(1).reduce((maximum, speed, index) => {
      const dt = trace.ticks.t[index + 1]! - trace.ticks.t[index]!;
      return Math.max(maximum, (egoTrack.speedMps[index]! - speed) / dt);
    }, 0);
    expect(observedDecel).toBeCloseTo(8, 5);
    expect(egoTrack.s.every((s, index) => index === 0 || s >= egoTrack.s[index - 1]! - 1e-9)).toBe(true);
    const speedLimitKph = matched.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null;
    const residuals = checkInvariants({
      template,
      trace,
      scope: {
        params: manifest.params.values,
        clip: { seconds: template.choreography.clipSeconds },
        lane: speedLimitKph === null ? {} : { speedLimitKph },
      },
      arrival: manifest.arrival,
      speedLimitKph,
    });
    expect(residuals.every((residual) => residual.status === 'held'), JSON.stringify(residuals)).toBe(true);
    expect(trace.metrics.minTTC).toMatchObject({
      pair: expect.arrayContaining(['ego', 'queue-tail']),
      value: expect.closeTo(1.49, 1),
    });
    expect(trace.metrics.minDistance).toContainEqual(expect.objectContaining({
      pair: expect.arrayContaining(['ego', 'queue-tail']),
      minDistanceM: expect.closeTo(8.6923, 3),
    }));
    expect(trace.metrics.declaredOcclusion).toContainEqual(expect.objectContaining({
      observer: 'ego', target: 'queue-tail', status: 'revealed_before_conflict',
      firstBlockedT: 0,
      losOpenT: expect.closeTo(2.42, 2),
      conflictT: expect.closeTo(3.7113, 3),
    }));
    expect(evaluateMetrics(trace.metrics, template.choreography.clipSeconds, { rejectCollisions: true }).findings)
      .toEqual([]);
    expect(new Set(egoTrack.speedMps.slice(-100))).toEqual(new Set([0]));
    expect(new Set(egoTrack.x.slice(-100)).size).toBe(1);
    expect(new Set(egoTrack.y.slice(-100)).size).toBe(1);
    expect(new Set(egoTrack.s.slice(-100)).size).toBe(1);
  }, 90_000);
});
