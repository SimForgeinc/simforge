/**
 * Executability and semantic-identity contract for road-departure/obstacle
 * mechanism templates. Real materialization checks use any available supported
 * map artifacts; document checks always run on a clean checkout.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  validateTemplate,
  type Interaction,
  type ScenarioTemplateV2,
} from '@simforge/scenario';
import { runSimulation } from '@simforge/engine';

import { adaptTemplate } from '../adapt.js';
import { checkInvariants } from '../invariants.js';
import { DEV_ASSETS, KNOWN_MAPS, REPO_ROOT } from '@simforge/compiler/node';
import { materialize } from '../materialize.js';
import { resolveParams } from '../params.js';
import { findSite, matchOnMap } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

const DIRECTORY = path.join(REPO_ROOT, 'examples', 'mechanisms', 'obstacle');
const FILES = {
  curve: path.join(DIRECTORY, 'curve-loss-control.template.json'),
  cargo: path.join(DIRECTORY, 'fallen-cargo.template.json'),
  animal: path.join(DIRECTORY, 'animal-crossing.template.json'),
  disabled: path.join(DIRECTORY, 'disabled-vehicle.template.json'),
} as const;

const CASES = [
  [FILES.curve, 'road-departure.curve-loss-control'],
  [FILES.cargo, 'obstacle.fallen-cargo'],
  [FILES.animal, 'obstacle.animal-crossing'],
  [FILES.disabled, 'obstacle.disabled-vehicle'],
] as const;

const materializationMaps = KNOWN_MAPS.filter((mapId) =>
  existsSync(path.join(DEV_ASSETS, mapId, 'topology-index.json.gz')) &&
  existsSync(path.join(DEV_ASSETS, mapId, 'derived', 'topology-derived.json.gz')) &&
  existsSync(path.join(DEV_ASSETS, mapId, 'derived', 'locations.json.gz')),
);
const haveArtifacts = materializationMaps.length > 0;

async function read(file: string): Promise<ScenarioTemplateV2> {
  return readTemplate(file);
}

function isMaterializableInteraction(interaction: Interaction): boolean {
  if (interaction.trigger.kind === 'after' && interaction.trigger.event === 'end') return false;
  if (interaction.until && interaction.until.kind !== 'when') return false;
  if (interaction.verb === 'speed' && interaction.target.mode === 'resume') return false;
  if (interaction.verb === 'route' && interaction.target.mode !== 'polyline') return false;
  if (interaction.verb === 'changeLane' && interaction.target.mode === 'relative' && interaction.target.dk === 0) return false;
  return true;
}

async function findFirstMaterialization(file: string) {
  const template = await read(file);
  const failures: string[] = [];
  for (const mapId of materializationMaps) {
    const matched = await matchOnMap(template, mapId);
    const selected = matched.report.sites[0];
    if (!selected) {
      failures.push(`${mapId}: ${matched.report.failureSummary ?? 'no feasible site'}`);
      continue;
    }
    const { bundle, site } = await findSite(template, mapId, selected.siteId);
    return { template, bundle, site, ...materialize(template, bundle, site, { drawIndex: 0 }) };
  }
  throw new Error(`No materializable site for ${template.meta.archetype}: ${failures.join(' | ')}`);
}

const materializationCache = new Map<string, ReturnType<typeof findFirstMaterialization>>();

function firstMaterialization(file: string): ReturnType<typeof findFirstMaterialization> {
  const cached = materializationCache.get(file);
  if (cached) return cached;
  const result = findFirstMaterialization(file);
  materializationCache.set(file, result);
  return result;
}

describe('road-departure and obstacle templates', () => {
  it.each(CASES)('%s parses, validates, adapts, and resolves deterministic draws', async (file, archetype) => {
    const template = await read(file);
    expect(template.meta.archetype).toBe(archetype);
    expect(template.metricSubject).toBe('ego');
    expect(validateTemplate(template).issues.filter((issue) => issue.severity === 'error')).toEqual([]);

    const adapted = adaptTemplate(template);
    expect(adapted.roles.map((role) => role.role).sort()).toEqual(
      template.roles.map((role) => role.id).sort(),
    );
    expect(adapted.notes.filter((note) => /not portable|not matchable/.test(note.reason))).toEqual([]);

    for (const drawIndex of [-1, 0, 1]) {
      const draw = resolveParams(template, { siteId: 'obstacle-mechanism-test-site', drawIndex });
      expect(draw.rejectedConstraints).toEqual([]);
      expect(Object.keys(draw.values)).toHaveLength(template.params.declarations.length);
    }

    expect(template.choreography.interactions.every(isMaterializableInteraction)).toBe(true);
    for (const interaction of template.choreography.interactions) {
      if (
        interaction.verb === 'speed' || interaction.verb === 'gap' ||
        interaction.verb === 'changeLane' || interaction.verb === 'laneOffset'
      ) {
        expect(interaction.dynamics).toBeDefined();
      }
    }
  });

  it('models a required curve, a collidable road edge, and ordered drift/recovery behavior', async () => {
    const template = await read(FILES.curve);
    expect(template.anchor.corridor?.curvatureDegPer10m).toMatchObject({
      value: [0.12, 35],
      essentiality: 'required',
    });
    expect(template.environment).toMatchObject({ weather: 'wet_road', frictionScale: expect.anything() });
    expect(template.roles.find((role) => role.id === 'road-edge')?.actor).toMatchObject({
      class: 'static_object',
      static: true,
      dims: { length: 18, width: 0.45, height: 0.8 },
    });
    expect(template.choreography.interactions.find((item) => item.id === 'ego-drifts-to-edge')).toMatchObject({
      actor: 'ego',
      verb: 'laneOffset',
      target: { reference: 'lane_center' },
    });
    expect(template.invariants).toContainEqual(expect.objectContaining({
      kind: 'event_order',
      events: ['ego-drifts-to-edge', 'ego-recovery-stop'],
    }));
  });

  it('keeps fallen cargo a collidable static actor rather than a cosmetic prop', async () => {
    const template = await read(FILES.cargo);
    const cargo = template.roles.find((role) => role.id === 'cargo');
    expect(cargo).toMatchObject({
      kind: 'on_reference',
      actor: {
        class: 'static_object',
        static: true,
        dims: { length: 1.8, width: 1.3, height: 0.9 },
      },
      pose: { tFrac: expect.anything() },
      initialSpeedKph: 0,
    });
    expect(template.props).toEqual([]);
    expect(template.choreography.interactions.find((item) => item.id === 'ego-brakes-for-cargo')).toMatchObject({
      verb: 'speed',
      trigger: { kind: 'when', condition: { kind: 'distance', to: { role: 'cargo' } } },
      target: { mode: 'stop' },
    });
  });

  it('preserves semantic animal identity, solved cross-road motion, and a terminal aftermath pose', async () => {
    const template = await read(FILES.animal);
    expect(template.roles.find((role) => role.id === 'animal')?.actor).toMatchObject({ class: 'animal' });
    const crossing = template.choreography.interactions.find((item) => item.id === 'animal-crosses-road');
    expect(crossing).toMatchObject({
      verb: 'route',
      target: { mode: 'polyline' },
    });
    if (crossing?.verb === 'route' && crossing.target.mode === 'polyline') {
      expect(crossing.target.points[0]).toMatchObject({ s: 70, tFrac: -1 });
      expect(crossing.target.points.at(-1)).toMatchObject({ s: 100, tFrac: 1 });
    }
    expect(template.choreography.interactions.find((item) => item.id === 'animal-arrival')?.trigger).toMatchObject({
      kind: 'arrival',
      of: 'animal',
      syncWith: 'ego',
    });
    expect(template.choreography.interactions.some((item) => item.verb === 'exist')).toBe(false);
  });

  it('keeps the disabled vehicle and stranded pedestrian stationary with visible warning state', async () => {
    const template = await read(FILES.disabled);
    expect(template.roles.find((role) => role.id === 'disabled-vehicle')?.actor).toMatchObject({
      class: 'car', static: true,
    });
    expect(template.roles.find((role) => role.id === 'stranded-occupant')).toMatchObject({
      actor: { class: 'pedestrian', static: true },
      tFrac: 0.96,
      initialSpeedKph: 0,
    });
    expect(template.choreography.interactions.find((item) => item.id === 'disabled-hazards-on')).toMatchObject({
      actor: 'disabled-vehicle',
      verb: 'set',
      target: { key: 'lights.indicator', value: 'hazard' },
    });
    expect(template.choreography.interactions.some((item) => item.verb === 'exist')).toBe(false);
  });

  it('uses only registered behavior and presentation keys', async () => {
    const templates = await Promise.all(Object.values(FILES).map(read));
    const keys = templates.flatMap((template) => template.choreography.interactions)
      .filter((interaction): interaction is Extract<Interaction, { verb: 'set' }> => interaction.verb === 'set')
      .map((interaction) => interaction.target.key)
      .sort();
    expect(keys).toEqual([
      'lights.indicator',
      'pose.gesture',
      'rules.collisionAvoidance',
      'rules.collisionAvoidance',
    ]);
  });
});

describe.skipIf(!haveArtifacts)('road-departure and obstacle materialization on available maps', () => {
  it.each(CASES)('%s materializes deterministically with a complete replay key', async (file, archetype) => {
    const { template, bundle, site, input, manifest } = await firstMaterialization(file);
    const replay = materialize(template, bundle, site, { drawIndex: 0 });

    expect(manifest.archetype).toBe(archetype);
    expect(manifest.replayKey).toMatchObject({
      templateId: template.anchor.id,
      templateVersion: 2,
      mapId: bundle.mapId,
      siteId: site.siteId,
      drawIndex: 0,
    });
    expect(manifest.replayKey.templateDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(manifest.inputHash).toBe(replay.manifest.inputHash);
    expect(input).toEqual(replay.input);
    expect(manifest.notes.filter((note) => /has no engine counterpart|interaction dropped/.test(note.reason))).toEqual([]);
  }, 60_000);

  it('materializes curve drift against a static, collidable road-edge actor', async () => {
    const { input } = await firstMaterialization(FILES.curve);
    expect(input.actors.find((actor) => actor.id === 'road-edge')).toMatchObject({
      kind: 'static_object', static: true,
    });
    expect(input.actors.find((actor) => actor.id === 'ego')?.behavior.rules.collisionAvoidance).toBe(false);
    expect(input.interactions.find((interaction) => interaction.id === 'ego-drifts-to-edge')?.verb).toBe('laneOffset');
  }, 60_000);

  it('keeps the formerly non-interacting Belmont curve draw physically critical but collision-free', async () => {
    const template = await read(FILES.curve);
    const matched = await matchOnMap(template, 'belmont-research-center');
    const site = matched.report.sites.find((candidate) => candidate.siteId === 'ca46a69a7d415c03');
    expect(site).toBeDefined();
    const { input, manifest } = materialize(template, matched.bundle, site!, {
      drawIndex: 2,
      seed: 'ed01346c2af4fbd54d5b3bcd78e7938f0c0d960ffd5cfa9b554af27ff4631d29',
    });
    expect(manifest.feasible).toBe(true);
    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
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
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.metrics.minTTC).toMatchObject({
      pair: expect.arrayContaining(['ego', 'road-edge']),
      value: expect.closeTo(0.963, 2),
    });
    expect(trace.ticks.actors.ego!.speedMps.at(-1)).toBe(0);
    expect(residuals.filter((entry) => entry.essentiality === 'required' && entry.status !== 'held')).toEqual([]);
  }, 90_000);

  it('materializes cargo as a static collision participant and preserves the controlled-stop action', async () => {
    const { input } = await firstMaterialization(FILES.cargo);
    expect(input.actors.find((actor) => actor.id === 'cargo')).toMatchObject({
      kind: 'static_object', static: true,
    });
    expect(input.occluders).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: 'cargo' })]));
    expect(input.interactions.find((interaction) => interaction.id === 'ego-brakes-for-cargo')).toMatchObject({
      verb: 'speed', target: { mode: 'stop' },
    });
  }, 60_000);

  it('materializes and simulates the animal as an animal that remains present after finishing its route', async () => {
    const { input, bundle, manifest } = await firstMaterialization(FILES.animal);
    const animal = input.actors.find((actor) => actor.id === 'animal')!;
    expect(animal.kind).toBe('animal');
    expect(animal.behavior.route.kind).toBe('polyline');
    expect(manifest.arrival.find((arrival) => arrival.actorId === 'animal')?.converged).toBe(true);

    const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    const track = trace.ticks.actors.animal!;
    expect(track.present.at(-1)).toBe(1);
    expect(track.speedMps.at(-1)).toBe(0);
    expect(trace.events.some((event) => event.kind === 'despawn' && event.actorId === 'animal')).toBe(false);
  }, 60_000);

  it('holds the disabled vehicle and stranded occupant fixed through the aftermath', async () => {
    const { input, bundle } = await firstMaterialization(FILES.disabled);
    expect(input.actors.find((actor) => actor.id === 'disabled-vehicle')).toMatchObject({ kind: 'car', static: true });
    expect(input.actors.find((actor) => actor.id === 'stranded-occupant')).toMatchObject({ kind: 'pedestrian', static: true });
    expect(input.interactions.find((interaction) => interaction.id === 'disabled-hazards-on')).toMatchObject({
      verb: 'set', target: { key: 'lights.indicator', value: 'hazard' },
    });

    const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    for (const actorId of ['disabled-vehicle', 'stranded-occupant']) {
      const track = trace.ticks.actors[actorId]!;
      expect(new Set(track.x).size).toBe(1);
      expect(new Set(track.y).size).toBe(1);
      expect(track.present.every((present) => present === 1)).toBe(true);
    }
  }, 60_000);
});
