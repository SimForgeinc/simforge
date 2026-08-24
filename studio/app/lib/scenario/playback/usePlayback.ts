"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CameraView, CityViewer } from '@simforge/viewer';
import {
  PlaybackController,
  createPlaybackVerticalMotion,
  type CollisionActorOverrides,
  type PlaybackBundle,
  type PlaybackState,
  withCollisionActorOverrides,
  withPlaybackVerticalMotion,
} from '@simforge/playback';
import type { MapOverlayHandle } from '../mapOverlays';
import type { CameraPolicy } from '@simforge/viewer';
import type { DashCameraSensor } from '@simforge/scenario';
import type { ActorRenderer } from '@simforge/viewer';
import { createRestingHeading, withRestingHeading } from '@simforge/playback';

export interface UsePlaybackOptions {
  viewer: CityViewer | null;
  bundle: PlaybackBundle | null;
  sampleHeight: ((x: number, z: number) => number | null) | null;
  overlays: MapOverlayHandle | null;
  cameraPolicy?: CameraPolicy;
  cameraView?: CameraView | null;
  dashCamera?: { actorId: string; sensor: DashCameraSensor } | null;
  restoreCameraOnDispose?: boolean;
  renderer?: ActorRenderer | null;
  collisionActorOverrides?: CollisionActorOverrides;
  externalClock?: boolean;
  /** Wrap at the trace boundary. Document previews disable this for an observable completion fence. */
  loop?: boolean;
  cameraActorIds?: readonly string[];
  /** Keep high-frequency transport snapshots local to a downstream surface. */
  subscribeState?: boolean;
}

declare global {
  interface Window {
    /** Deterministic import/playback surface for the verification harness. */
    __playback?: PlaybackController;
  }
}

export function usePlayback({
  viewer,
  bundle,
  sampleHeight,
  overlays,
  cameraPolicy,
  cameraView,
  dashCamera,
  restoreCameraOnDispose,
  renderer,
  collisionActorOverrides,
  externalClock,
  loop,
  cameraActorIds,
  subscribeState = true,
}: UsePlaybackOptions): { controller: PlaybackController | null; state: PlaybackState | null; error: string | null } {
  const [controller, setController] = useState<PlaybackController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const playbackRenderer = useMemo(() => {
    if (!renderer || !bundle || !sampleHeight) return renderer;
    const verticalRenderer = withPlaybackVerticalMotion(
      renderer,
      createPlaybackVerticalMotion(bundle, sampleHeight),
    );
    // A stopped body keeps the heading it stopped with; the trace records due
    // east for a timed-route dwell. See `restingHeading` in `@simforge/playback`.
    const orientedRenderer = withRestingHeading(
      verticalRenderer,
      createRestingHeading(bundle),
    );
    return collisionActorOverrides
      ? withCollisionActorOverrides(orientedRenderer, collisionActorOverrides)
      : orientedRenderer;
  }, [bundle, collisionActorOverrides, renderer, sampleHeight]);

  useEffect(() => {
    if (!viewer || !bundle || !sampleHeight) return;
    let next: PlaybackController;
    try {
      next = new PlaybackController({
        viewer,
        bundle,
        sampleHeight,
        setSignalStates: (states, timeSeconds) => overlays?.setSignalStates(states, timeSeconds) ?? 0,
        clearSignalStates: () => overlays?.clearSignalStates(),
        ...(cameraPolicy ? { cameraPolicy } : {}),
        ...(cameraView ? { cameraView } : {}),
        ...(dashCamera ? { dashCamera } : {}),
        ...(restoreCameraOnDispose ? { restoreCameraOnDispose: true } : {}),
        ...(playbackRenderer ? { renderer: playbackRenderer } : {}),
        ...(externalClock ? { externalClock: true } : {}),
        ...(loop !== undefined ? { loop } : {}),
        ...(cameraActorIds ? { cameraActorIds } : {}),
      });
      setError(null);
    } catch (reason) {
      setController(null);
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    window.__playback = next;
    setController(next);
    return () => {
      if (window.__playback === next) delete window.__playback;
      next.dispose();
      setController(null);
    };
  }, [viewer, bundle, sampleHeight, overlays, cameraPolicy, cameraView, dashCamera, restoreCameraOnDispose, playbackRenderer, externalClock, loop, cameraActorIds]);

  const liveState = usePlaybackControllerState(subscribeState ? controller : null);
  const state = subscribeState ? liveState : (controller?.state ?? null);
  return { controller, state, error };
}

/** Subscribe at the smallest UI boundary that actually paints the playhead. */
export function usePlaybackControllerState(
  controller: PlaybackController | null,
): PlaybackState | null {
  return useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getSnapshot : nullSnapshot,
    nullSnapshot,
  );
}

function noopSubscribe(): () => void {
  return () => {};
}

function nullSnapshot(): null {
  return null;
}
