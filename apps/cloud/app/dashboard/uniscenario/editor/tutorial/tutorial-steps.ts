import type { EditorExperience } from "../simple-timed-routes";

export type TutorialStep = {
  id: string;
  /** Matches `[data-tutorial="<anchor>"]`. Null centres the card. */
  anchor: string | null;
  title: string;
  body: string;
  /** Which side of the anchor the card sits on. */
  side: "right" | "left" | "top" | "bottom";
};

const SHARED_WELCOME: TutorialStep = {
  id: "welcome",
  anchor: null,
  title: "This is the Simcloud Editor.",
  body: "You are authoring a map-bound scenario document. It exports to OpenSCENARIO 1.4 and renders in CARLA.",
  side: "bottom",
};

const SHARED_LIBRARY: TutorialStep = {
  id: "library",
  anchor: "actor-library",
  title: "Place actors and objects",
  body: "Open Cars, Pedestrians, or Objects, choose an item, then place it in the scene. Vehicles snap to roads while pedestrians and objects can use valid surfaces.",
  side: "right",
};

const SHARED_CANVAS: TutorialStep = {
  id: "canvas",
  anchor: "canvas",
  title: "Move through the scene",
  body: "Use W, A, S, and D to move across the map, left-drag to orbit, and click an authored actor to select it.",
  side: "left",
};

const SHARED_EXPORT: TutorialStep = {
  id: "export",
  anchor: "header-actions",
  title: "Render from a saved revision",
  body: "Playback previews the scenario in the browser. Export and Render create an immutable revision so every result is traceable to the exact document that produced it.",
  side: "bottom",
};

export const SIMPLE_TUTORIAL_STEPS: readonly TutorialStep[] = [
  SHARED_WELCOME,
  SHARED_LIBRARY,
  SHARED_CANVAS,
  {
    id: "simple-route",
    anchor: "timeline",
    title: "Every moving actor uses one timed route",
    body: "Placement creates a red unfinished route clip. Click that clip when you are ready to draw. Every click appends the next one-second point in order, and Ctrl+Z or Cmd+Z removes the latest point. Click directly on the highlighted last point again to add a one-second wait while preserving the actor's direction.",
    side: "top",
  },
  {
    id: "simple-stop",
    anchor: "timeline",
    title: "The last point is the stopping point",
    body: "You can end the path before the scenario ends. The pedestrian follows the points as closely as possible, then stops at the last point and waits there.",
    side: "top",
  },
  SHARED_EXPORT,
];

export const ADVANCED_TUTORIAL_STEPS: readonly TutorialStep[] = [
  SHARED_WELCOME,
  SHARED_LIBRARY,
  SHARED_CANVAS,
  {
    id: "inspector",
    anchor: "inspector",
    title: "Configure exact actor behavior",
    body: "Use actor details to set names, initial speed, driver behavior, appearance, and pose. Advanced mode exposes the full motion model.",
    side: "left",
  },
  {
    id: "timeline",
    anchor: "timeline",
    title: "Author interactions and triggers",
    body: "Right-click an actor row to add an action. Then configure its timing, trigger, target, and dynamics in the interaction details.",
    side: "top",
  },
  SHARED_EXPORT,
];

export function tutorialStepsForMode(mode: EditorExperience): readonly TutorialStep[] {
  return mode === "simple" ? SIMPLE_TUTORIAL_STEPS : ADVANCED_TUTORIAL_STEPS;
}

export const TUTORIAL_STORAGE_KEY_PREFIX = "uniscenario.tutorial.completed.v2";

export function tutorialStorageKey(mode: EditorExperience): string {
  return `${TUTORIAL_STORAGE_KEY_PREFIX}.${mode}`;
}

/**
 * Whether the walkthrough should run.
 *
 * Defaults to *not* running when storage is unreadable. A private-mode browser
 * that throws on `localStorage` would otherwise replay the tour on every single
 * page load, which is worse than never showing it.
 */
export function shouldRunTutorial(
  storage: Pick<Storage, "getItem"> | null,
  mode: EditorExperience,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(tutorialStorageKey(mode)) == null;
  } catch {
    return false;
  }
}

export function markTutorialComplete(
  storage: Pick<Storage, "setItem"> | null,
  mode: EditorExperience,
): void {
  try {
    storage?.setItem(tutorialStorageKey(mode), new Date().toISOString());
  } catch {
    // A tour that cannot record completion still has to be dismissable.
  }
}

/** Steps whose anchor is currently in the DOM, in authoring order. */
export function reachableSteps(
  steps: readonly TutorialStep[],
  hasAnchor: (anchor: string) => boolean,
): TutorialStep[] {
  return steps.filter((step) => step.anchor == null || hasAnchor(step.anchor));
}
