import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildLaneGraph, parseSimScenarioInput, runSimulation, type TopologyIndex } from '@simforge/engine';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AsamExportError,
  assertOpenScenarioDsl22ProfileSyntax,
  exportOpenScenarioDsl22,
  exportOpenScenarioXml14,
  validateOpenScenarioDsl22ProfileSyntax,
} from './index.js';
import {
  OFFICIAL_OPENSCENARIO_140_XSD,
  validateOpenScenarioXml14,
} from '../node/xml-1.4-validation.js';

const graph = buildLaneGraph({
  schemaVersion: 1,
  mapName: 'export-fixture',
  source: { xodrSha256: 'fixture' },
  lanes: {},
  gates: [],
  junctions: {},
} satisfies TopologyIndex);

const laneGraph = buildLaneGraph({
  schemaVersion: 1,
  mapName: 'lane-export-fixture',
  source: { xodrSha256: 'lane-fixture' },
  lanes: Object.fromEntries([
    ['1:0:-1', 0, null, '1:0:-2'],
    ['1:0:-2', -3.5, '1:0:-1', null],
  ].map(([rsl, y, left, right]) => [rsl, {
    rsl, roadId: 1, section: 0, laneId: rsl === '1:0:-1' ? -1 : -2,
    laneType: 'driving', isJunction: false, junctionId: null,
    predecessors: [], successors: [], speedLimitKph: 50, representativeWidthM: 3.5,
    widthSamples: [{ s: 0, widthM: 3.5 }, { s: 500, widthM: 3.5 }],
    adjacentLanes: {
      left: { side: 'left', laneRsl: left, sameDirection: left !== null, permissionIds: left ? [`${rsl}:left`] : [] },
      right: { side: 'right', laneRsl: right, sameDirection: right !== null, permissionIds: right ? [`${rsl}:right`] : [] },
    },
    laneChangePermissions: [
      ...(left ? [{ id: `${rsl}:left`, side: 'left', startS: 0, endS: 500, allowed: true, marking: 'broken', source: 'fixture' }] : []),
      ...(right ? [{ id: `${rsl}:right`, side: 'right', startS: 0, endS: 500, allowed: true, marking: 'broken', source: 'fixture' }] : []),
    ],
    polyline: [{ x: 0, y }, { x: 500, y }],
  }])),
  gates: [],
  junctions: {},
} as TopologyIndex);

function mappedLaneChangeFixture(count = 1, durationS = 1) {
  return parseSimScenarioInput({
    mapId: 'lane-export-fixture', clipSeconds: 12, warmupSeconds: 0, dt: 0.02,
    physics: { mode: 'kinematic-v1' }, metricSubject: 'ego',
    actors: [{
      id: 'ego', kind: 'vehicle', dims: { l: 4.5, w: 1.9, h: 1.5 },
      initial: { laneRef: { rsl: '1:0:-2', s: 10, tFrac: 0 }, pose: { x: 10, z: 3.5, headingRad: 0 }, speedMps: 5 },
      behavior: { route: { kind: 'lanePath', lanes: ['1:0:-2'] }, cruiseSpeedMps: 5 },
    }],
    interactions: [{
      id: 'mapped-change', actorId: 'ego', trigger: { kind: 'at', t: 1 }, verb: 'changeLane',
      target: { mode: 'left', count }, dynamics: { shape: 'sinusoidal', constraint: 'time', value: durationS },
    }],
  });
}

function fixture() {
  return parseSimScenarioInput({
    mapId: 'fixture-map',
    clipSeconds: 12,
    warmupSeconds: 0,
    physics: { mode: 'kinematic-v1' },
    metricSubject: 'ego',
    nearMissCriteria: [],
    actors: [
      {
        id: 'ego',
        kind: 'vehicle',
        dims: { l: 4.6, w: 1.9, h: 1.5 },
        initial: { pose: { x: 10, z: -5, headingRad: 0.25 }, speedMps: 2 },
        behavior: {
          route: { kind: 'polyline', points: [{ x: 10, z: -5 }, { x: 80, z: -5 }] },
        },
      },
    ],
    interactions: [
      {
        id: 'accelerate',
        actorId: 'ego',
        trigger: { kind: 'at', t: 1 },
        verb: 'speed',
        target: { mode: 'absolute', value: 6 },
        dynamics: { shape: 'linear', constraint: 'time', value: 2 },
      },
      {
        id: 'stop',
        actorId: 'ego',
        trigger: { kind: 'after', interactionId: 'accelerate', delayS: 1 },
        verb: 'speed',
        target: { mode: 'stop' },
        dynamics: { shape: 'step', constraint: 'time', value: 0.1 },
      },
    ],
    occluders: [
      {
        id: 'parked-van',
        obb: { center: { x: 25, z: -2 }, lengthM: 5, widthM: 2, heightM: 2.2, headingRad: 0 },
      },
    ],
  });
}

function extendedXmlFixture() {
  const base = fixture();
  return parseSimScenarioInput({
    ...base,
    interactions: [
      {
        id: 'change-lane',
        actorId: 'ego',
        trigger: { kind: 'at', t: 0.5 },
        verb: 'changeLane',
        target: { mode: 'left', count: 1 },
        dynamics: { shape: 'sinusoidal', constraint: 'time', value: 1.5 },
      },
      {
        id: 'replace-route',
        actorId: 'ego',
        trigger: { kind: 'after', interactionId: 'change-lane', delayS: 0 },
        verb: 'route',
        target: { kind: 'polyline', points: [{ x: 30, z: -5 }, { x: 60, z: -10 }] },
      },
      {
        id: 'conditional-stop',
        actorId: 'ego',
        trigger: {
          kind: 'when',
          condition: { kind: 'speed', actorId: 'ego', cmp: 'gte', value: 4 },
          byLatest: 4,
          ifNever: 'fire',
        },
        verb: 'speed',
        target: { mode: 'stop' },
        dynamics: { shape: 'step', constraint: 'time', value: 0.1 },
      },
      {
        id: 'remove-ego',
        actorId: 'ego',
        trigger: { kind: 'at', t: 10 },
        verb: 'exist',
        target: { state: 'absent' },
      },
    ],
    signalPrograms: [{
      id: 'main-signal',
      phases: [
        { phase: 'green', durationS: 6 },
        { phase: 'yellow', durationS: 2 },
        { phase: 'red', durationS: 6 },
      ],
      offsetS: 1,
      loop: true,
      mapBinding: {
        junctionId: 'junction-1',
        controllerIds: ['odr-controller-7'],
        headIds: ['odr-signal-11', 'odr-signal-12'],
        controllerHeadGroups: [{
          controllerId: 'odr-controller-7',
          headIds: ['odr-signal-11', 'odr-signal-12'],
        }],
        timingSource: 'authored',
      },
    }],
  });
}

function semanticActorXmlFixture() {
  const kinds = ['bicycle', 'scooter', 'motorcycle', 'bus', 'van', 'truck', 'animal'] as const;
  return parseSimScenarioInput({
    mapId: 'fixture-map',
    clipSeconds: 6,
    warmupSeconds: 0,
    actors: [
      ...kinds.map((kind, index) => ({
        id: kind,
        kind,
        initial: { pose: { x: index * 3, z: 0, headingRad: 0 }, speedMps: 1 },
        behavior: {
          route: { kind: 'polyline' as const, points: [{ x: index * 3, z: 0 }, { x: index * 3 + 20, z: 0 }] },
        },
      })),
      {
        id: 'cargo',
        kind: 'static_object' as const,
        static: true,
        initial: { pose: { x: 30, z: 0, headingRad: 0 }, speedMps: 0 },
        behavior: {
          route: { kind: 'polyline' as const, points: [{ x: 30, z: 0 }, { x: 31, z: 0 }] },
        },
      },
    ],
  });
}

function standardActionsXmlFixture() {
  const base = fixture();
  return parseSimScenarioInput({
    ...base,
    actors: [
      { ...base.actors[0]!, kind: 'car' },
      {
        id: 'lead',
        kind: 'car',
        initial: { pose: { x: 20, z: -5, headingRad: 0.25 }, speedMps: 2 },
        behavior: {
          route: { kind: 'polyline', points: [{ x: 20, z: -5 }, { x: 80, z: -5 }] },
        },
      },
    ],
    interactions: [
      {
        id: 'signal-left',
        actorId: 'ego',
        trigger: { kind: 'at', t: 0.5 },
        verb: 'set',
        target: { key: 'lights.indicator', value: 'left' },
      },
      {
        id: 'reverse-lamps',
        actorId: 'ego',
        trigger: { kind: 'after', interactionId: 'signal-left', delayS: 0 },
        verb: 'set',
        target: { key: 'lights.reverse', value: true },
      },
      {
        id: 'open-driver-door',
        actorId: 'ego',
        trigger: { kind: 'at', t: 1 },
        verb: 'set',
        target: { key: 'doors.left', value: 'opening' },
      },
      {
        id: 'step-offset',
        actorId: 'ego',
        trigger: { kind: 'at', t: 2 },
        verb: 'laneOffset',
        target: { mode: 'meters', value: 0.35 },
        dynamics: { shape: 'step', constraint: 'time', value: 0.1 },
      },
      {
        id: 'join-lead-lane',
        actorId: 'ego',
        trigger: { kind: 'at', t: 3 },
        verb: 'changeLane',
        target: { mode: 'actorLane', actorId: 'lead' },
        dynamics: { shape: 'sinusoidal', constraint: 'time', value: 1.5 },
      },
    ],
  });
}

describe('ASAM OpenSCENARIO XML 1.4.0 export', () => {
  it('exports robots and drones using valid pedestrian categories while preserving their exact kinds', () => {
    const base = fixture();
    const result = exportOpenScenarioXml14(parseSimScenarioInput({
      ...base,
      metricSubject: 'robot',
      actors: [
        {
          id: 'robot', kind: 'sidewalk_robot', dims: { l: 0.9, w: 0.7, h: 1.2 },
          tags: ['driver-profile:cautious'],
          initial: { pose: { x: 0, z: 0, headingRad: 0 }, speedMps: 0 },
          behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 0 }, { x: 2, z: 0 }] } },
        },
        {
          id: 'drone', kind: 'drone', dims: { l: 0.8, w: 0.8, h: 0.3 },
          initial: { pose: { x: 0, z: 2, headingRad: 0 }, speedMps: 0 },
          behavior: { route: { kind: 'polyline', points: [{ x: 0, z: 2 }, { x: 2, z: 2 }] } },
        },
      ],
      interactions: [],
      occluders: [],
    }), { graph, trustedAmbientActorIds: ['robot'] });

    expect(result.content).toContain('<Pedestrian name="uniscenarios_sidewalk_robot" mass="70" pedestrianCategory="pedestrian">');
    expect(result.content).toContain('<Property name="uniscenarios.actorKind" value="sidewalk_robot"/>');
    expect(result.content).toContain('<Property name="uniscenarios.driverProfile" value="cautious"/>');
    expect(result.content).toContain('<Property name="uniscenarios.actorOrigin" value="canonical-ambient"/>');
    expect(result.content).toContain('<Pedestrian name="uniscenarios_drone" mass="12" pedestrianCategory="pedestrian">');
    expect(result.content).toContain('<Property name="uniscenarios.actorKind" value="drone"/>');
  });

  it('preserves near-miss criterion metadata and states the OSC limitation', () => {
    const result = exportOpenScenarioXml14(fixture(), {
      graph,
      nearMissCriteria: [{ pedestrianId: 'challenger', targetId: 'ego', clearanceM: 0.5, toleranceM: 0.1, pass: 'front', planHash: 'deadbeef' }],
    });
    expect(result.content).toContain('uniscenarios.nearMiss.0.clearanceM');
    expect(result.content).toContain('value="0.5"');
    expect(result.content).toContain('uniscenarios.nearMiss.0.planHash');
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'near_miss_criterion_metadata' }));
  });
  it('exports the runtime-clamped effective lane-change duration', () => {
    const input = mappedLaneChangeFixture(1, 1);
    const simulation = runSimulation(input, { graph: laneGraph, guards: 'collect' });
    const planned = simulation.trace.events.find((event) => event.kind === 'lateral_maneuver_planned')!;
    expect(planned.effectiveDurationS).toBeGreaterThan(1);
    const result = exportOpenScenarioXml14(input, { graph: laneGraph, executionMode: 'actions' });
    const exported = /LaneChangeActionDynamics dynamicsShape="cubic" dynamicsDimension="time" value="([^"]+)"/.exec(result.content);
    expect(Number(exported?.[1])).toBeCloseTo(planned.effectiveDurationS, 9);
  });

  it('fails closed when a requested multi-lane target has no final neighbour', () => {
    expect(() => exportOpenScenarioXml14(mappedLaneChangeFixture(2, 6), { graph: laneGraph, executionMode: 'actions' })).toThrow(AsamExportError);
    try {
      exportOpenScenarioXml14(mappedLaneChangeFixture(2, 6), { graph: laneGraph, executionMode: 'actions' });
    } catch (error) {
      expect((error as AsamExportError).issues).toContainEqual(expect.objectContaining({ code: 'lane_change_target_unreachable' }));
    }
  });

  it('emits deterministic concrete entities, routes, dependency triggers, and stop time', () => {
    const result = exportOpenScenarioXml14(fixture(), { graph, roadFile: 'fixture.xodr' });
    expect(result.standard).toBe('ASAM OpenSCENARIO XML 1.4.0');
    expect(result.content).toContain('<FileHeader revMajor="1" revMinor="4"');
    expect(result.content).toContain('<LogicFile filepath="fixture.xodr"/>');
    expect(result.content).toContain('<ScenarioObject name="actor_ego">');
    expect(result.content).toContain('<MiscObject mass="1" name="uniscenarios_occluder"');
    expect(result.content).toContain('<Route name="route_ego" closed="false">');
    expect(result.content).toContain('storyboardElementRef="event_accelerate"');
    expect(result.content).toContain('storyboardElementType="event" state="completeState"');
    expect(result.content).toContain('<SimulationTimeCondition value="12" rule="greaterOrEqual"/>');
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'field_omitted',
      path: 'metricSubject',
    }));
    expect(exportOpenScenarioXml14(fixture(), { graph, roadFile: 'fixture.xodr' }).content).toBe(result.content);
  });

  it('reports every SimScenarioInput field and labels action export as editable semantic output', () => {
    const result = exportOpenScenarioXml14(fixture(), { graph });
    expect(result.profile).toBe('xml-1.4-actions');
    expect(result.intent).toBe('editable-semantic');
    expect(result.capabilityReport).toMatchObject({
      roundTrip: 'not-supported',
      externalSimulatorValidation: 'not-verified',
    });
    expect(result.capabilityReport.fields.map((entry) => entry.path).sort()).toEqual(
      [...Object.keys(fixture()), 'perception'].sort(),
    );
    expect(result.content).toContain('name="uniscenarios.export.intent" value="editable-semantic"');
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'field_omitted',
      path: 'operationalConditions',
    }));
  });

  it('labels trajectory export and reports flattened causal intent instead of implying editable equivalence', () => {
    const result = exportOpenScenarioXml14(fixture(), { graph, executionMode: 'trajectory-replay' });
    expect(result.profile).toBe('xml-1.4-trajectory-replay');
    expect(result.intent).toBe('trajectory-replay');
    expect(result.capabilityReport.fields).toContainEqual(expect.objectContaining({
      path: 'interactions',
      disposition: 'derived',
    }));
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'semantic_intent_flattened',
      path: 'interactions',
    }));
    expect(result.content).toContain('name="uniscenarios.export.intent" value="trajectory-replay"');
    expect(result.content).toContain('name="uniscenarios.physics.mode" value="kinematic-v1"');
    expect(result.content).toContain('name="uniscenarios.trajectoryReplay.physics.mode" value="kinematic-v1"');
  });

  it('exports the omitted-input dynamic default with its actual 5 ms substep', () => {
    const { physics: _physics, ...input } = fixture();
    const result = exportOpenScenarioXml14(input, { graph, executionMode: 'trajectory-replay' });
    expect(result.content).toContain('name="uniscenarios.physics.mode" value="dynamic-v1"');
    expect(result.content).toContain('name="uniscenarios.physics.substepS" value="0.005"');
    expect(result.content).toContain('name="uniscenarios.trajectoryReplay.physics.mode" value="dynamic-v1"');
    expect(result.content).toContain('name="uniscenarios.trajectoryReplay.physics.substepS" value="0.005"');
  });

  it('emits schema-shaped routes, lifecycle actions, conditions, and 1.4 signal semantics', () => {
    const content = exportOpenScenarioXml14(extendedXmlFixture(), { graph }).content;
    expect(content).toContain('<LaneChangeAction>');
    expect(content).toContain('<AssignRouteAction>');
    expect(content).toContain('<DeleteEntityAction/>');
    expect(content).toContain('<TrafficSignalController name="odr-controller-7">');
    expect(content).not.toContain('reference="odr-controller-7"');
    expect(content).toContain('<Phase name="green" duration="5" semantics="go">');
    expect(content).toContain('<Phase name="green__cycle_wrap" duration="1" semantics="go">');
    expect(content).toContain('<TrafficSignalState trafficSignalId="odr-signal-11" state="green"/>');
    expect(content).toContain('name="uniscenarios.signal.main-signal.timingSource" value="authored"');
    expect(content).toContain('name="uniscenarios.signal.main-signal.junctionId" value="junction-1"');
    expect(content).toContain('<SpeedCondition rule="greaterOrEqual" value="4"/>');
  });

  it('uses an ASAM clock origin at warm-up start without firing authored triggers during warm-up', () => {
    const base = fixture();
    const input = parseSimScenarioInput({
      ...base,
      warmupSeconds: 5,
      interactions: [{
        id: 'pre-roll-speed',
        actorId: 'ego',
        trigger: { kind: 'at', t: -3 },
        verb: 'speed',
        target: { mode: 'absolute', value: 3 },
        dynamics: { shape: 'step', constraint: 'time', value: 0.1 },
      }],
    });
    const content = exportOpenScenarioXml14(input, { graph }).content;
    // The engine evaluates authored interactions from recorded t=0 onward, so
    // a negative authored time fires at recorded t=0 (ASAM t=warmupSeconds).
    expect(content).toContain('<SimulationTimeCondition value="5" rule="greaterOrEqual"/>');
    expect(content).toContain('<SimulationTimeCondition value="17" rule="greaterOrEqual"/>');
  });

  it('exports deterministic timed trajectories instead of assuming simulator controller behavior', () => {
    const base = fixture();
    const input = parseSimScenarioInput({
      ...base,
      warmupSeconds: 2,
      actors: base.actors.map((actor) => ({
        ...actor,
        behavior: {
          ...actor.behavior,
          rules: { ...actor.behavior.rules, collisionAvoidance: false },
        },
      })),
    });
    const content = exportOpenScenarioXml14(input, { graph, executionMode: 'trajectory-replay' }).content;
    expect(content).toContain('name="uniscenarios.executionMode" value="trajectory-replay"');
    expect(content).toContain('<FollowTrajectoryAction>');
    expect(content).toContain('<Timing domainAbsoluteRelative="absolute" scale="1" offset="0"/>');
    expect(content).toContain('<TrajectoryFollowingMode followingMode="position"/>');
    expect(content).toContain('<Trajectory name="trajectory_ego" closed="false">');
    expect(content).toContain('<Vertex time="0">');
    expect(content).toContain('<Motion speed_longitudinal="');
    expect(content).not.toContain('<SpeedAction>');
    expect(content).toContain('<SimulationTimeCondition value="14" rule="greaterOrEqual"/>');
  });

  it('carries replay provenance in standard extension properties', () => {
    const content = exportOpenScenarioXml14(fixture(), {
      graph,
      executionMode: 'trajectory-replay',
      provenance: { templateDigest: 'abc123', drawIndex: 7 },
    }).content;
    expect(content).toContain('<Property name="uniscenarios.provenance.templateDigest" value="abc123"/>');
    expect(content).toContain('<Property name="uniscenarios.provenance.drawIndex" value="7"/>');
    expect(content).toContain('<Property name="uniscenarios.physics.actorBackends" value="ego:kinematic-v1:selected:vehicle"/>');
    expect(content).toContain('<Property name="uniscenarios.trajectoryReplay.physics.actorBackends" value="ego:kinematic-v1:selected:vehicle"/>');
  });

  it('binds signal conditions to the logical scenario controller', () => {
    const base = extendedXmlFixture();
    const input = parseSimScenarioInput({
      ...base,
      interactions: [{
        id: 'wait-for-red',
        actorId: 'ego',
        trigger: {
          kind: 'when',
          condition: { kind: 'signal', signalId: 'main-signal', phase: 'red' },
          byLatest: 4,
          ifNever: 'fire',
        },
        verb: 'speed',
        target: { mode: 'stop' },
        dynamics: { shape: 'step', constraint: 'time', value: 0.1 },
      }],
    });
    const content = exportOpenScenarioXml14(input, { graph }).content;
    expect(content).toContain('trafficSignalControllerRef="odr-controller-7" phase="red"');
    expect(content).not.toContain('trafficSignalControllerRef="signal_controller_main_signal"');
  });

  it('binds disjoint physical controller groups by name without self-references', () => {
    const base = extendedXmlFixture();
    const input = parseSimScenarioInput({
      ...base,
      signalPrograms: base.signalPrograms.map((program) => ({
        ...program,
        mapBinding: {
          ...program.mapBinding!,
          controllerIds: ['odr-controller-7', 'odr-controller-8'],
          controllerHeadGroups: [
            { controllerId: 'odr-controller-7', headIds: ['odr-signal-11'] },
            { controllerId: 'odr-controller-8', headIds: ['odr-signal-12'] },
          ],
        },
      })),
    });
    const content = exportOpenScenarioXml14(input, { graph }).content;
    expect(content.match(/<TrafficSignalController name="odr-controller-7">/g)).toHaveLength(1);
    expect(content.match(/<TrafficSignalController name="odr-controller-8">/g)).toHaveLength(1);
    expect(content).not.toMatch(/<TrafficSignalController[^>]+\breference=/);
    expect(content).not.toMatch(/<TrafficSignalController[^>]+\bdelay=/);
    expect(content).toContain('name="uniscenarios.signal.main-signal.controllerIds" value="odr-controller-7,odr-controller-8"');
    expect(content).toContain('name="uniscenarios.signal.main-signal.controllerHeadGroups" value="odr-controller-7:odr-signal-11;odr-controller-8:odr-signal-12"');
  });

  it('maps every engine control indication to its ASAM 1.4 semantic state', () => {
    const base = extendedXmlFixture();
    const phases = [
      ['green', 'go'],
      ['green_arrow', 'go'],
      ['proceed', 'go'],
      ['yellow', 'attention_stop'],
      ['yellow_arrow', 'attention_stop'],
      ['flashing_yellow', 'caution'],
      ['off', 'fallback'],
      ['red', 'stop'],
      ['flashing_red', 'stop'],
      ['red_x', 'stop'],
      ['stop', 'stop'],
    ] as const;
    const input = parseSimScenarioInput({
      ...base,
      signalPrograms: [{
        ...base.signalPrograms[0]!,
        phases: phases.map(([phase]) => ({ phase, durationS: 1 })),
        offsetS: 0,
      }],
    });
    const content = exportOpenScenarioXml14(input, { graph }).content;
    for (const [phase, semantics] of phases) {
      expect(content).toContain(`<Phase name="${phase}" duration="1" semantics="${semantics}">`);
    }
  });

  it('preserves semantic actor classes in XML entity categories', () => {
    const content = exportOpenScenarioXml14(semanticActorXmlFixture(), { graph }).content;
    expect(content).toContain('<Vehicle name="uniscenarios_bicycle" vehicleCategory="bicycle">');
    expect(content).toContain('<Vehicle name="uniscenarios_scooter" vehicleCategory="standupScooter">');
    expect(content).toContain('<Vehicle name="uniscenarios_motorcycle" vehicleCategory="motorcycle">');
    expect(content).toContain('<Vehicle name="uniscenarios_bus" vehicleCategory="bus">');
    expect(content).toContain('<Vehicle name="uniscenarios_van" vehicleCategory="van">');
    expect(content).toContain('<Vehicle name="uniscenarios_truck" vehicleCategory="heavyTruck">');
    expect(content).toContain('<Pedestrian name="uniscenarios_animal" mass="40" pedestrianCategory="animal">');
    expect(content).toContain('<MiscObject mass="1" name="uniscenarios_static_object" miscObjectCategory="obstacle">');
    expect(content).not.toContain('<Route name="route_cargo"');
  });

  it('uses standard 1.4 appearance and lateral actions when their semantics close exactly', () => {
    const content = exportOpenScenarioXml14(standardActionsXmlFixture(), { graph }).content;
    expect(content).toContain('<VehicleLight vehicleLightType="indicatorLeft"/>');
    expect(content).toContain('<LightState mode="flashing" flashingOnDuration="0.5" flashingOffDuration="0.5"/>');
    expect(content).toContain('<VehicleLight vehicleLightType="reversingLights"/>');
    expect(content).toContain('<VehicleComponent vehicleComponentType="doorFrontLeft"/>');
    expect(content).toContain('<AnimationState state="1"/>');
    expect(content).toContain('<LaneOffsetAction continuous="false">');
    expect(content).toContain('<AbsoluteTargetLaneOffset value="0.35"/>');
    expect(content).toContain('<RelativeTargetLane entityRef="actor_lead" value="0"/>');
  });
});

describe('ASAM OpenSCENARIO DSL 2.2.0 export', () => {
  it('emits the official import, concrete geometry, absolute schedules, and typed units', () => {
    const result = exportOpenScenarioDsl22(fixture(), { graph, roadFile: 'fixture.xodr' });
    expect(result.standard).toBe('ASAM OpenSCENARIO DSL 2.2.0');
    expect(result.profile).toBe('dsl-2.2-actions');
    expect(result.intent).toBe('editable-semantic');
    expect(result.capabilityReport.fields.map((entry) => entry.path).sort()).toEqual(
      [...Object.keys(fixture()), 'perception'].sort(),
    );
    expect(result.capabilityReport.roundTrip).toBe('not-supported');
    expect(result.capabilityReport.externalSimulatorValidation).toBe('not-verified');
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'field_omitted',
      path: 'operationalConditions',
    }));
    expect(result.content).toContain('import osc.standard');
    expect(result.content).toContain('scenario uniscenarios_instance:');
    expect(result.content).toContain('# uniscenarios.physics.actorBackends=ego:kinematic-v1:selected:vehicle');
    expect(result.content).toContain('actor_ego: vehicle with:');
    expect(result.content).toContain('route_ego_pose_0: pose_3d with:');
    expect(result.content).toContain('route_ego: path = map_ref.create_path(points: [route_ego_pose_0');
    expect(result.content).not.toContain(': path = path(');
    expect(result.content).not.toMatch(/pose_3d\(/);
    expect(result.content).toContain('actor_ego.change_speed(target: 6mps, rate_profile: constant, rate_peak: 2mpss)');
    expect(result.content).toContain('wait elapsed(4s)');
    expect(result.content).toContain('actor_ego.assign_speed(speed: 0mps)');
    expect(result.content).toContain('occluder_parked_van.location(pose: occluder_pose_parked_van)');
  });

  it('carries replay provenance in comments without changing the grammar', () => {
    const content = exportOpenScenarioDsl22(fixture(), {
      graph,
      provenance: { templateDigest: 'abc123', drawIndex: 7 },
    }).content;
    expect(content).toContain('# uniscenarios.provenance.templateDigest=abc123');
    expect(content).toContain('# uniscenarios.provenance.drawIndex=7');
  });

  it('preserves every concrete semantic actor class supported by the 2.2 domain model', () => {
    const content = exportOpenScenarioDsl22(semanticActorXmlFixture(), { graph }).content;
    expect(content).toContain('actor_bicycle: vehicle with:\n        keep(it.vehicle_category == bicycle)');
    expect(content).toContain('actor_scooter: vehicle with:\n        keep(it.vehicle_category == stand_up_scooter)');
    expect(content).toContain('actor_motorcycle: vehicle with:\n        keep(it.vehicle_category == motorcycle)');
    expect(content).toContain('actor_bus: vehicle with:\n        keep(it.vehicle_category == bus)');
    expect(content).toContain('actor_van: vehicle with:\n        keep(it.vehicle_category == van)');
    expect(content).toContain('actor_truck: vehicle with:\n        keep(it.vehicle_category == heavy_truck)');
    expect(content).toContain('actor_animal: animal with:');
    expect(content).toContain('actor_cargo: stationary_object with:');
    expect(content).toContain('actor_cargo.location(pose: initial_pose_cargo)');
    expect(content).not.toContain('route_cargo: path');
    expect(validateOpenScenarioDsl22ProfileSyntax(content)).toEqual([]);
  });
});

describe('honest unsupported-feature failures', () => {
  it('fails closed for omitted props, action-mode road controls, and action-mode ambient semantics', () => {
    const input = parseSimScenarioInput({
      ...fixture(),
      operationalConditions: {
        weather: 'rain', timeOfDay: 'night', traffic: 'heavy', visibility: 'reduced-contrast',
        effects: { visibilityRangeM: 100, frictionScale: 0.7, trafficSpeedFactor: 0.8 },
      },
      roadControls: [{
        id: 'stop-control', kind: 'stop', dwellS: 1,
        stopLines: [{ rsl: '1:0:-1', s: 10, connectingLaneRsls: [] }],
      }],
      props: [{
        id: 'barrier', catalogId: 'construction.jersey_barrier',
        pose: { x: 20, z: -5, headingRad: 0 }, dims: { l: 4, w: 0.6, h: 0.8 },
        scale: 1, collidable: true, essentiality: 'required',
      }],
    });
    for (const executionMode of ['actions', 'trajectory-replay'] as const) {
      try {
        exportOpenScenarioXml14(input, { graph, executionMode });
        throw new Error('expected export to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(AsamExportError);
        expect((error as AsamExportError).issues).toEqual(expect.arrayContaining([
          expect.objectContaining({ code: 'unsupported_prop', path: 'props.0' }),
          ...(executionMode === 'actions'
            ? [
                expect.objectContaining({ code: 'unsupported_road_control', path: 'roadControls.0' }),
                expect.objectContaining({ code: 'unsupported_operational_conditions', path: 'operationalConditions' }),
              ]
            : []),
        ]));
      }
    }
  });

  it('bakes static road-control outcomes into XML 1.4 trajectory replay', () => {
    const input = parseSimScenarioInput({
      mapId: 'lane-export-fixture', clipSeconds: 12, warmupSeconds: 0, dt: 0.02,
      physics: { mode: 'kinematic-v1' }, metricSubject: 'ego',
      actors: [{
        id: 'ego', kind: 'vehicle', dims: { l: 4.5, w: 1.9, h: 1.5 },
        initial: { laneRef: { rsl: '1:0:-1', s: 10, tFrac: 0 }, pose: { x: 10, z: 0, headingRad: 0 }, speedMps: 5 },
        behavior: { route: { kind: 'lanePath', lanes: ['1:0:-1'] }, cruiseSpeedMps: 5 },
      }],
      roadControls: [{
        id: 'stop-control', kind: 'stop', dwellS: 1,
        stopLines: [{ rsl: '1:0:-1', s: 30, connectingLaneRsls: [] }],
      }],
    });

    const result = exportOpenScenarioXml14(input, {
      graph: laneGraph,
      executionMode: 'trajectory-replay',
    });
    const speeds = [...result.content.matchAll(/<Motion speed_longitudinal="([^"]+)"\/>/g)]
      .map((match) => Number(match[1]));

    expect(speeds.length).toBeGreaterThan(100);
    expect(speeds.some((speed) => Math.abs(speed) < 1e-6)).toBe(true);
    expect(result.capabilityReport.fields).toContainEqual(expect.objectContaining({
      path: 'roadControls',
      disposition: 'derived',
      fidelity: 'approximate',
    }));
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'semantic_intent_flattened',
      path: 'roadControls',
    }));
  });

  it('reports exact paths instead of silently degrading controller semantics', () => {
    const input = fixture();
    const changed = parseSimScenarioInput({
      ...input,
      actors: input.actors.map((actor) => ({
        ...actor,
        behavior: { ...actor.behavior, rules: { ...actor.behavior.rules, obeySignals: false } },
      })),
    });
    expect(() => exportOpenScenarioXml14(changed, { graph })).toThrowError(AsamExportError);
    try {
      exportOpenScenarioXml14(changed, { graph });
    } catch (error) {
      expect((error as AsamExportError).issues).toEqual([
        expect.objectContaining({ code: 'unsupported_controller_rules', path: 'actors.0.behavior.rules' }),
      ]);
    }
  });

  it('rejects DSL traffic-signal programs without concrete map group bindings', () => {
    const input = parseSimScenarioInput({
      ...fixture(),
      signalPrograms: [{
        id: 'main-signal',
        phases: [{ phase: 'green', durationS: 10 }, { phase: 'red', durationS: 10 }],
      }],
    });
    try {
      exportOpenScenarioDsl22(input, { graph });
      throw new Error('expected export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AsamExportError);
      expect((error as AsamExportError).issues).toEqual([
        expect.objectContaining({ code: 'unsupported_signal_program', path: 'signalPrograms' }),
      ]);
    }
  });

  it('rejects XML signal programs without an unambiguous physical controller binding', () => {
    const input = parseSimScenarioInput({
      ...fixture(),
      signalPrograms: [{
        id: 'main-signal',
        phases: [{ phase: 'green', durationS: 10 }, { phase: 'red', durationS: 10 }],
      }],
    });
    try {
      exportOpenScenarioXml14(input, { graph });
      throw new Error('expected export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AsamExportError);
      expect((error as AsamExportError).issues).toEqual([
        expect.objectContaining({ code: 'missing_signal_map_binding', path: 'signalPrograms.0.mapBinding' }),
      ]);
    }
  });

  it('exports bounded authored controller clips exactly in trajectory replay and fails closed in action mode', () => {
    const base = extendedXmlFixture();
    const input = parseSimScenarioInput({
      ...base,
      signalPrograms: base.signalPrograms.map((program) => ({
        ...program,
        phases: [{ phase: 'green' as const, durationS: 3 }, { phase: 'red' as const, durationS: 9.000001 }],
        offsetS: 0,
        loop: false,
        mapBinding: { ...program.mapBinding!, timingSource: 'authored' as const },
      })),
    });
    const replay = exportOpenScenarioXml14(input, { graph, executionMode: 'trajectory-replay' });
    expect(replay.content).toContain('<TrafficSignalStateAction name="odr-signal-11" state="green"/>');
    expect(replay.content).toContain('<TrafficSignalStateAction name="odr-signal-11" state="red"/>');
    try {
      exportOpenScenarioXml14(input, { graph, executionMode: 'actions' });
      throw new Error('expected export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AsamExportError);
      expect((error as AsamExportError).issues).toContainEqual(expect.objectContaining({
        code: 'unsupported_authored_signal_timeline',
        path: 'signalPrograms.0.loop',
      }));
    }
  });

  it('rejects a flat signal binding that cannot assign heads to multiple controllers', () => {
    const base = extendedXmlFixture();
    const input = parseSimScenarioInput({
      ...base,
      signalPrograms: base.signalPrograms.map((program) => ({
        ...program,
        mapBinding: {
          ...program.mapBinding!,
          controllerIds: ['odr-controller-7', 'odr-controller-8'],
          controllerHeadGroups: undefined,
        },
      })),
    });
    try {
      exportOpenScenarioXml14(input, { graph });
      throw new Error('expected export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AsamExportError);
      expect((error as AsamExportError).issues).toEqual([
        expect.objectContaining({
          code: 'missing_signal_controller_head_groups',
          path: 'signalPrograms.0.mapBinding.controllerHeadGroups',
        }),
      ]);
    }
  });

  it('rejects persistent signal overrides instead of substituting a phase jump', () => {
    const base = extendedXmlFixture();
    const input = parseSimScenarioInput({
      ...base,
      interactions: [{
        id: 'set-red',
        actorId: 'ego',
        trigger: { kind: 'at', t: 2 },
        verb: 'set',
        target: { key: 'signal:main-signal.phase', value: 'red' },
      }],
    });
    try {
      exportOpenScenarioXml14(input, { graph });
      throw new Error('expected export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AsamExportError);
      expect((error as AsamExportError).issues).toEqual([
        expect.objectContaining({ code: 'unsupported_set_action', path: 'interactions.set-red.target.key' }),
      ]);
    }
  });

  it('preserves pose state with the standard user-defined animation carrier and an explicit warning', () => {
    const base = fixture();
    const input = parseSimScenarioInput({
      ...base,
      interactions: [{
        id: 'look-left',
        actorId: 'ego',
        trigger: { kind: 'at', t: 1 },
        verb: 'set',
        target: { key: 'pose.headingLookDeg', value: -90 },
      }],
    });
    const result = exportOpenScenarioXml14(input, { graph });
    expect(result.content).toContain('userDefinedAnimationType="simforge:pose.headingLookDeg:-90"');
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'user_defined_animation',
      path: 'interactions.look-left.target.key',
    }));
  });

  it('rejects state with no exact standard or declared user-defined carrier', () => {
    const base = fixture();
    const input = parseSimScenarioInput({
      ...base,
      interactions: [{
        id: 'change-friction',
        actorId: 'ego',
        trigger: { kind: 'at', t: 1 },
        verb: 'set',
        target: { key: 'env.frictionScale', value: 0.7 },
      }],
    });
    try {
      exportOpenScenarioXml14(input, { graph, executionMode: 'trajectory-replay' });
      throw new Error('expected export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AsamExportError);
      expect((error as AsamExportError).issues).toEqual([
        expect.objectContaining({ code: 'unsupported_set_action', path: 'interactions.change-friction.target.key' }),
      ]);
    }
  });

  it('rejects a phase-name condition when an offset splits that phase at the cycle boundary', () => {
    const base = extendedXmlFixture();
    const input = parseSimScenarioInput({
      ...base,
      interactions: [{
        id: 'wait-for-green',
        actorId: 'ego',
        trigger: {
          kind: 'when',
          condition: { kind: 'signal', signalId: 'main-signal', phase: 'green' },
          byLatest: 4,
          ifNever: 'fire',
        },
        verb: 'speed',
        target: { mode: 'stop' },
        dynamics: { shape: 'step', constraint: 'time', value: 0.1 },
      }],
    });
    try {
      exportOpenScenarioXml14(input, { graph });
      throw new Error('expected export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AsamExportError);
      expect((error as AsamExportError).issues).toEqual([
        expect.objectContaining({ code: 'unsupported_offset_signal_condition', path: 'signalPrograms.0.offsetS' }),
      ]);
    }
  });

  it('rejects duplicate physical signal-head ownership', () => {
    const base = extendedXmlFixture();
    const original = base.signalPrograms[0]!;
    const input = parseSimScenarioInput({
      ...base,
      signalPrograms: [
        original,
        {
          ...original,
          id: 'second-signal',
          mapBinding: {
            ...original.mapBinding!,
            controllerIds: ['odr-controller-8'],
            headIds: ['odr-signal-12'],
            controllerHeadGroups: [{ controllerId: 'odr-controller-8', headIds: ['odr-signal-12'] }],
          },
        },
      ],
    });
    try {
      exportOpenScenarioXml14(input, { graph });
      throw new Error('expected export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AsamExportError);
      expect((error as AsamExportError).issues).toEqual([
        expect.objectContaining({
          code: 'duplicate_signal_head_binding',
          path: 'signalPrograms.1.mapBinding.headIds.0',
        }),
      ]);
    }
  });

  it('rejects one physical signal head being assigned to multiple controller groups', () => {
    const base = extendedXmlFixture();
    const input = parseSimScenarioInput({
      ...base,
      signalPrograms: base.signalPrograms.map((program) => ({
        ...program,
        mapBinding: {
          ...program.mapBinding!,
          controllerIds: ['odr-controller-7', 'odr-controller-8'],
          controllerHeadGroups: [
            { controllerId: 'odr-controller-7', headIds: ['odr-signal-11', 'odr-signal-12'] },
            { controllerId: 'odr-controller-8', headIds: ['odr-signal-12'] },
          ],
        },
      })),
    });
    expect(() => exportOpenScenarioXml14(input, { graph })).toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({
        code: 'duplicate_signal_group_membership',
        path: 'signalPrograms.0.mapBinding.controllerHeadGroups.1.headIds.0',
      })],
    }));
  });

  it('rejects one physical controller being defined by two logical programs', () => {
    const base = extendedXmlFixture();
    const original = base.signalPrograms[0]!;
    const input = parseSimScenarioInput({
      ...base,
      signalPrograms: [
        original,
        {
          ...original,
          id: 'second-signal',
          mapBinding: {
            ...original.mapBinding!,
            controllerIds: ['odr-controller-7'],
            headIds: ['odr-signal-13'],
            controllerHeadGroups: [{ controllerId: 'odr-controller-7', headIds: ['odr-signal-13'] }],
          },
        },
      ],
    });
    expect(() => exportOpenScenarioXml14(input, { graph })).toThrowError(expect.objectContaining({
      issues: [expect.objectContaining({
        code: 'duplicate_signal_controller_binding',
        path: 'signalPrograms.1.mapBinding.controllerHeadGroups.0.controllerId',
      })],
    }));
  });

  it('rejects signal conditions whose program or phase does not exist', () => {
    const base = extendedXmlFixture();
    const condition = (signalId: string, phase: 'green' | 'yellow' | 'red') => parseSimScenarioInput({
      ...base,
      interactions: [{
        id: 'conditioned-stop',
        actorId: 'ego',
        trigger: {
          kind: 'when',
          condition: { kind: 'signal', signalId, phase },
          byLatest: 4,
          ifNever: 'fire',
        },
        verb: 'speed',
        target: { mode: 'stop' },
        dynamics: { shape: 'step', constraint: 'time', value: 0.1 },
      }],
    });
    expect(() => exportOpenScenarioXml14(condition('missing', 'red'), { graph })).toThrowError(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'unknown_signal_program' })] }),
    );
    const greenOnly = parseSimScenarioInput({
      ...condition('main-signal', 'red'),
      signalPrograms: [{ ...base.signalPrograms[0]!, phases: [{ phase: 'green', durationS: 10 }], offsetS: 0 }],
    });
    expect(() => exportOpenScenarioXml14(greenOnly, { graph })).toThrowError(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'unknown_signal_phase' })] }),
    );
  });

  it('rejects controller yield switches that XML cannot preserve', () => {
    const base = fixture();
    const input = parseSimScenarioInput({
      ...base,
      actors: base.actors.map((actor) => ({
        ...actor,
        behavior: {
          ...actor.behavior,
          rules: { ...actor.behavior.rules, yieldToPedestrians: false },
        },
      })),
    });
    try {
      exportOpenScenarioXml14(input, { graph });
      throw new Error('expected export to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AsamExportError);
      expect((error as AsamExportError).issues[0]).toEqual(expect.objectContaining({
        code: 'unsupported_controller_rules',
        reason: expect.stringContaining('yieldToPedestrians'),
      }));
    }
  });

  it('requires trajectory replay for reverse motion and rejects reverse DSL controller substitution', () => {
    const base = fixture();
    const reverse = parseSimScenarioInput({
      ...base,
      actors: base.actors.map((actor) => ({ ...actor, tags: ['motion:reverse'] })),
    });
    expect(() => exportOpenScenarioXml14(reverse, { graph })).toThrowError(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'unsupported_reverse_motion' })] }),
    );
    expect(() => exportOpenScenarioDsl22(reverse, { graph })).toThrowError(
      expect.objectContaining({ issues: [expect.objectContaining({ code: 'unsupported_reverse_motion' })] }),
    );
    const replay = exportOpenScenarioXml14(reverse, { graph, executionMode: 'trajectory-replay' }).content;
    expect(replay).toContain('speed_longitudinal="-');
  });

  it('rejects static-object motion actions and replays standard appearance actions at their fired times', () => {
    const semantic = semanticActorXmlFixture();
    const movingStatic = parseSimScenarioInput({
      ...semantic,
      interactions: [{
        id: 'move-cargo',
        actorId: 'cargo',
        trigger: { kind: 'at', t: 1 },
        verb: 'speed',
        target: { mode: 'absolute', value: 2 },
        dynamics: { shape: 'step', constraint: 'time', value: 0.1 },
      }],
    });
    for (const exportScenario of [exportOpenScenarioXml14, exportOpenScenarioDsl22]) {
      expect(() => exportScenario(movingStatic, { graph })).toThrowError(
        expect.objectContaining({ issues: [expect.objectContaining({ code: 'unsupported_static_actor_action' })] }),
      );
    }
    const replay = exportOpenScenarioXml14(standardActionsXmlFixture(), {
      graph,
      executionMode: 'trajectory-replay',
    }).content;
    expect(replay).toContain('<VehicleLight vehicleLightType="indicatorLeft"/>');
    expect(replay).toContain('<VehicleLight vehicleLightType="reversingLights"/>');
    expect(replay).toContain('<VehicleComponent vehicleComponentType="doorFrontLeft"/>');
    expect(replay).toContain('name="signal-left_replay"');
    expect(replay).not.toContain('<SpeedAction>');
  });

  it('does not attach car doors or reverse lamps to vulnerable road-user vehicles', () => {
    const semantic = semanticActorXmlFixture();
    for (const [id, key, value] of [
      ['bicycle-door', 'doors.left', 'opening'],
      ['scooter-reverse', 'lights.reverse', true],
    ] as const) {
      const input = parseSimScenarioInput({
        ...semantic,
        interactions: [{
          id,
          actorId: id.startsWith('bicycle') ? 'bicycle' : 'scooter',
          trigger: { kind: 'at', t: 1 },
          verb: 'set',
          target: { key, value },
        }],
      });
      expect(() => exportOpenScenarioXml14(input, { graph })).toThrowError(expect.objectContaining({
        issues: [expect.objectContaining({ code: 'unsupported_appearance_actor' })],
      }));
    }
  });
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function acquireOfficialXml14Xsd(dir: string): Promise<string> {
  const override = process.env['ASAM_OPENSCENARIO_14_XSD'];
  if (override && existsSync(override)) {
    const bytes = await readFile(override);
    expect(sha256(bytes), 'ASAM_OPENSCENARIO_14_XSD is not the pinned official 1.4.0 schema').toBe(
      OFFICIAL_OPENSCENARIO_140_XSD.xsdSha256,
    );
    return override;
  }

  const response = await fetch(OFFICIAL_OPENSCENARIO_140_XSD.url);
  expect(response.ok, `failed to fetch official ASAM schema: HTTP ${response.status}`).toBe(true);
  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  expect(sha256(archiveBytes), 'official ASAM 1.4.0 schema archive checksum changed').toBe(
    OFFICIAL_OPENSCENARIO_140_XSD.archiveSha256,
  );
  const archive = path.join(dir, 'ASAM_OpenSCENARIO_v1.4.0_Schema.zip');
  await writeFile(archive, archiveBytes);
  const unzip = await execa('unzip', ['-q', archive, '-d', dir], { reject: false });
  expect(unzip.exitCode, unzip.stderr).toBe(0);
  const xsd = path.join(dir, 'OpenSCENARIO.xsd');
  expect(sha256(await readFile(xsd)), 'extracted official ASAM 1.4.0 XSD checksum mismatch').toBe(
    OFFICIAL_OPENSCENARIO_140_XSD.xsdSha256,
  );
  return xsd;
}

describe('official ASAM XML 1.4.0 schema', () => {
  let dir = '';
  let officialXsd = '';
  beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'simforge-asam-')); });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('validates the generated .xosc with the official XSD deliverable', async () => {
    officialXsd = await acquireOfficialXml14Xsd(dir);
    for (const [name, input] of [
      ['fixture', fixture()],
      ['extended', extendedXmlFixture()],
      ['semantic-actors', semanticActorXmlFixture()],
      ['standard-actions', standardActionsXmlFixture()],
    ] as const) {
      const file = path.join(dir, `${name}.xosc`);
      await writeFile(file, exportOpenScenarioXml14(input, { graph }).content, 'utf8');
      const result = await validateOpenScenarioXml14(await readFile(file, 'utf8'), officialXsd!);
      expect(result.valid, result.diagnostics.join('\n')).toBe(true);
    }
    const replayFile = path.join(dir, 'trajectory-replay.xosc');
    await writeFile(
      replayFile,
      exportOpenScenarioXml14(fixture(), { graph, executionMode: 'trajectory-replay' }).content,
      'utf8',
    );
    const replayResult = await validateOpenScenarioXml14(await readFile(replayFile, 'utf8'), officialXsd!);
    expect(replayResult.valid, replayResult.diagnostics.join('\n')).toBe(true);

    const appearanceReplayFile = path.join(dir, 'trajectory-replay-appearance.xosc');
    await writeFile(
      appearanceReplayFile,
      exportOpenScenarioXml14(standardActionsXmlFixture(), { graph, executionMode: 'trajectory-replay' }).content,
      'utf8',
    );
    const appearanceReplayResult = await validateOpenScenarioXml14(await readFile(appearanceReplayFile, 'utf8'), officialXsd!);
    expect(appearanceReplayResult.valid, appearanceReplayResult.diagnostics.join('\n')).toBe(true);

    const hostile = await validateOpenScenarioXml14(
      '<!DOCTYPE OpenSCENARIO [<!ENTITY secret SYSTEM "file:///etc/passwd">]><OpenSCENARIO>&secret;</OpenSCENARIO>',
      officialXsd!,
    );
    expect(hostile).toMatchObject({ valid: false, diagnostics: [expect.stringContaining('forbidden')] });
  }, 60_000);
});

const OFFICIAL_DSL_22_GRAMMAR = {
  url: 'https://publications.pages.asam.net/standards/ASAM_OpenSCENARIO/ASAM_OpenSCENARIO_DSL/v2.2.0/language-reference/_attachments/grammar.ebnf',
  sha256: '77acf08e7a8a9f424358452d4f955e4dcd15636468aba7b18ba644ce9edc619b',
} as const;
const OFFICIAL_DSL_22_DOMAIN = {
  url: 'https://publications.pages.asam.net/standards/ASAM_OpenSCENARIO/ASAM_OpenSCENARIO_DSL/v2.2.0/domain-model/_attachments/ASAM_OpenSCENARIO_DSL_v2.2.0_Domain_model_library.zip',
  sha256: 'b18ee980a48b9e71db8612b846f04be10dfba4cbb82944a48806078721879fa3',
} as const;

describe('pinned ASAM OpenSCENARIO DSL 2.2.0 grammar profile', () => {
  it('pins the official grammar and parses every generated fixture without an optional checker', async () => {
    const response = await fetch(OFFICIAL_DSL_22_GRAMMAR.url);
    expect(response.ok, `failed to fetch official ASAM DSL grammar: HTTP ${response.status}`).toBe(true);
    const grammar = new Uint8Array(await response.arrayBuffer());
    expect(sha256(grammar), 'official ASAM DSL 2.2 grammar checksum changed').toBe(OFFICIAL_DSL_22_GRAMMAR.sha256);
    const grammarText = new TextDecoder().decode(grammar);
    for (const production of [
      'import-statement ::=',
      'scenario-declaration ::=',
      'keep-constraint-declaration ::=',
      'composition ::=',
      'behavior-invocation ::=',
      'modifier-application ::=',
      'wait-directive ::=',
    ]) expect(grammarText).toContain(production);

    for (const input of [fixture(), semanticActorXmlFixture()]) {
      const content = exportOpenScenarioDsl22(input, { graph }).content;
      expect(validateOpenScenarioDsl22ProfileSyntax(content)).toEqual([]);
      expect(() => assertOpenScenarioDsl22ProfileSyntax(content)).not.toThrow();
    }
  }, 60_000);

  it('reports deterministic line diagnostics for malformed generated-profile syntax', () => {
    const malformed = exportOpenScenarioDsl22(fixture(), { graph }).content
      .replace('scenario uniscenarios_instance:', 'scenario uniscenarios_instance')
      .replace('        serial:', '       serial:');
    expect(validateOpenScenarioDsl22ProfileSyntax(malformed)).toEqual(expect.arrayContaining([
      expect.objectContaining({ line: 11, reason: expect.stringContaining('outside the generated') }),
      expect.objectContaining({ reason: 'indentation must use four-space levels' }),
    ]));
  });

  it('pins the official 2.2 domain library symbols used by the semantic export profile', async () => {
    const response = await fetch(OFFICIAL_DSL_22_DOMAIN.url);
    expect(response.ok, `failed to fetch official ASAM DSL domain library: HTTP ${response.status}`).toBe(true);
    const archiveBytes = new Uint8Array(await response.arrayBuffer());
    expect(sha256(archiveBytes), 'official ASAM DSL 2.2 domain library checksum changed').toBe(OFFICIAL_DSL_22_DOMAIN.sha256);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'simforge-osc-domain-'));
    try {
      const archive = path.join(dir, 'domain.zip');
      await writeFile(archive, archiveBytes);
      const unzip = await execa('unzip', ['-q', archive, '-d', dir], { reject: false });
      expect(unzip.exitCode, unzip.stderr).toBe(0);
      const domain = await readFile(path.join(dir, 'domain.osc'), 'utf8');
      for (const declaration of [
        'actor vehicle inherits traffic_participant:',
        'actor person inherits traffic_participant',
        'actor animal inherits traffic_participant',
        'actor stationary_object inherits physical_object',
        'modifier stationary_object.location:',
        'action movable_object.assign_position',
        'action movable_object.assign_orientation',
        'action movable_object.assign_speed',
        'action movable_object.change_speed',
        'action movable_object.follow_path',
        'action vehicle.change_lane',
      ]) expect(domain).toContain(declaration);
      for (const category of ['car', 'bus', 'heavy_truck', 'van', 'motorcycle', 'bicycle', 'stand_up_scooter']) {
        expect(domain).toMatch(new RegExp(`\\b${category},`));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
