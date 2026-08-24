export const START_INTERACTIVE_TUTORIAL_EVENT = "scenario:start-interactive-tutorial";

export type StartInteractiveTutorialDetail = {
  mode: "simple" | "advanced";
};

export function startInteractiveTutorial(mode: StartInteractiveTutorialDetail["mode"]): void {
  window.dispatchEvent(new CustomEvent<StartInteractiveTutorialDetail>(
    START_INTERACTIVE_TUTORIAL_EVENT,
    { detail: { mode } },
  ));
}
