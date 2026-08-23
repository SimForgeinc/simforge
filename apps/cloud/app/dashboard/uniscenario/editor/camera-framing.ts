import { Vector3 } from "three";
import type { SampledActor } from "@uniscenarios/playback";

/**
 * Camera framing the editor surface owns, as opposed to the deliberate
 * document-pose framing in `EditorController.frameActor`.
 *
 * The distinction matters during playback. `EditorController` resolves an actor
 * through `doc.actor(id)`, which is the authored *spawn* placement, so framing a
 * moving actor from the timeline flew the camera to where the car started
 * rather than where it is on screen. While playback owns the scene the poses
 * come from the trace, and the only pose that matches what the author is
 * looking at is the sample at the playhead.
 */

/** The slice of `CityViewer` a camera flight needs. */
export type FramingViewer = {
  readonly controls: {
    getView(): {
      readonly position: readonly [number, number, number];
      readonly target: readonly [number, number, number];
    };
    setView(position: Vector3, target: Vector3): void;
  };
};

/** A pose that can be framed: playhead sample or authored placement. */
export type FrameableActor = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly dims: { readonly l: number; readonly h: number };
};

/** Matches `EditorController.frameActor` so both paths settle at one distance. */
const FLIGHT_MS = 320;

export function actorFrameDistance(dims: FrameableActor["dims"]): number {
  return Math.max(14, Math.min(42, Math.max(dims.l, dims.h) * 4.5));
}

/**
 * Which pose the timeline should fly to for `actorId`.
 *
 * `inspecting` is the flag that says playback — not the editor — is presenting
 * the scene. A sample is used only when the actor is `present` at the playhead;
 * an actor that has not spawned yet, or has already been removed, has no
 * on-screen position, so its authored placement is the honest target.
 */
export function resolveActorFrameTarget({
  actorId,
  inspecting,
  sampledActors,
  authored,
  sampleHeight,
}: {
  actorId: string;
  inspecting: boolean;
  sampledActors: readonly SampledActor[] | null | undefined;
  authored: FrameableActor | null | undefined;
  sampleHeight: (x: number, z: number) => number | null;
}): FrameableActor | null {
  if (inspecting && sampledActors) {
    const sampled = sampledActors.find(
      (candidate) => candidate.id === actorId && candidate.present,
    );
    if (sampled) {
      return {
        x: sampled.x,
        y: sampleHeight(sampled.x, sampled.z) ?? authored?.y ?? 0,
        z: sampled.z,
        dims: sampled.dims,
      };
    }
  }
  return authored ?? null;
}

/**
 * Ease the camera to `target` while keeping the current view direction, and
 * return the cancel handle so one surface never runs two flights at once.
 */
export function flyCameraTo(
  viewer: FramingViewer,
  target: Vector3,
  distance: number,
): () => void {
  const from = viewer.controls.getView();
  const startPosition = new Vector3(...from.position);
  const startTarget = new Vector3(...from.target);
  const direction = startPosition.clone().sub(startTarget);
  if (direction.lengthSq() < 0.001) direction.set(1, 0.8, 1);
  const destination = target
    .clone()
    .add(direction.normalize().multiplyScalar(distance));
  const position = new Vector3();
  const lookAt = new Vector3();
  const startedAt = performance.now();
  let handle = 0;
  const tick = (now: number): void => {
    const linear = Math.min(1, (now - startedAt) / FLIGHT_MS);
    const eased = 1 - Math.pow(1 - linear, 3);
    viewer.controls.setView(
      position.copy(startPosition).lerp(destination, eased),
      lookAt.copy(startTarget).lerp(target, eased),
    );
    handle = linear < 1 ? requestAnimationFrame(tick) : 0;
  };
  handle = requestAnimationFrame(tick);
  return () => {
    if (handle) cancelAnimationFrame(handle);
    handle = 0;
  };
}

/**
 * Keep the camera looking at a moving actor.
 *
 * Clicking a car mid-playback used to fly once to wherever it happened to be and
 * stop, so by the time the flight settled the car had driven out of frame. This
 * follows it instead, and does so by translating the whole rig: every frame the
 * offset between camera and orbit target is read back from the controls and
 * reapplied to the actor's live position, so distance and angles are whatever
 * the author last set. We never recompute a framing distance here — that is what
 * `flyCameraTo` is for, and doing it while tracking would yank the zoom out from
 * under the author.
 *
 * Reading the offset live rather than capturing it once is what lets the author
 * keep orbiting and dollying while the car moves: their gesture rotates around
 * the target we just set, which is the car, and the next frame preserves the
 * angle they landed on.
 *
 * The first `FLIGHT_MS` ease the look-at point over from wherever it was so the
 * pick does not snap; because the offset is preserved throughout, that ease is a
 * translation and not an orbit change.
 *
 * `resolveTarget` returning null means the actor has no on-screen pose — it has
 * despawned, or playback moved past its window. The camera then holds still
 * rather than diving to the origin, and picks the actor up again if it returns.
 */
export function followActorCamera(
  viewer: FramingViewer,
  resolveTarget: () => FrameableActor | null,
): () => void {
  const startTarget = new Vector3(...viewer.controls.getView().target);
  const startedAt = performance.now();
  // Preallocated: this runs every animation frame for as long as the author
  // watches the car, so it must not litter the heap with vectors.
  const offset = new Vector3();
  const wanted = new Vector3();
  const lookAt = new Vector3();
  const position = new Vector3();
  let handle = 0;
  const tick = (now: number): void => {
    const target = resolveTarget();
    if (target) {
      const view = viewer.controls.getView();
      offset
        .set(view.position[0], view.position[1], view.position[2])
        .sub(wanted.set(view.target[0], view.target[1], view.target[2]));
      wanted.set(target.x, target.y + target.dims.h * 0.5, target.z);
      const linear = Math.min(1, (now - startedAt) / FLIGHT_MS);
      const eased = 1 - Math.pow(1 - linear, 3);
      lookAt.copy(startTarget).lerp(wanted, eased);
      viewer.controls.setView(position.copy(lookAt).add(offset), lookAt);
    }
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return () => {
    if (handle) cancelAnimationFrame(handle);
    handle = 0;
  };
}

/**
 * Has a follow outlived what started it?
 *
 * Two things end a follow, and both have to, because each is reachable when the
 * other is not.
 *
 * The selection: following a car is a consequence of having that car selected,
 * so deselecting it, closing its details panel, deleting it or picking up a tool
 * all hand the camera back.
 *
 * Playback presenting the scene: a follow only exists while playback owns the
 * actors, so leaving the simulation ends it too. This is the one that is
 * reachable mid-follow today — while the simulation is running the details panel
 * has no close button and viewport clicks do not deselect, so the selection
 * never changes and it alone would never fire. Without this the loop outlives the
 * simulation and keeps writing the view every frame, which reads as a camera
 * that will not let go.
 */
export function shouldReleaseFollowedActor({
  followedActorId,
  selection,
  presenting,
}: {
  /** The actor the camera is following, or null when the camera is not following. */
  followedActorId: string | null;
  /** The current actor selection. Undefined while the editor has no state yet. */
  selection: readonly string[] | undefined;
  /** Whether playback still owns the scene, i.e. there is a live pose to track. */
  presenting: boolean;
}): boolean {
  if (!followedActorId) return false;
  if (!presenting) return true;
  // No state yet is not a deselection: the editor is still coming up, and
  // dropping the follow here would cancel it on the frame it started.
  if (!selection) return false;
  return !selection.includes(followedActorId);
}
