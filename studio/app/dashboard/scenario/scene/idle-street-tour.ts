import type { DirectedLane } from "@simforge-oss/engine";
import type { CameraView } from "@simforge-oss/viewer";

const MIN_START_LANE_METERS = 24;
const TARGET_TOUR_METERS = 720;
const MAX_TOUR_LEGS = 48;
const CAMERA_HEIGHT_METERS = 3.8;
const TARGET_HEIGHT_METERS = 1.7;
const LOOK_AHEAD_METERS = 18;
const CINEMATIC_EYE_SWAY_METERS = 1.35;
const CINEMATIC_LOOK_SWAY_METERS = 3.2;
const DRONE_TRANSFER_LIFT_METERS = 42;

type StreetGeometry = {
  readonly lengthM: number;
  readonly lane: {
    readonly laneType: string;
    readonly isJunction?: boolean;
  };
};

export interface StreetTourGraph {
  laneRsls(): string[];
  geometry(rsl: string): StreetGeometry | undefined;
  nominalReversed(rsl: string): boolean | null;
  successors(lane: DirectedLane): DirectedLane[];
  sampleDirected(
    lane: DirectedLane,
    distance: number,
  ): { point: { x: number; y: number }; headingRad: number };
}

export type StreetTourLeg = DirectedLane & {
  readonly startM: number;
  readonly endM: number;
  readonly tourStartM: number;
};

export type StreetTour = {
  readonly graph: StreetTourGraph;
  readonly legs: readonly StreetTourLeg[];
  readonly lengthM: number;
};

function angleDelta(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
}

function randomItem<T>(items: readonly T[], random: () => number): T | null {
  if (items.length === 0) return null;
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  return items[index] ?? null;
}

/** Build a legal, connected lane walk suitable for a slow ambient camera pass. */
export function buildStreetTour(
  graph: StreetTourGraph,
  random: () => number = Math.random,
): StreetTour | null {
  const starts = graph.laneRsls().filter((rsl) => {
    const geometry = graph.geometry(rsl);
    return Boolean(
      geometry &&
        geometry.lane.laneType === "driving" &&
        !geometry.lane.isJunction &&
        geometry.lengthM >= MIN_START_LANE_METERS &&
        graph.nominalReversed(rsl) !== null,
    );
  });
  const startRsl = randomItem(starts, random);
  if (!startRsl) return null;

  let current: DirectedLane = {
    rsl: startRsl,
    reversed: graph.nominalReversed(startRsl) ?? false,
  };
  const firstLength = graph.geometry(startRsl)?.lengthM ?? 0;
  let startM = Math.min(firstLength * 0.2, 18);
  let lengthM = 0;
  const seen = new Set<string>();
  const legs: StreetTourLeg[] = [];

  for (
    let step = 0;
    step < MAX_TOUR_LEGS && lengthM < TARGET_TOUR_METERS;
    step += 1
  ) {
    const geometry = graph.geometry(current.rsl);
    if (!geometry || geometry.lane.laneType !== "driving") break;
    const endM = geometry.lengthM;
    if (endM - startM > 0.5) {
      legs.push({ ...current, startM, endM, tourStartM: lengthM });
      lengthM += endM - startM;
    }
    seen.add(`${current.rsl}${current.reversed ? "#r" : "#f"}`);

    const exitHeading = graph.sampleDirected(current, endM).headingRad;
    const next = graph
      .successors(current)
      .filter((candidate) => {
        const candidateGeometry = graph.geometry(candidate.rsl);
        return (
          candidateGeometry?.lane.laneType === "driving" &&
          !seen.has(`${candidate.rsl}${candidate.reversed ? "#r" : "#f"}`)
        );
      })
      .sort((a, b) => {
        const aHeading = graph.sampleDirected(a, 0).headingRad;
        const bHeading = graph.sampleDirected(b, 0).headingRad;
        return (
          angleDelta(exitHeading, aHeading) -
            angleDelta(exitHeading, bHeading) ||
          a.rsl.localeCompare(b.rsl)
        );
      });
    if (next.length === 0) break;

    // Usually continue straight, occasionally take the next-most-natural turn
    // so repeat visits do not become the exact same camera path.
    const choicePool = next.slice(0, Math.min(3, next.length));
    current = random() < 0.72 ? (choicePool[0] as DirectedLane) : (randomItem(choicePool, random) as DirectedLane);
    startM = 0;
  }

  return legs.length > 0 ? { graph, legs, lengthM } : null;
}

function sampleTour(
  tour: StreetTour,
  distanceM: number,
): { x: number; z: number; headingRad: number } {
  const distance = Math.min(tour.lengthM, Math.max(0, distanceM));
  let leg = tour.legs[tour.legs.length - 1] as StreetTourLeg;
  for (const candidate of tour.legs) {
    if (distance <= candidate.tourStartM + candidate.endM - candidate.startM) {
      leg = candidate;
      break;
    }
  }
  const laneDistance = Math.min(
    leg.endM,
    leg.startM + Math.max(0, distance - leg.tourStartM),
  );
  const sample = tour.graph.sampleDirected(leg, laneDistance);
  return {
    x: sample.point.x,
    z: -sample.point.y || 0,
    headingRad: sample.headingRad,
  };
}

/** A low, forward-looking camera pose sampled from the road route. */
export function streetTourCameraView(
  tour: StreetTour,
  distanceM: number,
  groundHeight: (x: number, z: number) => number | null,
  cinematicSeconds?: number,
): CameraView {
  const eye = sampleTour(tour, distanceM);
  const ahead = sampleTour(
    tour,
    Math.min(tour.lengthM, distanceM + LOOK_AHEAD_METERS),
  );
  const eyeY = groundHeight(eye.x, eye.z) ?? 0;
  const targetY = groundHeight(ahead.x, ahead.z) ?? eyeY;
  const cinematic = cinematicSeconds !== undefined;
  const dx = ahead.x - eye.x;
  const dz = ahead.z - eye.z;
  const planarLength = Math.max(0.001, Math.hypot(dx, dz));
  const rightX = -dz / planarLength;
  const rightZ = dx / planarLength;
  const eyeSway = cinematic
    ? Math.sin(cinematicSeconds * 0.42) * CINEMATIC_EYE_SWAY_METERS
    : 0;
  const lookSway = cinematic
    ? Math.sin(cinematicSeconds * 0.31 + 0.7) * CINEMATIC_LOOK_SWAY_METERS
    : 0;
  const float = cinematic ? Math.sin(cinematicSeconds * 0.55) * 0.22 : 0;
  return {
    position: [
      eye.x + rightX * eyeSway,
      eyeY + CAMERA_HEIGHT_METERS + float,
      eye.z + rightZ * eyeSway,
    ],
    target: [
      ahead.x + rightX * lookSway,
      targetY + TARGET_HEIGHT_METERS + float * 0.35,
      ahead.z + rightZ * lookSway,
    ],
    fov: cinematic ? 57 + Math.sin(cinematicSeconds * 0.24) * 1.25 : 58,
  };
}

function smootherStep(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** A continuous drone-like rise, overhead glide, and descent between streets. */
export function droneTransferCameraView(
  from: CameraView,
  to: CameraView,
  progress: number,
): CameraView {
  const t = smootherStep(progress);
  const mix = (start: number, end: number) => start + (end - start) * t;
  // Squared sine has zero slope at both ends, preventing a visible bump when
  // control passes between street motion and the aerial transfer.
  const arc = Math.sin(Math.PI * Math.min(1, Math.max(0, progress))) ** 2;
  const lift = DRONE_TRANSFER_LIFT_METERS * arc;
  return {
    position: [
      mix(from.position[0], to.position[0]),
      mix(from.position[1], to.position[1]) + lift,
      mix(from.position[2], to.position[2]),
    ],
    target: [
      mix(from.target[0], to.target[0]),
      mix(from.target[1], to.target[1]) + lift * 0.18,
      mix(from.target[2], to.target[2]),
    ],
    fov: mix(from.fov, to.fov) + arc * 4,
  };
}

function cameraAngles(view: CameraView): { yaw: number; pitch: number } {
  const dx = view.target[0] - view.position[0];
  const dy = view.target[1] - view.position[1];
  const dz = view.target[2] - view.position[2];
  return {
    yaw: Math.atan2(dx, dz),
    pitch: Math.atan2(dy, Math.max(0.001, Math.hypot(dx, dz))),
  };
}

function wrappedAngleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** Read only the look rotation introduced between two camera views. */
export function cameraLookDelta(
  from: CameraView,
  to: CameraView,
): { yaw: number; pitch: number } {
  const start = cameraAngles(from);
  const end = cameraAngles(to);
  return {
    yaw: wrappedAngleDelta(start.yaw, end.yaw),
    pitch: end.pitch - start.pitch,
  };
}

/** Layer a user's look direction over a continuously moving tour camera. */
export function withCameraLookOffset(
  view: CameraView,
  yawOffset: number,
  pitchOffset: number,
): CameraView {
  const dx = view.target[0] - view.position[0];
  const dy = view.target[1] - view.position[1];
  const dz = view.target[2] - view.position[2];
  const distance = Math.max(0.001, Math.hypot(dx, dy, dz));
  const base = cameraAngles(view);
  const yaw = base.yaw + yawOffset;
  const pitch = Math.max(
    -Math.PI * 0.44,
    Math.min(Math.PI * 0.44, base.pitch + pitchOffset),
  );
  const horizontal = Math.cos(pitch) * distance;
  return {
    ...view,
    target: [
      view.position[0] + Math.sin(yaw) * horizontal,
      view.position[1] + Math.sin(pitch) * distance,
      view.position[2] + Math.cos(yaw) * horizontal,
    ],
  };
}
