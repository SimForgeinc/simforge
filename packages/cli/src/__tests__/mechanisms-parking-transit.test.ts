/**
 * Executability and semantic contracts for the parking/transit mechanism tranche.
 *
 * The document checks are asset-independent. When development maps are present,
 * every template must also bind and materialize on at least one of the five maps.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  validateTemplate,
  type Interaction,
  type ScenarioTemplateV2,
} from '@uniscenarios/scenario-model';
import { runSimulation } from '@uniscenarios/sim-engine';

import { adaptTemplate } from '../adapt.js';
import { checkInvariants } from '../invariants.js';
import { KNOWN_MAPS, REPO_ROOT, artifactPresence } from '@uniscenarios/scenario-materializer';
import { materialize } from '../materialize.js';
import { resolveParams } from '../params.js';
import { matchOnMap } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const DIRECTORY = path.join(REPO_ROOT, 'examples', 'mechanisms', 'parking-transit');
const CASES = [
  ['vehicle-pulls-out.template.json', 'parking.vehicle-pulls-out'],
  ['backing-out-vehicle.template.json', 'parking.backing-out-vehicle'],
  ['delivery-double-park.template.json', 'parking.delivery-double-park'],
  ['driveway-emergence.template.json', 'parking.driveway-emergence'],
  ['bus-pullout.template.json', 'transit.bus-pullout'],
] as const;

const mapsWithArtifacts = KNOWN_MAPS.filter((mapId) => {
  const present = artifactPresence(mapId);
  return present.topologyIndex && present.derivedTopology && present.locations;
});
const haveArtifacts = mapsWithArtifacts.length > 0;

const SEARCH_ORDER: Record<(typeof CASES)[number][0], readonly string[]> = {
  'vehicle-pulls-out.template.json': [
    'easterbrook-discovery-school', 'richmond-field-station', 'belmont-research-center', 'yale-street', 'el-camino-road',
  ],
  'backing-out-vehicle.template.json': [
    'easterbrook-discovery-school', 'richmond-field-station', 'belmont-research-center', 'yale-street', 'el-camino-road',
  ],
  'delivery-double-park.template.json': [
    'yale-street', 'belmont-research-center', 'el-camino-road', 'richmond-field-station', 'easterbrook-discovery-school',
  ],
  'driveway-emergence.template.json': [
    'easterbrook-discovery-school', 'richmond-field-station', 'belmont-research-center', 'yale-street', 'el-camino-road',
  ],
  'bus-pullout.template.json': [
    'yale-street', 'richmond-field-station', 'belmont-research-center', 'el-camino-road', 'easterbrook-discovery-school',
  ],
};

function file(name: string): string {
  return path.join(DIRECTORY, name);
}

async function template(name: string): Promise<ScenarioTemplateV2> {
  return readTemplate(file(name));
}

async function findMaterialization(name: (typeof CASES)[number][0]) {
  const doc = await template(name);
  const failures: string[] = [];
  for (const mapId of SEARCH_ORDER[name]) {
    if (!mapsWithArtifacts.includes(mapId as (typeof KNOWN_MAPS)[number])) continue;
    const match = await matchOnMap(doc, mapId);
    if (match.report.sites.length === 0) {
      failures.push(`${mapId}: ${match.report.failureSummary}`);
      continue;
    }
    const selected = match.report.sites[0]!;
    const bundle = match.bundle;
    const site = selected;
    return { doc, mapId, selected, bundle, site, ...materialize(doc, bundle, site, { drawIndex: 0 }) };
  }
  throw new Error(`No materializable site for ${name}. ${failures.join(' | ')}`);
}

const materializationCache = new Map<string, ReturnType<typeof findMaterialization>>();

function cachedMaterialization(name: (typeof CASES)[number][0]) {
  const cached = materializationCache.get(name);
  if (cached) return cached;
  const pending = findMaterialization(name);
  materializationCache.set(name, pending);
  return pending;
}

function interactionIsExecutable(interaction: Interaction): boolean {
  if (interaction.trigger.kind === 'after' && interaction.trigger.event === 'end') return false;
  if (interaction.until && interaction.until.kind !== 'when') return false;
  if (interaction.verb === 'speed' && interaction.target.mode === 'resume') return false;
  if (interaction.verb === 'route' && interaction.target.mode !== 'polyline') return false;
  if (interaction.verb === 'changeLane' && interaction.target.mode === 'relative' && interaction.target.dk === 0) return false;
  return true;
}

function continuousInteractionHasDynamics(interaction: Interaction): boolean {
  switch (interaction.verb) {
    case 'speed':
    case 'gap':
    case 'changeLane':
    case 'laneOffset':
      return interaction.dynamics !== undefined;
    default:
      return true;
  }
}

describe('parking/transit mechanism templates', () => {
  it.each(CASES)('%s parses, validates, adapts, and resolves deterministic draws', async (name, archetype) => {
    const doc = await template(name);
    expect(doc.meta.archetype).toBe(archetype);
    expect(doc.metricSubject).toBe('ego');
    expect(validateTemplate(doc).issues.filter((issue) => issue.severity === 'error')).toEqual([]);

    const adapted = adaptTemplate(doc);
    expect(adapted.roles.map((role) => role.role).sort()).toEqual(doc.roles.map((role) => role.id).sort());
    expect(adapted.notes.filter((note) => /not portable|not matchable/.test(note.reason))).toEqual([]);

    for (const drawIndex of [-1, 0, 1]) {
      const draw = resolveParams(doc, { siteId: 'parking-transit-test-site', drawIndex });
      expect(draw.rejectedConstraints).toEqual([]);
      expect(Object.keys(draw.values)).toHaveLength(doc.params.declarations.length);
    }

    expect(doc.choreography.interactions.every(interactionIsExecutable)).toBe(true);
    expect(doc.choreography.interactions.every(continuousInteractionHasDynamics)).toBe(true);
  });

  it('contains exactly the five newly covered archetypes and does not duplicate bus-stop emergence', async () => {
    const docs = await Promise.all(CASES.map(([name]) => template(name)));
    expect(docs.map((doc) => doc.meta.archetype).sort()).toEqual(CASES.map(([, archetype]) => archetype).sort());
    expect(docs.some((doc) => doc.meta.archetype === 'transit.bus-stop-emergence')).toBe(false);
  });

  it('keeps the backing manoeuvre explicitly reverse-coded', async () => {
    const doc = await template('backing-out-vehicle.template.json');
    expect(doc.roles.find((role) => role.id === 'backing-vehicle')).toMatchObject({
      kind: 'in_parking_zone',
      facing: 'perpendicular',
      actor: { class: 'car', catalogId: 'vehicle.suv', static: false },
      extensions: { motionSemantics: 'reverse' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'reverse-lamps-on')).toMatchObject({
      verb: 'set', target: { key: 'lights.reverse', value: true },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'backing-path')).toMatchObject({
      verb: 'route', target: { mode: 'polyline' },
    });
  });

  it('keeps the delivery van static, the worker pedestrian, and their occlusion directional', async () => {
    const doc = await template('delivery-double-park.template.json');
    expect(doc.roles.find((role) => role.id === 'delivery-vehicle')).toMatchObject({
      actor: { class: 'van', catalogId: 'vehicle.van', static: true },
      extensions: { occludes: { observer: 'ego', target: 'delivery-worker' } },
    });
    expect(doc.roles.find((role) => role.id === 'delivery-worker')?.actor).toMatchObject({
      class: 'pedestrian', catalogId: 'pedestrian.adult_walking', static: false,
    });
  });

  it('uses a mapped parking-area access and a static sight obstruction for driveway emergence', async () => {
    const doc = await template('driveway-emergence.template.json');
    expect(doc.anchor.features).toContainEqual(expect.objectContaining({
      id: 'access', kind: 'parking_zone', essentiality: 'required',
    }));
    expect(doc.props).toContainEqual(expect.objectContaining({
      id: 'driveway-hedge',
      catalogId: 'occluder.hedge_run',
      essentiality: 'required',
      occludes: { observer: 'ego', target: 'emerging-vehicle' },
      extensions: expect.objectContaining({ staticObstruction: true }),
    }));
  });

  it('preserves a dwelling semantic bus, physical pullout, and post-departure route-conflict evidence', async () => {
    const doc = await template('bus-pullout.template.json');
    expect(doc.anchor.features).toContainEqual(expect.objectContaining({ id: 'stop', kind: 'bus_stop' }));
    expect(doc.roles.find((role) => role.id === 'bus')).toMatchObject({
      actor: { class: 'bus', catalogId: 'vehicle.bus', static: false },
      initialSpeedKph: 0,
      extensions: { placementFeature: 'stop', serviceState: 'dwelling' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'bus-signals')).toMatchObject({
      actor: 'bus',
      verb: 'set',
      trigger: { kind: 'when', condition: { kind: 'standstill', of: 'bus' }, ifNever: 'skip' },
      target: { key: 'lights.indicator', value: 'left' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'bus-accelerates')).toMatchObject({
      actor: 'bus',
      verb: 'speed',
      trigger: { kind: 'when', condition: { kind: 'distance', from: 'ego', to: { role: 'bus' } }, ifNever: 'skip' },
    });
    expect(doc.choreography.interactions.find((item) => item.id === 'bus-enters-lane')).toMatchObject({
      actor: 'bus',
      verb: 'laneOffset',
      trigger: { kind: 'after', of: 'bus-accelerates', delayS: 0.2 },
      target: { tFrac: 0, reference: 'lane_center' },
    });
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      id: 'bus-pullout-criticality', kind: 'pet', of: 'ego', to: 'bus', range: [0.5, 3.5], window: [3, 8],
    }));
    expect(doc.invariants.some((invariant) => invariant.kind === 'ttc')).toBe(false);
    expect(doc.invariants.some((invariant) => invariant.kind === 'path_ttc')).toBe(false);
    expect(doc.invariants.some((invariant) => invariant.kind === 'gap')).toBe(false);
    expect(doc.invariants).toContainEqual(expect.objectContaining({
      kind: 'event_order', events: ['bus-signals', 'bus-accelerates', 'bus-enters-lane'], strict: true,
    }));
    expect(doc.invariants.find((invariant) => invariant.id === 'bus-departure-order'))
      .not.toHaveProperty('minSeparationS');
  });
});

describe.skipIf(!haveArtifacts)('parking/transit templates across the five-map bundle', () => {
  it('keeps the selected Yale backing-out slot collision-free after reverse lamps reveal the manoeuvre', async () => {
    const doc = await template('backing-out-vehicle.template.json');
    const matched = await matchOnMap(doc, 'yale-street');
    const site = matched.report.sites.find((candidate) => candidate.siteId === '221c1cc1f26e3971');
    expect(site).toBeDefined();
    const { input, manifest } = materialize(doc, matched.bundle, site!, { drawIndex: 0 });
    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    const speedLimitKph = matched.bundle.index.lanes[site!.frame.entryLaneRsl]?.speedLimitKph ?? null;
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.events.filter((event) => event.kind === 'trigger_fired').map((event) => event.interactionId))
      .toEqual(expect.arrayContaining(['reverse-lamps-on', 'backing-begins', 'ego-brakes-for-reversing-vehicle']));
    expect(checkInvariants({
      template: doc,
      trace,
      scope: { params: manifest.params.values, clip: { seconds: doc.choreography.clipSeconds }, ...(speedLimitKph === null ? {} : { lane: { speedLimitKph } }) },
      arrival: manifest.arrival,
      speedLimitKph,
    }).filter((residual) => residual.essentiality === 'required' && residual.status !== 'held')).toEqual([]);
  }, 60_000);

  it.each(CASES)('%s finds a map and materializes every required semantic role', async (name) => {
    const { doc, input, manifest } = await cachedMaterialization(name);

    expect(input.actors.map((actor) => actor.id).sort()).toEqual(doc.roles.map((role) => role.id).sort());
    expect(manifest.metricSubject).toBe('ego');
    expect(manifest.params.rejectedConstraints).toEqual([]);
    expect(manifest.notes.filter((note) => /not expressible|interaction dropped|role unbound/.test(note.reason))).toEqual([]);
  }, 180_000);

  it('materializes the semantic bus, reverse-coded vehicle, delivery worker, and static obstructions', async () => {
    const materialized = new Map<string, Awaited<ReturnType<typeof findMaterialization>>>();
    for (const [name, archetype] of CASES) {
      materialized.set(archetype, await cachedMaterialization(name));
    }

    const backing = materialized.get('parking.backing-out-vehicle')!;
    expect(backing.input.actors.find((actor) => actor.id === 'backing-vehicle')?.behavior.route.kind).toBe('polyline');
    expect(backing.input.actors.find((actor) => actor.id === 'backing-vehicle')?.tags).toContain('motion:reverse');
    expect(backing.input.interactions.find((item) => item.id === 'reverse-lamps-on')).toMatchObject({
      verb: 'set', target: { key: 'lights.reverse', value: true },
    });

    const delivery = materialized.get('parking.delivery-double-park')!;
    expect(delivery.input.actors.find((actor) => actor.id === 'delivery-vehicle')).toMatchObject({
      kind: 'van', static: true,
    });
    expect(delivery.input.actors.find((actor) => actor.id === 'delivery-worker')).toMatchObject({
      kind: 'pedestrian', static: false,
    });
    expect(delivery.input.occlusionPairs).toEqual([
      { observer: 'ego', target: 'delivery-worker', occluderId: 'actor:delivery-vehicle' },
    ]);

    const driveway = materialized.get('parking.driveway-emergence')!;
    expect(driveway.input.occluders).toContainEqual(expect.objectContaining({
      id: 'driveway-hedge',
      obb: expect.objectContaining({ lengthM: 6, widthM: 0.8, heightM: 1.2 }),
    }));
    expect(driveway.input.occlusionPairs).toEqual([
      { observer: 'ego', target: 'emerging-vehicle', occluderId: 'driveway-hedge' },
    ]);

    const bus = materialized.get('transit.bus-pullout')!;
    expect(bus.input.actors.find((actor) => actor.id === 'bus')).toMatchObject({ kind: 'bus', static: false });
    expect(bus.input.actors.find((actor) => actor.id === 'bus')?.tags).toContain('catalog:vehicle.bus');
  }, 180_000);

  it('holds the mapped Belmont bus at its stop, then executes a persistent pull-out', async () => {
    const doc = await template('bus-pullout.template.json');
    const matched = await matchOnMap(doc, 'belmont-research-center');
    const site = matched.report.sites.find((candidate) => candidate.siteId === '5532969124e19a99');
    expect(site, 'truthful kerb-proximate Belmont bus-stop site').toBeDefined();

    const { input, manifest } = materialize(doc, matched.bundle, site!, { drawIndex: 0 });
    const bus = input.actors.find((actor) => actor.id === 'bus')!;
    expect(manifest.feasible).toBe(true);
    expect(manifest.issues).toEqual([]);
    expect(bus).toMatchObject({
      kind: 'bus',
      static: false,
      initial: { speedMps: 0, laneRef: { tFrac: -1 } },
      behavior: { cruiseSpeedMps: 0 },
    });

    const { trace } = runSimulation(input, { graph: matched.bundle.graph, guards: 'collect' });
    const busTrack = trace.ticks.actors.bus!;
    const departure = trace.events.find(
      (event) => event.kind === 'trigger_fired' && event.interactionId === 'bus-accelerates',
    );
    const merge = trace.events.find(
      (event) => event.kind === 'trigger_fired' && event.interactionId === 'bus-enters-lane',
    );
    expect(busTrack.speedMps.slice(0, 20)).toEqual(Array(20).fill(0));
    expect(departure).toMatchObject({ t: expect.any(Number), actorId: 'bus', verb: 'speed' });
    expect(merge).toMatchObject({ actorId: 'bus', verb: 'laneOffset' });
    expect((merge as { t: number }).t - (departure as { t: number }).t).toBeCloseTo(0.2, 6);
    expect(Math.max(...busTrack.speedMps)).toBeGreaterThan(4);
    expect(busTrack.speedMps.at(-1)).toBeGreaterThan(4);
    expect(Math.hypot(
      busTrack.x.at(-1)! - busTrack.x[0]!,
      busTrack.y.at(-1)! - busTrack.y[0]!,
    )).toBeGreaterThan(45);
    expect(trace.metrics.minTTC).toMatchObject({ pair: expect.arrayContaining(['ego', 'bus']) });
    expect(trace.metrics.minTTC!.t).toBeLessThan(4);
    expect(trace.metrics.minPET).toMatchObject({
      pair: expect.arrayContaining(['ego', 'bus']),
      value: expect.any(Number),
      t: expect.any(Number),
    });
    expect(trace.metrics.minPET!.t).toBeGreaterThanOrEqual(4);
    expect(trace.metrics.minPET!.t).toBeGreaterThan((merge as { t: number }).t);
    expect(trace.metrics.minPET!.value).toBeGreaterThanOrEqual(0);
    expect(trace.metrics.minPET!.value).toBeLessThanOrEqual(3.5);
    expect(trace.metrics.collisions).toEqual([]);
  }, 30_000);
});
