/**
 * Lightweight 3D pin markers for search results in the CityViewer.
 *
 * A vertical shaft + head sphere — mirrors the teardrop pin used on the 2D
 * map so the two views feel coherent. Uses MeshBasicMaterial (unlit) so the
 * pins stay visible regardless of scene lighting.
 */

import * as THREE from 'three/webgpu';

const DEFAULT_COLOR = 0x38bdf8; // sky-400 — matches 2D highlight blue
const HOVERED_COLOR = 0xfacc15; // amber-400 — matches 2D hover yellow
const STROKE_COLOR = 0x0a0a0a;

const SHAFT_HEIGHT_DEFAULT = 18;
const SHAFT_HEIGHT_HOVERED = 30;
const HEAD_RADIUS_DEFAULT = 3;
const HEAD_RADIUS_HOVERED = 5;

export function createSearchPin(
  position: THREE.Vector3,
  hovered: boolean,
): THREE.Group {
  const group = new THREE.Group();
  group.name = 'search-pin';
  group.position.copy(position);

  const color = hovered ? HOVERED_COLOR : DEFAULT_COLOR;
  const shaftHeight = hovered ? SHAFT_HEIGHT_HOVERED : SHAFT_HEIGHT_DEFAULT;
  const headRadius = hovered ? HEAD_RADIUS_HOVERED : HEAD_RADIUS_DEFAULT;

  // Vertical shaft — short cylinder from ground up
  const shaftGeo = new THREE.CylinderGeometry(0.4, 0.4, shaftHeight, 8);
  shaftGeo.translate(0, shaftHeight / 2, 0);
  const shaftMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(shaftGeo, shaftMat));

  // Head — sphere at the top
  const headGeo = new THREE.SphereGeometry(headRadius, 16, 12);
  headGeo.translate(0, shaftHeight, 0);
  const headMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(headGeo, headMat));

  // Thin stroke ring around the head so it reads against bright backgrounds
  const ringGeo = new THREE.TorusGeometry(headRadius * 1.05, 0.35, 8, 24);
  ringGeo.translate(0, shaftHeight, 0);
  const ringMat = new THREE.MeshBasicMaterial({
    color: STROKE_COLOR,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  group.add(new THREE.Mesh(ringGeo, ringMat));

  return group;
}

export function disposeSearchPinGroup(group: THREE.Group): void {
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
  });
}
