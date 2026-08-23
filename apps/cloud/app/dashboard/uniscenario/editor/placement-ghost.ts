import type { EditorMode } from "@uniscenarios/editor-core";

/**
 * Keep the translucent placement ghost off screen when nothing is being placed.
 *
 * `EditorController.setPlaybackInspection(active)` restores authoring chrome
 * with `ghost.group.visible = !active`, unconditionally — it does not ask
 * whether placement is armed. `cancelModal()` hides the ghost but keeps its
 * meshes, catalog and last pose, which after a placement is the pose of the car
 * that was just dropped. So every later "editor is presenting again" toggle
 * (leaving playback, the surface becoming active, opening a route from the
 * timeline) re-shows a green ghost sitting exactly on top of that car, and it
 * stays until something happens to hide it again.
 *
 * That is why it reads as "the car I clicked is highlighted green as if I were
 * still placing it", and why it only happens after a placement.
 *
 * The real repair belongs in `editor-core`, which owns the ghost and knows the
 * mode; the platform consumes a hash-verified vendored build of that package,
 * so the surface re-asserts the invariant instead.
 */
const PLACEMENT_GHOST_NAME = "placement-ghost";

/** The scene slice this needs: editor-core parents the ghost to the root. */
export type PlacementGhostScene = {
  readonly children: readonly { readonly name: string; visible: boolean }[];
};

/**
 * Hide a ghost left visible outside placement mode. Returns whether it hid one,
 * so callers and tests can tell a real repair from a no-op.
 *
 * The scene is optional: an injected or half-built viewer reaches the surface
 * before it owns one, and there is no ghost to repair in that window.
 */
export function hideStalePlacementGhost(
  scene: PlacementGhostScene | null | undefined,
  mode: EditorMode | null | undefined,
): boolean {
  // While placing, the ghost's visibility belongs to the controller: it is
  // hidden until the cursor is over the map and shown on every ground move.
  if (!scene || mode === "placing") return false;
  const ghost = scene.children.find((child) => child.name === PLACEMENT_GHOST_NAME);
  if (!ghost || !ghost.visible) return false;
  ghost.visible = false;
  return true;
}
