import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Euler,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Material,
} from 'three';
import {
  sensorAperture,
  sensorMountScenePose,
  type ActorSensor,
} from '@simforge-oss/scenario';

export interface SensorOverlayActor {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly headingRad: number;
  readonly sensors?: readonly ActorSensor[];
}

type SensorKind = ActorSensor['type'];
type HousingState = 'enabled' | 'disabled';

interface HousingBatch {
  readonly mesh: InstancedMesh;
  readonly capacity: number;
}

const SENSOR_KINDS: readonly SensorKind[] = ['dash_camera', 'lidar', 'radar'];
const HOUSING_STATES: readonly HousingState[] = ['enabled', 'disabled'];
const COVERAGE_ARC_STEP_DEG = 10;
const FULL_CIRCLE_EPSILON_DEG = 0.001;
const SENSOR_OVERLAY_RENDER_ORDER = 28;
const UNIT_SCALE = new Vector3(1, 1, 1);
const ACTOR_UP = new Vector3(0, 1, 0);

/**
 * Actor-local sensor pose lowered to Three.js scene axes and then attached to
 * the actor's unscaled body transform.
 */
export function sensorWorldMatrix(actor: SensorOverlayActor, sensor: ActorSensor): Matrix4 {
  const sceneMount = sensorMountScenePose(sensor.mount);
  const actorMatrix = new Matrix4().compose(
    new Vector3(actor.x, actor.y, actor.z),
    new Quaternion().setFromAxisAngle(ACTOR_UP, actor.headingRad),
    UNIT_SCALE,
  );
  const mountQuaternion = new Quaternion().setFromEuler(new Euler(
    sceneMount.rotation.rollRad,
    sceneMount.rotation.yawRad,
    sceneMount.rotation.pitchRad,
    'YZX',
  ));
  const mountMatrix = new Matrix4().compose(
    new Vector3(sceneMount.position.x, sceneMount.position.y, sceneMount.position.z),
    mountQuaternion,
    UNIT_SCALE,
  );
  return actorMatrix.multiply(mountMatrix);
}

/**
 * Coverage line segments in sensor-local Three.js axes (+X forward, -Z left).
 * A fixed set of envelope edges is used; there is deliberately no object or
 * allocation per simulated ray.
 */
export function sensorCoverageSegments(sensor: ActorSensor): Float32Array {
  if (sensor.type === 'dash_camera') return cameraFrustumSegments(sensor);
  if (sensor.type === 'lidar') return lidarEnvelopeSegments(sensor);
  return radarWedgeSegments(sensor);
}

function sensorCoverageKey(sensor: ActorSensor): string {
  const aperture = sensorAperture(sensor);
  return [
    sensor.type,
    aperture.horizontalFovDeg,
    aperture.verticalFovDeg,
    aperture.nearM,
    aperture.farM,
  ].join(':');
}

function cameraFrustumSegments(sensor: ActorSensor): Float32Array {
  const aperture = sensorAperture(sensor);
  const horizontal = Math.tan((aperture.horizontalFovDeg * Math.PI) / 360);
  const vertical = Math.tan((aperture.verticalFovDeg * Math.PI) / 360);
  const corners = (distance: number): readonly Vector3[] => [
    new Vector3(distance, distance * vertical, distance * horizontal),
    new Vector3(distance, distance * vertical, -distance * horizontal),
    new Vector3(distance, -distance * vertical, -distance * horizontal),
    new Vector3(distance, -distance * vertical, distance * horizontal),
  ];
  const near = corners(aperture.nearM);
  const far = corners(aperture.farM);
  const values: number[] = [];
  for (let index = 0; index < 4; index++) {
    pushSegment(values, near[index]!, near[(index + 1) % 4]!);
    pushSegment(values, far[index]!, far[(index + 1) % 4]!);
    pushSegment(values, near[index]!, far[index]!);
  }
  return new Float32Array(values);
}

function lidarEnvelopeSegments(sensor: ActorSensor): Float32Array {
  const aperture = sensorAperture(sensor);
  const halfHorizontalRad = (aperture.horizontalFovDeg * Math.PI) / 360;
  const halfVerticalRad = (aperture.verticalFovDeg * Math.PI) / 360;
  const steps = Math.max(8, Math.ceil(aperture.horizontalFovDeg / COVERAGE_ARC_STEP_DEG));
  const closed = Math.abs(aperture.horizontalFovDeg - 360) <= FULL_CIRCLE_EPSILON_DEG;
  const values: number[] = [];
  for (const elevation of [0, halfVerticalRad, -halfVerticalRad]) {
    const ring: Vector3[] = [];
    const sampleCount = closed ? steps : steps + 1;
    for (let index = 0; index < sampleCount; index++) {
      const fraction = index / steps;
      const azimuth = closed
        ? -Math.PI + fraction * Math.PI * 2
        : -halfHorizontalRad + fraction * halfHorizontalRad * 2;
      const horizontalRange = aperture.farM * Math.cos(elevation);
      ring.push(new Vector3(
        horizontalRange * Math.cos(azimuth),
        aperture.farM * Math.sin(elevation),
        horizontalRange * Math.sin(azimuth),
      ));
    }
    pushPolyline(values, ring, closed);
  }
  const boundaryAzimuths = closed
    ? [0, Math.PI / 2, Math.PI, -Math.PI / 2]
    : [-halfHorizontalRad, halfHorizontalRad];
  for (const azimuth of boundaryAzimuths) {
    const lower = sphericalPoint(aperture.farM, azimuth, -halfVerticalRad);
    const centre = sphericalPoint(aperture.farM, azimuth, 0);
    const upper = sphericalPoint(aperture.farM, azimuth, halfVerticalRad);
    pushSegment(values, lower, centre);
    pushSegment(values, centre, upper);
  }
  return new Float32Array(values);
}

function radarWedgeSegments(sensor: ActorSensor): Float32Array {
  const aperture = sensorAperture(sensor);
  const halfHorizontalRad = (aperture.horizontalFovDeg * Math.PI) / 360;
  const steps = Math.max(4, Math.ceil(aperture.horizontalFovDeg / COVERAGE_ARC_STEP_DEG));
  const arc: Vector3[] = [];
  for (let index = 0; index <= steps; index++) {
    const azimuth = -halfHorizontalRad + (index / steps) * halfHorizontalRad * 2;
    arc.push(new Vector3(
      aperture.farM * Math.cos(azimuth),
      0,
      aperture.farM * Math.sin(azimuth),
    ));
  }
  const origin = new Vector3(0, 0, 0);
  const values: number[] = [];
  pushPolyline(values, arc, false);
  pushSegment(values, origin, arc[0]!);
  pushSegment(values, origin, arc[arc.length - 1]!);
  pushSegment(values, origin, new Vector3(aperture.farM, 0, 0));
  return new Float32Array(values);
}

function sphericalPoint(range: number, azimuth: number, elevation: number): Vector3 {
  const horizontalRange = range * Math.cos(elevation);
  return new Vector3(
    horizontalRange * Math.cos(azimuth),
    range * Math.sin(elevation),
    horizontalRange * Math.sin(azimuth),
  );
}

function pushPolyline(values: number[], points: readonly Vector3[], closed: boolean): void {
  for (let index = 1; index < points.length; index++) {
    pushSegment(values, points[index - 1]!, points[index]!);
  }
  if (closed && points.length > 1) pushSegment(values, points[points.length - 1]!, points[0]!);
}

function pushSegment(values: number[], start: Vector3, end: Vector3): void {
  values.push(start.x, start.y, start.z, end.x, end.y, end.z);
}

/** Actor-owned, batched Three.js visualization of physical sensors. */
export class ActorSensorOverlay {
  readonly group = new Group();

  private readonly housingGeometry: Record<SensorKind, BufferGeometry>;
  private readonly housingMaterials: Record<HousingState, MeshStandardMaterial>;
  private readonly housingBatches = new Map<string, HousingBatch>();
  private readonly coverageLines: Record<SensorKind, LineSegments>;
  private readonly coverageCache = new Map<string, Float32Array>();
  private actors: readonly SensorOverlayActor[] = [];
  private selectedActorIds = new Set<string>();
  private disposed = false;

  constructor() {
    this.group.name = 'actor-sensors';
    this.group.renderOrder = SENSOR_OVERLAY_RENDER_ORDER;

    const camera = new BoxGeometry(0.28, 0.16, 0.2);
    camera.translate(0.1, 0, 0);
    const lidar = new CylinderGeometry(0.11, 0.13, 0.16, 16);
    const radar = new BoxGeometry(0.12, 0.08, 0.24);
    radar.translate(0.04, 0, 0);
    this.housingGeometry = { dash_camera: camera, lidar, radar };
    this.housingMaterials = {
      enabled: new MeshStandardMaterial({ color: 0x31485c, roughness: 0.42, metalness: 0.35 }),
      disabled: new MeshStandardMaterial({
        color: 0x7f8589,
        roughness: 0.82,
        metalness: 0.05,
        transparent: true,
        opacity: 0.48,
      }),
    };

    this.coverageLines = {
      dash_camera: this.createCoverageLine('camera', 0x55a6e8),
      lidar: this.createCoverageLine('lidar', 0x54bd8b),
      radar: this.createCoverageLine('radar', 0xe2a44f),
    };
  }

  get stats(): { housingDrawCalls: number; coverageDrawCalls: number } {
    let housingDrawCalls = 0;
    for (const batch of this.housingBatches.values()) {
      if (batch.mesh.visible && batch.mesh.count > 0) housingDrawCalls++;
    }
    let coverageDrawCalls = 0;
    for (const line of Object.values(this.coverageLines)) {
      if (line.visible) coverageDrawCalls++;
    }
    return { housingDrawCalls, coverageDrawCalls };
  }

  sync(actors: readonly SensorOverlayActor[]): void {
    if (this.disposed) return;
    this.actors = actors;
    this.syncHousings();
    this.syncCoverage();
  }

  setSelectedActorIds(ids: ReadonlySet<string>): void {
    if (this.disposed) return;
    this.selectedActorIds = new Set(ids);
    this.syncCoverage();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const batch of this.housingBatches.values()) batch.mesh.dispose();
    this.housingBatches.clear();
    for (const geometry of Object.values(this.housingGeometry)) geometry.dispose();
    for (const material of Object.values(this.housingMaterials)) material.dispose();
    for (const line of Object.values(this.coverageLines)) {
      line.geometry.dispose();
      (line.material as Material).dispose();
    }
    this.coverageCache.clear();
    this.actors = [];
    this.selectedActorIds.clear();
    this.group.clear();
    this.group.removeFromParent();
  }

  private createCoverageLine(name: string, color: number): LineSegments {
    const line = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color, transparent: true, opacity: 0.72, depthWrite: false }),
    );
    line.name = `sensor-coverage.${name}`;
    line.renderOrder = SENSOR_OVERLAY_RENDER_ORDER;
    line.frustumCulled = false;
    line.visible = false;
    this.group.add(line);
    return line;
  }

  private syncHousings(): void {
    const buckets: Record<SensorKind, Record<HousingState, Array<{
      actor: SensorOverlayActor;
      sensor: ActorSensor;
    }>>> = {
      dash_camera: { enabled: [], disabled: [] },
      lidar: { enabled: [], disabled: [] },
      radar: { enabled: [], disabled: [] },
    };
    for (const actor of this.actors) {
      for (const sensor of actor.sensors ?? []) {
        const state: HousingState = sensor.enabled ? 'enabled' : 'disabled';
        buckets[sensor.type][state].push({ actor, sensor });
      }
    }

    for (const kind of SENSOR_KINDS) {
      for (const state of HOUSING_STATES) {
        const key = `${kind}.${state}`;
        const sensors = buckets[kind][state];
        const existing = this.housingBatches.get(key);
        if (sensors.length === 0) {
          if (existing) {
            existing.mesh.count = 0;
            existing.mesh.visible = false;
          }
          continue;
        }
        const batch = this.ensureHousingBatch(kind, state, sensors.length);
        batch.mesh.count = sensors.length;
        batch.mesh.visible = true;
        batch.mesh.userData.actorIds = sensors.map(({ actor }) => actor.id);
        batch.mesh.userData.sensorIds = sensors.map(({ sensor }) => sensor.id);
        sensors.forEach(({ actor, sensor }, index) => {
          batch.mesh.setMatrixAt(index, sensorWorldMatrix(actor, sensor));
        });
        batch.mesh.instanceMatrix.needsUpdate = true;
        batch.mesh.computeBoundingSphere();
      }
    }
  }

  private ensureHousingBatch(kind: SensorKind, state: HousingState, needed: number): HousingBatch {
    const key = `${kind}.${state}`;
    const existing = this.housingBatches.get(key);
    if (existing && existing.capacity >= needed) return existing;
    if (existing) {
      this.group.remove(existing.mesh);
      existing.mesh.dispose();
    }
    const capacity = Math.max(4, 1 << Math.ceil(Math.log2(Math.max(1, needed))));
    const mesh = new InstancedMesh(
      this.housingGeometry[kind],
      this.housingMaterials[state],
      capacity,
    );
    mesh.name = `sensor-housings.${key}`;
    mesh.count = 0;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = SENSOR_OVERLAY_RENDER_ORDER;
    const batch = { mesh, capacity };
    this.housingBatches.set(key, batch);
    this.group.add(mesh);
    return batch;
  }

  private syncCoverage(): void {
    const positions: Record<SensorKind, number[]> = {
      dash_camera: [],
      lidar: [],
      radar: [],
    };
    for (const actor of this.actors) {
      if (!this.selectedActorIds.has(actor.id)) continue;
      for (const sensor of actor.sensors ?? []) {
        if (!sensor.enabled) continue;
        const matrix = sensorWorldMatrix(actor, sensor);
        const key = sensorCoverageKey(sensor);
        let local = this.coverageCache.get(key);
        if (!local) {
          local = sensorCoverageSegments(sensor);
          this.coverageCache.set(key, local);
        }
        const point = new Vector3();
        for (let offset = 0; offset < local.length; offset += 3) {
          point.set(local[offset]!, local[offset + 1]!, local[offset + 2]!).applyMatrix4(matrix);
          positions[sensor.type].push(point.x, point.y, point.z);
        }
      }
    }
    for (const kind of SENSOR_KINDS) {
      const line = this.coverageLines[kind];
      const geometry = new BufferGeometry();
      const values = positions[kind];
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(values), 3));
      if (values.length > 0) geometry.computeBoundingSphere();
      line.geometry.dispose();
      line.geometry = geometry;
      line.visible = values.length > 0;
    }
  }
}
