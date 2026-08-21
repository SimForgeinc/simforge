import { describe, expect, it } from 'vitest';
import { InstancedMesh, LineSegments, Vector3 } from 'three';
import {
  ActorSensorSchema,
  defaultDashCamera,
  type ActorSensor,
} from '@uniscenarios/scenario-model';
import {
  ActorSensorOverlay,
  sensorCoverageSegments,
  sensorWorldMatrix,
  type SensorOverlayActor,
} from './sensorOverlay';

function activeSensor(
  type: 'lidar' | 'radar',
  id: string,
  enabled = true,
): ActorSensor {
  return ActorSensorSchema.parse({
    id,
    type,
    enabled,
    mount: { position: { x: 0, y: 1.5, z: 0 } },
  });
}

const actor = (
  sensors: readonly ActorSensor[],
  overrides: Partial<SensorOverlayActor> = {},
): SensorOverlayActor => ({
  id: 'ego',
  x: 10,
  y: 0,
  z: 20,
  headingRad: 0,
  sensors,
  ...overrides,
});

describe('sensor overlay geometry', () => {
  it('renders an authored left mount on scene left and follows the actor transform', () => {
    const camera = defaultDashCamera({ class: 'car' }, 'left-camera');
    camera.mount.position.x = 0;
    camera.mount.position.y = 1;
    camera.mount.position.z = 1.25;
    const position = new Vector3().setFromMatrixPosition(sensorWorldMatrix(actor([camera]), camera));

    expect(position.x).toBeCloseTo(10, 6);
    expect(position.y).toBeCloseTo(1, 6);
    expect(position.z).toBeCloseTo(18.75, 6);

    const rotated = new Vector3().setFromMatrixPosition(sensorWorldMatrix(
      actor([camera], { headingRad: Math.PI / 2 }),
      camera,
    ));
    expect(rotated.x).toBeCloseTo(8.75, 6);
    expect(rotated.z).toBeCloseTo(20, 6);
  });

  it('builds envelopes rather than allocating a ray object per sample', () => {
    const camera = defaultDashCamera({ class: 'car' }, 'camera');
    const lidar = activeSensor('lidar', 'lidar');
    const radar = activeSensor('radar', 'radar');

    // Twelve frustum edges, three LiDAR elevation arcs, and one radar arc with
    // boundary/boresight edges are stable structural primitives.
    expect(sensorCoverageSegments(camera).length).toBe(12 * 2 * 3);
    expect(sensorCoverageSegments(lidar).length).toBeGreaterThan(100);
    expect(sensorCoverageSegments(radar).length).toBeGreaterThan(30);
  });

  it('instances enabled and disabled housings and shows coverage only for selection', () => {
    const overlay = new ActorSensorOverlay();
    const enabled = activeSensor('lidar', 'roof');
    const disabled = activeSensor('lidar', 'roof-disabled', false);
    overlay.sync([actor([enabled, disabled])]);

    const housings = overlay.group.children.filter(
      (child): child is InstancedMesh => child instanceof InstancedMesh,
    );
    expect(housings.map((mesh) => [mesh.name, mesh.count])).toEqual([
      ['sensor-housings.lidar.enabled', 1],
      ['sensor-housings.lidar.disabled', 1],
    ]);
    expect(housings[0]!.material).not.toBe(housings[1]!.material);
    expect(housings[1]!.material).toMatchObject({ transparent: true, opacity: 0.48 });
    expect(overlay.group.children.filter((child) => child instanceof LineSegments && child.visible)).toHaveLength(0);

    overlay.setSelectedActorIds(new Set(['ego']));
    expect(overlay.group.children.filter((child) => child instanceof LineSegments && child.visible).map((line) => line.name))
      .toEqual(['sensor-coverage.lidar']);

    overlay.setSelectedActorIds(new Set());
    expect(overlay.group.children.filter((child) => child instanceof LineSegments && child.visible)).toHaveLength(0);

    overlay.sync([]);
    expect(housings.every((mesh) => mesh.count === 0 && !mesh.visible)).toBe(true);
    overlay.dispose();
  });

  it('disposes every owned geometry and material', () => {
    const overlay = new ActorSensorOverlay();
    overlay.sync([actor([
      defaultDashCamera({ class: 'car' }, 'front-camera'),
      activeSensor('lidar', 'roof-lidar', false),
      activeSensor('radar', 'front-radar'),
    ])]);
    const geometries = new Set(overlay.group.children.flatMap((child) => {
      if (child instanceof InstancedMesh || child instanceof LineSegments) return [child.geometry];
      return [];
    }));
    const materials = new Set(overlay.group.children.flatMap((child) => {
      if (!(child instanceof InstancedMesh || child instanceof LineSegments)) return [];
      return Array.isArray(child.material) ? child.material : [child.material];
    }));
    let disposedGeometries = 0;
    let disposedMaterials = 0;
    for (const geometry of geometries) geometry.addEventListener('dispose', () => disposedGeometries++);
    for (const material of materials) material.addEventListener('dispose', () => disposedMaterials++);

    overlay.dispose();

    expect(disposedGeometries).toBe(geometries.size);
    expect(disposedMaterials).toBe(materials.size);
    expect(overlay.group.children).toEqual([]);
  });
});
