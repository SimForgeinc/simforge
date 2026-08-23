"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  MAP_VIEW_MODE_EASE_MS,
  MAX_3D_PITCH,
  useMapViewModeStore,
  type MapViewMode,
} from "@/app/lib/scenario-editor/stores";

/**
 * The camera half of the 2D/3D toggle: lock the map flat in 2D, hand rotation
 * and pitch back in 3D, and remember where the user left the 3D camera.
 *
 * **Locking 2D is a fix, not a restriction.** The editor map has always left
 * MapLibre's defaults in place — `dragRotate`, `pitchWithRotate` and a 60 degree
 * `maxPitch` — with no UI anywhere acknowledging it. A user can right-drag,
 * accidentally tilt the "2D" map, and have no control to put it back; the
 * viewport controller only ever calls `fitBounds`, so the accidental pitch
 * survives every reset. Making 2D genuinely flat removes that trap, and gives
 * the 3D toggle something real to hand over.
 *
 * Centre and zoom are never touched: the map instance is the same one across a
 * toggle, so they survive for free. Only pitch and bearing move, eased, because
 * an instant jump between a pitched and a flat view is disorienting and the
 * eased version is the moment the feature feels good.
 */

export function useMapViewModeCamera({
  mapRef,
  ready,
  enabled,
  interactionLocked = false,
}: {
  mapRef: RefObject<MapLibreMap | null>;
  /** True once `onLoad` has fired — before that there is nothing to configure. */
  ready: boolean;
  /** False on surfaces that have no 3D mode; the camera is then left alone. */
  enabled: boolean;
  /** True while an actor or timed-point drag owns the pointer. */
  interactionLocked?: boolean;
}) {
  const mode = useMapViewModeStore((state) => state.mode);
  const rememberCamera = useMapViewModeStore((state) => state.rememberCamera);
  const previousModeRef = useRef<MapViewMode | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !enabled) return;

    const previous = previousModeRef.current;
    previousModeRef.current = mode;

    if (mode === "3d") {
      map.setMaxPitch(MAX_3D_PITCH);
      map.dragRotate.enable();
      map.touchZoomRotate.enableRotation();
      map.keyboard.enableRotation();
      // Read through, not `||`: an author who deliberately flattened the camera
      // while IN 3D mode stored a pitch of 0, and `0 || 50` would silently
      // undo that every time they came back. The store already seeds these with
      // the defaults, so there is nothing to fall back to here.
      const { pitch, bearing } = useMapViewModeStore.getState();
      map.easeTo({
        pitch,
        bearing,
        duration: previous == null ? 0 : MAP_VIEW_MODE_EASE_MS,
      });
      return;
    }

    // Leaving 3D: capture the angle the author was working at before flattening,
    // so 3D -> 2D -> 3D returns to it rather than resetting to the default.
    if (previous === "3d") {
      rememberCamera({ pitch: map.getPitch(), bearing: map.getBearing() });
    }
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    // `setMaxPitch` is deliberately NOT clamped to 0 here: it jumps the camera
    // immediately when the current pitch exceeds the new maximum, which would
    // eat the ease below. Disabling the three rotation handlers is what actually
    // makes 2D flat; the ease is what makes it feel like a mode change.
    map.easeTo({
      pitch: 0,
      bearing: 0,
      duration: previous == null ? 0 : MAP_VIEW_MODE_EASE_MS,
    });
  }, [enabled, mapRef, mode, ready, rememberCamera]);

  // Rotation is suspended for the duration of a drag, alongside the existing
  // `dragPan={!interactionLocked}`. Right-dragging mid-gesture is harmless
  // today because nothing depends on bearing; the moment a model is anchored to
  // a ground point under a pitched camera, it stops being harmless.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !enabled || mode !== "3d") return;
    if (interactionLocked) {
      map.dragRotate.disable();
      map.touchZoomRotate.disableRotation();
      return () => {
        map.dragRotate.enable();
        map.touchZoomRotate.enableRotation();
      };
    }
    return undefined;
  }, [enabled, interactionLocked, mapRef, mode, ready]);

  // Keep the remembered angle current while the user orbits, so a toggle taken
  // mid-orbit does not lose the last few degrees.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !enabled || mode !== "3d") return;
    const onMoveEnd = () => {
      rememberCamera({ pitch: map.getPitch(), bearing: map.getBearing() });
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [enabled, mapRef, mode, ready, rememberCamera]);
}
