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

import { Vector2, Vector3, type Intersection } from 'three';
import { getViewerSurfaceRect, type EditorViewer } from './viewer-contract';
import { CATALOG, getEntry, type CatalogId } from '@simforge/asset-catalog';
import { buildDefaultPlacementRoute, buildFollowRoute } from '@simforge/engine';
import { type ActorView } from '@simforge/viewer';
import {
  actorKindFor,
  DEFAULT_AUTHORED_VEHICLE_SPEED_KPH,
  type ActorKind,
  type ActorRecord,
  type ActorUpdate,
  type EditorDocument,
  type LaneAnchor,
} from './document';
import {
  headingDelta,
  normalizeHeading,
  type IndexedLane,
  type LaneIndex
} from './laneIndex';
import { firstOverlap, type Footprint } from './obb';
import { authoringRoutes } from './routeOverlay';
import { resolveVehicleDrop, DROP_SNAP_RADIUS_M, type DropOutcome } from './drop-resolver';
import { actorIdsInRect, applySelectionOp, selectionOpForModifiers, type ScreenRect, type SelectionOp } from './marquee';

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
  /** Live drop-resolver verdict for the in-flight move (see `DropOutcome`). */
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
  /** Ground height in scene metres, or `null` off the map. */
  sampleHeight: (x: number, z: number) => number | null;
}

/** How far from the cursor the snapper will look for a lane, metres. */
const SNAP_RADIUS_M = 30;
/** Clearance every pair of actors must keep, metres. */
const CLEARANCE_M = 0.3;
/** Shift-snap increment while rotating, degrees. */
const ROTATE_SNAP_DEG = 15;
/** Lift the authored object while its original footprint remains visible. */
const DIRECT_MOVE_LIFT_M = 0.42;
/** How long a transient status message stays up. */
const MESSAGE_MS = 2600;

const _ndc = new Vector2();
const _origin = new Vector3();
const _direction = new Vector3();

import { EditorControllerInput } from "./controller-input";

export class EditorController extends EditorControllerInput {
  // ------------------------------------------------------------- placement

  /**
   * Commit one exact catalog item at a browser client point.
   *
   * HTML drag/drop does not produce the pointer sequence used by click-to-place.
   * Keep that transport detail out of React: this command resolves the same
   * ground point, snapping, collision validation and document transaction as
   * ordinary placement without manufacturing DOM pointer events.
   */
  placeCatalogAtClientPoint(
    catalogId: CatalogId,
    clientX: number,
    clientY: number,
    modifiers: { altKey?: boolean; shiftKey?: boolean; freeformStatic?: boolean } = {},
  ): boolean {
    if (!this.authoringEnabled) return false;
    const freeformStatic = Boolean(modifiers.freeformStatic);
    if (this.mode !== 'placing' || this.placing !== catalogId || this.placingFreeformStatic !== freeformStatic) {
      this.togglePlacement(catalogId, { freeformStatic });
    }
    this.altDown = Boolean(modifiers.altKey);
    this.shiftDown = Boolean(modifiers.shiftKey);
    const ground = this.groundPoint({ clientX, clientY });
    if (!ground) {
      this.flash('Choose a point on the map');
      return false;
    }
    this.updateGhost(ground);
    const count = this.doc.actors.length;
    this.commitPlacement(Boolean(modifiers.altKey));
    return this.doc.actors.length > count;
  }

  protected updateGhost(ground: Vector3): void {
    const catalogId = this.placing;
    if (!catalogId) return;
    const pose = this.computeGhostPose(catalogId, ground);
    this.ghostPose = pose;
    if (!pose) {
      this.ghost.hide();
      this.notify();
      return;
    }
    this.ghost.show(catalogId);
    this.ghost.setPose(pose.x, pose.y, pose.z, pose.headingRad);
    this.ghost.setValid(pose.valid);
    this.notify();
  }

  /** Recompute the ghost at the last known cursor position (after Tab/⌥/scroll). */
  protected refreshGhost(): void {
    const point = this.lastGroundPoint;
    if (point && this.mode === 'placing') this.updateGhost(point);
    else this.notify();
  }

  protected computeGhostPose(catalogId: CatalogId, ground: Vector3): GhostPose {
    const kind = actorKindFor(catalogId);
    const dims = getEntry(catalogId).dims;
    const requiresLane = !this.placingFreeformStatic && isRoadBoundMotorVehicle(catalogId);
    // Preserve the existing opt-in driving-lane behavior for VRUs and other
    // mobile catalog actors, while motor vehicles can never bypass it.
    const wantsLane = !this.placingFreeformStatic && kind === 'vehicle' && (requiresLane || !this.altDown);

    if (wantsLane) {
      const nearest = this.laneIndex.nearestForVehiclePlacement(ground.x, ground.z, SNAP_RADIUS_M);
      const snapped = this.snapMotorVehicle(catalogId, ground, {
        lateralM: this.lateral,
        ...(this.flipped && nearest ? { opposingToHeadingRad: nearest.headingRad } : {}),
        fallbackHeadingRad: this.freeHeading
      });
      if (!snapped.laneRef) {
        return {
          ...snapped,
          reason: requiresLane
            ? 'no valid driving lane within 30 m — vehicle must be placed on a road'
            : 'no driving lane within 30 m — hold ⌥ for free placement'
        };
      }
      this.lateral = snapped.laneRef.t;
      const blocker = this.overlap({
        x: snapped.x,
        z: snapped.z,
        length: dims.l,
        width: dims.w,
        headingRad: snapped.headingRad
      });
      const drivingSpeedKph = defaultDrivingSpeedKph(catalogId);
      const warning = drivingSpeedKph === null
        ? null
        : this.placementRouteWarning(snapped.laneRef, drivingSpeedKph);
      return {
        ...snapped,
        valid: !blocker,
        reason: blocker
          ? requiresLane
            ? `overlaps ${describe(blocker)} — choose another road position`
            : `overlaps ${describe(blocker)} — hold ⌥ to place anyway`
          : null,
        warning,
      };
    }

    // Free placement: ground snap, heading from the drag (or the last one).
    const heading = normalizeHeading(this.freeHeading + this.placementHeadingOffsetRad);
    const blocker = this.overlap({
      x: ground.x,
      z: ground.z,
      length: dims.l,
      width: dims.w,
      headingRad: heading
    });
    return {
      x: ground.x,
      y: ground.y,
      z: ground.z,
      headingRad: heading,
      laneRef: null,
      laneLabel: null,
      valid: !blocker,
      reason: blocker ? `overlaps ${describe(blocker)} — hold ⌥ to place anyway` : null
    };
  }

  /**
   * The single semantic-road snap used by palette placement, direct movement,
   * keyboard movement and numeric pose edits. It never inspects render meshes,
   * so every graphics preset resolves the same lane, pose and travel yaw.
   */
  protected snapMotorVehicle(catalogId: CatalogId, ground: Vector3, options: VehicleSnapOptions = {}): GhostPose {
    let hit = this.laneIndex.nearestForVehiclePlacement(ground.x, ground.z, SNAP_RADIUS_M);
    if (hit && options.opposingToHeadingRad !== undefined) {
      hit = this.laneIndex.nearestOpposingForVehiclePlacement(
        ground.x,
        ground.z,
        options.opposingToHeadingRad,
        SNAP_RADIUS_M,
      ) ?? hit;
    }
    if (!hit) {
      return {
        x: ground.x,
        y: ground.y,
        z: ground.z,
        headingRad: options.fallbackHeadingRad ?? 0,
        laneRef: null,
        laneLabel: null,
        valid: false,
        reason: 'no valid driving lane within 30 m'
      };
    }
    const limit = this.laneIndex.lateralLimit(hit.lane, getEntry(catalogId).dims.w);
    const t = Math.max(-limit, Math.min(limit, options.lateralM ?? 0));
    const pose = this.laneIndex.poseAt(hit.lane, hit.s, t);
    return {
      x: pose.x,
      y: this.groundY(pose.x, pose.z, ground.y),
      z: pose.z,
      headingRad: pose.headingRad === 0 ? 0 : pose.headingRad,
      laneRef: {
        roadId: hit.lane.roadId,
        section: hit.lane.section,
        laneId: hit.lane.laneId,
        s: hit.s,
        t,
        headingOffsetRad: 0
      },
      laneLabel: laneLabel(hit.lane, hit.s, t),
      valid: true,
      reason: null
    };
  }

  protected commitPlacement(altClick: boolean): void {
    const pose = this.ghostPose;
    const catalogId = this.placing;
    if (!pose || !catalogId) return;
    const requiresLane = !this.placingFreeformStatic && isRoadBoundMotorVehicle(catalogId);
    if (!pose.valid && (requiresLane || !altClick)) {
      this.flash(pose.reason ?? 'cannot place here');
      return;
    }
    const actorId = this.pendingActorId ?? this.doc.allocateActorId(catalogId);
    const drivingSpeedKph = this.placingFreeformStatic ? null : defaultDrivingSpeedKph(catalogId);
    if (drivingSpeedKph !== null) {
      if (!pose.laneRef) {
        this.flash('Place road vehicles on a valid driving lane');
        return;
      }
    }
    this.doc.add([{
      id: actorId,
      catalogId,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      headingRad: pose.headingRad,
      ...(pose.laneRef ? { laneRef: pose.laneRef } : {}),
      ...(drivingSpeedKph === null ? {} : { initialSpeedKph: drivingSpeedKph }),
      ...(this.placingFreeformStatic ? { static: true } : {}),
      ...(actorKindFor(catalogId) === 'vehicle'
        ? { bodyColor: defaultBodyColor(catalogId) }
        : {})
    }]);
    if (!pose.valid) this.flash('placed with ⌥ override');
    else if (pose.warning) this.flash(pose.warning);
    // Placement remains armed so one catalog choice can stamp multiple actors.
    // The new actor stays unselected, so no inspector, anchored popover or
    // selected-route overlay interrupts the placement run. Escape, Cancel, a
    // different tool, or pressing the active catalog tool again ends it.
    this.selection = [];
    this.pendingActorId = null;
    this.ghostPose = null;
    this.syncScene();
    if (this.placingKind) {
      this.prepareRandomActorAppearance(this.placingKind);
    } else if (this.placing) {
      this.ghost.show(this.placing);
      this.ghost.hide(); // hidden until the cursor next moves over the map
    }
    this.notify();
  }

  protected prepareRandomActorAppearance(kind: 'vehicle' | 'pedestrian'): void {
    const placeholder = kind === 'vehicle' ? 'vehicle.sedan' : 'pedestrian.adult';
    const actorId = this.doc.allocateActorId(placeholder as CatalogId);
    const catalogId = deterministicActorCatalog(kind, this.doc.routeSeed, actorId);
    this.pendingActorId = actorId;
    this.placing = catalogId;
    this.ghost.show(catalogId);
    this.ghost.hide();
  }

  // ------------------------------------------------------------ grab/rotate

  protected updateGrab(event?: PointerEvent): void {
    const session = this.grab;
    if (!session) return;
    const ground = event ? this.groundPoint(event) : this.lastGroundPoint;
    if (!ground) return;
    const dx = ground.x - session.start.x;
    const dz = ground.z - session.start.z;
    session.valid = true;
    session.reason = null;
    let anyFree = false;

    this.preview.clear();
    for (const actor of session.origin.values()) {
      const targetX = actor.x + dx;
      const targetZ = actor.z + dz;
      if (!actor.static && isRoadBoundMotorVehicle(actor.catalogId)) {
        // Road semantics apply at the drop, through the one resolver: the
        // nearest usable lane within DROP_SNAP_RADIUS_M snaps (heading to lane
        // travel, authored lateral offset preserved); anything else places the
        // vehicle free — "unanchored" — instead of refusing the move.
        const resolved = resolveVehicleDrop(this.laneIndex, targetX, targetZ, {
          preferredLateralM: actor.laneRef?.t ?? 0,
          fallbackHeadingRad: actor.headingRad,
          bodyWidthM: actor.dims.w,
          radiusM: DROP_SNAP_RADIUS_M,
          routeUsable: (anchor) => this.routeForLaneMutation(actor, anchor) !== null,
        });
        if (resolved.outcome === 'free') anyFree = true;
        this.preview.set(actor.id, {
          x: resolved.x,
          y: this.groundY(resolved.x, resolved.z, actor.y),
          z: resolved.z,
          headingRad: resolved.headingRad,
          laneRef: resolved.laneRef,
          routeLaneRsls: null,
        });
        continue;
      }
      // Pedestrians, props and parked bodies move free, ground-height sampled.
      // A previous lane anchor no longer describes the new spot, so it clears.
      this.preview.set(actor.id, {
        x: targetX,
        y: this.groundY(targetX, targetZ, actor.y),
        z: targetZ,
        headingRad: normalizeHeading(actor.headingRad + (actor.kind !== 'vehicle' || actor.static ? session.headingOffsetRad : 0)),
        laneRef: actor.laneRef ? null : undefined,
        routeLaneRsls: actor.laneRef ? null : undefined
      });
    }
    {
      const movingIds = new Set(session.origin.keys());
      for (const [id, actor] of session.origin) {
        const patch = this.preview.get(id);
        if (!patch) continue;
        const blocker = this.overlap({
          x: patch.x,
          z: patch.z,
          length: actor.dims.l,
          width: actor.dims.w,
          headingRad: patch.headingRad
        }, movingIds);
        if (blocker) {
          session.valid = false;
          session.reason = `Overlaps ${describe(blocker)}`;
        }
      }
      session.outcome = !session.valid ? 'invalid' : anyFree ? 'free' : 'snapped';
      if (session.direct) {
        for (const [id, actor] of session.origin) {
          const patch = this.preview.get(id);
          if (!patch) continue;
          this.ghost.show(actor.catalogId);
          this.ghost.setPose(patch.x, patch.y, patch.z, patch.headingRad);
          this.ghost.setOutcome(session.outcome);
          break;
        }
      }
    }
    this.syncScene();
    this.notify();
  }

  protected updateRotate(event?: PointerEvent): void {
    const session = this.rotate;
    if (!session) return;
    const ground = event ? this.groundPoint(event) : this.lastGroundPoint;
    if (!ground) return;
    const angle = Math.atan2(-(ground.z - session.centerZ), ground.x - session.centerX);
    let delta = normalizeHeading(angle - session.startAngle);
    if (this.shiftDown) {
      const step = (ROTATE_SNAP_DEG * Math.PI) / 180;
      delta = Math.round(delta / step) * step;
    }
    session.delta = delta;

    this.preview.clear();
    const single = session.origin.size === 1;
    for (const actor of session.origin.values()) {
      // Blender contract: the group turns about its shared centroid — offsets
      // orbit the pivot and each heading turns by the same delta. A single
      // actor's centroid is itself, which degenerates to rotate-in-place.
      const headingRad = normalizeHeading(actor.headingRad + delta);
      const offsetX = actor.x - session.centerX;
      const offsetZ = actor.z - session.centerZ;
      const cos = Math.cos(delta);
      const sin = Math.sin(delta);
      // Headings measure against -z (atan2(-dz, dx)), so the matching positive
      // planar rotation is x' = x·cos + z·sin, z' = z·cos − x·sin.
      const x = single ? actor.x : session.centerX + offsetX * cos + offsetZ * sin;
      const z = single ? actor.z : session.centerZ + offsetZ * cos - offsetX * sin;
      const patch: PosePatch = { x, y: this.groundY(x, z, actor.y), z, headingRad };
      if (actor.laneRef) {
        if (single) {
          const lane = this.laneFor(actor.laneRef);
          if (lane) {
            const pose = this.laneIndex.poseAt(lane, actor.laneRef.s, actor.laneRef.t);
            patch.laneRef = {
              ...actor.laneRef,
              headingOffsetRad: headingDelta(pose.headingRad, headingRad)
            };
          }
        } else {
          // The orbit moved an anchored body off its anchor point; the stale
          // anchor cannot describe the new spot, so it clears (free placement).
          patch.laneRef = null;
          patch.routeLaneRsls = null;
        }
      }
      this.preview.set(actor.id, patch);
    }
    this.syncScene();
    this.notify();
  }

  protected commitModal(): void {
    if (this.grab && !this.grab.valid) {
      this.flash(this.grab.reason ?? 'Move cancelled — choose a valid position');
      return;
    }
    const updates: ActorUpdate[] = [];
    for (const [id, patch] of this.preview) {
      updates.push({
        id,
        x: patch.x,
        y: patch.y,
        z: patch.z,
        headingRad: patch.headingRad,
        ...(patch.laneRef === undefined ? {} : { laneRef: patch.laneRef }),
        ...(patch.routeLaneRsls === undefined ? {} : { routeLaneRsls: patch.routeLaneRsls })
      });
    }
    const freed = this.grab?.outcome === 'free';
    this.preview.clear();
    this.grab = null;
    this.rotate = null;
    this.mode = 'idle';
    this.ghost.hide();
    this.endDirectPress();
    if (updates.length > 0) this.doc.update(updates);
    if (freed) this.flash('placed off-road — unanchored (use Re-snap to re-anchor)');
    this.syncScene();
    this.notify();
  }

  /** Validate that runtime routing can start from a lane-bound pose mutation. */
  protected routeForLaneMutation(actor: ActorRecord, anchor: LaneAnchor): readonly string[] | null {
    const speedKph = actor.initialSpeedKph ?? defaultDrivingSpeedKph(actor.catalogId);
    if (speedKph === null) return actor.routeLaneRsls ?? [];
    return this.planLaneRoute(anchor, speedKph);
  }

  protected planLaneRoute(anchor: LaneAnchor, speedKph: number): readonly string[] | null {
    const startRsl = `${anchor.roadId}:${anchor.section}:${anchor.laneId}`;
    const duration = this.doc.data.choreography.clipSeconds + this.doc.data.choreography.warmupSeconds;
    const requiredDownstreamM = Math.max(100, (speedKph / 3.6) * duration + 10);
    const planned = buildDefaultPlacementRoute(this.laneIndex.graph, {
      startRsl,
      startStorageS: anchor.s,
      requiredDownstreamM
    });
    return planned.ok ? planned.lanes : null;
  }

  /**
   * Resolve an explicit timeline turn into the exact map-bound lane path.
   * New authoring can persist semantic next-junction intent; this method stays
   * available for hosts that need an immediate concrete guide.
   */
  planTimelineTurn(
    actorId: string,
    turn: 'Straight' | 'Left' | 'Right',
  ): readonly string[] | null {
    const actor = this.doc.actor(actorId);
    if (!actor?.laneRef) return null;
    const startRsl = `${actor.laneRef.roadId}:${actor.laneRef.section}:${actor.laneRef.laneId}`;
    const speedKph = actor.initialSpeedKph ?? defaultDrivingSpeedKph(actor.catalogId) ?? 30;
    const duration = this.doc.data.choreography.clipSeconds
      + this.doc.data.choreography.warmupSeconds;
    const built = buildFollowRoute(
      this.laneIndex.graph,
      startRsl,
      [turn],
      Math.max(100, (speedKph / 3.6) * duration + 10),
    );
    return built.ok ? built.route.legs.map((leg) => leg.rsl) : null;
  }

  /** Explain a risky but still authorable road anchor. */
  protected placementRouteWarning(anchor: LaneAnchor, speedKph: number): string | null {
    const startRsl = `${anchor.roadId}:${anchor.section}:${anchor.laneId}`;
    const duration = this.doc.data.choreography.clipSeconds + this.doc.data.choreography.warmupSeconds;
    const requiredDownstreamM = Math.max(100, (speedKph / 3.6) * duration + 10);
    const planned = buildDefaultPlacementRoute(this.laneIndex.graph, {
      startRsl,
      startStorageS: anchor.s,
      requiredDownstreamM,
    });
    if (!planned.ok) {
      return 'Warning: this lane has no connected continuation. Move to a nearby through lane unless the stop is intentional.';
    }

    const turnRelation = [startRsl, ...planned.lanes]
      .map((rsl) => this.laneIndex.graph.turnRelationOf(rsl))
      .find((relation) => relation !== null) ?? null;
    const turnLabel = turnRelation === 'Right'
      ? 'right turn'
      : turnRelation === 'Left'
        ? 'left turn'
        : turnRelation === 'UTurnRight' || turnRelation === 'UTurnLeft'
          ? 'U-turn'
          : null;
    const availableM = Math.round(planned.downstreamM);
    const short = planned.downstreamM + 0.5 < requiredDownstreamM;
    if (turnLabel && short) {
      return `Warning: this position commits the actor to a ${turnLabel}, and the mapped route ends after about ${availableM} m. Move to a straight-through lane unless that turn is intentional.`;
    }
    if (turnLabel) {
      return `Warning: this position commits the actor to a ${turnLabel}. Move to a straight-through lane unless that turn is intentional.`;
    }
    if (short) {
      return `Warning: the mapped road ends after about ${availableM} m, before the actor can finish the clip. Move farther back or choose a connected through lane.`;
    }
    return null;
  }

  /** Drop any in-flight gesture without writing to the document. */
  protected cancelModal(): void {
    if (this.customRouteDraft) {
      this.cancelCustomRouteAuthoring();
      return;
    }
    this.endDirectPress();
    this.preview.clear();
    this.grab = null;
    this.rotate = null;
    this.placing = null;
    this.placingKind = null;
    this.pendingActorId = null;
    this.placementHeadingOffsetRad = 0;
    this.placingFreeformStatic = false;
    this.ghost.hide();
    this.ghostPose = null;
    this.mode = 'idle';
    this.syncScene();
  }

  // -------------------------------------------------------------- picking

  protected pick(event: PointerEvent): void {
    const id = this.actorIdAt(event);
    if (!id) {
      // Shift/Ctrl clicks are set edits; only a plain empty click clears.
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey) this.setSelection([]);
      return;
    }
    this.selectPickedActor(id, selectionOpForModifiers(event), true);
  }

  protected actorIdAt(event: PointerEvent): string | null {
    const targets = this.renderer.pickables();
    if (targets.length === 0) return null;
    this.setRay(event);
    const hits: Intersection[] = this.raycaster.intersectObjects(targets, false);
    for (const hit of hits) {
      const id = this.renderer.actorIdForHit(hit);
      if (id) return id;
    }
    return null;
  }

  protected routePointIndexAt(event: PointerEvent): number | null {
    this.setRay(event);
    return this.routeRenderer.draftPointIndexAt(this.raycaster);
  }

  protected selectPickedActor(id: string, op: SelectionOp, frame: boolean): void {
    if (op !== 'replace') {
      this.setSelection(applySelectionOp(this.selection, [id], op));
      return;
    }
    this.setSelection([id]);
    // A direct scene click has the same camera contract as clicking the
    // actor's name in the timeline: smoothly frame that actor.  Keep this
    // out of `setSelection` so Speed/Actions controls, box selection, and
    // playback-driven selection remain completely camera-neutral.
    if (frame) this.frameActor(id);
  }

  /**
   * Marquee release: screen-space centroid test against every placed actor,
   * combined with the current selection under the modifier rule. Deliberately
   * camera-neutral — box selection never reframes.
   */
  protected applyMarqueeSelection(rect: ScreenRect, op: SelectionOp): void {
    const surface = getViewerSurfaceRect(this.viewer);
    const picked = actorIdsInRect(this.doc.actors, this.viewer.camera, surface, rect);
    this.setSelection(applySelectionOp(this.selection, picked, op));
  }

  /** The translucent DOM rectangle the operator drags. Owned here, not React:
   * it must track the pointer without waiting for a render commit. */
  protected marqueeBox: HTMLDivElement | null = null;

  protected syncMarqueeBox(rect: ScreenRect | null): void {
    if (!rect) {
      this.marqueeBox?.remove();
      this.marqueeBox = null;
      return;
    }
    if (!this.marqueeBox) {
      const box = document.createElement('div');
      box.dataset.testid = 'editor-marquee';
      box.style.position = 'fixed';
      box.style.zIndex = '40';
      box.style.pointerEvents = 'none';
      box.style.border = '1px solid rgba(96, 165, 250, 0.9)';
      box.style.background = 'rgba(59, 130, 246, 0.15)';
      (this.host ?? document.body).appendChild(box);
      this.marqueeBox = box;
    }
    this.marqueeBox.style.left = `${rect.left}px`;
    this.marqueeBox.style.top = `${rect.top}px`;
    this.marqueeBox.style.width = `${rect.right - rect.left}px`;
    this.marqueeBox.style.height = `${rect.bottom - rect.top}px`;
  }

  // --------------------------------------------------------------- helpers

  protected lastGround: Vector3 | null = null;

  protected get lastGroundPoint(): Vector3 | null {
    return this.lastGround;
  }

  protected setRay(event: { clientX: number; clientY: number }): void {
    const rect = getViewerSurfaceRect(this.viewer);
    _ndc.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(_ndc, this.viewer.camera);
  }

  /**
   * Where the cursor meets the ground.
   *
   * Not a raycast against the scene: the ground is a height *field*, so the
   * cheap answer is to intersect a horizontal plane and then iterate — sample
   * the terrain there, move the plane to that height, repeat. Three passes
   * converge to millimetres on real city grades, at ~0.2 µs a sample through
   * `GroundIndex`, and it never touches the scene graph.
   */
  protected groundPoint(event: { clientX: number; clientY: number }): Vector3 | null {
    this.setRay(event);
    _origin.copy(this.raycaster.ray.origin);
    _direction.copy(this.raycaster.ray.direction);
    if (_direction.y >= -1e-6) return null; // looking at or above the horizon

    let y = this.lastGroundY;
    const point = new Vector3();
    for (let i = 0; i < 4; i++) {
      const t = (y - _origin.y) / _direction.y;
      if (!(t > 0) || t > 1e5) return null;
      point.copy(_direction).multiplyScalar(t).add(_origin);
      const sampled = this.sampleHeight(point.x, point.z);
      if (sampled === null) break;
      if (Math.abs(sampled - y) < 0.01) {
        y = sampled;
        break;
      }
      y = sampled;
    }
    point.y = y;
    this.lastGroundY = y;
    this.lastGround = point;
    return point;
  }

  protected groundY(x: number, z: number, fallback: number): number {
    const sampled = this.sampleHeight(x, z);
    return sampled === null ? fallback : sampled;
  }

  /** Public cursor→ground projection for host tools (paste at a client point). */
  groundPointAtClient(clientX: number, clientY: number): { x: number; y: number; z: number } | null {
    const point = this.groundPoint({ clientX, clientY });
    return point ? { x: point.x, y: point.y, z: point.z } : null;
  }

  /** Last ground point under the cursor, if the pointer has crossed the map. */
  get cursorGroundPoint(): { x: number; y: number; z: number } | null {
    const point = this.lastGround;
    return point ? { x: point.x, y: point.y, z: point.z } : null;
  }

  /**
   * Resolve a paste placement through the same road-semantics rule as a drop:
   * a road-bound vehicle snaps to the nearest usable lane within
   * {@link DROP_SNAP_RADIUS_M} (heading to lane travel, lateral offset
   * preserved) or places free — never refused; everything else grounds at the
   * requested point.
   */
  resolveDrop(
    catalogId: CatalogId,
    x: number,
    z: number,
    options: { preferredLateralM?: number; headingRad?: number; static?: boolean; fallbackY?: number } = {},
  ): { outcome: 'snapped' | 'free'; x: number; y: number; z: number; headingRad: number; laneRef: LaneAnchor | null } {
    const heading = options.headingRad ?? 0;
    const fallbackY = options.fallbackY ?? 0;
    if (!options.static && isRoadBoundMotorVehicle(catalogId)) {
      const speedKph = defaultDrivingSpeedKph(catalogId) ?? DEFAULT_AUTHORED_VEHICLE_SPEED_KPH;
      const resolved = resolveVehicleDrop(this.laneIndex, x, z, {
        preferredLateralM: options.preferredLateralM ?? 0,
        fallbackHeadingRad: heading,
        bodyWidthM: getEntry(catalogId).dims.w,
        radiusM: DROP_SNAP_RADIUS_M,
        routeUsable: (anchor) => this.planLaneRoute(anchor, speedKph) !== null,
      });
      return { ...resolved, y: this.groundY(resolved.x, resolved.z, fallbackY) };
    }
    return { outcome: 'free', x, y: this.groundY(x, z, fallbackY), z, headingRad: heading, laneRef: null };
  }

  protected laneFor(anchor: LaneAnchor): IndexedLane | null {
    return this.laneIndex.laneFor(anchor.roadId, anchor.section, anchor.laneId) ?? null;
  }

  protected overlap(probe: Footprint, exclude = new Set<string>()): (Footprint & { id: string; catalogId: CatalogId }) | null {
    const others = this.doc.actors.filter((a) => !exclude.has(a.id)).map((a) => ({
      id: a.id,
      catalogId: a.catalogId,
      x: a.x,
      z: a.z,
      length: a.dims.l,
      width: a.dims.w,
      headingRad: a.headingRad
    }));
    return firstOverlap(probe, others, CLEARANCE_M);
  }

  /** Push the current document + preview into the renderer. */
  protected syncScene(): void {
    const views: ActorView[] = this.doc.actors.map((actor) => {
      const patch = this.preview.get(actor.id);
      return {
        id: actor.id,
        catalogId: actor.catalogId,
        x: patch?.x ?? actor.x,
        y: (patch?.y ?? actor.y) + (this.grab?.direct && this.preview.has(actor.id) ? DIRECT_MOVE_LIFT_M : 0),
        z: patch?.z ?? actor.z,
        headingRad: patch?.headingRad ?? actor.headingRad,
        dims: actor.dims,
        bodyColor: actor.bodyColor,
        sensors: actor.sensors
      };
    });
    this.renderer.sync(views);
    const selected = new Set(this.selection);
    this.renderer.setSelection(views.filter((v) => selected.has(v.id)));
    const simulationPreview = this.simulationPreview;
    const routeDraft = this.customRouteDraft;
    const draftActorId = routeDraft
      ? this.doc.data.choreography.interactions.find((item) => item.id === routeDraft.interactionId)?.actor
      : null;
    const routes = simulationPreview
      ? authoringRoutes(
          this.doc.data,
          this.laneIndex,
          simulationPreview.input,
          simulationPreview.trace,
        )
      : [];
    this.routeRenderer.sync(draftActorId ? routes.filter((route) => route.actorId !== draftActorId) : routes, {
      showAmbient: false,
      showActual: false,
      selectedActorIds: selected,
      primarySelectedActorId: this.selection[0] ?? null
    });
  }

  protected flash(message: string): void {
    this.message = message;
    if (this.messageTimer !== null) clearTimeout(this.messageTimer);
    this.messageTimer = setTimeout(() => {
      this.message = null;
      this.messageTimer = null;
      this.notify();
    }, MESSAGE_MS);
    this.notify();
  }

  /** Coalesce notifications to one per frame: pointer moves fire in bursts. */
  protected notify(): void {
    if (this.notifyHandle) return;
    this.notifyHandle = requestAnimationFrame(() => {
      this.notifyHandle = 0;
      this.publish();
    });
  }

  protected publish(): void {
    this.snapshot = this.buildState();
    for (const listener of [...this.listeners]) listener();
  }

  protected buildState(): EditorState {
    const selectedRecord =
      this.selection.length === 1 ? this.doc.actor(this.selection[0] as string) : undefined;
    const laneLabel =
      this.mode === 'placing'
        ? this.ghostPose?.laneLabel ?? null
        : this.mode === 'grab' && selectedRecord
          ? (() => {
              const anchor = this.preview.get(selectedRecord.id)?.laneRef;
              return anchor ? anchorLabel(anchor) : null;
            })()
        : selectedRecord?.laneRef
          ? anchorLabel(selectedRecord.laneRef)
          : null;
    return {
      revision: this.doc.revision,
      name: this.doc.name,
      mode: this.mode,
      actors: this.doc.actors.map((actor) => {
        const patch = this.preview.get(actor.id);
        if (!patch) return actor;
        return {
          ...actor,
          x: patch.x,
          y: patch.y,
          z: patch.z,
          headingRad: patch.headingRad,
          laneRef: patch.laneRef === undefined ? actor.laneRef : patch.laneRef ?? undefined,
          routeLaneRsls: patch.routeLaneRsls === undefined
            ? actor.routeLaneRsls
            : patch.routeLaneRsls ?? undefined
        };
      }),
      selection: this.selection,
      placing: this.placing,
      snapped: this.mode === 'grab' && selectedRecord
        ? this.preview.get(selectedRecord.id)?.laneRef != null
        : this.ghostPose?.laneRef != null,
      lateral: this.lateral,
      flipped: this.flipped,
      valid: this.mode === 'grab' ? this.grab?.valid ?? true : this.ghostPose?.valid ?? true,
      placementWarning: this.mode === 'placing' ? this.ghostPose?.warning ?? null : null,
      customRoutePointCount: this.customRouteDraft?.points.length ?? 0,
      customRouteTool: this.customRouteDraft?.tool ?? null,
      customRouteSelectedPointIndex: this.customRouteDraft?.selectedPointIndex ?? null,
      hint: this.buildHint(),
      message: this.message,
      rotationDeg:
        this.mode === 'rotate' && this.rotate ? (this.rotate.delta * 180) / Math.PI : null,
      laneLabel,
      canUndo: this.doc.canUndo,
      canRedo: this.doc.canRedo,
      dirty: this.doc.isDirty,
      savedAt: this.doc.savedAt,
      dropOutcome: this.mode === 'grab' ? this.grab?.outcome ?? null : null
    };
  }

  protected buildHint(): string {
    switch (this.mode) {
      case 'drawingRoute':
        return this.customRouteDraft?.tool === 'move'
          ? `${this.customRouteDraft.points.length} route points · drag a 3D point to move · Delete removes selected · Esc closes`
          : `${this.customRouteDraft?.points.length ?? 0} route points · click to draw or insert · Enter finishes drawing · Esc closes`;
      case 'placing': {
        const kind: ActorKind = this.placing ? actorKindFor(this.placing) : 'prop';
        if (this.placingFreeformStatic) {
          return 'free placement · click place · click-drag set heading · Q / E rotate 5° · right-click cancel';
        }
        if (kind === 'vehicle') {
          if (this.placing && isRoadBoundMotorVehicle(this.placing)) {
            return this.ghostPose?.laneRef
              ? this.ghostPose.warning
                ? `${this.ghostPose.warning} · click to place anyway · Tab opposite lane · right-click cancel`
                : `snapped to ${this.ghostPose.laneLabel ?? 'driving lane'} · click place · Tab opposite lane · scroll offset ${this.lateral.toFixed(2)} m · right-click cancel`
              : 'no driving lane nearby · move onto a road · right-click cancel';
          }
          return this.ghostPose?.laneRef
            ? `click place · Tab opposite lane · scroll offset ${this.lateral.toFixed(2)} m · ⌥ free · right-click cancel`
            : 'free placement (⌥) · click place · drag set heading · right-click cancel';
        }
        return 'click place · click-drag set heading · Q / E rotate 5° · right-click cancel';
      }
      case 'grab': {
        if (this.grab?.direct) {
          const rotatable = [...this.grab.origin.values()].every((actor) => actor.kind !== 'vehicle' || actor.static);
          const roadVehicle = [...this.grab.origin.values()].some((actor) => !actor.static && isRoadBoundMotorVehicle(actor.catalogId));
          if (roadVehicle) {
            if (this.grab.outcome === 'invalid') {
              return `${this.grab.reason ?? 'invalid position'} · release cancels move · Esc cancel`;
            }
            return this.grab.outcome === 'free'
              ? 'off-road — will place unanchored · release confirm · Esc cancel'
              : `snapped to ${laneLabelFromPreview(this.preview, this.grab.origin) ?? 'driving lane'} · release confirm · Esc cancel`;
          }
          return rotatable
            ? 'move · Q / E rotate 5° · release confirm · Esc cancel'
            : 'move · release confirm · Esc cancel';
        }
        return 'move · click confirm · right-click cancel';
      }
      case 'rotate':
        return 'rotate · ⇧ 15° snap · click confirm · right-click cancel';
      default:
        return this.selection.length > 0
          ? `${this.selection.length} selected · hold-drag move · ⌘C copy · ⌘D duplicate · ⌫ delete · ⇧click add · ⌃click toggle`
          : 'click select · drag box-select · hold-drag actor move · middle-drag / WASD pan';
    }
  }
}

function laneLabel(lane: IndexedLane, s: number, t: number): string {
  const offset = Math.abs(t) < 0.005 ? '' : ` · t ${t >= 0 ? '+' : ''}${t.toFixed(2)} m`;
  return `road ${lane.roadId} · lane ${lane.laneId} · s ${s.toFixed(1)} m${offset}`;
}

function anchorLabel(anchor: LaneAnchor): string {
  const offset = Math.abs(anchor.t) < 0.005 ? '' : ` · t ${anchor.t >= 0 ? '+' : ''}${anchor.t.toFixed(2)} m`;
  return `road ${anchor.roadId} · lane ${anchor.laneId} · s ${anchor.s.toFixed(1)} m${offset}`;
}

function laneLabelFromPreview(
  preview: ReadonlyMap<string, PosePatch>,
  origin: ReadonlyMap<string, ActorRecord>,
): string | null {
  for (const id of origin.keys()) {
    const anchor = preview.get(id)?.laneRef;
    if (anchor) return anchorLabel(anchor);
  }
  return null;
}

function describe(actor: { catalogId: CatalogId }): string {
  try {
    return getEntry(actor.catalogId).label.toLowerCase();
  } catch {
    return 'another actor';
  }
}

/** Exact authored cruise speed for newly placed motor vehicles; null stays static. */
export function defaultDrivingSpeedKph(catalogId: CatalogId): number | null {
  const entry = getEntry(catalogId);
  if (entry.class !== 'vehicle' || !entry.tags.includes('roadway')) return null;
  // A cyclist is a VRU, not a default motor-traffic actor. Sidewalk mobility
  // devices are already excluded by the roadway requirement above.
  if (catalogId === 'vehicle.bicycle') return null;
  return DEFAULT_AUTHORED_VEHICLE_SPEED_KPH;
}

/** Motor-road actors share the editor's mandatory semantic lane contract. */
export function isRoadBoundMotorVehicle(catalogId: CatalogId): boolean {
  return defaultDrivingSpeedKph(catalogId) !== null;
}

/** Stable catalog choice: save/reopen never rerolls an actor's appearance. */
export function deterministicActorCatalog(
  kind: 'vehicle' | 'pedestrian',
  scenarioSeed: string,
  actorId: string,
): CatalogId {
  const compatible = CATALOG.filter((entry) => kind === 'pedestrian'
    ? entry.class === 'pedestrian'
    : entry.class === 'vehicle' && (entry.tags as readonly string[]).includes('roadway') && entry.id !== 'vehicle.bicycle')
    .map((entry) => entry.id as CatalogId)
    .sort();
  if (compatible.length === 0) throw new Error(`No compatible ${kind} models are installed`);
  let hash = 2166136261;
  for (const char of `${scenarioSeed}|${actorId}|${kind}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return compatible[(hash >>> 0) % compatible.length] as CatalogId;
}

function defaultBodyColor(catalogId: CatalogId): string {
  const color = getEntry(catalogId).defaultParams['color'];
  return typeof color === 'string' ? color : '#59748f';
}
