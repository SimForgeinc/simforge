"use client";

import { Search } from "lucide-react";
import type { CSSProperties, DragEvent } from "react";
import type { CatalogEntry, CatalogId } from "@simforge/asset-catalog";

import type { CarlaCompatibility } from "@/app/lib/scenario/carla-compatibility";

import { CatalogTile } from "./CatalogTile";
import { MAX_TILE_STAGGER_MS, PanelSection, PanelTile, PanelTileGrid, type SceneSearchResult } from "./panel-tiles";

/** Order the scene panels appear under a universal search. */
const SCENE_SEARCH_GROUPS: readonly string[] = ["Weather", "Traffic"];

/**
 * One field over every panel. Models keep their own tile (drag, favourite,
 * CARLA mark); weather and traffic hits come back from their panels already
 * knowing how to apply themselves.
 */
export function PanelSearchResults({
  compatibilityByCatalogId,
  favorites,
  hitCount,
  modelGroups,
  onChooseModel,
  onDragEnd,
  onDragModel,
  onFavorite,
  placing,
  query,
  sceneResults,
}: {
  compatibilityByCatalogId: Record<string, CarlaCompatibility> | null;
  favorites: ReadonlySet<string>;
  hitCount: number;
  modelGroups: readonly { id: string; label: string; entries: readonly CatalogEntry[] }[];
  onChooseModel: (id: CatalogId) => void;
  onDragEnd: () => void;
  onDragModel: (event: DragEvent, id: CatalogId) => void;
  onFavorite: (id: string) => void;
  placing: string | null;
  query: string;
  sceneResults: readonly SceneSearchResult[];
}) {
  if (!query.trim()) {
    return (
      <div style={styles.empty} data-testid="search-prompt">
        <Search aria-hidden="true" size={26} strokeWidth={1.5} />
        <strong>Search every panel</strong>
        <span>Cars, pedestrians, props, weather, traffic — all from here.</span>
      </div>
    );
  }
  if (!hitCount) {
    return (
      <div style={styles.empty} data-testid="search-empty">
        <span style={styles.emptyGlyph}>⌕</span>
        <strong>Nothing matches “{query.trim()}”</strong>
        <span>Try a model name, a weather word, or “traffic”.</span>
      </div>
    );
  }
  let tileIndex = 0;
  return (
    <div data-testid="search-results">
      {modelGroups.map((group) => (
        <PanelSection
          count={group.entries.length}
          key={group.id}
          label={group.label}
          testId={`search-section-${group.id}`}
        >
          <PanelTileGrid>
            {group.entries.map((entry) => {
              const stagger = Math.min(tileIndex++ * 16, MAX_TILE_STAGGER_MS);
              return (
                <CatalogTile
                  key={entry.id}
                  entry={entry}
                  compatibility={compatibilityByCatalogId?.[entry.id] ?? null}
                  favorite={favorites.has(entry.id)}
                  active={placing === entry.id}
                  stagger={stagger}
                  onChoose={() => onChooseModel(entry.id as CatalogId)}
                  onFavorite={() => onFavorite(entry.id)}
                  onDragStart={(event) => onDragModel(event, entry.id as CatalogId)}
                  onDragEnd={onDragEnd}
                />
              );
            })}
          </PanelTileGrid>
        </PanelSection>
      ))}
      {SCENE_SEARCH_GROUPS.map((groupLabel) => {
        const hits = sceneResults.filter((result) => result.group === groupLabel);
        if (!hits.length) return null;
        return (
          <PanelSection
            count={hits.length}
            key={groupLabel}
            label={groupLabel}
            testId={`search-section-${groupLabel.toLowerCase()}`}
          >
            <PanelTileGrid>
              {hits.map((hit) => (
                <PanelTile
                  active={hit.active}
                  detail={hit.detail}
                  icon={hit.icon}
                  index={tileIndex++}
                  key={hit.id}
                  label={hit.label}
                  onChoose={hit.apply}
                  testId={`search-${hit.id}`}
                />
              ))}
            </PanelTileGrid>
          </PanelSection>
        );
      })}
    </div>
  );
}


const styles: Record<string, CSSProperties> = {
  empty: { height: 210, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, color: "#727b88", fontSize: 10, textAlign: "center" },
  emptyGlyph: { fontSize: 30, color: "#555d68" },
};
