import type { CSSProperties } from "react";

/**
 * Geometry shared by the Scenario editor chrome.
 *
 * Keep these values independent from the editor runtime. Consumers can tune the
 * shell without importing a store or remounting the Three.js world.
 */
export const SCENARIO_EDITOR_SHELL_GEOMETRY = {
  headerHeight: "3.5rem",
  leftSidebarWidth: "31.25rem",
  leftSidebarWideWidth: "31.25rem",
} as const;

/** V1's neutral instrument palette, separated from any controller state. */
export const SCENARIO_EDITOR_SHELL_COLORS = {
  workspace: "#0a0a0a",
  viewportFallback: "#050506",
  panel: "#111113",
  panelRaised: "#18181b",
  line: "rgba(255, 255, 255, 0.08)",
  text: "#f2f2f2",
  muted: "#9a9a9a",
  accent: "#e8e044",
} as const;

export type ScenarioEditorShellStyle = CSSProperties & {
  "--scenario-header-height"?: string;
  "--scenario-left-sidebar-width"?: string;
  "--scenario-left-sidebar-wide-width"?: string;
  "--scenario-chrome-workspace"?: string;
  "--scenario-chrome-viewport"?: string;
  "--scenario-chrome-panel"?: string;
  "--scenario-chrome-line"?: string;
  "--scenario-chrome-text"?: string;
};

export const SCENARIO_EDITOR_SHELL_STYLE: ScenarioEditorShellStyle = {
  "--scenario-header-height": SCENARIO_EDITOR_SHELL_GEOMETRY.headerHeight,
  "--scenario-left-sidebar-width": SCENARIO_EDITOR_SHELL_GEOMETRY.leftSidebarWidth,
  "--scenario-left-sidebar-wide-width": SCENARIO_EDITOR_SHELL_GEOMETRY.leftSidebarWideWidth,
  "--scenario-chrome-workspace": SCENARIO_EDITOR_SHELL_COLORS.workspace,
  "--scenario-chrome-viewport": SCENARIO_EDITOR_SHELL_COLORS.viewportFallback,
  "--scenario-chrome-panel": SCENARIO_EDITOR_SHELL_COLORS.panel,
  "--scenario-chrome-line": SCENARIO_EDITOR_SHELL_COLORS.line,
  "--scenario-chrome-text": SCENARIO_EDITOR_SHELL_COLORS.text,
};
