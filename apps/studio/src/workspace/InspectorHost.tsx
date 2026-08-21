import { EditorOverlayHost, EditorOverlayProvider } from '@uniscenarios/editor-ui';
import type { EditorController, EditorDocument, EditorState } from '@uniscenarios/editor-core';
import type { ActorPhysicsDisplay } from '@uniscenarios/playback';
import type { ActorRecord } from '../editor/document';
import { ActorInspectorPanel } from './ActorDetails';

export interface InspectorHostProps {
  controller: EditorController | null;
  document: EditorDocument | null;
  state: EditorState | null;
  /** Resolves the selected id against editable actors and materialized roles. */
  resolveActor: (actorId: string) => ActorRecord | null;
  physicsFor: (actorId: string) => ActorPhysicsDisplay | null;
  /** Route authoring owns the pointer; the details card would fight the draw. */
  suppress?: boolean;
  onSelectActor: (actorId: string | null) => void;
  onDeleteActor?: (actorId: string) => void;
}

/**
 * Selection-driven right inspector overlay. The provider adapts the editor
 * controller's actor selection to the mutually-exclusive overlay selection;
 * the host mounts exactly one details card for whatever is selected.
 */
export function InspectorHost({
  controller,
  document,
  state,
  resolveActor,
  physicsFor,
  suppress = false,
  onSelectActor,
  onDeleteActor,
}: InspectorHostProps): JSX.Element | null {
  if (!controller || !document) return null;
  const selectedActorId = state?.selection[0] ?? null;
  return (
    <EditorOverlayProvider
      documentKey={document}
      selectedActorId={selectedActorId}
      suppressActorDetails={suppress}
      onSelectActor={onSelectActor}
    >
      <EditorOverlayHost
        controller={controller}
        document={document}
        renderActorPanel={({ actorId }) => (
          <ActorInspectorPanel
            actor={resolveActor(actorId)}
            physics={physicsFor(actorId)}
            controller={controller}
            onClose={() => onSelectActor(null)}
            onDelete={onDeleteActor ? () => onDeleteActor(actorId) : undefined}
          />
        )}
      />
    </EditorOverlayProvider>
  );
}
