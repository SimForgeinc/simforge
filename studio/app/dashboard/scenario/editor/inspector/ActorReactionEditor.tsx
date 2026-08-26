"use client";

import { useMemo, useState } from "react";
import type { ActorRecord, EditorDocument } from "@simforge-oss/editor";
import { ActionPalette } from "../timeline/ActionPalette";
import { InteractionList } from "../timeline/InteractionList";

/** Selected-actor behavior only; document-global authoring never enters this tab. */
export function ActorReactionEditor({
  actor,
  document,
}: {
  actor: ActorRecord;
  document: EditorDocument;
}) {
  const [time, setTime] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const role = document.data.roles.find((candidate) => candidate.id === actor.id) ?? null;
  const otherRole = document.data.roles.find((candidate) => candidate.id !== actor.id) ?? null;
  const interactions = useMemo(
    () => document.data.choreography.interactions.filter((interaction) => interaction.actor === actor.id),
    [actor.id, document.data.choreography.interactions],
  );

  return (
    <div className="mt-4 space-y-3" data-actor-id={actor.id} data-testid="actor-reaction-editor">
      <div className="flex min-h-0 overflow-hidden border border-white/10">
        <ActionPalette
          document={document}
          role={role}
          otherRole={otherRole}
          interactions={interactions}
          time={time}
          onTimeChange={setTime}
        />
        <InteractionList
          document={document}
          interactions={interactions}
          editingId={editingId}
          onEditingChange={setEditingId}
        />
      </div>
    </div>
  );
}
