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
 * | left drag on empty map | camera (orbit) |
 * | middle drag | camera (ground-plane pan) |
 * | right drag | camera (pan), or cancel while editing |
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

import { Vector2, Vector3 } from 'three';
import type { EditorViewer } from './viewer-contract';
import { type CatalogId } from '@simforge/asset-catalog';
import { handleEditorHistoryKey, isTextEditingTarget } from './keyboard';
import {
  actorKindFor,
  type ActorRecord,
  type EditorDocument,
} from './document';
import { normalizeHeading, type LaneIndex } from './laneIndex';

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
}

interface DirectMovePress {
  pointerId: number;
  actorId: string;
  startGround: Vector3;
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface EditorControllerOptions {
  viewer: EditorViewer;
  laneIndex: LaneIndex;
  document: EditorDocument;
  /** Ground height in scene metres, or `null` off the map. */
  sampleHeight: (x: number, z: number) => number | null;
}

/** Pointer travel below which a press counts as a click, CSS pixels. */
const CLICK_SLOP_PX = 5;
/** Lateral nudge per wheel notch, metres. */
const LATERAL_STEP_M = 0.25;
/** Direct manipulation intentionally distinguishes a hold from a normal click. */
const DIRECT_MOVE_HOLD_MS = 220;
/** Non-vehicle authored actors rotate in deterministic increments while positioned. */
const PROP_ROTATE_STEP_RAD = (5 * Math.PI) / 180;

const _ndc = new Vector2();
const _origin = new Vector3();
const _direction = new Vector3();

import { EditorControllerCommands } from "./controller-commands";

export abstract class EditorControllerInput extends EditorControllerCommands {
  // ------------------------------------------------------------ input: keys

  protected onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Alt') this.setAlt(true);
    if (event.key === 'Shift') this.setShift(true);
    if (isTextEditingTarget(event.target)) return;
    if (!this.authoringEnabled) return;

    // While drawing, undo belongs to the gesture, not the document. The points
    // placed so far are not committed yet, so document undo would step over the
    // whole drawing and reverse whatever the author did before it.
    const undoRoutePoint = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey;
    if (undoRoutePoint && this.mode === 'drawingRoute' && this.customRouteDraft?.tool === 'add') {
      event.preventDefault();
      event.stopPropagation();
      this.removeLastCustomRoutePoint();
      return;
    }

    if (handleEditorHistoryKey(event, {
      enabled: this.authoringEnabled,
      canUndo: this.doc.canUndo,
      canRedo: this.doc.canRedo,
      undo: () => this.undo(),
      redo: () => this.redo()
    })) return;
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      event.stopPropagation();
      this.duplicateSelection();
      return;
    }
    if (meta && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      event.stopPropagation();
      this.selectAll();
      return;
    }
    if (meta) return; // leave the rest of the browser's shortcuts alone

    if ((event.key === 'q' || event.key === 'Q' || event.key === 'e' || event.key === 'E')
      && this.rotateStaticPreview(event.key.toLowerCase() === 'q' ? 1 : -1)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.cancel();
        return;
      case 'g':
      case 'G':
        event.preventDefault();
        event.stopPropagation();
        this.beginGrab();
        return;
      case 'r':
      case 'R':
        event.preventDefault();
        event.stopPropagation();
        this.beginRotate();
        return;
      case 'Delete':
        event.preventDefault();
        event.stopPropagation();
        if (this.mode === 'drawingRoute') this.deleteSelectedCustomRoutePoint();
        else this.deleteSelection();
        return;
      case 'Tab':
        if (this.mode === 'placing') {
          event.preventDefault();
          event.stopPropagation();
          this.flipped = !this.flipped;
          this.refreshGhost();
        }
        return;
      case 'Enter':
        if (this.mode === 'drawingRoute') {
          event.preventDefault();
          event.stopPropagation();
          this.finishCustomRouteAuthoring();
        } else if (this.mode === 'grab' || this.mode === 'rotate') {
          event.preventDefault();
          event.stopPropagation();
          this.commitModal();
        }
        return;
      case 'Backspace':
        if (this.mode === 'drawingRoute') {
          event.preventDefault();
          event.stopPropagation();
          if (this.customRouteDraft?.tool === 'move') this.deleteSelectedCustomRoutePoint();
          else this.removeLastCustomRoutePoint();
        } else {
          event.preventDefault();
          event.stopPropagation();
          this.deleteSelection();
        }
        return;
      default:
    }
  };

  protected onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Alt') this.setAlt(false);
    if (event.key === 'Shift') this.setShift(false);
  };

  protected setAlt(down: boolean): void {
    if (this.altDown === down) return;
    this.altDown = down;
    if (this.mode === 'placing') this.refreshGhost();
    else if (this.mode === 'grab') this.updateGrab();
  }

  protected setShift(down: boolean): void {
    if (this.shiftDown === down) return;
    this.shiftDown = down;
    if (this.mode === 'rotate') this.updateRotate();
  }

  /** Q turns left and E turns right for props and pedestrians, never vehicles. */
  protected rotateStaticPreview(direction: 1 | -1): boolean {
    if (this.mode === 'placing' && this.placing && (actorKindFor(this.placing) !== 'vehicle' || this.placingFreeformStatic)) {
      this.placementHeadingOffsetRad = normalizeHeading(
        this.placementHeadingOffsetRad + direction * PROP_ROTATE_STEP_RAD,
      );
      this.refreshGhost();
      return true;
    }
    const session = this.grab;
    if (this.mode !== 'grab' || !session?.direct
      || [...session.origin.values()].some((actor) => actor.kind === 'vehicle' && !actor.static)) return false;
    session.headingOffsetRad = normalizeHeading(session.headingOffsetRad + direction * PROP_ROTATE_STEP_RAD);
    this.updateGrab();
    return true;
  }

  // -------------------------------------------------------- input: pointer

  protected onContextMenu = (event: MouseEvent): void => {
    // Right-click cancels a modal gesture instead of opening a menu; outside a
    // mode it belongs to the camera (pan), which already suppresses the menu.
    if (this.mode === 'grab' || this.mode === 'rotate' || this.mode === 'placing' || this.mode === 'drawingRoute') {
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
    }
  };

  /**
   * Only the canvas is the map.
   *
   * The panels are siblings of the canvas inside the host, so a capture-phase
   * listener on the host sees palette clicks and inspector scrolls too. Without
   * this guard, arming a prop from the palette would immediately place one.
   */
  protected isCanvasEvent(event: Event): boolean {
    return event.target === this.viewer.renderer.domElement;
  }

  protected onPointerDown = (event: PointerEvent): void => {
    if (!this.isCanvasEvent(event)) return;
    if (!this.authoringEnabled) return;
    this.altDown = event.altKey;
    this.shiftDown = event.shiftKey;

    if (this.mode === 'drawingRoute') {
      if (event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        const draft = this.customRouteDraft;
        if (draft?.tool === 'move') {
          const pointIndex = this.routePointIndexAt(event);
          // The 0th point of a timed route is the actor's own position: the simulation
          // starts it from there, so dragging the two apart would put the car in two
          // places at t=0. Moving the car carries the whole route instead, which is what
          // the message points the author at. Selection is refused as well, because a
          // selected point is a deletable one and deleting this one hands the start to a
          // waypoint that is not the car.
          const pinned = draft.timed === true && pointIndex === 0;
          if (pinned) this.flash("The first point is the car's position — move the car to move it");
          draft.selectedPointIndex = pinned ? null : pointIndex;
          draft.draggingPointIndex = pinned ? null : pointIndex;
          if (!pinned && pointIndex !== null) {
            try { this.viewer.renderer.domElement.setPointerCapture(event.pointerId); } catch { /* optional */ }
            this.viewer.controls.setEnabled(false);
          }
          this.syncCustomRouteDraft();
          this.notify();
        } else {
          const ground = this.groundPoint(event);
          if (ground) this.addCustomRoutePoint(ground, event);
        }
      }
      return;
    }

    if (this.mode === 'grab' || this.mode === 'rotate') {
      if (event.button === 0) {
        event.preventDefault();
        event.stopPropagation();
        this.commitModal();
      }
      return;
    }

    this.pressButton = event.button;
    this.pressX = event.clientX;
    this.pressY = event.clientY;
    this.pressMoved = false;

    if (this.mode === 'idle' && event.button === 0) {
      const actorId = this.actorIdAt(event);
      const actor = actorId ? this.doc.actor(actorId) : undefined;
      const ground = actor ? this.groundPoint(event) : null;
      if (actor && ground) {
        // Consume the press immediately. If it stays short it is selection; if
        // it crosses the hold/slop boundary it becomes direct manipulation.
        event.preventDefault();
        event.stopPropagation();
        const press: DirectMovePress = {
          pointerId: event.pointerId,
          actorId: actor.id,
          startGround: ground.clone(),
          active: false,
          timer: null
        };
        press.timer = setTimeout(() => this.activateDirectMove(press), DIRECT_MOVE_HOLD_MS);
        this.directPress = press;
        try { this.viewer.renderer.domElement.setPointerCapture(event.pointerId); } catch { /* synthetic/legacy canvas */ }
        this.viewer.controls.setEnabled(false);
        return;
      }
    }

    if (this.mode === 'placing' && event.button === 0) {
      // The camera must not orbit while the user is dropping actors.
      event.preventDefault();
      event.stopPropagation();
      const ground = this.groundPoint(event);
      if (ground) {
        // A click can arrive before any pointermove after the catalog drawer
        // closes. Seed the exact pose from pointerdown so pointerup always has
        // something to commit, even when the cursor never moved over the map.
        this.updateGhost(ground);
        this.headingDrag = { x: ground.x, z: ground.z };
      }
    }
  };

  protected onPointerMove = (event: PointerEvent): void => {
    if (!this.isCanvasEvent(event)) return;
    if (!this.authoringEnabled) return;
    this.altDown = event.altKey;
    this.shiftDown = event.shiftKey;
    if (
      this.pressButton >= 0 &&
      (Math.abs(event.clientX - this.pressX) > CLICK_SLOP_PX ||
        Math.abs(event.clientY - this.pressY) > CLICK_SLOP_PX)
    ) {
      this.pressMoved = true;
    }

    const direct = this.directPress;
    if (direct && direct.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      if (!direct.active && this.pressMoved) this.activateDirectMove(direct);
      if (direct.active) this.updateGrab(event);
      else this.groundPoint(event);
      return;
    }

    switch (this.mode) {
      case 'drawingRoute':
        if (this.customRouteDraft?.tool === 'move' && this.customRouteDraft.draggingPointIndex !== null) {
          event.preventDefault();
          event.stopPropagation();
          const ground = this.groundPoint(event);
          const pointIndex = this.customRouteDraft.draggingPointIndex;
          if (ground && pointIndex !== null && this.customRouteDraft.points[pointIndex]) {
            this.customRouteDraft.points[pointIndex] = {
              ...this.customRouteDraft.points[pointIndex],
              x: Number(ground.x.toFixed(3)),
              z: Number(ground.z.toFixed(3)),
            };
            this.syncCustomRouteDraft();
            this.notify();
          }
        } else if (this.customRouteDraft?.tool === 'add') {
          this.updateCustomRouteCursor(this.groundPoint(event));
        }
        return;
      case 'placing': {
        const ground = this.groundPoint(event);
        if (!ground) {
          this.ghost.hide();
          this.ghostPose = null;
          return;
        }
        if (this.headingDrag && this.pressMoved) {
          const dx = ground.x - this.headingDrag.x;
          const dz = ground.z - this.headingDrag.z;
          if (dx * dx + dz * dz > 0.5) this.freeHeading = Math.atan2(-dz, dx);
        }
        this.updateGhost(ground);
        return;
      }
      case 'grab':
        this.updateGrab(event);
        return;
      case 'rotate':
        this.updateRotate(event);
        return;
      default:
        // Idle: remember where the cursor is on the ground so `G`/`R` have an
        // anchor the moment they are pressed.
        this.groundPoint(event);
    }
  };

  protected onPointerUp = (event: PointerEvent): void => {
    if (this.mode === 'drawingRoute') {
      if (this.isCanvasEvent(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
      const draft = this.customRouteDraft;
      if (draft?.tool === 'move' && draft.draggingPointIndex !== null) {
        draft.draggingPointIndex = null;
        try {
          const canvas = this.viewer.renderer.domElement;
          if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        } catch { /* optional */ }
        this.viewer.controls.setEnabled(true);
        const interaction = this.doc.data.choreography.interactions.find((item) => item.id === draft.interactionId);
        if (interaction?.verb === 'route' && (interaction.target.mode === 'customRoute' || interaction.target.mode === 'customTimedRoute')) {
          this.commitCustomRouteDraft(interaction);
        }
        this.syncScene();
        this.notify();
      }
      return;
    }
    const direct = this.directPress;
    // Pointer capture is best-effort. Browsers can retarget or drop capture
    // when opening portal UI during the gesture, so the matching release must
    // still finish the actor press even when it lands outside the canvas.
    if (!this.isCanvasEvent(event) && direct?.pointerId !== event.pointerId) return;
    if (!this.authoringEnabled) return;
    if (direct && direct.pointerId === event.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      const actorId = direct.actorId;
      const active = direct.active;
      const valid = this.grab?.valid !== false;
      const reason = this.grab?.reason;
      this.pressButton = -1;
      this.pressMoved = false;
      if (!active) {
        this.endDirectPress();
        this.selectPickedActor(actorId, event.shiftKey, true);
      } else if (valid) {
        this.commitModal();
      } else {
        this.cancelModal();
        this.flash(reason ?? 'Move cancelled — choose a valid position');
      }
      return;
    }

    const wasPlacing = this.mode === 'placing';
    const button = this.pressButton;
    const moved = this.pressMoved;
    this.pressButton = -1;
    this.headingDrag = null;

    if (button !== 0) return;

    if (wasPlacing) {
      event.preventDefault();
      event.stopPropagation();
      this.commitPlacement(event.altKey);
      return;
    }
    if (this.mode !== 'idle' || moved) return;
    // A click that did not drag is a selection, not a camera move.
    this.pick(event);
  };

  protected onPointerCancel = (event: PointerEvent): void => {
    const direct = this.directPress;
    if (!direct || direct.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.pressButton = -1;
    this.pressMoved = false;
    this.cancelModal();
    this.notify();
  };

  protected onWheel = (event: WheelEvent): void => {
    // Only steal the wheel when it has a lane to nudge along; otherwise it is
    // the camera's zoom and must stay that way.
    if (!this.isCanvasEvent(event) || !this.authoringEnabled) return;
    if (this.mode !== 'placing' || !this.ghostPose?.laneRef) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.deltaY > 0 ? -LATERAL_STEP_M : LATERAL_STEP_M;
    this.lateral += step;
    this.refreshGhost();
  };

  protected activateDirectMove(press: DirectMovePress): void {
    if (this.directPress !== press || press.active || !this.authoringEnabled) return;
    const actor = this.doc.actor(press.actorId);
    if (!actor) {
      this.endDirectPress();
      return;
    }
    if (press.timer !== null) clearTimeout(press.timer);
    press.timer = null;
    press.active = true;
    this.selection = [actor.id];
    this.grab = {
      origin: new Map([[actor.id, actor]]),
      start: press.startGround.clone(),
      broke: false,
      direct: true,
      valid: true,
      reason: null,
      headingOffsetRad: 0
    };
    this.mode = 'grab';
    this.ghost.show(actor.catalogId);
    this.updateGrab();
  }

  protected endDirectPress(): void {
    const press = this.directPress;
    if (!press) return;
    if (press.timer !== null) clearTimeout(press.timer);
    try {
      const canvas = this.viewer.renderer.domElement;
      if (canvas.hasPointerCapture?.(press.pointerId)) canvas.releasePointerCapture(press.pointerId);
    } catch { /* capture is optional in synthetic/legacy canvases */ }
    this.directPress = null;
    this.viewer.controls.setEnabled(true);
  }

  protected abstract updateGhost(ground: Vector3): void;
  protected abstract refreshGhost(): void;
  protected abstract commitPlacement(altClick: boolean): void;
  protected abstract updateGrab(event?: PointerEvent): void;
  protected abstract updateRotate(event?: PointerEvent): void;
  protected abstract commitModal(): void;
  protected abstract pick(event: PointerEvent): void;
  protected abstract actorIdAt(event: PointerEvent): string | null;
  protected abstract routePointIndexAt(event: PointerEvent): number | null;
  protected abstract selectPickedActor(id: string, additive: boolean, frame: boolean): void;
  protected abstract groundPoint(event: { clientX: number; clientY: number }): Vector3 | null;
}
