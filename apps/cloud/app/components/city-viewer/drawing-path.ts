/**
 * The path an author is drawing right now, rendered into the twin.
 *
 * Sibling of `actor-trajectory.ts` and deliberately not the same thing. That
 * module draws a FINISHED plan: at least two points, an arrowhead at the
 * destination, one colour. This one draws a path mid-authoring, which has three
 * states that module cannot express — nothing placed yet, exactly one point
 * placed (no segment exists), and a live segment chasing the cursor that is not
 * committed to anything.
 *
 * It also has to say something that module never needed to: whether each point
 * is stuck to a lane or floating free. That is the whole distinction between
 * "drive down this road" and "cut across this car park", it is stored per point
 * as `snap` on the waypoint, and if the author cannot see it they cannot tell
 * the two apart until the simulation runs.
 *
 * Geometry is in scene units (metres, x = east, y = up, −z = north) to match
 * `geo-utils.lonLatToScene`; the caller snaps Y to the surface via
 * `CityViewerCore.pickGround` before handing points over.
 */

import * as THREE from "three/webgpu";

/** Editor yellow — the accent every armed authoring surface already uses. */
const LANE_COLOR = "#E8E044";
/** Freeform points read cooler, so a mixed path is legible at a glance. */
const FREE_COLOR = "#7DD3FC";
/** The uncommitted leg from the last point to wherever the pointer is. */
const CURSOR_COLOR = "#FFFFFF";

const SHAFT_RADIUS = 0.35;
const POINT_RADIUS = 0.9;
const CURSOR_RING_RADIUS = 1.6;
/** Points sit this far above the surface so they are not z-fought by the road. */
const LIFT_M = 0.5;

export interface DrawingPathPoint {
  x: number;
  y: number;
  z: number;
  /** Absent reads as free, matching the waypoint schema's optional `snap`. */
  snap?: "lane" | "free";
}

function pointColor(point: DrawingPathPoint): string {
  return point.snap === "lane" ? LANE_COLOR : FREE_COLOR;
}

function unlit(color: string, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity,
    depthWrite: false,
  });
}

/**
 * One placed point: a small sphere with a flat ground ring under it.
 *
 * The ring is what makes the point readable at a shallow camera angle — a bare
 * sphere at 60 m reads as a dot of ambiguous height, and "is that point on the
 * road or floating above it" is exactly the question an author is asking.
 */
function pointMarker(point: DrawingPathPoint, index: number): THREE.Group {
  const marker = new THREE.Group();
  marker.name = `drawing-path-point-${index}`;
  marker.position.set(point.x, point.y + LIFT_M, point.z);

  const color = pointColor(point);
  marker.add(new THREE.Mesh(new THREE.SphereGeometry(POINT_RADIUS, 16, 12), unlit(color, 0.95)));

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(POINT_RADIUS * 1.4, POINT_RADIUS * 2.1, 24),
    unlit(color, 0.5),
  );
  // RingGeometry is built in the XY plane; lay it flat on the ground.
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -LIFT_M + 0.05;
  marker.add(ring);

  return marker;
}

/** A cylinder from `a` to `b`, oriented the way `actor-trajectory` does it. */
function segment(
  a: THREE.Vector3,
  b: THREE.Vector3,
  material: THREE.Material,
): THREE.Mesh | null {
  const dir = new THREE.Vector3().subVectors(b, a);
  const length = dir.length();
  if (length < 1e-3) return null;

  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(SHAFT_RADIUS, SHAFT_RADIUS, length, 8),
    material,
  );
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  // The cylinder's own axis is +y; rotate that onto the segment direction.
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize(),
  );
  return mesh;
}

/**
 * Build the in-progress path group.
 *
 * Returns an empty group rather than null when there is nothing to draw, so the
 * caller's add/remove bookkeeping stays uniform across the arming transition —
 * arming with zero points still puts a (currently empty) group in the scene,
 * and the first click fills it rather than creating it.
 */
export function createDrawingPath(
  points: readonly DrawingPathPoint[],
  cursor: { x: number; y: number; z: number } | null,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "drawing-path";

  const lifted = points.map((p) => new THREE.Vector3(p.x, p.y + LIFT_M, p.z));

  // Committed legs. Each takes the colour of the point it ARRIVES at, so a leg
  // that leaves the road is visibly the leg that leaves the road.
  for (let i = 0; i < lifted.length - 1; i += 1) {
    const leg = segment(lifted[i]!, lifted[i + 1]!, unlit(pointColor(points[i + 1]!), 0.85));
    if (leg) group.add(leg);
  }

  for (const [index, point] of points.entries()) {
    group.add(pointMarker(point, index));
  }

  if (cursor) {
    const cursorVec = new THREE.Vector3(cursor.x, cursor.y + LIFT_M, cursor.z);
    // The uncommitted leg, dimmer than a placed one: it shows where the next
    // click would land without claiming the click has happened.
    const last = lifted[lifted.length - 1];
    if (last) {
      const preview = segment(last, cursorVec, unlit(CURSOR_COLOR, 0.35));
      if (preview) group.add(preview);
    }

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(CURSOR_RING_RADIUS * 0.62, CURSOR_RING_RADIUS, 28),
      unlit(CURSOR_COLOR, 0.7),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(cursor.x, cursor.y + 0.06, cursor.z);
    group.add(ring);
  }

  return group;
}

/** Free every geometry and material the group owns. Mirrors `disposeTrajectoryLine`. */
export function disposeDrawingPath(group: THREE.Group): void {
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((m) => m.dispose());
    } else {
      mesh.material.dispose();
    }
  });
}
