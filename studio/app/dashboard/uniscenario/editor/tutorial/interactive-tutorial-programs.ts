import type { EditorExperience } from "../simple-timed-routes";

export type InteractiveAction =
  | "reset"
  | "move"
  | "orbit"
  | "open-cars"
  | "open-pedestrians"
  | "choose-actor"
  | "place-actor"
  | "configure-route"
  | "draw-route"
  | "add-action"
  | "play"
  | "exit-playback"
  | "finish";

export type InteractiveStep = {
  id: string;
  action: InteractiveAction;
  selector: string | null;
  eyebrow: string;
  title: string;
  body: string;
  prompt: string;
  card: "top-left" | "top-right" | "bottom-left" | "bottom-right";
};

const SHARED_START: readonly InteractiveStep[] = [
  {
    id: "move-camera",
    action: "move",
    selector: '[data-tutorial="canvas"]',
    eyebrow: "Controls",
    title: "Move across the map",
    body: "Use the keyboard to pan the viewport. The tutorial advances after the editor receives a movement key.",
    prompt: "Press W, A, S, or D",
    card: "top-right",
  },
  {
    id: "orbit-camera",
    action: "orbit",
    selector: '[data-tutorial="canvas"]',
    eyebrow: "Controls",
    title: "Orbit the camera",
    body: "Orbit around the current view target to inspect the road from another angle.",
    prompt: "Left-drag on the map",
    card: "top-right",
  },
];

const SHARED_END: readonly InteractiveStep[] = [
  {
    id: "play-timeline",
    action: "play",
    selector: '[data-tutorial="timeline"]',
    eyebrow: "Simulation",
    title: "Play the scenario",
    body: "Space is the primary timeline shortcut. It prepares browser simulation and starts playback without moving the camera.",
    prompt: "Press Space",
    card: "top-right",
  },
  {
    id: "exit-playback",
    action: "exit-playback",
    selector: '[data-tutorial="timeline"]',
    eyebrow: "Simulation",
    title: "Reset to authoring",
    body: "Escape stops playback, rewinds the playhead, and exits timeline inspection in one action.",
    prompt: "Press Esc",
    card: "top-right",
  },
  {
    id: "complete",
    action: "finish",
    selector: null,
    eyebrow: "Complete",
    title: "You authored and ran a scenario",
    body: "You can reopen Tutorial at any time to review this mode or repeat its interactive walkthrough.",
    prompt: "Continue authoring",
    card: "top-right",
  },
];

export const SIMPLE_INTERACTIVE_STEPS: readonly InteractiveStep[] = [
  ...SHARED_START,
  {
    id: "open-pedestrians",
    action: "open-pedestrians",
    selector: '[data-tutorial="actor-library"]',
    eyebrow: "Actors",
    title: "Open the pedestrian library",
    body: "Simple mode gives every moving actor one timed route. Start by adding a pedestrian.",
    prompt: "Click Pedestrian",
    card: "top-right",
  },
  {
    id: "choose-pedestrian",
    action: "choose-actor",
    selector: '[data-testid="catalog-drawer"]',
    eyebrow: "Actors",
    title: "Choose a pedestrian",
    body: "Pick any pedestrian from the library to attach its placement preview to the pointer.",
    prompt: "Click any pedestrian",
    card: "bottom-left",
  },
  {
    id: "place-pedestrian",
    action: "place-actor",
    selector: '[data-tutorial="canvas"]',
    eyebrow: "Actors",
    title: "Place the pedestrian",
    body: "Click a valid surface. Placement creates an unfinished red route interaction, but route drawing will not begin until you click it.",
    prompt: "Place the pedestrian successfully",
    card: "top-left",
  },
  {
    id: "configure-route",
    action: "configure-route",
    selector: '[data-route-status="needs-setup"]',
    eyebrow: "Timed route",
    title: "Open the route interaction",
    body: "The red blinking bar means this actor still needs a route. Click it at the bottom of the editor to begin drawing.",
    prompt: "Click the red route interaction",
    card: "top-right",
  },
  {
    id: "draw-route",
    action: "draw-route",
    selector: '[data-tutorial="canvas"]',
    eyebrow: "Timed route",
    title: "Place one point per second",
    body: "The starting position is 0 seconds. Each click appends the next one-second point in order. Press Ctrl+Z or Cmd+Z to undo the latest point. Click directly on the highlighted last point again to make the pedestrian wait there for one second without changing direction.",
    prompt: "Place at least one point, then press Enter",
    card: "bottom-right",
  },
  {
    id: "open-cars-after-pedestrian",
    action: "open-cars",
    selector: '[data-tutorial="actor-library"]',
    eyebrow: "Actors",
    title: "Add a car",
    body: "Now add a car so the scenario contains both a pedestrian and a vehicle.",
    prompt: "Click Car",
    card: "top-right",
  },
  {
    id: "choose-car-after-pedestrian",
    action: "choose-actor",
    selector: '[data-testid="catalog-drawer"]',
    eyebrow: "Actors",
    title: "Choose a car",
    body: "Pick any vehicle from the library to attach its placement preview to the pointer.",
    prompt: "Click any vehicle",
    card: "bottom-left",
  },
  {
    id: "place-car-after-pedestrian",
    action: "place-actor",
    selector: '[data-tutorial="canvas"]',
    eyebrow: "Actors",
    title: "Place the car",
    body: "Place the car on a valid road surface. The placement panel closes after the car is added.",
    prompt: "Place the car successfully",
    card: "top-left",
  },
  {
    id: "configure-car-route",
    action: "configure-route",
    selector: '[data-route-status="needs-setup"]',
    eyebrow: "Timed route",
    title: "Open the car route",
    body: "Click the car's red blinking route interaction to begin drawing its timed path.",
    prompt: "Click the red car route interaction",
    card: "top-right",
  },
  {
    id: "draw-car-route",
    action: "draw-route",
    selector: '[data-tutorial="canvas"]',
    eyebrow: "Timed route",
    title: "Draw the car route",
    body: "Add at least one destination point for the car. Each point represents one more second of travel.",
    prompt: "Place at least one point, then press Enter",
    card: "bottom-right",
  },
  ...SHARED_END,
];

export const ADVANCED_INTERACTIVE_STEPS: readonly InteractiveStep[] = [
  ...SHARED_START,
  {
    id: "open-cars",
    action: "open-cars",
    selector: '[data-tutorial="actor-library"]',
    eyebrow: "Actors",
    title: "Open the car library",
    body: "Advanced mode exposes detailed actor settings and multi-track behavior authoring. Start with a car.",
    prompt: "Click Car",
    card: "top-right",
  },
  {
    id: "choose-car",
    action: "choose-actor",
    selector: '[data-testid="catalog-drawer"]',
    eyebrow: "Actors",
    title: "Choose a car",
    body: "Pick any vehicle from the library. This arms placement and attaches the vehicle preview to the pointer.",
    prompt: "Click any vehicle",
    card: "bottom-left",
  },
  {
    id: "place-car",
    action: "place-actor",
    selector: '[data-tutorial="canvas"]',
    eyebrow: "Actors",
    title: "Place it on a road",
    body: "Move over a valid lane and click. If the lane is ambiguous, move along the road until the placement warning improves.",
    prompt: "Place the vehicle successfully",
    card: "top-left",
  },
  {
    id: "add-timeline-action",
    action: "add-action",
    selector: '[data-tutorial="timeline"]',
    eyebrow: "Timeline",
    title: "Add an interaction",
    body: "Right-click an empty gap in the new actor row, choose an action, then use its details to configure timing, triggers, and dynamics.",
    prompt: "Right-click a gap and choose an action",
    card: "top-right",
  },
  ...SHARED_END,
];

export function interactiveStepsForMode(mode: EditorExperience): readonly InteractiveStep[] {
  return mode === "simple" ? SIMPLE_INTERACTIVE_STEPS : ADVANCED_INTERACTIVE_STEPS;
}

export function interactiveTutorialProgram(
  mode: EditorExperience,
  playbackInspecting: boolean,
): readonly InteractiveStep[] {
  const steps = interactiveStepsForMode(mode);
  if (!playbackInspecting) return steps;
  return [{
    id: "reset-first",
    action: "reset",
    selector: '[data-tutorial="timeline"]',
    eyebrow: "Controls",
    title: "Return to authoring",
    body: "The timeline is currently in playback mode. Reset it before beginning the tutorial.",
    prompt: "Press Esc",
    card: "top-right",
  }, ...steps];
}
