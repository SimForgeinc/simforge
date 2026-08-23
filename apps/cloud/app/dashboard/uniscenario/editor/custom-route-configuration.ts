import type { EditorController, EditorDocument } from "@uniscenarios/editor-core";
import type { SampledActor } from "@uniscenarios/playback";
import { resolveInteractionLayout } from "@/app/lib/uniscenario/timeline";

export type CustomRoutePlayback = {
  pause: () => void;
  seek: (time: number) => void;
  readonly currentActors: readonly SampledActor[];
};

export function configureCustomRouteAtClipStart({
  document,
  controller,
  playback,
  setInspecting,
  interactionId,
}: {
  document: EditorDocument;
  controller: EditorController;
  playback: CustomRoutePlayback;
  setInspecting: (inspecting: boolean) => void;
  interactionId: string;
}): { configured: boolean; startS?: number } {
  const interaction = document.data.choreography.interactions.find(
    (candidate) => candidate.id === interactionId,
  );
  if (!interaction || interaction.verb !== "route" || (
    interaction.target.mode !== "customRoute" && interaction.target.mode !== "customTimedRoute"
  )) {
    return { configured: false };
  }
  const numericTriggerStart = interaction.trigger.kind === "at"
    && typeof interaction.trigger.t === "number"
    ? interaction.trigger.t
    : null;
  const startS = numericTriggerStart ?? (resolveInteractionLayout(document.data).find(
    (candidate) => candidate.interaction.id === interactionId,
  )?.range.startMs ?? 0) / 1000;

  playback.pause();
  playback.seek(startS);
  const sampled = playback.currentActors.find((actor) => actor.id === interaction.actor);
  const authored = document.actor(interaction.actor);
  if (!sampled && !authored) return { configured: false, startS };

  setInspecting(false);
  controller.setPlaybackInspection(false);
  const points = interaction.target.points;
  const isLegacyOriginSegment = (distanceM: 1 | 10) => points.length === 2
    && points[0]!.x === 0
    && points[0]!.z === 0
    && points[1]!.x === distanceM
    && points[1]!.z === 0;
  const isGeneratedPlaceholder = (interaction.target.mode === "customRoute" && points.length === 1) || (interaction.target.mode === "customTimedRoute"
    ? (isLegacyOriginSegment(1) || isLegacyOriginSegment(10))
      && "timeS" in points[0]!
      && "timeS" in points[1]!
      && points[0].timeS === 0
      && points[1].timeS === 1
    : isLegacyOriginSegment(1) || isLegacyOriginSegment(10));
  const configured = controller.beginCustomRouteAuthoring(interactionId, isGeneratedPlaceholder
    ? {
        reset: true,
        startPose: sampled
          ? { x: sampled.x, z: sampled.z, headingRad: sampled.headingRad }
          : { x: authored!.x, z: authored!.z, headingRad: authored!.headingRad },
      }
    : {});
  return { configured, startS };
}
