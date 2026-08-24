"use client";

import type {
  CSSProperties,
  HTMLAttributes,
  ReactNode,
} from "react";
import { cn } from "@/app/lib/utils";
import styles from "./ScenarioEditorShell.module.css";
import {
  SCENARIO_EDITOR_SHELL_STYLE,
  type ScenarioEditorShellStyle,
} from "./editor-shell-tokens";

export type ScenarioEditorCanvasMode = "interactive" | "passthrough";

export type ScenarioEditorShellSlotProps = HTMLAttributes<HTMLDivElement> & {
  "data-editor-shell-region": string;
  "data-open"?: string;
  "data-testid"?: string;
  "data-tutorial"?: string;
};

/**
 * A shell slot can be a plain node, or a render function that spreads the
 * supplied geometry and legacy selector props onto its own root. The latter is
 * the integration path for existing regions: it preserves selector identity
 * without introducing a duplicate wrapper around a Three.js host or tool rail.
 */
export type ScenarioEditorShellSlot =
  | ReactNode
  | ((slotProps: ScenarioEditorShellSlotProps) => ReactNode);

export interface ScenarioEditorShellProps
  extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  "data-testid"?: string;
  header: ScenarioEditorShellSlot;
  leftSidebar: ScenarioEditorShellSlot;
  canvas: ScenarioEditorShellSlot;
  statusOverlay?: ScenarioEditorShellSlot;
  floatingOverlay?: ScenarioEditorShellSlot;
  canvasMode?: ScenarioEditorCanvasMode;
  disabled?: boolean;
  geometryStyle?: ScenarioEditorShellStyle;
}

/**
 * V1-style, runtime-free composition shell for Scenario authoring.
 *
 * It owns only geometry, stacking and disabled/pass-through behavior. In
 * particular, changing a drawer or workspace overlay never conditions the
 * canvas slot, so a mounted Three.js surface stays mounted.
 */
export function ScenarioEditorShell({
  header,
  leftSidebar,
  canvas,
  statusOverlay,
  floatingOverlay,
  canvasMode = "interactive",
  disabled = false,
  geometryStyle,
  className,
  style,
  "data-testid": testId = "scenario-editor-shell",
  ...rootProps
}: ScenarioEditorShellProps) {
  const chromeDisabled = disabled;
  const shellStyle = {
    ...SCENARIO_EDITOR_SHELL_STYLE,
    ...geometryStyle,
    ...style,
  } as CSSProperties;

  return (
    <section
      {...rootProps}
      aria-disabled={chromeDisabled || undefined}
      className={cn(styles.shell, className)}
      data-canvas-mode={canvasMode}
      data-editor-shell-geometry="v1"
      data-has-header={String(header !== null && header !== undefined)}
      data-testid={testId}
      style={shellStyle}
    >
      {header !== null && header !== undefined
        ? renderSlot(header, {
            className: cn(styles.header, chromeDisabled && styles.disabledChrome),
            "data-editor-shell-region": "header",
            inert: chromeDisabled || undefined,
          })
        : null}

      <div className={styles.body} data-editor-shell-region="body">
        {leftSidebar !== null && leftSidebar !== undefined
          ? renderSlot(leftSidebar, {
              className: cn(styles.leftSidebar, chromeDisabled && styles.disabledChrome),
              "data-editor-shell-region": "left-sidebar",
              inert: chromeDisabled || undefined,
            })
          : null}

        <div className={styles.viewport} data-editor-shell-region="viewport">
          {renderSlot(canvas, {
            className: cn(
              styles.canvas,
              canvasMode === "passthrough" && styles.passthrough,
              chromeDisabled && styles.disabledChrome,
            ),
            "data-editor-shell-region": "canvas",
            "data-tutorial": "canvas",
            "data-testid": "scenario-editor-canvas-region",
            inert: chromeDisabled || undefined,
          })}
          {statusOverlay
            ? renderSlot(statusOverlay, {
                className: styles.statusLayer,
                "data-editor-shell-region": "status-overlay",
              })
            : null}
          {floatingOverlay
            ? renderSlot(floatingOverlay, {
                className: styles.floatingLayer,
                "data-editor-shell-region": "floating-overlay",
              })
            : null}
        </div>

      </div>

    </section>
  );
}

function renderSlot(
  slot: ScenarioEditorShellSlot,
  slotProps: ScenarioEditorShellSlotProps,
) {
  if (typeof slot === "function") return slot(slotProps);
  return <div {...slotProps}>{slot}</div>;
}
