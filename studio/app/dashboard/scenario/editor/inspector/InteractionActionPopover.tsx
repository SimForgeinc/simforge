"use client";

import { Route, Trash2, Workflow } from "lucide-react";
import type { Interaction, Trigger } from "@simforge/scenario";

import type { EditorDocument } from "@simforge/editor";
import { InteractionSemanticsControls } from "../timeline/InteractionSemanticsControls";
import { InteractionTargetControls } from "../timeline/InteractionTargetControls";
import { TriggerControls } from "../timeline/TriggerControls";
import { EditorDetailsPanel } from "./EditorDetailsPanel";

/** Full v2 action editor in the shared right-side details surface. */
export function InteractionActionPopover({
  document,
  interaction,
  onConfigureCustomRoute,
  onClose,
}: {
  document: EditorDocument;
  interaction: Interaction;
  onConfigureCustomRoute?: (interactionId: string) => void;
  onClose: () => void;
}) {
  const interactions = document.data.choreography.interactions;
  const name = interaction.label ?? interaction.verb;
  const deleteInteraction = () => {
    document.removeInteraction(interaction.id);
    onClose();
  };

  const replaceTrigger = (
    slot: "trigger" | "until",
    trigger: Trigger | undefined,
  ) => {
    const next = { ...interaction };
    if (slot === "trigger") next.trigger = trigger ?? { kind: "at", t: 0 };
    else if (trigger) next.until = trigger;
    else delete next.until;
    document.replaceInteraction(interaction.id, next);
  };

  const semanticTarget =
    (interaction.verb === "speed" && interaction.target.mode === "absolute") ||
    (interaction.verb === "changeLane" && interaction.target.mode === "relative");
  const customRouteTarget = interaction.verb === "route" && (
    interaction.target.mode === "customRoute" || interaction.target.mode === "customTimedRoute"
  )
    ? interaction.target
    : null;

  if (customRouteTarget) {
    return (
      <EditorDetailsPanel
        ariaLabel="Custom route details"
        id={`scenario-interaction-${interaction.id}`}
        onClose={onClose}
        onDelete={deleteInteraction}
        preview={(
          <div className="flex flex-col items-center gap-1 text-center">
            <Route aria-hidden="true" className="size-9 text-[#E8E044]" />
            <strong className="text-xs font-medium text-white">
              {customRouteTarget.mode === "customTimedRoute" ? "Custom timed route" : "Custom route"}
            </strong>
          </div>
        )}
        testId="scenario-custom-route-panel"
      >
        <button
          className="editor-motion flex h-10 w-full items-center justify-center rounded-lg border border-[#E8E044] bg-[#E8E044] px-3 text-xs font-semibold text-black hover:bg-[#f4ed5d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
          data-testid={`interaction-custom-route-configure-${interaction.id}`}
          onClick={() => {
            onConfigureCustomRoute?.(interaction.id);
            onClose();
          }}
          type="button"
        >
          Configure
        </button>
      </EditorDetailsPanel>
    );
  }

  return (
    <EditorDetailsPanel
      ariaLabel={`${name} interaction details`}
      id={`scenario-interaction-${interaction.id}`}
      onClose={onClose}
      onDelete={deleteInteraction}
      preview={(
        <div className="flex flex-col items-center gap-1 text-center">
          <Workflow aria-hidden="true" className="size-9 text-[#E8E044]" />
          <span className="text-[9px] uppercase tracking-[0.16em] text-white/40">
            Editing interaction
          </span>
          <strong className="max-w-full truncate text-xs font-medium text-white">{name}</strong>
        </div>
      )}
      testId="scenario-interaction-popover"
    >
      <div
        className="space-y-4"
        data-actor-id={interaction.actor}
        data-interaction-id={interaction.id}
        data-testid={`interaction-overlay-editor-${interaction.id}`}
      >
        <p className="break-all text-[10px] uppercase tracking-[0.14em] text-white/40">
          {interaction.actor} · {interaction.verb}
        </p>
        <div className="grid grid-cols-1 gap-3">
          <TriggerControls
            label="Starts"
            value={interaction.trigger}
            document={document}
            actorId={interaction.actor}
            interactionId={interaction.id}
            interactions={interactions}
            onChange={(value) => replaceTrigger("trigger", value)}
          />
          <TriggerControls
            label="Ends"
            value={interaction.until}
            document={document}
            actorId={interaction.actor}
            interactionId={interaction.id}
            interactions={interactions}
            optional
            onChange={(value) => replaceTrigger("until", value)}
          />
          <InteractionSemanticsControls
            document={document}
            interaction={interaction}
          />
          {!semanticTarget ? (
            <div className="border-t border-white/10 pt-3">
              <InteractionTargetControls
                document={document}
                interaction={interaction}
              />
            </div>
          ) : null}
        </div>
        <button
          className="editor-motion flex w-full items-center justify-center gap-2 border border-red-400/30 px-3 py-2 text-xs text-red-300 hover:bg-red-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
          data-testid={`interaction-overlay-delete-${interaction.id}`}
          type="button"
          onClick={deleteInteraction}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
          Delete action
        </button>
      </div>
    </EditorDetailsPanel>
  );
}
