/**
 * A `when` trigger's `byLatest` is a firing deadline, not an eligibility window.
 *
 * The materializer used to emit BOTH: the engine trigger kept `byLatest`/`ifNever`,
 * and the interaction also got `window: { startS: 0, endS: byLatest }`. The engine
 * checks the window first (`sim/engine.ts`, `window_elapsed`) and only then asks
 * `shouldFire`, which is where `ifNever: 'fire'` forces the interaction at
 * `byLatest`. Both fire on the same tick, so the window always won:
 * `ifNever: 'fire'` was unreachable for every template-authored `when`, every such
 * trigger landed in `metrics.triggerNeverFired`, and — once fired — the command's
 * axis was silently released at `byLatest` as well.
 *
 * One deadline, one representation. Only an authored `until: at(t)` is a window.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { matchAnchorReport, normalizeDerivedMapIndex } from '@uniscenarios/anchor-matcher';
import type { DerivedTopology, LocationCatalog } from '@uniscenarios/map-intel';
import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import { buildLaneGraph, type TopologyIndex } from '@uniscenarios/sim-engine';

import { adaptTemplate } from '../adapt.js';
import { materialize } from '../materialize.js';
import { topologyWithMapSpeedLimits } from '../map-signals.js';
import type { MapBundle } from '../types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_ASSETS = path.resolve(HERE, '..', '..', '..', '..', 'dev-assets');
const MAP_ID = 'richmond-field-station';
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
    mapId: MAP_ID, topology: topology as never, locations: catalog as unknown,
  });
  bundle = {
    mapId: MAP_ID, catalog, derived, topology, index,
    graph: buildLaneGraph(topology), signalCatalog,
  };
  return bundle;
}

function templateWith(interaction: Record<string, unknown>): ScenarioTemplateV2 {
  return ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: {
      name: 'when deadline fixture', createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z', appVersion: 'uniscenarios/0.0.1',
      archetype: 'test.when-deadline', author: 'test',
    },
    params: { declarations: [], constraints: [] },
    environment: { weather: 'clear', timeOfDay: 'afternoon' },
    anchor: {
      id: 'plain-corridor',
      corridor: {
        throughLanesSameDir: { value: [1, 1], essentiality: 'required' },
        runwayDownstreamM: { value: [120, null], essentiality: 'required' },
      },
      features: [],
      policy: { allowMirror: false, maxSitesPerMap: 8, diversity: 'moderate', minScore: 0.5 },
    },
    roles: [
      {
        id: 'ego', kind: 'on_reference', actor: { class: 'car', catalogId: 'vehicle.sedan' },
        pose: { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 }, initialSpeedKph: 30,
      },
      {
        id: 'lead', kind: 'relative_to', ref: 'ego', dLane: 0, dsM: 40, tFrac: 0,
        headingOffsetRad: 0, actor: { class: 'car', catalogId: 'vehicle.sedan' },
        initialSpeedKph: 30,
      },
    ],
    props: [],
    choreography: { clipSeconds: 12, warmupSeconds: 1, interactions: [interaction] },
    invariants: [], variants: [], metricSubject: 'ego',
  });
}

function materialized(interaction: Record<string, unknown>) {
  const loaded = loadBundle();
  const template = templateWith(interaction);
  const { anchor, roles } = adaptTemplate(template);
  const site = matchAnchorReport(anchor, loaded.index, { roles }).sites[0];
  expect(site, `${MAP_ID} should offer a plain corridor site`).toBeDefined();
  const { input } = materialize(template, loaded, site!, { drawIndex: 0 });
  const emitted = input.interactions.find((it) => it.id === 'brake');
  expect(emitted, 'the interaction should materialise').toBeDefined();
  return emitted!;
}

const brake = {
  id: 'brake', actor: 'lead', verb: 'speed', target: { mode: 'stop' },
  dynamics: { shape: 'linear', constraint: 'rate', value: 4 },
};

describe.skipIf(!HAVE_MAP)('when(byLatest) is a deadline, not a window', () => {
  it('emits the deadline on the trigger and no eligibility window', () => {
    const emitted = materialized({
      ...brake,
      trigger: {
        kind: 'when',
        condition: { kind: 'distance', from: 'ego', to: { role: 'lead' }, measure: 'euclidean', op: '<=', valueM: 25 },
        byLatest: 7,
        ifNever: 'fire',
      },
    });
    expect(emitted.trigger).toMatchObject({ kind: 'when', byLatest: 7, ifNever: 'fire' });
    expect(emitted.window).toBeUndefined();
  });

  it('still emits a window for an authored until(at)', () => {
    const emitted = materialized({
      ...brake,
      trigger: { kind: 'at', t: 2 },
      until: { kind: 'at', t: 6 },
    });
    expect(emitted.window).toEqual({ startS: 2, endS: 6 });
  });
});
