/**
 * Executability and mechanism-fidelity contract for school/work-zone examples.
 *
 * Document checks run in a clean checkout. Composition checks use the first
 * checked-in map artifact that can bind each template and skip only when this
 * checkout has no complete map artifacts at all.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateTrace, runSimulation } from '@uniscenarios/sim-engine';
import {
  checkSetValue,
  lookupSetKey,
  validateTemplate,
  type Interaction,
  type ScenarioTemplateV2,
} from '@uniscenarios/scenario-model';

import { adaptTemplate } from '../adapt.js';
import { matcherSiteClosesLocation } from '../catalog.js';
import { filtersFor } from '../commands/evaluate.js';
import { checkInvariants } from '../invariants.js';
import { DEV_ASSETS, KNOWN_MAPS, REPO_ROOT } from '@uniscenarios/scenario-materializer';
import { mapSetKey, materialize } from '../materialize.js';
import { resolveParams } from '../params.js';
import { findSite, matchOnMap } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const DIRECTORY = path.join(REPO_ROOT, 'examples', 'mechanisms', 'school-workzone');

const CASES = [
  ['crossing-guard-release.template.json', 'school.crossing-guard-release'],
  ['lane-shift.template.json', 'workzone.lane-shift'],
  ['worker-intrusion.template.json', 'workzone.worker-intrusion'],
] as const;

function file(name: string): string {
  return path.join(DIRECTORY, name);
}

async function template(name: string): Promise<ScenarioTemplateV2> {
  return readTemplate(file(name));
}

async function schoolDartout(): Promise<ScenarioTemplateV2> {
  return readTemplate(path.join(REPO_ROOT, 'examples', 'school-dartout.template.json'));
}

function interactionIsExecutable(interaction: Interaction): boolean {
  if (interaction.trigger.kind === 'after' && interaction.trigger.event === 'end') return false;
  if (interaction.until && interaction.until.kind !== 'when') return false;
  if (interaction.verb === 'speed' && interaction.target.mode === 'resume') return false;
  if (interaction.verb === 'route' && interaction.target.mode !== 'polyline') return false;
  if (interaction.verb === 'changeLane' && interaction.target.mode === 'relative' && interaction.target.dk === 0) return false;
  switch (interaction.verb) {
    case 'speed':
    case 'gap':
    case 'changeLane':
    case 'laneOffset':
      if (interaction.dynamics === undefined) return false;
      break;
    default:
      break;
  }
  return true;
}

const mapsWithCompleteArtifacts = KNOWN_MAPS.filter((mapId) =>
  [
    path.join(DEV_ASSETS, mapId, 'topology-index.json.gz'),
    path.join(DEV_ASSETS, mapId, 'derived', 'topology-derived.json.gz'),
    path.join(DEV_ASSETS, mapId, 'derived', 'locations.json.gz'),
  ].every(existsSync),
);

async function computeFirstMaterialization(name: string) {
  const doc = await template(name);
  const failures: string[] = [];
  for (const mapId of mapsWithCompleteArtifacts) {
    const match = await matchOnMap(doc, mapId);
    if (match.report.sites.length === 0) {
      failures.push(`${mapId}: ${match.report.failureSummary}`);
      continue;
    }
    const { bundle, site } = await findSite(doc, mapId, match.report.sites[0]!.siteId);
    return { doc, bundle, site, ...materialize(doc, bundle, site, { drawIndex: 0 }) };
  }
  throw new Error(`no complete map bound ${name}\n${failures.join('\n')}`);
}

type Materialization = Awaited<ReturnType<typeof computeFirstMaterialization>>;
const materializationByName = new Map<string, Promise<Materialization>>();

function firstMaterialization(name: string): Promise<Materialization> {
  const cached = materializationByName.get(name);
  if (cached) return cached;
  const pending = computeFirstMaterialization(name);
  materializationByName.set(name, pending);
  return pending;
}

describe('school/work-zone mechanism templates', () => {
  it('contains exactly the requested tranche and does not recreate child dart-out', async () => {
    expect((await readdir(DIRECTORY)).sort()).toEqual(CASES.map(([name]) => name).sort());
  });

  it.each(CASES)('%s parses, validates, adapts, resolves, and uses executable interactions', async (name, archetype) => {
    const doc = await template(name);
    expect(doc.meta.archetype).toBe(archetype);
    expect(doc.metricSubject).toBe('ego');
    expect(validateTemplate(doc).issues.filter((issue) => issue.severity === 'error')).toEqual([]);

    const adapted = adaptTemplate(doc);
    expect(adapted.roles.map((role) => role.role).sort()).toEqual(
      doc.roles.map((role) => role.id).sort(),
    );
    expect(adapted.notes.filter((note) => /not portable|not matchable/.test(note.reason))).toEqual([]);

    for (const drawIndex of [-1, 0, 1]) {
      const draw = resolveParams(doc, { siteId: 'school-workzone-mechanism-test-site', drawIndex });
      expect(draw.rejectedConstraints).toEqual([]);
      expect(Object.keys(draw.values)).toHaveLength(doc.params.declarations.length);
    }
    expect(doc.choreography.interactions.every(interactionIsExecutable)).toBe(true);
  });

  it('keeps the crossing guard and child group separate and makes release precede entry', async () => {
    const doc = await template('crossing-guard-release.template.json');
    expect(doc.roles.map((role) => role.id)).toEqual(['ego', 'crossing-guard', 'child-group']);
    expect(doc.roles.find((role) => role.id === 'crossing-guard')).toMatchObject({
      actor: { class: 'pedestrian', static: true },
    });
    expect(doc.roles.find((role) => role.id === 'child-group')).toMatchObject({
      kind: 'on_crossing', actor: { class: 'pedestrian' }, feature: 'school-crossing',
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'children-enter')?.trigger).toMatchObject({
      kind: 'after', of: 'guard-releases', event: 'start',
    });
    expect(doc.choreography.interactions.at(-1)).toMatchObject({
      id: 'guard-secures-crossing', target: { key: 'pose.gesture', value: 'halt' },
    });
  });

  it('uses static actor roles, not non-colliding props, for the lane closure', async () => {
    const doc = await template('lane-shift.template.json');
    expect(doc.roles.find((role) => role.id === 'channelizer')).toMatchObject({
      actor: { class: 'static_object', static: true, catalogId: 'construction.channelizer_drum' },
    });
    expect(doc.roles.find((role) => role.id === 'work-vehicle')).toMatchObject({
      actor: { class: 'truck', static: true, catalogId: 'vehicle.pickup' },
    });
    expect(doc.props.map((prop) => prop.id)).toEqual(['cone-taper']);
    expect(doc.roles.find((role) => role.id === 'queue-tail')).toMatchObject({
      actor: { class: 'car', static: true }, pose: { tFrac: 0.82 },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'ego-brakes-for-queue')).toMatchObject({
      verb: 'speed', target: { mode: 'stop' },
    });
  });

  it('preserves the worker intrusion, static work vehicle occlusion, and stopped aftermath', async () => {
    const doc = await template('worker-intrusion.template.json');
    expect(doc.roles.find((role) => role.id === 'work-vehicle')).toMatchObject({
      actor: { class: 'van', static: true },
      extensions: { occludes: { observer: 'ego', target: 'worker' } },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'worker-crosses')).toMatchObject({
      actor: 'worker', verb: 'route', target: { mode: 'polyline' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'worker-clears-and-stops')).toMatchObject({
      actor: 'worker', verb: 'speed', target: { mode: 'stop' },
    });
    expect(doc.choreography.interactions.some((item) => item.verb === 'exist')).toBe(false);
  });

  it('uses registered set values whose engine key mappings are intentional', async () => {
    for (const [name] of CASES) {
      const doc = await template(name);
      for (const interaction of doc.choreography.interactions) {
        if (interaction.verb !== 'set') continue;
        expect(lookupSetKey(interaction.target.key), `${name}: ${interaction.target.key}`).toBeDefined();
        expect(checkSetValue(interaction.target.key, interaction.target.value)).toEqual({ ok: true });
        expect(mapSetKey(interaction.target.key), `${name}: ${interaction.target.key}`).not.toBeNull();
      }
    }
    expect(mapSetKey('rules.yieldToVehicles')).toBe('rules.yieldToVehicles');
    expect(mapSetKey('pose.gesture')).toBe('pose.gesture');
    expect(mapSetKey('pose.headingLookDeg')).toBe('pose.headingLookDeg');
    expect(mapSetKey('lights.indicator')).toBe('lights.indicator');
  });
});

describe.skipIf(mapsWithCompleteArtifacts.length === 0)('school/work-zone materialization', () => {
  it.each(CASES)('%s binds and materializes all roles with no dropped authored interaction', async (name) => {
    const { doc, input, manifest } = await firstMaterialization(name);
    expect(input.actors.map((actor) => actor.id).sort()).toEqual(doc.roles.map((role) => role.id).sort());
    expect(manifest.feasible).toBe(true);
    expect(manifest.notes.filter((note) => /interaction dropped/.test(note.reason))).toEqual([]);
  }, 180_000);

  it('materializes the lane-shift hazards as collision participants', async () => {
    const { input } = await firstMaterialization('lane-shift.template.json');
    expect(input.actors.find((actor) => actor.id === 'channelizer')).toMatchObject({
      kind: 'static_object', static: true,
    });
    expect(input.actors.find((actor) => actor.id === 'work-vehicle')).toMatchObject({
      kind: 'truck', static: true,
    });
    expect(input.occluders).toHaveLength(8);
  }, 180_000);

  it('executes the exact work-zone location with a measured queue conflict and stable stopped aftermath', async () => {
    const doc = await template('lane-shift.template.json');
    const match = await matchOnMap(doc, 'el-camino-road', { maxSites: 100 });
    const location = match.bundle.catalog.locations.find((entry) => entry.id === 'loc_a5a07469383b8e126175239b');
    const site = match.report.sites.find((candidate) =>
      location !== undefined && matcherSiteClosesLocation(candidate, location, match.bundle.index));
    expect(location).toBeDefined();
    expect(site).toMatchObject({
      siteId: '21352a7f76445d6e',
      frame: { origin: { mapFeatureId: 'seg_94172a1d683ed19d' } },
      featureMatches: {
        'work-zone-reservation': { mapFeatureId: 'loc_a5a07469383b8e126175239b' },
      },
    });
    expect(site?.featureMatches['work-zone-reservation']?.s).toBeCloseTo(157.5, 9);
    expect(site).toBeDefined();
    const concrete = materialize(doc, match.bundle, site!, {
      drawIndex: 0,
      seed: 'workzone-lane-shift-exact-runtime',
    });
    expect(concrete.manifest.feasible).toBe(true);
    expect(concrete.manifest.issues).toEqual([]);
    expect(concrete.input.actors.find((actor) => actor.id === 'ego')?.behavior.rules.collisionAvoidance).toBe(true);
    expect(concrete.input.actors.find((actor) => actor.id === 'channelizer')).toMatchObject({
      kind: 'static_object', static: true,
    });
    expect(concrete.input.actors.find((actor) => actor.id === 'work-vehicle')).toMatchObject({
      kind: 'truck', static: true,
    });
    expect(concrete.input.actors.find((actor) => actor.id === 'queue-tail')).toMatchObject({
      kind: 'car', static: true,
    });
    expect(concrete.input.occluders).toHaveLength(8);

    const simulation = runSimulation(concrete.input, { graph: match.bundle.graph, guards: 'collect' });
    expect(simulation.issues).toEqual([]);
    expect(simulation.trace.metrics.collisions).toEqual([]);
    expect(simulation.trace.metrics.triggerNeverFired).toEqual([]);
    expect(simulation.trace.metrics.clippedCriticality).toBe(false);
    expect(evaluateTrace(simulation.trace, filtersFor('critical', { rejectCollisions: true }))).toMatchObject({
      verdict: 'accept', findings: [],
    });

    const residuals = checkInvariants({
      template: doc,
      trace: simulation.trace,
      scope: {
        params: concrete.manifest.params.values,
        clip: { seconds: doc.choreography.clipSeconds },
        lane: { speedLimitKph: match.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? 64 },
      },
      arrival: concrete.manifest.arrival,
      speedLimitKph: match.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null,
    });
    expect(residuals.filter((residual) => residual.essentiality === 'required').map((residual) => residual.status)).toEqual([
      'held', 'held', 'held', 'held',
    ]);
    const brake = simulation.trace.events.find((event) =>
      event.kind === 'trigger_fired' && event.interactionId === 'ego-brakes-for-queue');
    expect(brake).toMatchObject({ forced: false });
    const egoSpeed = simulation.trace.ticks.actors.ego!.speedMps;
    const aftermathSpeeds = simulation.trace.ticks.t
      .flatMap((t, index) => t >= 16 ? [egoSpeed[index]!] : []);
    expect(aftermathSpeeds.length).toBeGreaterThan(100);
    expect(Math.max(...aftermathSpeeds)).toBeLessThan(0.01);
  }, 180_000);

  it('materializes the work vehicle as both static collision actor and worker occluder', async () => {
    const { input } = await firstMaterialization('worker-intrusion.template.json');
    expect(input.actors.find((actor) => actor.id === 'work-vehicle')).toMatchObject({
      kind: 'van', static: true,
    });
    expect(input.occlusionPairs).toContainEqual({
      observer: 'ego', target: 'worker', occluderId: 'actor:work-vehicle',
    });
    expect(input.interactions.find((item) => item.id === 'worker-crosses')).toMatchObject({
      verb: 'route', target: { kind: 'polyline' },
    });
  }, 180_000);

  it('hard-excludes the preserved Yale false school/work-zone candidates', async () => {
    const school = await matchOnMap(await template('crossing-guard-release.template.json'), 'yale-street', { maxSites: 100 });
    expect(school.report.sites.some((site) => site.siteId === '2cddd4ee49f2d79f')).toBe(false);
    const signedSchool = await matchOnMap(await template('crossing-guard-release.template.json'), 'easterbrook-discovery-school', { maxSites: 100 });
    expect(signedSchool.report.sites).not.toHaveLength(0);
    expect(signedSchool.report.sites[0]?.featureMatches['school-zone']).toBeDefined();

    const worker = await matchOnMap(await template('worker-intrusion.template.json'), 'yale-street', { maxSites: 100 });
    expect(worker.report.sites.some((site) => site.siteId === '92020b3cc7c4178c')).toBe(false);

    const realWorkZone = await matchOnMap(await template('worker-intrusion.template.json'), 'el-camino-road', { maxSites: 100 });
    expect(realWorkZone.report.sites).not.toHaveLength(0);
    expect(realWorkZone.report.sites[0]?.featureMatches['work-zone-reservation']).toBeDefined();
  }, 180_000);

  it('replays the taxonomy school dart-out on a signed school zone with persistent ball and stable aftermath', async () => {
    const doc = await schoolDartout();
    expect(doc.meta.archetype).toBe('C12.ball-then-child');
    expect(doc.choreography.interactions.some((item) => item.id === 'ball-vanishes')).toBe(false);
    const match = await matchOnMap(doc, 'easterbrook-discovery-school', { maxSites: 100 });
    const site = match.report.sites[0];
    expect(site?.featureMatches.sz).toBeDefined();
    const concrete = materialize(doc, match.bundle, site!, {
      drawIndex: 0,
      seed: 'school-child-dartout-taxonomy-runtime',
    });
    expect(concrete.manifest).toMatchObject({ feasible: true, issues: [] });
    const simulation = runSimulation(concrete.input, { graph: match.bundle.graph, guards: 'collect' });
    expect(simulation.issues).toEqual([]);
    expect(simulation.trace.metrics.collisions).toEqual([]);
    expect(simulation.trace.events.find((event) => event.kind === 'trigger_fired' && event.interactionId === 'ego-brakes-after-cue'))
      .toMatchObject({ forced: false });
    expect(simulation.trace.ticks.actors.ball!.present.at(-1)).toBe(1);
    const child = simulation.trace.ticks.actors.child!;
    const ego = simulation.trace.ticks.actors.ego!;
    expect(Math.max(...child.speedMps.slice(-100))).toBeLessThan(0.01);
    expect(Math.max(...ego.speedMps.slice(-100))).toBeLessThan(0.01);
    const residuals = checkInvariants({
      template: doc,
      trace: simulation.trace,
      scope: {
        params: concrete.manifest.params.values,
        clip: { seconds: doc.choreography.clipSeconds },
        lane: { speedLimitKph: match.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? 64 },
      },
      arrival: concrete.manifest.arrival,
      speedLimitKph: match.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null,
    });
    expect(residuals.filter((residual) => residual.essentiality === 'required').map((residual) => residual.status))
      .toEqual(['held', 'held', 'held']);
  }, 180_000);

  it('replays a feature-bound work-zone intrusion with a real reveal and safe criticality', async () => {
    const doc = await template('worker-intrusion.template.json');
    const match = await matchOnMap(doc, 'el-camino-road', { maxSites: 100 });
    const site = match.report.sites[0];
    expect(site?.featureMatches['work-zone-reservation']).toBeDefined();
    const concrete = materialize(doc, match.bundle, site!, {
      drawIndex: 0,
      seed: 'workzone-worker-intrusion-feature-bound-runtime',
    });
    expect(concrete.manifest).toMatchObject({ feasible: true, issues: [] });
    const simulation = runSimulation(concrete.input, { graph: match.bundle.graph, guards: 'collect' });
    expect(simulation.issues).toEqual([]);
    expect(simulation.trace.metrics.collisions).toEqual([]);
    expect(simulation.trace.metrics.occluderIneffective).toEqual([]);
    expect(simulation.trace.metrics.revealToConflict?.value).not.toBeNull();
    const residuals = checkInvariants({
      template: doc,
      trace: simulation.trace,
      scope: {
        params: concrete.manifest.params.values,
        clip: { seconds: doc.choreography.clipSeconds },
        lane: { speedLimitKph: match.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? 64 },
      },
      arrival: concrete.manifest.arrival,
      speedLimitKph: match.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null,
    });
    expect(residuals.filter((residual) => residual.essentiality === 'required').map((residual) => residual.status))
      .toEqual(['held', 'held', 'held']);
  }, 180_000);

  it('keeps a signed-school staffed-crossing release collision-free while the ego yields to the guard', async () => {
    const doc = await template('crossing-guard-release.template.json');
    const match = await matchOnMap(doc, 'easterbrook-discovery-school', { maxSites: 100 });
    const site = match.report.sites[0];
    expect(site).toBeDefined();
    expect(site?.featureMatches['school-zone']).toBeDefined();
    expect(site?.featureMatches['school-crossing']).toBeDefined();
    expect(site!.siteId).toBe('5bd9f3d603b149df');
    const concrete = materialize(doc, match.bundle, site!, {
      drawIndex: 0,
      seed: 'school-crossing-guard-release-signed-school-runtime',
    });
    expect(concrete.manifest).toMatchObject({ feasible: true, issues: [] });
    expect(concrete.input.actors.find((actor) => actor.id === 'crossing-guard')).toMatchObject({ kind: 'pedestrian', static: true });
    expect(concrete.input.actors.find((actor) => actor.id === 'child-group')).toMatchObject({ kind: 'pedestrian' });
    expect(concrete.input.interactions.find((item) => item.id === 'ego-yields-to-guard')).toMatchObject({
      actorId: 'ego', verb: 'speed', target: { mode: 'stop' },
    });

    const simulation = runSimulation(concrete.input, { graph: match.bundle.graph, guards: 'collect' });
    expect(simulation.issues).toEqual([]);
    expect(simulation.trace.metrics.collisions).toEqual([]);
    expect(simulation.trace.metrics.clippedCriticality).toBe(false);
    expect(simulation.trace.metrics.requiredDecelMax.ego).toBeLessThanOrEqual(8);
    expect(evaluateTrace(simulation.trace, filtersFor('critical', { rejectCollisions: true }))).toMatchObject({
      verdict: 'accept', findings: [],
    });
    expect(simulation.trace.events.find((event) =>
      event.kind === 'trigger_fired' && event.interactionId === 'ego-yields-to-guard'))
      .toMatchObject({ forced: false });
    const residuals = checkInvariants({
      template: doc,
      trace: simulation.trace,
      scope: {
        params: concrete.manifest.params.values,
        clip: { seconds: doc.choreography.clipSeconds },
        lane: { speedLimitKph: match.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? 64 },
      },
      arrival: concrete.manifest.arrival,
      speedLimitKph: match.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null,
    });
    expect(residuals.filter((residual) => residual.essentiality === 'required').map((residual) => residual.status))
      .toEqual(['held', 'held', 'held']);
    const aftermath = simulation.trace.ticks.actors.ego!.speedMps.slice(-100);
    expect(Math.max(...aftermath)).toBeLessThan(0.01);
  }, 180_000);
});
