import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import type { MatchedSite } from '@simforge/compiler';
import { ScenarioTemplateV2Schema } from '@simforge/scenario';
import { buildRoute, createAmbientCandidatePool, runSimulation } from '@simforge/engine';

import {
  buildSiteSignalPlan,
  buildSiteRoadControls,
  buildMapControlPlan,
  defaultPhasesForHead,
  parseMapSignalCatalog,
  resolveSiteSignalProgram,
} from '../map-signals.js';
import { createMapContext } from '@simforge/compiler';
import { DEV_ASSETS, KNOWN_MAPS, REPO_ROOT, loadMap } from '@simforge/compiler';
import { matchOnMap } from '@simforge/compiler';
import { readTemplate } from '@simforge/compiler';
import {
  assertMaterializableMapControls,
  mapSetKey,
  materialize,
} from '../materialize.js';

const YALE = 'yale-street';
const BELMONT = 'belmont-research-center';
const LTAP = path.join(REPO_ROOT, 'examples', 'ltap-opposing.template.json');
const RED_LIGHT = path.join(REPO_ROOT, 'examples', 'mechanisms', 'remaining', 'red-light-late-entry.template.json');
const PROTECTED_LEFT_GALLERY = path.join(
  REPO_ROOT,
  'examples',
  'edge-cases',
  '07-protected-left-red-runner',
  'scenario.template.json',
);
const haveMaps = [YALE, BELMONT].every((map) => existsSync(path.join(DEV_ASSETS, map, 'map.xodr')));
const haveAllMaps = KNOWN_MAPS.every((map) => existsSync(path.join(DEV_ASSETS, map, 'map.xodr')));

describe('map signal controller parsing', () => {
  it('preserves head, controller sequence, and junction bindings', () => {
    const catalog = parseMapSignalCatalog(
      `
        <road id="200"><signals>
          <signalReference id="h1" s="5" orientation="+"><validity fromLane="-1" toLane="-1"/></signalReference>
        </signals></road>
        <controller id="c1" sequence="0"><control signalId="h1"/></controller>
        <controller id="c2" sequence="1"><control signalId="h2"/></controller>
        <junction id="j1"><controller id="c1"/><controller id="c2"/></junction>
      `,
      {
        features: [
          { properties: { id: 'h1', road_id: '10', s: 2, signal_category: 'traffic_light', dynamic: 'yes' } },
          { properties: { id: 'static', road_id: '10', signal_category: 'traffic_light', dynamic: 'no' } },
        ],
      },
    );
    expect(catalog.heads.map((head) => head.id)).toEqual(['h1']);
    expect(catalog.applicability).toContainEqual({
      headId: 'h1',
      roadId: '200',
      fromLane: -1,
      toLane: -1,
      source: 'signal-reference',
    });
    expect(catalog.controllers.map((controller) => [controller.id, controller.sequence])).toEqual([
      ['c1', 0],
      ['c2', 1],
    ]);
    expect(catalog.junctions).toEqual([{ junctionId: 'j1', controllerIds: ['c1', 'c2'] }]);
    expect(defaultPhasesForHead('h1', catalog.controllers)).toEqual([
      { phase: 'green', durationS: 12 },
      { phase: 'yellow', durationS: 3 },
      { phase: 'red', durationS: 15 },
    ]);
  });

  it('binds a repeated physical head by signalReference lane, not its declaration road', () => {
    const catalog = parseMapSignalCatalog(
      `
        <road id="200"><signals>
          <signalReference id="h1" s="5"><validity fromLane="-1" toLane="-1"/></signalReference>
        </signals></road>
        <controller id="c1" sequence="0"><control signalId="h1"/></controller>
        <controller id="c2" sequence="1"><control signalId="h2"/></controller>
        <junction id="j1"><controller id="c1"/><controller id="c2"/></junction>
      `,
      {
        features: [
          // The furniture is declared on a different road. Only the explicit
          // signalReference controls connecting road 200 / lane -1.
          { properties: { id: 'h1', road_id: '999', s: 2, signal_category: 'traffic_light', dynamic: 'yes' } },
          { properties: { id: 'stop1', road_id: '200', s: 4, signal_category: 'stop_sign', dynamic: 'no' } },
        ],
      },
    );
    const bundle = {
      mapId: 'fixture',
      signalCatalog: catalog,
      topology: {
        lanes: {
          '10:0:-1': { roadId: 10, laneId: -1 },
          '200:0:-1': { roadId: 200, laneId: -1 },
        },
        gates: [{
          id: 'g1',
          junctionId: 'j1',
          approachLaneRsl: '10:0:-1',
          connectingLaneRsl: '200:0:-1',
        }],
      },
      graph: {
        geometry: (rsl: string) => rsl === '10:0:-1' ? { lengthM: 50 } : null,
        nominalReversed: () => false,
      },
      index: {
        mapId: 'fixture',
        topologyDigest: 'digest',
        lanes: {},
        gates: [{ id: 'g1', connectingLaneRsl: '200:0:-1' }],
        junctionDescriptors: {
          j1: { approaches: [{ gateIds: ['g1'] }], conflictPairs: [] },
        },
      },
    } as any;
    const site = {
      frame: {
        origin: { mapFeatureId: 'junction:j1' },
        egoGateId: 'g1',
        referencePath: [],
        lateralLanes: {},
        sRange: [0, 0],
      },
      featureMatches: { jx: { mapFeatureId: 'junction:j1' } },
      bindings: [],
    } as any;
    const plan = buildSiteSignalPlan(bundle, site);
    expect(plan.programs[0]?.stopLines).toEqual([
      { rsl: '10:0:-1', s: 49, connectingLaneRsls: ['200:0:-1'] },
    ]);
    expect(plan.programs[0]?.mapBinding).toEqual({
      junctionId: 'j1',
      controllerIds: ['c1'],
      headIds: ['h1'],
      controllerHeadGroups: [{ controllerId: 'c1', headIds: ['h1'] }],
      timingSource: 'synthetic-default',
    });
    expect(resolveSiteSignalProgram(bundle, site, plan, { featureId: 'jx', approach: 'subject' })).toBe('signal:h1');
    expect(createMapContext(bundle, site).signal({ featureId: 'jx', approach: 'subject' })).toEqual({
      handle: 'signal:h1',
      phases: ['green', 'yellow', 'red'],
    });
    expect(buildSiteRoadControls(bundle, site)).toEqual([{
      id: 'road-control:stop1',
      kind: 'stop',
      dwellS: 1,
      stopLines: [{ rsl: '10:0:-1', s: 49, connectingLaneRsls: ['200:0:-1'] }],
      mapBinding: { junctionId: 'j1', controlIds: ['stop1'], source: 'map' },
    }]);
  });

  it('rejects required controls only when deterministic map bindings are absent', () => {
    const template = {
      anchor: {
        features: [{
          id: 'jx',
          kind: 'junction',
          control: { value: ['minor_stop'], essentiality: 'required' },
        }],
      },
    } as any;
    const bundle = {
      index: { junctionDescriptors: { j1: { control: 'minor_stop' } } },
    } as any;
    const site = {
      featureMatches: { jx: { mapFeatureId: 'junction:j1' } },
    } as any;
    expect(() =>
      assertMaterializableMapControls(template, bundle, site, {
        junctionId: 'j1',
        programs: [],
      } as any),
    ).toThrow(/no deterministic stop-sign-to-movement binding/);
    expect(() =>
      assertMaterializableMapControls(
        template,
        bundle,
        site,
        { junctionId: 'j1', programs: [] } as any,
        [{ id: 'stop1', kind: 'stop', dwellS: 1, stopLines: [{ rsl: 'lane', s: 1 }] }] as any,
      ),
    ).not.toThrow();
    template.anchor.features[0].control.value = ['signalized'];
    bundle.index.junctionDescriptors.j1.control = 'signalized';
    expect(() =>
      assertMaterializableMapControls(template, bundle, site, {
        junctionId: 'j1',
        programs: [],
      } as any),
    ).toThrow(/no complete OpenDRIVE controller\/head\/movement binding/);
    expect(() =>
      assertMaterializableMapControls(template, bundle, site, {
        junctionId: 'j1',
        programs: [{
          id: 'signal:h1',
          phases: [{ phase: 'green', durationS: 10 }],
          stopLines: [{ rsl: 'lane', s: 1, connectingLaneRsls: ['connector'] }],
          mapBinding: { junctionId: 'j1', controllerIds: ['c1'], headIds: ['h1'], timingSource: 'synthetic-default' },
        }],
      } as any),
    ).toThrow(/no complete OpenDRIVE controller\/head\/movement binding/);
    expect(mapSetKey('rules.yieldToVehicles')).toBe('rules.yieldToVehicles');
    expect(mapSetKey('rules.yieldToPedestrians')).toBe('rules.yieldToPedestrians');
  });
});

describe.skipIf(!haveMaps)('real map signal materialization', () => {
  it('makes map-wide Belmont stops and Yale signals authoritative for live preview', async () => {
    const [belmont, yale] = await Promise.all([loadMap(BELMONT), loadMap(YALE)]);
    const belmontControls = buildMapControlPlan(belmont);
    const yaleControls = buildMapControlPlan(yale);

    expect(belmontControls.signalPrograms).toEqual([]);
    expect(belmontControls.roadControls.length).toBeGreaterThan(0);
    expect(belmontControls.roadControls.flatMap((control) => control.mapBinding?.controlIds ?? []))
      .toContain('4376');
    expect(belmontControls.roadControls.every((control) =>
      control.stopLines.length > 0 && control.stopLines.every((line) =>
        belmont.graph.geometry(line.rsl) !== null && line.connectingLaneRsls.length > 0,
      ),
    )).toBe(true);
    expect(belmont.signalCatalog.speedLimits.some((sign) => sign.id === '4394' && sign.speedLimitKph > 40)).toBe(true);
    expect(belmont.graph.geometry('17:0:-1')?.speedLimitMps).toBeCloseTo(25 * 1.609344 / 3.6, 6);

    expect(yaleControls.signalPrograms.length).toBeGreaterThan(0);
    expect(yaleControls.signalPrograms.flatMap((program) => program.mapBinding?.headIds ?? []))
      .toContain('1542');
    expect(yaleControls.signalPrograms.every((program) =>
      program.stopLines.length > 0 && program.stopLines.every((line) =>
        yale.graph.geometry(line.rsl) !== null && line.connectingLaneRsls.length > 0,
      ),
    )).toBe(true);

    for (const bundle of [belmont, yale]) {
      const pool = createAmbientCandidatePool(bundle.graph, {
        version: 1, preset: 'custom', seed: `road-adherence:${bundle.mapId}`,
        densityVehiclesPerKm: 20, maxActors: 32, pedestrianShare: 0, cyclistShare: 0,
      });
      expect(pool.candidates.length).toBeGreaterThan(0);
      for (const candidate of pool.candidates) {
        const route = buildRoute(bundle.graph, { kind: 'lanePath', lanes: [...candidate.routeLaneRsls] });
        expect(route.ok, `${bundle.mapId}/${candidate.id} uses only directed connected successors`).toBe(true);
      }
    }
  }, 60_000);

  it('binds Yale physical heads and controller sequences to movement-filtered programs', async () => {
    const authoredTemplate = await readTemplate(LTAP);
    const template = ScenarioTemplateV2Schema.parse({
      ...authoredTemplate,
      choreography: {
        ...authoredTemplate.choreography,
        interactions: authoredTemplate.choreography.interactions.filter(
          (interaction) =>
            interaction.verb !== 'set' ||
            (interaction.target.key !== 'rules.yieldToVehicles' &&
              interaction.target.key !== 'rules.yieldToPedestrians'),
        ),
      },
    });
    const match = await matchOnMap(template, YALE);
    const bundle = await loadMap(YALE);
    const site = match.report.sites.find((candidate) => {
      return buildSiteSignalPlan(bundle, candidate).programs.length > 0;
    })!;
    expect(site).toBeDefined();
    const plan = buildSiteSignalPlan(bundle, site);
    expect(plan.timingSource).toBe('synthetic-default');
    expect(plan.junctionId).toBe(site.frame.origin.mapFeatureId.slice('junction:'.length));
    expect(plan.programs.length).toBeGreaterThan(0);
    expect(plan.programs.every((program) => program.mapBinding?.timingSource === 'synthetic-default')).toBe(true);
    expect(plan.programs.every((program) => {
      const binding = program.mapBinding!;
      const groups = binding.controllerHeadGroups!;
      return JSON.stringify(binding.controllerIds) === JSON.stringify(groups.map((group) => group.controllerId)) &&
        JSON.stringify(binding.headIds) === JSON.stringify([...new Set(groups.flatMap((group) => group.headIds))].sort());
    })).toBe(true);
    // Yale has heads active in more than one ordered controller stage. That
    // membership must survive materialization instead of being flattened to an
    // arbitrary controller id.
    expect(plan.programs.some((program) => program.mapBinding!.controllerHeadGroups!.length > 1)).toBe(true);
    expect(plan.programs.some((program) => program.stopLines.length > 0)).toBe(true);
    expect(
      plan.programs.flatMap((program) => program.stopLines).every((line) => line.connectingLaneRsls.length > 0),
    ).toBe(true);

    const concrete = materialize(template, bundle, site, { drawIndex: 0 });
    expect(concrete.input.signalPrograms).toEqual(plan.programs);
    expect(concrete.manifest.notes.some((note) => note.reason.includes('synthetic-default'))).toBe(true);

    const withSignalTrigger = structuredClone(template) as any;
    withSignalTrigger.choreography.interactions.push({
      id: 'ego-goes-on-green',
      actor: 'ego',
      verb: 'set',
      trigger: {
        kind: 'when',
        condition: { kind: 'signal', signal: { feature: 'jx', approach: 'subject' }, phase: 'green' },
        byLatest: 10,
        ifNever: 'skip',
      },
      target: { key: 'rules.obeySignals', value: true },
    });
    const triggered = materialize(ScenarioTemplateV2Schema.parse(withSignalTrigger), bundle, site, { drawIndex: 0 });
    const interaction = triggered.input.interactions.find((entry) => entry.id === 'ego-goes-on-green');
    expect(interaction?.trigger).toEqual(expect.objectContaining({
      kind: 'when',
      condition: expect.objectContaining({ kind: 'signal', phase: 'green' }),
    }));
    expect(triggered.manifest.notes.some((note) => note.path.includes('ego-goes-on-green') && note.reason.includes('dropped'))).toBe(false);
    const { trace } = runSimulation(triggered.input, { graph: bundle.graph, guards: 'collect' });
    expect(Object.keys(trace.ticks.signals ?? {})).toEqual(
      triggered.input.signalPrograms.map((program) => program.id).sort(),
    );
    expect(
      Object.values(trace.ticks.signals ?? {}).every((track) => track.phase.length === trace.ticks.t.length),
    ).toBe(true);
    expect(trace.events.some((event) => event.kind === 'trigger_fired' && event.interactionId === 'ego-goes-on-green')).toBe(true);

    const missingSignal = structuredClone(template) as any;
    missingSignal.choreography.interactions.push({
      id: 'waits-on-missing-map-control',
      actor: 'ego',
      verb: 'set',
      trigger: {
        kind: 'when',
        condition: { kind: 'signal', signal: { handle: 'not-a-real-head' }, phase: 'red' },
        byLatest: 10,
        ifNever: 'skip',
      },
      target: { key: 'rules.obeySignals', value: true },
    });
    expect(() =>
      materialize(ScenarioTemplateV2Schema.parse(missingSignal), bundle, site, { drawIndex: 0 }),
    ).toThrow(/not-a-real-head/);

    const withDistinctYield = materialize(authoredTemplate, bundle, site, { drawIndex: 0 });
    expect(withDistinctYield.input.actors.find((actor) => actor.id === 'ego')?.behavior.rules.yieldToVehicles).toBe(false);
    expect(withDistinctYield.input.actors.find((actor) => actor.id === 'oncoming')?.behavior.rules.yieldToVehicles).toBe(false);
  }, 60_000);

  it('keeps an unsignalized Belmont site explicitly empty', async () => {
    const bundle = await loadMap(BELMONT);
    expect(bundle.signalCatalog.heads).toEqual([]);
    expect(bundle.signalCatalog.controllers).toEqual([]);
    const junctionId = Object.keys(bundle.topology.junctions).sort()[0]!;
    const site = {
      frame: { origin: { mapFeatureId: `junction:${junctionId}` } },
    } as unknown as MatchedSite;
    const plan = buildSiteSignalPlan(bundle, site);
    expect(plan).toEqual(expect.objectContaining({ junctionId, programs: [], timingSource: 'none', stateSource: 'none' }));
  }, 60_000);

  it('rejects Yale junction 303 for its unbound cross movement and retains an exact viable alternative', async () => {
    const template = await readTemplate(RED_LIGHT);
    const match = await matchOnMap(template, YALE);
    const bundle = await loadMap(YALE);
    const atJunction = (junctionId: string) => match.report.sites.find(
      (site) => site.frame.origin.mapFeatureId === `junction:${junctionId}`,
    );
    const incomplete = atJunction('303');
    const viable = atJunction('345');
    expect(incomplete).toBeDefined();
    expect(viable).toBeDefined();

    const incompletePlan = buildSiteSignalPlan(bundle, incomplete!);
    expect(resolveSiteSignalProgram(bundle, incomplete!, incompletePlan, {
      featureId: 'signal-junction', approach: 'subject',
    })).toBeDefined();
    expect(resolveSiteSignalProgram(bundle, incomplete!, incompletePlan, {
      featureId: 'signal-junction', approach: 'left',
    })).toBeNull();
    expect(() => materialize(template, bundle, incomplete!, { drawIndex: 0 })).toThrow(/signal_unbindable|no physical signal head binds the left movement/);

    const viablePlan = buildSiteSignalPlan(bundle, viable!);
    expect(resolveSiteSignalProgram(bundle, viable!, viablePlan, {
      featureId: 'signal-junction', approach: 'subject',
    })).toBeDefined();
    expect(resolveSiteSignalProgram(bundle, viable!, viablePlan, {
      featureId: 'signal-junction', approach: 'left',
    })).toBeDefined();
    expect(() => materialize(template, bundle, viable!, { drawIndex: 0 })).not.toThrow();
  }, 60_000);

  it('executes the canonical replacement signal gallery scenario with concrete signal programs', async () => {
    const instanceFile = path.join(path.dirname(PROTECTED_LEFT_GALLERY), 'scenario.instance.json');
    const artifact = JSON.parse(await readFile(instanceFile, 'utf8')) as {
      input: Parameters<typeof runSimulation>[0];
    };
    const bundle = await loadMap(artifact.input.mapId as Parameters<typeof loadMap>[0]);
    expect(artifact.input.signalPrograms.length).toBeGreaterThan(0);
    expect(artifact.input.actors.map((actor) => actor.id).sort()).toEqual([
      'cyclist', 'focus-vehicle', 'mobility-scooter', 'outer-pickup', 'red-runner',
    ]);
    expect(artifact.input.interactions.find((interaction) => interaction.id === 'protected-left-turns-red'))
      .toMatchObject({ target: { key: expect.stringMatching(/^signal:.+\.phase$/) } });
    const { trace, issues } = runSimulation(artifact.input, { graph: bundle.graph, guards: 'collect' });
    expect(issues).toEqual([]);
    expect(trace.metrics.collisions).toEqual([]);
    expect(trace.metrics.triggerNeverFired).toEqual([]);
    expect(trace.ticks.t.at(-1)).toBe(20);
    expect(Object.keys(trace.ticks.actors).sort()).toEqual([
      'cyclist', 'focus-vehicle', 'mobility-scooter', 'outer-pickup', 'red-runner',
    ]);
    expect(trace.events.some((event) => event.kind === 'trigger_fired' && event.interactionId === 'protected-left-turns-red')).toBe(true);
    expect(trace.events.some((event) => event.kind === 'trigger_fired' && event.interactionId === 'cyclist-emerges')).toBe(true);
  }, 60_000);
});

describe.skipIf(!haveAllMaps)('five-map control binding closure', () => {
  it('closes every declared controller junction over physical heads and exact movements', async () => {
    for (const mapId of KNOWN_MAPS) {
      const bundle = await loadMap(mapId);
      for (const junction of bundle.signalCatalog.junctions) {
        const site = {
          frame: { origin: { mapFeatureId: `junction:${junction.junctionId}` } },
        } as unknown as MatchedSite;
        const plan = buildSiteSignalPlan(bundle, site);
        const controllerById = new Map(bundle.signalCatalog.controllers.map((controller) => [controller.id, controller]));
        const declaredVehicleHeads = new Set(
          junction.controllerIds
            .flatMap((id) => controllerById.get(id)?.signalIds ?? [])
            .filter((id) => bundle.signalCatalog.heads.some((head) => head.id === id)),
        );
        expect(plan.timingSource, `${mapId}/${junction.junctionId}`).toBe('synthetic-default');
        expect(plan.stateSource, `${mapId}/${junction.junctionId}`).toBe('synthetic-cycle');
        expect(new Set(plan.programs.flatMap((program) => program.mapBinding!.headIds))).toEqual(declaredVehicleHeads);
        expect(plan.programs.every((program) =>
          program.stopLines.length > 0 && program.stopLines.every(
            (line) => line.connectingLaneRsls.length > 0,
          ),
        ), `${mapId}/${junction.junctionId} has an unbound logical signal program`).toBe(true);
        for (const headId of declaredVehicleHeads) {
          expect(plan.programByHeadId.get(headId), `${mapId}/${junction.junctionId}/${headId}`).toBeDefined();
        }
      }
    }
  }, 60_000);
});
