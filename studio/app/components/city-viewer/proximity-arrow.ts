/**
 * 3D proximity arrows for spatial- and topology-search results in the
 * CityViewer.
 *
 * Spatial relations (`near` / `within` / `adjacent_to`) draw a single
 * straight shaft from the focused subject's position to its matched
 * neighbor's position, capped with a cone arrowhead — the 3D mirror of
 * the 2D dashed straight arrow. Topology relations (`leads_to` and
 * friends) pass in the full subject + path-step sequence so the arrow
 * traces every hop in the graph route, with a single arrowhead at the
 * destination.
 *
 * Geometry is in scene units (meters, lon/lat-local) to match how
 * `geo-utils.lonLatToScene` positions everything else. Callers snap Y to
 * ground via `CityViewerCore.sampleGroundY` before handing off.
 */

import * as THREE from "three/webgpu";

const COLOR = 0x60a5fa; // muted sky blue — matches C.related
const SHAFT_RADIUS = 0.4;
const SHAFT_RADIUS_HL = 0.75;
const HEAD_LENGTH = 6;
const HEAD_RADIUS = 2;
const HEAD_LENGTH_HL = 9;
const HEAD_RADIUS_HL = 3;

/**
 * Builds an arrow group along the supplied path. With two points the
 * result matches the legacy single-segment arrow exactly; with more, the
 * shaft is a chain of cylinders one per segment, plus a single cone head
 * at the destination oriented along the final segment. `highlight` swaps
 * in the thicker / brighter variant for the pinned ref.
 */
export function createProximityArrow(
  points: THREE.Vector3[],
  highlight: boolean = false,
): THREE.Group | null {
  if (points.length < 2) return null;

  const group = new THREE.Group();
  group.name = "proximity-arrow";

  const shaftRadius = highlight ? SHAFT_RADIUS_HL : SHAFT_RADIUS;
  const shaftOpacity = highlight ? 0.9 : 0.55;
  const headLength = highlight ? HEAD_LENGTH_HL : HEAD_LENGTH;
  const headRadius = highlight ? HEAD_RADIUS_HL : HEAD_RADIUS;
  const headOpacity = highlight ? 1 : 0.8;

  // Render each segment as its own cylinder. The last segment is shortened
  // by `headLength` so the cone (drawn separately) fits on the destination
  // without poking past it. Reject the whole arrow if the final segment
  // can't accommodate the cone.
  const segments: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    segments.push({ a: points[i]!, b: points[i + 1]! });
  }
  const last = segments[segments.length - 1]!;
  const lastDir = new THREE.Vector3().subVectors(last.b, last.a);
  const lastLen = lastDir.length();
  if (lastLen < headLength * 0.5) return null;
  lastDir.normalize();
  const lastShaftEnd = new THREE.Vector3()
    .copy(last.a)
    .addScaledVector(lastDir, Math.max(0, lastLen - headLength));
  // Replace the last segment's endpoint with the head's base position so
  // the shaft doesn't overlap the cone.
  segments[segments.length - 1] = { a: last.a, b: lastShaftEnd };

  const shaftMat = new THREE.MeshBasicMaterial({
    color: COLOR,
    transparent: true,
    opacity: shaftOpacity,
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
      shaftRadius,
      shaftRadius,
      length,
      8,
    );
    shaftGeo.translate(0, length / 2, 0);
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    shaft.position.copy(seg.a);
    shaft.setRotationFromQuaternion(orient);
    group.add(shaft);
  }

  // Single arrowhead at the destination, oriented along the final segment.
  const coneGeo = new THREE.ConeGeometry(headRadius, headLength, 12);
  coneGeo.translate(0, headLength / 2, 0);
  const coneMat = new THREE.MeshBasicMaterial({
    color: COLOR,
    transparent: true,
    opacity: headOpacity,
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

  return group;
}

export function disposeProximityArrow(group: THREE.Group): void {
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
