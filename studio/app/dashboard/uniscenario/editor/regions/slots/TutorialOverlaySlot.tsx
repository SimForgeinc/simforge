"use client";

import { useEffect, useState } from "react";
import { InteractiveTutorialOverlay } from "../../tutorial/InteractiveTutorialOverlay";
import { TutorialOverlay, tutorialPending } from "../../tutorial/TutorialOverlay";
import { START_INTERACTIVE_TUTORIAL_EVENT } from "../../tutorial/interactive-tutorial-events";
import type { StartInteractiveTutorialDetail } from "../../tutorial/interactive-tutorial-events";
import type { EditorExperience } from "../../simple-timed-routes";
import {
  markSimpleRouteTutorialSeen,
  simpleRouteTutorialStorage,
} from "../../tutorial/simple-route-tutorial";

/**
 * HOST SLOT — tutorial / onboarding. Manifest section 14. **Filled.**
 *
 * The tour lives in `../../tutorial/`. Steps are data in `tutorial-steps.ts`,
 * addressed by `data-tutorial` attribute — add a step there rather than editing
 * the overlay, and put the matching attribute on the region you want ringed.
 *
 * `ready` gates the first step: until the map, lane topology and document have
 * loaded, the regions the tour points at either are not mounted or sit under the
 * boot gate, and a tour pointing at a boot gate teaches nothing.
 *
 * Completion is decided on the client only. `tutorialPending()` reads
 * `localStorage`, so calling it during render would produce different markup on
 * the server and hydrate to a mismatch; the effect defers it to after mount.
 */
export function TutorialOverlaySlot({
  ready,
  experience,
  actorCount = 0,
  configuredRouteCount = 0,
  customRouteTool = null,
  editorMode = "idle",
  interactionCount = 0,
  playbackInspecting = false,
  playbackPlaying = false,
  scenarioKey = null,
}: {
  ready: boolean;
  experience: EditorExperience | null;
  actorCount?: number;
  configuredRouteCount?: number;
  customRouteTool?: "add" | "move" | null;
  editorMode?: string;
  interactionCount?: number;
  playbackInspecting?: boolean;
  playbackPlaying?: boolean;
  scenarioKey?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [interactiveMode, setInteractiveMode] = useState<EditorExperience | null>(null);

  useEffect(() => {
    setInteractiveMode(null);
    setOpen(false);
    if (!ready || !experience || !tutorialPending(experience)) return;
    if (experience === "simple") {
      markSimpleRouteTutorialSeen(simpleRouteTutorialStorage());
      setInteractiveMode("simple");
      return;
    }
    setOpen(true);
  }, [experience, ready, scenarioKey]);

  useEffect(() => {
    const startInteractive = (event: Event) => {
      if (!ready || !experience) return;
      const requestedMode = (event as CustomEvent<StartInteractiveTutorialDetail>).detail?.mode;
      if (requestedMode && requestedMode !== experience) return;
      setOpen(false);
      if (experience === "simple") {
        markSimpleRouteTutorialSeen(simpleRouteTutorialStorage());
      }
      setInteractiveMode(experience);
    };
    window.addEventListener(START_INTERACTIVE_TUTORIAL_EVENT, startInteractive);
    return () => window.removeEventListener(START_INTERACTIVE_TUTORIAL_EVENT, startInteractive);
  }, [experience, ready]);

  if (interactiveMode) {
    return (
      <InteractiveTutorialOverlay
        actorCount={actorCount}
        configuredRouteCount={configuredRouteCount}
        customRouteTool={customRouteTool}
        editorMode={editorMode}
        interactionCount={interactionCount}
        mode={interactiveMode}
        onClose={() => setInteractiveMode(null)}
        playbackInspecting={playbackInspecting}
        playbackPlaying={playbackPlaying}
      />
    );
  }
  if (!open) return null;
  return experience ? <TutorialOverlay mode={experience} onClose={() => setOpen(false)} /> : null;
}
