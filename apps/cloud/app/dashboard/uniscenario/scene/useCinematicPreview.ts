"use client";

import { useEffect, useMemo, useState } from "react";
import type { CityViewer } from "@uniscenarios/city-renderer";
import {
  samplePlaybackActors,
  type PlaybackBundle,
  type PlaybackController,
} from "@uniscenarios/playback";
import {
  buildCinematicShotList,
  cinematicViewAt,
  shotAt,
  type CinematicDashMount,
  type CinematicShot,
  type CinematicShotList,
} from "./cinematic-director";
import { solveClearanceBias, type ClearanceProbe } from "./cinematic-shot-clearance";
import { interpolateMapView } from "./map-camera-transition";

/**
 * Runtime owner of the cinematic camera on the list surface.
 *
 * ## One camera, one owner
 *
 * Three things can move the list camera: the idle street tour, the single-actor
 * framing transition, and now the director. They cannot overlap — a shared
 * viewer with two writers produces a camera that visibly fights itself, which is
 * exactly why `useUniScenarioSession` pins the playback policy to `free` and
 * warns against auto-framing during authoring. The invariant is enforced by the
 * call sites: the tour runs only without a selected document, the director only
 * with one, and the framing transition is the at-rest pose the director replaces
 * while it is engaged.
 *
 * The director writes through `viewer.applyView`, the same channel the framing
 * transition on this surface already uses, rather than a `PlaybackController`
 * camera policy. Policies hold one sustained composition; this needs to cut.
 *
 * ## Release on touch
 *
 * A preview that fights the mouse is worse than no preview. Any pointer, wheel,
 * or key interaction hands the camera back for `RESUME_IDLE_MS`, after which the
 * director picks the current shot back up mid-clip — the same contract as the
 * street tour's `interruptible`.
 */

const RESUME_IDLE_MS = 6_000;
/** Blend time across a cut. Long enough to read as an edit, short enough to feel deliberate. */
const CUT_BLEND_MS = 260;
/** Mid-body height for line-of-sight probes when an actor's box is unknown. */
const DEFAULT_PROBE_HEIGHT_M = 0.9;

function reducedMotionRequested(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface UseCinematicPreviewOptions {
  /** Engage only when this surface owns the camera and the map is resident. */
  readonly enabled: boolean;
  readonly viewer: CityViewer | null;
  readonly bundle: PlaybackBundle | null;
  readonly controller: PlaybackController | null;
  /** Preferred following subject, normally the sensor-owning actor. */
  readonly subjectActorId?: string | null;
  readonly dashMount?: CinematicDashMount | null;
}

export interface CinematicPreviewHandle {
  /** The solved sequence, or `null` when this scenario cannot be directed. */
  readonly shotList: CinematicShotList | null;
  /** The shot on screen. Updates on cuts only, never per frame. */
  readonly activeShot: CinematicShot | null;
  /** Whether the director currently owns the camera. */
  readonly engaged: boolean;
}

export function useCinematicPreview({
  enabled,
  viewer,
  bundle,
  controller,
  subjectActorId,
  dashMount,
}: UseCinematicPreviewOptions): CinematicPreviewHandle {
  const [activeShot, setActiveShot] = useState<CinematicShot | null>(null);
  const [engaged, setEngaged] = useState(false);

  // A recompiled scenario arrives as a new bundle object, so identity is the
  // correct cache key: the cut sequence is re-solved exactly when the trace it
  // describes changes.
  const shotList = useMemo(
    () => (bundle ? buildCinematicShotList(bundle, { subjectActorId, dashMount }) : null),
    [bundle, subjectActorId, dashMount],
  );

  useEffect(() => {
    setActiveShot(null);
    setEngaged(false);
    if (!enabled || !viewer || !bundle || !shotList || !controller) return;
    if (reducedMotionRequested()) return;

    let disposed = false;
    let frame = 0;
    let releasedUntil = 0;
    let currentShot: CinematicShot | null = null;
    let clearanceBias = 0;
    let cutStartedAt = 0;
    let cutFrom = viewer.captureView();
    const activeViewer = viewer;
    const groundIndex = activeViewer.getGroundIndex() ?? activeViewer.buildGroundIndex();
    const sampleGround = (x: number, z: number) => groundIndex?.sample(x, z) ?? 0;

    /**
     * Re-seat the shot's azimuth once, when the cut happens.
     *
     * Probes are the framing actors' mid-body points at the instant the shot
     * opens. Sampling once per shot is the whole reason this is affordable at 60
     * fps, and a shot that starts clear stays acceptable for its window.
     */
    const solveBias = (shot: CinematicShot, time: number): number => {
      const sampleT = shot.frozenAtT ?? time;
      const actors = samplePlaybackActors(bundle, sampleT);
      const wanted = new Set(shot.framingActorIds);
      const probes: ClearanceProbe[] = actors
        .filter((actor) => actor.present && wanted.has(actor.id))
        .map((actor) => ({
          x: actor.x,
          z: actor.z,
          y: sampleGround(actor.x, actor.z) + Math.max(DEFAULT_PROBE_HEIGHT_M, actor.dims.h * 0.52),
        }));
      if (probes.length === 0) return 0;
      return solveClearanceBias(
        activeViewer,
        (azimuthBiasRad) => cinematicViewAt({ bundle, shotList, time, sampleGround, dashMount, azimuthBiasRad }),
        probes,
      );
    };

    const tick = (now: number) => {
      if (disposed) return;
      frame = window.requestAnimationFrame(tick);
      if (now < releasedUntil) return;
      if (releasedUntil !== 0) {
        // Re-engaging mid-clip: blend in from wherever the user left the camera
        // instead of snapping to the shot.
        releasedUntil = 0;
        cutFrom = activeViewer.captureView();
        cutStartedAt = now;
        setEngaged(true);
      }

      const time = controller.state.time;
      const shot = shotAt(shotList, time);
      if (shot !== currentShot) {
        cutFrom = activeViewer.captureView();
        cutStartedAt = now;
        currentShot = shot;
        clearanceBias = solveBias(shot, time);
        setActiveShot(shot);
      }

      const view = cinematicViewAt({
        bundle,
        shotList,
        time,
        sampleGround,
        dashMount,
        azimuthBiasRad: clearanceBias,
      });
      if (!view) return;
      const blend = (now - cutStartedAt) / CUT_BLEND_MS;
      activeViewer.applyView(blend >= 1 ? view : interpolateMapView(cutFrom, view, blend));
    };

    const release = () => {
      releasedUntil = performance.now() + RESUME_IDLE_MS;
      setEngaged(false);
    };
    const handleVisibility = () => {
      if (document.hidden) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      } else if (frame === 0) {
        frame = window.requestAnimationFrame(tick);
      }
    };

    window.addEventListener("pointerdown", release, true);
    window.addEventListener("wheel", release, { capture: true, passive: true });
    window.addEventListener("keydown", release, true);
    document.addEventListener("visibilitychange", handleVisibility);
    setEngaged(true);
    frame = window.requestAnimationFrame(tick);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", release, true);
      window.removeEventListener("wheel", release, true);
      window.removeEventListener("keydown", release, true);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [bundle, controller, dashMount, enabled, shotList, viewer]);

  return { shotList, activeShot, engaged };
}
