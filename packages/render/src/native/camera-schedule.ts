import type { RenderSensorSourceHost, RenderSourceV3 } from '@simforge-oss/scenario';

import type { NativeSceneState } from './lowering.js';

export interface NativeScheduledCamera {
  readonly sensorId: string;
  readonly width: number;
  readonly height: number;
  readonly fovDeg: number;
  /** Mount pose at the host's *authored* transform (y as the trajectory says). */
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  /**
   * Rigid attachment the service resolves itself every tick, against the
   * host as it actually stands on the map: trajectories author y = 0 and
   * the service snaps the actor to the sampled ground, so an explicit
   * `eye` at the authored y would put the camera under the road wherever
   * the map is not at sea level. With `attach` present the service ignores
   * `eye`/`target`.
   */
  readonly attach: {
    readonly actorId: string;
    /** Actor-local mount, metres: x forward, y right, z up. */
    readonly offsetM: readonly [number, number, number];
    /** Degrees, CARLA sense (clockwise from above); the service subtracts it. */
    readonly yawDeg: number;
    readonly pitchDeg: number;
  };
}

const TARGET_DISTANCE_M = 50;

function verticalFov(horizontalDegrees: number, width: number, height: number): number {
  const horizontal = horizontalDegrees * Math.PI / 180;
  return 2 * Math.atan(Math.tan(horizontal / 2) * height / width) * 180 / Math.PI;
}

function yawFromQuaternion(rotation: readonly [number, number, number, number]): number {
  const [x, y, z, w] = rotation;
  return Math.atan2(2 * (w * y + z * x), 1 - 2 * (y * y + z * z));
}

/** Resolve every authored rigid sensor mount against every simulated host pose. */
export function createNativeCameraSchedule(
  sources: readonly RenderSourceV3[],
  sensorHosts: readonly RenderSensorSourceHost[],
  states: readonly NativeSceneState[],
): readonly (readonly NativeScheduledCamera[])[] {
  const hosts = new Map(sensorHosts.map((host) => [host.sourceId, host.actorId]));
  return states.map((state) => sources.map((source): NativeScheduledCamera => {
    if (source.modality !== 'rgb') throw new Error(`unsupported native modality ${source.modality}`);
    const actorId = hosts.get(source.outputName);
    if (!actorId) throw new Error(`native render source ${source.outputName} has no sensor host mapping`);
    if (actorId !== source.actorId) {
      throw new Error(`native sensor host for ${source.outputName} does not match actor ${source.actorId}`);
    }
    const actor = state.actors.find((candidate) => candidate.id === actorId && candidate.kind !== 'despawn');
    if (!actor) throw new Error(`native sensor host ${actorId} is absent at tick ${state.tick}`);

    const hostYaw = yawFromQuaternion(actor.transform.rotation);
    const mount = source.transform.position;
    const forward = mount.x;
    const right = -mount.z;
    const up = mount.y;
    const sinYaw = Math.sin(hostYaw);
    const cosYaw = Math.cos(hostYaw);
    const eye: [number, number, number] = [
      actor.transform.position[0] + cosYaw * forward + sinYaw * right,
      actor.transform.position[1] + up,
      actor.transform.position[2] - sinYaw * forward + cosYaw * right,
    ];

    // Native scene yaw is CCW about +Y. Render-source mount yaw follows the
    // authored sensor frame, so it composes directly with the host heading.
    const yaw = hostYaw + source.transform.rotation.yawRad;
    const pitch = source.transform.rotation.pitchRad;
    const cosPitch = Math.cos(pitch);
    const direction: [number, number, number] = [
      cosPitch * Math.cos(yaw),
      Math.sin(pitch),
      -cosPitch * Math.sin(yaw),
    ];
    return {
      sensorId: source.outputName,
      width: source.attributes.width,
      height: source.attributes.height,
      fovDeg: verticalFov(source.attributes.horizontalFovDeg, source.attributes.width, source.attributes.height),
      eye,
      target: [
        eye[0] + TARGET_DISTANCE_M * direction[0],
        eye[1] + TARGET_DISTANCE_M * direction[1],
        eye[2] + TARGET_DISTANCE_M * direction[2],
      ],
      attach: {
        actorId,
        offsetM: [forward, right, up],
        // Authored mount yaw is CCW; the service's attach yaw is CARLA's
        // clockwise sense, so the sign flips here and nowhere else.
        yawDeg: -source.transform.rotation.yawRad * 180 / Math.PI,
        pitchDeg: source.transform.rotation.pitchRad * 180 / Math.PI,
      },
    };
  }));
}
