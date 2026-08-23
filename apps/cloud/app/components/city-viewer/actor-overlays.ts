/**
 * Three.js scene-graph helpers for the diagnostic actor-overlay layer.
 *
 * Builds and disposes the per-frame 3D objects that visualise AI-proposed
 * scenario drafts: the collision-point X-marker and the per-actor spawn
 * markers. Extracted from city-viewer-core.ts to keep that file under
 * 1,000 lines; the CityViewerCore class delegates to these free functions.
 */

import * as THREE from 'three/webgpu';

// ── Collision marker ──────────────────────────────────────────────────────

/**
 * Build the collision-point marker group. The shape mirrors the POI highlight
 * (`location-marker.ts`): flat ground ring + centre disc + tall vertical beacon
 * line so the spot is glanceable at any zoom. On top of those, the red X bars
 * are retained so the marker still reads semantically as "collision here".
 */
export function buildCollisionMarkerGroup(groundY: number, point: { x: number; y: number; z: number }): THREE.Group {
  const group = new THREE.Group();
  group.name = 'collision-marker';
  group.position.set(point.x, groundY, point.z);

  // Visual scale: bar / ring sizes tuned so the marker reads from the
  // cruising-altitude camera distances the digital twin viewer
  // typically frames; the beacon stretches up tall so it remains
  // visible when the X itself is occluded by buildings.
  const BAR_LENGTH = 2;
  const BAR_THICKNESS = 0.3;
  const HEIGHT_OFFSET = 1.2;
  const RING_OUTER_RADIUS = 6;
  const RING_INNER_RADIUS = RING_OUTER_RADIUS * 0.7;
  const DISC_RADIUS = RING_OUTER_RADIUS * 0.18;
  const BEACON_HEIGHT = 30;
  const RING_SEGMENTS = 64;
  const COLLISION_RED = 0xef4444;
  const HALO_DARK = 0x0b1120;

  const solidRedMat = new THREE.MeshBasicMaterial({
    color: COLLISION_RED,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const haloMat = new THREE.MeshBasicMaterial({
    color: HALO_DARK,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  // Softer, semi-transparent variants for the POI-style attention
  // shapes. Mirrors `location-marker.ts`'s ring/disc/beacon opacities
  // so the two highlight conventions sit at the same visual weight.
  const ringMat = new THREE.MeshBasicMaterial({
    color: COLLISION_RED,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const discMat = new THREE.MeshBasicMaterial({
    color: COLLISION_RED,
    transparent: true,
    opacity: 0.65,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const beaconMat = new THREE.LineBasicMaterial({
    color: COLLISION_RED,
    transparent: true,
    opacity: 0.6,
  });

  // POI-style ground ring + center disc — flat on the XZ plane, lifted
  // a hair off the ground to avoid z-fighting against tile geometry.
  const ringGeo = new THREE.RingGeometry(
    RING_INNER_RADIUS,
    RING_OUTER_RADIUS,
    RING_SEGMENTS,
  );
  ringGeo.rotateX(-Math.PI / 2);
  ringGeo.translate(0, 0.05, 0);
  group.add(new THREE.Mesh(ringGeo, ringMat));

  const discGeo = new THREE.CircleGeometry(DISC_RADIUS, 32);
  discGeo.rotateX(-Math.PI / 2);
  discGeo.translate(0, 0.06, 0);
  group.add(new THREE.Mesh(discGeo, discMat));

  // Tall vertical beacon — a single line that stays visible after
  // the X is occluded by buildings / canopy. Same colour as the ring.
  const beaconGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, BEACON_HEIGHT, 0),
  ]);
  group.add(new THREE.Line(beaconGeo, beaconMat));

  // Red X bars (with the dark halo behind) so the marker still says
  // "collision here", distinct from a generic POI highlight.
  const makeBar = (rotationY: number, mat: THREE.MeshBasicMaterial, scale: number) => {
    const geo = new THREE.BoxGeometry(
      BAR_LENGTH * scale,
      BAR_THICKNESS * scale,
      BAR_THICKNESS * scale,
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = HEIGHT_OFFSET;
    mesh.rotation.y = rotationY;
    return mesh;
  };
  group.add(makeBar(Math.PI / 4, haloMat, 1.4));
  group.add(makeBar(-Math.PI / 4, haloMat, 1.4));
  group.add(makeBar(Math.PI / 4, solidRedMat, 1));
  group.add(makeBar(-Math.PI / 4, solidRedMat, 1));

  // Short vertical pole bridging ground → X centre so the X reads as
  // "at this spot" when the camera is pitched steeply.
  const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, HEIGHT_OFFSET, 8);
  poleGeo.translate(0, HEIGHT_OFFSET / 2, 0);
  group.add(new THREE.Mesh(poleGeo, solidRedMat));

  return group;
}

/** Dispose all geometries + materials inside a collision marker group. */
export function disposeCollisionMarkerGroup(group: THREE.Group): void {
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
    // Beacon is a `THREE.Line` (not Mesh) — has its own dispose path.
    if ((obj as THREE.Line).isLine) {
      const line = obj as THREE.Line;
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
  });
}

// ── Actor spawn markers ───────────────────────────────────────────────────

export type SpawnKind = "vehicle" | "walker" | "prop";

export interface SpawnDescriptor {
  id: string;
  kind: SpawnKind;
  color: string;
  yawRad: number | null;
  point: { x: number; y: number; z: number };
}

/**
 * Build the per-actor spawn mesh for one actor. Vehicles render as a colored
 * 4 m × 2 m × 1.5 m box oriented to spawn yaw; walkers render as a capsule
 * sized to a standing pedestrian; props render as a generic cube.
 * Returns null when the groundY sample produces an unexpected value (defensive).
 */
export function buildSpawnMesh(
  spawn: SpawnDescriptor,
  groundY: number,
): THREE.Group | null {
  const group = new THREE.Group();
  group.name = "actor-spawn";
  group.position.set(spawn.point.x, groundY, spawn.point.z);
  if (spawn.yawRad != null) {
    // Same north-vs-east convention as the trajectory module: scene Z
    // is south-positive (Z_SIGN = -1 in geo-utils), so a yaw measured
    // in the runtime east-north frame rotates around scene-Y by
    // `-yaw` to face along the heading.
    group.rotation.y = -spawn.yawRad;
  }

  const color = new THREE.Color(spawn.color);
  const bodyMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
  });
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0x0b1120,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });

  if (spawn.kind === "walker") {
    // ~1.8 m tall, ~0.5 m wide capsule — reads as a person at the
    // camera distances the digital twin viewer typically frames.
    const radius = 0.35;
    const height = 1.8;
    const capsule = new THREE.CapsuleGeometry(radius, height - 2 * radius, 6, 12);
    capsule.translate(0, height / 2, 0);
    group.add(new THREE.Mesh(capsule, bodyMat));
    // Dark base ring so the body separates from the ground/road tile.
    const ring = new THREE.TorusGeometry(radius * 1.15, 0.06, 6, 24);
    ring.translate(0, 0.05, 0);
    ring.rotateX(Math.PI / 2);
    group.add(new THREE.Mesh(ring, haloMat));
    return group;
  }

  if (spawn.kind === "prop") {
    // Generic colored cube — props don't carry blueprint-specific
    // geometry yet.
    const side = 1.0;
    const cube = new THREE.BoxGeometry(side, side, side);
    cube.translate(0, side / 2, 0);
    group.add(new THREE.Mesh(cube, bodyMat));
    return group;
  }

  // Vehicle — colored box sized to a passenger car. Local +X is the
  // direction of travel; group.rotation.y above orients that into the
  // scene frame.
  const length = 4.5;
  const width = 2;
  const height = 1.5;
  const box = new THREE.BoxGeometry(length, height, width);
  box.translate(0, height / 2, 0);
  group.add(new THREE.Mesh(box, bodyMat));

  // Small forward-edge wedge so the heading is readable at a glance —
  // a 0.6 m-tall, half-width slab pulled forward by half the body
  // length. Gives the otherwise-symmetric box a clear "nose".
  const noseGeo = new THREE.BoxGeometry(0.8, height * 0.6, width * 0.85);
  noseGeo.translate(length / 2 + 0.1, height * 0.5, 0);
  group.add(new THREE.Mesh(noseGeo, bodyMat));

  // Dark outline ring along the ground footprint so the marker reads
  // against tile colour just like the search pins do.
  const ring = new THREE.TorusGeometry(
    Math.max(length, width) * 0.55,
    0.08,
    6,
    24,
  );
  ring.translate(0, 0.06, 0);
  ring.rotateX(Math.PI / 2);
  group.add(new THREE.Mesh(ring, haloMat));
  return group;
}

/** Dispose all geometries + materials inside an actor-spawns group. */
export function disposeActorSpawnsGroup(group: THREE.Group): void {
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
