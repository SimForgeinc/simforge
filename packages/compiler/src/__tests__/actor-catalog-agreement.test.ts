/**
 * An actor's semantic class and its catalog model must describe the same thing.
 *
 * The defect this pins was measured, not imagined. A brief asking for "an animal
 * wanders into the ego's lane" produced a clip whose actor reads
 * `kind: 'animal'`, `tags: ['class:animal', 'catalog:pedestrian.adult_walking']`
 * — an animal trajectory wearing a walking adult human. It passed the admission
 * gate, the physics-quality layer and an independent intent critic, because all
 * of those read trajectories or a top-down render, where a 0.6 m box is a 0.6 m
 * box whatever fills it. The catalog id is the only witness, so the catalog id
 * is where it has to be caught. A corpus built from clips like that teaches a
 * perception model that an animal looks like a person.
 *
 * It is the same latent defect as an unresolvable id (`vehicle.boxTruck`)
 * silently materialising as a sedan, so the rule is general: for **every** class,
 * the pair must agree or the build fails.
 *
 * A real dev map is used because the check lives in `buildActor`, which only
 * runs once a role has actually bound to concrete lane structure.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  matchAnchorReport,
  normalizeDerivedMapIndex,
  type MatchedSite,
} from '../anchor/index.js';
import type { DerivedTopology, LocationCatalog } from '@simforge-oss/maps';
import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from '@simforge-oss/scenario';
import { buildLaneGraph, type TopologyIndex } from '@simforge-oss/engine';

import { adaptTemplate } from '../adapt.js';
import {
  materialize,
  type MaterializeOptions,
  type MaterializeResult,
} from '../materialize.js';
import { topologyWithMapSpeedLimits } from '../map-signals.js';
import type { MapBundle } from '../types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_ASSETS = path.resolve(HERE, '..', '..', '..', '..', 'dev-assets');
const MAP_ID = 'richmond-field-station-richmond-ca';
const HAVE_MAP = existsSync(path.join(DEV_ASSETS, MAP_ID, 'topology-index.json.gz'));

function readJsonGz<T>(file: string): T {
  const bytes = readFileSync(file);
  const plain = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  return JSON.parse(plain.toString('utf8')) as T;
}

let cached: MapBundle | null = null;
function loadBundle(): MapBundle {
  if (cached) return cached;
  const dir = path.join(DEV_ASSETS, MAP_ID);
  const raw = readJsonGz<TopologyIndex>(path.join(dir, 'topology-index.json.gz'));
  const derived = readJsonGz<DerivedTopology>(path.join(dir, 'derived', 'topology-derived.json.gz'));
  const catalog = readJsonGz<LocationCatalog>(path.join(dir, 'derived', 'locations.json.gz'));
  const signalCatalog: MapBundle['signalCatalog'] = {
    heads: [], roadControls: [], speedLimits: [], applicability: [], controllers: [], junctions: [],
  };
  const topology = topologyWithMapSpeedLimits(raw, signalCatalog);
  const index = normalizeDerivedMapIndex(derived as unknown, {
    mapId: MAP_ID,
    topology: topology as never,
    locations: catalog as unknown,
  });
  cached = {
    mapId: MAP_ID,
    catalog,
    derived,
    topology,
    index,
    graph: buildLaneGraph(topology),
    signalCatalog,
  };
  return cached;
}

interface ActorSpecInput {
  class: string;
  catalogId?: string;
  dims?: { length: number; width: number; height: number };
  static?: boolean;
}

/** Ego plus one roadside actor whose class/catalog pair is under test. */
function templateWith(subject: ActorSpecInput, props: unknown[] = [], bodyColor?: string): ScenarioTemplateV2 {
  return ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: {
      name: 'actor catalog agreement fixture',
      createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      appVersion: 'simforge/0.0.1',
      archetype: 'test.actor-catalog-agreement',
      author: 'test',
    },
    params: { declarations: [], constraints: [] },
    environment: { weather: 'clear', timeOfDay: 'afternoon' },
    anchor: {
      id: 'plain-corridor',
      corridor: {
        throughLanesSameDir: { value: [1, 4], essentiality: 'required' },
        runwayDownstreamM: { value: [120, null], essentiality: 'required' },
      },
      features: [],
      policy: { allowMirror: false, maxSitesPerMap: 8, diversity: 'moderate', minScore: 0.5 },
    },
    roles: [
      {
        id: 'ego',
        kind: 'on_reference',
        actor: { class: 'car', catalogId: 'vehicle.sedan' },
        pose: { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 },
        initialSpeedKph: 30,
      },
      {
        id: 'subject',
        kind: 'on_reference',
        actor: subject,
        pose: { laneOffset: 0, s: 60, tFrac: -0.9, headingOffsetRad: 0 },
        initialSpeedKph: 0,
        ...(bodyColor ? { extensions: { 'studio.presentation.bodyColor': bodyColor } } : {}),
      },
    ],
    props,
    choreography: { clipSeconds: 8, warmupSeconds: 1, interactions: [] },
    invariants: [],
    variants: [],
    metricSubject: 'ego',
  });
}

function run(
  template: ScenarioTemplateV2,
  catalogEntries?: MaterializeOptions['catalogEntries'],
): MaterializeResult {
  const bundle = loadBundle();
  const { anchor, roles } = adaptTemplate(template);
  const report = matchAnchorReport(anchor, bundle.index, { roles });
  const site: MatchedSite | undefined = report.sites[0];
  expect(site, `${MAP_ID} should offer a corridor site`).toBeDefined();
  return materialize(template, bundle, site!, { drawIndex: 0, catalogEntries });
}

function actor(result: MaterializeResult, id: string) {
  const found = result.input.actors.find((candidate) => candidate.id === id);
  expect(found, `actor ${id}`).toBeDefined();
  return found!;
}

describe.skipIf(!HAVE_MAP)('actor class / catalog id agreement', () => {
  it('refuses an animal wearing a pedestrian model', () => {
    expect(() => run(templateWith({ class: 'animal', catalogId: 'pedestrian.adult_walking' })))
      .toThrow(/actor class "animal" cannot be filled by catalog model "pedestrian.adult_walking"/);
  });

  it('refuses a pedestrian wearing a vehicle model, and a car wearing a bus model', () => {
    expect(() => run(templateWith({ class: 'pedestrian', catalogId: 'vehicle.van' }))).toThrow(/cannot be filled by/);
    expect(() => run(templateWith({ class: 'car', catalogId: 'vehicle.bus' }))).toThrow(/cannot be filled by/);
  });

  it('refuses an id that does not exist rather than substituting a default model', () => {
    // The historical shape of this bug: `vehicle.boxTruck` is not an id — the
    // real one is `vehicle.box_truck` — and it used to materialise as a sedan.
    expect(() => run(templateWith({ class: 'truck', catalogId: 'vehicle.boxTruck' })))
      .toThrow(/does not exist/);
  });

  it('materializes a persisted gallery vehicle with its authored class and dimensions', () => {
    const catalogId = 'gallery.90dc9cf7-5c32-4a97-b43b-768f2749a221.v1';
    const result = run(
      templateWith({ class: 'car', catalogId }),
      [{
        id: catalogId,
        label: 'Kia Carnival',
        class: 'vehicle',
        actorClass: 'car',
        description: 'Kia Carnival',
        dims: { l: 5.155, w: 1.995, h: 1.775 },
        tags: ['passenger'],
        defaultParams: {},
        model: {
          kind: 'glb',
          url: 'https://example.invalid/kia-carnival.glb',
          contentHash: 'a'.repeat(64),
        },
      }],
    );
    expect(actor(result, 'subject')).toMatchObject({
      kind: 'car',
      dims: { l: 5.155, w: 1.995, h: 1.775 },
      tags: expect.arrayContaining([`catalog:${catalogId}`]),
    });
  });

  it('still refuses an unknown gallery id when no persisted metadata is supplied', () => {
    expect(() => run(templateWith({
      class: 'car',
      catalogId: 'gallery.00000000-0000-0000-0000-000000000000.v1',
    }))).toThrow(/does not exist/);
  });

  it('accepts agreeing pairs, including a prop id placed as inert scenery', () => {
    expect(() => run(templateWith({ class: 'animal', catalogId: 'animal.deer' }))).not.toThrow();
    expect(() => run(templateWith({ class: 'car', catalogId: 'vehicle.sedan' }))).not.toThrow();
    expect(() => run(templateWith({ class: 'static_object', catalogId: 'object.tyre', static: true }))).not.toThrow();
  });

  it('projects authored Studio paint onto the materialized playback actor', () => {
    const result = run(templateWith({ class: 'car', catalogId: 'vehicle.sedan' }, [], '#8C2F2F'));
    expect(actor(result, 'subject').tags).toContain('studio:body-color:#8c2f2f');
  });
});

describe.skipIf(!HAVE_MAP)('the catalog model carries the footprint', () => {
  it('gives a deer the deer footprint instead of the generic animal box', () => {
    const deer = actor(run(templateWith({ class: 'animal', catalogId: 'animal.deer' })), 'subject');
    expect(deer.kind).toBe('animal');
    expect(deer.dims).toEqual({ l: 1.76, w: 0.46, h: 1.62 });
    // The generic class default, which is what an authored deer used to get.
    expect(deer.dims).not.toEqual({ l: 1.2, w: 0.5, h: 1 });
  });

  it('resolves an author-facing object id to the real prop footprint', () => {
    const tyre = actor(
      run(templateWith({ class: 'static_object', catalogId: 'object.tyre', static: true })),
      'subject',
    );
    expect(tyre.dims).toEqual({ l: 0.74, w: 0.56, h: 0.24 });
    expect(tyre.dims).not.toEqual({ l: 1, w: 1, h: 1 });
  });

  it('still lets an explicit dims override win', () => {
    const result = run(templateWith({
      class: 'animal',
      catalogId: 'animal.deer',
      dims: { length: 2.4, width: 0.8, height: 1.9 },
    }));
    expect(actor(result, 'subject').dims).toEqual({ l: 2.4, w: 0.8, h: 1.9 });
  });

  it('places debris and traffic furniture props under their author-facing ids', () => {
    const result = run(templateWith({ class: 'animal', catalogId: 'animal.deer' }, [
      { id: 'tyre', catalogId: 'object.tyre', pose: { laneOffset: 0, s: 45, tFrac: 0.2, headingOffsetRad: 0 } },
      { id: 'cones', catalogId: 'object.cone', pose: { laneOffset: 0, s: 50, tFrac: 0.5, headingOffsetRad: 0 }, repeat: { count: 3, spacingM: 4 } },
    ]));
    const tyre = result.input.props?.find((prop) => prop.id === 'tyre');
    expect(tyre?.dims).toEqual({ l: 0.74, w: 0.56, h: 0.24 });
    expect(tyre?.collidable, 'debris in the carriageway is a physical object').toBe(true);
    const cone = result.input.props?.find((prop) => prop.id === 'cones-0');
    expect(cone?.dims).toEqual({ l: 0.36, w: 0.36, h: 0.7 });
  });
});
