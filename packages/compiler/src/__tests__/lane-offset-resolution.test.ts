/**
 * The materializer's lane-offset resolution must fail rather than relocate.
 *
 * `framePosePoint` is the one place every authored `laneOffset` is turned into
 * a world point: role poses, prop poses, `route` polyline vertices, arrival
 * triggers and `at.pose` invariants all pass through it. When the matched site
 * had no lane at the requested `k` it pushed a note and fell back to the
 * **reference** lane — so a prop authored one lane over materialised in the
 * ego's own lane, and an arrival invariant measured against a station the
 * scenario never described. A note is not a failure: `manifest.feasible` stayed
 * true and the cell ran.
 *
 * This test uses a real dev map because the defect is a property of real
 * cross-sections: it only shows up where the corridor is narrower than the
 * template assumes, which is most of these maps.
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
import { materialize } from '../materialize.js';
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

let bundle: MapBundle | null = null;
function loadBundle(): MapBundle {
  if (bundle) return bundle;
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
  bundle = {
    mapId: MAP_ID,
    catalog,
    derived,
    topology,
    index,
    graph: buildLaneGraph(topology),
    signalCatalog,
  };
  return bundle;
}

const car = { class: 'car', catalogId: 'vehicle.sedan' } as const;

/** A one-lane corridor template whose *prop* asks for a lane that is not there. */
function templateWithPropAt(laneOffset: number): ScenarioTemplateV2 {
  return ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: {
      name: 'lane-offset resolution fixture',
      createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      appVersion: 'simforge/0.0.1',
      archetype: 'test.lane-offset-resolution',
      author: 'test',
    },
    params: { declarations: [], constraints: [] },
    environment: { weather: 'clear', timeOfDay: 'afternoon' },
    anchor: {
      id: 'one-lane-corridor',
      corridor: {
        throughLanesSameDir: { value: [1, 1], essentiality: 'required' },
        runwayDownstreamM: { value: [120, null], essentiality: 'required' },
      },
      features: [],
      policy: { allowMirror: false, maxSitesPerMap: 8, diversity: 'moderate', minScore: 0.5 },
    },
    roles: [
      {
        id: 'ego',
        kind: 'on_reference',
        actor: car,
        pose: { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 },
        initialSpeedKph: 30,
      },
    ],
    props: [
      {
        id: 'cone',
        catalogId: 'prop.traffic_cone',
        essentiality: 'required',
        pose: { laneOffset, s: 40, tFrac: 0, headingOffsetRad: 0 },
        headingOffsetRad: 0,
        scale: 1,
      },
    ],
    choreography: { clipSeconds: 8, warmupSeconds: 1, interactions: [] },
    invariants: [],
    variants: [],
    metricSubject: 'ego',
  });
}

function firstSite(template: ScenarioTemplateV2): { bundle: MapBundle; site: MatchedSite } {
  const loaded = loadBundle();
  const { anchor, roles } = adaptTemplate(template);
  const report = matchAnchorReport(anchor, loaded.index, { roles });
  const site = report.sites[0];
  expect(site, `${MAP_ID} should offer a one-lane corridor site`).toBeDefined();
  return { bundle: loaded, site: site! };
}

describe.skipIf(!HAVE_MAP)('framePosePoint — a laneOffset the site cannot satisfy', () => {
  it('materialises normally when the offset is the reference lane', () => {
    const template = templateWithPropAt(0);
    const { bundle: loaded, site } = firstSite(template);
    const { input } = materialize(template, loaded, site, { drawIndex: 0 });
    expect(input.props?.some((p) => p.id === 'cone')).toBe(true);
  });

  it('fails loudly instead of quietly re-parking the prop on the reference lane', () => {
    const template = templateWithPropAt(-1);
    const { bundle: loaded, site } = firstSite(template);
    expect(Object.keys(site.frame.lateralLanes).map(Number)).not.toContain(-1);
    expect(() => materialize(template, loaded, site, { drawIndex: 0 })).toThrowError(
      expect.objectContaining({
        code: 'lane_offset_unavailable',
        message: expect.stringMatching(/no lane at lane offset -1/),
      }),
    );
  });
});
