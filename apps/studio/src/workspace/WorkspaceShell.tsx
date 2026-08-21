import type { ReactNode } from 'react';
import {
  UNISCENARIO_EDITOR_SHELL_STYLE,
  UniScenarioEditorShell,
  type UniScenarioEditorCanvasMode,
  type UniScenarioEditorShellSlotProps,
} from '@uniscenarios/editor-ui';
import './workspace-shell.css';

export interface WorkspaceShellProps {
  /** Top chrome: the existing WorkspaceHeader content. */
  header: ReactNode;
  /**
   * Floating glass rail over the viewport's left edge. Null collapses the
   * overlay entirely (playback inspection, map workspace).
   */
  rail: ReactNode | null;
  /**
   * The persistent canvas. Rendered as a slot function so the shell's canvas
   * region props land directly on the Three.js host div — no wrapper, so the
   * viewer keeps its layout box and the editor keeps its pointer plumbing.
   */
  canvas: (slotProps: UniScenarioEditorShellSlotProps) => ReactNode;
  /** Mode banners and placement hints, pinned above the canvas. */
  statusOverlay?: ReactNode;
  /** Floating chrome: timeline dock, drawers, replay bar, notices. */
  floatingOverlay?: ReactNode;
  canvasMode?: UniScenarioEditorCanvasMode;
  disabled?: boolean;
}

/**
 * Viewport-first workspace composition: a persistent canvas with the header,
 * the floating rail, and every panel as an overlay. Changing a drawer or
 * workspace never unmounts the canvas slot, so the streamed city survives.
 */
export function WorkspaceShell({
  header,
  rail,
  canvas,
  statusOverlay,
  floatingOverlay,
  canvasMode = 'interactive',
  disabled = false,
}: WorkspaceShellProps): JSX.Element {
  return (
    <UniScenarioEditorShell
      className="studio-editor-shell"
      geometryStyle={UNISCENARIO_EDITOR_SHELL_STYLE}
      canvasMode={canvasMode}
      disabled={disabled}
      header={<>{header}</>}
      leftSidebar={rail === null ? null : (slotProps) => (
        <div {...slotProps} className={`${slotProps.className ?? ''} studio-rail-slot`}>{rail}</div>
      )}
      canvas={canvas}
      statusOverlay={statusOverlay === undefined ? null : <>{statusOverlay}</>}
      floatingOverlay={floatingOverlay === undefined ? null : <>{floatingOverlay}</>}
    />
  );
}
