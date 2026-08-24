import { describe, expect, it } from 'vitest';
import { MemoryStorage, WebTemplateFileStore, defaultDashCamera } from '@simforge/scenario';
import { EditorDocument, sensorSubjectRole } from './document';
import { TEST_MAP } from './map';

async function cameraVehicle(): Promise<{ document: EditorDocument; actorId: string }> {
  const document = await EditorDocument.openBlank(TEST_MAP, {
    store: new WebTemplateFileStore({ storage: new MemoryStorage() }),
    autosaveMs: 60_000,
  });
  const [actorId] = document.add([{
    id: 'camera_vehicle', catalogId: 'vehicle.sedan', x: 0, y: 0, z: 0, headingRad: 0,
  }]);
  return { document, actorId: actorId! };
}

describe('sensor-derived metric subject', () => {
  it('selects the first sensor-bearing role in authoring order', async () => {
    const { document, actorId } = await cameraVehicle();
    document.add([{
      id: 'second_vehicle', catalogId: 'vehicle.suv', x: 5, y: 0, z: 0, headingRad: 0,
    }]);
    const second = document.data.roles.find((role) => role.id === 'second_vehicle')!;
    document.addActorSensor('second_vehicle', defaultDashCamera(second.actor, 'second_camera'));
    expect(sensorSubjectRole(document.data)).toBe('second_vehicle');

    const first = document.data.roles.find((role) => role.id === actorId)!;
    document.addActorSensor(actorId, defaultDashCamera(first.actor, 'first_camera'));
    expect(sensorSubjectRole(document.data)).toBe(actorId);
    document.dispose();
  });

  it('adds the first sensor and its subject as one undo step', async () => {
    const { document, actorId } = await cameraVehicle();
    const role = document.data.roles.find((item) => item.id === actorId)!;
    const camera = defaultDashCamera(role.actor, 'front_camera');

    document.addActorSensor(actorId, camera);
    expect(document.data.metricSubject).toBe(actorId);
    expect(document.actor(actorId)?.sensors).toEqual([camera]);

    expect(document.undo()).toBe(true);
    expect(document.data.metricSubject).toBeUndefined();
    expect(document.actor(actorId)?.sensors).toEqual([]);
    expect(document.actor(actorId)).toBeDefined();
    document.dispose();
  });

  it('replaces a complete sensor rig and its subject as one undo step', async () => {
    const { document, actorId } = await cameraVehicle();
    const role = document.data.roles.find((item) => item.id === actorId)!;
    const camera = defaultDashCamera(role.actor, 'replacement_camera');

    document.replaceActorSensors(actorId, [camera]);
    expect(document.data.metricSubject).toBe(actorId);
    expect(document.actor(actorId)?.sensors).toEqual([camera]);
    expect(document.undo()).toBe(true);
    expect(document.data.metricSubject).toBeUndefined();
    expect(document.actor(actorId)?.sensors).toEqual([]);
    document.dispose();
  });

  it('removes the last sensor and clears its subject as one undo step', async () => {
    const { document, actorId } = await cameraVehicle();
    const role = document.data.roles.find((item) => item.id === actorId)!;
    const camera = defaultDashCamera(role.actor, 'front_camera');
    document.addActorSensor(actorId, camera);

    document.removeActorSensor(actorId, camera.id);
    expect(document.data.metricSubject).toBeUndefined();
    expect(document.actor(actorId)?.sensors).toEqual([]);

    expect(document.undo()).toBe(true);
    expect(document.data.metricSubject).toBe(actorId);
    expect(document.actor(actorId)?.sensors).toEqual([camera]);
    document.dispose();
  });

  it('preserves the subject and authored trace when the last sensor is removed', async () => {
    const { document, actorId } = await cameraVehicle();
    const role = document.data.roles.find((item) => item.id === actorId)!;
    const camera = defaultDashCamera(role.actor, 'front_camera');
    document.addActorSensor(actorId, camera);
    const segment = {
      id: 'camera_observation', actor: actorId, startS: 0, endS: 1,
      observation: 'A pedestrian enters the lane.', action: 'Brake.',
    };
    document.addReasoningTraceSegment(segment);

    document.removeActorSensor(actorId, camera.id);
    expect(document.data.metricSubject).toBe(actorId);
    expect(document.data.reasoningTrace).toEqual([segment]);
    expect(document.actor(actorId)?.sensors).toEqual([]);

    expect(document.undo()).toBe(true);
    expect(document.data.metricSubject).toBe(actorId);
    expect(document.data.reasoningTrace).toEqual([segment]);
    expect(document.actor(actorId)?.sensors).toEqual([camera]);
    document.dispose();
  });
});
