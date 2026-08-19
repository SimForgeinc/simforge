/**
 * W2 — a roadside occluder must be able to sit OFF the carriageway.
 *
 * `FramePose.tFrac` is a fraction of local lane width, bounded to [-1, 1]. Whatever constant it is
 * multiplied by, it is bounded by the road's own geometry, so there is no way to author "2.5 m
 * beyond the kerb". The measured consequence (`OCCLUSION-FINDING.md`): a hedge authored at
 * `tFrac -1` ends up at the same lateral position as the VRU it is supposed to hide, and occlusion
 * was proven in 0/30 then 0/80 cells. The only workaround that ever worked put a box truck in the
 * ADJACENT lane, which needs `throughLanesSameDir >= 2` — and that fails at 157/210 sites, so it
 * cannot satisfy the >=2 maps / >=3 sites clause.
 *
 * The fix is a representation change, not another validator: an explicit metric lateral offset with
 * a named reference. This test pins the property that matters — a `verge`-referenced prop lands
 * strictly outside the carriageway, further out than `tFrac` can reach.
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

const car = { class: 'car', catalogId: 'vehicle.sedan' } as const;

function templateWithPropPose(pose: Record<string, unknown>): ScenarioTemplateV2 {
  return ScenarioTemplateV2Schema.parse({
    scenarioVersion: 2,
    meta: {
      name: 'verge placement fixture', createdAt: '2026-08-01T00:00:00.000Z',
      modifiedAt: '2026-08-01T00:00:00.000Z', appVersion: 'uniscenarios/0.0.1',
      archetype: 'test.verge-placement', author: 'test',
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
    roles: [{
      id: 'ego', kind: 'on_reference', actor: car,
      pose: { laneOffset: 0, s: 10, tFrac: 0, headingOffsetRad: 0 }, initialSpeedKph: 30,
    }],
    props: [{
      id: 'hedge', catalogId: 'occluder.hedge_run', essentiality: 'required',
      pose, headingOffsetRad: 0, scale: 1,
    }],
    choreography: { clipSeconds: 8, warmupSeconds: 1, interactions: [] },
    invariants: [], variants: [], metricSubject: 'ego',
  });
}

function firstSite(template: ScenarioTemplateV2): { bundle: MapBundle; site: MatchedSite } {
  const loaded = loadBundle();
  const { anchor, roles, scope } = adaptTemplate(template);
  const report = matchAnchorReport(anchor, loaded.index, { roles, scope });
  const site = report.sites[0];
  expect(site, `${MAP_ID} should offer a one-lane corridor site`).toBeDefined();
  return { bundle: loaded, site: site! };
}

/** Where the hedge prop materialises, in xodr-local metres. */
function propPointOf(template: ScenarioTemplateV2): { x: number; y: number } {
  const { bundle: loaded, site } = firstSite(template);
  const { input } = materialize(template, loaded, site, { drawIndex: 0 });
  const prop = input.props?.find((p) => p.id === 'hedge');
  expect(prop, 'the hedge prop should materialise').toBeDefined();
  return { x: prop!.pose.x, y: prop!.pose.z };
}

/**
 * Signed lateral displacement of a pose from the lane-centre datum at the SAME station.
 *
 * Measuring against a same-`s` datum rather than against the ego cancels the road's own geometry:
 * two poses that differ only in lateral offset differ only by a lateral vector, whatever the lane
 * is doing. The sign is taken against a known-right-hand reference (`tFrac = -1`), so "further
 * out on the same side" is a positive number and a placement that flipped sides would be negative.
 */
function lateralFromCentre(pose: Record<string, unknown>): number {
  const datum = propPointOf(templateWithPropPose({ laneOffset: 0, s: 40, tFrac: 0, headingOffsetRad: 0 }));
  const right = propPointOf(templateWithPropPose({ laneOffset: 0, s: 40, tFrac: -1, headingOffsetRad: 0 }));
  const rx = right.x - datum.x;
  const ry = right.y - datum.y;
  const rlen = Math.hypot(rx, ry);
  expect(rlen, 'tFrac -1 must displace the prop from the lane centre').toBeGreaterThan(0.1);
  const p = propPointOf(templateWithPropPose(pose));
  return ((p.x - datum.x) * rx + (p.y - datum.y) * ry) / rlen;
}

describe.skipIf(!HAVE_MAP)('FramePose lateral placement can reach the verge', () => {
  it('tFrac is bounded by the road, so it cannot reach past the carriageway', () => {
    expect(lateralFromCentre({ laneOffset: 0, s: 40, tFrac: -1, headingOffsetRad: 0 }))
      .toBeGreaterThan(0.1);
    // and asking for more is a schema error, not a bigger offset
    expect(() => templateWithPropPose({ laneOffset: 0, s: 40, tFrac: -1.8, headingOffsetRad: 0 }))
      .toThrowError();
  });

  it('lateralM 0 from the lane centre is the lane centre', () => {
    expect(lateralFromCentre(
      { laneOffset: 0, s: 40, lateralM: 0, lateralRef: 'lane_centre', headingOffsetRad: 0 }))
      .toBeCloseTo(0, 3);
  });

  it('places a prop a stated number of metres beyond the lane edge', () => {
    const edge = lateralFromCentre(
      { laneOffset: 0, s: 40, lateralM: -2.5, lateralRef: 'lane_edge', headingOffsetRad: 0 });
    // 2.5 m beyond the nearer lane edge is 2.5 m + half a lane from the centreline.
    expect(edge).toBeGreaterThan(2.5);
  });

  it('places a prop off the carriageway entirely when the reference is the verge', () => {
    const tFracLimit = lateralFromCentre({ laneOffset: 0, s: 40, tFrac: -1, headingOffsetRad: 0 });
    const verge = lateralFromCentre(
      { laneOffset: 0, s: 40, lateralM: -2.0, lateralRef: 'verge', headingOffsetRad: 0 });
    // Same side, and strictly further out than the fraction form can ever reach.
    expect(verge).toBeGreaterThan(tFracLimit);
  });

  it('rejects specifying both a fractional and a metric lateral offset', () => {
    expect(() => templateWithPropPose(
      { laneOffset: 0, s: 40, tFrac: -0.9, lateralM: -2.0, lateralRef: 'verge', headingOffsetRad: 0 }))
      .toThrowError(/lateralM/);
  });
});
