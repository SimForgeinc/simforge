/**
 * 3D planned-actor trajectories for the CityViewer.
 *
 * Mirrors `proximity-arrow.ts` (cylinder-chain shaft + a single cone head at
 * the destination) but is a per-actor authored path rather than a spatial
 * relation: colored per actor and a touch thinner, so an AI-proposed
 * scenario's actor routes read distinctly from proximity/topology arrows.
 *
 * Geometry is in scene units (meters, lon/lat-local) to match
 * `geo-utils.lonLatToScene`; callers snap Y to ground via
 * `CityViewerCore.sampleGroundY` before handing off.
 */

import * as THREE from "three/webgpu";

const SHAFT_RADIUS = 0.5;
const HEAD_LENGTH = 5;
const HEAD_RADIUS = 1.8;
// Endpoint sphere at each trajectory start (spawn) + end (target). Sized to
// a fraction of a vehicle footprint so it reads as a "point marker" rather
// than a body — earlier 2.2 m made the sphere larger than the car-shaped
// spawn marker that now sits on top of the same spot.
const ENDPOINT_RADIUS = 1;

/**
 * Sphere + thin dark ring marking a trajectory endpoint, mirroring the
 * search-pin head style so start/end points read the same way as other 3D
 * map markers. Unlit so it stays visible regardless of scene lighting.
 */
function endpointMarker(
  position: THREE.Vector3,
  color: THREE.Color,
): THREE.Group {
  const marker = new THREE.Group();
  marker.position.copy(position);

  const sphereGeo = new THREE.SphereGeometry(ENDPOINT_RADIUS, 16, 12);
  const sphereMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  marker.add(new THREE.Mesh(sphereGeo, sphereMat));

  const ringGeo = new THREE.TorusGeometry(
    ENDPOINT_RADIUS * 1.05,
    0.3,
    8,
    24,
  );
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x0a0a0a,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
  });
  marker.add(new THREE.Mesh(ringGeo, ringMat));

  return marker;
}

/**
 * Build a trajectory group along `points`: a chain of thin cylinders
 * through every point, plus a single cone arrowhead at the destination when
 * the final segment is long enough to host it (otherwise the destination
 * endpoint marker conveys the terminus). Returns null only when there
 * aren't at least 2 points.
 */
export function createTrajectoryLine(
  points: THREE.Vector3[],
  colorHex: string,
): THREE.Group | null {
  if (points.length < 2) return null;

  const color = new THREE.Color(colorHex);
  const group = new THREE.Group();
  group.name = "actor-trajectory";

  // Endpoint markers at the true authored start + destination (before the
  // last segment is shortened below to fit the arrowhead).
  const startPoint = points[0]!;
  const endPoint = points[points.length - 1]!;

  const segments: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    segments.push({ a: points[i]!, b: points[i + 1]! });
  }
  const last = segments[segments.length - 1]!;
  const lastDir = new THREE.Vector3().subVectors(last.b, last.a);
  const lastLen = lastDir.length();
  // Only cap the path with a cone arrowhead when the final segment is long
  // enough to host it. Planner polylines terminate exactly at the conflict
  // point, so the last sample→conflict segment is often a few cm — far too
  // short for the cone. Previously we returned null in that case, which
  // silently dropped the whole vehicle trajectory from the 3D view (the
  // subject, whose route ends at the conflict, vanished while the pedestrian's
  // long final crossing segment still rendered). Now: always draw the full
  // shaft through every point; add the cone only when it fits, and let the
  // destination endpoint marker convey the terminus otherwise.
  const drawCone = lastLen > HEAD_LENGTH;
  if (drawCone) lastDir.normalize();
  const lastShaftEnd = drawCone
    ? new THREE.Vector3()
        .copy(last.a)
        .addScaledVector(lastDir, lastLen - HEAD_LENGTH)
    : null;
  if (drawCone && lastShaftEnd) {
    segments[segments.length - 1] = { a: last.a, b: lastShaftEnd };
  }

  const shaftMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  });

  for (const seg of segments) {
    const dir = new THREE.Vector3().subVectors(seg.b, seg.a);
    const length = dir.length();
    if (length < 0.1) continue;
    dir.normalize();
    const orient = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      dir,
    );
    const shaftGeo = new THREE.CylinderGeometry(
      SHAFT_RADIUS,
      SHAFT_RADIUS,
      length,
      8,
    );
    shaftGeo.translate(0, length / 2, 0);
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.copy(seg.a);
    shaft.setRotationFromQuaternion(orient);
    group.add(shaft);
  }

  if (drawCone && lastShaftEnd) {
    const coneGeo = new THREE.ConeGeometry(HEAD_RADIUS, HEAD_LENGTH, 12);
    coneGeo.translate(0, HEAD_LENGTH / 2, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.copy(lastShaftEnd);
    cone.setRotationFromQuaternion(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        lastDir,
      ),
    );
    group.add(cone);
  }

  group.add(endpointMarker(startPoint, color));
  group.add(endpointMarker(endPoint, color));

  // Initial-heading arrowhead: a small cone at the spawn point pointing
  // along the first segment, so the direction the actor faces at spawn is
  // visible in 3D (mirrors the 2D heading caret).
  const headingDir = new THREE.Vector3().subVectors(points[1]!, startPoint);
  if (headingDir.length() > 1e-3) {
    headingDir.normalize();
    const headGeo = new THREE.ConeGeometry(
      HEAD_RADIUS * 0.8,
      HEAD_LENGTH * 0.8,
      12,
    );
    headGeo.translate(0, (HEAD_LENGTH * 0.8) / 2, 0);
    const headMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
    });
    const headCone = new THREE.Mesh(headGeo, headMat);
    headCone.position
      .copy(startPoint)
      .addScaledVector(headingDir, ENDPOINT_RADIUS);
    headCone.setRotationFromQuaternion(
      new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        headingDir,
      ),
    );
    group.add(headCone);
  }

  return group;
}

export function disposeTrajectoryLine(group: THREE.Group): void {
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
