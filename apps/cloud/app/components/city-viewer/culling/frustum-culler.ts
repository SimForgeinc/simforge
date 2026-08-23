import * as THREE from 'three/webgpu';
import type { AABB } from '../types';

const _box = new THREE.Box3();
const _min = new THREE.Vector3();
const _max = new THREE.Vector3();

/** Tests tile AABBs against the camera frustum */
export class FrustumCuller {
  test(bounds: AABB, frustum: THREE.Frustum): boolean {
    _min.set(bounds.min[0], bounds.min[1], bounds.min[2]);
    _max.set(bounds.max[0], bounds.max[1], bounds.max[2]);
    _box.set(_min, _max);
    return frustum.intersectsBox(_box);
  }
}
