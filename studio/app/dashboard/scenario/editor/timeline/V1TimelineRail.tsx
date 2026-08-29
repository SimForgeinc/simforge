"use client";

import {
  AlertTriangle,
  Box,
  BrainCircuit,
  CarFront,
  Clock3,
  Globe2,
  Lock,
  PersonStanding,
  Plus,
  Route as RouteIcon,
  Trash2,
  TrafficCone,
  Zap,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { newTemplateId, type Interaction, type ReasoningTraceSegment } from "@simforge-oss/scenario";

import {
  actionsForActor,
  interactionForAction,
  setExclusiveCustomTimedRoute,
  type ActionDefinition,
  type EditorDocument,
  type EditorState,
} from "@simforge-oss/editor";
import {
  getEntry,
  isCatalogId,
  type CatalogId,
} from "@simforge-oss/asset-catalog";
import {
  carlaCompatibilityFor,
  loadCarlaCompatibility,
  type CarlaCompatibility,
  type CarlaCompatibilityTable,
} from "@/app/lib/scenario/carla-compatibility";
import type { SignalTimelineBand } from "@/app/lib/scenario/signals";
import {
  choreographyWindow,
  rangePercent,
  resolveInteractionLayout,
  snapToTimeGrid,
  type ResolvedInteraction,
  type TimelineRange,
} from "@/app/lib/scenario/timeline";
import { indicationLabel, indicationSwatch } from "../signals/indication-style";
import {
  OBJECT_CATALOG_IDS,
  ObjectCatalogIcon,
  type ObjectCatalogId,
} from "../regions/ObjectCatalogIcon";
import {
  PEDESTRIAN_CATALOG_IDS,
  PedestrianCatalogIcon,
  type PedestrianCatalogId,
} from "../regions/PedestrianCatalogIcon";
import {
  VEHICLE_CATALOG_IDS,
  VehicleCatalogIcon,
  type VehicleCatalogId,
} from "../regions/VehicleCatalogIcon";
import { DynamicActorCatalogIcon, isDynamicActorCatalogId } from '../regions/DynamicActorCatalogIcon';
import { cn } from "@/app/lib/utils";
import { isUnconfiguredSimpleTimedRoute } from "../simple-route-status";
import { isCustomTimedRoute } from "../simple-timed-routes";
import { TimelineCarlaCompatibilityMarker } from "./TimelineCarlaCompatibilityMarker";
import { TimelineRuler } from "./TimelineRuler";
import { TimelineTransportControls } from "./TimelineTransportControls";
import {
  buildTimelineCues,
  timelineCauseLabel,
  timelineConflictMessage,
  type TimelineCue,
} from "./timeline-cues";
import {
  authoredTimelineRange,
  authoredTimelineRangesEqual,
  editAuthoredTimelineRange,
  interactionWithAuthoredTimelineRange,
  packTimelineInteractionRows,
  timelineTimeFromClientX,
  uniqueTimelineInteractionId,
  type AuthoredTimelineRange,
  type TimelineClipEditMode,
} from "./v1-timeline-model";
import {
  TIMELINE_GLASS_SURFACE_CLASSNAME,
  TimelineGlassBackdrop,
} from "./TimelineGlassSurface";
import {
  type TrafficLightAuthoring,
} from "../inspector/TrafficLightDetailsPanel";
import { EditorDetailsPanel } from "../inspector/EditorDetailsPanel";
import { CanonicalInteractionComposer } from "./CanonicalInteractionComposer";

type Role = EditorDocument["data"]["roles"][number];

/** One stable controller-stage lane. Selection may highlight it, never redefine it. */
export type V1TimelineSignalLane = {
  readonly junctionId: string;
  readonly controllerId: string;
  readonly headIds: readonly string[];
  readonly bands: readonly SignalTimelineBand[];
  readonly referenceHeadId: string;
  readonly onRemoveControl?: () => void;
};

export type V1TimelineSignalAuthoring = TrafficLightAuthoring;

/** Canonical browser simulation transport shared with the scenario list. */
export type V1TimelineBrowserPlayback = {
  readonly sessionId: string;
  readonly playing: boolean;
  readonly inspecting: boolean;
  readonly time: number;
  readonly crashes?: readonly V1TimelineCrashMarker[];
  readonly onPlay: () => void;
  readonly onStop: () => void;
  readonly onReset: () => void;
  readonly onPlayPause: () => void;
  readonly onSeek: (time: number) => void;
  readonly onExitInspection: () => void;
};

export type V1TimelineCrashMarker = {
  readonly timeS: number;
  readonly actorLabels: readonly string[];
};

export type V1TimelineRailProps = {
  document: EditorDocument;
  state?: Pick<EditorState, "selection" | "mode"> | null;
  signalLanes?: readonly V1TimelineSignalLane[];
  signalAuthoring?: V1TimelineSignalAuthoring | null;
  playback?: V1TimelineBrowserPlayback | null;
  selectedInteractionId?: string | null;
  onSelectActor?: (actorId: string) => void;
  onFocusActor?: (actorId: string) => void;
  onFocusSignal?: (headId: string) => void;
  onSelectInteraction?: (interactionId: string, actorId: string) => void;
  onClearSelection?: () => void;
  onSelectSignal?: (headId: string) => void;
  disableInteractionCreation?: boolean;
  lockSimpleTimedRoutes?: boolean;
  readOnly?: boolean;
};

type ContextMenuState = {
  actorId: string;
  timeS: number;
  anchorX: number;
  anchorY: number;
};

type ClipPreview = { interactionId: string; range: AuthoredTimelineRange };


const TIMELINE_HEADER_HEIGHT_PX = 48;
const TIMELINE_LANE_HEIGHT_PX = 40;
const TIMELINE_EMPTY_BODY_HEIGHT_PX = 120;
const TIMELINE_MIN_HEIGHT_PX = 168;
const TIMELINE_DEFAULT_MAX_HEIGHT_PX = 300;
const TIMELINE_RESIZE_MAX_HEIGHT_PX = 520;

export function timelineContentHeightPx(visibleLaneRows: number): number {
  return TIMELINE_HEADER_HEIGHT_PX + Math.max(
    TIMELINE_EMPTY_BODY_HEIGHT_PX,
    Math.max(0, visibleLaneRows) * TIMELINE_LANE_HEIGHT_PX,
  );
}

export function timelineDefaultHeightPx(visibleLaneRows: number): number {
  return Math.min(
    TIMELINE_DEFAULT_MAX_HEIGHT_PX,
    Math.max(
      TIMELINE_MIN_HEIGHT_PX,
      timelineContentHeightPx(visibleLaneRows),
    ),
  );
}

export function clampTimelineHeightPx(height: number, viewportHeight: number): number {
  const maxHeight = Math.max(
    TIMELINE_MIN_HEIGHT_PX,
    Math.min(TIMELINE_RESIZE_MAX_HEIGHT_PX, Math.round(viewportHeight * 0.65)),
  );
  return Math.max(TIMELINE_MIN_HEIGHT_PX, Math.min(maxHeight, Math.round(height)));
}

/**
 * The name column and the time track share one row.
 *
 * The column sizes itself to its own contents — the widest lane's icon, label
 * and row actions — so a name is never clipped and the icons never crowd it. A
 * drag on the divider overrides that with an explicit width; double-pressing the
 * divider drops the override and returns to fitting.
 *
 * Fitting is measured in JS rather than expressed as a `max-content` grid track
 * because each lane is its own grid. Per-grid `max-content` would give every
 * lane a different column width and the lanes would no longer line up. One
 * measured value published through `--timeline-identity-width` on the rail is
 * what keeps the header, every lane, the divider and the playhead offset in
 * agreement.
 */
const IDENTITY_DEFAULT_WIDTH_PX = 114;
const IDENTITY_MIN_WIDTH_PX = 72;
const IDENTITY_MAX_WIDTH_PX = 420;
/** Time track floor: a name column may never squeeze the clips out of view. */
const TRACK_MIN_WIDTH_PX = 220;
const IDENTITY_WIDTH_VAR = "--timeline-identity-width";
/** Two presses inside this window are a reset, not a drag. */
const SPLIT_RESET_WINDOW_MS = 350;
const IDENTITY_GRID_COLUMNS = `var(${IDENTITY_WIDTH_VAR}) minmax(0, 1fr)`;
/** Marks the unshrinkable content row inside each identity cell. */
const IDENTITY_CONTENT_ATTR = "data-timeline-identity-content";
/**
 * Breathing room added to the widest measured content row.
 *
 * The content rows carry their own `px-2` gutters, so this is not padding — it
 * is the margin that keeps a label from ending flush against the divider, plus
 * a pixel of slack for sub-pixel text measurement rounding down.
 */
const IDENTITY_CONTENT_SLACK_PX = 9;

export function clampTimelineIdentityWidthPx(width: number, railWidth: number): number {
  const trackAllowance = Math.max(0, Math.round(railWidth) - TRACK_MIN_WIDTH_PX);
  const maxWidth = Math.max(
    IDENTITY_MIN_WIDTH_PX,
    Math.min(IDENTITY_MAX_WIDTH_PX, trackAllowance),
  );
  return Math.max(IDENTITY_MIN_WIDTH_PX, Math.min(maxWidth, Math.round(width)));
}

/** Anything whose laid-out width can be read. */
export type MeasurableRow = { getBoundingClientRect(): { width: number } };

/**
 * The width that shows every identity cell's content in full.
 *
 * Each cell's content row is laid out at `max-content` and therefore overflows
 * its cell while the column is too narrow, which is exactly what makes it
 * measurable: the reported width is what the content wants, not what the column
 * currently allows. Returns `null` when nothing is mounted or nothing has been
 * laid out yet, so a caller keeps its previous width instead of collapsing to
 * the minimum for a frame.
 */
export function fittedTimelineIdentityWidthPx(
  rows: Iterable<MeasurableRow>,
  railWidth: number,
): number | null {
  let widest = 0;
  for (const row of rows) {
    widest = Math.max(widest, row.getBoundingClientRect().width);
  }
  if (widest <= 0) return null;
  return clampTimelineIdentityWidthPx(Math.ceil(widest) + IDENTITY_CONTENT_SLACK_PX, railWidth);
}

const REASONING_TRACE_LANE_EXTENSION = "studio.presentation.reasoningTraceLane";

export function V1TimelineRail({
  document,
  state,
  signalLanes = [],
  playback = null,
  selectedInteractionId = null,
  onSelectActor,
  onFocusActor,
  onFocusSignal,
  onSelectInteraction,
  onClearSelection,
  onSelectSignal,
  disableInteractionCreation = false,
  lockSimpleTimedRoutes = false,
  readOnly = false,
}: V1TimelineRailProps) {
  const railRef = useRef<HTMLElement>(null);
  const [authoringTime, setAuthoringTime] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [preview, setPreview] = useState<ClipPreview | null>(null);
  const [manualHeight, setManualHeight] = useState<number | null>(null);
  // `null` means "fit the content"; a number is an explicit width the user dragged.
  const [manualIdentityWidth, setManualIdentityWidth] = useState<number | null>(null);
  const [fittedIdentityWidth, setFittedIdentityWidth] = useState(IDENTITY_DEFAULT_WIDTH_PX);
  const identityWidth = manualIdentityWidth ?? fittedIdentityWidth;
  const splitDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const splitResetRef = useRef(0);
  const [draggedPlayheadTime, setDraggedPlayheadTime] = useState<number | null>(null);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const playheadDragRef = useRef<number | null>(null);
  const trackScrubRef = useRef<{ pointerId: number; track: HTMLElement } | null>(null);
  const [carlaTable, setCarlaTable] = useState<CarlaCompatibilityTable | null>(null);

  const { choreography } = document.data;
  const windowRange = useMemo(() => choreographyWindow(choreography), [choreography]);
  const layout = useMemo(() => resolveInteractionLayout(document.data), [document.data]);
  const timelineCues = useMemo(() => buildTimelineCues(document.data), [document.data]);
  const rowsByActor = useMemo(() => {
    const byActor = new Map<string, ResolvedInteraction[]>();
    for (const item of layout) {
      const actorItems = byActor.get(item.actor) ?? [];
      actorItems.push(item);
      byActor.set(item.actor, actorItems);
    }
    return new Map([...byActor].map(([actorId, items]) => [actorId, packTimelineInteractionRows(items)]));
  }, [layout]);
  const worldRows = useMemo(
    () => packTimelineInteractionRows(layout.filter((item) => item.actor === "@world")),
    [layout],
  );
  const hasWorldInteractions = worldRows.some((row) => row.length > 0);
  const sensorSubjectId = document.data.roles.find(
    (role) => role.actor.sensors.length > 0,
  )?.id;
  const reasoningTraceEnabled = Boolean(
    sensorSubjectId && (
      document.data.reasoningTrace.length > 0 ||
      document.data.extensions?.[REASONING_TRACE_LANE_EXTENSION] === true
    ),
  );
  const actorLabels = timelineActorLabels(document.data.roles);
  const carlaCompatibilityByActor = useMemo(() => {
    if (!carlaTable) return null;
    const compatibilityByActor = new Map<string, CarlaCompatibility>();
    for (const role of document.data.roles) {
      if (!role.actor.catalogId) continue;
      compatibilityByActor.set(
        role.id,
        carlaCompatibilityFor(role.actor.catalogId, carlaTable),
      );
    }
    return compatibilityByActor;
  }, [carlaTable, document.data.roles]);
  const visibleLaneRows = signalLanes.length
    + (hasWorldInteractions ? Math.max(1, worldRows.length) : 0)
    + document.data.roles.reduce(
      (count, role) => count + Math.max(1, rowsByActor.get(role.id)?.length ?? 0),
      0,
    ) + (reasoningTraceEnabled ? 1 : 0);
  const timelineHeight = manualHeight ?? timelineDefaultHeightPx(visibleLaneRows);

  /**
   * What the identity cells actually render, as one string.
   *
   * Measuring on every render would reflow the rail 60 times a second during a
   * scrub, and enumerating "the labels, plus the icons, plus whether the delete
   * button exists" as effect dependencies is the kind of list that silently goes
   * stale. A signature over the same inputs re-measures exactly when the content
   * can have changed.
   */
  const identityContentSignature = [
    readOnly ? "ro" : "rw",
    reasoningTraceEnabled ? "reason" : "",
    hasWorldInteractions ? "world" : "",
    carlaCompatibilityByActor ? [...carlaCompatibilityByActor].map(([id, value]) => `${id}:${value}`).join(",") : "",
    document.data.roles.map((role) => `${role.id}:${actorLabels.get(role.id) ?? ""}:${role.actor.catalogId ?? ""}`).join(","),
    signalLanes.map((lane) => `${lane.referenceHeadId}:${lane.headIds.join("/")}`).join(","),
  ].join("|");

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const fit = () => {
      const next = fittedTimelineIdentityWidthPx(
        rail.querySelectorAll<HTMLElement>(`[${IDENTITY_CONTENT_ATTR}]`),
        rail.getBoundingClientRect().width,
      );
      if (next === null) return;
      setFittedIdentityWidth((current) => (current === next ? current : next));
    };
    fit();
    // A narrower rail lowers the cap, and a late webfont changes every label's
    // width after the first measurement has already been taken. Both are
    // refinements of a width that is already correct, so an environment without
    // either API keeps the measurement above.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(rail);
    let cancelled = false;
    void globalThis.document?.fonts?.ready.then(() => {
      if (!cancelled) fit();
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [identityContentSignature]);
  const selectInteraction = useCallback((interactionId: string, actorId: string) => {
    onSelectInteraction?.(interactionId, actorId);
  }, [onSelectInteraction]);
  const clearInteraction = useCallback(() => {
    onClearSelection?.();
  }, [onClearSelection]);
  const routeAuthoring = state?.mode === "drawingRoute";
  const playAvailable = Boolean(playback?.sessionId && playback.onPlayPause) && !routeAuthoring;
  const displayedTime = draggedPlayheadTime ?? (playback?.inspecting ? playback.time : authoringTime);
  const playheadPercent = rangePercent(displayedTime * 1000, windowRange);
  const playPauseRef = useRef<(() => void) | null>(null);
  playPauseRef.current = playAvailable ? playback?.onPlayPause ?? null : null;
  const exitPlaybackRef = useRef<(() => void) | null>(null);
  exitPlaybackRef.current = playback?.inspecting ? playback.onExitInspection : null;

  useEffect(() => {
    let active = true;
    void loadCarlaCompatibility()
      .then((table) => {
        if (active) setCarlaTable(table);
      })
      .catch(() => {
        // Compatibility metadata is advisory and must never break the editor.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onPlaybackShortcut = (event: KeyboardEvent) => {
      if (event.key === "Escape" && exitPlaybackRef.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        exitPlaybackRef.current();
        return;
      }
      const space = event.code === "Space" || event.key === " " || event.key === "Spacebar";
      if (!space || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTextEntryKeyboardTarget(event.target)) return;
      // Capture before CityCameraControls records Space as fly-mode elevation.
      // This also prevents a focused button from interpreting Space as a click
      // and opening actor or interaction details.
      event.preventDefault();
      event.stopImmediatePropagation();
      playPauseRef.current?.();
    };
    window.addEventListener("keydown", onPlaybackShortcut, true);
    return () => window.removeEventListener("keydown", onPlaybackShortcut, true);
  }, []);

  useEffect(() => {
    setAuthoringTime((current) => clampTime(current, windowRange));
  }, [windowRange]);

  useEffect(() => {
    if (
      selectedInteractionId &&
      !choreography.interactions.some((item) => item.id === selectedInteractionId)
    ) {
      clearInteraction();
    }
  }, [choreography.interactions, clearInteraction, selectedInteractionId]);

  useEffect(() => {
    setPreview(null);
    setContextMenu(null);
    setSelectedTraceId(null);
  }, [document]);

  const addReasoningTrace = (event: React.MouseEvent<HTMLElement>) => {
    if (readOnly || !sensorSubjectId) return;
    event.preventDefault();
    const timeS = timelineTimeFromClientX(event.clientX, event.currentTarget.getBoundingClientRect(), windowRange);
    const startS = Math.min(snapToTimeGrid(timeS), Math.max(0, choreography.clipSeconds - 0.1));
    const segment: ReasoningTraceSegment = {
      id: newTemplateId('trace'),
      actor: sensorSubjectId,
      startS,
      endS: Math.min(choreography.clipSeconds, Math.max(startS + 0.1, snapToTimeGrid(startS + 2))),
      observation: '',
      action: '',
    };
    document.addReasoningTraceSegment(segment);
    onClearSelection?.();
    setSelectedTraceId(segment.id);
  };

  const selectReasoningTrace = (id: string) => {
    onClearSelection?.();
    setSelectedTraceId(id);
  };

  const openContextMenu = (
    event: React.MouseEvent<HTMLElement>,
    actorId: string,
  ) => {
    if (readOnly || disableInteractionCreation) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const track = event.currentTarget.matches("[data-timeline-track]")
      ? event.currentTarget
      : event.currentTarget.querySelector<HTMLElement>("[data-timeline-track]");
    if (!track) return;
    const timeS = timelineTimeFromClientX(event.clientX, track.getBoundingClientRect(), windowRange);
    setAuthoringTime(timeS);
    setContextMenu({
      actorId,
      timeS,
      anchorX: event.clientX,
      anchorY: event.clientY,
    });
  };

  const addAction = (role: Role, definitionId: string, timeS: number) => {
    if (readOnly || disableInteractionCreation) return;
    const definition = actionsForActor(role.actor.class, role.actor.catalogId).find(
      (candidate) => candidate.id === definitionId,
    );
    if (!definition) return;
    const interaction = interactionForAction(
      definition,
      role.id,
      timeS,
      choreography.interactions.length + 1,
    );
    const id = uniqueTimelineInteractionId(
      `${definition.id}_${role.id}`,
      choreography.interactions.map((item) => item.id),
    );
    const next = definition.id === 'custom_route'
      ? {
          ...interaction,
          id,
          until: { kind: 'at', t: choreography.clipSeconds },
        }
      : { ...interaction, id };
    if (!setExclusiveCustomTimedRoute(document, next as Interaction)) {
      document.addInteraction(next as Interaction);
    }
    selectInteraction(id, role.id);
    setContextMenu(null);
  };

  const addDirectAction = (role: Role, verb: "gap" | "exist", timeS: number) => {
    if (readOnly || disableInteractionCreation) return;
    const otherRole = gapPeerFor(role, document.data.roles);
    if (verb === "gap" && !otherRole) return;
    const startS = snapToTimeGrid(timeS);
    const id = uniqueTimelineInteractionId(
      `${verb}_${role.id}`,
      choreography.interactions.map((item) => item.id),
    );
    const interaction = {
      id,
      actor: role.id,
      label: verb === "gap" ? "Follow gap" : "Become absent",
      trigger: { kind: "at", t: startS },
      until: { kind: "at", t: snapToTimeGrid(startS + 1) },
      verb,
      target:
        verb === "gap"
          ? { role: otherRole!.id, value: 2, unit: "time" }
          : { state: "absent" },
      ...(verb === "gap"
        ? { dynamics: { shape: "linear", constraint: "time", value: 1 } }
        : {}),
    } as Interaction;
    document.addInteraction(interaction);
    selectInteraction(id, role.id);
    setContextMenu(null);
  };

  const finishCanonicalAdd = (interaction: Interaction) => {
    selectInteraction(interaction.id, interaction.actor);
    setContextMenu(null);
  };

  const commitRange = (interaction: Interaction, range: AuthoredTimelineRange) => {
    if (readOnly || isCustomTimedRoute(interaction)) return;
    const ranged = interactionWithAuthoredTimelineRange(interaction, range);
    document.replaceInteraction(
      interaction.id,
      interaction.verb === 'route' && (interaction.target.mode === 'customRoute' || interaction.target.mode === 'customTimedRoute')
        ? { ...ranged, until: { kind: 'at', t: choreography.clipSeconds } }
        : ranged,
    );
    setPreview(null);
  };

  const seekTimelineToTime = (timeS: number) => {
    const nextTimeS = clampTime(timeS, windowRange);
    setContextMenu(null);
    setAuthoringTime(nextTimeS);
    if (playback?.sessionId) playback.onSeek(nextTimeS);
    return nextTimeS;
  };

  const scrubTrackToClientX = (track: HTMLElement, clientX: number) => {
    const timeS = timelineTimeFromClientX(clientX, track.getBoundingClientRect(), windowRange);
    setDraggedPlayheadTime(seekTimelineToTime(timeS));
  };

  const beginTrackScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(
      "[data-timeline-seek-ignore], [data-timeline-interaction-id], input, textarea, select, button, a",
    )) return;
    const track = target.closest<HTMLElement>("[data-timeline-track]");
    if (!track) return;
    event.preventDefault();
    trackScrubRef.current = { pointerId: event.pointerId, track };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    scrubTrackToClientX(track, event.clientX);
  };

  const moveTrackScrub = (event: ReactPointerEvent<HTMLElement>) => {
    const scrub = trackScrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    scrubTrackToClientX(scrub.track, event.clientX);
  };

  const endTrackScrub = (event: ReactPointerEvent<HTMLElement>) => {
    const scrub = trackScrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    scrubTrackToClientX(scrub.track, event.clientX);
    trackScrubRef.current = null;
    setDraggedPlayheadTime(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelTrackScrub = (event: ReactPointerEvent<HTMLElement>) => {
    if (trackScrubRef.current?.pointerId !== event.pointerId) return;
    trackScrubRef.current = null;
    setDraggedPlayheadTime(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const dragPlayheadToClientX = (clientX: number) => {
    const rail = railRef.current?.getBoundingClientRect();
    if (!rail) return;
    const timeS = timelineTimeFromClientX(clientX, {
      left: rail.left + identityWidth,
      width: Math.max(1, rail.width - identityWidth),
    }, windowRange);
    setDraggedPlayheadTime(seekTimelineToTime(timeS));
  };

  const beginPlayheadDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    playheadDragRef.current = event.pointerId;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragPlayheadToClientX(event.clientX);
  };

  const movePlayheadDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (playheadDragRef.current !== event.pointerId) return;
    dragPlayheadToClientX(event.clientX);
  };

  const endPlayheadDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (playheadDragRef.current !== event.pointerId) return;
    dragPlayheadToClientX(event.clientX);
    playheadDragRef.current = null;
    setDraggedPlayheadTime(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelPlayheadDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (playheadDragRef.current !== event.pointerId) return;
    playheadDragRef.current = null;
    setDraggedPlayheadTime(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const beginTimelineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeDragRef.current = { startY: event.clientY, startHeight: timelineHeight };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const resizeTimeline = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag) return;
    setManualHeight(
      clampTimelineHeightPx(
        drag.startHeight + drag.startY - event.clientY,
        window.innerHeight,
      ),
    );
  };

  const endTimelineResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizeDragRef.current) return;
    resizeDragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const railWidth = () => railRef.current?.getBoundingClientRect().width ?? 0;

  const beginSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // Capturing the pointer keeps a drag alive outside this 12px strip, but it
    // also stops Chromium from synthesizing the `dblclick` that would carry a
    // reset, so the second press is recognized here instead.
    if (event.timeStamp - splitResetRef.current < SPLIT_RESET_WINDOW_MS) {
      splitResetRef.current = 0;
      splitDragRef.current = null;
      // Reset means "go back to fitting the content", not "go back to 114px".
      setManualIdentityWidth(null);
      return;
    }
    splitResetRef.current = event.timeStamp;
    splitDragRef.current = { startX: event.clientX, startWidth: identityWidth };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const resizeSplit = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = splitDragRef.current;
    if (!drag) return;
    event.stopPropagation();
    setManualIdentityWidth(clampTimelineIdentityWidthPx(
      drag.startWidth + (event.clientX - drag.startX),
      railWidth(),
    ));
  };

  const endSplitResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!splitDragRef.current) return;
    splitDragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section
      ref={railRef}
      className={cn(
        "z-30 flex min-h-0 w-full shrink-0 flex-col text-white",
        TIMELINE_GLASS_SURFACE_CLASSNAME,
      )}
      data-floating="true"
      data-interaction-authoring={readOnly || disableInteractionCreation ? "disabled" : "enabled"}
      data-presentation="floating"
      data-testid="scenario-timeline-dock"
      data-tutorial="timeline"
      aria-readonly={readOnly}
      onPointerCancelCapture={cancelTrackScrub}
      onPointerDownCapture={beginTrackScrub}
      onPointerMoveCapture={moveTrackScrub}
      onPointerUpCapture={endTrackScrub}
      style={{
        width: "100%",
        maxWidth: "none",
        borderRadius: "24px 24px 0 0",
        clipPath: "inset(0 round 24px 24px 0 0)",
        backdropFilter: "blur(72px) saturate(1.85) contrast(1.05)",
        WebkitBackdropFilter: "blur(72px) saturate(1.85) contrast(1.05)",
        height: `${timelineHeight}px`,
        maxHeight: "min(65vh, 520px)",
        [IDENTITY_WIDTH_VAR]: `${identityWidth}px`,
      } as CSSProperties}
    >
      <>
          <TimelineGlassBackdrop />
          <div
            aria-label="Resize timeline"
            aria-orientation="horizontal"
            className="absolute left-1/2 top-0 z-40 flex h-3 w-24 -translate-x-1/2 cursor-ns-resize touch-none items-start justify-center pt-1"
            data-testid="timeline-height-resize-handle"
            onDoubleClick={() => setManualHeight(null)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              setManualHeight(clampTimelineHeightPx(
                timelineHeight + (event.key === "ArrowUp" ? 24 : -24),
                window.innerHeight,
              ));
            }}
            onPointerCancel={endTimelineResize}
            onPointerDown={beginTimelineResize}
            onPointerMove={resizeTimeline}
            onPointerUp={endTimelineResize}
            role="separator"
            tabIndex={0}
          >
            <span className="h-1 w-10 rounded-full bg-white/35 transition-colors hover:bg-[#E8E044]/70" />
          </div>
          <div
            aria-label="Resize name column"
            aria-orientation="vertical"
            aria-valuemax={IDENTITY_MAX_WIDTH_PX}
            aria-valuemin={IDENTITY_MIN_WIDTH_PX}
            aria-valuenow={identityWidth}
            aria-valuetext={
              manualIdentityWidth === null
                ? `Name column fits its contents, ${identityWidth} pixels`
                : `Name column ${identityWidth} pixels`
            }
            className="group absolute inset-y-0 z-40 -ml-1.5 w-3 cursor-col-resize touch-none"
            data-testid="timeline-split-resize-handle"
            data-timeline-seek-ignore="true"
            // Two press/release pairs — a human double click — are caught in
            // `beginSplitResize`, because pointer capture suppresses `dblclick`
            // there. A single press carrying `clickCount: 2` arrives only as
            // `dblclick` instead. Resetting is idempotent, so honouring both
            // shapes costs nothing and leaves no way to double click without a
            // reset.
            onDoubleClick={() => setManualIdentityWidth(null)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              setManualIdentityWidth(clampTimelineIdentityWidthPx(
                identityWidth + (event.key === "ArrowRight" ? 16 : -16),
                railWidth(),
              ));
            }}
            onPointerCancel={endSplitResize}
            onPointerDown={beginSplitResize}
            onPointerMove={resizeSplit}
            onPointerUp={endSplitResize}
            role="separator"
            style={{ left: `var(${IDENTITY_WIDTH_VAR})` }}
            tabIndex={0}
          >
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/25 transition-colors group-hover:bg-[#E8E044]/80 group-focus-visible:bg-[#E8E044]" />
          </div>
          <header
            className="relative z-10 grid h-12 shrink-0 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] overflow-hidden rounded-t-[24px] border-b border-white/10 bg-gradient-to-r from-[#E8E044]/[0.07] via-white/[0.025] to-transparent"
            data-testid="timeline-topbar"
          >
            <div className="flex min-w-0 items-center justify-center overflow-hidden border-r border-white/10">
              <div
                className="flex w-max flex-col items-center justify-center gap-0.5 px-2"
                {...{ [IDENTITY_CONTENT_ATTR]: "" }}
              >
                <strong className="whitespace-nowrap text-center text-[8px] font-bold uppercase tracking-[0.12em] text-[#E8E044]">
                  Timeline
                </strong>
                <TimelineTransportControls playback={playback} playDisabled={routeAuthoring} />
              </div>
            </div>
            <div
              className="relative min-w-0 self-stretch cursor-pointer"
              data-testid="timeline-inline-ruler"
              data-timeline-track="ruler"
            >
              <TimelineRuler
                choreography={choreography}
                crashes={playback?.crashes}
                className="mb-0 h-full border-b-0 bg-black/20"
              />
            </div>
          </header>

          <div
            className="pointer-events-none absolute inset-y-0 z-20 w-px bg-[#E8E044] shadow-[0_0_10px_rgba(232,224,68,0.65)]"
            data-testid="timeline-playhead"
            style={{
              left: `calc(var(${IDENTITY_WIDTH_VAR}) + (100% - var(${IDENTITY_WIDTH_VAR})) * ${playheadPercent / 100})`,
            }}
          >
            <button
              aria-label="Drag timeline playhead"
              aria-valuemax={windowRange.endMs / 1000}
              aria-valuemin={windowRange.startMs / 1000}
              aria-valuenow={displayedTime}
              aria-valuetext={`${displayedTime.toFixed(1)} seconds`}
              className="group pointer-events-auto absolute -left-2 inset-y-0 w-4 cursor-ew-resize touch-none bg-transparent p-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
              data-testid="timeline-playhead-drag-handle"
              data-timeline-seek-ignore="true"
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const step = event.shiftKey ? 1 : 0.1;
                seekTimelineToTime(displayedTime + (event.key === "ArrowRight" ? step : -step));
              }}
              onPointerCancel={cancelPlayheadDrag}
              onPointerDown={beginPlayheadDrag}
              onPointerMove={movePlayheadDrag}
              onPointerUp={endPlayheadDrag}
              role="slider"
              type="button"
            >
              <span className="absolute left-1/2 top-0 size-3 -translate-x-1/2 rounded-full bg-[#E8E044] shadow-[0_0_10px_rgba(232,224,68,0.55)] transition-transform group-hover:scale-125" />
            </button>
          </div>

          <div className="relative z-10 min-h-0 flex-1 overflow-hidden bg-black/10" data-testid="semantic-timeline">
            <div className="absolute inset-0 overflow-y-auto" onScroll={() => setContextMenu(null)}>
              <div className="min-h-full pb-12">
                {signalLanes.map((lane) => (
                  <SignalRailLane
                    key={`${lane.junctionId}:${lane.controllerId}`}
                    lane={lane}
                    window={windowRange}
                    onFocus={
                      !readOnly && onFocusSignal
                        ? () => onFocusSignal(lane.referenceHeadId)
                        : undefined
                    }
                    onConfigure={
                      !readOnly && onSelectSignal
                        ? () => onSelectSignal(lane.referenceHeadId)
                        : undefined
                    }
                    onRemoveControl={!readOnly ? lane.onRemoveControl : undefined}
                  />
                ))}
                {hasWorldInteractions ? (
                  <WorldRailLane
                    cues={timelineCues}
                    rows={worldRows}
                    preview={preview}
                    selectedInteractionId={selectedInteractionId}
                    window={windowRange}
                    onCommitRange={commitRange}
                    onPreview={setPreview}
                    onSelectInteraction={(id) => selectInteraction(id, "@world")}
                    lockSimpleTimedRoutes={lockSimpleTimedRoutes}
                    readOnly={readOnly}
                  />
                ) : null}
                {document.data.roles.map((role) => (
                  <Fragment key={role.id}>
                  <ActorRailLane
                    cues={timelineCues}
                    displayLabel={actorLabels.get(role.id) ?? "Actor"}
                    rows={rowsByActor.get(role.id) ?? [[]]}
                    preview={preview}
                    role={role}
                    carlaCompatibility={carlaCompatibilityByActor?.get(role.id) ?? null}
                    selected={state?.selection.includes(role.id) ?? false}
                    selectedInteractionId={selectedInteractionId}
                    window={windowRange}
                    onCommitRange={commitRange}
                    onContextMenu={openContextMenu}
                    onPreview={setPreview}
                    onRemoveActor={(actor) => {
                      setContextMenu(null);
                      document.remove([actor.id]);
                    }}
                    onFocusActor={onFocusActor}
                    onSelectActor={onSelectActor}
                    onSelectInteraction={(id) => selectInteraction(id, role.id)}
                    interactionCreationDisabled={disableInteractionCreation}
                    lockSimpleTimedRoutes={lockSimpleTimedRoutes}
                    readOnly={readOnly}
                  />
                  {reasoningTraceEnabled && sensorSubjectId === role.id ? (
                    <ReasoningTraceLane
                      segments={document.data.reasoningTrace.filter((segment) => segment.actor === role.id)}
                      selectedId={selectedTraceId}
                      window={windowRange}
                      readOnly={readOnly}
                      onAdd={addReasoningTrace}
                      onSelect={selectReasoningTrace}
                    />
                  ) : null}
                  </Fragment>
                ))}
                {document.data.roles.length === 0 && signalLanes.length === 0 && !hasWorldInteractions ? (
                  <p className="m-3 grid h-24 place-items-center border border-dashed border-white/15 px-4 text-center text-xs text-white/35">
                    {readOnly ? "No authored timeline content." : "Place an actor to start authoring the timeline."}
                  </p>
                ) : null}
              </div>
            </div>
          </div>

          {contextMenu && !readOnly && !disableInteractionCreation ? (
            <ContextActionMenu
              document={document}
              state={contextMenu}
              onAdd={addAction}
              onAddCanonical={finishCanonicalAdd}
              onAddDirect={addDirectAction}
              onClose={() => setContextMenu(null)}
            />
          ) : null}
          {selectedTraceId ? (
            <ReasoningTraceEditor
              segment={document.data.reasoningTrace.find((item) => item.id === selectedTraceId) ?? null}
              clipSeconds={choreography.clipSeconds}
              readOnly={readOnly}
              onClose={() => setSelectedTraceId(null)}
              onDelete={(id) => { document.removeReasoningTraceSegment(id); setSelectedTraceId(null); }}
              onSave={(segment) => document.replaceReasoningTraceSegment(segment.id, segment)}
            />
          ) : null}
      </>
    </section>
  );
}

function isTextEntryKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('textarea, [contenteditable="true"], [role="textbox"]')) return true;
  const input = target.closest("input");
  if (!input) return false;
  return ![
    "button",
    "checkbox",
    "color",
    "file",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ].includes(input.type);
}

function SignalRailLane({
  lane,
  window,
  onConfigure,
  onFocus,
  onRemoveControl,
}: {
  lane: V1TimelineSignalLane;
  window: TimelineRange;
  onFocus?: () => void;
  onConfigure?: () => void;
  onRemoveControl?: () => void;
}) {
  const laneId = `${lane.junctionId}-${lane.controllerId}`;
  return (
    <div
      className="grid h-10 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] border-b border-white/10 bg-black/20"
      data-testid={`timeline-signal-lane-${laneId}`}
    >
      <div className="flex min-w-0 items-stretch overflow-hidden border-r border-white/10 bg-[#E8E044]/[0.06]">
        <div
          className="flex w-max items-stretch self-stretch"
          {...{ [IDENTITY_CONTENT_ATTR]: "" }}
        >
          {onFocus || onConfigure ? (
            <button
              aria-label={`${onFocus ? "Focus" : "Configure"} traffic light ${lane.referenceHeadId}`}
              className="editor-motion flex items-center gap-1.5 px-2 text-left text-[9px] text-[#E8E044] hover:bg-[#E8E044]/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#E8E044]"
              data-testid={`timeline-focus-signal-${laneId}`}
              type="button"
              onClick={onFocus ?? onConfigure}
            >
              <TrafficCone aria-hidden="true" className="size-3 shrink-0" />
              <span className="whitespace-nowrap">Light {lane.referenceHeadId}</span>
            </button>
          ) : (
            <div className="flex items-center gap-1.5 px-2 text-[9px] text-[#E8E044]/80">
              <TrafficCone aria-hidden="true" className="size-3 shrink-0" />
              <span className="whitespace-nowrap">Lights {lane.headIds.join(", ")}</span>
            </div>
          )}
          {onRemoveControl ? (
            <button
              aria-label={`Remove control from traffic light ${lane.referenceHeadId}`}
              className="editor-motion grid w-6 shrink-0 place-items-center border-l border-white/10 text-white/35 hover:bg-red-500/15 hover:text-red-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-red-300"
              data-testid={`timeline-remove-signal-control-${laneId}`}
              onClick={onRemoveControl}
              title="Remove control"
              type="button"
            >
              <Trash2 aria-hidden="true" className="size-3" />
            </button>
          ) : null}
        </div>
      </div>
      <div className="relative my-2 cursor-pointer overflow-hidden bg-white/[0.025]" data-timeline-track="signal">
        {lane.bands.map((band) => {
          const classes = indicationSwatch(band.indication);
          const authored = band.source === "authored";
          const selectable = Boolean(onConfigure);
          return (
            <button
              aria-label={`${indicationLabel(band.indication)}, ${band.startS.toFixed(1)} to ${band.endS.toFixed(1)} seconds, ${authored ? "authored" : selectable ? "map timing; click to take control" : "map timing"}`}
              className={`absolute inset-y-0 flex min-w-px items-center justify-center overflow-hidden border disabled:pointer-events-none ${
                authored ? `${classes.fill} ${classes.border}` : `${classes.ghost} border-dashed border-white/20`
              } ${selectable ? "cursor-pointer" : "cursor-default"}`}
              data-source={band.source}
              data-testid={`timeline-signal-band-${laneId}-${band.startS}`}
              disabled={!selectable}
              key={`${band.startS}:${band.endS}:${band.indication}:${band.source}`}
              onClick={() => {
                if (onConfigure) {
                  onConfigure();
                }
              }}
              style={{
                left: `${rangePercent(band.startS * 1000, window)}%`,
                width: `${Math.max(0, rangePercent(band.endS * 1000, window) - rangePercent(band.startS * 1000, window))}%`,
              }}
              type="button"
            />
          );
        })}
      </div>
    </div>
  );
}

function WorldRailLane({
  cues,
  rows,
  window,
  selectedInteractionId,
  preview,
  onSelectInteraction,
  onPreview,
  onCommitRange,
  lockSimpleTimedRoutes,
  readOnly,
}: {
  cues: ReadonlyMap<string, TimelineCue>;
  rows: readonly (readonly ResolvedInteraction[])[];
  window: TimelineRange;
  selectedInteractionId: string | null;
  preview: ClipPreview | null;
  onSelectInteraction: (id: string) => void;
  onPreview: (preview: ClipPreview | null) => void;
  onCommitRange: (interaction: Interaction, range: AuthoredTimelineRange) => void;
  lockSimpleTimedRoutes: boolean;
  readOnly: boolean;
}) {
  const rowCount = Math.max(1, rows.length);
  return (
    <article
      className="grid border-b border-white/10"
      data-testid="timeline-world-lane"
      style={{
        gridTemplateColumns: IDENTITY_GRID_COLUMNS,
        gridTemplateRows: `repeat(${rowCount}, 28px)`,
      }}
    >
      <div
        className="relative z-10 flex min-w-0 items-start overflow-hidden border-r border-white/10 bg-[#E8E044]/[0.04] text-[#E8E044]/80"
        data-testid="timeline-world-identity"
        style={{ gridColumn: 1, gridRow: `1 / span ${rowCount}` }}
      >
        <div
          className="flex w-max items-start gap-1.5 px-2 py-2"
          {...{ [IDENTITY_CONTENT_ATTR]: "" }}
        >
          <Globe2 aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          <span className="whitespace-nowrap text-[9px] font-medium">Scene / world</span>
        </div>
      </div>
      {rows.flatMap((row, rowIndex) => row.map((resolved) => (
        <InteractionBand
          cue={cues.get(resolved.interaction.id)}
          key={resolved.interaction.id}
          preview={preview?.interactionId === resolved.interaction.id ? preview.range : null}
          resolved={resolved}
          selected={selectedInteractionId === resolved.interaction.id}
          window={window}
          onCommitRange={onCommitRange}
          onPreview={onPreview}
          onSelect={() => onSelectInteraction(resolved.interaction.id)}
          lockSimpleTimedRoutes={lockSimpleTimedRoutes}
          readOnly={readOnly}
          row={rowIndex + 1}
        />
      )))}
    </article>
  );
}

function ActorRailLane({
  cues,
  carlaCompatibility,
  role,
  displayLabel,
  rows,
  window,
  selected,
  selectedInteractionId,
  preview,
  onContextMenu,
  onRemoveActor,
  onFocusActor,
  onSelectActor,
  onSelectInteraction,
  onPreview,
  onCommitRange,
  interactionCreationDisabled,
  lockSimpleTimedRoutes,
  readOnly,
}: {
  carlaCompatibility: CarlaCompatibility | null;
  cues: ReadonlyMap<string, TimelineCue>;
  role: Role;
  displayLabel: string;
  rows: readonly (readonly ResolvedInteraction[])[];
  window: TimelineRange;
  selected: boolean;
  selectedInteractionId: string | null;
  preview: ClipPreview | null;
  onContextMenu: (event: React.MouseEvent<HTMLElement>, actorId: string) => void;
  onRemoveActor: (role: Role) => void;
  onFocusActor?: (actorId: string) => void;
  onSelectActor?: (actorId: string) => void;
  onSelectInteraction: (id: string) => void;
  onPreview: (preview: ClipPreview | null) => void;
  onCommitRange: (interaction: Interaction, range: AuthoredTimelineRange) => void;
  interactionCreationDisabled: boolean;
  lockSimpleTimedRoutes: boolean;
  readOnly: boolean;
}) {
  // `Static / parked` is the only immovability switch. An object's catalog class
  // never vetoes motion: a custom gallery upload — a pedestrian model, an animal,
  // a delivery robot — is placed as `static_object` and must still accept a route.
  const staticActor = Boolean(role.actor.static);
  const interactions = rows.flat();
  const rowCount = Math.max(1, rows.length);
  const rowTemplate = `repeat(${rowCount}, 28px)`;
  const actorLabel = displayLabel;

  return (
    <article
      className="grid border-b border-white/10"
      data-static={staticActor ? "true" : "false"}
      data-testid={`timeline-actor-lane-${role.id}`}
      onClick={readOnly ? undefined : (event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("[data-timeline-interaction-id]")) return;
        onSelectActor?.(role.id);
      }}
      style={{ gridTemplateColumns: IDENTITY_GRID_COLUMNS, gridTemplateRows: rowTemplate }}
    >
      <div
        className={`relative z-10 flex min-w-0 items-start overflow-hidden border-r border-white/10 ${
          selected ? "bg-[#E8E044]/10 text-[#E8E044]" : "bg-black/20 text-white/75"
        }`}
        data-testid={`timeline-actor-identity-${role.id}`}
        style={{ gridColumn: 1, gridRow: `1 / span ${rowCount}` }}
      >
        <div
          className="flex w-max items-start gap-1.5 px-2 py-2"
          {...{ [IDENTITY_CONTENT_ATTR]: "" }}
        >
          <button
            aria-label={`Focus actor ${actorLabel}`}
            className="flex items-center gap-1.5 rounded-sm text-left enabled:cursor-pointer enabled:hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#E8E044]"
            disabled={readOnly || (!onFocusActor && !onSelectActor)}
            onClick={(event) => {
              event.stopPropagation();
              (onFocusActor ?? onSelectActor)?.(role.id);
            }}
            type="button"
          >
            <TimelineActorCatalogIcon role={role} />
            <span className="whitespace-nowrap text-[9px] font-medium" title={actorLabel}>
              {actorLabel}
            </span>
          </button>
          {carlaCompatibility ? (
            <TimelineCarlaCompatibilityMarker
              actorLabel={actorLabel}
              compatibility={carlaCompatibility}
            />
          ) : null}
          {!readOnly ? (
            <button
              aria-label={`Delete actor ${actorLabel}`}
              className="inline-flex size-4 shrink-0 items-center justify-center bg-transparent p-0 text-white/35 transition-colors hover:bg-transparent hover:text-red-300 focus-visible:bg-transparent focus-visible:text-red-300 focus-visible:outline-none"
              data-testid={`timeline-delete-${role.id}`}
              onClick={(event) => {
                event.stopPropagation();
                onRemoveActor(role);
              }}
              type="button"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      {staticActor && interactions.length === 0 ? (
        <div
          className="flex cursor-pointer items-center px-2 text-[9px] uppercase tracking-[0.12em] text-white/25"
          data-testid={`timeline-static-identity-only-${role.id}`}
          data-timeline-track="interaction"
          style={{ gridColumn: 2, gridRow: 1 }}
        >
          Static · no authored actions
        </div>
      ) : (
        <>
          {!staticActor && interactions.length === 0 ? (
            <div
              className="relative cursor-pointer bg-black/15"
              data-testid={`timeline-interaction-gap-${role.id}`}
              data-timeline-track="interaction"
              onContextMenu={readOnly ? undefined : (event) => onContextMenu(event, role.id)}
              style={{ gridColumn: 2, gridRow: 1 }}
            >
              <span className="absolute inset-0 grid place-items-center text-[8px] text-white/20">
                {readOnly || interactionCreationDisabled
                  ? "No authored actions"
                  : "Right-click a gap to add an action"}
              </span>
            </div>
          ) : (
            rows.flatMap((row, rowIndex) => row.map((resolved) => (
              <InteractionBand
                cue={cues.get(resolved.interaction.id)}
                key={resolved.interaction.id}
                preview={preview?.interactionId === resolved.interaction.id ? preview.range : null}
                resolved={resolved}
                selected={selectedInteractionId === resolved.interaction.id}
                window={window}
                onCommitRange={onCommitRange}
                onPreview={onPreview}
                onSelect={() => onSelectInteraction(resolved.interaction.id)}
                onOpenContextMenu={readOnly ? undefined : (event) => onContextMenu(event, role.id)}
                lockSimpleTimedRoutes={lockSimpleTimedRoutes}
                readOnly={readOnly}
                row={rowIndex + 1}
              />
            )))
          )}
        </>
      )}
    </article>
  );
}

function ReasoningTraceLane({
  segments,
  selectedId,
  window,
  readOnly,
  onAdd,
  onSelect,
}: {
  segments: readonly ReasoningTraceSegment[];
  selectedId: string | null;
  window: TimelineRange;
  readOnly: boolean;
  onAdd: (event: React.MouseEvent<HTMLElement>) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <article className="grid h-10 grid-cols-[var(--timeline-identity-width)_minmax(0,1fr)] border-b border-white/10 bg-[#E8E044]/[0.025]" data-testid="timeline-reasoning-trace-lane">
      <div className="flex min-w-0 items-center overflow-hidden border-r border-white/10 text-[#E8E044]/80">
        <div
          className="flex w-max items-center gap-1.5 px-2"
          {...{ [IDENTITY_CONTENT_ATTR]: "" }}
        >
          <BrainCircuit aria-hidden="true" className="size-3 shrink-0" />
          <span className="whitespace-nowrap text-[8px] font-semibold uppercase tracking-[0.08em]">Reasoning</span>
        </div>
      </div>
      <div
        className="relative cursor-pointer bg-black/15"
        data-timeline-track="reasoning"
        onContextMenu={readOnly ? undefined : onAdd}
      >
        {segments.length === 0 ? (
          <span className="absolute inset-0 grid place-items-center text-[8px] text-white/20">
            {readOnly ? 'No reasoning trace' : 'Right-click to add observation + action'}
          </span>
        ) : null}
        {segments.map((segment) => {
          const start = rangePercent(segment.startS * 1000, window);
          const end = rangePercent(segment.endS * 1000, window);
          const label = segment.observation || segment.action || 'New reasoning note';
          return (
            <button
              aria-label={`Edit reasoning trace from ${segment.startS.toFixed(1)} to ${segment.endS.toFixed(1)} seconds`}
              className={`absolute inset-y-1 overflow-hidden rounded-md border px-2 text-left text-[8px] ${selectedId === segment.id ? 'border-white bg-[#E8E044] text-black ring-1 ring-white' : 'border-[#E8E044]/70 bg-[#E8E044]/25 text-[#E8E044]'}`}
              data-timeline-seek-ignore="true"
              data-testid={`reasoning-trace-clip-${segment.id}`}
              key={segment.id}
              onClick={(event) => { event.stopPropagation(); onSelect(segment.id); }}
              onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onSelect(segment.id); }}
              style={{ left: `${start}%`, width: `${Math.max(1, end - start)}%` }}
              title={label}
              type="button"
            >
              <span className="block truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </article>
  );
}

function ReasoningTraceEditor({
  segment,
  clipSeconds,
  readOnly,
  onClose,
  onDelete,
  onSave,
}: {
  segment: ReasoningTraceSegment | null;
  clipSeconds: number;
  readOnly: boolean;
  onClose: () => void;
  onDelete: (id: string) => void;
  onSave: (segment: ReasoningTraceSegment) => void;
}) {
  const [draft, setDraft] = useState(segment);
  useEffect(() => setDraft(segment), [segment]);
  if (!draft) return null;
  return (
    <EditorDetailsPanel
      ariaLabel="Reasoning trace details"
      closeLabel="Close reasoning trace"
      closeTestId="reasoning-trace-close"
      maxHeight="min(620px, calc(100vh - 96px))"
      onClose={onClose}
      onDelete={readOnly ? undefined : () => onDelete(draft.id)}
      preview={(
        <div className="flex flex-col items-center gap-1 text-center">
          <BrainCircuit aria-hidden="true" className="size-8 text-[#E8E044]" />
          <strong className="text-[10px] font-semibold text-white">Reasoning trace</strong>
          <span className="text-[8px] text-white/40">Observation and action</span>
        </div>
      )}
      previewClassName="h-24 px-4 py-3"
      testId="scenario-reasoning-trace-panel"
    >
      <div className="grid grid-cols-2 gap-2">
        {(['startS', 'endS'] as const).map((field) => (
          <label className="min-w-0 text-[8px] uppercase tracking-[0.1em] text-white/45" key={field}>{field === 'startS' ? 'Start' : 'End'}
            <input className="mt-1 h-8 w-full min-w-0 rounded-md border border-white/10 bg-white/[0.04] px-2 text-[10px] normal-case text-white outline-none focus:border-[#E8E044]/60" disabled={readOnly} max={clipSeconds} min={field === 'startS' ? 0 : 0.1} onChange={(event) => setDraft({ ...draft, [field]: Number(event.target.value) })} step="0.1" type="number" value={draft[field]} />
          </label>
        ))}
      </div>
      <label className="block text-[8px] uppercase tracking-[0.1em] text-white/45">Observation
        <textarea className="mt-1 min-h-24 w-full resize-y rounded-md border border-white/10 bg-white/[0.04] p-2 text-[10px] normal-case leading-relaxed text-white outline-none focus:border-[#E8E044]/60" disabled={readOnly} onChange={(event) => setDraft({ ...draft, observation: event.target.value })} placeholder="What is happening around the camera vehicle?" value={draft.observation} />
      </label>
      <label className="block text-[8px] uppercase tracking-[0.1em] text-white/45">Action
        <textarea className="mt-1 min-h-24 w-full resize-y rounded-md border border-white/10 bg-white/[0.04] p-2 text-[10px] normal-case leading-relaxed text-white outline-none focus:border-[#E8E044]/60" disabled={readOnly} onChange={(event) => setDraft({ ...draft, action: event.target.value })} placeholder="What should the camera vehicle do next?" value={draft.action} />
      </label>
      {!readOnly ? <div className="grid grid-cols-1 gap-1.5 border-t border-white/10 pt-3"><button className="h-8 rounded-md bg-[#E8E044] px-3 text-[10px] font-semibold text-black disabled:opacity-40" disabled={!Number.isFinite(draft.startS) || !Number.isFinite(draft.endS) || draft.startS < 0 || draft.endS <= draft.startS || draft.endS > clipSeconds} onClick={() => onSave(draft)} type="button">Save trace</button><button className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-red-300/20 text-[9px] text-red-200 hover:bg-red-300/10" onClick={() => onDelete(draft.id)} type="button"><Trash2 aria-hidden="true" className="size-3" />Delete trace</button></div> : null}
    </EditorDetailsPanel>
  );
}

function InteractionBand({
  cue,
  resolved,
  selected,
  preview,
  window,
  row,
  onSelect,
  onPreview,
  onCommitRange,
  onOpenContextMenu,
  lockSimpleTimedRoutes,
  readOnly,
}: {
  cue: TimelineCue | undefined;
  resolved: ResolvedInteraction;
  selected: boolean;
  preview: AuthoredTimelineRange | null;
  window: TimelineRange;
  row: number;
  onSelect: () => void;
  onPreview: (preview: ClipPreview | null) => void;
  onCommitRange: (interaction: Interaction, range: AuthoredTimelineRange) => void;
  onOpenContextMenu?: (event: React.MouseEvent<HTMLElement>) => void;
  lockSimpleTimedRoutes: boolean;
  readOnly: boolean;
}) {
  const interaction = resolved.interaction;
  const customTimedRoute = isCustomTimedRoute(interaction);
  const simpleTimedRoute = lockSimpleTimedRoutes && customTimedRoute;
  const routeNeedsSetup = simpleTimedRoute && isUnconfiguredSimpleTimedRoute(interaction);
  const timingLocked = readOnly || customTimedRoute;
  const endsWithScenario = interaction.verb === 'route' && (interaction.target.mode === 'customRoute' || customTimedRoute);
  const editable = authoredTimelineRange(interaction);
  const shownRange = preview
    ? { startMs: preview.startS * 1000, endMs: preview.endS * 1000 }
    : resolved.range;
  const start = rangePercent(shownRange.startMs, window);
  const end = rangePercent(shownRange.endMs, window);
  const label = simpleTimedRoute
    ? routeNeedsSetup
      ? "Click to configure route"
      : "Edit route"
    : interaction.label ?? interaction.verb;
  const conflictMessage = cue ? timelineConflictMessage(cue) : null;
  const deadlinePercent = cue?.deadlineS === null || cue?.deadlineS === undefined
    ? null
    : rangePercent(cue.deadlineS * 1000, window);
  const timingHelp = cue?.cause === "time"
    ? "Starts at a set time"
    : "Starts when something happens";

  const beginEdit =
    (editMode: TimelineClipEditMode) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (timingLocked) return;
      onSelect();
      // Selection is controlled by the editor shell and therefore cannot be
      // reflected until the next render. Do not make the first edge press a
      // selection-only click: an editable clip must resize immediately.
      if (!editable || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const track = event.currentTarget.closest<HTMLElement>("[data-timeline-track]");
      if (!track) return;
      const bounds = track.getBoundingClientRect();
      const startX = event.clientX;
      let latest = editable;
      const rangeAt = (pointer: PointerEvent) => {
        const deltaS = ((pointer.clientX - startX) / Math.max(1, bounds.width)) *
          ((window.endMs - window.startMs) / 1000);
        return editAuthoredTimelineRange(editable, editMode, deltaS, window);
      };
      const move = (pointer: PointerEvent) => {
        latest = rangeAt(pointer);
        onPreview({ interactionId: interaction.id, range: latest });
      };
      const finish = (pointer: PointerEvent) => {
        windowThis().removeEventListener("pointermove", move);
        latest = rangeAt(pointer);
        if (authoredTimelineRangesEqual(editable, latest)) {
          onPreview(null);
          return;
        }
        onCommitRange(interaction, latest);
      };
      windowThis().addEventListener("pointermove", move);
      windowThis().addEventListener("pointerup", finish, { once: true });
    };

  const keyboardEdit = (editMode: TimelineClipEditMode) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (timingLocked || !selected || !editable || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    const delta = (event.shiftKey ? 1 : 0.1) * (event.key === "ArrowRight" ? 1 : -1);
    onCommitRange(interaction, editAuthoredTimelineRange(editable, editMode, delta, window));
  };

  return (
    <div
      className="relative cursor-pointer overflow-hidden bg-black/15"
      data-testid={`interaction-row-${interaction.id}`}
      data-timeline-track="interaction"
      onContextMenu={onOpenContextMenu}
      style={{ gridColumn: 2, gridRow: row }}
    >
      <div className="contents" data-testid="interaction-track">
        <div className="absolute inset-x-0 top-1/2 h-px bg-white/[0.06]" />
        {deadlinePercent !== null ? (
          <span
            aria-label={`Trigger deadline by ${cue?.deadlineS}s`}
            className="pointer-events-none absolute inset-y-0 z-[5] w-px -translate-x-1/2 bg-amber-300/80 shadow-[0_0_6px_rgba(252,211,77,0.45)] before:absolute before:left-1/2 before:top-0 before:size-1 before:-translate-x-1/2 before:rounded-full before:bg-amber-200"
            data-testid={`timeline-trigger-deadline-${interaction.id}`}
            role="img"
            style={{ left: `${deadlinePercent}%` }}
            title={`Trigger deadline: by ${cue?.deadlineS}s`}
          />
        ) : null}
        <div
          className={`group/clip absolute inset-y-1 flex min-w-4 overflow-visible rounded-[3px] border ${
            routeNeedsSetup
              ? "animate-pulse border-red-300 bg-red-500/45 text-red-50 shadow-[0_0_12px_rgba(248,113,113,0.45)] motion-reduce:animate-none"
              : cue?.conflict === "conflict"
              ? "border-red-300 bg-red-400/25 text-red-50 shadow-[0_0_8px_rgba(252,165,165,0.2)]"
              : cue?.conflict === "possible"
                ? "border-amber-300/80 bg-amber-300/20 text-amber-50"
                : resolved.armed || !editable
              ? "border-dashed border-[#E8E044]/60 bg-[#E8E044]/15"
              : "border-[#E8E044]/80 bg-[#E8E044]/65 text-black"
          } ${selected ? "z-10 ring-1 ring-white" : ""}`}
          data-conflict={cue?.conflict ?? "none"}
          data-editable={editable && !timingLocked ? "true" : "false"}
          data-locked={timingLocked ? "true" : "false"}
          data-route-status={routeNeedsSetup ? "needs-setup" : simpleTimedRoute ? "configured" : undefined}
          data-timeline-interaction-id={interaction.id}
          data-testid={`timeline-interaction-clip-${interaction.id}`}
          style={{ left: `${start}%`, width: `${Math.max(0.6, end - start)}%` }}
          title={[
            label,
            timingHelp,
            conflictMessage,
            simpleTimedRoute
              ? routeNeedsSetup
                ? "Route setup required"
                : "Route timing is managed by Simple mode"
              : timingLocked
                ? "Timing is locked"
                : editable
                  ? endsWithScenario
                    ? "Drag its start; route continues to scenario end"
                    : "Drag or resize authored times"
                  : "Conditional or open timing is locked",
          ].filter(Boolean).join(" · ")}
        >
          {!timingLocked ? (
            <button
              aria-label={`Resize start of ${label}`}
              className="absolute -left-1.5 top-0 z-20 h-full w-3 cursor-col-resize touch-none rounded-l-sm bg-transparent before:absolute before:inset-y-1 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:rounded-full before:bg-white/60 before:opacity-0 before:transition-opacity hover:before:bg-[#E8E044] hover:before:opacity-100 focus-visible:outline-none focus-visible:before:bg-[#E8E044] focus-visible:before:opacity-100 group-hover/clip:before:opacity-100 disabled:cursor-not-allowed disabled:before:bg-white/25"
              data-testid={`timeline-resize-start-${interaction.id}`}
              data-timeline-seek-ignore="true"
              disabled={!editable}
              onKeyDown={keyboardEdit("resize-start")}
              onPointerDown={beginEdit("resize-start")}
              type="button"
            />
          ) : null}
          <button
            aria-controls={`scenario-interaction-${interaction.id}`}
            aria-expanded={selected}
            aria-label={simpleTimedRoute
              ? routeNeedsSetup
                ? "Configure route; setup required"
                : "Edit route"
              : timingLocked || !editable
                ? `Select ${label}; timing is locked`
                : `Select and move ${label}`}
            className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden px-2 text-[8px] font-medium disabled:pointer-events-none"
            data-testid={`interaction-expand-${interaction.id}`}
            disabled={readOnly}
            onClick={readOnly ? undefined : onSelect}
            onKeyDown={keyboardEdit("move")}
            onPointerDown={beginEdit("move")}
            type="button"
          >
            {cue ? (
              <span
                className="inline-flex h-3 shrink-0 items-center gap-0.5 rounded-sm border border-current/20 bg-black/15 px-0.5 text-[6px] font-semibold uppercase tracking-[0.04em]"
                data-cause={cue.cause}
                data-testid={`timeline-cause-${interaction.id}`}
                title={timingHelp}
              >
                {cue.cause === "time" ? (
                  <Clock3 aria-hidden="true" className="size-1.5" />
                ) : (
                  <Zap aria-hidden="true" className="size-1.5" />
                )}
                {timelineCauseLabel(cue.cause)}
              </span>
            ) : null}
            {(!editable || timingLocked) && !simpleTimedRoute ? (
              <Lock aria-hidden="true" className="size-2.5 shrink-0" />
            ) : null}
            <span className="truncate">{label}</span>
            {conflictMessage ? (
              <AlertTriangle
                aria-label={conflictMessage}
                className="ml-auto size-2.5 shrink-0"
                data-testid={`timeline-conflict-${interaction.id}`}
                role="img"
              />
            ) : null}
          </button>
          {!timingLocked && !endsWithScenario ? (
            <button
              aria-label={`Resize end of ${label}`}
              className="absolute -right-1.5 top-0 z-20 h-full w-3 cursor-col-resize touch-none rounded-r-sm bg-transparent before:absolute before:inset-y-1 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:rounded-full before:bg-white/60 before:opacity-0 before:transition-opacity hover:before:bg-[#E8E044] hover:before:opacity-100 focus-visible:outline-none focus-visible:before:bg-[#E8E044] focus-visible:before:opacity-100 group-hover/clip:before:opacity-100 disabled:cursor-not-allowed disabled:before:bg-white/25"
              data-testid={`timeline-resize-end-${interaction.id}`}
              data-timeline-seek-ignore="true"
              disabled={!editable}
              onKeyDown={keyboardEdit("resize-end")}
              onPointerDown={beginEdit("resize-end")}
              type="button"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ContextActionMenu({
  document,
  state,
  onAdd,
  onAddCanonical,
  onAddDirect,
  onClose,
}: {
  document: EditorDocument;
  state: ContextMenuState;
  onAdd: (role: Role, definitionId: string, timeS: number) => void;
  onAddCanonical: (interaction: Interaction) => void;
  onAddDirect: (role: Role, verb: "gap" | "exist", timeS: number) => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const role = document.data.roles.find((item) => item.id === state.actorId);
  const actions = role ? actionsForActor(role.actor.class, role.actor.catalogId) : [];
  const groups = groupContextActions(actions);
  const actorLabel = role
    ? timelineActorLabels(document.data.roles).get(role.id) ?? "Actor"
    : "Actor";
  const viewportWidth = windowThis().innerWidth;
  const viewportHeight = windowThis().innerHeight;
  const panelWidth = Math.min(520, Math.max(280, viewportWidth - 24));
  const left = Math.max(12, Math.min(state.anchorX - 24, viewportWidth - panelWidth - 12));
  const bottom = Math.max(12, viewportHeight - state.anchorY + 10);
  const maxHeight = Math.max(180, Math.min(460, state.anchorY - 24));

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    windowThis().addEventListener("keydown", closeOnEscape, true);
    globalThis.document.addEventListener("pointerdown", closeOutside, true);
    return () => {
      windowThis().removeEventListener("keydown", closeOnEscape, true);
      globalThis.document.removeEventListener("pointerdown", closeOutside, true);
    };
  }, [onClose]);

  if (!role) return null;
  return createPortal(
    <div
      ref={menuRef}
      aria-label={`Add interaction for ${actorLabel}`}
      className="fixed z-[90] overflow-y-auto rounded-2xl border border-white/15 bg-[linear-gradient(150deg,rgba(30,30,27,0.98),rgba(10,10,10,0.98))] p-3 text-white shadow-[0_24px_80px_rgba(0,0,0,0.72),0_0_0_1px_rgba(232,224,68,0.12)] backdrop-blur-2xl"
      data-placement="above"
      data-testid="timeline-context-menu"
      id="timeline-context-menu"
      role="menu"
      style={{ bottom, left, maxHeight, width: panelWidth }}
    >
      <header className="mb-3 flex items-start gap-3 border-b border-white/10 pb-2.5">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-[#E8E044]/30 bg-[#E8E044]/10 text-[#E8E044]">
          <Plus aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#E8E044]">
            Add at {state.timeS.toFixed(1)}s
          </p>
          <p className="mt-0.5 truncate text-xs text-white/60">{actorLabel}</p>
        </div>
        <button
          aria-label="Close action menu"
          className="grid size-7 place-items-center rounded-lg text-lg leading-none text-white/45 hover:bg-white/10 hover:text-white"
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </header>
      <div className="grid gap-2 sm:grid-cols-2">
        {groups.map((group) => (
          <ActionMenuGroup key={group.label} label={group.label}>
            {group.actions.map((action) => (
              <ActionMenuButton
                key={action.id}
                testId={`timeline-context-add-${action.id}`}
                onClick={() => onAdd(role, action.id, state.timeS)}
              >
                <span className="flex items-center gap-1.5">
                  {action.id === 'custom_route' ? <RouteIcon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
                  <span>{action.label}</span>
                </span>
              </ActionMenuButton>
            ))}
          </ActionMenuGroup>
        ))}
        <ActionMenuGroup label="Actor behavior">
          {gapPeerFor(role, document.data.roles) ? (
            <ActionMenuButton
              testId="action-palette-follow-gap"
              timelineAction="gap"
              onClick={() => onAddDirect(role, "gap", state.timeS)}
            >
              Follow gap
            </ActionMenuButton>
          ) : null}
          <ActionMenuButton
            testId="action-palette-become-absent"
            timelineAction="exist"
            onClick={() => onAddDirect(role, "exist", state.timeS)}
          >
            Become absent
          </ActionMenuButton>
        </ActionMenuGroup>
        <div className="sm:col-span-2">
          <CanonicalInteractionComposer
            document={document}
            interactions={document.data.choreography.interactions}
            otherRole={gapPeerFor(role, document.data.roles)}
            role={role}
            testIdPrefix="timeline-context-canonical"
            time={state.timeS}
            onAdded={(interaction) => {
              onAddCanonical(interaction);
              onClose();
            }}
          />
        </div>
      </div>
    </div>,
    globalThis.document.body,
  );
}

function groupContextActions(actions: readonly ActionDefinition[]) {
  const order = ["Speed", "Direction", "Routes", "Signals"];
  const labels = [
    ...order.filter((label) => actions.some((action) => action.group === label)),
    ...new Set(actions.map((action) => action.group).filter((label) => !order.includes(label))),
  ];
  return labels.map((label) => ({
    label,
    actions: actions.filter((action) => action.group === label),
  }));
}

function ActionMenuGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section
      aria-label={label}
      className="rounded-xl border border-white/10 bg-white/[0.035] p-2"
      data-testid={`timeline-context-group-${label.toLowerCase().replaceAll(" ", "-")}`}
      role="group"
    >
      <h3 className="mb-1.5 px-1 text-[9px] font-semibold uppercase tracking-[0.15em] text-white/40">
        {label}
      </h3>
      <div className="grid grid-cols-2 gap-1">{children}</div>
    </section>
  );
}

function ActionMenuButton({
  children,
  onClick,
  testId,
  timelineAction,
}: {
  children: React.ReactNode;
  onClick: () => void;
  testId?: string;
  timelineAction?: string;
}) {
  return (
    <button
      className="min-h-8 rounded-lg border border-transparent bg-black/20 px-2 py-1.5 text-left text-[10px] leading-tight text-white/70 hover:border-[#E8E044]/35 hover:bg-[#E8E044]/10 hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
      data-testid={testId}
      data-timeline-action={timelineAction}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      {children}
    </button>
  );
}

function TimelineActorCatalogIcon({ role }: { role: Role }) {
  const catalogId = catalogIdForRole(role);
  const className = "mt-0.5 h-3.5 w-6 shrink-0 text-[#E8E044]";
  if (catalogId && isVehicleTimelineCatalogId(catalogId)) {
    return (
      <span aria-hidden="true" className={className} data-testid={`timeline-actor-icon-${role.id}`}>
        <VehicleCatalogIcon id={catalogId} />
      </span>
    );
  }
  if (catalogId && isPedestrianTimelineCatalogId(catalogId)) {
    return (
      <span aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#E8E044]" data-testid={`timeline-actor-icon-${role.id}`}>
        <PedestrianCatalogIcon id={catalogId} />
      </span>
    );
  }
  if (catalogId && isObjectTimelineCatalogId(catalogId)) {
    return (
      <span aria-hidden="true" className={className} data-testid={`timeline-actor-icon-${role.id}`}>
        <ObjectCatalogIcon id={catalogId} />
      </span>
    );
  }
  if (catalogId && isDynamicActorCatalogId(catalogId)) {
    return (
      <span aria-hidden="true" className={className} data-testid={`timeline-actor-icon-${role.id}`}>
        <DynamicActorCatalogIcon id={catalogId} />
      </span>
    );
  }
  if (role.actor.class === "pedestrian") {
    return <PersonStanding aria-hidden="true" className="mt-0.5 size-3 shrink-0" data-testid={`timeline-actor-icon-${role.id}`} />;
  }
  if (role.actor.class === "static_object") {
    return <Box aria-hidden="true" className="mt-0.5 size-3 shrink-0" data-testid={`timeline-actor-icon-${role.id}`} />;
  }
  return <CarFront aria-hidden="true" className="mt-0.5 size-3 shrink-0" data-testid={`timeline-actor-icon-${role.id}`} />;
}

/** Display names shown on the timeline: catalog label plus a per-label ordinal. */
export function timelineActorLabels(roles: readonly Role[]): ReadonlyMap<string, string> {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const role of roles) {
    const base = timelineActorBaseLabel(role);
    const ordinal = (counts.get(base) ?? 0) + 1;
    counts.set(base, ordinal);
    labels.set(role.id, `${base} ${ordinal}`);
  }
  return labels;
}

function timelineActorBaseLabel(role: Role): string {
  const catalogId = catalogIdForRole(role);
  if (catalogId) {
    const entry = getEntry(catalogId);
    return entry.class === "pedestrian" ? "Pedestrian" : entry.label;
  }
  const semanticLabels: Partial<Record<Role["actor"]["class"], string>> = {
    bicycle: "Cyclist",
    bus: "Bus",
    car: "Car",
    motorcycle: "Motorcycle",
    pedestrian: "Pedestrian",
    scooter: "Scooter",
    static_object: "Object",
    truck: "Truck",
    van: "Van",
  };
  return semanticLabels[role.actor.class] ?? "Actor";
}

function catalogIdForRole(role: Role): CatalogId | null {
  const catalogId = role.actor.catalogId;
  return typeof catalogId === "string" && isCatalogId(catalogId) ? catalogId : null;
}

function isVehicleTimelineCatalogId(id: CatalogId): id is VehicleCatalogId {
  return (VEHICLE_CATALOG_IDS as readonly string[]).includes(id);
}

function isPedestrianTimelineCatalogId(id: CatalogId): id is PedestrianCatalogId {
  return (PEDESTRIAN_CATALOG_IDS as readonly string[]).includes(id);
}

function isObjectTimelineCatalogId(id: CatalogId): id is ObjectCatalogId {
  return (OBJECT_CATALOG_IDS as readonly string[]).includes(id);
}

function clampTime(timeS: number, window: TimelineRange): number {
  return Math.min(window.endMs / 1000, Math.max(window.startMs / 1000, timeS));
}

function gapPeerFor(role: Role, roles: readonly Role[]): Role | null {
  return (
    roles.find(
      (candidate) =>
        candidate.id !== role.id &&
        !candidate.actor.static,
    ) ?? null
  );
}

/** Indirection keeps the prop named `window` from shadowing the browser global in clip helpers. */
function windowThis(): Window {
  return globalThis.window;
}
