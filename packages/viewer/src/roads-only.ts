import { Box3, Vector3, type Mesh, type Object3D } from 'three';

/** Stable semantic marker used by editor renderers for helpers Roads Only omits. */
export const LOW_FIDELITY_HIDDEN_ROLE = 'low-fidelity-hidden';
/** @deprecated use LOW_FIDELITY_HIDDEN_ROLE */
export const ROADS_ONLY_HIDDEN_ROLE = LOW_FIDELITY_HIDDEN_ROLE;

const _bounds = new Box3();
const _size = new Vector3();

function semanticText(object: Object3D): string {
  const metadata = object.userData as Record<string, unknown>;
  return [
    object.name,
    metadata.category,
    metadata.kind,
    metadata.role,
    metadata.semantic,
    metadata.class,
  ].filter((value): value is string => typeof value === 'string').join(' ').toLowerCase();
}

/**
 * Physical signal infrastructure is the only small road-layer furniture kept
 * by Roads Only. Exported semantic metadata wins; the name fallback covers
 * legacy RoadRunner glTFs that predate category metadata.
 */
export function isTrafficSignalMesh(mesh: Mesh): boolean {
  const text = semanticText(mesh);
  return /traffic[_ .-]?(light|signal)|signal(?:[_ .-]|\w)*(head|post|pole|mast|light)|pole(?:[_ .-]|\w)*signal|^(walk[_ .-]?)?light[_ .-]?(red|yellow|green|walk)/.test(text);
}

/**
 * RoadRunner combines road sheets and street furniture in one glTF. Ground
 * sheets are reliably separated by their map-scale footprint. Small meshes are
 * retained only when explicitly identified as traffic-signal infrastructure;
 * uncertain map-scale geometry stays visible so navigability cannot disappear.
 */
export function keepInRoadsOnly(mesh: Mesh, minGroundFootprintM = 10): boolean {
  if (isTrafficSignalMesh(mesh)) return true;
  if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
  const bounds = mesh.geometry.boundingBox;
  if (!bounds) return true;
  mesh.updateWorldMatrix(true, false);
  _bounds.copy(bounds).applyMatrix4(mesh.matrixWorld).getSize(_size);
  return Math.min(_size.x, _size.z) >= minGroundFootprintM;
}

export function isLowFidelityHiddenHelper(object: Object3D): boolean {
  return object.userData.simforgeRole === LOW_FIDELITY_HIDDEN_ROLE;
}

export const isRoadsOnlyHiddenHelper = isLowFidelityHiddenHelper;
