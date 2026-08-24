import { DirectionalLight, Vector3 } from 'three';

export interface SunOptions {
  /** Direction the light travels, from the manifest. */
  direction: Vector3;
  intensity: number;
  /** Scene centre; the light target is parked here. */
  target: Vector3;
}

/**
 * Directional sun.
 *
 * Shadow casting, the shadow frustum and the light's final position are owned
 * by the viewer, which fits them to the camera each time the bake goes stale;
 * this only establishes the light and the direction the manifest asked for.
 */
export function createSun(opts: SunOptions): DirectionalLight {
  const light = new DirectionalLight(0xfff2df, opts.intensity);
  const dir = opts.direction.clone().normalize();
  light.position.copy(opts.target).addScaledVector(dir, -2000);
  light.target.position.copy(opts.target);
  light.castShadow = false;
  light.name = 'sun';
  return light;
}
