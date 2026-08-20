import { describe, expect, it } from 'vitest';
import { DashCameraSensorSchema, dashCameras, type ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import { simulationSourceHash } from './recovery';

function template(): ScenarioTemplateV2 {
  return {
    meta: { name: 'Ambulance response', negativeControl: false },
    params: { declarations: [], constraints: [] },
    environment: { weather: 'clear', timeOfDay: 'noon' },
    anchor: { id: 'source-scene', features: [] },
    roles: [{
      id: 'ambulance', kind: 'scene_absolute', label: 'Ambulance',
      actor: {
        class: 'car', static: false, catalogId: 'vehicle.ambulance',
        dims: { length: 6.1, width: 2.1, height: 2.65 }, sensors: [],
      },
      pose: { position: { x: 1, y: 0, z: 2 }, headingRad: 0 },
      extensions: { 'studio.presentation.bodyColor': '#ffffff' },
    }],
    props: [],
    trafficControls: [],
    mapSignalPlans: [],
    choreography: { warmupSeconds: 0, clipSeconds: 20, interactions: [] },
  } as unknown as ScenarioTemplateV2;
}

describe('verified materialization recovery identity', () => {
  it('ignores dash cameras and appearance while retaining physical behavior fields', () => {
    const baseline = template();
    const decorated = template();
    decorated.roles[0]!.label = 'Response unit';
    decorated.roles[0]!.actor.catalogId = 'vehicle.van';
    decorated.roles[0]!.actor.sensors = [DashCameraSensorSchema.parse({
      id: 'dash-1', type: 'dash_camera', enabled: true,
      mount: { position: { x: 2, y: 1.5, z: 0 }, rotation: { yawRad: 0, pitchRad: 0, rollRad: 0 } },
      camera: { horizontalFovDeg: 90, aspectRatio: 16 / 9, nearM: 0.05, farM: 2_000 },
    })];
    decorated.roles[0]!.extensions = { 'studio.presentation.bodyColor': '#ff0000' };
    decorated.extensions = {
      'studio.presentation.cameras.v1': { cameras: [{ id: 'dash-1' }] },
      'studio.presentation.timeline.v1': { lanes: { ambulance: 2 } },
    };
    expect(simulationSourceHash(decorated)).toBe(simulationSourceHash(baseline));
    expect(dashCameras(decorated.roles[0]!.actor).map((camera) => camera.id)).toEqual(['dash-1']);

    decorated.roles[0]!.actor.dims!.length = 7;
    expect(simulationSourceHash(decorated)).not.toBe(simulationSourceHash(baseline));
  });

  it('invalidates verified evidence for signal phase edits and exact-controller rebinds', () => {
    const baseline = template();
    baseline.mapSignalPlans = [{
      id: 'junction-j1',
      version: 1,
      binding: { mapId: 'yale', junctionId: 'j1', controlDigest: 'controls-1' },
      clips: [{
        id: 'phase-1', startS: 2, endS: 5, indication: 'green',
        reference: { controllerId: 'controller-1', headId: 'head-1' },
      }],
    }];

    const phaseEdit = structuredClone(baseline);
    phaseEdit.mapSignalPlans[0]!.clips[0]!.indication = 'yellow';
    expect(simulationSourceHash(phaseEdit)).not.toBe(simulationSourceHash(baseline));

    const controllerRebind = structuredClone(baseline);
    controllerRebind.mapSignalPlans[0]!.clips[0]!.reference.controllerId = 'controller-2';
    expect(simulationSourceHash(controllerRebind)).not.toBe(simulationSourceHash(baseline));
  });

  it('tracks the complete execution input, including environment, controls, and behavior extensions', () => {
    const baseline = template();

    const environmentEdit = structuredClone(baseline);
    environmentEdit.environment = { weather: 'heavy_rain', timeOfDay: 'noon', frictionScale: 0.72, surfacePatches: [] };
    expect(simulationSourceHash(environmentEdit)).not.toBe(simulationSourceHash(baseline));

    const controlEdit = structuredClone(baseline);
    controlEdit.trafficControls = [{
      id: 'reversible-west', kind: 'lane_control',
      pose: { s: 0, laneOffset: 0, tFrac: 0, headingOffsetRad: 0 },
      stopLines: [{ pose: { s: -5, laneOffset: 0, tFrac: 0, headingOffsetRad: 0 } }],
      phases: [{ indication: 'red_x', durationS: 5 }],
      offsetS: 0, loop: false, darkFallback: 'all_way_stop', darkDwellS: 1,
    }];
    expect(simulationSourceHash(controlEdit)).not.toBe(simulationSourceHash(baseline));

    const behaviorExtension = structuredClone(baseline);
    behaviorExtension.roles[0]!.extensions = {
      ...behaviorExtension.roles[0]!.extensions,
      motionSemantics: 'reverse',
    };
    expect(simulationSourceHash(behaviorExtension)).not.toBe(simulationSourceHash(baseline));

    const documentBehaviorExtension = structuredClone(baseline);
    documentBehaviorExtension.extensions = { 'studio.variation.signalApproaches': { approach: 'subject' } };
    expect(simulationSourceHash(documentBehaviorExtension)).not.toBe(simulationSourceHash(baseline));
  });
});
