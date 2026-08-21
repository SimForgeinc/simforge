import { describe, expect, it } from "vitest";

import {
  UNISCENARIO_EDITOR_SHELL_COLORS,
  UNISCENARIO_EDITOR_SHELL_GEOMETRY,
  UNISCENARIO_EDITOR_SHELL_STYLE,
} from "./tokens.js";
import { clampPanelWidth } from "./use-panel-edge-resize.js";
import { computeAnchoredPopoverPlacement } from "./inspector/anchored-popover.js";
import {
  clampTimelineHeightPx,
  clampTimelineIdentityWidthPx,
  timelineContentHeightPx,
  timelineDefaultHeightPx,
} from "./timeline/v1-timeline-rail.js";

describe("editor shell tokens", () => {
  it("installs the shared V1 palette and geometry as CSS variables", () => {
    expect(UNISCENARIO_EDITOR_SHELL_STYLE["--uniscenario-header-height"]).toBe(UNISCENARIO_EDITOR_SHELL_GEOMETRY.headerHeight);
    expect(UNISCENARIO_EDITOR_SHELL_STYLE["--uniscenario-chrome-workspace"]).toBe(UNISCENARIO_EDITOR_SHELL_COLORS.workspace);
    expect(UNISCENARIO_EDITOR_SHELL_COLORS.accent).toBe("#e8e044");
  });
});

describe("panel width clamping", () => {
  it("keeps panels inside the given bounds and rejects non-finite values", () => {
    expect(clampPanelWidth(10, { minWidth: 132, maxWidth: 192 })).toBe(132);
    expect(clampPanelWidth(10_000, { minWidth: 132, maxWidth: 192 })).toBe(192);
    expect(clampPanelWidth(Number.NaN, { minWidth: 132, maxWidth: 192 })).toBe(192);
  });
});

describe("anchored popover placement", () => {
  it("returns a placement inside the viewport for a mid-screen anchor", () => {
    const placement = computeAnchoredPopoverPlacement({
      anchor: { left: 500, top: 300, right: 560, bottom: 330 },
      viewport: { width: 1000, height: 600 },
      preferredWidth: 240,
      panelHeight: 120,
      maxPreferredHeight: 320,
      minimumUsefulHeight: 80,
    });
    expect(placement).toBeTruthy();
    expect(placement!.side).toBeDefined();
  });
});

describe("timeline geometry helpers", () => {
  it("scales content height with visible lane rows", () => {
    expect(timelineContentHeightPx(3)).toBeLessThan(timelineContentHeightPx(30));
  });

  it("derives a default height from lane rows and clamps to the viewport", () => {
    const height = timelineDefaultHeightPx(4);
    expect(height).toBeGreaterThan(0);
    expect(clampTimelineHeightPx(height, 400)).toBeLessThanOrEqual(400);
    expect(clampTimelineHeightPx(-10, 400)).toBeGreaterThan(0);
  });

  it("clamps identity width into the rail bounds", () => {
    expect(clampTimelineIdentityWidthPx(50, 200)).toBeGreaterThanOrEqual(0);
    expect(clampTimelineIdentityWidthPx(9_999, 200)).toBeLessThanOrEqual(200);
  });
});
