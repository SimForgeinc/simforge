/**
 * The editor's interaction state machine.
 *
 * Framework-free on purpose: React renders panels, this owns the pointer, the
 * keyboard, the three.js objects and the document. Panels read
 * {@link EditorController.state} and call methods; nothing in a render path
 * touches the scene graph, and a ghost tracking the cursor never depends on a
 * React commit.
 *
 * ## Sharing input with the camera
 *
 * `CameraRig` listens on the canvas. Listeners on the *same* element fire in
 * registration order regardless of the capture flag, so "register later and stop
 * propagation" does not work. Instead every listener here is registered on the
 * canvas's **parent** in the capture phase, which by DOM ordering runs before
 * anything on the canvas — so the editor can consume an event (placement click,
 * gizmo drag, lateral scroll) or let it through to the camera (orbit drag, zoom)
 * on a case-by-case basis.
 *
 * The division that makes the tool feel right:
 *
 * | gesture | owner |
 * |---|---|
 * | left click, no drag | editor (select or place) |
 * | left drag on empty map | editor (marquee selection) |
 * | middle drag | camera (ground-plane pan) |
 * | right drag | camera (orbit), including while a placement ghost is active |
 * | wheel | camera, except lateral nudge while lane-snapped |
 * | any pointer while in a modal mode (`G`/`R`/placing) | editor |
 *
 * ## Modal editing
 *
 * `G` and `R` are modes, not drags: press, move, click to confirm, `Esc` to
 * cancel — the Blender contract. While a mode is live the affected actors are
 * drawn from a preview overlay rather than from the document, so a 40-actor
 * drag writes exactly one undo entry at the end instead of one per frame.
 */

import { Raycaster, Vector2, Vector3 } from 'three';
import { getViewerSurfaceRect, type EditorViewer } from './viewer-contract';
import { getEntry, type CatalogId } from '@simforge-oss/asset-catalog';
import type { Interaction, ScenarioTemplateV2 } from '@simforge-oss/scenario';
import type { SceneTrace, SimScenarioInput } from '@simforge-oss/engine';
import { ActorRenderer, type ActorView } from '@simforge-oss/viewer';
import { GhostActor } from './ghostActor';
import { interactionDraftId } from './interaction-palette';
import { resolveVehicleDrop, RESNAP_RADIUS_M, type DropOutcome } from './drop-resolver';
import type { ScreenRect } from './marquee';
import {
  type GroupPlacementActor,
  type GroupPlacementPose,
} from './group-placement';

import {
  actorKindFor,
  type ActorRecord,
  type ActorUpdate,
  type EditorDocument,
  type LaneAnchor,
  type NewActor,
} from './document';
import {
  advanceAlongTravel,
  headingDelta,
  normalizeHeading,
  type IndexedLane,
  type LaneIndex
} from './laneIndex';
import { VehicleRouteOverlayRenderer } from './routeOverlay';

/**
 * Screen-space radius, in pixels, within which clicking the last drawn point of a
 * timed route repeats it as a one-second wait instead of adding a new position.
 */
const ROUTE_WAIT_SNAP_PX = 5;

/** Ground-ray projection across an actor body still represents the actor seed. */
const ROUTE_POINT_COINCIDENCE_EPSILON_M = 0.3;


export type EditorMode = 'idle' | 'placing' | 'grab' | 'rotate' | 'drawingRoute';
export type CustomRouteTool = 'add' | 'move';

/** Everything the panels render from. Replaced wholesale on every change. */
export interface EditorState {
  /** Exact EditorDocument revision represented by this snapshot. */
  readonly revision: number;
  readonly name: string;
  readonly mode: EditorMode;
  readonly actors: readonly ActorRecord[];
  readonly selection: readonly string[];
  /** Catalog id currently being placed. */
  readonly placing: CatalogId | null;
  /** Lane snapping is active for the current ghost or directly moved actor. */
  readonly snapped: boolean;
  /** Lateral nudge inside the lane, metres, positive to the left. */
  readonly lateral: number;
  /** Tab has flipped the ghost to the opposing lane. */
  readonly flipped: boolean;
  /** Ghost placement is legal. */
  readonly valid: boolean;
  /** Non-blocking route warning for the lane under the placement ghost. */
  readonly placementWarning: string | null;
  /** Whether Shift was held for the most recent successful catalog placement. */
  readonly placementSticky: boolean;
  readonly customRoutePointCount: number;
  readonly customRouteTool: CustomRouteTool | null;
  readonly customRouteSelectedPointIndex: number | null;
  /** One-line status hint: mode plus the modifiers that apply to it. */
  readonly hint: string;
  /** Transient feedback (a refused placement, a broken anchor). */
  readonly message: string | null;
  /** Live yaw readout while rotating, degrees. */
  readonly rotationDeg: number | null;
  /** Lane under the ghost / selection, for the status bar. */
  readonly laneLabel: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirty: boolean;
  readonly savedAt: number | null;
  /**
   * Aggregate commit feedback for the in-flight move: `snapped` (green) means
   * every road vehicle re-anchors on drop, `free` (amber) means at least one
   * lands unanchored, `invalid` (red) means the drop is refused (overlap).
   */
  readonly dropOutcome: DropOutcome | null;
}

/** Live pose overrides used while a modal gesture is in flight. */
interface PosePatch {
  x: number;
  y: number;
  z: number;
  headingRad: number;
  laneRef?: LaneAnchor | null;
  routeLaneRsls?: readonly string[] | null;
}

interface GrabSession {
  origin: Map<string, ActorRecord>;
  start: Vector3;
  direct: boolean;
  valid: boolean;
  reason: string | null;
  headingOffsetRad: number;
  /** Live resolver verdict for the whole moving set. */
  outcome: DropOutcome;
}

interface DirectMovePress {
  pointerId: number;
  actorId: string;
  startGround: Vector3;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RotateSession {
  origin: Map<string, ActorRecord>;
  centerX: number;
  centerZ: number;
  startAngle: number;
  delta: number;
}

interface GhostPose {
  x: number;
  y: number;
  z: number;
  headingRad: number;
  laneRef: LaneAnchor | null;
  laneLabel: string | null;
  valid: boolean;
  reason: string | null;
  warning?: string | null;
}

interface GroupPlacementSession {
  readonly actors: readonly GroupPlacementActor[];
  readonly onCommit: (poses: readonly GroupPlacementPose[]) => void;
  poses: readonly GroupPlacementPose[];
  valid: boolean;
  blockerId: string | null;
}

interface VehicleSnapOptions {
  /** Explicit authoring offset retained within the selected lane. */
  lateralM?: number;
  /** Select the nearest genuinely opposing travel lane (palette Tab action). */
  opposingToHeadingRad?: number;
  /** Heading used only by the red invalid ghost when no lane is nearby. */
  fallbackHeadingRad?: number;
}

export interface EditorControllerOptions {
  viewer: EditorViewer;
  laneIndex: LaneIndex;
  document: EditorDocument;
  /** Persistent workspace renderer. Standalone editors omit it and own one locally. */
  renderer?: ActorRenderer;
  /** Ground height in scene metres, or `null` off the map. */
  sampleHeight: (x: number, z: number) => number | null;
}

/** How far from the cursor the snapper will look for a lane, metres. */
const SNAP_RADIUS_M = 30;

const _ndc = new Vector2();
const _origin = new Vector3();
const _direction = new Vector3();

export abstract class EditorControllerCommands {
  readonly renderer: ActorRenderer;
  readonly routeRenderer: VehicleRouteOverlayRenderer;
  /** Public so tooling (and the verification harness) can query lane geometry. */
  readonly laneIndex: LaneIndex;
  readonly doc: EditorDocument;

  protected readonly viewer: EditorViewer;
  private readonly ownsRenderer: boolean;
  protected readonly sampleHeight: (x: number, z: number) => number | null;
  protected readonly ghost = new GhostActor();
  protected readonly raycaster = new Raycaster();
  protected readonly listeners = new Set<() => void>();

  protected host: HTMLElement | null = null;
  protected unbindDoc: (() => void) | null = null;

  protected mode: EditorMode = 'idle';
  protected selection: string[] = [];
  protected placing: CatalogId | null = null;
  protected placingKind: 'vehicle' | 'pedestrian' | null = null;
  protected pendingActorId: string | null = null;
  protected lateral = 0;
  protected flipped = false;
  protected ghostPose: GhostPose | null = null;
  protected placementSticky = false;
  protected groupPlacement: GroupPlacementSession | null = null;
  protected groupGhosts: GhostActor[] = [];
  protected preview = new Map<string, PosePatch>();
  /** Completed fixed-step run for the current committed document revision. */
  protected simulationPreview: {
    readonly input: Pick<SimScenarioInput, 'actors' | 'interactions' | 'nearMissCriteria'>;
    readonly trace: SceneTrace;
  } | null = null;
  protected grab: GrabSession | null = null;
  protected directPress: DirectMovePress | null = null;
  /** Armed on empty-ground left press; becomes a live marquee past the slop. */
  protected marqueePress: {
    pointerId: number;
    x: number;
    y: number;
    shiftKey: boolean;
    ctrlKey: boolean;
  } | null = null;
  /** Live marquee rectangle in client coordinates; null while not dragging. */
  protected marqueeRect: ScreenRect | null = null;
  protected rotate: RotateSession | null = null;
  protected message: string | null = null;
  protected messageTimer: ReturnType<typeof setTimeout> | null = null;
  protected customRouteDraft: {
    interactionId: string;
    points: Array<{ x: number; z: number; timeS?: number }>;
    timed: boolean;
    cursor: { x: number; z: number } | null;
    removeOnCancel: boolean;
    seedLocked: boolean;
    tool: CustomRouteTool;
    selectedPointIndex: number | null;
    draggingPointIndex: number | null;
  } | null = null;

  /** Pointer bookkeeping for the click-vs-drag discrimination. */
  protected pressX = 0;
  protected pressY = 0;
  protected pressButton = -1;
  protected pressMoved = false;
  protected headingDrag: { x: number; z: number } | null = null;
  protected freeHeading = 0;
  protected placementHeadingOffsetRad = 0;
  protected placingFreeformStatic = false;
  protected altDown = false;
  protected shiftDown = false;
  protected lastGroundY = 0;
  protected notifyHandle = 0;
  protected frameHandle = 0;
  /** False for every non-authoring session state. This is the capability gate,
   * not a cosmetic UI flag: all document-changing commands return at this boundary. */
  protected authoringEnabled = true;

  protected snapshot: EditorState;

  constructor(options: EditorControllerOptions) {
    this.viewer = options.viewer;
    this.renderer = options.renderer ?? new ActorRenderer();
    this.ownsRenderer = !options.renderer;
    this.laneIndex = options.laneIndex;
    this.doc = options.document;
    this.sampleHeight = options.sampleHeight;
    this.routeRenderer = new VehicleRouteOverlayRenderer(options.sampleHeight);
    if (this.ownsRenderer) this.viewer.scene.add(this.renderer.group);
    this.viewer.scene.add(this.routeRenderer.group);
    this.viewer.scene.add(this.ghost.group);
    this.unbindDoc = this.doc.subscribe(() => {
      // A trajectory from the previous revision is misleading as soon as the
      // document changes. The workspace worker will publish the replacement
      // after it has completed the same simulation that powers Play.
      this.simulationPreview = null;
      this.syncScene();
      // Document edits are already gesture-coalesced. Publish them immediately
      // so timeline edits update route previews before autosave/materialization.
      this.publish();
    });
    this.snapshot = this.buildState();
    this.syncScene();
  }

  // ------------------------------------------------------------ React glue

  get state(): EditorState {
    return this.snapshot;
  }

  /** Immutable template view used only to draw in-flight route previews. */
  get authoringPreviewData(): ScenarioTemplateV2 {
    const data = this.doc.data;
    if (this.preview.size === 0) return data;
    return {
      ...data,
      roles: data.roles.map((role) => {
        const patch = this.preview.get(role.id);
        if (!patch || role.kind !== 'scene_absolute') return role;
        const next = {
          ...role,
          pose: {
            position: { x: patch.x, y: patch.y, z: patch.z },
            headingRad: patch.headingRad
          }
        };
        if (patch.laneRef === null) delete next.laneRef;
        else if (patch.laneRef !== undefined) next.laneRef = patch.laneRef;
        if (patch.routeLaneRsls === null) delete next.initialRoute;
        else if (patch.routeLaneRsls !== undefined) {
          next.initialRoute = { mode: 'lanePath', lanes: [...patch.routeLaneRsls] };
        }
        return next;
      })
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): EditorState => this.snapshot;

  /** Install the completed background run used by both the overlay and Play. */
  setSimulationPreview(preview: {
    readonly input: Pick<SimScenarioInput, 'actors' | 'interactions' | 'nearMissCriteria'>;
    readonly trace: SceneTrace;
  } | null): void {
    this.simulationPreview = preview;
    this.syncScene();
  }

  setAuthoringEnabled(enabled: boolean): void {
    if (this.authoringEnabled === enabled) return;
    this.authoringEnabled = enabled;
    if (!enabled) {
      this.cancelModal();
      this.placing = null;
    }
    this.notify();
  }

  get canAuthor(): boolean {
    return this.authoringEnabled;
  }

  /** Hide authoring actors/input while the shared physics trace is inspected. */
  setPlaybackInspection(active: boolean): void {
    this.setAuthoringEnabled(!active);
    this.renderer.setLayerVisible('editor', !active);
    this.routeRenderer.group.visible = !active;
    this.ghost.group.visible = !active;
    if (active) this.renderer.setSelection([]);
    if (!active) this.syncScene();
  }

  /** Mode visibility uses the same capability boundary without disposing runtime state. */
  setPresentationActive(active: boolean): void {
    this.setPlaybackInspection(!active);
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Bind input.
   *
   * @param host The element *containing* the canvas — see the module docs on
   *   why listeners cannot live on the canvas itself.
   */
  attach(host: HTMLElement): void {
    this.detach();
    this.host = host;
    host.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    host.addEventListener('pointermove', this.onPointerMove, { capture: true });
    host.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    host.addEventListener('contextmenu', this.onContextMenu, { capture: true });
    window.addEventListener('pointerup', this.onPointerUp, { capture: true });
    window.addEventListener('pointercancel', this.onPointerCancel, { capture: true });
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('keyup', this.onKeyUp, { capture: true });
  }

  detach(): void {
    const host = this.host;
    if (!host) return;
    host.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    host.removeEventListener('pointermove', this.onPointerMove, { capture: true });
    host.removeEventListener('wheel', this.onWheel, { capture: true });
    host.removeEventListener('contextmenu', this.onContextMenu, { capture: true });
    window.removeEventListener('pointerup', this.onPointerUp, { capture: true });
    window.removeEventListener('pointercancel', this.onPointerCancel, { capture: true });
    window.removeEventListener('keydown', this.onKeyDown, { capture: true });
    window.removeEventListener('keyup', this.onKeyUp, { capture: true });
    this.endDirectPress();
    this.clearMarquee();
    this.host = null;
  }

  dispose(): void {
    this.detach();
    if (this.messageTimer !== null) clearTimeout(this.messageTimer);
    if (this.notifyHandle) cancelAnimationFrame(this.notifyHandle);
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.unbindDoc?.();
    this.unbindDoc = null;
    this.clearGroupGhosts();
    if (this.ownsRenderer) this.renderer.dispose();
    else {
      this.renderer.clearLayer('editor');
      this.renderer.setSelection([]);
    }
    this.routeRenderer.dispose();
    this.listeners.clear();
  }

  // ---------------------------------------------------------- commands (UI)

  /**
   * Enter cursor-attached free-form placement for an actor group.
   *
   * This deliberately shares the ordinary `placing` input mode and GhostActor
   * rendering, but never asks the lane resolver: the exact green preview poses
   * are the poses delivered to `onCommit`. A red overlapping preview refuses
   * the click, and Escape cancels without invoking the callback.
   */
  beginGroupPlacement(
    actors: readonly GroupPlacementActor[],
    onCommit: (poses: readonly GroupPlacementPose[]) => void,
  ): boolean {
    if (!this.authoringEnabled || actors.length === 0) return false;
    this.cancelModal();
    this.mode = 'placing';
    this.placing = null;
    this.placingKind = null;
    this.placementSticky = false;
    this.groupPlacement = {
      actors: actors.map((actor) => ({ ...actor })),
      onCommit,
      poses: [],
      valid: false,
      blockerId: null,
    };
    this.groupGhosts = actors.map((actor) => {
      const ghost = new GhostActor();
      this.viewer.scene.add(ghost.group);
      ghost.show(actor.catalogId);
      ghost.hide();
      return ghost;
    });
    this.notify();
    return true;
  }
  protected clearGroupGhosts(): void {
    for (const ghost of this.groupGhosts) ghost.dispose();
    this.groupGhosts = [];
    this.groupPlacement = null;
  }

  /** Enter placement mode with a catalog item, or leave it if it is already active. */

  togglePlacement(catalogId: CatalogId, options: { freeformStatic?: boolean } = {}): void {
    if (!this.authoringEnabled) return;
    const freeformStatic = Boolean(options.freeformStatic);
    if (this.mode === 'placing' && this.placing === catalogId && this.placingFreeformStatic === freeformStatic) {
      this.cancel();
      return;
    }
    this.cancelModal();
    this.placingFreeformStatic = freeformStatic;
    this.placementSticky = false;
    this.placingKind = null;
    this.pendingActorId = null;
    this.mode = 'placing';
    this.placing = catalogId;
    this.lateral = 0;
    this.flipped = false;
    this.placementHeadingOffsetRad = 0;
    this.ghost.show(catalogId);
    this.ghost.hide(); // stays hidden until the cursor is over the map
    this.notify();
  }

  /** Arm one human-level actor tool; the concrete appearance is stable per actor. */
  togglePlacementKind(kind: 'vehicle' | 'pedestrian'): void {
    if (!this.authoringEnabled) return;
    if (this.mode === 'placing' && this.placingKind === kind) {
      this.cancel();
      return;
    }
    this.cancelModal();
    this.mode = 'placing';
    this.placingKind = kind;
    this.prepareRandomActorAppearance(kind);
    this.lateral = 0;
    this.flipped = false;
    this.placementHeadingOffsetRad = 0;
    this.notify();
  }

  /** Change only appearance in one undoable document gesture. */
  updateActorAppearance(id: string, patch: { catalogId?: CatalogId; bodyColor?: string; initialSpeedKph?: number; driverProfile?: ActorUpdate['driverProfile']; static?: boolean }): void {
    if (!this.authoringEnabled) return;
    const actor = this.doc.actor(id);
    if (!actor) return;
    if (patch.catalogId && actorKindFor(patch.catalogId) !== actor.kind) return;
    this.doc.update([{ id, ...patch }]);
  }

  /** Leave whatever mode is active; from idle, clear the selection. */
  cancel(): void {
    if (this.mode === 'idle') {
      if (this.selection.length > 0) this.setSelection([]);
      return;
    }
    if (this.mode === 'drawingRoute') this.cancelCustomRouteAuthoring();
    else this.cancelModal();
    this.notify();
  }

  /** Enter the map tool used by a first-class custom-route timeline clip. */
  beginCustomRouteAuthoring(interactionId: string, options: {
    reset?: boolean;
    removeOnCancel?: boolean;
    startPose?: { x: number; z: number; headingRad: number };
  } = {}): boolean {
    if (!this.authoringEnabled) return false;
    const interaction = this.doc.data.choreography.interactions.find((item) => item.id === interactionId);
    if (interaction?.verb !== 'route' || (interaction.target.mode !== 'customRoute' && interaction.target.mode !== 'customTimedRoute')) return false;
    this.cancelModal();
    const actor = this.doc.actor(interaction.actor);
    const startPose = options.startPose;
    if (actor && startPose) {
      this.preview.set(actor.id, {
        x: startPose.x,
        y: this.groundY(startPose.x, startPose.z, actor.y),
        z: startPose.z,
        headingRad: startPose.headingRad,
        laneRef: null,
        routeLaneRsls: null,
      });
    }
    this.mode = 'drawingRoute';
    this.customRouteDraft = {
      interactionId,
      timed: interaction.target.mode === 'customTimedRoute',
      points: startPose
        ? [{ x: Number(startPose.x.toFixed(3)), z: Number(startPose.z.toFixed(3)) }]
        : options.reset ? [] : interaction.target.points.map((point) => ({ ...point })),
      cursor: null,
      removeOnCancel: options.removeOnCancel ?? false,
      seedLocked: Boolean(startPose),
      tool: startPose || options.reset ? 'add' : 'move',
      selectedPointIndex: null,
      draggingPointIndex: null,
    };
    this.selection = [interaction.actor];
    this.syncCustomRouteDraft();
    this.syncScene();
    this.notify();
    return true;
  }

  finishCustomRouteAuthoring(): boolean {
    const draft = this.customRouteDraft;
    if (!draft) {
      this.flash('Place at least two route points');
      return false;
    }
    const cursor = draft.cursor
      ? { x: Number(draft.cursor.x.toFixed(3)), z: Number(draft.cursor.z.toFixed(3)) }
      : null;
    const previous = draft.points.at(-1);
    if (cursor && draft.points.length < 128 && (!previous || Math.hypot(previous.x - cursor.x, previous.z - cursor.z) >= 0.1)) {
      draft.points.push(cursor);
    }
    if (draft.points.length < 2) {
      this.flash('Place at least two route points');
      return false;
    }
    const interaction = this.doc.data.choreography.interactions.find((item) => item.id === draft.interactionId);
    if (interaction?.verb !== 'route' || (interaction.target.mode !== 'customRoute' && interaction.target.mode !== 'customTimedRoute')) return false;
    this.commitCustomRouteDraft(interaction);
    draft.cursor = null;
    draft.removeOnCancel = false;
    draft.seedLocked = false;
    draft.tool = 'move';
    draft.selectedPointIndex = null;
    draft.draggingPointIndex = null;
    this.syncCustomRouteDraft();
    this.syncScene();
    this.notify();
    return true;
  }

  setCustomRouteTool(tool: CustomRouteTool): void {
    const draft = this.customRouteDraft;
    if (!draft) return;
    draft.tool = tool;
    draft.cursor = null;
    draft.selectedPointIndex = null;
    draft.draggingPointIndex = null;
    this.viewer.controls.setEnabled(true);
    this.syncCustomRouteDraft();
    this.notify();
  }

  deleteSelectedCustomRoutePoint(): void {
    const draft = this.customRouteDraft;
    const index = draft?.selectedPointIndex;
    if (!draft || index === null || index === undefined || index < 0) return;
    if (draft.points.length <= 2) {
      this.flash('A route needs at least two points');
      return;
    }
    draft.points.splice(index, 1);
    draft.selectedPointIndex = Math.min(index, draft.points.length - 1);
    const interaction = this.doc.data.choreography.interactions.find((item) => item.id === draft.interactionId);
    if (interaction?.verb === 'route' && (interaction.target.mode === 'customRoute' || interaction.target.mode === 'customTimedRoute')) {
      this.commitCustomRouteDraft(interaction);
    }
    this.syncCustomRouteDraft();
    this.syncScene();
    this.notify();
  }

  protected commitCustomRouteDraft(interaction: Extract<ScenarioTemplateV2['choreography']['interactions'][number], { verb: 'route' }>): void {
    const draft = this.customRouteDraft;
    if (!draft) return;
    const triggerStartS = interaction.trigger.kind === 'at' && typeof interaction.trigger.t === 'number'
      ? interaction.trigger.t
      : 0;
    let previousTimeS = triggerStartS - 1;
    this.doc.replaceInteraction(interaction.id, {
      ...interaction,
      target: draft.timed
        ? {
            mode: 'customTimedRoute',
            points: draft.points.map((point) => {
              const timeS = typeof point.timeS === 'number' ? point.timeS : previousTimeS + 1;
              previousTimeS = timeS;
              return { timeS: Number(timeS.toFixed(3)), x: point.x, z: point.z };
            }),
          }
        : { mode: 'customRoute', points: draft.points.map(({ x, z }) => ({ x, z })) },
    });
  }

  removeLastCustomRoutePoint(): void {
    if (!this.customRouteDraft?.points.length) return;
    if (this.customRouteDraft.seedLocked && this.customRouteDraft.points.length === 1) return;
    this.customRouteDraft.points.pop();
    this.syncCustomRouteDraft();
    this.notify();
  }

  protected cancelCustomRouteAuthoring(): void {
    const draft = this.customRouteDraft;
    this.customRouteDraft = null;
    this.mode = 'idle';
    this.preview.clear();
    this.routeRenderer.setDraftRoute(null);
    if (draft?.removeOnCancel) this.doc.removeInteraction(draft.interactionId);
    this.syncScene();
  }

  /**
   * Place one drawn route point at the end of the path.
   *
   * Drawing only ever appends. Measuring the click against every existing
   * segment and splicing it in when it landed within a metre or so of one
   * cannot work: that distance is computed from a projection clamped to the
   * segment's ends, and past the final vertex it is just the stride length, so
   * every stride shorter than the radius reads as a mid-path click. A straight
   * path's segments are collinear and the earliest wins the tie, so each new
   * point lands behind the first and the path draws itself backwards — worst on
   * walkers, whose strides are shorter than the radius. A point in the wrong
   * place is moved by dragging its handle, which acts on the point itself
   * instead of guessing intent from proximity.
   *
   * ## Clicking the last point again is a wait, on timed routes only
   *
   * Two keyframes on one spot is how an author writes a dwell, so a click
   * within a few pixels of the last point's screen position repeats that point
   * exactly rather than sampling the ground under the cursor. The test is in
   * screen space on purpose: at a grazing camera angle the ground point a few
   * pixels away is tens of metres away, so a world-space radius would either
   * miss the gesture or swallow deliberate nearby steps. An untimed route has
   * no time axis and therefore no dwell to express, so it never snaps.
   */
  protected addCustomRoutePoint(point: Vector3, event?: { clientX: number; clientY: number }): void {
    const draft = this.customRouteDraft;
    if (!draft || draft.points.length >= 128) return;
    const latest = draft.points.at(-1);
    const bounds = getViewerSurfaceRect(this.viewer);
    const projected = latest
      ? new Vector3(
          latest.x,
          (this.sampleHeight(latest.x, latest.z) ?? this.lastGroundY) + .1,
          latest.z,
        ).project(this.viewer.camera)
      : null;
    const latestClientX = projected ? bounds.left + (projected.x + 1) * bounds.width / 2 : Infinity;
    const latestClientY = projected ? bounds.top + (1 - projected.y) * bounds.height / 2 : Infinity;
    const waiting = Boolean(
      draft.timed && latest && event && projected && projected.z >= -1 && projected.z <= 1
      && Math.hypot(event.clientX - latestClientX, event.clientY - latestClientY) <= ROUTE_WAIT_SNAP_PX,
    );
    const next = waiting
      ? { x: latest!.x, z: latest!.z }
      : { x: Number(point.x.toFixed(3)), z: Number(point.z.toFixed(3)) };
    draft.points.push(next);
    this.syncCustomRouteDraft();
    this.notify();
  }

  protected updateCustomRouteCursor(point: Vector3 | null): void {
    const draft = this.customRouteDraft;
    if (!draft) return;
    const cursor = point ? { x: point.x, z: point.z } : null;
    const latest = draft.points.at(-1);
    draft.cursor = cursor && latest
      && Math.hypot(cursor.x - latest.x, cursor.z - latest.z) <= ROUTE_POINT_COINCIDENCE_EPSILON_M
      ? null
      : cursor;
    this.syncCustomRouteDraft();
  }

  protected syncCustomRouteDraft(): void {
    const draft = this.customRouteDraft;
    if (!draft) {
      this.routeRenderer.setDraftRoute(null);
      return;
    }
    const interaction = this.doc.data.choreography.interactions.find((item) => item.id === draft.interactionId);
    const triggerStartS = interaction?.trigger.kind === 'at' && typeof interaction.trigger.t === 'number'
      ? interaction.trigger.t
      : 0;
    this.routeRenderer.setDraftRoute(
      [...draft.points, ...(draft.tool === 'add' && draft.cursor && draft.points.length ? [draft.cursor] : [])],
      {
        // A run of points on one spot is a wait, and labelling each of them with
        // its own second stacks unreadable text on a single marker. Label the
        // run once, on its last point, with the span it covers; the earlier
        // members render nothing.
        timeLabels: draft.timed
          ? draft.points.map((point, index) => {
              let runStart = index;
              let runEnd = index;
              while (
                runStart > 0
                && Math.hypot(point.x - draft.points[runStart - 1]!.x, point.z - draft.points[runStart - 1]!.z) <= 1e-6
              ) runStart--;
              while (
                runEnd + 1 < draft.points.length
                && Math.hypot(point.x - draft.points[runEnd + 1]!.x, point.z - draft.points[runEnd + 1]!.z) <= 1e-6
              ) runEnd++;
              if (index !== runEnd) return '';
              const startTimeS = Number((draft.points[runStart]!.timeS ?? triggerStartS + runStart).toFixed(3));
              const endTimeS = Number((draft.points[runEnd]!.timeS ?? triggerStartS + runEnd).toFixed(3));
              return runStart === runEnd ? `${endTimeS}s` : `${startTimeS}–${endTimeS}s`;
            })
          : undefined,
        selectedPointIndex: draft.selectedPointIndex,
        // A timed route's 0th point is where the simulation starts the actor, which
        // makes it the actor's position rather than a waypoint of its own.
        pinnedPointIndex: draft.timed ? 0 : null,
        committedPointCount: draft.points.length,
      },
    );
  }

  setSelection(ids: readonly string[]): void {
    this.selection = [...new Set(ids)].filter((id) => this.doc.actor(id));
    this.syncScene();
    this.notify();
  }

  /** Deliberate, name-click-only camera framing. Timeline row controls never call this. */
  frameActor(id: string, materializedActor?: ActorView): void {
    const actor = this.doc.actor(id) ?? (materializedActor?.id === id ? materializedActor : undefined);
    if (!actor) return;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    const from = this.viewer.controls.getView();
    const startPosition = new Vector3(...from.position);
    const startTarget = new Vector3(...from.target);
    const target = new Vector3(actor.x, actor.y + actor.dims.h * 0.5, actor.z);
    const direction = startPosition.clone().sub(startTarget);
    if (direction.lengthSq() < 0.001) direction.set(1, 0.8, 1);
    const distance = Math.max(14, Math.min(42, Math.max(actor.dims.l, actor.dims.h) * 4.5));
    const destination = target.clone().add(direction.normalize().multiplyScalar(distance));
    const startedAt = performance.now();
    const tick = (now: number): void => {
      const linear = Math.min(1, (now - startedAt) / 320);
      const eased = 1 - Math.pow(1 - linear, 3);
      this.viewer.controls.setView(
        startPosition.clone().lerp(destination, eased),
        startTarget.clone().lerp(target, eased),
      );
      if (linear < 1) this.frameHandle = requestAnimationFrame(tick);
      else this.frameHandle = 0;
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  selectAll(): void {
    this.setSelection(this.doc.actors.map((a) => a.id));
  }

  deleteSelection(): void {
    if (!this.authoringEnabled) return;
    if (this.selection.length === 0) return;
    const n = this.selection.length;
    this.doc.remove(this.selection);
    this.selection = [];
    this.flash(`deleted ${n} actor${n === 1 ? '' : 's'}`);
  }

  /**
   * Copy the selection one body-length upstream.
   *
   * "Upstream" is along the lane when the actor is anchored (so a duplicated car
   * lands in its own lane behind itself, ready to become a queue) and along its
   * own heading otherwise. Pedestrians and props use a flat 2 m, since their
   * body length is not a meaningful spacing.
   */
  duplicateSelection(options: { drag?: boolean } = {}): void {
    if (!this.authoringEnabled) return;
    if (this.selection.length === 0) return;
    const inputs: NewActor[] = [];
    const interactions: Interaction[] = [];
    const clipSeconds = this.doc.data.choreography.clipSeconds;
    for (const id of this.selection) {
      const actor = this.doc.actor(id);
      if (!actor) continue;
      const newId = this.doc.allocateActorId(actor.catalogId);
      const gap = actor.kind === 'vehicle' ? actor.dims.l + 1 : 2;
      const lane = actor.laneRef ? this.laneFor(actor.laneRef) : null;
      const shared: Pick<NewActor, 'id' | 'catalogId' | 'label' | 'bodyColor' | 'initialSpeedKph' | 'driverProfile' | 'static'> = {
        id: newId,
        catalogId: actor.catalogId,
        ...(actor.label === undefined ? {} : { label: actor.label }),
        ...(actor.bodyColor === undefined ? {} : { bodyColor: actor.bodyColor }),
        ...(actor.initialSpeedKph === undefined ? {} : { initialSpeedKph: actor.initialSpeedKph }),
        ...(actor.driverProfile === undefined ? {} : { driverProfile: actor.driverProfile }),
        ...(actor.static === undefined ? {} : { static: actor.static }),
      };
      let dx: number;
      let dz: number;
      if (lane && actor.laneRef) {
        const s = advanceAlongTravel(lane, actor.laneRef.s, -gap);
        const pose = this.laneIndex.poseAt(lane, s, actor.laneRef.t);
        dx = pose.x - actor.x;
        dz = pose.z - actor.z;
        inputs.push({
          ...shared,
          x: pose.x,
          y: this.groundY(pose.x, pose.z, actor.y),
          z: pose.z,
          headingRad: normalizeHeading(pose.headingRad + actor.laneRef.headingOffsetRad),
          laneRef: { ...actor.laneRef, s }
        });
      } else {
        dx = -Math.cos(actor.headingRad) * gap;
        dz = Math.sin(actor.headingRad) * gap;
        const x = actor.x + dx;
        const z = actor.z + dz;
        inputs.push({
          ...shared,
          x,
          y: this.groundY(x, z, actor.y),
          z,
          headingRad: actor.headingRad
        });
      }
      interactions.push(...this.cloneOwnedRouteClips(actor.id, newId, dx, dz, clipSeconds));
    }
    const ids = this.doc.addWithInteractions(inputs, interactions);
    this.setSelection(ids);
    this.flash(`duplicated ${ids.length}`);
    // Duplicate-and-drag: the copies follow the cursor until the click commits.
    if (options.drag && this.lastGroundPoint) this.beginGrab();
  }

  /**
   * Clone the route clips one actor owns onto its copy, translated rigidly by
   * the duplicate/paste offset.
   *
   * A timed route is normalized full-width (`trigger` at 0, `until` at the
   * clip end) so the copy satisfies the timeline's exclusive full-width
   * contract for custom timed routes on its own actor.
   */
  protected cloneOwnedRouteClips(
    sourceActorId: string,
    newActorId: string,
    dx: number,
    dz: number,
    clipSeconds: number,
  ): Interaction[] {
    const clones: Interaction[] = [];
    let ordinal = 0;
    for (const interaction of this.doc.data.choreography.interactions) {
      if (interaction.actor !== sourceActorId || interaction.verb !== 'route') continue;
      const target = interaction.target;
      if (target.mode !== 'customRoute' && target.mode !== 'customTimedRoute') continue;
      const points = target.points.map((point) => ({
        ...point,
        x: Number((point.x + dx).toFixed(3)),
        z: Number((point.z + dz).toFixed(3)),
      })) as typeof target.points;
      clones.push({
        ...interaction,
        id: interactionDraftId('route', newActorId, ordinal++),
        actor: newActorId,
        target: { ...target, points } as Interaction['target'],
        ...(target.mode === 'customTimedRoute'
          ? {
              trigger: { kind: 'at', t: 0 },
              until: { kind: 'at', t: clipSeconds },
            }
          : {}),
      } as Interaction);
    }
    return clones;
  }

  /**
   * One-click re-anchor for an unanchored road vehicle: resolve the nearest
   * usable driving lane within {@link RESNAP_RADIUS_M} and snap onto it.
   */
  resnapToLane(ids: readonly string[]): void {
    if (!this.authoringEnabled) return;
    const updates: ActorUpdate[] = [];
    let missed = 0;
    for (const id of ids) {
      const actor = this.doc.actor(id);
      if (!actor || actor.static || actor.kind !== 'vehicle') continue;
      const resolved = resolveVehicleDrop(this.laneIndex, actor.x, actor.z, {
        preferredLateralM: actor.laneRef?.t ?? 0,
        fallbackHeadingRad: actor.headingRad,
        bodyWidthM: actor.dims.w,
        radiusM: RESNAP_RADIUS_M,
        routeUsable: (anchor) => this.routeForLaneMutation(actor, anchor) !== null,
      });
      if (resolved.outcome !== 'snapped' || !resolved.laneRef) {
        missed++;
        continue;
      }
      updates.push({
        id,
        x: resolved.x,
        y: this.groundY(resolved.x, resolved.z, actor.y),
        z: resolved.z,
        headingRad: resolved.headingRad,
        laneRef: resolved.laneRef,
        routeLaneRsls: null,
      });
    }
    if (updates.length > 0) this.doc.update(updates);
    if (missed > 0) this.flash(`no usable driving lane within ${RESNAP_RADIUS_M} m`);
    else if (updates.length > 0) this.flash(`snapped ${updates.length} to lane`);
  }

  undo(): void {
    if (!this.authoringEnabled) return;
    if (!this.doc.undo()) return;
    this.selection = this.selection.filter((id) => this.doc.actor(id));
    this.syncScene();
    this.notify();
  }

  redo(): void {
    if (!this.authoringEnabled) return;
    if (!this.doc.redo()) return;
    this.selection = this.selection.filter((id) => this.doc.actor(id));
    this.syncScene();
    this.notify();
  }

  /** Start a move gesture on the current selection (the `G` key, or a button). */
  beginGrab(): void {
    if (!this.authoringEnabled) return;
    if (this.selection.length === 0) {
      this.flash('select something first');
      return;
    }
    const start = this.lastGroundPoint;
    if (!start) return;
    this.cancelModal();
    this.grab = {
      origin: new Map(this.selection.map((id) => [id, this.doc.actor(id) as ActorRecord])),
      start: start.clone(),
      direct: false,
      valid: true,
      reason: null,
      headingOffsetRad: 0,
      outcome: 'snapped'
    };
    this.mode = 'grab';
    this.notify();
  }

  /** Start a rotate gesture on the current selection (the `R` key). */
  beginRotate(): void {
    if (!this.authoringEnabled) return;
    if (this.selection.length === 0) {
      this.flash('select something first');
      return;
    }
    if (this.selection.some((id) => {
      const actor = this.doc.actor(id);
      return actor?.kind === 'vehicle' && !actor.static;
    })) {
      this.flash('Vehicles follow lane travel direction and cannot be freely rotated');
      return;
    }
    const point = this.lastGroundPoint;
    if (!point) return;
    this.cancelModal();
    const origin = new Map(this.selection.map((id) => [id, this.doc.actor(id) as ActorRecord]));
    let cx = 0;
    let cz = 0;
    for (const actor of origin.values()) {
      cx += actor.x;
      cz += actor.z;
    }
    cx /= origin.size;
    cz /= origin.size;
    this.rotate = {
      origin,
      centerX: cx,
      centerZ: cz,
      startAngle: Math.atan2(-(point.z - cz), point.x - cx),
      delta: 0
    };
    this.mode = 'rotate';
    this.notify();
  }

  // ------------------------------------------------------- inspector edits

  setLabel(id: string, label: string): void {
    if (!this.authoringEnabled) return;
    this.doc.update([{ id, label }]);
  }

  /**
   * Edit the world pose numerically.
   *
   * Moving an anchored actor in world space is a conflict: the lane anchor says
   * one thing, the numbers another. Rather than silently keeping a stale anchor,
   * the actor is re-snapped when it still lands on its own lane and the anchor is
   * dropped (with a message) when it does not.
   */
  setWorldPose(id: string, patch: { x?: number; z?: number; headingDeg?: number }): void {
    if (!this.authoringEnabled) return;
    const actor = this.doc.actor(id);
    if (!actor) return;
    const x = patch.x ?? actor.x;
    const z = patch.z ?? actor.z;
    const requestedHeadingRad =
      patch.headingDeg === undefined
        ? actor.headingRad
        : normalizeHeading((patch.headingDeg * Math.PI) / 180);
    if (!actor.static && isRoadBoundMotorVehicle(actor.catalogId)) {
      const snapped = this.snapMotorVehicle(actor.catalogId, new Vector3(x, actor.y, z), {
        lateralM: actor.laneRef?.t ?? 0,
        fallbackHeadingRad: actor.headingRad
      });
      if (!snapped.valid || !snapped.laneRef) {
        this.flash(snapped.reason ?? 'No driving lane nearby — move cancelled');
        return;
      }
      const route = this.routeForLaneMutation(actor, snapped.laneRef);
      if (!route) {
        this.flash('No usable route from that road position — move cancelled');
        return;
      }
      this.doc.update([{
        id,
        x: snapped.x,
        y: snapped.y,
        z: snapped.z,
        headingRad: snapped.headingRad,
        laneRef: snapped.laneRef,
        routeLaneRsls: null,
      }]);
      return;
    }
    const headingRad = requestedHeadingRad;
    const update: ActorUpdate = { id, x, z, y: this.groundY(x, z, actor.y), headingRad };

    if (actor.laneRef) {
      const hit = this.laneIndex.nearest(x, z, SNAP_RADIUS_M);
      if (hit && Math.abs(hit.t) <= hit.lane.widthM) {
        const anchor: LaneAnchor = {
          roadId: hit.lane.roadId,
          section: hit.lane.section,
          laneId: hit.lane.laneId,
          s: hit.s,
          t: hit.t,
          headingOffsetRad: headingDelta(hit.headingRad, headingRad)
        };
        const route = this.routeForLaneMutation(actor, anchor);
        if (!route) {
          this.flash('No usable route from that road position — move cancelled');
          return;
        }
        update.laneRef = anchor;
        update.routeLaneRsls = null;
      } else {
        update.laneRef = null;
        update.routeLaneRsls = null;
        this.flash('moved off the road — anchor and route cleared');
      }
    }
    this.doc.update([update]);
  }

  /** Edit the lane anchor numerically; the world pose is re-derived from it. */
  setLanePose(id: string, patch: { s?: number; t?: number }): void {
    if (!this.authoringEnabled) return;
    const actor = this.doc.actor(id);
    if (!actor?.laneRef) return;
    const lane = this.laneFor(actor.laneRef);
    if (!lane) return;
    const s = Math.min(lane.length, Math.max(0, patch.s ?? actor.laneRef.s));
    const t = patch.t ?? actor.laneRef.t;
    const pose = this.laneIndex.poseAt(lane, s, t);
    const anchor = {
      ...actor.laneRef,
      s,
      t,
      ...(isRoadBoundMotorVehicle(actor.catalogId) ? { headingOffsetRad: 0 } : {})
    };
    const route = this.routeForLaneMutation(actor, anchor);
    if (!route) {
      this.flash('No usable route from that lane station — move cancelled');
      return;
    }
    this.doc.update([
      {
        id,
        x: pose.x,
        z: pose.z,
        y: this.groundY(pose.x, pose.z, actor.y),
        headingRad: normalizeHeading(pose.headingRad + anchor.headingOffsetRad),
        laneRef: anchor,
        routeLaneRsls: null,
      },
    ]);
  }

  /** Lane length, so the inspector can bound its `s` field. */
  laneLength(anchor: LaneAnchor): number | null {
    return this.laneFor(anchor)?.length ?? null;
  }

  protected abstract readonly onPointerDown: (event: PointerEvent) => void;
  protected abstract readonly onPointerMove: (event: PointerEvent) => void;
  protected abstract readonly onPointerUp: (event: PointerEvent) => void;
  protected abstract readonly onPointerCancel: (event: PointerEvent) => void;
  protected abstract readonly onWheel: (event: WheelEvent) => void;
  protected abstract readonly onContextMenu: (event: MouseEvent) => void;
  protected abstract readonly onKeyDown: (event: KeyboardEvent) => void;
  protected abstract readonly onKeyUp: (event: KeyboardEvent) => void;
  protected abstract endDirectPress(): void;
  protected abstract clearMarquee(): void;
  protected abstract get lastGroundPoint(): Vector3 | null;
  protected abstract cancelModal(): void;
  protected abstract groundY(x: number, z: number, fallback: number): number;
  protected abstract laneFor(anchor: LaneAnchor): IndexedLane | null;
  protected abstract snapMotorVehicle(
    catalogId: CatalogId,
    ground: Vector3,
    options?: VehicleSnapOptions,
  ): GhostPose;
  protected abstract routeForLaneMutation(
    actor: ActorRecord,
    anchor: LaneAnchor,
  ): readonly string[] | null;
  protected abstract syncScene(): void;
  protected abstract flash(message: string): void;
  protected abstract notify(): void;
  protected abstract publish(): void;
  protected abstract buildState(): EditorState;
  protected abstract prepareRandomActorAppearance(kind: "vehicle" | "pedestrian"): void;
}

function isRoadBoundMotorVehicle(catalogId: CatalogId): boolean {
  const entry = getEntry(catalogId);
  if (entry.class !== 'vehicle' || !entry.tags.includes('roadway')) return false;
  return catalogId !== 'vehicle.bicycle';
}
