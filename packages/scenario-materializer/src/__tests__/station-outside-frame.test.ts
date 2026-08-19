/**
 * A spawn station the site's reference path does not reach is a refusal.
 *
 * `framePoint` converts a frame station through `Route.poseAt`, which saturates
 * at the route ends. A station past the end therefore produced a *valid-looking*
 * world point at the road end, the actor materialised there, `manifest.feasible`
 * stayed true, and every number measured from that pose — arrival TTC, headway,
 * the recorded clip — described a scenario nobody authored. The matcher now
 * sizes each site's frame to the template's own longitudinal envelope, so this
 * is unreachable through matching; a parameter draw that reaches further than
 * the envelope is the remaining way in, and it must stop the cell rather than
 * quietly move the actor.
 *
 * Uses a real dev map: the defect is a property of real reference-path extents.
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
} from '@uniscenarios/anchor-matcher';
import type { DerivedTopology, LocationCatalog } from '@uniscenarios/map-intel';
import { ScenarioTemplateV2Schema, type ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import { buildLaneGraph, type TopologyIndex } from '@uniscenarios/sim-engine';

import { adaptTemplate } from '../adapt.js';
import { CliError } from '../errors.js';
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

/** A corridor template with one actor at `stationM` along the frame. */
function templateAt(stationM: number): ScenarioTemplateV2 {
  return ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: {
      name: 'station-outside-frame fixture',
      createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z',
      appVersion: 'uniscenarios/0.0.1',
      archetype: 'test.station-outside-frame',
      author: 'test',
    },
    params: { declarations: [], constraints: [] },
    environment: { weather: 'clear', timeOfDay: 'afternoon' },
    anchor: {
      id: 'plain-corridor',
      corridor: {
        throughLanesSameDir: { value: [1, 2], essentiality: 'required' },
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
        pose: { laneOffset: 0, s: stationM, tFrac: 0, headingOffsetRad: 0 },
        initialSpeedKph: 30,
      },
    ],
    props: [],
    choreography: { clipSeconds: 8, warmupSeconds: 1, interactions: [] },
    invariants: [],
    variants: [],
    metricSubject: 'ego',
  });
}

function firstSite(template: ScenarioTemplateV2): { bundle: MapBundle; site: MatchedSite } {
  const loaded = loadBundle();
  const { anchor, roles, scope } = adaptTemplate(template);
  const report = matchAnchorReport(anchor, loaded.index, { roles, scope });
  const site = report.sites[0];
  expect(site, `${MAP_ID} should offer a corridor site`).toBeDefined();
  return { bundle: loaded, site: site! };
}

describe.skipIf(!HAVE_MAP)('a station outside the matched frame', () => {
  it('materialises the authored station when the frame holds it', () => {
    const template = templateAt(20);
    const { bundle: loaded, site } = firstSite(template);
    const { input } = materialize(template, loaded, site, { drawIndex: 0 });
    expect(input.actors.some((actor) => actor.id === 'ego')).toBe(true);
  });

  it('refuses instead of clamping the actor onto the road end', () => {
    const matched = templateAt(20);
    const { bundle: loaded, site } = firstSite(matched);
    // Same site, a station the frame cannot hold: what a parameter draw wider
    // than the matched envelope produces.
    const beyond = site.frame.sRange[1] + 500;
    let error: unknown;
    try {
      materialize(templateAt(beyond), loaded, site, { drawIndex: 0 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe('role_station_outside_frame');
    expect((error as CliError).message).toContain('outside this site');
  });
});
