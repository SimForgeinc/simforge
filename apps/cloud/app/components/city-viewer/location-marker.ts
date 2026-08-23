/**
 * 3D location marker for highlighting candidate locations in the CityViewer.
 *
 * Renders a flat orange ring on the ground plane with a center disc and
 * vertical beacon line. Uses MeshBasicMaterial (unlit) so the marker is
 * always visible regardless of scene lighting.
 */

import * as THREE from 'three/webgpu';

const MARKER_COLOR = 0xf97316; // orange-500 — matches attribute panel selection
const RING_OPACITY = 0.4;
const DISC_OPACITY = 0.6;
const BEACON_OPACITY = 0.5;
const BEACON_HEIGHT = 30;
const RING_SEGMENTS = 64;

/**
 * Create a location marker Group positioned at `position`.
 *
 * @param position  Scene-frame position (x, groundY, z)
 * @param regionRadius  Approximate extent of the candidate region in meters.
 *                      Controls the ring size (clamped to a reasonable range).
 */
export function createLocationMarker(
  position: THREE.Vector3,
  regionRadius: number,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'location-marker';
  group.position.copy(position);

  const ringRadius = Math.max(5, Math.min(regionRadius * 0.4, 50));

  // Ground ring — flat donut on the XZ plane
  const ringGeo = new THREE.RingGeometry(ringRadius * 0.7, ringRadius, RING_SEGMENTS);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: MARKER_COLOR,
    transparent: true,
    opacity: RING_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(ringGeo, ringMat));

  // Center disc — small filled circle
  const discGeo = new THREE.CircleGeometry(ringRadius * 0.15, 32);
  discGeo.rotateX(-Math.PI / 2);
  const discMat = new THREE.MeshBasicMaterial({
    color: MARKER_COLOR,
    transparent: true,
    opacity: DISC_OPACITY,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(discGeo, discMat));

  // Vertical beacon — thin line extending upward
  const beaconGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, BEACON_HEIGHT, 0),
  ]);
  const beaconMat = new THREE.LineBasicMaterial({
    color: MARKER_COLOR,
    transparent: true,
    opacity: BEACON_OPACITY,
  });
  group.add(new THREE.Line(beaconGeo, beaconMat));

  return group;
}

/** Dispose all geometry and materials in a marker group. */
export function disposeMarkerGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const mesh = obj as THREE.Mesh;
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((m) => m.dispose());
      } else {
        mesh.material.dispose();
      }
    }
    if ((obj as THREE.Line).isLine) {
      const line = obj as THREE.Line;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
  });
}
