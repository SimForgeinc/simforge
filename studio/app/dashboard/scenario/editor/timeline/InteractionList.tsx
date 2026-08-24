"use client";

import { Radio, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type { Interaction, Trigger } from "@simforge/scenario";
import type { EditorDocument } from "@simforge/editor";
import {
  choreographyWindow,
  resolveInteractionLayout,
} from "@/app/lib/scenario/timeline";
import { InteractionTrack } from "./InteractionTrack";
import { InteractionTargetControls } from "./InteractionTargetControls";
import { TimelineRuler } from "./TimelineRuler";
import { TriggerControls } from "./TriggerControls";
import { triggerLabel } from "./trigger-defaults";

/**
 * The semantic timeline: one row per authored interaction, expandable into its
 * start and end triggers.
 *
 * Each row is a disclosure, so the button carries `aria-expanded` *and*
 * `aria-controls` pointing at the panel's `id` — v2 had the former without the
 * latter, which tells assistive tech that something expanded without saying what.
 *
 * Rows are ordered by authoring order, not by trigger time. A `when` trigger has
 * no time to sort by, and re-sorting rows as an author edits a threshold would
 * move the row out from under the pointer.
 *
 * ## The time axis (manifest 84)
 *
 * Each row carries a bar on a shared axis, so "at 3 s, do these three things"
 * is visible as three bars in a column rather than three numbers to compare by
 * eye. The words stay: `triggerLabel` remains on every row, because a `when`
 * trigger has no position worth reading off a rail and the bar can only say
 * "somewhere from here".
 *
 * Layout is resolved through the domain layer, which delegates to the model's
 * own timing analysis. The list does not compute times — if it did, the rail and
 * the validator could disagree, and that reads as a rendering bug.
 */
export function InteractionList({
  document,
  interactions,
  editingId,
  onEditingChange,
}: {
  document: EditorDocument;
  interactions: readonly Interaction[];
  editingId: string | null;
  onEditingChange: (id: string | null) => void;
}) {
  const { choreography } = document.data;
  const window = useMemo(() => choreographyWindow(choreography), [choreography]);
  // Keyed by id rather than index: a delete shifts every later index, and a bar drawn from a stale
  // index would attach to its neighbour's row — the kind of wrong that looks like a rendering glitch.
  const layout = useMemo(() => {
    const resolved = resolveInteractionLayout(document.data);
    return new Map(resolved.map((item) => [item.interaction.id, item]));
  }, [document.data]);

  const replaceTrigger = (
    interaction: Interaction,
    slot: "trigger" | "until",
    trigger: Trigger | undefined,
  ) => {
    const next = { ...interaction };
    if (slot === "trigger") next.trigger = trigger ?? { kind: "at", t: 0 };
    else if (trigger) next.until = trigger;
    else delete next.until;
    document.replaceInteraction(interaction.id, next);
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-[#0a0a0a] p-3 text-white" data-testid="semantic-timeline">
      <h2 className="mb-2 flex items-center text-micro font-semibold uppercase tracking-meta-wide text-white/45">
        <Radio aria-hidden="true" className="mr-2 size-3" />
        Semantic timeline
        <span className="ml-auto normal-case tracking-normal">
          {choreography.clipSeconds}s
        </span>
      </h2>
      {interactions.length > 0 ? <TimelineRuler choreography={choreography} /> : null}
      <div className="space-y-1">
        {interactions.map((interaction) => {
          const expanded = editingId === interaction.id;
          const panelId = `scenario-interaction-${interaction.id}`;
          const name = interaction.label ?? interaction.verb;
          const resolved = layout.get(interaction.id);
          return (
            <div key={interaction.id} data-testid={`interaction-row-${interaction.id}`}>
              <div
                className={`flex h-8 w-full items-center border text-xs ${
                  expanded
                    ? "border-[#E8E044]/60 bg-[#E8E044]/10"
                    : "border-white/10 bg-white/[0.035] hover:bg-white/[0.06]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onEditingChange(expanded ? null : interaction.id)}
                  aria-controls={panelId}
                  aria-expanded={expanded}
                  data-testid={`interaction-expand-${interaction.id}`}
                  className="editor-motion flex min-w-0 flex-1 items-center self-stretch px-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="w-24 truncate text-white/40">
                    {interaction.actor}
                  </span>
                  <span className="truncate font-medium">{name}</span>
                  <span className="ml-auto font-mono text-white/45">
                    {triggerLabel(interaction.trigger)}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete action ${name}`}
                  className="editor-motion mr-2 text-white/30 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
                  onClick={() => document.removeInteraction(interaction.id)}
                >
                  <Trash2 aria-hidden="true" className="size-3" />
                </button>
              </div>
              {resolved ? <InteractionTrack resolved={resolved} window={window} /> : null}
              <div
                className={
                  expanded
                    ? "grid grid-cols-2 gap-3 border-x border-b border-white/10 bg-[#111111] p-3"
                    : "hidden"
                }
                id={panelId}
                data-testid={`interaction-inspector-${interaction.id}`}
              >
                {expanded ? (
                  <>
                    <TriggerControls
                      label="Starts"
                      value={interaction.trigger}
                      document={document}
                      actorId={interaction.actor}
                      interactionId={interaction.id}
                      interactions={interactions}
                      onChange={(value) =>
                        replaceTrigger(interaction, "trigger", value)
                      }
                    />
                    <TriggerControls
                      label="Ends"
                      value={interaction.until}
                      document={document}
                      actorId={interaction.actor}
                      interactionId={interaction.id}
                      interactions={interactions}
                      optional
                      onChange={(value) => replaceTrigger(interaction, "until", value)}
                    />
                    <div className="col-span-2 border-t border-white/10 pt-3">
                      <InteractionTargetControls
                        document={document}
                        interaction={interaction}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
        {interactions.length === 0 ? (
          <p className="grid h-16 place-items-center border border-dashed border-white/15 text-xs text-white/35">
            Actions appear here as semantic, exportable OpenSCENARIO behavior.
          </p>
        ) : null}
      </div>
    </div>
  );
}
