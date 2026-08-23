import { describe, expect, it } from 'vitest';
import type { ControlIndication, SignalProgram } from '@simforge/engine';
import {
  buildSignalControlIndex,
  evaluateSignalReferencePhase,
  selectSignalReference,
} from './signal-control.js';

const programs: SignalProgram[] = [
  {
    id: 'north-through', phases: [{ phase: 'green', durationS: 10 }], offsetS: 0, loop: true,
    stopLines: [{ rsl: '1:0:-1', s: 10, connectingLaneRsls: ['10:0:-1'] }],
    mapBinding: {
      junctionId: 'j1', controllerIds: ['stage-ns'], headIds: ['h1', 'h2'], timingSource: 'authored',
      controllerHeadGroups: [{ controllerId: 'stage-ns', headIds: ['h1', 'h2'] }],
    },
  },
  {
    id: 'east-through', phases: [{ phase: 'red', durationS: 10 }], offsetS: 0, loop: true,
    stopLines: [{ rsl: '2:0:-1', s: 8, connectingLaneRsls: ['20:0:-1'] }],
    mapBinding: {
      junctionId: 'j1', controllerIds: ['stage-ew'], headIds: ['h3'], timingSource: 'authored',
      controllerHeadGroups: [{ controllerId: 'stage-ew', headIds: ['h3'] }],
    },
  },
];

describe('signal control index and reference evaluation', () => {
  it('builds exact head to movement to junction/controller reverse indices', () => {
    const index = buildSignalControlIndex(programs, ['h1', 'h2', 'h3', 'unbound']);
    expect(index.heads.get('h1')).toMatchObject({
      movementIds: ['north-through'], controllerIds: ['stage-ns'], junctionIds: ['j1'], resolved: true,
    });
    expect(index.controllers.get('stage-ns')).toMatchObject({ headIds: ['h1', 'h2'], movementIds: ['north-through'] });
    expect(index.junctions.get('j1')?.headIds).toEqual(['h1', 'h2', 'h3']);
    expect(index.diagnostics).toContainEqual(expect.objectContaining({ code: 'unresolved_head', headIds: ['unbound'] }));
  });

  it('selects a stable reference and exposes all three highlight scopes', () => {
    const selected = selectSignalReference(buildSignalControlIndex(programs), 'h2');
    expect(selected).toMatchObject({
      selectedHeadId: 'h2', referenceMovementId: 'north-through', junctionId: 'j1',
      controllerIds: ['stage-ns'], movementHeadIds: ['h1', 'h2'],
      intersectionHeadIds: ['h1', 'h2', 'h3'], relatedMovementIds: ['east-through', 'north-through'],
    });
  });

  it('holds a competing controller stage red and reports the conflict', () => {
    const index = buildSignalControlIndex(programs);
    const selected = selectSignalReference(index, 'h1')!;
    const result = evaluateSignalReferencePhase(index, selected, {
      timeSeconds: 3,
      referencePhase: 'green',
      movementPhases: { 'east-through': 'green' },
    });
    expect(result.headStates).toEqual({ h1: 'green', h2: 'green', h3: 'red' });
    expect(result.movementStates['east-through']).toBe('red');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'conflicting_controller_stage' }));
  });

  it('applies the reference phase to every movement in the exact controller stage', () => {
    const sameStage: SignalProgram = {
      ...programs[1]!,
      id: 'north-left',
      stopLines: [{ rsl: '4:0:-1', s: 7, connectingLaneRsls: ['40:0:-1'] }],
      mapBinding: {
        junctionId: 'j1', controllerIds: ['stage-ns'], headIds: ['h4'], timingSource: 'authored',
        controllerHeadGroups: [{ controllerId: 'stage-ns', headIds: ['h4'] }],
      },
    };
    const index = buildSignalControlIndex([...programs, sameStage]);
    const selected = selectSignalReference(index, 'h1', 'north-through', 'stage-ns')!;
    expect(selected).toMatchObject({
      referenceControllerId: 'stage-ns',
      stageMovementIds: ['north-left', 'north-through'],
      movementHeadIds: ['h1', 'h2', 'h4'],
    });
    const result = evaluateSignalReferencePhase(index, selected, {
      timeSeconds: 1,
      referencePhase: 'yellow',
    });
    expect(result.movementStates).toEqual({
      'east-through': 'red',
      'north-left': 'yellow',
      'north-through': 'yellow',
    });
    expect(result.headStates).toEqual({ h1: 'yellow', h2: 'yellow', h3: 'red', h4: 'yellow' });
  });

  it.each([
    ['green', { h1: 'green', h2: 'green', h3: 'red' }],
    ['yellow', { h1: 'yellow', h2: 'yellow', h3: 'red' }],
    ['red', { h1: 'red', h2: 'red', h3: 'red' }],
    ['off', { h1: 'off', h2: 'off', h3: 'red' }],
    ['flashing_yellow', { h1: 'flashing_yellow', h2: 'flashing_yellow', h3: 'flashing_red' }],
    ['flashing_red', { h1: 'flashing_red', h2: 'flashing_red', h3: 'flashing_red' }],
  ] satisfies Array<[ControlIndication, Record<string, ControlIndication>]>) (
    'derives the complete safe intersection state for reference phase %s',
    (referencePhase, expected) => {
      const index = buildSignalControlIndex(programs);
      const selected = selectSignalReference(index, 'h1')!;
      expect(evaluateSignalReferencePhase(index, selected, {
        timeSeconds: 1,
        referencePhase,
        movementPhases: { 'east-through': 'green' },
      }).headStates).toEqual(expected);
    },
  );

  it('uses exact selected-stage membership for a head referenced by multiple stages', () => {
    const shared: SignalProgram = {
      ...programs[1]!, id: 'east-shared',
      mapBinding: {
        ...programs[1]!.mapBinding!, headIds: ['h1'],
        controllerHeadGroups: [{ controllerId: 'stage-ew', headIds: ['h1'] }],
      },
    };
    const index = buildSignalControlIndex([programs[0]!, shared]);
    const selected = selectSignalReference(index, 'h1', 'north-through')!;
    const result = evaluateSignalReferencePhase(index, selected, {
      timeSeconds: 1, referencePhase: 'green', movementPhases: { 'east-shared': 'red' },
    });
    expect(result.headStates.h1).toBe('green');
    expect(result.diagnostics.filter((entry) => entry.code === 'shared_head').length).toBeGreaterThan(0);
  });
});
