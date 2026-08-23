"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

/** Screen pixels per second at full tilt. A screen-width sweep in ~1.5s. */
const PAN_PIXELS_PER_SECOND = 900;
/** Shift is the sprint, for crossing a map rather than lining up a shot. */
const SPRINT_MULTIPLIER = 2.5;

/** Which way each key pushes the CAMERA, in screen space. */
const KEY_VECTORS: Record<string, { x: number; y: number }> = {
  w: { x: 0, y: -1 },
  a: { x: -1, y: 0 },
  s: { x: 0, y: 1 },
  d: { x: 1, y: 0 },
};

function isTextEditingElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

function overlayOwnsKeys(): boolean {
  return Boolean(
    document.querySelector(
      [
        '[aria-modal="true"]',
        "[data-radix-popper-content-wrapper]",
        '[role="menu"]',
        '[role="listbox"]',
      ].join(","),
    ),
  );
}

/**
 * WASD flies the 3D camera over the map.
 *
 * Screen-space rather than compass-space, via `panBy`: W is "further up the
 * screen", which is what the hand expects at any bearing. Deriving a north/east
 * vector and rotating it by the bearing would come to the same thing on a
 * north-up map and to the wrong thing the moment the author rotates.
 *
 * Held keys accumulate in a set and are integrated on an animation frame, so a
 * diagonal is a real diagonal and speed does not depend on the browser's
 * key-repeat rate. The frame loop only runs while a key is down.
 *
 * 3D only. In 2D the map is a flat authoring surface where a stray `d` should
 * do nothing, and MapLibre's own keyboard handler already pans it with arrows.
 *
 * Deliberately NOT taking a modified key: `Shift+D` is the 2D/3D flip and ⌘/^
 * combinations belong to the editor. Shift alone is the sprint, which is why
 * the guard is on the meta/ctrl/alt keys only and `Shift+D` is excluded by
 * name — it would otherwise sprint east and toggle the view at once.
 */
export function useMapWasdPan({
  mapRef,
  enabled,
}: {
  mapRef: RefObject<MapLibreMap | null>;
  /** True only in 3D mode, once the map is ready. */
  enabled: boolean;
}) {
  const heldRef = useRef(new Set<string>());
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);
  const sprintRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const held = heldRef.current;

    const stop = () => {
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastTimeRef.current = null;
    };

    const step = (time: number) => {
      const map = mapRef.current;
      if (!map || held.size === 0) {
        stop();
        return;
      }
      const last = lastTimeRef.current;
      lastTimeRef.current = time;
      // Skip the first frame: with no previous timestamp there is no interval
      // to integrate over, and assuming one makes the first press jump.
      if (last == null) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }
      // Clamp the interval so a backgrounded tab does not resume with one
      // enormous leap across the city.
      const seconds = Math.min(0.05, (time - last) / 1000);

      let x = 0;
      let y = 0;
      for (const key of held) {
        const vector = KEY_VECTORS[key];
        if (!vector) continue;
        x += vector.x;
        y += vector.y;
      }
      if (x !== 0 || y !== 0) {
        // Normalize, or holding W+D would travel 1.41x as fast as either alone.
        const length = Math.hypot(x, y);
        const distance =
          PAN_PIXELS_PER_SECOND * seconds * (sprintRef.current ? SPRINT_MULTIPLIER : 1);
        map.panBy([(x / length) * distance, (y / length) * distance], {
          duration: 0,
        });
      }
      frameRef.current = requestAnimationFrame(step);
    };

    const start = () => {
      if (frameRef.current != null) return;
      lastTimeRef.current = null;
      frameRef.current = requestAnimationFrame(step);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      // `Shift+D` is the view-mode flip and has to reach its own handler.
      if (key === "d" && event.shiftKey) return;
      if (!KEY_VECTORS[key]) return;
      if (isTextEditingElement(event.target) || overlayOwnsKeys()) return;

      sprintRef.current = event.shiftKey;
      held.add(key);
      // Claim the key so it cannot also scroll the page or reach a shortcut.
      event.preventDefault();
      start();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!KEY_VECTORS[key]) return;
      held.delete(key);
      sprintRef.current = event.shiftKey && held.size > 0;
      if (held.size === 0) stop();
    };

    // A key held while the window loses focus never fires its keyup, and the
    // camera would fly away on its own until the next press.
    const release = () => {
      held.clear();
      sprintRef.current = false;
      stop();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      release();
    };
  }, [enabled, mapRef]);
}
