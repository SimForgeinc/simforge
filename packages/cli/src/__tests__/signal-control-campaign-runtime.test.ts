import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { evaluateTrace, runSimulation } from '@simforge/engine';

import { checkInvariants } from '../invariants.js';
import { DEV_ASSETS, REPO_ROOT } from '@simforge/compiler';
import { materialize } from '../materialize.js';
import { findSite } from '@simforge/compiler';
import { readTemplate } from '@simforge/compiler';

const MAP = 'yale-street';
const haveArtifacts = existsSync(path.join(DEV_ASSETS, MAP, 'derived', 'topology-derived.json.gz'));
const REMAINING = path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining');
const JUNCTION_VRU = path.join(REPO_ROOT, 'examples', 'mechanisms', 'junction-vru');

const STOP = {
  file: path.join(REMAINING, 'cross-traffic-stop-violation.template.json'),
  siteId: '63766d5398e0c41c',
  seeds: [
    '60f4d6c7bc2ccebc1c9ffedd26e2bcd85140a9c2e363d85954bb530487a0bb1e',
    '3c0a20a31b156484365eb2b8dfbc3b6f9113fa806157d2ef8e4c00c5ff10e66c',
    'e9dfbca7df4dccee6775f723dea486c68fb95f06ded0b753c3a681736415928f',
  ],
} as const;

const RED = {
  file: path.join(REMAINING, 'red-light-late-entry.template.json'),
  siteId: '887600a74e1e2c0d',
  seeds: [
    '73743a24c48e0ce4492530f111e38156cc0aba99c995dd6fec0b5aa72eb1f732',
    '347f630b0a14067e2bf629749a5ff0a6bc48c97a4a9f30650bc2b9047abb4379',
    '1627c35548d3993813a778f58d0c5db3a0625b683074674b3ccd5c54403a9274',
  ],
} as const;

const LEFT = {
  file: path.join(JUNCTION_VRU, 'left-turn-crosswalk.template.json'),
  siteId: '079913526020aa66',
  seeds: [
    '958ca748b33c599cc87e6de5a3289de36fcd99ef5b24b1cf2f9b4aafdf64e0ab',
    '69d53d41ce9a02029d3f5f98098c3d82c8701c56583dbf21b43dd943c168015e',
    '95e089b86491b3ca16bcdd41ac253217fb2b365211730f4bea1c314c7135e30e',
  ],
} as const;

async function executeExact(file: string, siteId: string, seed: string, drawIndex: number) {
  const template = await readTemplate(file);
  const { bundle, site } = await findSite(template, MAP, siteId, { exactCatalogSiteResolution: true });
  const { input, manifest } = materialize(template, bundle, site, { seed, drawIndex });
  const { trace, issues } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
  const speedLimitKph = bundle.index.lanes[site.frame.entryLaneRsl]?.speedLimitKph ?? null;
  const invariants = checkInvariants({
    template,
    trace,
    scope: {
      params: manifest.params.values,
      clip: { seconds: trace.header.clipSeconds },
      ...(speedLimitKph === null ? {} : { lane: { speedLimitKph } }),
    },
    arrival: manifest.arrival,
    speedLimitKph,
  });
  return { template, input, manifest, trace, issues, invariants };
}

function expectAccepted(result: Awaited<ReturnType<typeof executeExact>>, actors: readonly string[]) {
  expect(result.manifest.feasible).toBe(true);
  expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  expect(result.invariants.filter((invariant) => invariant.essentiality === 'required' && invariant.status !== 'held')).toEqual([]);
  expect(result.trace.metrics.collisions).toEqual([]);
  expect(result.trace.metrics.clippedCriticality).toBe(false);
  const evaluation = evaluateTrace(result.trace, { rejectCollisions: true });
  expect(evaluation.verdict, JSON.stringify(evaluation.findings)).toBe('accept');
  for (const actorId of actors) {
    expect(result.trace.ticks.actors[actorId]?.present.at(-1)).toBe(1);
    expect(result.trace.events.some((event) => event.kind === 'despawn' && event.actorId === actorId)).toBe(false);
  }
}

function expectPhysicalSyntheticBinding(result: Awaited<ReturnType<typeof executeExact>>, interactionId: string) {
  const interaction = result.input.interactions.find((candidate) => candidate.id === interactionId);
  expect(interaction).toMatchObject({
    verb: 'set', trigger: { kind: 'at', t: 0 }, target: { key: expect.stringMatching(/^signal:.+\.phase$/) },
  });
  if (!interaction || interaction.verb !== 'set') throw new Error(`${interactionId} was not materialized as set(signal)`);
  const signalId = /^signal:(.+)\.phase$/.exec(interaction.target.key)?.[1];
  const program = result.input.signalPrograms.find((candidate) => candidate.id === signalId);
  expect(program?.mapBinding).toEqual(expect.objectContaining({
    junctionId: expect.any(String),
    timingSource: 'synthetic-default',
    headIds: expect.arrayContaining([expect.any(String)]),
    controllerHeadGroups: expect.arrayContaining([
      expect.objectContaining({ controllerId: expect.any(String), headIds: expect.arrayContaining([expect.any(String)]) }),
    ]),
  }));
}

describe.skipIf(!haveArtifacts)('fresh stratified signal/control campaign regressions', () => {
  it('keeps the exact stop-controlled violator rolling through, critical, and collision-free for every preserved draw', async () => {
    for (let drawIndex = 0; drawIndex < STOP.seeds.length; drawIndex += 1) {
      const result = await executeExact(STOP.file, STOP.siteId, STOP.seeds[drawIndex]!, drawIndex);
      expect(result.input.roadControls).toContainEqual(expect.objectContaining({
        kind: 'stop',
        mapBinding: expect.objectContaining({ source: 'map', controlIds: expect.arrayContaining([expect.any(String)]) }),
      }));
      expect(result.manifest.arrival).toContainEqual(expect.objectContaining({
        actorId: 'violator', referenceActorId: 'ego', converged: true,
      }));
      expectAccepted(result, ['ego', 'violator']);
    }
  }, 30_000);

  it('keeps exact opposing signal programs green/red with physical provenance and an achievable late-entry conflict', async () => {
    for (let drawIndex = 0; drawIndex < RED.seeds.length; drawIndex += 1) {
      const result = await executeExact(RED.file, RED.siteId, RED.seeds[drawIndex]!, drawIndex);
      expectPhysicalSyntheticBinding(result, 'ego-bound-signal-green');
      expectPhysicalSyntheticBinding(result, 'left-bound-signal-red');
      expect(result.input.interactions.find((interaction) => interaction.id === 'ego-bound-signal-green')).toMatchObject({
        target: { value: 'green' },
      });
      expect(result.input.interactions.find((interaction) => interaction.id === 'left-bound-signal-red')).toMatchObject({
        target: { value: 'red' },
      });
      expectAccepted(result, ['ego', 'late-entry']);
    }
  }, 30_000);

  it('keeps the selected mapped left turn yielding to its adult pedestrian with stable aftermath', async () => {
    for (let drawIndex = 0; drawIndex < LEFT.seeds.length; drawIndex += 1) {
      const result = await executeExact(LEFT.file, LEFT.siteId, LEFT.seeds[drawIndex]!, drawIndex);
      expectPhysicalSyntheticBinding(result, 'ego-bound-signal-proceeds');
      expect(result.input.actors.find((actor) => actor.id === 'pedestrian')).toMatchObject({
        kind: 'pedestrian', static: false,
      });
      expect(result.manifest.arrival).toContainEqual(expect.objectContaining({
        actorId: 'pedestrian', referenceActorId: 'ego', converged: true,
      }));
      expectAccepted(result, ['ego', 'pedestrian']);
    }
  }, 30_000);
});
