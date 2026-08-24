/**
 * The editor core's contract with whatever 3D surface it is driving.
 *
 * The core used to `import` this from the WebGL renderer, which is what forced
 * the renderer to be a workspace package in the first place. The real coupling
 * was never structural: six of the seven references were `import type` (erased
 * at compile time) and the seventh was a single string constant. So the contract
 * lives here instead, stated as the *narrowest* surface the core actually
 * touches — `scene`, `camera`, `renderer.domElement`, and four `controls`
 * methods.
 *
 * Consequence worth keeping: any viewer that satisfies this shape can host the
 * editor. `CityViewer` (`../renderer`) satisfies it structurally without
 * declaring so, and nothing in this directory imports the renderer.
 */

import type { PerspectiveCamera, Scene, Vector3 } from 'three';

/**
 * Role tag stamped on editor-owned helper objects (drop shadows, gizmos) that
 * must disappear when the viewer drops to a low-fidelity preset.
 *
 * **This value is duplicated on purpose.** The renderer owns the read side
 * (`isLowFidelityHiddenHelper` in `../renderer/roads-only`); the core owns the
 * write side. Duplicating one string literal is cheaper than a module edge
 * between them. The two are pinned together by
 * `test/uniscenario/editor/core/viewer-contract.test.ts`, which fails if they
 * ever drift.
 */
export const LOW_FIDELITY_HIDDEN_ROLE = 'low-fidelity-hidden';

/** Camera pose as the viewer reports it. Mirrors the renderer's `CameraView`. */
export interface EditorViewerCameraView {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
}

/** The camera-rig methods the editor drives directly. */
export interface EditorViewerControls {
  getView(): EditorViewerCameraView;
  setView(position: Vector3, target: Vector3): void;
  /**
   * Hand pointer ownership back and forth: the editor disables the rig while a
   * gizmo drag or a modal placement owns the pointer.
   */
  setEnabled(enabled: boolean): void;
}

/**
 * The 3D surface the editor attaches to.
 *
 * Deliberately structural, not an implemented interface — the renderer must not
 * have to know the editor exists.
 */
export interface EditorViewer {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: { readonly domElement: HTMLCanvasElement };
  readonly controls: EditorViewerControls;
}

/** The CSS-pixel surface used by both camera projection and pointer rays. */
export function getViewerSurfaceRect(viewer: EditorViewer): DOMRect {
  return viewer.renderer.domElement.getBoundingClientRect();
}
