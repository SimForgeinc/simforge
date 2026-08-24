"use client";

import type { EditorDocument, EditorState } from "@simforge/editor";
import {
  V1TimelineRail,
  type V1TimelineBrowserPlayback,
  type V1TimelineSignalAuthoring,
  type V1TimelineSignalLane,
} from "./timeline/V1TimelineRail";
import type { EditorExperience } from "./simple-timed-routes";

// `editor-trigger-builders.test.ts` imports these from this module path; keep the
// re-export when moving them again.
export {
  buildDefaultScenarioCondition,
  buildDefaultScenarioTrigger,
} from "./timeline/trigger-defaults";

/**
 * Always-visible floating timeline around the V2 document/timing authority.
 *
 * Signal truth and canonical browser playback are optional inputs because their owners
 * load and validate them. Their absence stays visible and inert here: the dock
 * never invents a baseline, fetches a second projection, or advertises Play for
 * an authoring-only document.
 */
export function ScenarioTimelineDock({
  document,
  state,
  signalLanes,
  signalAuthoring,
  playback,
  selectedInteractionId,
  onFocusActor,
  onFocusSignal,
  onSelectActor,
  onSelectInteraction,
  onClearSelection,
  onSelectSignal,
  readOnly = false,
  experience = "advanced",
}: {
  document: EditorDocument;
  state?: Pick<EditorState, "selection" | "mode"> | null;
  signalLanes?: readonly V1TimelineSignalLane[];
  signalAuthoring?: V1TimelineSignalAuthoring | null;
  playback?: V1TimelineBrowserPlayback | null;
  selectedInteractionId?: string | null;
  onFocusActor?: (actorId: string) => void;
  onFocusSignal?: (headId: string) => void;
  onSelectActor?: (actorId: string) => void;
  onSelectInteraction?: (interactionId: string, actorId: string) => void;
  onClearSelection?: () => void;
  onSelectSignal?: (headId: string) => void;
  readOnly?: boolean;
  experience?: EditorExperience;
}) {
  return (
    <V1TimelineRail
      document={document}
      playback={playback}
      signalLanes={signalLanes}
      signalAuthoring={signalAuthoring}
      state={state}
      selectedInteractionId={selectedInteractionId}
      onFocusActor={onFocusActor}
      onFocusSignal={onFocusSignal}
      onSelectActor={onSelectActor}
      onSelectInteraction={onSelectInteraction}
      onClearSelection={onClearSelection}
      onSelectSignal={onSelectSignal}
      disableInteractionCreation={experience === "simple"}
      lockSimpleTimedRoutes={experience === "simple"}
      readOnly={readOnly}
    />
  );
}
