/**
 * Marquee (box) selection math, kept pure so the hit-test is unit-testable
 * without a DOM, a renderer or a live camera rig.
 *
 * The test is screen-space against actor *centroids*: instanced actor meshes
 * cannot be enumerated per-DOM-rectangle, and a centroid test matches what an
 * operator aims at. Actors behind the camera never select.
 */

import { Vector3 } from 'three';
import type { Camera } from 'three';

/** Normalised client-space rectangle; `left <= right`, `top <= bottom`. */
export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The surface actors project onto, in client (CSS pixel) coordinates. */
export interface ScreenSurface {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Order two drag corners into a rectangle. */
export function normalizedRect(x0: number, y0: number, x1: number, y1: number): ScreenRect {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    right: Math.max(x0, x1),
    bottom: Math.max(y0, y1),
  };
}

const _projected = new Vector3();

/**
 * Project a world point to client coordinates, or `null` when it falls
 * outside the camera's depth range (behind the camera / beyond far plane).
 */
export function projectToClient(
  camera: Camera,
  surface: ScreenSurface,
  x: number,
  y: number,
  z: number,
): { x: number; y: number } | null {
  _projected.set(x, y, z).project(camera);
  if (_projected.z < -1 || _projected.z > 1) return null;
  return {
    x: surface.left + ((_projected.x + 1) * surface.width) / 2,
    y: surface.top + ((1 - _projected.y) * surface.height) / 2,
  };
}

/** Actor ids whose projected centroid falls inside the rectangle. */
export function actorIdsInRect(
  actors: readonly { id: string; x: number; y: number; z: number; dims?: { h: number } }[],
  camera: Camera,
  surface: ScreenSurface,
  rect: ScreenRect,
): string[] {
  const ids: string[] = [];
  for (const actor of actors) {
    const centroidY = actor.y + (actor.dims ? actor.dims.h * 0.5 : 0);
    const point = projectToClient(camera, surface, actor.x, centroidY, actor.z);
    if (!point) continue;
    if (point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom) {
      ids.push(actor.id);
    }
  }
  return ids;
}

/** How a gesture combines with the existing selection set. */
export type SelectionOp = 'replace' | 'add' | 'toggle';

/** Combine picked ids with the current selection under one modifier rule. */
export function applySelectionOp(
  current: readonly string[],
  picked: readonly string[],
  op: SelectionOp,
): string[] {
  if (op === 'replace') return [...new Set(picked)];
  if (op === 'add') return [...new Set([...current, ...picked])];
  const toggled = new Set(current);
  for (const id of new Set(picked)) {
    if (toggled.has(id)) toggled.delete(id);
    else toggled.add(id);
  }
  return [...toggled];
}

/** The modifier contract shared by click picking and marquee release. */
export function selectionOpForModifiers(modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey?: boolean }): SelectionOp {
  if (modifiers.shiftKey) return 'add';
  if (modifiers.ctrlKey || modifiers.metaKey) return 'toggle';
  return 'replace';
}
