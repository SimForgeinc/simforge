"use client";

import type { CSSProperties, ReactNode } from "react";

/**
 * The add-panel's one visual vocabulary: a titled section of tiles.
 *
 * Weather and traffic are chosen the same way an actor is chosen — pick the
 * thing that looks right — so they use the actor grid rather than a second
 * dialect of dropdowns and sliders. Hover, lift and entrance animation live in
 * `editor-ui.css` under `.ueui-catalog-tile`, shared with the model tiles.
 */
export const MAX_TILE_STAGGER_MS = 260;

/**
 * One hit from a scene panel (weather, traffic) for the universal search. Each
 * panel knows how to apply its own choice, so the search surface stays a
 * renderer and never learns what a "snow cover" is.
 */
export interface SceneSearchResult {
  id: string;
  label: string;
  detail: string;
  group: string;
  icon: ReactNode;
  active: boolean;
  apply: () => void;
}

/** Case-insensitive substring match over a tile's own words. */
export function matchesSearch(query: string, ...words: readonly string[]): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  return words.join(" ").toLowerCase().includes(needle);
}

export function PanelSection({
  children,
  count,
  label,
  testId,
}: {
  children: ReactNode;
  count?: number;
  label: string;
  testId?: string;
}) {
  return (
    <section className="ueui-panel-section" data-testid={testId} style={styles.section}>
      <div className="ueui-panel-section-header" style={styles.header}>
        <span>{label}</span>
        {count === undefined ? null : <span className="ueui-panel-section-count" style={styles.count}>{count}</span>}
      </div>
      {children}
    </section>
  );
}

export function PanelTileGrid({ children }: { children: ReactNode }) {
  return <div className="ueui-panel-tile-grid" style={styles.grid}>{children}</div>;
}

/** One choosable thing: glyph, name, and a line of detail. */
export function PanelTile({
  active,
  detail,
  disabled = false,
  icon,
  index = 0,
  label,
  onChoose,
  testId,
  title,
}: {
  active: boolean;
  detail?: string;
  disabled?: boolean;
  icon: ReactNode;
  index?: number;
  label: string;
  onChoose: () => void;
  testId?: string;
  title?: string;
}) {
  return (
    <button
      aria-pressed={active}
      className="ueui-catalog-tile ueui-catalog-tile-enter"
      data-active={String(active)}
      data-testid={testId}
      disabled={disabled}
      onClick={onChoose}
      style={{
        ...styles.tile,
        ...(disabled ? styles.tileDisabled : null),
        animationDelay: `${Math.min(index * 22, MAX_TILE_STAGGER_MS)}ms`,
      }}
      title={title}
      type="button"
    >
      <span className="ueui-catalog-tile-icon" style={styles.icon}>{icon}</span>
      <strong className="ueui-catalog-tile-label" style={styles.label}>{label}</strong>
      {detail ? <span className="ueui-catalog-tile-detail" style={styles.detail}>{detail}</span> : null}
    </button>
  );
}

const styles: Record<string, CSSProperties> = {
  section: { marginBottom: 15 },
  header: { display: "flex", alignItems: "center", gap: 6, height: 22, color: "#8f97a3", fontSize: 9, fontWeight: 700, letterSpacing: .65, textTransform: "uppercase" },
  count: { marginLeft: "auto", color: "#5f6773" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(114px, 1fr))", gap: 7 },
  tile: { position: "relative", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, padding: "9px 9px 8px", boxSizing: "border-box", font: "inherit", textAlign: "left", color: "#d8dce2", cursor: "pointer", userSelect: "none" },
  tileDisabled: { opacity: .38, cursor: "not-allowed" },
  icon: { width: 50, height: 32, marginBottom: 3, display: "grid", placeItems: "center", color: "#8fb7ff" },
  label: { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10.5, fontWeight: 620, color: "#eef1f6" },
  detail: { color: "#737c89", fontSize: 8.5 },
};
