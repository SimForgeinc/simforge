import type { CSSProperties } from "react";

/**
 * Geometry shared by the UniScenario editor chrome.
 *
 * Keep these values independent from the editor runtime. Consumers can tune the
 * shell without importing a store or remounting the Three.js world.
 */
export const UNISCENARIO_EDITOR_SHELL_GEOMETRY = {
  headerHeight: "3.5rem",
  leftSidebarWidth: "31.25rem",
  leftSidebarWideWidth: "31.25rem",
} as const;

/** V1's neutral instrument palette, separated from any controller state. */
export const UNISCENARIO_EDITOR_SHELL_COLORS = {
  workspace: "#0a0a0a",
  viewportFallback: "#050506",
  panel: "#111113",
  panelRaised: "#18181b",
  line: "rgba(255, 255, 255, 0.08)",
  text: "#f2f2f2",
  muted: "#9a9a9a",
  accent: "#e8e044",
} as const;

export type UniScenarioEditorShellStyle = CSSProperties & {
  "--uniscenario-header-height"?: string;
  "--uniscenario-left-sidebar-width"?: string;
  "--uniscenario-left-sidebar-wide-width"?: string;
  "--uniscenario-chrome-workspace"?: string;
  "--uniscenario-chrome-viewport"?: string;
  "--uniscenario-chrome-panel"?: string;
  "--uniscenario-chrome-line"?: string;
  "--uniscenario-chrome-text"?: string;
};

export const UNISCENARIO_EDITOR_SHELL_STYLE: UniScenarioEditorShellStyle = {
  "--uniscenario-header-height": UNISCENARIO_EDITOR_SHELL_GEOMETRY.headerHeight,
  "--uniscenario-left-sidebar-width": UNISCENARIO_EDITOR_SHELL_GEOMETRY.leftSidebarWidth,
  "--uniscenario-left-sidebar-wide-width": UNISCENARIO_EDITOR_SHELL_GEOMETRY.leftSidebarWideWidth,
  "--uniscenario-chrome-workspace": UNISCENARIO_EDITOR_SHELL_COLORS.workspace,
  "--uniscenario-chrome-viewport": UNISCENARIO_EDITOR_SHELL_COLORS.viewportFallback,
  "--uniscenario-chrome-panel": UNISCENARIO_EDITOR_SHELL_COLORS.panel,
  "--uniscenario-chrome-line": UNISCENARIO_EDITOR_SHELL_COLORS.line,
  "--uniscenario-chrome-text": UNISCENARIO_EDITOR_SHELL_COLORS.text,
};
