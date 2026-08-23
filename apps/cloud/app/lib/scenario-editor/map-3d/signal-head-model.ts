/**
 * Physical traffic-signal heads for the map's 3D mode: where a head is, which
 * way it looks, and which lamp is lit at the playhead.
 *
 * Three things this module settles that the docked viewport got approximately
 * right and the 2D map did not have at all:
 *
 * 1. **Pose comes from the map's traffic-light index, not from
 *    `street_furniture`.** `GET /api/map-assets/[id]/traffic-lights` serves the
 *    runtime bundle's heads already projected into the runtime frame (see
 *    `signals/editor-traffic-lights.ts`); street furniture is lazily fetched and
 *    null unless street-camera mode asked for it, and carries no stop lines or
 *    lamp boxes at all.
 * 2. **A head faces where it was AUTHORED to face.** `<signal hOffset>` plus the
 *    road heading, flipped by `orientation`, is the exact answer, and the index
 *    ships it as `yaw` on an `authored` head. The stop-line bearing survives only
 *    for a head with no `<signal>`: it is a decent guess but only a guess, and it
 *    sits a median ~98 deg off the actor yaw, so the two are plainly different
 *    things rather than a rounding matter.
 * 3. **Lamp geometry follows the cook that produced the bundle.** New-cook
 *    bundles carry `housing.lamps`, the real lens positions, and those win
 *    outright. Old-cook bundles carry no housing and report one `light_box` for
 *    the whole uniform housing, so both 0 and 1 mean "no per-lamp data" and
 *    resolve to the old standard three-lamp fallback.
 *
 * ## Height is RELATIVE, and the bundle's `z` is not
 *
 * A bundle row's `z` is ABSOLUTE elevation (133–144 m on San Ramon P1). This
 * module used to clamp it into `[1.8, 8]` as if it were a height above the road,
 * which pinned every head on five of six lit maps to the 8 m ceiling. The only
 * height in the data that means anything is `light_boxes[0].location.z` minus
 * the actor's own `z` — both absolute, so the difference is the lamp's height
 * above the head's base, and the base sits within centimetres of the road under
 * it. New-cook housings make the same rule explicit as
 * `height_above_ground_m`. That value is the authored `<signal zOffset>`:
 * the mounting point at the housing's base, not its centre. The centre is one
 * half housing-height above it. Lamps remain absolute measurements only long
 * enough to subtract the housing's absolute centre `z`, then move with that
 * corrected centre. Absolute elevation never becomes scene height.
 *
 * ## Unauthored junctions read GREEN, not grey
 *
 * A head whose OpenDRIVE id matches no authored movement resolves to `authored:
 * false` with state `green`. That is not a guess — a junction with no plan is
 * forced green for the whole scenario (`SIGNAL_PLAN_MODE_LABELS.map_default` is
 * literally "Forced green", and the browser engine drives through a null signal
 * as green). Grey lamps on every junction of a fresh map would misrepresent what
 * the simulation actually does. The renderer dims the emissive on unauthored
 * heads so "forced green by default" still looks different from "green because
 * you painted it green".
 *
 * ## Each quantity comes from whichever source is exact for it
 *
 * The two sources disagree, and neither wins outright — which is the mistake
 * two earlier revisions of this module each made in opposite directions:
 *
 * - **Position** comes from the actor/XODR pose for old-cook fallback geometry,
 *   but from `housing.x/y` when the new cook exposes the surviving RoadRunner
 *   mesh. On the old cook the actor is the upright exactly (0.00 m to
 *   `Poles_1`); on the new cook the housing is only 0.25 m from its actor.
 * - **Facing** comes from the `<signal>` on the old-cook fallback. The actor's
 *   yaw is ~95-100 deg off the direction the head looks; `road heading +
 *   hOffset + 180` lands within 8-15 deg of the stop-line bearing on every map.
 *   A new-cook housing instead carries the rendered mesh's own measured yaw.
 *
 * The position-from-actor and facing-from-signal distinction therefore remains
 * essential to the old-cook path, while the new-cook path needs neither
 * inference because the rendered housing supplies both quantities directly.
 *
 * ## Hardware follows the cook
 *
 * The old cook replaced every signal with one `BP_TLOpenDrive`, broken into
 * `Poles_1` (upright), `Poles_2` (arm), `Poles_3` (foot) and `TrafficLight_0`
 * (housing). Its measured geometry remains the nullable fallback:
 *
 *     actor pose            -> Poles_1        0.00 m    (103/103 and 46/46)
 *     actor pose            -> TrafficLight_0 6.01 m
 *     authored (s,t)        -> Poles_1        0.25 m
 *     authored (s,t)        -> TrafficLight_0 6.00 m
 *
 * For that old cook, **the actor/authored point is the pole base** and the
 * housing hangs {@link SIGNAL_MAST_ARM_LENGTH_M} out over the roadway.
 *
 * That old cook also gives **every head an upright**, including every `Bare`,
 * `Bracket` and `Side` one: 103/103 on Di Rosa, 46/46 on Yale. It does not
 * honour the RoadRunner asset, so a `Post`-only rule would disagree with the
 * simulator.
 *
 * The new cook has no `BP_TLOpenDrive` instances. RoadRunner's housing variation
 * survives: four real heights (1.08/1.16/1.26/1.46 m), 74 distinct elevations
 * among Di Rosa's 82 housings, and exactly three measured lenses per housing.
 * Its tall, thin mast meshes are geometrically identifiable even though their
 * semantic type is usually only `Other`: every housing on every lit map has one
 * within 12 m (median 0.5 m). The assignment collapses Di Rosa's 82 heads onto
 * 46 masts, including 19 heads on 9 masts at junction 710.
 *
 * Heads therefore SHARE masts. New-cook geometry draws one pole per distinct
 * `mast.id` and one measured arm from that pole to each sufficiently distant
 * housing. Emitting the pole per head would recreate the old over-poling bug in
 * a form that looks almost right, so mast identity — not proximity — is the
 * deduplication contract.
 *
 * ## Arrow lenses come from the PLAN, never from the signal type
 *
 * `<signal type="1000011" subtype="10">` claims to be an arrow variant and is
 * not one in these files — see the measurement in `editor-traffic-lights.ts`.
 * `signalLensKindIndex` derives protected turns from the authored plan instead:
 * a head bound only to the left movements of its approach, on an approach whose
 * other turns are driven by other heads, IS a protected left, and that is the
 * `refineMovementSignalIds` per-connecting-road refinement showing through. It
 * needs no map data the plan does not already carry, and it degrades to a plain
 * ball head whenever the approach has no per-turn split.
 */

import type { BehaviorSignalState, JunctionSignalPlan } from "@simcloud/shared";
import {
  planStatesAt,
  SIGNAL_STATE_COLORS,
} from "@/app/lib/scenario-editor/signals/signal-plan-model";
import { carlaPointToRuntimePoint } from "@/app/lib/editor-map/coordinate-frames";
import type {
  EditorSignalHousing,
  EditorSignalMast,
  EditorSignalMountStyle,
} from "@/app/lib/scenario-editor/signals/editor-traffic-lights";
import { runtimeYawToSceneRotationY } from "./coordinates";

export type Map3DSignalLampState = BehaviorSignalState;

/**
 * What the lenses on a head show.
 *
 * `ball` is the ordinary circular head. The rest are protected-turn arrow heads,
 * all three lenses arrowed, which is what a three-section arrow signal is.
 */
export type Map3DSignalLensKind = "ball" | "left" | "right" | "straight";

export type Map3DSignalMountStyle = EditorSignalMountStyle;

/**
 * The one signal palette. Previously the dock used `#F04E4E/#F0B429/#3FCF6E`
 * and the 3D viewport used `0xe5484d/0xf5c518/0x3dd68c`, agreeing only on
 * `unknown`. These are the dock's, converted — the dock is the surface an
 * author stares at while painting, so it wins.
 */
export const MAP_3D_SIGNAL_COLORS: Record<Map3DSignalLampState, number> = {
  red: hexStringToNumber(SIGNAL_STATE_COLORS.red),
  yellow: hexStringToNumber(SIGNAL_STATE_COLORS.yellow),
  green: hexStringToNumber(SIGNAL_STATE_COLORS.green),
};

function hexStringToNumber(value: string): number {
  const parsed = Number.parseInt(value.replace("#", ""), 16);
  return Number.isFinite(parsed) ? parsed : 0x6b7280;
}

/** Lamps run top to bottom on a real head, and so do these. */
export const LAMP_ORDER: readonly Map3DSignalLampState[] = ["red", "yellow", "green"];

/** Where the lamp sits when the source carries no measured lamp height. */
export const DEFAULT_HEAD_HEIGHT_M = 3.2;
/** A dense city junction cluster is context, not the subject. */
export const MAP_3D_MAX_SIGNAL_HEADS = 120;

/** The corpus's most common housing: `Signal_3Light_Post01` at 1.16 x 0.52 m. */
export const DEFAULT_HOUSING_HEIGHT_M = 1.16;
export const DEFAULT_HOUSING_WIDTH_M = 0.52;

/**
 * The OLD cook's mast, measured off `environment_objects` on Di Rosa and Yale.
 *
 * Not inferred, and not the blueprint's documentation — these are the world
 * bounding boxes of the meshes the UE5 map actually contains, one set per
 * `BP_TLOpenDrive` instance (`Poles_1` upright, `Poles_2` arm, `Poles_3` foot,
 * `TrafficLight_0` housing). Every value below is identical on 100% of the 149
 * old-cook instances measured, because that cook spawns one uniform blueprint
 * per signal and discards the RoadRunner asset it came from. New-cook housings
 * do not use any of these constants.
 *
 * The horizontal offset is expressed from the head's FACING rather than from the
 * CARLA actor's yaw, so it survives for an authored head with no actor row. The
 * two are equivalent: the cooked housing's own mesh yaw equals the actor yaw
 * exactly, the arm runs at `housingYaw - 176 deg`, and the facing sits 90 deg off
 * the housing yaw — which puts the arm at `facing + 94 deg`, i.e. very nearly
 * across the head's line of sight, which is what a mast arm is.
 */
export const SIGNAL_MAST_ARM_LENGTH_M = 6.01;
/**
 * Signed, and the sign is the whole point: `-86` and `+94` describe the same
 * line and opposite ends of it, so getting it backwards puts every housing on
 * the far side of its own pole. Measured directly as
 * `bearing(upright -> housing) - facing`, p50 `-86.0` on all four maps.
 */
export const SIGNAL_MAST_ARM_BEARING_FROM_FACING_DEG = -86;
/** Housing centre above the road. Rigid: the cook ignores `<signal zOffset>`. */
export const SIGNAL_COOKED_HOUSING_HEIGHT_M = 5.75;
/** Top of the upright above the road. */
export const SIGNAL_COOKED_POLE_TOP_M = 7.75;
/** How far above the housing the arm runs. */
const POLE_CAP_M = 0.45;

/**
 * A new-cook head closer than this to its mast is post-mounted for editor
 * purposes. Suppressing the sub-metre member avoids a short, misleading stub.
 */
export const SIGNAL_MAST_ARM_MIN_LENGTH_M = 1.0;

/**
 * Old-cook pole bases closer together than this are one upright.
 *
 * Deliberately tight. RoadRunner authors a genuinely separate pole for nearly
 * every head — 81 distinct bases among Di Rosa's 82 heads at 0.5 m — so this
 * merges only the handful that are physically the same post (measured 0.4 m
 * apart, carrying two heads back-to-back) and invents no sharing beyond that.
 *
 * This applies only to fallback assemblies. New-cook heads dedupe exactly on
 * their measured `mast.id` instead.
 */
export const ASSEMBLY_POLE_RADIUS_M = 1.0;

/**
 * Structural shape covering an `EditorTrafficLight`. Deliberately loose: the
 * same head arrives from the map's traffic-light index, from street furniture
 * and from a test fixture, and a missing optional is normal rather than an
 * error.
 *
 * Absolute actor `z` remains deliberately absent. A new-cook housing carries
 * absolute `z` only so its lenses can be made relative to the measured
 * `height_above_ground_m`; it is never treated as scene height directly.
 */
export interface Map3DSignalHeadSource {
  /** Ground position under the housing, runtime frame, metres. */
  x?: number | null;
  y?: number | null;
  /** The direction the head looks, runtime degrees CCW from +x. */
  yaw?: number | null;
  /**
   * Whether `x`/`y`/`yaw` came from the `<signal>` or from the CARLA actor.
   *
   * `"authored"` means `yaw` is the real facing and needs no inference at all;
   * anything else leaves {@link headFacingYawDegrees} to fall back to the stop
   * line. Absent on street furniture and on older fixtures, which is why the
   * check is for the positive value rather than against `"actor"`.
   */
  facing_source?: "authored" | "actor" | null;
  /** RAW CARLA-frame pose, as a bundle row carries it: `y` is mirrored. */
  location?: { x?: number | null; y?: number | null; z?: number | null } | null;
  opendrive_id?: string | number | null;
  actor_id?: number | null;
  pole_index?: number | null;
  /** Lamp-housing centre above the head's own base, metres. */
  lamp_height_m?: number | null;
  /**
   * Stop lines this head governs. Flat `x`/`y` are runtime frame; a raw bundle
   * row instead nests the pose at `transform.location`, in the CARLA frame.
   */
  stop_waypoints?: Array<
    | {
        x?: number | null;
        y?: number | null;
        /**
         * Declared but deliberately UNREAD. CARLA reports -1 here on 90–100% of
         * heads because a stop waypoint sits on the approach lane, outside the
         * junction box; it was the editor's exact attribution tier and never
         * once fired. `intersection-candidates.ts` joins on `opendrive_id`.
         */
        junction_id?: number | string | null;
        transform?: {
          location?: { x?: number | null; y?: number | null } | null;
        } | null;
      }
    | null
  > | null;
  /** Number of per-lamp boxes CARLA reported, when the raw array is not carried. */
  light_box_count?: number | null;
  light_boxes?: readonly unknown[] | null;
  /** RoadRunner mounting hardware. `null` on the zero-geometry debris rows. */
  mount_style?: Map3DSignalMountStyle | null;
  /**
   * Authored `<signal zOffset>`: the mounting point at the housing's base.
   *
   * It is not the housing centre; measured geometry adds half the housing's
   * own height before placing the box and its relative lamp offsets.
   */
  mount_height_m?: number | null;
  /** Authored `<signal height>`/`<signal width>`, metres. */
  housing_height_m?: number | null;
  housing_width_m?: number | null;
  /** The real rendered housing and lenses on a new-cook bundle. */
  housing?: EditorSignalHousing | null;
}

export interface Map3DMeasuredSignalHousing {
  /** Exact cooked box dimensions in its local x/y/z axes, metres. */
  sizeXM: number;
  sizeYM: number;
  sizeZM: number;
  /** Housing centre above the head's ground point, metres. */
  centerHeightM: number;
  /** Housing centre offset from the assembly's mast origin, head-local metres. */
  centerForwardM: number;
  centerRightM: number;
  /** Exact measured lens centres in the assembly's local frame, top first. */
  lamps: Array<{ forwardM: number; rightM: number; heightM: number }>;
}

/**
 * Everything about a head's physical build.
 *
 * Split out from `Map3DSignalHead` because it is exactly the tuple
 * `buildSignalHeadParts` needs and exactly what `signalHeadSignature` has to
 * cover: geometry that differs between two heads must force a rebuild, and
 * lamp STATE, which changes every playhead frame, must not.
 */
export interface Map3DSignalAssembly {
  mountStyle: Map3DSignalMountStyle;
  /** New-cook mast identity. Shared heads carry the same value. */
  mastId?: string;
  /** This head draws its assembly's vertical pole. One per pole cluster. */
  poleAnchor: boolean;
  /** This head draws the arm from its mast to its own housing. */
  armAnchor: boolean;
  /** Pole base above the road, metres. Zero on the old-cook fallback. */
  poleBaseHeightM?: number;
  /** Pole top above the road, metres. */
  poleHeightM: number;
  /** Height the arm runs at, metres. Its cluster's tallest mounting. */
  armHeightM: number;
  /** Arm reach in head-local metres: how far out the farthest member hangs. */
  armForwardM: number;
  armRightM: number;
  /**
   * Present only for a new-cook housing. Geometry uses these exact measurements
   * and ignores every synthesized mast field above.
   */
  measuredHousing?: Map3DMeasuredSignalHousing;
}

export interface Map3DSignalHead {
  key: string;
  /**
   * The OpenDRIVE `<signal>` id this head IS, when it has one.
   *
   * Carried because it is the only stable identity a head shares with the rest
   * of the editor — the junction index's `signal_ids`, the plan's movement
   * bindings and the click resolver all key on it. `key` is a rendering
   * identity and is not safe to parse for one: it falls back to the actor id for
   * heads with no `<signal>`.
   */
  signalId: string | null;
  /**
   * Runtime-frame ground position this head's group is drawn at, metres.
   *
   * New cook with a mast: the measured mast x/y. New cook without one: the
   * measured housing x/y. Old cook: the synthesized assembly's pole base, with
   * the housing reached through `lampForwardM`/`lampRightM`.
   */
  runtimeX: number;
  runtimeY: number;
  /**
   * Runtime-frame ground position under this head's HOUSING, metres.
   *
   * Equal to `runtimeX`/`runtimeY` for a new-cook housing with no mast; offset
   * along its measured arm when a mast exists; roughly six metres from them on
   * the old-cook fallback. Carried so hit targets and labels can aim at the
   * rendered housing without re-deriving it.
   */
  housingRuntimeX: number;
  housingRuntimeY: number;
  /** Height of the TOP lamp's centre above the road, metres. */
  headHeightM: number;
  /** Scene `rotation.y`, radians: the head looks along its own +X. */
  rotationY: number;
  /** Housing centre offset from the group origin, head-local metres. */
  lampForwardM: number;
  lampRightM: number;
  housingHeightM: number;
  housingWidthM: number;
  lensKind: Map3DSignalLensKind;
  assembly: Map3DSignalAssembly;
  lampCount: number;
  state: Map3DSignalLampState;
  /** Index into the head's lamps (0 = top) that is currently lit. */
  litLampIndex: number;
  /** False when no authored plan names this head — forced green by default. */
  authored: boolean;
  /**
   * A translucent preview of a head that does not exist yet: what the author
   * WOULD get by placing a control on this junction. Ghosts are drawn from the
   * same geometry at the same poses as the real heads, so solidifying one moves
   * nothing.
   */
  ghost: boolean;
  /** The hovered junction's heads light brighter and lose their translucency. */
  hovered: boolean;
  junctionId: string | null;
  movementId: string | null;
}

/**
 * How a head's non-lamp parts are materialised.
 *
 * Ghost roles get their own SHARED set — three extra materials for the whole
 * scene, not three per head — because translucency cannot be turned on for one
 * head through a material every head shares. The selection glow is the same
 * trick for the same reason: at most one head is selected, so its yellow set
 * costs the scene one more copy of the role table rather than a material per
 * head.
 *
 * Selection wins over ghost: a ghost is a head that does not exist yet, and
 * clicking one is what makes it exist.
 */
export function signalPartMaterialKey(
  role: Exclude<Map3DSignalPartRole, "lamp">,
  ghost: boolean,
  selected = false,
): string {
  if (selected) return `signal:selected:${role}`;
  return ghost ? `signal:ghost:${role}` : `signal:${role}`;
}

/** Emissive on a lit lamp. Unauthored is dim, ghost dimmer, hover full. */
export const SIGNAL_LAMP_EMISSIVE = {
  authored: 1,
  unauthored: 0.28,
  ghost: 0.18,
} as const;

export function signalLampEmissiveIntensity(head: {
  authored: boolean;
  ghost: boolean;
  hovered: boolean;
}): number {
  if (head.hovered) return SIGNAL_LAMP_EMISSIVE.authored;
  if (head.ghost) return SIGNAL_LAMP_EMISSIVE.ghost;
  return head.authored
    ? SIGNAL_LAMP_EMISSIVE.authored
    : SIGNAL_LAMP_EMISSIVE.unauthored;
}

/**
 * The reconciliation key for a drawn head.
 *
 * **`ghost` is in here on purpose.** The non-lamp roles are shared materials, so
 * a head that was built as a ghost keeps translucent poles forever unless a
 * change in ghost-ness forces a rebuild. Leaving it out is the single most
 * likely bug in this feature — a placed intersection whose heads stay
 * see-through — and it is why this signature is a tested pure function rather
 * than a template literal inlined in the renderer.
 *
 * `selected` is in here for exactly the same reason — it swaps the same shared
 * materials — and it is affordable for the same reason it is not `hovered`:
 * selection changes on a click, at most once per head per click, whereas hover
 * changes on every mouse move and so has to stay a material swap on materials
 * the head already owns.
 */
export function signalHeadSignature(head: {
  lampCount: number;
  headHeightM: number;
  ghost: boolean;
  selected?: boolean;
  lensKind?: Map3DSignalLensKind;
  housingHeightM?: number;
  housingWidthM?: number;
  lampForwardM?: number;
  lampRightM?: number;
  assembly?: Map3DSignalAssembly;
}): string {
  const two = (value: number | undefined, fallback: number): string =>
    (Number.isFinite(value) ? (value as number) : fallback).toFixed(2);
  const assembly = head.assembly;
  const four = (value: number | undefined, fallback: number): string =>
    (Number.isFinite(value) ? (value as number) : fallback).toFixed(4);
  // Every geometric input to `buildSignalHeadParts`, and nothing else. The pole
  // and arm flags are in here because a head that lost its pole to a
  // better-placed neighbour must rebuild without it; leaving them out strands a
  // pole in mid-air when the cluster's membership changes.
  const measured = assembly?.measuredHousing;
  const measuredSignature = measured
    ? [
        "measured",
        four(measured.sizeXM, 0),
        four(measured.sizeYM, 0),
        four(measured.sizeZM, 0),
        four(measured.centerHeightM, 0),
        four(measured.centerForwardM, 0),
        four(measured.centerRightM, 0),
        ...measured.lamps.flatMap((lamp) => [
          four(lamp.forwardM, 0),
          four(lamp.rightM, 0),
          four(lamp.heightM, 0),
        ]),
      ].join(",")
    : "fallback";
  return [
    head.lampCount,
    two(head.headHeightM, DEFAULT_HEAD_HEIGHT_M),
    head.ghost ? "ghost" : "solid",
    head.selected ? "selected" : "-",
    head.lensKind ?? "ball",
    two(head.housingHeightM, DEFAULT_HOUSING_HEIGHT_M),
    two(head.housingWidthM, DEFAULT_HOUSING_WIDTH_M),
    two(head.lampForwardM, 0),
    two(head.lampRightM, 0),
    assembly?.mountStyle ?? "post",
    assembly?.poleAnchor ? "pole" : "-",
    assembly?.armAnchor ? "arm" : "-",
    two(assembly?.poleBaseHeightM, 0),
    two(assembly?.poleHeightM, 0),
    two(assembly?.armHeightM, 0),
    two(assembly?.armForwardM, 0),
    two(assembly?.armRightM, 0),
    measuredSignature,
  ].join(":");
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** OpenDRIVE signal id -> the authored movement that drives it. */
export function signalIdToMovementIndex(
  plans: readonly JunctionSignalPlan[],
): Map<string, { junctionId: string; movementId: string }> {
  const index = new Map<string, { junctionId: string; movementId: string }>();
  for (const plan of plans) {
    for (const movement of plan.movements ?? []) {
      for (const signalId of movement.signal_ids ?? []) {
        const key = String(signalId).trim();
        // First binding wins: a signal id claimed by two movements is a plan
        // authoring problem, and picking arbitrarily beats flickering.
        if (key && !index.has(key)) {
          index.set(key, {
            junctionId: plan.junction_id,
            movementId: movement.movement_id,
          });
        }
      }
    }
  }
  return index;
}

export interface HeadLampResolution {
  state: Map3DSignalLampState;
  authored: boolean;
}

/**
 * What a head shows at time `t`.
 *
 * Every path that is not an explicitly authored colour lands on green with
 * `authored: false` — see the module header for why that is the honest default
 * rather than grey.
 */
export function resolveHeadLampState(
  plan: JunctionSignalPlan | null | undefined,
  movementId: string | null | undefined,
  timestampSeconds: number,
): HeadLampResolution {
  if (!plan || !movementId) return { state: "green", authored: false };
  if (plan.mode === "map_default") return { state: "green", authored: false };
  const state = planStatesAt(plan, timestampSeconds)[movementId];
  if (!state) return { state: "green", authored: false };
  return { state, authored: true };
}

/**
 * Lamp count from the cook's best available measurement.
 *
 * A new-cook `housing.lamps` array is genuine per-lens data and wins outright.
 * On old-cook bundles, **counts of 0 and 1 are not lamp counts**: 1 is the box
 * around the whole uniform housing, while 0 is the new manager reporting no
 * legacy boxes. Both resolve to the standard three-lamp fallback.
 */
export function resolveLampCount(source: Map3DSignalHeadSource): number {
  if (source.housing) return source.housing.lamps.length;
  const count = finite(source.light_box_count)
    ? source.light_box_count
    : source.light_boxes?.length;
  if (finite(count) && count >= 2 && count <= 5) return count;
  return 3;
}

/**
 * Height of the top lens above the head's ground point, metres.
 *
 * New-cook `height_above_ground_m` is the authored `<signal zOffset>` mounting
 * point at the housing's base. The housing centre is therefore one half of its
 * measured height above that point. Lens `z` values are absolute, so they
 * become relative by subtracting the housing's absolute centre `z` and adding
 * that corrected centre height. The old cook has no housing and stays at its
 * rigid {@link SIGNAL_COOKED_HOUSING_HEIGHT_M}; `mount_height_m` and
 * `lamp_height_m` remain intentionally ignored on that path.
 *
 * This never treats either the actor's or the housing's absolute elevation as a
 * height above the road.
 */
export function resolveHeadHeightM(source: Map3DSignalHeadSource): number {
  const housing = source.housing;
  const topLamp = housing?.lamps[0];
  if (
    housing &&
    topLamp &&
    finite(housing.z) &&
    finite(housing.height_above_ground_m) &&
    finite(housing.size_z) &&
    finite(topLamp.z)
  ) {
    const centerHeightM =
      housing.height_above_ground_m + housing.size_z / 2;
    return centerHeightM + topLamp.z - housing.z;
  }
  return SIGNAL_COOKED_HOUSING_HEIGHT_M;
}

/**
 * Whether this row is a signal head at all.
 *
 * 22 of Di Rosa's 103 rows and 24 of San Ramon P1's 147 are RoadRunner debris:
 * `zOffset`, `height` and `width` all zero, no asset name. CARLA spawns an actor
 * for each, so they arrive here carrying the blueprint's rigid pose and are
 * otherwise indistinguishable from real heads — and 21 of 22 stand more than
 * 1.5 m from any real head, so they are not duplicates of anything, just
 * phantoms. Yale has none, which is what makes this per-map authoring debris
 * rather than a pipeline defect.
 *
 * The test is deliberately CONJUNCTIVE, and deliberately does not apply to a
 * source carrying no XODR attributes at all: a head with `mount_style: null` but
 * a real `housing_height_m` is a named-asset gap, and a source with all four
 * fields absent (street furniture, a v1 bundle, a test fixture) must keep
 * drawing exactly as it did before.
 */
export function isDrawableHead(source: Map3DSignalHeadSource): boolean {
  if (source.housing) return true;
  const hasAttributes =
    source.mount_style !== undefined ||
    source.mount_height_m !== undefined ||
    source.housing_height_m !== undefined ||
    source.housing_width_m !== undefined;
  if (!hasAttributes) return true;
  const zero = (value: number | null | undefined): boolean =>
    value == null || !finite(value) || value <= 0;
  return !(
    source.mount_style == null &&
    zero(source.mount_height_m) &&
    zero(source.housing_height_m) &&
    zero(source.housing_width_m)
  );
}

/**
 * Which mounting hardware to build.
 *
 * `post` is the default rather than an "unknown" variant because a head that
 * survived {@link isDrawableHead} has a real housing somewhere and something has
 * to hold it up, and a head that lost only its asset NAME is far likelier to be
 * the corpus's commonest asset than to be one of the three that hang off other
 * hardware. {@link MOUNT_DRAWS_UPRIGHT} then decides whether this head draws a
 * pole.
 */
export function resolveMountStyle(
  source: Map3DSignalHeadSource,
): Map3DSignalMountStyle {
  return source.mount_style ?? "post";
}

/** Housing size from the real cooked box, then XODR, then the common fallback. */
export function resolveHousingSizeM(source: Map3DSignalHeadSource): {
  heightM: number;
  widthM: number;
} {
  if (source.housing) {
    return {
      heightM: source.housing.size_z,
      widthM: source.housing.size_y,
    };
  }
  const height = source.housing_height_m;
  const width = source.housing_width_m;
  return {
    heightM: finite(height) && height > 0 ? height : DEFAULT_HOUSING_HEIGHT_M,
    widthM: finite(width) && width > 0 ? width : DEFAULT_HOUSING_WIDTH_M,
  };
}

const LENS_KIND_BY_TURN: Record<string, Map3DSignalLensKind | undefined> = {
  left: "left",
  right: "right",
  uturn: "left",
};

/**
 * OpenDRIVE signal id -> the arrow it should show, for protected turns only.
 *
 * A head is a protected-turn head when, within its own approach, the movements
 * it drives are all the same non-through turn AND at least one other head on
 * that approach drives a different turn. Both halves matter:
 *
 * - "all the same turn" is what makes it an arrow rather than a ball;
 * - "the approach has other turns too" is what makes it PROTECTED rather than
 *   merely a head on an approach where only one turn happens to be authored.
 *   Without that clause, every head on a one-movement approach sprouts an arrow.
 *
 * This is `refineMovementSignalIds`' per-connecting-road split showing through
 * the plan, which is the only place in the pipeline that genuinely distinguishes
 * a protected left. It is NOT `<signal subtype>`, which the corpus disproves —
 * see `editor-traffic-lights.ts`.
 *
 * `uturn` resolves to a left arrow: it is the closest true glyph, and a U-turn
 * head is a left-arrow variant on the street.
 */
export function signalLensKindIndex(
  plans: readonly JunctionSignalPlan[],
): Map<string, Map3DSignalLensKind> {
  const index = new Map<string, Map3DSignalLensKind>();
  for (const plan of plans) {
    // approach id -> signal id -> the set of turns that signal drives
    const byApproach = new Map<string, Map<string, Set<string>>>();
    for (const movement of plan.movements ?? []) {
      const movementId = movement.movement_id ?? "";
      const split = movementId.lastIndexOf(":");
      if (split <= 0) continue;
      const approachId = movementId.slice(0, split);
      const turn = movementId.slice(split + 1);
      if (!turn) continue;
      let bySignal = byApproach.get(approachId);
      if (!bySignal) {
        bySignal = new Map();
        byApproach.set(approachId, bySignal);
      }
      for (const signalId of movement.signal_ids ?? []) {
        const key = String(signalId).trim();
        if (!key) continue;
        const turns = bySignal.get(key) ?? new Set<string>();
        turns.add(turn);
        bySignal.set(key, turns);
      }
    }

    for (const bySignal of byApproach.values()) {
      const turnsOnApproach = new Set<string>();
      for (const turns of bySignal.values()) {
        for (const turn of turns) turnsOnApproach.add(turn);
      }
      // One turn authored across the whole approach is not a protected turn, it
      // is an approach with one movement. Nothing on it is an arrow.
      if (turnsOnApproach.size < 2) continue;
      for (const [signalId, turns] of bySignal) {
        if (turns.size !== 1) continue;
        const lens = LENS_KIND_BY_TURN[[...turns][0] ?? ""];
        // First binding wins, matching `signalIdToMovementIndex`: a head claimed
        // by two approaches is an authoring problem, and picking deterministically
        // beats flickering between playhead frames.
        if (lens && !index.has(signalId)) index.set(signalId, lens);
      }
    }
  }
  return index;
}

/**
 * Which lamp lights up on a head with `lampCount` lamps.
 *
 * A standard three-lamp head is red/yellow/green top to bottom. A two-lamp head
 * (CARLA does report some) drops yellow, and a one-lamp head is a single
 * repurposed lens.
 */
export function litLampIndexFor(
  state: Map3DSignalLampState,
  lampCount: number,
): number {
  if (lampCount <= 1) return 0;
  if (lampCount === 2) return state === "green" ? 1 : 0;
  const index = LAMP_ORDER.indexOf(state);
  return index < 0 ? 0 : Math.min(index, lampCount - 1);
}

/**
 * A head's runtime-frame ground position, metres.
 *
 * Flat `x`/`y` are already runtime. `location` is the raw bundle row's CARLA
 * pose and is CONVERTED, not copied: `carla_y == -runtime_y`, and the two
 * disagree in sign on 100% of measured rows, so reading it naively mirrors the
 * head to the wrong side of the map.
 */
export function headRuntimePoint(
  source: Map3DSignalHeadSource,
): { x: number; y: number } | null {
  if (finite(source.x) && finite(source.y)) return { x: source.x, y: source.y };
  const carlaX = source.location?.x;
  const carlaY = source.location?.y;
  if (!finite(carlaX) || !finite(carlaY)) return null;
  const runtime = carlaPointToRuntimePoint({ x: carlaX, y: carlaY });
  return { x: runtime.x, y: runtime.y };
}

/**
 * Where this head's HOUSING stands in the runtime frame, metres.
 *
 * New-cook bundles carry the exact point. Old-cook bundles fall back to the
 * measured mast-arm bearing and reach from the actor/authored pole base.
 *
 * `null` when the head has no resolvable pose.
 */
export function headHousingRuntimePoint(
  source: Map3DSignalHeadSource,
): { x: number; y: number } | null {
  if (finite(source.housing?.x) && finite(source.housing?.y)) {
    return { x: source.housing.x, y: source.housing.y };
  }
  const origin = headRuntimePoint(source);
  if (!origin) return null;
  const bearing =
    ((headFacingYawDegrees(source) + SIGNAL_MAST_ARM_BEARING_FROM_FACING_DEG) *
      Math.PI) /
    180;
  return {
    x: origin.x + SIGNAL_MAST_ARM_LENGTH_M * Math.cos(bearing),
    y: origin.y + SIGNAL_MAST_ARM_LENGTH_M * Math.sin(bearing),
  };
}

/** A stop point's runtime-frame position, from either the flat or nested shape. */
function stopRuntimePoint(
  point: NonNullable<NonNullable<Map3DSignalHeadSource["stop_waypoints"]>[number]>,
): { x: number; y: number } | null {
  if (finite(point.x) && finite(point.y)) return { x: point.x, y: point.y };
  const carla = point.transform?.location;
  if (!finite(carla?.x) || !finite(carla?.y)) return null;
  const runtime = carlaPointToRuntimePoint({ x: carla.x, y: carla.y });
  return { x: runtime.x, y: runtime.y };
}

/**
 * Runtime yaw, degrees: the direction this head's lenses point.
 *
 * An AUTHORED head already knows. `<signal hOffset>` plus its road's heading,
 * flipped by `orientation`, is the facing RoadRunner gave it, and the index
 * ships that as `yaw` — so there is nothing to infer and inferring anyway would
 * be strictly worse.
 *
 * Everything below is the fallback for a head with no `<signal>`: aim it at the
 * first usable stop point, since that is where the traffic it governs comes to
 * rest, and failing that use the actor's own yaw. Both stop-point shapes are
 * accepted and the nested one is CONVERTED rather than copied, because a copied
 * `y` mirrors the stop line and aims the head roughly backwards.
 */
export function headFacingYawDegrees(source: Map3DSignalHeadSource): number {
  if (source.facing_source === "authored" && finite(source.yaw)) return source.yaw;
  const origin = headRuntimePoint(source);
  if (origin) {
    for (const point of source.stop_waypoints ?? []) {
      if (point == null) continue;
      const stop = stopRuntimePoint(point);
      if (!stop) continue;
      const dx = stop.x - origin.x;
      const dy = stop.y - origin.y;
      if (Math.hypot(dx, dy) > 1e-6) {
        return (Math.atan2(dy, dx) * 180) / Math.PI;
      }
    }
  }
  return finite(source.yaw) ? source.yaw : 0;
}

export interface BuildMap3DSignalHeadsInput {
  sources: readonly Map3DSignalHeadSource[] | null | undefined;
  plans: readonly JunctionSignalPlan[];
  timestampSeconds: number;
  /** Runtime-frame centre heads are ranked against; heads beyond `radiusM` drop. */
  center: { x: number; y: number } | null;
  radiusM: number;
  maxHeads?: number;
}

function measuredHousingGeometry(
  housing: EditorSignalHousing,
  mountingHeightM: number,
  centerOffset: { forward: number; right: number },
): Map3DMeasuredSignalHousing {
  const yaw = (housing.yaw * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  // OpenDRIVE `zOffset` marks the housing's bottom mounting point. Cooked
  // `housing.z` is the box centre, so the whole measured assembly — box and
  // lenses alike — is raised by half this housing's own measured height.
  const centerHeightM = mountingHeightM + housing.size_z / 2;
  return {
    sizeXM: housing.size_x,
    sizeYM: housing.size_y,
    sizeZM: housing.size_z,
    centerHeightM,
    centerForwardM: centerOffset.forward,
    centerRightM: centerOffset.right,
    lamps: housing.lamps.map((lamp) => {
      const dx = lamp.x - housing.x;
      const dy = lamp.y - housing.y;
      return {
        // Inverse of the renderer's local-to-runtime transform:
        // dx = forward*cos + right*sin
        // dy = forward*sin - right*cos
        forwardM: centerOffset.forward + dx * cos + dy * sin,
        rightM: centerOffset.right + dx * sin - dy * cos,
        heightM: centerHeightM + lamp.z - housing.z,
      };
    }),
  };
}

/** Runtime-frame offset expressed in a head's local (+forward, +right) frame. */
function runtimeOffsetToHeadLocal(
  dx: number,
  dy: number,
  yawDegrees: number,
): { forward: number; right: number } {
  const yaw = (yawDegrees * Math.PI) / 180;
  return {
    forward: dx * Math.cos(yaw) + dy * Math.sin(yaw),
    right: dx * Math.sin(yaw) - dy * Math.cos(yaw),
  };
}

function validMast(housing: EditorSignalHousing): EditorSignalMast | null {
  const mast = housing.mast;
  if (
    !mast ||
    !mast.id.trim() ||
    !finite(mast.x) ||
    !finite(mast.y) ||
    !finite(mast.base_height_m) ||
    !finite(mast.top_height_m) ||
    mast.top_height_m <= mast.base_height_m
  ) {
    return null;
  }
  return mast;
}

/**
 * Poses + state for every head worth drawing, nearest-first within `radiusM`.
 *
 * Heads are capped rather than screen-clustered: 3D mode draws real objects, and
 * a cluster bubble is a 2D affordance. `TrafficLightLayers`' clustered dots
 * remain exactly as they are and are what 2D mode still shows.
 *
 * New-cook heads use the measured housing pose plus their measured mast and
 * arm. Old-cook heads preserve the measured uniform mast assembly, including
 * its narrowly shared-upright fallback.
 */
export function buildMap3DSignalHeads({
  sources,
  plans,
  timestampSeconds,
  center,
  radiusM,
  maxHeads = MAP_3D_MAX_SIGNAL_HEADS,
}: BuildMap3DSignalHeadsInput): Map3DSignalHead[] {
  if (!sources?.length) return [];

  const movementBySignalId = signalIdToMovementIndex(plans);
  const lensBySignalId = signalLensKindIndex(plans);
  const planByJunction = new Map(plans.map((plan) => [plan.junction_id, plan]));
  const radiusSquared = radiusM * radiusM;
  const heads: (Map3DSignalHead & { distanceSquared: number })[] = [];

  for (const [index, source] of sources.entries()) {
    if (!isDrawableHead(source)) continue;
    const headPoint = headRuntimePoint(source);
    const housingPoint = headHousingRuntimePoint(source);
    if (!headPoint || !housingPoint) continue;
    const hasMeasuredHousing =
      source.housing && finite(source.housing.height_above_ground_m);
    const facing = hasMeasuredHousing
      ? source.housing!.yaw
      : headFacingYawDegrees(source);
    const mast = hasMeasuredHousing ? validMast(source.housing!) : null;
    // A measured mast is the shared group origin. Without one, a new-cook head
    // remains rooted at its housing and draws no invented mounting hardware.
    const x = mast ? mast.x : hasMeasuredHousing ? housingPoint.x : headPoint.x;
    const y = mast ? mast.y : hasMeasuredHousing ? housingPoint.y : headPoint.y;
    const measuredOffset = hasMeasuredHousing
      ? runtimeOffsetToHeadLocal(
          housingPoint.x - x,
          housingPoint.y - y,
          facing,
        )
      : null;
    const measuredHousing =
      hasMeasuredHousing
      ? measuredHousingGeometry(
          source.housing!,
          source.housing!.height_above_ground_m!,
          measuredOffset!,
        )
      : null;

    // Rank and cull by the clickable housing, not by the far end of a long mast
    // arm, so adding measured hardware cannot make a visible head disappear.
    const cullPoint = measuredHousing ? housingPoint : headPoint;
    const dx = center ? cullPoint.x - center.x : 0;
    const dy = center ? cullPoint.y - center.y : 0;
    const distanceSquared = dx * dx + dy * dy;
    if (center && distanceSquared > radiusSquared) continue;

    const openDriveId =
      source.opendrive_id != null ? String(source.opendrive_id).trim() : "";
    const movement = openDriveId ? movementBySignalId.get(openDriveId) : undefined;
    const plan = movement ? planByJunction.get(movement.junctionId) : undefined;
    const { state, authored } = resolveHeadLampState(
      plan,
      movement?.movementId,
      timestampSeconds,
    );
    const lampCount = resolveLampCount(source);
    const housingSize = resolveHousingSizeM(source);
    const arm = measuredHousing
      ? measuredOffset!
      : mastArmHeadLocalOffset();
    const measuredArmReach = measuredHousing
      ? Math.hypot(arm.forward, arm.right)
      : SIGNAL_MAST_ARM_LENGTH_M;

    heads.push({
      // Stable under culling. The array index used to be part of this, which
      // made a head's identity depend on how many OTHER heads survived the
      // radius filter — so panning the camera renamed heads and forced the
      // renderer to rebuild meshes it already had. `<signal>` ids are unique
      // per physical head (verified: `vectorSignal` GUIDs are 1:1 with ids on
      // all four measured maps), so the id alone identifies one.
      key: openDriveId
        ? `signal-${openDriveId}${source.pole_index != null ? `-${source.pole_index}` : ""}`
        : `signal-actor-${source.actor_id ?? index}`,
      signalId: openDriveId || null,
      // New cook: exact mast position when available, otherwise the housing.
      // Old cook: exact synthesized pole base.
      runtimeX: x,
      runtimeY: y,
      housingRuntimeX: housingPoint.x,
      housingRuntimeY: housingPoint.y,
      headHeightM: resolveHeadHeightM(source),
      rotationY: runtimeYawToSceneRotationY(facing),
      lampForwardM: arm.forward,
      lampRightM: arm.right,
      housingHeightM: housingSize.heightM,
      housingWidthM: housingSize.widthM,
      lensKind: (openDriveId ? lensBySignalId.get(openDriveId) : undefined) ?? "ball",
      assembly: {
        mountStyle: resolveMountStyle(source),
        ...(mast ? { mastId: mast.id } : {}),
        poleAnchor: measuredHousing ? mast != null : true,
        armAnchor: measuredHousing
          ? mast != null && measuredArmReach >= SIGNAL_MAST_ARM_MIN_LENGTH_M
          : true,
        ...(measuredHousing
          ? { poleBaseHeightM: mast?.base_height_m ?? 0 }
          : {}),
        poleHeightM: measuredHousing
          ? (mast?.top_height_m ?? 0)
          : SIGNAL_COOKED_POLE_TOP_M,
        armHeightM: measuredHousing
          ? source.housing!.height_above_ground_m!
          : SIGNAL_COOKED_HOUSING_HEIGHT_M + POLE_CAP_M,
        armForwardM: arm.forward,
        armRightM: arm.right,
        ...(measuredHousing ? { measuredHousing } : {}),
      },
      lampCount,
      state,
      litLampIndex: litLampIndexFor(state, lampCount),
      authored,
      ghost: false,
      hovered: false,
      junctionId: movement?.junctionId ?? null,
      movementId: movement?.movementId ?? null,
      distanceSquared,
    });
  }

  heads.sort(
    (left, right) =>
      left.distanceSquared - right.distanceSquared || left.key.localeCompare(right.key),
  );
  return shareCoLocatedUprights(
    heads
      .slice(0, Math.max(0, maxHeads))
      .map(({ distanceSquared: _distanceSquared, ...head }) => head),
  );
}

/**
 * The housing's offset from its own upright, head-local metres.
 *
 * Constant, because the cooked mast is: `SIGNAL_MAST_ARM_LENGTH_M` at
 * `facing + SIGNAL_MAST_ARM_BEARING_FROM_FACING_DEG`, rotated into the head's
 * own frame, reduces to `(L cos 94, -L sin 94)` with no dependence on the facing
 * at all. Computed rather than hard-coded so the two constants stay the single
 * place either number is stated.
 */
function mastArmHeadLocalOffset(): { forward: number; right: number } {
  const bearing = (SIGNAL_MAST_ARM_BEARING_FROM_FACING_DEG * Math.PI) / 180;
  return {
    forward: SIGNAL_MAST_ARM_LENGTH_M * Math.cos(bearing),
    right: -SIGNAL_MAST_ARM_LENGTH_M * Math.sin(bearing),
  };
}

/**
 * Let heads standing on the same physical upright draw it once.
 *
 * New-cook heads merge STRICTLY on measured `mast.id`; nearby but distinct
 * poles must stay distinct. Old-cook fallback heads have no identity and retain
 * the narrow co-located-base rule ({@link ASSEMBLY_POLE_RADIUS_M}). The arm is
 * never shared: each head reaches from the common pole to its own housing.
 *
 * Leader-based against the caller's nearest-first order, so the head that keeps
 * the upright is a stable choice and does not depend on input order beyond the
 * sort already applied.
 */
function shareCoLocatedUprights(heads: Map3DSignalHead[]): Map3DSignalHead[] {
  const measuredMastIds = new Set<string>();
  const fallbackAnchors: Map3DSignalHead[] = [];
  return heads.map((head) => {
    if (!head.assembly.poleAnchor) return head;
    const mastId = head.assembly.mastId?.trim();
    if (mastId) {
      if (!measuredMastIds.has(mastId)) {
        measuredMastIds.add(mastId);
        return head;
      }
      return { ...head, assembly: { ...head.assembly, poleAnchor: false } };
    }

    const shared = fallbackAnchors.find(
      (anchor) =>
        Math.hypot(anchor.runtimeX - head.runtimeX, anchor.runtimeY - head.runtimeY) <=
        ASSEMBLY_POLE_RADIUS_M,
    );
    if (!shared) {
      fallbackAnchors.push(head);
      return head;
    }
    return { ...head, assembly: { ...head.assembly, poleAnchor: false } };
  });
}


// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type Map3DSignalPartRole =
  | "pole"
  /** The mast arm reaching out over the roadway. */
  | "arm"
  /** The short vertical hanger from the arm down to one housing. */
  | "drop"
  | "housing"
  | "backplate"
  /** The dark recess an arrow glyph sits in. Never lit. */
  | "lens"
  | "lamp";

export interface Map3DSignalPart {
  shape: "box" | "cylinder";
  role: Map3DSignalPartRole;
  /** Local frame: +X is the direction the head looks, +Y up, +Z to its right. */
  position: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  radius?: number;
  length?: number;
  axis?: "x" | "y" | "z";
  /**
   * Extra local rotations, radians, applied before translation. `rotationX`
   * spins a part within the lens plane (this is what aims an arrow glyph);
   * `rotationY` swings it in the ground plane (this is what aims the mast arm).
   */
  rotationX?: number;
  rotationY?: number;
  /** Set on `lamp` parts only: which lamp this is, counting from the top. */
  lampIndex?: number;
}

/** Everything `buildSignalHeadParts` needs. See {@link Map3DSignalHead}. */
export interface Map3DSignalHeadGeometrySpec {
  lampCount: number;
  /** Height of the TOP lamp's centre above the road, metres. */
  headHeightM: number;
  housingHeightM: number;
  housingWidthM: number;
  lensKind: Map3DSignalLensKind;
  lampForwardM: number;
  lampRightM: number;
  assembly: Map3DSignalAssembly;
}

/**
 * Uniform visual scale on the head assembly. Real US heads are ~0.075 m pole /
 * 0.13 m lenses, which reads as a toothpick from editor viewing distances; the
 * mounting height stays survey-true while the assembly itself is enlarged for
 * legibility.
 */
const SIGNAL_MODEL_SCALE = 1.5;
export const SIGNAL_POLE_RADIUS_M = 0.075 * SIGNAL_MODEL_SCALE;
export const SIGNAL_LAMP_RADIUS_M = 0.13 * SIGNAL_MODEL_SCALE;
const HOUSING_DEPTH_M = 0.24 * SIGNAL_MODEL_SCALE;
const ARM_THICKNESS_M = 0.09 * SIGNAL_MODEL_SCALE;
const DROP_THICKNESS_M = 0.06 * SIGNAL_MODEL_SCALE;

/**
 * Pole radius per mounting style, as a multiple of {@link SIGNAL_POLE_RADIUS_M}.
 *
 * Only `post` draws a pole at all ({@link MOUNT_DRAWS_UPRIGHT}), so in practice
 * only its entry is ever read. The other three are kept so the table stays total
 * over the style union — a new RoadRunner asset that does own an upright gets a
 * sane radius rather than `undefined` and a `NaN` mesh.
 */
const POLE_RADIUS_BY_MOUNT: Record<Map3DSignalMountStyle, number> = {
  post: 1,
  bracket: 0.72,
  side: 0.72,
  bare: 0.55,
};

/**
 * The head's meshes, built once per geometry signature and shared by every head
 * with the same one — the renderer instances them rather than rebuilding a group
 * per playhead frame, because 120 multi-mesh heads torn down and rebuilt at
 * 20 Hz is exactly the pathology the docked viewport has.
 *
 * With `assembly.measuredHousing`, the origin is the measured mast when one was
 * assigned and otherwise the housing itself. The returned parts use the exact
 * housing/lens measurements plus at most one shared pole and one arm per head.
 * No drop or inferred backplate is emitted.
 *
 * Without it, every calculation below is the old-cook fallback: its actor pose
 * is the pole base, its housing hangs at the fixed mast-arm offset, and lamps
 * are subdivided downward from `headHeightM`.
 */
export function buildSignalHeadParts(
  spec: Map3DSignalHeadGeometrySpec,
): Map3DSignalPart[] {
  const {
    lampCount,
    headHeightM,
    housingHeightM,
    housingWidthM,
    lensKind,
    lampForwardM,
    lampRightM,
    assembly,
  } = spec;

  const mountingParts = buildMastParts(assembly);
  if (assembly.measuredHousing) {
    return [
      ...mountingParts,
      ...buildMeasuredHousingParts(assembly.measuredHousing, lensKind),
    ];
  }

  const lamps = Math.max(1, Math.min(5, Math.round(lampCount)));
  // The authored housing is a real measurement (1.08-1.46 m tall), so the lamp
  // pitch is derived FROM it rather than the housing being derived from a fixed
  // pitch. A head with more lenses than a three-section housing has room for
  // simply packs them tighter, which is what a real 4- or 5-section head does.
  const housingHeight = Math.max(0.3, housingHeightM) * SIGNAL_MODEL_SCALE;
  const housingWidth = Math.max(0.2, housingWidthM) * SIGNAL_MODEL_SCALE;
  const lampPitch = (housingHeight * 0.92) / lamps;
  const lensRadius = Math.min(lampPitch * 0.42, housingWidth * 0.36);

  const topLampY = headHeightM;
  const housingCenterY = topLampY - (lamps - 1) * lampPitch * 0.5;
  const housingTopY = housingCenterY + housingHeight / 2;
  const armY = Math.max(assembly.armHeightM, housingTopY);

  const parts: Map3DSignalPart[] = [...mountingParts];

  // Every head hangs from the arm on its own drop, however short.
  const dropHeight = Math.max(0.04, armY - housingTopY);
  parts.push({
    shape: "box",
    role: "drop",
    position: {
      x: lampForwardM,
      y: housingTopY + dropHeight / 2,
      z: lampRightM,
    },
    size: { x: DROP_THICKNESS_M, y: dropHeight, z: DROP_THICKNESS_M },
  });

  parts.push({
    shape: "box",
    role: "housing",
    position: { x: lampForwardM, y: housingCenterY, z: lampRightM },
    size: { x: HOUSING_DEPTH_M, y: housingHeight, z: housingWidth },
  });
  // The backplate is what makes a head read as a head at a distance: a dark
  // rectangle behind the lenses, which is exactly why real ones exist.
  parts.push({
    shape: "box",
    role: "backplate",
    position: {
      x: lampForwardM - HOUSING_DEPTH_M * 0.55,
      y: housingCenterY,
      z: lampRightM,
    },
    size: {
      x: 0.03 * SIGNAL_MODEL_SCALE,
      y: housingHeight * 1.24,
      z: housingWidth * 1.5,
    },
  });

  const faceX = lampForwardM + HOUSING_DEPTH_M / 2 + 0.02 * SIGNAL_MODEL_SCALE;
  for (let index = 0; index < lamps; index += 1) {
    const y = topLampY - index * lampPitch;
    if (lensKind === "ball") {
      parts.push({
        shape: "cylinder",
        role: "lamp",
        axis: "x",
        lampIndex: index,
        radius: lensRadius,
        length: 0.06 * SIGNAL_MODEL_SCALE,
        position: { x: faceX, y, z: lampRightM },
        size: { x: 0.06 * SIGNAL_MODEL_SCALE, y: lensRadius * 2, z: lensRadius * 2 },
      });
      continue;
    }
    // An arrow head is a dark recess with a lit glyph in it: the disc must NOT
    // be the lamp, or a protected left glows as a full ball and the arrow is
    // invisible against it.
    parts.push({
      shape: "cylinder",
      role: "lens",
      axis: "x",
      radius: lensRadius,
      length: 0.05 * SIGNAL_MODEL_SCALE,
      position: { x: faceX - 0.01, y, z: lampRightM },
      size: { x: 0.05 * SIGNAL_MODEL_SCALE, y: lensRadius * 2, z: lensRadius * 2 },
    });
    parts.push(
      ...arrowGlyphParts({
        lensKind,
        lampIndex: index,
        radius: lensRadius,
        centerX: faceX + 0.015,
        centerY: y,
        centerZ: lampRightM,
      }),
    );
  }

  return parts;
}

function buildMastParts(assembly: Map3DSignalAssembly): Map3DSignalPart[] {
  const parts: Map3DSignalPart[] = [];
  if (assembly.poleAnchor) {
    const base = finite(assembly.poleBaseHeightM)
      ? assembly.poleBaseHeightM
      : 0;
    const top = Math.max(base + 0.5, assembly.poleHeightM);
    const length = top - base;
    const radius = SIGNAL_POLE_RADIUS_M * POLE_RADIUS_BY_MOUNT[assembly.mountStyle];
    parts.push({
      shape: "cylinder",
      role: "pole",
      axis: "y",
      radius,
      length,
      position: { x: 0, y: base + length / 2, z: 0 },
      size: { x: radius * 2, y: length, z: radius * 2 },
    });
  }

  const reach = Math.hypot(assembly.armForwardM, assembly.armRightM);
  if (assembly.armAnchor && reach >= SIGNAL_MAST_ARM_MIN_LENGTH_M) {
    parts.push({
      shape: "box",
      role: "arm",
      // three's `rotateY(t)` sends local +X to `(cos t, 0, -sin t)`, so this is
      // the angle that aims the arm's long axis down the reach vector.
      rotationY: Math.atan2(-assembly.armRightM, assembly.armForwardM),
      position: {
        x: assembly.armForwardM / 2,
        y: assembly.armHeightM,
        z: assembly.armRightM / 2,
      },
      size: { x: reach, y: ARM_THICKNESS_M, z: ARM_THICKNESS_M },
    });
  }
  return parts;
}

function buildMeasuredHousingParts(
  housing: Map3DMeasuredSignalHousing,
  lensKind: Map3DSignalLensKind,
): Map3DSignalPart[] {
  const parts: Map3DSignalPart[] = [
    {
      shape: "box",
      role: "housing",
      position: {
        x: housing.centerForwardM,
        y: housing.centerHeightM,
        z: housing.centerRightM,
      },
      // Runtime/cooked z is vertical; scene y is vertical. The housing's local
      // cooked x/y axes become scene x/z under the root's measured yaw.
      size: { x: housing.sizeXM, y: housing.sizeZM, z: housing.sizeYM },
    },
  ];

  for (const [index, lamp] of housing.lamps.entries()) {
    const radius = SIGNAL_LAMP_RADIUS_M;
    if (lensKind === "ball") {
      parts.push({
        shape: "cylinder",
        role: "lamp",
        axis: "x",
        lampIndex: index,
        radius,
        length: 0.06 * SIGNAL_MODEL_SCALE,
        position: {
          x: lamp.forwardM,
          y: lamp.heightM,
          z: lamp.rightM,
        },
        size: {
          x: 0.06 * SIGNAL_MODEL_SCALE,
          y: radius * 2,
          z: radius * 2,
        },
      });
      continue;
    }

    parts.push({
      shape: "cylinder",
      role: "lens",
      axis: "x",
      radius,
      length: 0.05 * SIGNAL_MODEL_SCALE,
      position: {
        x: lamp.forwardM - 0.01,
        y: lamp.heightM,
        z: lamp.rightM,
      },
      size: {
        x: 0.05 * SIGNAL_MODEL_SCALE,
        y: radius * 2,
        z: radius * 2,
      },
    });
    parts.push(
      ...arrowGlyphParts({
        lensKind,
        lampIndex: index,
        radius,
        centerX: lamp.forwardM + 0.015,
        centerY: lamp.heightM,
        centerZ: lamp.rightM,
      }),
    );
  }

  return parts;
}

/**
 * The three boxes that make an arrow: a shaft and two barbs.
 *
 * ## Which way is "left"
 *
 * The head's local `+X` is its VIEWING direction, so the driver reading it is in
 * front of the head looking back along `-X`. The driver's forward bearing is
 * therefore `facing + 180`, and their left is `facing + 270`, which is
 * `facing - 90` — and `facing - 90` is precisely the head's local `+Z` (see
 * {@link runtimeOffsetToHeadLocal}). **A left arrow points along local +Z.**
 *
 * Getting this backwards puts a right arrow on every protected left, which is
 * the kind of wrong that looks completely fine until someone reads it.
 *
 * Angles run from `+Y` (straight up, a through arrow) toward `+Z`, which is what
 * three's `rotateX` does to a `+Y`-long box: `(0,1,0) -> (0, cos a, sin a)`.
 */
function arrowGlyphParts({
  lensKind,
  lampIndex,
  radius,
  centerX,
  centerY,
  centerZ,
}: {
  lensKind: Exclude<Map3DSignalLensKind, "ball">;
  lampIndex: number;
  radius: number;
  centerX: number;
  centerY: number;
  centerZ: number;
}): Map3DSignalPart[] {
  const HALF_PI = Math.PI / 2;
  const angle =
    lensKind === "left" ? HALF_PI : lensKind === "right" ? -HALF_PI : 0;
  const depth = 0.05 * SIGNAL_MODEL_SCALE;
  const thickness = radius * 0.42;

  const along = (a: number, distance: number) => ({
    y: centerY + Math.cos(a) * distance,
    z: centerZ + Math.sin(a) * distance,
  });

  const shaftLength = radius * 1.24;
  const shaft = along(angle, -radius * 0.14);
  const tip = along(angle, radius * 0.48);

  const parts: Map3DSignalPart[] = [
    {
      shape: "box",
      role: "lamp",
      lampIndex,
      rotationX: angle,
      position: { x: centerX, y: shaft.y, z: shaft.z },
      size: { x: depth, y: shaftLength, z: thickness },
    },
  ];

  for (const sign of [1, -1]) {
    const barbAngle = angle + sign * (Math.PI * 0.75);
    const barbLength = radius * 0.72;
    const center = {
      y: tip.y + Math.cos(barbAngle) * barbLength * 0.5,
      z: tip.z + Math.sin(barbAngle) * barbLength * 0.5,
    };
    parts.push({
      shape: "box",
      role: "lamp",
      lampIndex,
      rotationX: barbAngle,
      position: { x: centerX, y: center.y, z: center.z },
      size: { x: depth, y: barbLength, z: thickness },
    });
  }

  return parts;
}
