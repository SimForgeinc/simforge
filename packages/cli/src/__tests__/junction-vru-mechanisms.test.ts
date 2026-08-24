/**
 * Focused composition coverage for the junction/VRU mechanism tranche.
 *
 * These tests deliberately use the real Yale artifacts when available: schema
 * validity alone cannot prove that a turn, a map crossing, or a conflicting
 * gate can actually bind and materialize.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  validateTemplate,
  type Interaction,
  type ScenarioTemplateV2,
} from '@simforge/scenario';
import { criticalityWindow, evaluateTrace, runSimulation } from '@simforge/engine';

import { adaptTemplate } from '../adapt.js';
import { DEV_ASSETS, REPO_ROOT } from '@simforge/compiler/node';
import { materialize } from '../materialize.js';
import { resolveParams } from '../params.js';
import { findSite, matchOnMap } from '@simforge/compiler/node';
import { readTemplate } from '@simforge/compiler/node';

const MAP = 'yale-street';
const BELMONT_MAP = 'belmont-research-center';
const BELMONT_ADULT_SITE = '09a7cfa564438716';
const BELMONT_ADULT_SEED = 'd27a7ac0ec84eaf482d5bc4d09da0f8c0ae5fd84987f7579ec73f53c759470cc';
const YALE_RIGHT_TURN_SITE = '6b93dfcb1e303540';
const YALE_LEFT_TURN_SITE = '0288f40f0213a281';
const YALE_CYCLIST_CROSSING_SITE = '0702f5f7ef448100';
const YALE_CYCLIST_CROSSING_SEEDS = [
  'f20e3a2c3638759b488dcedddabad9055d05f1566c25791913751f3eac049b72',
  '339624416ae33a6afbd0fac339bfa5d9647805c2711c8b9aa4df03e3ead9e3ea',
  '84842d8c969794af2a2c9d3451a9a0e0229e5b24401112a69b5aaf582fab62d2',
] as const;
const DIR = path.join(REPO_ROOT, 'examples', 'mechanisms', 'junction-vru');
const FILES = {
  rightTurn: path.join(DIR, 'right-turn-crosswalk.template.json'),
  leftTurn: path.join(DIR, 'left-turn-crosswalk.template.json'),
  adultMidblock: path.join(DIR, 'adult-midblock-crossing.template.json'),
  blockedBox: path.join(DIR, 'intersection-blocked-box-reveal.template.json'),
  cyclistCrossing: path.join(DIR, 'cyclist-crossing-path.template.json'),
} as const;

const CASES = [
  [FILES.rightTurn, 'intersection.right-turn-crosswalk'],
  [FILES.leftTurn, 'intersection.left-turn-crosswalk'],
  [FILES.adultMidblock, 'vru.adult-midblock-crossing'],
  [FILES.blockedBox, 'intersection-blocked-box-reveal'],
  [FILES.cyclistCrossing, 'vru.cyclist-crossing-path'],
] as const;

const haveArtifacts =
  existsSync(path.join(DEV_ASSETS, MAP, 'derived', 'topology-derived.json.gz')) &&
  existsSync(path.join(DEV_ASSETS, MAP, 'derived', 'locations.json.gz'));

const haveBelmontArtifacts =
  existsSync(path.join(DEV_ASSETS, BELMONT_MAP, 'derived', 'topology-derived.json.gz')) &&
  existsSync(path.join(DEV_ASSETS, BELMONT_MAP, 'derived', 'locations.json.gz'));

async function firstMaterialization(file: string) {
  const template = await readTemplate(file);
  const match = await matchOnMap(template, MAP);
  expect(match.report.sites.length, match.report.failureSummary).toBeGreaterThan(0);
  const selected = match.report.sites[0]!;
  const { bundle, site } = await findSite(template, MAP, selected.siteId);
  return { template, selected, site, ...materialize(template, bundle, site, { drawIndex: 0 }), bundle };
}

function interactionIsExecutable(interaction: Interaction): boolean {
  if (interaction.trigger.kind === 'after' && interaction.trigger.event === 'end') return false;
  if (interaction.until && interaction.until.kind !== 'when') return false;
  if (interaction.verb === 'speed' && interaction.target.mode === 'resume') return false;
  if (interaction.verb === 'route' && interaction.target.mode !== 'polyline') return false;
  if (interaction.verb === 'changeLane' && interaction.target.mode === 'relative' && interaction.target.dk === 0) return false;
  return true;
}

function conflictPose(roleId: 'pedestrian' | 'cyclist') {
  return { laneOffset: 0, s: 100, tFrac: 0, headingOffsetRad: 0, roleId };
}

function inWindowPathCriticality(trace: ReturnType<typeof runSimulation>['trace']) {
  const [lo, hi] = criticalityWindow(trace.header.clipSeconds);
  return [
    ...(trace.metrics.criticalitySamples?.pathTTC ?? []),
    ...(trace.metrics.criticalitySamples?.pet ?? []),
  ].flatMap((sample) => sample.t.map((t, index) => ({
    pair: sample.pair,
    t,
    value: sample.value[index]!,
  }))).filter((sample) =>
    sample.pair.includes('ego') && sample.pair.includes('pedestrian') &&
    sample.t >= lo && sample.t <= hi && Number.isFinite(sample.value),
  );
}

describe('junction/VRU templates', () => {
  it.each(CASES)('%s parses, validates, adapts, and resolves deterministic draws', async (file, archetype) => {
      const template = await readTemplate(file);
      expect(template.meta.archetype).toBe(archetype);
      expect(template.metricSubject).toBe('ego');
      expect(validateTemplate(template).issues.filter((issue) => issue.severity === 'error')).toEqual([]);

      const adapted = adaptTemplate(template);
      expect(adapted.roles.map((role) => role.role).sort()).toEqual(template.roles.map((role) => role.id).sort());
      expect(adapted.notes.filter((note) => /not portable|not matchable/.test(note.reason))).toEqual([]);

      for (const drawIndex of [-1, 0, 1]) {
        const draw = resolveParams(template, { siteId: 'junction-vru-mechanism-test-site', drawIndex });
        expect(draw.rejectedConstraints).toEqual([]);
        expect(Object.keys(draw.values)).toHaveLength(template.params.declarations.length);
      }

      expect(template.choreography.interactions.every(interactionIsExecutable)).toBe(true);
      for (const interaction of template.choreography.interactions) {
        if (interaction.verb === 'speed' || interaction.verb === 'gap' ||
            interaction.verb === 'changeLane' || interaction.verb === 'laneOffset') {
          expect(interaction.dynamics).toBeDefined();
        }
      }
  });

  it('contains exactly the five supported archetypes without unsupported incident claims', async () => {
    const templates: ScenarioTemplateV2[] = await Promise.all(Object.values(FILES).map(readTemplate));

    expect(templates.map((template) => template.meta.archetype).sort()).toEqual([
      'intersection-blocked-box-reveal',
      'intersection.left-turn-crosswalk',
      'intersection.right-turn-crosswalk',
      'vru.adult-midblock-crossing',
      'vru.cyclist-crossing-path',
    ]);

    const authoredClaims = templates
      .flatMap((template) => [template.meta.name, template.meta.description, ...template.meta.tags])
      .join(' ')
      .toLowerCase();
    for (const unsupported of ['stop-violation', 'red-light', 'encroachment', 'right-hook', 'crossing-guard']) {
      expect(authoredClaims).not.toContain(unsupported);
    }
  });

  it.each([
    ['right', FILES.rightTurn],
    ['left', FILES.leftTurn],
  ] as const)('requires a map-derived %s turn and mapped receiving-side pedestrian crossing', async (turn, file) => {
    const template = await readTemplate(file);
    expect(template.anchor.features).toContainEqual(expect.objectContaining({
      id: 'jx', kind: 'junction', essentiality: 'required',
      egoTurn: { value: [turn], essentiality: 'required' },
      // The crossing conflict is phase-released; a generic stop-controlled
      // approach would change the executed arrival after nominal solving.
      control: { value: ['signalized'], essentiality: 'required' },
    }));
    expect(template.anchor.features).toContainEqual(expect.objectContaining({
      id: 'xw', kind: 'crossing', essentiality: 'required',
    }));
    expect(template.roles.find((role) => role.id === 'pedestrian')).toMatchObject({
      kind: 'on_crossing',
      feature: 'xw',
      direction: 'near_to_far',
      actor: { class: 'pedestrian', catalogId: 'pedestrian.adult_walking' },
    });
  });

  it.each([
    [FILES.adultMidblock, 'pedestrian'],
    [FILES.cyclistCrossing, 'cyclist'],
  ] as const)('%s carries its semantic VRU through the exact conflict pose to a persistent far-side aftermath', async (file, roleId) => {
    const template = await readTemplate(file);
    const role = template.roles.find((candidate) => candidate.id === roleId)!;
    expect(role.actor.class).toBe(roleId === 'cyclist' ? 'bicycle' : 'pedestrian');
    if (roleId === 'pedestrian') expect(role.actor.catalogId).toBe('pedestrian.adult_walking');

    const route = template.choreography.interactions.find((interaction) =>
      interaction.actor === roleId && interaction.verb === 'route');
    expect(route).toMatchObject({ verb: 'route', target: { mode: 'polyline' } });
    if (route?.verb === 'route' && route.target.mode === 'polyline') {
      const expected = conflictPose(roleId);
      expect(route.target.points).toContainEqual(expect.objectContaining({
        laneOffset: expected.laneOffset, s: expected.s, tFrac: expected.tFrac,
      }));
      expect(route.target.points.at(-1)).toMatchObject({ s: 100, tFrac: 1 });
    }

    expect(template.choreography.interactions).toContainEqual(expect.objectContaining({
      actor: roleId,
      verb: 'set',
      target: { key: 'rules.collisionAvoidance', value: false },
    }));
    expect(template.choreography.interactions.some((interaction) => interaction.verb === 'exist')).toBe(false);
    expect(template.meta.tags).toContain('stable-aftermath');
  });

  it('keeps blocked-box reveal participants distinct and the queue van as a directional physical occluder', async () => {
    const template = await readTemplate(FILES.blockedBox);
    expect(template.roles.find((role) => role.id === 'cross-traffic')).toMatchObject({
      kind: 'conflicting_gate',
      feature: 'jx',
      from: 'from_left',
      turn: 'straight',
      actor: { class: 'car', catalogId: 'vehicle.suv' },
    });
    expect(template.roles.find((role) => role.id === 'stopped-queue')).toMatchObject({
      kind: 'lane_offset',
      k: 1,
      onMissing: 'fail',
      actor: { class: 'van', catalogId: 'vehicle.van', static: true },
      initialSpeedKph: 0,
      extensions: { occludes: { observer: 'ego', target: 'cross-traffic' } },
    });
    expect(template.choreography.interactions.some((interaction) => interaction.verb === 'exist')).toBe(false);
  });

  it('requires both solved arrival and physical criticality for every incident pair', async () => {
    const templates = await Promise.all(Object.values(FILES).map(readTemplate));
    for (const template of templates) {
      expect(template.invariants).toContainEqual(expect.objectContaining({
        kind: 'arrival', essentiality: 'required', syncWith: 'ego',
      }));
      expect(template.invariants).toContainEqual(expect.objectContaining({
        kind: 'pet', essentiality: 'required', of: 'ego',
      }));
    }
  });
});

describe.skipIf(!haveArtifacts)('junction/VRU templates on Yale Street', () => {
  it.each([
    ['right', FILES.rightTurn],
    ['left', FILES.leftTurn],
  ] as const)('binds the %s-turn path to a receiving-side map crossing', async (turn, file) => {
    const { selected, site, input, manifest, bundle } = await firstMaterialization(file);

    expect(selected.frame.egoTurn).toBe(turn);
    expect(selected.featureMatches['xw']?.kind).toBe('crossing');
    expect(selected.featureMatches['xw']?.s).toBeGreaterThanOrEqual(0);
    expect(selected.bindings.find((binding) => binding.role === 'pedestrian')).toEqual(
      expect.objectContaining({ kind: 'on_crossing', status: 'bound' }),
    );

    const pedestrian = input.actors.find((actor) => actor.id === 'pedestrian')!;
    expect(pedestrian.kind).toBe('pedestrian');
    expect(pedestrian.behavior.route.kind).toBe('polyline');
    expect(site.frame.referencePath.length).toBeGreaterThan(1);
    expect(
      manifest.arrival.find((arrival) => arrival.actorId === 'pedestrian'),
      JSON.stringify(manifest.notes),
    ).toEqual(
      expect.objectContaining({ converged: true, referenceActorId: 'ego' }),
    );
    expect(manifest.notes.filter((note) => /not expressible|has no engine counterpart|interaction dropped/.test(note.reason))).toEqual([]);

    const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    for (const actorId of ['ego', 'pedestrian']) {
      expect(trace.ticks.actors[actorId]?.present.at(-1)).toBe(1);
      expect(trace.events.some((event) => event.kind === 'despawn' && event.actorId === actorId)).toBe(false);
    }
  }, 30_000);

  it.each([
    ['right', FILES.rightTurn, YALE_RIGHT_TURN_SITE],
    ['left', FILES.leftTurn, YALE_LEFT_TURN_SITE],
  ] as const)('keeps the exact signalized %s-turn pedestrian conflict executable, controlled, and collision-free', async (_turn, file, siteId) => {
    const template = await readTemplate(file);
    const { bundle, site } = await findSite(template, MAP, siteId);
    const { input, manifest } = materialize(template, bundle, site, { drawIndex: 0 });
    const release = input.interactions.find((interaction) => interaction.id === 'ego-bound-signal-proceeds');

    expect(manifest.feasible).toBe(true);
    expect(manifest.arrival).toContainEqual(expect.objectContaining({
      actorId: 'pedestrian', referenceActorId: 'ego', converged: true,
    }));
    expect(release).toMatchObject({
      verb: 'set', trigger: { kind: 'at', t: 0 }, target: { value: 'green' },
    });
    expect(release?.verb).toBe('set');
    const signalId = release?.verb === 'set'
      ? /^signal:(.+)\.phase$/.exec(release.target.key)?.[1]
      : undefined;
    const program = input.signalPrograms.find((candidate) => candidate.id === signalId);
    expect(program?.mapBinding).toEqual(expect.objectContaining({
      junctionId: expect.any(String),
      timingSource: 'synthetic-default',
      headIds: expect.arrayContaining([expect.any(String)]),
      controllerHeadGroups: expect.arrayContaining([
        expect.objectContaining({ controllerId: expect.any(String), headIds: expect.any(Array) }),
      ]),
    }));

    const { trace, issues } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    const evaluation = evaluateTrace(trace, { rejectCollisions: true });
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(inWindowPathCriticality(trace)).not.toEqual([]);
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.metrics.clippedCriticality).toBe(false);
    expect(trace.ticks.actors.ego?.present.at(-1)).toBe(1);
    expect(trace.ticks.actors.pedestrian?.present.at(-1)).toBe(1);
    expect(trace.events.some((event) => event.kind === 'despawn' &&
      (event.actorId === 'ego' || event.actorId === 'pedestrian'))).toBe(false);
    expect(evaluation.verdict, JSON.stringify(evaluation.findings)).toBe('accept');
  }, 30_000);

  it('materializes the adult as a continuous lateral midblock crossing', async () => {
    const { input, manifest, bundle } = await firstMaterialization(FILES.adultMidblock);
    const pedestrian = input.actors.find((actor) => actor.id === 'pedestrian')!;

    expect(pedestrian.kind).toBe('pedestrian');
    expect(pedestrian.behavior.route.kind).toBe('polyline');
    expect(manifest.notes.some((note) => note.reason.includes('folded into'))).toBe(true);
    expect(manifest.arrival.find((arrival) => arrival.actorId === 'pedestrian')?.converged).toBe(true);

    const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    expect(trace.ticks.actors.pedestrian?.present.at(-1)).toBe(1);
    expect(trace.events.some((event) => event.kind === 'despawn' && event.actorId === 'pedestrian')).toBe(false);
  }, 30_000);

  it('binds blocked-box cross traffic to a real crossing gate and preserves the occluder pair', async () => {
    const { selected, input, manifest, bundle } = await firstMaterialization(FILES.blockedBox);
    const challenger = selected.bindings.find((binding) => binding.role === 'cross-traffic');

    expect(challenger).toEqual(expect.objectContaining({ kind: 'conflicting_gate', status: 'bound' }));
    expect(challenger?.conflict).toEqual(
      expect.objectContaining({ relation: 'from_left', crossingAngleDeg: expect.any(Number) }),
    );
    expect(selected.bindings.find((binding) => binding.role === 'stopped-queue')).toEqual(
      expect.objectContaining({ kind: 'lane_offset', status: 'bound' }),
    );
    expect(input.actors.find((actor) => actor.id === 'stopped-queue')).toEqual(
      expect.objectContaining({ kind: 'van', static: true }),
    );
    expect(input.occlusionPairs).toEqual([
      { observer: 'ego', target: 'cross-traffic', occluderId: 'actor:stopped-queue' },
    ]);
    expect(manifest.arrival.find((arrival) => arrival.actorId === 'cross-traffic')?.converged).toBe(true);
    expect(manifest.notes.filter((note) => /not expressible|has no engine counterpart|interaction dropped/.test(note.reason))).toEqual([]);

    const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    expect(trace.metrics.declaredOcclusion).toContainEqual(expect.objectContaining({
      observer: 'ego',
      target: 'cross-traffic',
      occluderId: 'actor:stopped-queue',
      status: 'revealed_before_conflict',
    }));
    expect(trace.metrics.occluderIneffective).toEqual([]);
    expect(trace.metrics.revealToConflict).toMatchObject({
      observer: 'ego', target: 'cross-traffic', occluderId: 'actor:stopped-queue',
    });
    for (const actorId of ['ego', 'cross-traffic', 'stopped-queue']) {
      expect(trace.ticks.actors[actorId]?.present.at(-1)).toBe(1);
      expect(trace.events.some((event) => event.kind === 'despawn' && event.actorId === actorId)).toBe(false);
    }
  }, 30_000);

  it('preserves bicycle semantics through materialization and simulation', async () => {
    const { template, input, bundle, manifest } = await firstMaterialization(FILES.cyclistCrossing);
    const role = template.roles.find((candidate) => candidate.id === 'cyclist')!;
    const cyclist = input.actors.find((actor) => actor.id === 'cyclist')!;

    expect(role.actor.class).toBe('bicycle');
    expect(cyclist.kind).toBe('bicycle');
    expect(cyclist.dims).toEqual({ l: 1.8, w: 0.6, h: 1.7 });
    expect(cyclist.tags).toContain('class:bicycle');
    expect(cyclist.behavior.route.kind).toBe('polyline');
    expect(manifest.arrival.find((arrival) => arrival.actorId === 'cyclist')?.converged).toBe(true);

    const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    expect(trace.header.actorMetadata?.['cyclist']).toEqual(
      expect.objectContaining({ kind: 'bicycle', dims: { l: 1.8, w: 0.6, h: 1.7 } }),
    );
    expect(trace.metrics.minPET?.pair.slice().sort()).toEqual(['cyclist', 'ego']);
    expect(trace.metrics.minPET?.value).toBeLessThan(3);
    expect(trace.ticks.actors.cyclist?.present.at(-1)).toBe(1);
    expect(trace.events.some((event) => event.kind === 'despawn' && event.actorId === 'cyclist')).toBe(false);
  }, 30_000);

  it.each(YALE_CYCLIST_CROSSING_SEEDS)(
    'keeps the fresh cyclist-crossing seed %s continuously bound and campaign-critical',
    async (seed) => {
      const template = await readTemplate(FILES.cyclistCrossing);
      const { bundle, site } = await findSite(template, MAP, YALE_CYCLIST_CROSSING_SITE);
      const { input, manifest } = materialize(template, bundle, site, { drawIndex: 0, seed });
      const cyclist = input.actors.find((actor) => actor.id === 'cyclist')!;
      expect(cyclist.kind).toBe('bicycle');
      expect(cyclist.behavior.route.kind).toBe('polyline');
      expect(manifest.arrival).toContainEqual(expect.objectContaining({
        actorId: 'cyclist', referenceActorId: 'ego', converged: true,
      }));

      const { trace } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
      const evaluation = evaluateTrace(trace, { rejectCollisions: true });
      expect(trace.metrics.collisions).toEqual([]);
      expect(trace.metrics.minPET).toMatchObject({
        pair: expect.arrayContaining(['cyclist', 'ego']), value: expect.any(Number),
      });
      expect(trace.ticks.actors.cyclist?.present.at(-1)).toBe(1);
      expect(trace.ticks.actors.ego?.present.at(-1)).toBe(1);
      expect(evaluation, JSON.stringify(evaluation.findings)).toMatchObject({ verdict: 'accept', findings: [] });
    },
    60_000,
  );
});

describe.skipIf(!haveBelmontArtifacts)('adult midblock catalog regression on Belmont', () => {
  it('keeps the exact seeded pedestrian crossing critical, in-window, collision-free, and stable', async () => {
    const template = await readTemplate(FILES.adultMidblock);
    const { bundle, site } = await findSite(template, BELMONT_MAP, BELMONT_ADULT_SITE);
    const { input, manifest } = materialize(template, bundle, site, {
      drawIndex: 0,
      seed: BELMONT_ADULT_SEED,
    });

    expect(manifest.feasible).toBe(true);
    expect(manifest.params.values.arrivalTtc).toBeCloseTo(1.0967710273340343, 9);
    expect(manifest.arrival).toContainEqual(expect.objectContaining({
      actorId: 'pedestrian',
      referenceActorId: 'ego',
      converged: true,
    }));

    const { trace, issues } = runSimulation(input, { graph: bundle.graph, guards: 'collect' });
    const evaluation = evaluateTrace(trace, { rejectCollisions: true });
    const pedestrian = trace.header.actorMetadata?.pedestrian;
    const inWindowPet = trace.metrics.criticalitySamples?.pet
      .filter((sample) => sample.pair.includes('ego') && sample.pair.includes('pedestrian'))
      .flatMap((sample) => sample.t.map((t, index) => ({ t, value: sample.value[index]! })))
      .filter(({ t }) => t >= 4 && t <= 10)
      .sort((a, b) => a.value - b.value || a.t - b.t)[0];

    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(pedestrian).toEqual(expect.objectContaining({ kind: 'pedestrian', static: false }));
    expect(inWindowPet).toEqual(expect.objectContaining({
      t: expect.any(Number),
      value: expect.any(Number),
    }));
    expect(inWindowPet!.value).toBeGreaterThanOrEqual(0.2);
    expect(inWindowPet!.value).toBeLessThanOrEqual(1.5);
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.metrics.minDistance[0]?.minDistanceM).toBeGreaterThan(0);
    expect(trace.ticks.actors.pedestrian?.present.at(-1)).toBe(1);
    expect(trace.ticks.actors.pedestrian?.speedMps.at(-1)).toBe(0);
    expect(trace.events.some((event) => event.kind === 'despawn' && event.actorId === 'pedestrian')).toBe(false);
    expect(evaluation.verdict, JSON.stringify(evaluation.findings)).toBe('accept');
  }, 30_000);
});
