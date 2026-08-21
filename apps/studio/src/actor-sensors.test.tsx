import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { defaultDashCamera, type ActorSensor, type RoleBinding } from '@uniscenarios/scenario-model';
import type { SampledActor } from '@uniscenarios/playback';
import type { EditorController } from './editor/controller';
import type { ActorRecord } from './editor/document';
import { ActorDetailsCallout, ActorSensorsPanel, actorRecordForRole } from './workspace/ActorDetails';

function actor(kind: ActorRecord['kind'], sensors: readonly ActorSensor[] = []): ActorRecord {
  return {
    id: `${kind}-actor`,
    source: kind === 'prop' ? 'prop' : 'role',
    kind,
    catalogId: kind === 'vehicle' ? 'vehicle.sedan' : kind === 'pedestrian' ? 'pedestrian.adult_walking' : 'construction.traffic_cone',
    label: undefined,
    x: 0,
    y: 0,
    z: 0,
    headingRad: 0,
    laneRef: undefined,
    dims: { l: 4.8, w: 1.9, h: 1.5 },
    bodyColor: undefined,
    sensors,
  };
}

function controllerFor(record: ActorRecord, actorClass: string): EditorController {
  return {
    doc: {
      data: {
        roles: [{ id: record.id, actor: { class: actorClass, sensors: record.sensors } }],
      },
    },
  } as unknown as EditorController;
}

describe('ActorSensorsPanel', () => {
  it('discloses the selected class-native actor backend in the inspector', () => {
    const record = actor('pedestrian');
    const markup = renderToStaticMarkup(<ActorDetailsCallout
      actor={record}
      physics={{ id: record.id, label: record.label ?? record.id, mode: 'dynamic-v1', reason: 'selected', profile: 'pedestrian' }}
      controller={controllerFor(record, 'pedestrian')}
      viewer={{ camera: {} } as never}
      host={null}
      onClose={() => undefined}
    />);
    expect(markup).toContain('data-testid="actor-physics-backend"');
    expect(markup).toContain('Dynamic v1 · pedestrian');
    expect(markup).toContain('Selected backend');
  });
  it('renders add, enable, configure and remove affordances for vehicle cameras', () => {
    const camera = defaultDashCamera({ class: 'car' }, 'test-dash-camera');
    const record = actor('vehicle', [camera]);
    const markup = renderToStaticMarkup(<ActorSensorsPanel actor={record} controller={controllerFor(record, 'car')} />);

    expect(markup).toContain('data-testid="add-dash-camera"');
    expect(markup).toContain('data-testid="dash-camera-editor"');
    expect(markup).toContain('Enable dash camera 1');
    expect(markup).toContain('Remove dash camera 1');
    expect(markup).toContain('horizontal field of view');
    expect(markup).toContain('Mount &amp; camera details');
  });

  it.each([
    ['pedestrian', 'pedestrian'],
    ['prop', 'static_object'],
  ] as const)('keeps the Sensors panel for unsupported %s actors', (kind, actorClass) => {
    const record = actor(kind);
    const markup = renderToStaticMarkup(<ActorSensorsPanel actor={record} controller={controllerFor(record, actorClass)} />);
    expect(markup).toContain('data-testid="actor-sensors-panel"');
    expect(markup).toContain('Dash cameras are not supported on this actor type');
    expect(markup).not.toContain('data-testid="add-dash-camera"');
  });

  it('resolves a portable Gallery role through its materialized pose and exposes sensor authoring', () => {
    const role = {
      id: 'portable-ambulance',
      kind: 'on_reference',
      actor: { class: 'car', catalogId: 'vehicle.sedan', static: false, sensors: [] },
      pose: { laneOffset: 0, s: 0, tFrac: 0, headingOffsetRad: 0 },
      essentiality: 'required',
    } as RoleBinding;
    const sampled: SampledActor = {
      id: role.id,
      catalogId: 'vehicle.sedan',
      dims: { l: 4.8, w: 1.9, h: 1.5 },
      x: 42,
      z: -17,
      headingRad: 0.5,
      speedMps: 0,
      present: true,
      static: false,
      motionDirection: 1,
      downProgress: 0,
    };
    const record = actorRecordForRole(role, sampled);
    expect(record).toMatchObject({ id: role.id, x: 42, z: -17, headingRad: 0.5, sensors: [] });
    const markup = renderToStaticMarkup(<ActorSensorsPanel actor={record!} controller={controllerFor(record!, 'car')} />);
    expect(markup).toContain('data-testid="actor-sensors-panel"');
    expect(markup).toContain('data-testid="add-dash-camera"');
  });
});
