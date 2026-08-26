"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Bike, Bird, Bot, Box, CarFront, CloudSun, Images, PersonStanding, Plane, Route, Search, Shuffle, SquareParking, X } from "lucide-react";
import {
  getEntry,
  type CatalogEntry,
  type CatalogId,
  isCatalogId,
} from "@simforge-oss/asset-catalog";
import { CarlaReadyMark } from "@/app/components/CarlaReadyMark";
import {
  carlaCompatibilityFor,
  loadCarlaCompatibility,
  type CarlaCompatibility,
  type CarlaCompatibilityTable,
} from "@/app/lib/scenario/carla-compatibility";
import {
  registerCarlaObjects,
  type CarlaObjectDto,
} from "@/app/lib/scenario/carla-objects";

import type { SumoTrafficStatus } from "@simforge-oss/playback/traffic";
import type { EditorController, EditorDocument, EditorState } from "@simforge-oss/editor";
import {
  ACTOR_LIBRARY_CATALOG,
  catalogEntryMatchesTool,
  filterActorCatalog,
  groupActorCatalog,
  isStaticCarCatalogId,
  mergeCarlaCatalogSections,
  pickRandomCar,
  pushActorCatalogRecent,
  type CatalogFilter,
  type CatalogTool,
  type ViewportTool,
} from "./actor-catalog";
import {
  PanelSection,
  PanelTileGrid,
  type SceneSearchResult,
} from "./panel-tiles";
import { GalleryAssetPanel } from "./GalleryAssetPanel";
import { AddTrafficPanel, trafficSearchResults } from "./AddTrafficPanel";
import { CatalogTile } from "./CatalogTile";
import { PanelSearchResults } from "./PanelSearchResults";
import { AddWeatherPanel, weatherSearchResults } from "./AddWeatherPanel";
import { ParkedCarsPanel } from "@/app/lib/scenario/parking/ParkedCarsPanel";
import type { ParkedCarPlan } from "@/app/lib/scenario/parking/fill";
import type { ParkedCarsSettings } from "@/app/lib/scenario/parking/extension";
import type { ParkingStallsStatus } from "@/app/lib/scenario/parking/useParkedCars";
import { usePanelEdgeResize } from "../usePanelEdgeResize";

/** Everything the parked-cars tool needs, supplied by the editor surface. */
export interface ParkedCarsRailState {
  readonly settings: ParkedCarsSettings;
  readonly onChange: (settings: ParkedCarsSettings) => void;
  readonly plan: ParkedCarPlan;
  readonly stallCount: number;
  readonly status: ParkingStallsStatus;
  readonly reason: string | null;
  readonly bakedCount: number;
}

const GLASS_BACKGROUND = "linear-gradient(145deg, rgba(19, 24, 32, 0.34), rgba(8, 11, 16, 0.22))";
const GLASS_PANEL_BACKGROUND = "linear-gradient(150deg, rgba(19, 24, 32, 0.46), rgba(8, 11, 16, 0.34))";
const GLASS_BORDER = "1px solid rgba(222, 234, 255, 0.14)";
const GLASS_BLUR = "blur(72px) saturate(185%) contrast(105%)";
const FAVORITES_KEY = "uniscenarios.studio.catalog-favorites.v1";
const RECENTS_KEY = "uniscenarios.studio.catalog-recents.v1";
const CATALOG_DRAG_TYPE = "application/x-simforge-catalog-id";
const ALL_CATEGORIES = "all";
/** Gap above and below the rail/panel rectangle. */
const RAIL_MARGIN = 9;
/** Breathing room between the panel's bottom edge and the timeline dock. */
const TIMELINE_CLEARANCE = 12;
/** The width the catalog had before it could be resized, and so the widest it may be. */
const CATALOG_MAX_WIDTH = 540;
/** A quarter slimmer, which is where it opens until the author drags it. */
const CATALOG_DEFAULT_WIDTH = Math.round(CATALOG_MAX_WIDTH * 0.75);
/** Cap on the entrance stagger so a long category never crawls in. */
const MAX_STAGGER_MS = 260;

/** Rail groups, drawn with a gap between them. */
type ToolGroup = "search" | "actors" | "props" | "scene";

interface ToolDefinition {
  id: ViewportTool;
  label: string;
  icon: typeof Box;
  group: ToolGroup;
  /**
   * `search` spans every panel, `catalog` browses bundled models, `gallery` the
   * author's uploads, `scene` the world itself. Every kind is the same panel: a
   * class of thing you add.
   */
  kind: "search" | "catalog" | "gallery" | "scene";
}

const TOOLS: readonly ToolDefinition[] = [
  { id: "search", label: "Search everything", icon: Search, group: "search", kind: "search" },
  { id: "vehicles", label: "Car", icon: CarFront, group: "actors", kind: "catalog" },
  { id: "two-wheelers", label: "Two-wheelers", icon: Bike, group: "actors", kind: "catalog" },
  { id: "pedestrians", label: "Pedestrian", icon: PersonStanding, group: "actors", kind: "catalog" },
  { id: "sidewalk-robots", label: "Sidewalk robots", icon: Bot, group: "actors", kind: "catalog" },
  { id: "humanoid-robots", label: "Humanoid robots", icon: PersonStanding, group: "actors", kind: "catalog" },
  { id: "drones", label: "Drones", icon: Plane, group: "actors", kind: "catalog" },
  { id: "animals", label: "Animals", icon: Bird, group: "actors", kind: "catalog" },
  { id: "objects", label: "Object", icon: Box, group: "props", kind: "catalog" },
  { id: "gallery", label: "Asset gallery", icon: Images, group: "props", kind: "gallery" },
  { id: "weather", label: "Weather", icon: CloudSun, group: "scene", kind: "scene" },
  { id: "traffic", label: "Traffic", icon: Route, group: "scene", kind: "scene" },
  { id: "parked", label: "Parked cars", icon: SquareParking, group: "scene", kind: "scene" },
] as const;

const TOOL_GROUP_ORDER: readonly ToolGroup[] = ["search", "actors", "props", "scene"];

const FILTERS: readonly { id: CatalogFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "favorite", label: "Favorites" },
  { id: "recent", label: "Recent" },
] as const;

/**
 * Floating authoring rail. The icon column is the resting state; choosing a
 * class expands it in place into the add panel, so the surface an author
 * reaches for and the surface they browse are one continuous object on the left
 * edge. Placement itself remains owned by the viewport controller.
 *
 * The column carries three groups, spaced apart: actors, props, and the scene
 * itself (weather, traffic). Weather and traffic used to be top-bar popovers;
 * they are the same act — adding something to the scenario — so they are the
 * same panel, with the same tile galleries.
 */
export function ActorLibraryRail({
  controller,
  state,
  hostRef,
  canvas,
  activeTool: controlledActiveTool,
  onExpandedToolChange,
  document: editorDocument = null,
  trafficDetails = null,
  sumoAvailable = true,
  sumoStatus = null,
  parkedCars = null,
}: {
  controller: EditorController | null;
  state: EditorState | null;
  hostRef: RefObject<HTMLDivElement | null>;
  /** Persistent-world mode can hand the shared Three.js canvas in directly. */
  canvas?: HTMLCanvasElement | null;
  /** Controls the expanded add panel when supplied. */
  activeTool?: ViewportTool | null;
  /** Publishes add panel selection to the editor shell. */
  onExpandedToolChange?: (tool: ViewportTool | null) => void;
  /** Scene tools edit the document directly rather than arming a placement. */
  document?: EditorDocument | null;
  /** Numeric ambient-traffic editor, owned by the surface that has its status. */
  trafficDetails?: ReactNode;
  sumoAvailable?: boolean;
  sumoStatus?: SumoTrafficStatus | null;
  /**
   * Parked-car generator state. Owned by the surface, which holds the viewer
   * that draws the cars, so the panel and the scene cannot disagree.
   */
  parkedCars?: ParkedCarsRailState | null;
}) {
  const [internalActiveTool, setInternalActiveTool] = useState<ViewportTool | null>(null);
  const activeTool = controlledActiveTool === undefined
    ? internalActiveTool
    : controlledActiveTool;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CatalogFilter>("all");
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [recents, setRecents] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [carlaTable, setCarlaTable] = useState<CarlaCompatibilityTable | null>(null);
  const [carlaObjects, setCarlaObjects] = useState<readonly CarlaObjectDto[]>([]);
  const [carlaCompatibleOnly, setCarlaCompatibleOnly] = useState(false);
  // The tooltip is positioned against the hovered button's own box so it can be
  // `fixed` and escape the rail's clipped, rounded frame.
  const [hoveredTool, setHoveredTool] = useState<{ id: ViewportTool; top: number } | null>(null);
  const [timelineInset, setTimelineInset] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const staticCarPlacementRef = useRef<CatalogId | null>(null);
  const {
    width: catalogWidth,
    panelRef: catalogPanelRef,
    separatorProps: catalogSeparatorProps,
  } = usePanelEdgeResize({
    storageKey: "uniscenario.editor.catalog-width",
    // 540 was this panel's only width, so it stays the ceiling. It opens a quarter slimmer, which
    // still fits the catalog grid while leaving more of the map visible while placing.
    defaultWidth: CATALOG_DEFAULT_WIDTH,
    minWidth: 320,
    maxWidth: CATALOG_MAX_WIDTH,
    edge: "right",
    // The rail itself sits to the left of the panel, so keep its width plus a margin clear.
    viewportReserve: 96,
    label: "Resize the actor catalog",
  });

  useEffect(() => {
    setFavorites(readStoredIds(FAVORITES_KEY));
    setRecents([...readStoredIds(RECENTS_KEY)]);
  }, []);

  useEffect(() => {
    let active = true;
    void loadCarlaCompatibility()
      .then((table) => {
        if (active) setCarlaTable(table);
      })
      .catch(() => {
        // Compatibility is advisory; a failed lookup must not interrupt authoring.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void registerCarlaObjects()
      .then((objects) => {
        if (active) setCarlaObjects(objects);
      })
      .catch(() => {
        // The bundled catalog remains fully usable if the optional CARLA catalog fails.
      });
    return () => {
      active = false;
    };
  }, []);

  // The floating timeline owns the bottom of the viewport and is the surface an
  // author reads while placing. The panel is tall, centred-map-width wide and on
  // the same layer, so without this it lands on top of the dock's left third.
  // Measure the dock instead of reserving a constant: its height is content
  // driven and the author can drag it taller.
  useEffect(() => {
    if (!activeTool) return;
    const measure = () => {
      const dock = window.document.querySelector<HTMLElement>(
        '[data-testid="floating-timeline-layer"]',
      );
      const height = dock?.getBoundingClientRect().height ?? 0;
      setTimelineInset(height > 0 ? Math.round(height) + TIMELINE_CLEARANCE : 0);
    };
    measure();
    const dock = window.document.querySelector<HTMLElement>(
      '[data-testid="floating-timeline-layer"]',
    );
    // Not every environment provides ResizeObserver; the open-time measurement
    // and the resize listener remain correct without it.
    const observer = dock && typeof ResizeObserver === "function"
      ? new ResizeObserver(measure)
      : null;
    if (dock && observer) observer.observe(dock);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeTool]);

  const setActiveTool = (tool: ViewportTool | null) => {
    if (controlledActiveTool === undefined) setInternalActiveTool(tool);
    onExpandedToolChange?.(tool);
  };

  useEffect(() => () => onExpandedToolChange?.(null), [onExpandedToolChange]);

  useEffect(() => {
    if (!activeTool) return;
    setSelectedIndex(0);
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [activeTool]);

  // Esc closes the panel from anywhere, not only from the search field: the
  // author's hand is usually on the map when they change their mind.
  useEffect(() => {
    if (!activeTool) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      controller?.cancel();
      setActiveTool(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // `setActiveTool` closes over the controlled/uncontrolled decision only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, controller, controlledActiveTool, onExpandedToolChange]);

  useEffect(() => {
    const dropCanvas = canvas ?? hostRef.current?.querySelector("canvas");
    if (!controller || !dropCanvas) return;
    const onDragOver = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer?.types.includes(CATALOG_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: globalThis.DragEvent) => {
      const catalogId = event.dataTransfer?.getData(CATALOG_DRAG_TYPE) ?? "";
      if (!isCatalogId(catalogId)) return;
      event.preventDefault();
      const placed = controller.placeCatalogAtClientPoint(catalogId, event.clientX, event.clientY, {
        altKey: Boolean(event.altKey),
        shiftKey: Boolean(event.shiftKey),
        freeformStatic: staticCarPlacementRef.current === catalogId,
      });
      if (!placed) return;
    };
    dropCanvas.addEventListener("dragover", onDragOver);
    dropCanvas.addEventListener("drop", onDrop);
    return () => {
      dropCanvas.removeEventListener("dragover", onDragOver);
      dropCanvas.removeEventListener("drop", onDrop);
    };
  }, [canvas, controller, hostRef]);

  const catalog = useMemo<readonly CatalogEntry[]>(() => [
    ...ACTOR_LIBRARY_CATALOG,
    ...carlaObjects.map((object) => getEntry(object.catalogId as CatalogId)),
  ], [carlaObjects]);
  const catalogSections = useMemo(
    () => mergeCarlaCatalogSections(carlaObjects),
    [carlaObjects],
  );
  const entries = useMemo(() => {
    const filtered = filterActorCatalog(catalog, filter, query, favorites, recents);
    return filtered.filter((entry) => catalogEntryMatchesTool(entry, activeTool));
  }, [activeTool, catalog, favorites, filter, query, recents]);
  const activeDefinition = TOOLS.find((tool) => tool.id === activeTool) ?? null;
  const activeKind = activeDefinition?.kind ?? null;
  const groups = useMemo(
    () => activeTool && activeKind === "catalog"
      ? groupActorCatalog(entries, activeTool as CatalogTool, catalogSections[activeTool as CatalogTool])
      : [],
    [activeKind, activeTool, catalogSections, entries],
  );
  const compatibilityByCatalogId = useMemo<Record<string, CarlaCompatibility> | null>(() => {
    if (!carlaTable) return null;
    return Object.fromEntries(
      catalog.map((entry) => [entry.id, carlaCompatibilityFor(entry.id, carlaTable)]),
    );
  }, [carlaTable, catalog]);
  const compatibilityGroups = useMemo(
    () => carlaCompatibleOnly && compatibilityByCatalogId
      ? groups.map((group) => ({
        ...group,
        entries: group.entries.filter(
          (entry) => compatibilityByCatalogId[entry.id]?.status === "native",
        ),
      })).filter((group) => group.entries.length > 0)
      : groups,
    [carlaCompatibleOnly, compatibilityByCatalogId, groups],
  );
  const visibleGroups = useMemo(
    () => category === ALL_CATEGORIES
      ? compatibilityGroups
      : compatibilityGroups.filter((group) => group.id === category),
    [category, compatibilityGroups],
  );
  // One flat order for keyboard travel and for the highlighted tile, so what
  // Enter places is always the tile the author can see is selected.
  const visibleEntries = useMemo(
    () => visibleGroups.flatMap((group) => group.entries),
    [visibleGroups],
  );

  // Universal search spans every panel: models from every class, plus the
  // weather and traffic choices, each panel supplying its own hits.
  const searchModelGroups = useMemo(() => {
    if (activeKind !== "search" || !query.trim()) return [];
    const matched = filterActorCatalog(catalog, "all", query, favorites, recents);
    return TOOLS.filter((tool) => tool.kind === "catalog").flatMap((tool) => {
      const forTool = matched.filter((entry) => catalogEntryMatchesTool(entry, tool.id));
      if (!forTool.length) return [];
      return [{ id: tool.id, label: catalogToolTitle(tool.id), entries: forTool }];
    });
  }, [activeKind, catalog, favorites, query, recents]);
  const searchSceneResults = useMemo<readonly SceneSearchResult[]>(
    () => activeKind !== "search" || !query.trim()
      ? []
      : [
        ...weatherSearchResults(query, editorDocument),
        ...trafficSearchResults(query, editorDocument),
      ],
    [activeKind, editorDocument, query],
  );
  const searchHitCount = searchModelGroups.reduce((total, group) => total + group.entries.length, 0)
    + searchSceneResults.length;
  const categories = activeTool && activeKind === "catalog"
    ? catalogSections[activeTool as CatalogTool]
    : [];
  const ActiveToolIcon = activeDefinition?.icon ?? Box;
  // Scene and search tools work on the document, so they open while the map is
  // still streaming; catalog tools arm a placement and cannot.
  const open = activeDefinition !== null
    && (activeKind === "scene" || activeKind === "search" || controller !== null);

  const remember = (id: CatalogId) => {
    setRecents((current) => {
      const next = pushActorCatalogRecent(current, id);
      writeStoredIds(RECENTS_KEY, next);
      return next;
    });
  };

  const arm = (id: CatalogId, staticCar = false) => {
    if (!controller) return;
    const wasStaticCar = staticCarPlacementRef.current === id;
    staticCarPlacementRef.current = staticCar ? id : null;
    if (state?.placing !== id || wasStaticCar !== staticCar) {
      if (staticCar) controller.togglePlacement(id, { freeformStatic: true });
      else controller.togglePlacement(id);
    }
    remember(id);
  };

  // Keep the source mounted throughout native dragstart; Chromium may cancel a
  // drag if React removes it before the browser begins the drop transaction.
  const beginDrag = (event: DragEvent, id: CatalogId, staticCar = false) => {
    staticCarPlacementRef.current = staticCar ? id : null;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(CATALOG_DRAG_TYPE, id);
    event.dataTransfer.setData("text/plain", id);
    remember(id);
  };

  const endDrag = () => undefined;

  const run = (tool: ToolDefinition) => {
    // Search, weather and traffic work on the document, so they stay usable
    // while the map is still streaming and the placement controller is absent.
    if (!controller && tool.kind !== "scene" && tool.kind !== "search") return;
    staticCarPlacementRef.current = null;
    controller?.cancel();
    if (activeTool === tool.id) {
      setActiveTool(null);
      return;
    }
    setActiveTool(tool.id);
    setCategory(ALL_CATEGORIES);
    setFilter("all");
    setQuery("");
  };

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((current) => {
        if (!visibleEntries.length) return 0;
        return (current + direction + visibleEntries.length) % visibleEntries.length;
      });
      return;
    }
    if (event.key === "Enter" && visibleEntries.length) {
      event.preventDefault();
      const id = visibleEntries[Math.min(selectedIndex, visibleEntries.length - 1)]!.id as CatalogId;
      arm(id, activeTool === "objects" && isStaticCarCatalogId(id));
    }
  };

  const toggleFavorite = (id: string) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeStoredIds(FAVORITES_KEY, [...next]);
      return next;
    });
  };

  return (
    <div
      className="pointer-events-auto flex h-full min-h-0 items-center"
      data-testid="editor-tool-sidebar"
      data-tutorial="actor-library"
    >
      {/*
        Rail and panel share one row so opening a tool expands sideways and
        nothing moves vertically.

        The rail used to take the panel's full height, which meant the icon
        column jumped from its resting position in the middle of the viewport up
        to the top the moment a panel opened — the panel appeared and the thing
        you had just clicked went somewhere else. Pairing them inside a
        height-capped row that the outer flex centres keeps the icon under the
        cursor: the row grows around its own middle, and only to the cap, so the
        pair never reaches the top edge.

        `stretch` is what keeps the seam honest. The panel decides the height and
        the rail matches it exactly, so the two still read as one rectangle
        rather than a short pill beside a tall card.
      */}
      <div
        data-testid="editor-tool-row"
        style={{
          display: "flex",
          alignItems: "stretch",
          minHeight: 0,
          maxHeight: `calc(100% - ${RAIL_MARGIN * 2 + timelineInset}px)`,
        }}
      >
      <nav
        style={{
          ...styles.rail,
          ...(open ? styles.railExpanded : null),
        }}
        aria-label="Authoring tools"
        data-testid="editor-tool-rail"
        data-visual-surface="glass"
      >
        {TOOL_GROUP_ORDER.map((group, groupIndex) => (
          <div
            key={group}
            data-tool-group={group}
            style={{
              ...styles.toolGroup,
              ...(groupIndex === TOOL_GROUP_ORDER.length - 1 ? styles.toolGroupLast : null),
            }}
          >
            {TOOLS.filter((tool) => tool.group === group).map((tool) => {
              const Icon = tool.icon;
              const disabled = !controller && tool.kind !== "scene" && tool.kind !== "search";
              const active = activeTool === tool.id;
              return (
                <button
                  key={tool.id}
                  className="actor-tool-button"
                  type="button"
                  aria-label={tool.label}
                  aria-pressed={active}
                  disabled={disabled}
                  data-testid={`tool-${tool.id}`}
                  style={{
                    ...styles.toolButton,
                    ...(hoveredTool?.id === tool.id && !active ? styles.toolButtonHover : null),
                    ...(active ? styles.toolButtonActive : null),
                    ...(disabled ? styles.disabled : null),
                  }}
                  onFocus={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setHoveredTool({ id: tool.id, top: box.top + box.height / 2 });
                  }}
                  onBlur={() => setHoveredTool(null)}
                  onMouseEnter={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    setHoveredTool({ id: tool.id, top: box.top + box.height / 2 });
                  }}
                  onMouseLeave={() => setHoveredTool(null)}
                  onClick={() => run(tool)}
                >
                  <Icon aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Named, not guessed: the rail is eleven unlabelled glyphs, and the label
          has to clear the rail's own clipped frame, hence `fixed`. */}
      {hoveredTool ? (
        <span
          className="actor-rail-tooltip"
          data-testid="tool-tooltip"
          role="tooltip"
          style={{ ...styles.railTooltip, top: hoveredTool.top }}
        >
          {TOOLS.find((tool) => tool.id === hoveredTool.id)?.label}
        </span>
      ) : null}

      {open && activeTool ? (
        <section
          ref={catalogPanelRef as React.RefObject<HTMLElement>}
          aria-label={addActorTitle(activeTool)}
          className="actor-add-panel-enter"
          data-placement="left-expanded"
          data-testid="catalog-drawer"
          data-visual-surface="glass"
          key={activeTool}
          role="dialog"
          style={{
            ...styles.panel,
            width: catalogWidth,
            // No explicit height: the panel is as tall as its own content and
            // the row above caps it. A short panel is short, and the rail
            // matches whatever it settles on.
            maxHeight: "100%",
          }}
        >
          {/* The rail is welded to the panel's left edge, so the right edge is the free one. */}
          <div
            {...catalogSeparatorProps}
            className="actor-add-panel-resize"
            data-testid="catalog-resize-handle"
            style={styles.panelResizeHandle}
          />
          <header style={styles.panelHeader}>
            <span style={styles.panelHeaderIcon}>
              <ActiveToolIcon aria-hidden="true" size={20} strokeWidth={1.7} />
            </span>
            <span style={styles.panelHeading}>
              <h2 style={styles.panelTitle}>{addActorTitle(activeTool)}</h2>
              <span style={styles.panelSubtitle}>{addActorSubtitle(activeTool)}</span>
            </span>
            <button
              aria-label="Close catalog"
              className="actor-panel-close"
              data-testid="catalog-close"
              onClick={() => { controller?.cancel(); setActiveTool(null); }}
              style={styles.panelClose}
              type="button"
            >
              <X aria-hidden="true" size={14} />
            </button>
          </header>

          {activeKind === "scene" ? null : (
          <div style={styles.controls}>
            <div style={styles.searchRow}>
              <div style={styles.searchWrap}>
                <span style={styles.searchGlyph}>⌕</span>
                <input
                  autoFocus
                  ref={searchRef}
                  type="search"
                  aria-label={activeKind === "search" ? "Search everything" : "Search catalog"}
                  placeholder={activeKind === "search"
                    ? "Search cars, props, weather, traffic…"
                    : `Search ${catalogToolTitle(activeTool).toLowerCase()}…`}
                  value={query}
                  style={styles.search}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelectedIndex(0);
                  }}
                  onKeyDown={onSearchKeyDown}
                />
              </div>
              {activeTool === "vehicles" ? (
                <button
                  className="actor-chip"
                  type="button"
                  aria-label="Add random car"
                  style={styles.randomAction}
                  onClick={() => {
                    const car = pickRandomCar(visibleEntries);
                    if (car) arm(car.id as CatalogId);
                  }}
                >
                  <Shuffle size={13} aria-hidden="true" />
                  <span>Random</span>
                </button>
              ) : null}
            </div>

            {activeKind === "search" ? null : (
            <div style={styles.filterRow}>
              <div style={styles.filters} aria-label="Catalog filters">
                {FILTERS.map((item) => (
                  <button
                    className="actor-chip"
                    key={item.id}
                    type="button"
                    aria-pressed={filter === item.id}
                    style={{ ...styles.filter, ...(filter === item.id ? styles.filterActive : null) }}
                    onClick={() => setFilter(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {activeTool !== "gallery" ? (
                <label htmlFor="catalog-carla-compatible" style={styles.carlaToggle}>
                  <input
                    checked={carlaCompatibleOnly}
                    data-testid="catalog-carla-compatible"
                    id="catalog-carla-compatible"
                    onChange={(event) => {
                      setCarlaCompatibleOnly(event.currentTarget.checked);
                      setSelectedIndex(0);
                    }}
                    style={styles.carlaToggleInput}
                    type="checkbox"
                  />
                  <CarlaReadyMark size={13} />
                  <span>CARLA compatible</span>
                </label>
              ) : null}
            </div>
            )}

            {categories.length > 1 ? (
              <div aria-label="Categories" role="group" style={styles.categories}>
                <button
                  aria-pressed={category === ALL_CATEGORIES}
                  className="actor-chip actor-catalog-chip-enter"
                  onClick={() => { setCategory(ALL_CATEGORIES); setSelectedIndex(0); }}
                  style={{
                    ...styles.category,
                    ...(category === ALL_CATEGORIES ? styles.categoryActive : null),
                  }}
                  type="button"
                >
                  All categories
                </button>
                {categories.map((section, index) => {
                  const selected = category === section.id;
                  return (
                    <button
                      aria-pressed={selected}
                      className="actor-chip actor-catalog-chip-enter"
                      key={section.id}
                      onClick={() => { setCategory(section.id); setSelectedIndex(0); }}
                      style={{
                        ...styles.category,
                        ...(selected ? styles.categoryActive : null),
                        animationDelay: `${Math.min((index + 1) * 26, MAX_STAGGER_MS)}ms`,
                      }}
                      type="button"
                    >
                      {section.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
          )}

          <div style={styles.panelBody}>
            {activeKind === "search" ? (
              <PanelSearchResults
                hitCount={searchHitCount}
                modelGroups={searchModelGroups}
                onChooseModel={(id) => arm(id, isStaticCarCatalogId(id))}
                onDragModel={(event, id) => beginDrag(event, id, isStaticCarCatalogId(id))}
                onDragEnd={endDrag}
                compatibilityByCatalogId={compatibilityByCatalogId}
                favorites={favorites}
                onFavorite={toggleFavorite}
                placing={state?.placing ?? null}
                query={query}
                sceneResults={searchSceneResults}
              />
            ) : activeTool === "weather" ? (
              <AddWeatherPanel document={editorDocument} />
            ) : activeTool === "traffic" ? (
              <AddTrafficPanel
                details={trafficDetails}
                document={editorDocument}
                sumoAvailable={sumoAvailable}
                sumoStatus={sumoStatus}
              />
            ) : activeTool === "parked" && parkedCars ? (
              <ParkedCarsPanel
                bakedCount={parkedCars.bakedCount}
                onChange={parkedCars.onChange}
                plan={parkedCars.plan}
                reason={parkedCars.reason}
                settings={parkedCars.settings}
                stallCount={parkedCars.stallCount}
                status={parkedCars.status}
              />
            ) : activeTool === "gallery" && controller ? (
              <GalleryAssetPanel
                controller={controller}
                favorites={favorites}
                state={state}
                onFavorite={toggleFavorite}
                onRemember={remember}
              />
            ) : visibleGroups.length ? (
              visibleGroups.map((group, groupIndex) => (
                <PanelSection
                  count={group.entries.length}
                  key={group.id}
                  label={group.label}
                  testId={`catalog-section-${group.id}`}
                >
                  <PanelTileGrid>
                    {group.entries.map((entry, entryIndex) => (
                      <CatalogTile
                        key={entry.id}
                        entry={entry}
                        compatibility={compatibilityByCatalogId?.[entry.id] ?? null}
                        favorite={favorites.has(entry.id)}
                        active={state?.placing === entry.id || visibleEntries[selectedIndex]?.id === entry.id}
                        stagger={Math.min((groupIndex * 3 + entryIndex) * 18, MAX_STAGGER_MS)}
                        onChoose={() => arm(entry.id as CatalogId, activeTool === "objects" && isStaticCarCatalogId(entry.id as CatalogId))}
                        onFavorite={() => toggleFavorite(entry.id)}
                        onDragStart={(event) => beginDrag(event, entry.id as CatalogId, activeTool === "objects" && isStaticCarCatalogId(entry.id as CatalogId))}
                        onDragEnd={endDrag}
                      />
                    ))}
                  </PanelTileGrid>
                </PanelSection>
              ))
            ) : (
              <div style={styles.empty}>
                <span style={styles.emptyGlyph}>⌕</span>
                <strong>No models match</strong>
                <span>
                  {carlaCompatibleOnly
                    ? `CARLA ${carlaTable?.carlaVersion ?? "0.10.0"} has no blueprint for this category.`
                    : "Try another search or category."}
                </span>
              </div>
            )}
          </div>

          <footer style={styles.panelFooter}>
            <span>
              {activeKind === "search"
                ? `${searchHitCount} ${searchHitCount === 1 ? "match" : "matches"} across every panel`
                : activeKind === "scene" ? "Changes apply immediately" : "Closes after placement"}
            </span>
            <span>{activeKind === "scene" ? "Esc close" : "↑↓ · Enter · Esc cancel"}</span>
          </footer>
        </section>
      ) : null}
      </div>
    </div>
  );
}


/** Panel heading: the sentence the author is completing by clicking a tile. */
function addActorTitle(tool: ViewportTool): string {
  if (tool === "vehicles") return "Add a car";
  if (tool === "two-wheelers") return "Add a two-wheeler";
  if (tool === "pedestrians") return "Add a pedestrian";
  if (tool === "sidewalk-robots") return "Add a sidewalk robot";
  if (tool === "humanoid-robots") return "Add a humanoid robot";
  if (tool === "drones") return "Add a drone";
  if (tool === "animals") return "Add an animal";
  if (tool === "gallery") return "Add from your gallery";
  if (tool === "search") return "Search everything";
  if (tool === "weather") return "Add weather";
  if (tool === "traffic") return "Add traffic";
  return "Add an object";
}

function addActorSubtitle(tool: ViewportTool): string {
  if (tool === "search") return "One field over every panel: models, weather, traffic.";
  if (tool === "gallery") return "Your uploaded models. Click one, then click the map.";
  if (tool === "weather") return "Pick the sky and the hour. The scene changes as you click.";
  if (tool === "traffic") return "Pick who drives the background cars, and how many.";
  return "Click a model, then click the map. Dragging onto the map works too.";
}

function catalogToolTitle(tool: ViewportTool): string {
  if (tool === "search") return "Everything";
  if (tool === "vehicles") return "Cars";
  if (tool === "two-wheelers") return "Two-wheelers";
  if (tool === "pedestrians") return "Pedestrians";
  if (tool === "sidewalk-robots") return "Sidewalk robots";
  if (tool === "humanoid-robots") return "Humanoid robots";
  if (tool === "drones") return "Drones";
  if (tool === "animals") return "Animals";
  if (tool === "gallery") return "Asset gallery";
  return "Objects";
}


function readStoredIds(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch { return new Set(); }
}

function writeStoredIds(key: string, values: readonly string[]): void {
  try { window.localStorage.setItem(key, JSON.stringify(values)); } catch { /* Storage can be unavailable in hardened browsers. */ }
}

const styles: Record<string, CSSProperties> = {
  rail: { zIndex: 22, flex: "0 0 48px", width: 48, marginLeft: 0, display: "flex", flexDirection: "column", gap: 14, padding: "6px 6px 6px 5px", boxSizing: "border-box", overflow: "hidden", borderRadius: "0 22px 22px 0", background: GLASS_BACKGROUND, border: GLASS_BORDER, borderLeft: 0, boxShadow: "0 18px 48px rgba(0,0,0,.3), inset 0 1px rgba(255,255,255,.14)", backdropFilter: GLASS_BLUR, WebkitBackdropFilter: GLASS_BLUR, userSelect: "none", pointerEvents: "auto" },
  // Groups, not a run of eleven glyphs: actors, then props, then the scene
  // itself. The gap plus a hairline is the whole separation — a labelled header
  // would not fit 48px and a tooltip already names each tool.
  toolGroup: { display: "flex", flexDirection: "column", gap: 4, paddingBottom: 14, borderBottom: "1px solid rgba(222,234,255,.09)" },
  toolGroupLast: { paddingBottom: 0, borderBottom: 0 },
  // Open state: the icon column takes the panel's full height, loses its right
  // shoulder and its shadow, so the two read as one rectangle instead of a card
  // floating in front of a card.
  railExpanded: { justifyContent: "flex-start", borderRadius: 0, borderRight: "1px solid rgba(222,234,255,.1)", boxShadow: "inset 0 1px rgba(255,255,255,.14)" },
  toolButton: { position: "relative", width: 36, height: 36, display: "grid", placeItems: "center", padding: 0, border: "1px solid transparent", borderRadius: 9, background: "transparent", color: "rgba(225,231,240,.7)", font: "inherit", cursor: "pointer", transition: "background 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease" },
  toolButtonHover: { background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.1)", color: "#fff" },
  toolButtonActive: { background: "rgba(232, 224, 68, 0.16)", border: "1px solid rgba(232, 224, 68, 0.42)", color: "#f7fbff", boxShadow: "inset 0 1px rgba(255,255,255,.12)" },
  railTooltip: { position: "fixed", left: 56, zIndex: 40, transform: "translateY(-50%)", padding: "5px 9px", borderRadius: 8, background: "rgba(12,16,22,.92)", border: "1px solid rgba(222,234,255,.16)", boxShadow: "0 10px 24px rgba(0,0,0,.45)", color: "#eef2f8", fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", pointerEvents: "none", backdropFilter: "blur(12px)" },
  disabled: { opacity: .28, cursor: "default" },

  // Width is owned by `usePanelEdgeResize`, applied on the element: the author drags this panel's
  // right edge, and 540 — its only width before that — is now the ceiling.
  panel: { zIndex: 21, flex: "0 0 auto", position: "relative", display: "flex", flexDirection: "column", minHeight: 0, boxSizing: "border-box", overflow: "hidden", borderRadius: "0 26px 26px 0", background: GLASS_PANEL_BACKGROUND, border: GLASS_BORDER, borderLeft: 0, boxShadow: "26px 24px 70px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.12)", backdropFilter: GLASS_BLUR, WebkitBackdropFilter: GLASS_BLUR, color: "#e6ebf2", pointerEvents: "auto" },
  panelResizeHandle: { position: "absolute", top: 0, right: 0, bottom: 0, zIndex: 30, width: 8, cursor: "col-resize", touchAction: "none", background: "transparent", border: 0, padding: 0, borderRadius: "0 26px 26px 0" },
  panelHeader: { position: "relative", flex: "0 0 auto", display: "flex", alignItems: "flex-start", gap: 11, padding: "16px 44px 12px 18px" },
  panelHeaderIcon: { flex: "0 0 auto", width: 34, height: 34, display: "grid", placeItems: "center", borderRadius: 11, border: "1px solid rgba(232,224,68,.34)", background: "rgba(232,224,68,.12)", color: "#E8E044" },
  panelHeading: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
  panelTitle: { margin: 0, fontSize: 17, fontWeight: 600, letterSpacing: -0.2, color: "#f4f7fb" },
  panelSubtitle: { color: "#8d97a5", fontSize: 10, lineHeight: 1.35 },
  panelClose: { position: "absolute", top: 13, right: 14, width: 26, height: 26, display: "grid", placeItems: "center", padding: 0, border: "1px solid transparent", borderRadius: 8, background: "transparent", color: "rgba(225,231,240,.5)", cursor: "pointer" },

  controls: { flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 8, padding: "0 18px 11px", borderBottom: "1px solid rgba(255,255,255,.08)" },
  searchRow: { display: "flex", alignItems: "center", gap: 7 },
  searchWrap: { position: "relative", flex: "1 1 auto", minWidth: 0 },
  searchGlyph: { position: "absolute", left: 11, top: 6, color: "#737b88", fontSize: 16, pointerEvents: "none" },
  search: { width: "100%", height: 32, boxSizing: "border-box", padding: "5px 10px 5px 32px", border: "1px solid rgba(255,255,255,.14)", borderRadius: 9, background: "rgba(5, 7, 10, 0.42)", color: "#e2e5ea", boxShadow: "inset 0 1px 0 rgba(255,255,255,.04)", font: "inherit", fontSize: 11, outline: "none" },
  randomAction: { flex: "0 0 auto", height: 32, display: "flex", alignItems: "center", gap: 6, padding: "0 11px", border: "1px solid rgba(240,127,47,.36)", borderRadius: 9, background: "rgba(240,127,47,.13)", color: "#ffd0ae", font: "inherit", fontSize: 10, fontWeight: 680, cursor: "pointer" },
  filterRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  filters: { display: "flex", gap: 4 },
  filter: { flex: "0 0 auto", padding: "4px 9px", border: "1px solid rgba(255,255,255,.11)", borderRadius: 999, background: "rgba(255,255,255,.045)", color: "#9ca5b2", font: "inherit", fontSize: 9, cursor: "pointer" },
  filterActive: { border: "1px solid rgba(232,224,68,.48)", background: "rgba(232,224,68,.14)", color: "#f3ed73" },
  carlaToggle: { display: "inline-flex", flex: "0 0 auto", alignItems: "center", gap: 6, color: "#c8ced6", fontSize: 10, cursor: "pointer" },
  carlaToggleInput: { width: 13, height: 13, margin: 0, accentColor: "#61d095", cursor: "pointer" },
  categories: { display: "flex", flexWrap: "wrap", gap: 5 },
  category: { minHeight: 24, padding: "4px 9px", border: "1px solid rgba(255,255,255,.12)", borderRadius: 999, background: "rgba(255,255,255,.045)", color: "#9aa3b0", font: "inherit", fontSize: 9, lineHeight: 1.2, cursor: "pointer" },
  categoryActive: { border: "1px solid rgba(232,224,68,.48)", background: "rgba(232,224,68,.14)", color: "#f3ed73" },

  panelBody: { flex: "1 1 auto", minHeight: 0, overflowY: "auto", overflowX: "hidden", padding: "12px 18px 14px", scrollbarWidth: "thin" },
  // Border, radius, background and every hover/active state of a tile live in
  // `.actor-catalog-tile`: hover cannot be expressed inline.
  empty: { height: 210, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 5, color: "#727b88", fontSize: 10, textAlign: "center" },
  emptyGlyph: { fontSize: 30, color: "#555d68" },
  panelFooter: { flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 18px 11px", borderTop: "1px solid rgba(255,255,255,.08)", color: "#77808d", fontSize: 8.5 },
};
