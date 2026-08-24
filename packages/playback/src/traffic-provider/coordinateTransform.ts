import {
  sumoNetworkHeadingToScene,
  sumoNetworkToScene,
  sumoSceneHeadingToNetwork,
  sumoSceneToNetwork,
} from '@simforge/engine';
import type { NetworkWorldTransform } from './protocol';

export function toWorld(x: number, y: number, transform: NetworkWorldTransform): { x: number; y: number } {
  const scene = sumoNetworkToScene({ x, y }, transform);
  // Compatibility wrapper for existing Studio call sites. `y` here is scene
  // z; the shared API above deliberately names it z to prevent sign mistakes.
  return { x: scene.x, y: scene.z };
}
export function toNetwork(x: number, y: number, transform: NetworkWorldTransform): { x: number; y: number } {
  return sumoSceneToNetwork({ x, z: y }, transform);
}

/** Exact scene -> SUMO conversion used for authored occupancy proxies. */
export function externalActorToNetwork(
  actor: { readonly x: number; readonly z: number; readonly headingDegrees: number },
  transform: NetworkWorldTransform,
): { readonly x: number; readonly y: number; readonly headingDegrees: number } {
  const point = sumoSceneToNetwork(actor, transform);
  return { ...point, headingDegrees: sumoSceneHeadingToNetwork(actor.headingDegrees, transform) };
}

export function transformPackedStatesToWorld(
  buffer: ArrayBuffer,
  count: number,
  transform: NetworkWorldTransform,
): void {
  const floats = new Float32Array(buffer);
  if (count < 0 || floats.length < count * 8) {
    throw new RangeError(`packed traffic state has ${floats.length} floats for ${count} actors`);
  }
  for (let actor = 0; actor < count; actor += 1) {
    const offset = actor * 8;
    const position = toWorld(floats[offset + 1]!, floats[offset + 2]!, transform);
    floats[offset + 1] = position.x;
    floats[offset + 2] = position.y;
    const heading = floats[offset + 3]!;
    floats[offset + 3] = sumoNetworkHeadingToScene(heading, transform);
  }
}
