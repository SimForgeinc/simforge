/**
 * Live handles on the 3D signal renderer, published for the rest of the map:
 * the picker the click chain asks "which light is under this pixel", and the
 * projector the card anchor asks "where on screen is that light drawn".
 *
 * `MapAssetsMap` owns the one click precedence chain (a second listener on the
 * same event is what broke this feature the first time round), but the thing
 * that can answer "which light's LAMPS are under this pixel" is the three.js
 * scene, which lives inside `Map3DLayer`. A module-level registry is the
 * narrowest connection between them: the layer publishes its picker while
 * mounted, the chain calls it if one is there, and every other consumer of
 * `MapAssetsMap` — the catalog and detail pages, which never mount the 3D
 * layer — sees `null` and falls through to the flat hit layers.
 *
 * Deliberately not React state or a store. It is neither: it is a live handle
 * on a renderer, it changes only on mount and unmount, and putting it in a store
 * would invite a render on something that must never trigger one.
 */

export type SignalHeadPick = {
  key: string;
  signalId: string | null;
  distancePx: number;
};

export type SignalHeadPicker = (
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  radiusPx?: number,
) => SignalHeadPick | null;

let picker: SignalHeadPicker | null = null;

/** Publish (or with `null`, retract) the picker. Called by `Map3DLayer`. */
export function setSignalHeadPicker(next: SignalHeadPicker | null): void {
  picker = next;
}

/**
 * The head whose lamps are nearest `point`, or `null` when 3D is not mounted.
 *
 * Never throws: a pick runs inside a click handler, and a renderer torn down
 * mid-gesture must cost the click, not the canvas.
 */
export function pickSignalHeadAt(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  radiusPx?: number,
): SignalHeadPick | null {
  if (!picker) return null;
  try {
    return picker(point, viewport, radiusPx);
  } catch {
    return null;
  }
}

/** True when a 3D scene is mounted and able to answer picks. */
export function hasSignalHeadPicker(): boolean {
  return picker != null;
}

/** The screen-space box a drawn head occupies, in CSS pixels. */
export type SignalHeadScreenBox = {
  /** Topmost pixel of the head — the housing's top, not the road beneath it. */
  top: number;
  bottom: number;
  left: number;
  right: number;
};

export type SignalHeadProjector = (
  signalId: string,
  viewport: { width: number; height: number },
) => SignalHeadScreenBox | null;

let projector: SignalHeadProjector | null = null;

/** Publish (or with `null`, retract) the projector. Called by `Map3DLayer`. */
export function setSignalHeadProjector(next: SignalHeadProjector | null): void {
  projector = next;
}

/**
 * Where a head is DRAWN, in CSS pixels — or `null` in 2D, where it isn't.
 *
 * The detail card anchors on the light's ground position, which under any pitch
 * is metres below the lamps hanging off the mast arm: placing the card "above"
 * that point puts it straight over the head it describes. This is what lets the
 * anchor cover the head's real screen extent instead.
 *
 * Never throws, for the same reason the picker doesn't: it is called from map
 * event handlers, and a renderer torn down mid-pan must cost a frame of anchor
 * accuracy, not the canvas.
 */
export function projectSignalHead(
  signalId: string,
  viewport: { width: number; height: number },
): SignalHeadScreenBox | null {
  if (!projector) return null;
  try {
    return projector(signalId, viewport);
  } catch {
    return null;
  }
}
