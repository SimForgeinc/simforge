import type * as THREE from 'three/webgpu';

// Fixed display radius for the sun's directional light. Direction is what
// matters for shading; the magnitude only has to be large enough that the
// shadow camera can still see the scene.
const SUN_RADIUS = 500;

/** Convert azimuth/elevation (degrees) to a Vector3 with `R = SUN_RADIUS`. */
export function sunPositionFrom(
  azimuthDeg: number,
  elevationDeg: number,
  out: THREE.Vector3,
): void {
  const azim = (azimuthDeg * Math.PI) / 180;
  const elev = (elevationDeg * Math.PI) / 180;
  const cosE = Math.cos(elev);
  out.set(
    SUN_RADIUS * cosE * Math.sin(azim),
    SUN_RADIUS * Math.sin(elev),
    SUN_RADIUS * cosE * Math.cos(azim),
  );
}

export const SUN_RADIUS_FOR_TESTING = SUN_RADIUS;
