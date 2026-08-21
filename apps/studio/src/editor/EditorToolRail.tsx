import { memo, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import {
  CATALOG,
  type CatalogEntry,
  type CatalogId,
  type PropClass,
} from '@uniscenarios/prop-catalog';
import type { EditorController, EditorMode, EditorState } from './controller';

const ACCENT = '#f07f2f';
const PANEL = 'rgba(28, 30, 35, 0.97)';
const BORDER = '1px solid #3a3d44';
const FAVORITES_KEY = 'uniscenarios.studio.catalog-favorites.v1';
const RECENTS_KEY = 'uniscenarios.studio.catalog-recents.v1';
const MAX_RECENTS = 8;

export type ViewportTool = 'select' | 'rotate' | 'add' | 'ambient' | 'camera' | 'saved' | 'variations' | 'copilot' | 'measure';
export type CatalogFilter = 'all' | 'vehicle' | 'pedestrian' | 'prop' | 'favorite' | 'recent';

/**
 * The catalog deliberately depends on this tiny placement seam rather than a
 * document implementation. Today it arms the viewport placement controller;
 * the v2 Studio document can replace that controller without changing catalog
 * UX or teaching React components how roles and props are persisted.
 */
export interface CatalogPlacementAdapter {
  readonly enabled: boolean;
  readonly placing: CatalogId | null;
  arm(catalogId: CatalogId, intent: 'click' | 'drag'): void;
  armKind(kind: 'vehicle' | 'pedestrian'): void;
  cancel(): void;
}

export interface EditorToolRailProps {
  controller: EditorController | null;
  state: EditorState | null;
  placement: CatalogPlacementAdapter;
  /** False throughout preparing, paused, playing and ended playback states. */
  authoringEnabled: boolean;
  /** Opens an application-owned drawer, or closes it with `null`. */
  onToolRequest?: (tool: Exclude<ViewportTool, 'select' | 'rotate' | 'add'> | null) => void;
  /** Application-owned auxiliary tool, kept in sync when a popover closes externally. */
  auxiliaryTool?: Exclude<ViewportTool, 'select' | 'rotate' | 'add'> | null;
}

/** The authoring rail is overlay chrome and should disappear outside mutable authoring. */
export function shouldShowEditorToolRail(authoringEnabled: boolean, mapWorkspaceOpen: boolean): boolean {
  return authoringEnabled && !mapWorkspaceOpen;
}

interface ToolDefinition {
  id: ViewportTool;
  label: string;
  glyph: string;
  shortcut?: string;
  needsSelection?: boolean;
}

const TOOLS: readonly ToolDefinition[] = [
  { id: 'select', label: 'Select', glyph: '↖', shortcut: 'Esc' },
  { id: 'rotate', label: 'Rotate', glyph: '↻', shortcut: 'R', needsSelection: true },
  { id: 'add', label: 'Add actor', glyph: '+', shortcut: 'A' },
  { id: 'ambient', label: 'Ambient traffic', glyph: '≋' },
  { id: 'camera', label: 'Camera', glyph: '▣' },
  { id: 'saved', label: 'Scenario Gallery', glyph: '▦' },
  { id: 'variations', label: 'Find variations', glyph: '⎇' },
  { id: 'copilot', label: 'Scenario Copilot', glyph: '✦' },
  { id: 'measure', label: 'Measure', glyph: '⌇' },
] as const;

const FILTERS: readonly { id: CatalogFilter; label: string }[] = [
  { id: 'all', label: 'Props' },
  { id: 'favorite', label: 'Favorites' },
  { id: 'recent', label: 'Recent' },
] as const;

export function filterCatalog(
  entries: readonly CatalogEntry[],
  filter: CatalogFilter,
  query: string,
  favorites: ReadonlySet<string>,
  recents: readonly string[],
): CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  const recentRank = new Map(recents.map((id, index) => [id, index]));
  return entries
    .filter((entry) => {
      if (filter === 'vehicle' && entry.class !== 'vehicle') return false;
      if (filter === 'pedestrian' && entry.class !== 'pedestrian') return false;
      if (filter === 'prop' && (entry.class === 'vehicle' || entry.class === 'pedestrian')) return false;
      if (filter === 'favorite' && !favorites.has(entry.id)) return false;
      if (filter === 'recent' && !recentRank.has(entry.id)) return false;
      if (!needle) return true;
      return `${entry.label} ${entry.id} ${entry.description} ${entry.class} ${entry.tags.join(' ')}`
        .toLowerCase()
        .includes(needle);
    })
    .sort((a, b) => {
      if (filter === 'recent') return (recentRank.get(a.id) ?? Infinity) - (recentRank.get(b.id) ?? Infinity);
      return a.label.localeCompare(b.label);
    });
}

export function pushRecent(recents: readonly string[], id: string): string[] {
  return [id, ...recents.filter((item) => item !== id)].slice(0, MAX_RECENTS);
}

export const EditorToolRail = memo(function EditorToolRail({
  controller,
  state,
  placement,
  authoringEnabled,
  onToolRequest,
  auxiliaryTool = null,
}: EditorToolRailProps): JSX.Element {
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(() => readStoredIds(FAVORITES_KEY));
  const [recents, setRecents] = useState<string[]>(() => [...readStoredIds(RECENTS_KEY)]);

  const enabled = authoringEnabled && placement.enabled;
  useEffect(() => {
    if (enabled) return;
    setCatalogOpen(false);
    onToolRequest?.(null);
    placement.cancel();
  }, [enabled, onToolRequest, placement]);

  const choose = (id: CatalogId, intent: 'click' | 'drag'): void => {
    if (!enabled) return;
    placement.arm(id, intent);
    setRecents((current) => {
      const next = pushRecent(current, id);
      writeStoredIds(RECENTS_KEY, next);
      return next;
    });
    setCatalogOpen(false);
  };

  const run = (tool: ToolDefinition): void => {
    if (!authoringEnabled || !controller) return;
    if (tool.id === 'select') {
      placement.cancel();
      controller.cancel();
      onToolRequest?.(null);
    } else if (tool.id === 'rotate') {
      controller.beginRotate();
      onToolRequest?.(null);
    } else if (tool.id === 'add') {
      setCatalogOpen((open) => !open);
      onToolRequest?.(null);
    } else {
      placement.cancel();
      setCatalogOpen(false);
      const next = auxiliaryTool === tool.id ? null : tool.id;
      onToolRequest?.(next);
    }
  };

  const toggleFavorite = (id: string): void => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeStoredIds(FAVORITES_KEY, [...next]);
      return next;
    });
  };

  const activeTool = toolForMode(state?.mode, catalogOpen, auxiliaryTool);

  return (
    <>
      <nav style={styles.rail} aria-label="Authoring tools" data-testid="editor-tool-rail">
        {TOOLS.map((tool, index) => {
          const disabled = !authoringEnabled || !controller || (!!tool.needsSelection && !state?.selection.length);
          const active = activeTool === tool.id;
          return (
            <button
              key={tool.id}
              type="button"
              aria-label={tool.label}
              aria-pressed={active}
              aria-haspopup={tool.id === 'ambient' ? 'dialog' : undefined}
              aria-controls={tool.id === 'ambient' && active ? 'ambient-traffic-popover' : undefined}
              title={`${tool.label}${tool.shortcut ? ` (${tool.shortcut})` : ''}`}
              disabled={disabled}
              data-testid={`tool-${tool.id}`}
              style={{
                ...styles.toolButton,
                ...(index === 3 || index === 4 || index === 5 ? styles.toolDivider : null),
                ...(active ? styles.toolButtonActive : null),
                ...(disabled ? styles.disabled : null),
              }}
              onClick={() => run(tool)}
            >
              <span style={styles.toolGlyph}>{tool.glyph}</span>
              <span style={styles.tooltip}>{tool.label}</span>
            </button>
          );
        })}
      </nav>
      {catalogOpen && enabled ? (
        <CatalogDrawer
          filter={filter}
          query={query}
          favorites={favorites}
          recents={recents}
          placing={placement.placing}
          onFilter={setFilter}
          onQuery={setQuery}
          onChoose={choose}
          onChooseKind={(kind) => {
            placement.armKind(kind);
            setCatalogOpen(false);
          }}
          onFavorite={toggleFavorite}
          onClose={() => setCatalogOpen(false)}
        />
      ) : null}
    </>
  );
});

function CatalogDrawer({
  filter,
  query,
  favorites,
  recents,
  placing,
  onFilter,
  onQuery,
  onChoose,
  onChooseKind,
  onFavorite,
  onClose,
}: {
  filter: CatalogFilter;
  query: string;
  favorites: ReadonlySet<string>;
  recents: readonly string[];
  placing: CatalogId | null;
  onFilter: (filter: CatalogFilter) => void;
  onQuery: (value: string) => void;
  onChoose: (id: CatalogId, intent: 'click' | 'drag') => void;
  onChooseKind: (kind: 'vehicle' | 'pedestrian') => void;
  onFavorite: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const entries = useMemo(
    () => filterCatalog(CATALOG, filter, query, favorites, recents)
      .filter((entry) => entry.class !== 'vehicle' && entry.class !== 'pedestrian'),
    [filter, query, favorites, recents],
  );
  const groups = useMemo(() => groupEntries(entries), [entries]);

  const drag = (event: DragEvent, id: CatalogId): void => {
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('application/x-uniscenarios-catalog-id', id);
    event.dataTransfer.setData('text/plain', id);
    onChoose(id, 'drag');
  };

  return (
    <aside style={styles.drawer} aria-label="Actor catalog" data-testid="catalog-drawer">
      <div style={styles.drawerHeader}>
        <div>
          <div style={styles.drawerEyebrow}>Add to scenario</div>
          <div style={styles.drawerTitle}>Actor catalog</div>
        </div>
        <button type="button" aria-label="Close catalog" style={styles.closeButton} onClick={onClose}>×</button>
      </div>
      <div style={styles.searchWrap}>
        <span style={styles.searchGlyph}>⌕</span>
        <input
          autoFocus
          type="search"
          aria-label="Search catalog"
          placeholder="Search actors, props, or use…"
          value={query}
          style={styles.search}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose();
          }}
        />
      </div>
      <div style={styles.primaryActors} aria-label="Primary actors">
        <button type="button" style={styles.primaryActor} onClick={() => onChooseKind('vehicle')} data-testid="catalog-primary-vehicle">
          <span style={{ ...styles.primaryGlyph, color: '#68a5ff' }}>▱</span>
          <span><strong>Vehicle</strong><small>Random compatible road model</small></span>
        </button>
        <button type="button" style={styles.primaryActor} onClick={() => onChooseKind('pedestrian')} data-testid="catalog-primary-pedestrian">
          <span style={{ ...styles.primaryGlyph, color: '#f2b35f' }}>●</span>
          <span><strong>Pedestrian</strong><small>Random compatible person model</small></span>
        </button>
      </div>
      <div style={styles.filters} aria-label="Catalog filters">
        {FILTERS.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-pressed={filter === item.id}
            style={{ ...styles.filter, ...(filter === item.id ? styles.filterActive : null) }}
            onClick={() => onFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div style={styles.drawerBody}>
        {entries.length === 0 ? (
          <div style={styles.empty}>
            <span style={styles.emptyGlyph}>⌕</span>
            <strong>No catalog matches</strong>
            <span>Try another search or category.</span>
          </div>
        ) : (
          groups.map(([group, items]) => (
            <section key={group} style={styles.catalogGroup}>
              <div style={styles.groupHeader}>
                <span>{classLabel(group)}</span>
                <span style={styles.groupCount}>{items.length}</span>
              </div>
              <div style={styles.catalogGrid}>
                {items.map((entry) => (
                  <CatalogCard
                    key={entry.id}
                    entry={entry}
                    favorite={favorites.has(entry.id)}
                    active={placing === entry.id}
                    onChoose={onChoose}
                    onFavorite={onFavorite}
                    onDragStart={drag}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      <div style={styles.drawerFooter}>
        <span>Click or drag to arm placement</span>
        <span>Esc / right-click cancels</span>
      </div>
    </aside>
  );
}

function CatalogCard({
  entry,
  favorite,
  active,
  onChoose,
  onFavorite,
  onDragStart,
}: {
  entry: CatalogEntry;
  favorite: boolean;
  active: boolean;
  onChoose: (id: CatalogId, intent: 'click' | 'drag') => void;
  onFavorite: (id: string) => void;
  onDragStart: (event: DragEvent, id: CatalogId) => void;
}): JSX.Element {
  const id = entry.id as CatalogId;
  return (
    <div
      draggable
      title={entry.description}
      style={{ ...styles.card, ...(active ? styles.cardActive : null) }}
      data-testid={`catalog-${entry.id}`}
      onDragStart={(event) => onDragStart(event, id)}
      onClick={() => onChoose(id, 'click')}
    >
      <span style={{ ...styles.cardIcon, color: classColor(entry.class) }}>{classGlyph(entry.class)}</span>
      <span style={styles.cardCopy}>
        <strong style={styles.cardLabel}>{entry.label}</strong>
        <span style={styles.cardMeta}>{entry.dims.l.toFixed(1)} × {entry.dims.w.toFixed(1)} m</span>
      </span>
      <button
        type="button"
        aria-label={`${favorite ? 'Remove' : 'Add'} ${entry.label} ${favorite ? 'from' : 'to'} favorites`}
        aria-pressed={favorite}
        style={{ ...styles.favorite, ...(favorite ? styles.favoriteActive : null) }}
        onClick={(event) => {
          event.stopPropagation();
          onFavorite(entry.id);
        }}
      >
        {favorite ? '★' : '☆'}
      </button>
    </div>
  );
}

function toolForMode(mode: EditorMode | undefined, catalogOpen: boolean, auxiliary: ViewportTool | null): ViewportTool {
  if (catalogOpen || mode === 'placing') return 'add';
  if (mode === 'rotate') return 'rotate';
  return auxiliary ?? 'select';
}

/** Saved workspaces from the dedicated-Move era reopen in ordinary Select. */
export function migrateViewportTool(value: unknown): ViewportTool {
  if (value === 'move') return 'select';
  return TOOLS.some((tool) => tool.id === value) ? value as ViewportTool : 'select';
}

function groupEntries(entries: readonly CatalogEntry[]): [PropClass, CatalogEntry[]][] {
  const order: readonly PropClass[] = ['vehicle', 'pedestrian', 'construction', 'occluder', 'street', 'hazard'];
  return order
    .map((kind) => [kind, entries.filter((entry) => entry.class === kind)] as [PropClass, CatalogEntry[]])
    .filter(([, items]) => items.length > 0);
}

function classLabel(kind: PropClass): string {
  return kind === 'street' ? 'Street furniture' : `${kind[0]?.toUpperCase()}${kind.slice(1)}`;
}

function classGlyph(kind: PropClass): string {
  if (kind === 'vehicle') return '▱';
  if (kind === 'pedestrian') return '●';
  if (kind === 'construction') return '▲';
  if (kind === 'street') return '⌑';
  if (kind === 'occluder') return '▰';
  return '◆';
}

function classColor(kind: PropClass): string {
  if (kind === 'vehicle') return '#68a5ff';
  if (kind === 'pedestrian') return '#f2b35f';
  if (kind === 'construction') return '#ff9250';
  if (kind === 'street') return '#72c4ae';
  if (kind === 'occluder') return '#a68de7';
  return '#e06767';
}

function readStoredIds(key: string): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    const value = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeStoredIds(key: string, ids: readonly string[]): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(ids));
  } catch {
    // Favorites and recents are convenience state; private mode must not block authoring.
  }
}

const styles: Record<string, CSSProperties> = {
  rail: {
    position: 'absolute', zIndex: 22, right: 10, top: 12, width: 44,
    display: 'flex', flexDirection: 'column', gap: 2, padding: 4,
    borderRadius: 7, background: PANEL, border: BORDER,
    boxShadow: '0 8px 28px rgba(0,0,0,.38)', userSelect: 'none',
  },
  toolButton: {
    position: 'relative', width: 36, height: 36, display: 'grid', placeItems: 'center',
    padding: 0, border: '1px solid transparent', borderRadius: 5,
    background: 'transparent', color: '#adb4c0', font: 'inherit', cursor: 'pointer',
  },
  toolButtonActive: { background: '#315f98', border: '1px solid #5d9de8', color: '#fff', boxShadow: 'inset 0 1px rgba(255,255,255,.15)' },
  toolDivider: { marginTop: 5, boxShadow: '0 -4px 0 -3px #464950' },
  toolGlyph: { fontSize: 20, lineHeight: 1, fontWeight: 500 },
  tooltip: { position: 'absolute', left: 45, pointerEvents: 'none', opacity: 0, width: 1, height: 1, overflow: 'hidden' },
  disabled: { opacity: .28, cursor: 'default' },
  drawer: {
    position: 'absolute', zIndex: 21, top: 12, right: 63, bottom: 12, width: 372,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    borderRadius: 9, background: PANEL, border: BORDER,
    boxShadow: '0 18px 48px rgba(0,0,0,.52)',
  },
  drawerHeader: { display: 'flex', alignItems: 'center', padding: '13px 14px 10px', borderBottom: '1px solid #34373d' },
  drawerEyebrow: { color: ACCENT, fontSize: 9, fontWeight: 750, letterSpacing: .9, textTransform: 'uppercase' },
  drawerTitle: { color: '#eef0f4', fontSize: 15, fontWeight: 680 },
  closeButton: { marginLeft: 'auto', width: 28, height: 28, border: 0, borderRadius: 5, background: 'transparent', color: '#949ba7', fontSize: 22, cursor: 'pointer' },
  searchWrap: { position: 'relative', padding: '10px 12px 7px' },
  searchGlyph: { position: 'absolute', left: 22, top: 14, color: '#737b88', fontSize: 16, pointerEvents: 'none' },
  search: { width: '100%', height: 32, boxSizing: 'border-box', padding: '5px 10px 5px 31px', border: '1px solid #444850', borderRadius: 5, background: '#14161a', color: '#e2e5ea', font: 'inherit', fontSize: 11, outline: 'none' },
  filters: { display: 'flex', gap: 4, padding: '0 12px 9px', overflowX: 'auto' },
  primaryActors: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, padding: '3px 12px 11px', borderBottom: '1px solid #34373d' },
  primaryActor: { minWidth: 0, minHeight: 70, display: 'flex', alignItems: 'center', gap: 9, padding: '9px', border: '1px solid #4a4f58', borderRadius: 7, background: '#25282e', color: '#edf0f5', cursor: 'pointer', textAlign: 'left' },
  primaryGlyph: { fontSize: 24 },
  filter: { flex: '0 0 auto', padding: '4px 8px', border: '1px solid #3b3f46', borderRadius: 999, background: '#22252a', color: '#8e96a2', font: 'inherit', fontSize: 9, cursor: 'pointer' },
  filterActive: { border: '1px solid #d56d27', background: '#5a3521', color: '#ffd2b2' },
  drawerBody: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 12px 12px' },
  catalogGroup: { marginBottom: 13 },
  groupHeader: { display: 'flex', alignItems: 'center', gap: 6, height: 24, color: '#969eaa', fontSize: 9, fontWeight: 700, letterSpacing: .65, textTransform: 'uppercase' },
  groupCount: { marginLeft: 'auto', color: '#646c78' },
  catalogGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 },
  card: { minWidth: 0, minHeight: 52, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 7px', boxSizing: 'border-box', border: '1px solid #373a41', borderRadius: 6, background: '#222429', color: '#d8dce2', cursor: 'grab', userSelect: 'none' },
  cardActive: { border: '1px solid #f08a43', background: '#4a3020' },
  cardIcon: { flex: '0 0 auto', width: 20, textAlign: 'center', fontSize: 16 },
  cardCopy: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 },
  cardLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, fontWeight: 620 },
  cardMeta: { color: '#737c89', fontSize: 8, fontVariantNumeric: 'tabular-nums' },
  favorite: { flex: '0 0 auto', width: 21, height: 25, padding: 0, border: 0, background: 'transparent', color: '#69717d', cursor: 'pointer', fontSize: 15 },
  favoriteActive: { color: '#f1b74f' },
  empty: { height: 190, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, color: '#727b88', fontSize: 10 },
  emptyGlyph: { fontSize: 30, color: '#555d68' },
  drawerFooter: { display: 'flex', justifyContent: 'space-between', padding: '7px 12px', borderTop: '1px solid #34373d', color: '#69717d', fontSize: 8 },
};
