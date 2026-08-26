import { buildLaneGraph, parseSimScenarioInput, type TopologyIndex } from '@simforge-oss/engine';
import { describe, expect, it } from 'vitest';

import {
  exportOpenScenarioXml14,
  extractOpenScenarioExecutionPlan,
  OpenScenarioExecutionPlanError,
} from './index.js';

const SOURCE_SHA256 = '0123456789abcdef'.repeat(4);
const graph = buildLaneGraph({
  schemaVersion: 1,
  mapName: 'replay-map',
  source: { xodrSha256: 'fixture' },
  lanes: {},
  gates: [],
  junctions: {},
} satisfies TopologyIndex);

function fixture() {
  return parseSimScenarioInput({
    mapId: 'replay-map',
    clipSeconds: 1,
    warmupSeconds: 0,
    dt: 0.1,
    physics: { mode: 'kinematic-v1' },
    metricSubject: 'ego/authored-id',
    operationalConditions: {
      weather: 'rain',
      timeOfDay: 'dusk',
      visibility: 'reduced-contrast',
      traffic: 'moderate',
      effects: { frictionScale: 0.8, visibilityRangeM: 700, trafficSpeedFactor: 0.9 },
    },
    actors: [{
      id: 'ego/authored-id',
      kind: 'car',
      dims: { l: 4.6, w: 1.9, h: 1.5 },
      tags: ['catalog:vehicle.sedan', 'driver-profile:cautious'],
      initial: { pose: { x: 10, z: -5, headingRad: 0.25 }, speedMps: 2 },
      behavior: { route: { kind: 'polyline', points: [{ x: 10, z: -5 }, { x: 80, z: -5 }] } },
    }],
    interactions: [{
      id: 'despawn',
      actorId: 'ego/authored-id',
      trigger: { kind: 'at', t: 0.8 },
      verb: 'exist',
      target: { state: 'absent' },
    }],
  });
}

function exportedFixture(): string {
  return exportOpenScenarioXml14(fixture(), {
    graph,
    executionMode: 'trajectory-replay',
    roadFile: 'maps/replay-map.xodr',
  }).content;
}

function expectCode(xosc: string, code: string): void {
  try {
    extractOpenScenarioExecutionPlan(xosc, { sourceSha256: SOURCE_SHA256 });
    throw new Error(`expected execution-plan error ${code}`);
  } catch (caught) {
    expect(caught).toBeInstanceOf(OpenScenarioExecutionPlanError);
    expect((caught as OpenScenarioExecutionPlanError).code).toBe(code);
  }
}

describe('extractOpenScenarioExecutionPlan', () => {
  it('extracts the exporter trajectory, metadata, and caller-verified source identity', () => {
    const plan = extractOpenScenarioExecutionPlan(exportedFixture(), { sourceSha256: SOURCE_SHA256 });

    expect(plan).toMatchObject({
      sourceSha256: SOURCE_SHA256,
      mapId: 'replay-map',
      dt: 0.1,
      warmupSeconds: 0,
      clipSeconds: 1,
      stopTimeS: 1,
      roadFile: 'maps/replay-map.xodr',
    });
    expect(plan.actors).toHaveLength(1);
    expect(plan.actors[0]).toMatchObject({
      id: 'ego/authored-id',
      kind: 'car',
      static: false,
      dims: { l: 4.6, w: 1.9, h: 1.5 },
      tags: ['catalog:vehicle.sedan', 'driver-profile:cautious'],
    });
    expect(plan.actors[0]!.samples.at(-1)?.present).toBe(false);
  });

  it('rejects unsupported profile elements, actions, triggers, markers, and trajectory mutations', () => {
    const xosc = exportedFixture();
    expectCode(xosc.replace('value="xml-1.4-trajectory-replay"', 'value="xml-1.4-actions"'), 'unknown_profile');
    expectCode(xosc.replace('<Vertex time="0.1">', '<Vertex time="0.15">'), 'invalid_actor_timeline');
    expectCode(xosc.replace(/\s*<PrivateAction>\s*<RoutingAction>[\s\S]*?<\/RoutingAction>\s*<\/PrivateAction>/, ''), 'missing_trajectory');
    expectCode(xosc.replace('<DeleteEntityAction/>', '<AddEntityAction/>'), 'unsupported_action');
    expectCode(xosc.replace('conditionEdge="none"', 'conditionEdge="rising"'), 'unsupported_trigger');
    expectCode(xosc.replace('<OpenSCENARIO>', '<OpenSCENARIO><Bogus/>'), 'unsupported_element');
    expectCode(xosc.replace('</OpenSCENARIO>', ''), 'malformed_xml');
  });

  it('rejects a digest that is not a 64-character hexadecimal SHA-256 value', () => {
    expect(() => extractOpenScenarioExecutionPlan(exportedFixture(), { sourceSha256: 'not-a-digest' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_source_digest' }));
  });
});
