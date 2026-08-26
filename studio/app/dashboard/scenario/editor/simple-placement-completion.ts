import type { EditorState } from "@simforge-oss/editor";

import type { ViewportTool } from "./regions/actor-catalog";
import type { EditorExperience } from "./simple-timed-routes";

export type PlacementSnapshot = Pick<EditorState, "mode"> & { actorCount: number };

/** Every catalog is a single-shot workflow: successful placement closes it. */
export function shouldFinishActorPlacement(input: {
  experience: EditorExperience | null;
  activeTool: ViewportTool | null;
  previous: PlacementSnapshot | null;
  current: PlacementSnapshot | null;
}): boolean {
  return input.experience !== null
    && input.activeTool !== null
    && input.current !== null
    && input.previous !== null
    && input.current.actorCount > input.previous.actorCount;
}
