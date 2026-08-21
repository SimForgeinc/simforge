import { ActorLibraryRail } from '@uniscenarios/editor-ui';
import type { EditorController, EditorDocument, EditorState } from '@uniscenarios/editor-core';
import type { RefObject } from 'react';

export interface RailHostProps {
  controller: EditorController | null;
  state: EditorState | null;
  document: EditorDocument | null;
  hostRef: RefObject<HTMLDivElement | null>;
}

/**
 * The floating glass authoring rail on the viewport's left edge. Catalog
 * placement is armed straight on the editor controller — the same seam the
 * previous split-pane tool rail used — so ghost preview, click-to-place and
 * drag-and-drop keep their wiring.
 */
export function RailHost({ controller, state, document, hostRef }: RailHostProps): JSX.Element {
  return (
    <ActorLibraryRail
      controller={controller}
      state={state}
      hostRef={hostRef}
      document={document}
    />
  );
}
