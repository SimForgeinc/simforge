import { Raycaster, Vector3 } from "three";
import type { CameraView, CityViewer } from "@uniscenarios/city-renderer";

/**
 * Azimuth search for an unobstructed shot.
 *
 * ## Why an analytic camera is not enough
 *
 * The director solves its azimuth from the interaction sightline, which on a
 * real city map is frequently occupied by a building, a bus shelter, or street
 * trees. The offline exporter hit exactly this and answered it with
 * `CAMERA_SEARCH_OFFSETS` in `scripts/export-render.mjs`: orbit the fitted
 * camera around its own target until every framing actor has line of sight, and
 * keep the accepted offset sticky so the shot does not jitter frame to frame.
 * Its authoritative check, `inspectIncidentComposition`, raycast from the eye to
 * each actor through the static city and vegetation layers — which is what this
 * module does against the same two groups.
 *
 * The offline version re-ran the search per frame, each candidate paying a
 * `waitForStreamIdle` and a settle: seconds of work per still. Real-time
 * playback cannot afford that, so the search runs **once per shot** when the
 * shot becomes active and its result is reused for the shot's whole window.
 *
 * This is the only part of the director that touches the scene graph, which is
 * why it lives apart from the pure solver.
 */

/** Azimuth candidates in degrees, tried in order. Mirrors the offline ladder. */
export const CLEARANCE_AZIMUTHS_DEG: readonly number[] = [0, 25, -25, 55, -55, 90, -90, 125, -125];

/** Minimum horizontal gap between the eye and any framing actor, metres. */
const MIN_EYE_CLEARANCE_M = 2;
/**
 * Slack on the ray length so the actor's own surroundings do not read as a
 * blocker. The offline gate did the same by stopping the ray short of the actor
 * centre it was testing.
 */
const RAY_SHORTENING_M = 1.5;

export interface ClearanceProbe {
  readonly x: number;
  readonly z: number;
  /** Ray endpoint height, normally mid-body of the framed actor. */
  readonly y: number;
}

/**
 * First azimuth bias whose eye clears every actor footprint and holds line of
 * sight to every probe, in radians.
 *
 * Falls back to `0` when no candidate clears: a partly obstructed shot is better
 * than a camera parked inside a wall, and the sequence moves on at the next cut.
 */
export function solveClearanceBias(
  viewer: CityViewer,
  solveView: (azimuthBiasRad: number) => CameraView | null,
  probes: readonly ClearanceProbe[],
): number {
  if (probes.length === 0) return 0;
  const raycaster = new Raycaster();
  const origin = new Vector3();
  const direction = new Vector3();
  const targets = [viewer.cityGroup, viewer.vegetationGroup];

  for (const degrees of CLEARANCE_AZIMUTHS_DEG) {
    const bias = (degrees * Math.PI) / 180;
    const view = solveView(bias);
    if (!view) continue;
    const [eyeX, eyeY, eyeZ] = view.position;
    if (probes.some((probe) => Math.hypot(eyeX - probe.x, eyeZ - probe.z) < MIN_EYE_CLEARANCE_M)) continue;

    origin.set(eyeX, eyeY, eyeZ);
    const clear = probes.every((probe) => {
      direction.set(probe.x - eyeX, probe.y - eyeY, probe.z - eyeZ);
      const distance = direction.length();
      if (distance <= RAY_SHORTENING_M) return true;
      raycaster.set(origin, direction.normalize());
      raycaster.near = 0;
      raycaster.far = distance - RAY_SHORTENING_M;
      // A shot is judged against whatever is resident right now. Streaming in a
      // further tile can only ever be corrected at the next cut, and blocking
      // playback on stream-idle is exactly the offline cost this avoids.
      return raycaster.intersectObjects(targets, true).length === 0;
    });
    if (clear) return bias;
  }
  return 0;
}
