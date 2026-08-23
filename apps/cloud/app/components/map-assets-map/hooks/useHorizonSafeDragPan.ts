"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Drag-pan that does not come apart near the horizon.
 *
 * MapLibre's own drag-pan grabs the ground point under the cursor and keeps it
 * under the cursor — per frame, `setLocationAtPoint(pointLocation(cursor -
 * delta), cursor)`. On a flat map that is exact and feels perfect. Under a
 * pitched camera it is the problem:
 *
 *   - Ground distance to a pixel goes as `tan(angle from nadir)`, so the
 *     metres-per-pixel at the cursor goes as `sec²`. At the 82.5 degree ceiling
 *     `MAX_3D_PITCH` allows, that is ~59x a flat map at the middle of the canvas,
 *     and it climbs without bound toward the horizon line.
 *   - Above that line there is no ground to grab, and `pointCoordinate` does not
 *     say so — it extrapolates and returns a point BEHIND the camera, so the map
 *     lurches the wrong way and flips sign as the cursor crosses. At 82.5 degrees
 *     the top ~30% of the canvas is that region.
 *
 * So pan by PIXEL DELTA anchored at the canvas centre instead. This is the fix
 * MapLibre itself applies — but only when 3D terrain is enabled, which we do not
 * use (`HandlerManager`, verbatim):
 *
 *   // dragging do not drag the picked point itself, instead it drags the map by
 *   // pixel-delta. With this approach it is no longer possible to pick a point
 *   // from somewhere near the horizon to the center in one move.
 *   // So this logic avoids the problem, that in such cases you easily loose
 *   // orientation.
 *
 * `panBy` is exactly that operation: it resolves the ground under `centre -
 * delta`, which stays far below the horizon at any pitch we allow, so one pixel
 * of pointer travel is one pixel of map travel at every angle. It is the same
 * primitive `useMapWasdPan` already flies the 3D camera with, which is why
 * keyboard panning never had this problem.
 *
 * What it gives up: the ground no longer sticks to the cursor when pitched. That
 * correspondence is what made the gesture erratic, and it is still exact in 2D —
 * this hook is off there and MapLibre's own handler runs instead.
 *
 * There is deliberately no inertia. MapLibre's pan inertia integrates the last
 * few frames of a gesture (`maxSpeed: 1400` px/s), and a fling is the wrong
 * gesture for lining up a spawn point.
 */
/**
 * Negation that keeps zero positive.
 *
 * `-0` is arithmetically harmless here — MapLibre's `Point` does not care — but
 * it makes every assertion about "no movement on this axis" read as a trap.
 */
function negate(value: number): number {
  return value === 0 ? 0 : -value;
}

export function useHorizonSafeDragPan({
  mapRef,
  enabled,
  onPanEnd,
}: {
  mapRef: RefObject<MapLibreMap | null>;
  /**
   * True only while this hook owns panning: 3D mode, map loaded, and no actor
   * drag holding the pointer. MapLibre's `dragPan` must be off for the same
   * span, or both handlers move the camera and the deltas double.
   */
  enabled: boolean;
  /**
   * The gesture ended.
   *
   * Each `panBy` is a complete camera animation, so it fires its own `moveend`,
   * and `moveend` is what publishes viewport bounds — which editor consumers
   * FETCH on. Sixty of those a second would hammer them, so the caller suppresses
   * them for the duration of a pan and publishes once here instead.
   */
  onPanEnd?: () => void;
}): { panningRef: RefObject<boolean> } {
  const panningRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const pendingRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastEventRef = useRef<PointerEvent | null>(null);
  const onPanEndRef = useRef(onPanEnd);

  useEffect(() => {
    onPanEndRef.current = onPanEnd;
  }, [onPanEnd]);

  useEffect(() => {
    if (!enabled) return;
    const map = mapRef.current;
    if (!map) return;
    const canvasContainer = map.getCanvasContainer();

    // Pointer events arrive faster than frames on a high-rate mouse, and each
    // `panBy` is a full camera update. Coalescing to one per frame is the same
    // shape `useMapWasdPan` integrates its held keys on.
    const flush = () => {
      frameRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (!pending || (pending.x === 0 && pending.y === 0)) return;
      // Negated: the camera moves opposite the pointer, so the ground follows
      // the hand.
      map.panBy([negate(pending.x), negate(pending.y)], { duration: 0 }, {
        // `isUserInitiatedMapMove` keys off `originalEvent`. Without it the
        // editor reads its own pan as programmatic and keeps auto-fitting over
        // the author.
        originalEvent: lastEventRef.current ?? undefined,
      });
    };

    const schedule = () => {
      if (frameRef.current != null) return;
      frameRef.current = requestAnimationFrame(flush);
    };

    const end = () => {
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      // Before clearing the flag, so the final frame's `moveend` is suppressed
      // like every other one and `onPanEnd` is the single publish.
      flush();
      const wasPanning = panningRef.current;
      panningRef.current = false;
      pointerIdRef.current = null;
      lastPointRef.current = null;
      lastEventRef.current = null;
      if (wasPanning) onPanEndRef.current?.();
    };

    const onPointerDown = (event: PointerEvent) => {
      // A second pointer means a pinch. Hand the gesture back rather than
      // fighting the two-finger zoom handler for the camera.
      if (pointerIdRef.current != null) {
        end();
        return;
      }
      // Primary button only: right-drag is `dragRotate`, which stays MapLibre's.
      if (event.button !== 0 || !event.isPrimary) return;
      pointerIdRef.current = event.pointerId;
      lastPointRef.current = { x: event.clientX, y: event.clientY };
      lastEventRef.current = event;
      panningRef.current = true;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerIdRef.current) return;
      const last = lastPointRef.current;
      if (!last) return;
      const pending = pendingRef.current ?? { x: 0, y: 0 };
      pendingRef.current = {
        x: pending.x + (event.clientX - last.x),
        y: pending.y + (event.clientY - last.y),
      };
      lastPointRef.current = { x: event.clientX, y: event.clientY };
      lastEventRef.current = event;
      schedule();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerIdRef.current) return;
      end();
    };

    canvasContainer.addEventListener("pointerdown", onPointerDown);
    // The rest on the window: a drag that leaves the canvas must keep panning,
    // and a release outside it must still end the gesture. Same reason the
    // locked-pointer feed listens there.
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("blur", end);
    return () => {
      canvasContainer.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", end);
      // Leaving 3D mid-drag still owes the deferred bounds publish.
      end();
    };
  }, [enabled, mapRef]);

  return { panningRef };
}
