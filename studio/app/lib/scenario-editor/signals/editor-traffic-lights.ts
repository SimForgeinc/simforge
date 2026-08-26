/**
 * The editor's slim traffic-light projection: every signal head a map has, in
 * the pose RoadRunner authored it at.
 *
 * ## Why this exists
 *
 * The editor used to get its lights from `bundle.runtime.traffic_lights` via the
 * scenario-editor bootstrap. That route has returned `runtime: null` since the
 * semantic-first bootstrap landed (2026-07-12), so from that day until the
 * 2026-07-27 audit EVERY signal surface — the 3D heads, the intersection
 * candidates, the placement ghosts and the `topology_only` signalization
 * fallback — read an empty list on every map. The data was always healthy; the
 * transport dropped it.
 *
 * Restoring the whole runtime block is not the fix: `traffic_lights` alone is
 * 113 KB–1.87 MB per map, almost all of it CARLA bookkeeping (bounding boxes,
 * trigger volumes, per-waypoint lane metadata, live actor velocities) that no
 * editor surface has ever read. This module is the projection instead, served by
 * `GET /api/map-assets/[mapAssetId]/traffic-lights`.
 *
 * ## Each quantity comes from whichever source is exact for it
 *
 * A head exists twice in a bundle: as a `<signal>` in the XODR, and as a CARLA
 * actor row. Measured 2026-07-27 against four real dev bundles, and against the
 * cooked UE5 map's own geometry in `environment_objects`:
 *
 * - **Position** is the ACTOR's. It sits 0.00 m from the cooked upright box on
 *   100% of heads; the authored `(s, t)` resolves to the same point but only to
 *   0.25 m median, since resolving a station against a reference line is
 *   approximate. Authored is the fallback when a row has no usable pose.
 * - **Facing** is the `<signal>`'s. The actor's yaw is ~95-100 deg off the
 *   direction a head looks, while `road heading + hOffset + 180` lands within
 *   8-15 deg of the stop-line bearing on every map. See
 *   {@link SIGNAL_AUTHORED_FACING_OFFSET_DEG}.
 * - **Hardware** — `name`, `zOffset`, `height`, `width` — only exists on the
 *   `<signal>`. Every CARLA actor on every map is the same blueprint.
 *
 * Two things this settles, both of which cost a revision each to learn:
 * `light_boxes[0]` is a rigid 6.01 m from the actor on 100% of heads on 100% of
 * maps, so it is a blueprint-internal volume carrying no map information and is
 * not a lamp position; and `vectorSignal` GUIDs are unique per `<signal>` on all
 * four maps, so no two rows are ever the same physical head — head COUNT was
 * never the problem.
 *
 * ## What the cook keeps, and what it throws away
 *
 * `zOffset` is shipped here because it is what RoadRunner authored, but the map
 * being simulated does not honour it: measured against the cooked housing boxes
 * on 366 instances across four maps, every head sits at a rigid 5.75 m and the
 * correlation with `zOffset` (which spans 2.29-10.13 m) is r = 0.02-0.15. The
 * same is true of `name`: the cook spawns one uniform `BP_TLOpenDrive` per
 * signal, so a `Bare` housing meant to share someone else's mast gets its own
 * full pole and arm. `map-3d/signal-head-model.ts` draws the cooked geometry,
 * because that is what runs; the gap between the two is an upstream defect and
 * is tracked as one.
 *
 * ## Server measures, client interprets
 *
 * Everything here is a MEASUREMENT taken off the bundle. The rules for turning a
 * measurement into geometry — a lamp count of 1 meaning "no per-lamp data", a
 * height clamp, which styles draw an upright — live in
 * `map-3d/signal-head-model.ts` where they are pure and unit-tested. That split
 * is why `light_box_count` ships raw rather than pre-resolved.
 *
 * ## Coordinates
 *
 * Every point that leaves this module is in the RUNTIME frame: x east, y north,
 * metres, yaw degrees CCW from +x — the frame `SignalJunctionIndex` centroids,
 * actor spawn points and `runtimePointToLngLat` all share.
 *
 * The OpenDRIVE reference-line frame IS that frame (verified: authored `(s, t)`
 * lands within 0.25 m median of the bundle row's flat runtime `x`/`y`), so an
 * authored pose needs no conversion. The BUNDLE ROW is the part that is not
 * uniformly in it, and that is the trap the audit flagged: a row carries the
 * pose twice, flat `x`/`y`/`z`/`yaw` in the runtime frame and `location` in the
 * RAW CARLA frame whose `y` is mirrored (`carla_y == -runtime_y`,
 * `docs/carla-coordinate-systems.md`). Measured on the real bundles the two
 * disagree in sign on 100% of rows. Nested geometry —
 * `stop_waypoints[].transform.location`, `light_boxes[].location` — only ever
 * exists in the raw CARLA frame, so it is converted here, once, through
 * `carlaPointToRuntimePoint`. Reading it naively would mirror every stop line
 * across the map.
 *
 * ## Zero-geometry signals are real rows, and they are not real heads
 *
 * 22 of Di Rosa's 103 signals and 24 of San Ramon P1's 147 carry `zOffset="0"
 * height="0" width="0"` with no `name` — RoadRunner emitted a signal record with
 * no asset behind it. CARLA still spawns an actor, so they arrive in the bundle
 * indistinguishable from real heads, and 21 of 22 sit nowhere near one (>1.5 m
 * from any real head). Yale has none, so this is per-map authoring debris rather
 * than something structural.
 *
 * They ship with their measurements intact and `mount_style: null`; deciding
 * that such a row is not drawable is interpretation, and interpretation lives in
 * `signal-head-model.ts` (`isDrawableHead`).
 *
 * ## `type`/`subtype` is NOT lens information — do not read it for arrows
 *
 * OpenDRIVE says 1000011 subtypes 10/20/30 are the arrow variants, and that is
 * false of these files. Measured against turn classification across four maps,
 * `1000011/10` splits right 39% / uturn 21% / straight 20% / left 20% — the base
 * rate, i.e. no signal at all — and carries the SAME `Signal_3Light_*` asset
 * names and the same 1.08/1.16 m housings as plain `1000001`. RoadRunner is
 * exporting one physical asset under two codes. `1000011/20` is, on every map
 * that has any, exactly the zero-geometry debris above.
 *
 * Protected turns are recoverable, but from the plan's own per-movement head
 * bindings (`refineMovementSignalIds`), never from the signal type. That is
 * `signalLensKindIndex` in `signal-head-model.ts`.
 */

import { parseGeometrySegments, resolveSTtoXYWithHeading } from "@simforge-oss/studio-shared";
import { carlaPointToRuntimePoint } from "@/app/lib/editor-map/coordinate-frames";

export const EDITOR_TRAFFIC_LIGHTS_SCHEMA_VERSION =
  "simforge.editor-traffic-lights.v3";

/**
 * Degrees between `road heading + hOffset` and the direction a head LOOKS.
 *
 * A signal faces back down its road, against `+s`, because that is where the
 * traffic it governs comes from. Chosen by measurement rather than by reasoning:
 * seven candidate formulas were scored against the head→stop-line bearing across
 * four maps (318 heads), and this one wins on every map by a wide margin.
 *
 * |                         | Di Rosa | Yale | San Ramon | Page Mill |
 * |-------------------------|---------|------|-----------|-----------|
 * | `heading + hOffset + 180` (this) | 8.4 | 14.6 | 9.1 | 7.9 |
 * | `+ 90` / `- 90`         | 76–103  | ...  | ...       | ...       |
 * | the CARLA actor's yaw   | 95.3    | 100.3| 95.2      | 97.2      |
 *
 * (median degrees off the stop-line bearing; p90 runs 20–39 deg, and the stop
 * waypoint is itself a point on the approach lane rather than the head's exact
 * aim point, so a residual of that order is the measurement's own noise floor.)
 *
 * Two things this settles. The CARLA actor's yaw — which every version of this
 * pipeline used until now — is ~95 deg off the direction the head actually
 * looks, so it was never the facing. And `orientation` must NOT be folded in:
 * it says which travel direction the signal APPLIES to, not which way the asset
 * points, and adding it makes the residual bimodal (Di Rosa p50 8.4 -> 121.3).
 */
export const SIGNAL_AUTHORED_FACING_OFFSET_DEG = 180;

/**
 * A stop line this head governs, runtime frame.
 *
 * `junction_id` is CARLA's own junction attribution and is kept for diagnostics,
 * but it is NOT an attribution source: it is -1 on 90–100% of heads because a
 * stop waypoint sits on the APPROACH lane, outside the junction box. The
 * attribution that works is the `opendrive_id` → movement `signal_ids` join in
 * `intersection-candidates.ts`.
 */
export type EditorTrafficLightStopPoint = {
  x: number;
  y: number;
  junction_id: number | null;
};

/** Where a head's pose came from. */
export type EditorTrafficLightFacingSource =
  /** The `<signal>` element — RoadRunner's own authoring. Preferred. */
  | "authored"
  /** The CARLA actor, for a row whose id matches no `<signal>`. */
  | "actor";

/** One physical signal head, in the shape the editor's signal surfaces read. */
export type EditorTrafficLight = {
  /** OpenDRIVE `<signal>` id — the key every attribution and plan binding uses. */
  opendrive_id: string | null;
  actor_id: number | null;
  pole_index: number | null;
  /**
   * Runtime-frame ground position UNDER the head's housing, metres.
   *
   * The authored `(s, t)` resolved on the road reference line. This is where the
   * housing hangs, not a pole base — no pole position exists in the data. See
   * the module header.
   */
  x: number;
  y: number;
  /**
   * The direction the head LOOKS, runtime degrees CCW from +x.
   *
   * Authored: `road heading + hOffset`, flipped when `orientation="-"`, put into
   * the runtime basis by {@link SIGNAL_AUTHORED_FACING_OFFSET_DEG}. Falls back to
   * the CARLA actor's yaw.
   */
  yaw: number;
  /** Which of the two the pose and yaw above actually came from. */
  facing_source: EditorTrafficLightFacingSource;
  /**
   * Authored mounting height above the road, metres, from `<signal zOffset>`.
   *
   * The height that actually varies (2.29–10.13 m across the corpus) and the
   * only height this module ships as authoritative.
   */
  mount_height_m: number | null;
  /** `<signal height>` — the housing's real height, metres. */
  housing_height_m: number | null;
  /** `<signal width>` — the housing's real width, metres. */
  housing_width_m: number | null;
  /**
   * How this head is mounted, from the RoadRunner asset name on its `<signal>`.
   *
   * This is the ONLY field that says whether a head owns an upright, and the
   * 3D model treats it that way. `null` when the signal is unnamed, which in
   * this corpus means the zero-geometry debris described in the module header.
   */
  mount_style: EditorSignalMountStyle | null;
  /**
   * Lamp-housing centre above the head's OWN base, metres, from CARLA.
   *
   * A rigid 5.57 m on every head of every map — the `BP_TLOpenDrive` blueprint's
   * own mast offset, carrying no per-map information. Kept ONLY as the height
   * fallback for a head with no matching `<signal>`.
   */
  lamp_height_m: number | null;
  /**
   * `light_boxes.length` verbatim. 1 on 100% of heads on 100% of maps, which is
   * CARLA reporting one box for the whole housing rather than a one-lamp head —
   * `resolveLampCount` is where that is interpreted.
   */
  light_box_count: number;
  /** Stop lines this head governs, runtime frame, nearest ordering preserved. */
  stop_waypoints: EditorTrafficLightStopPoint[];
  /**
   * The housing the SIMULATOR actually renders for this head, or null.
   *
   * Null on every bundle cooked before the `ff4e8233` base — including the one
   * staging and prod still run — so every consumer must keep a path that works
   * without it. See {@link EditorSignalHousing}.
   */
  housing: EditorSignalHousing | null;
};

/** One lamp lens, runtime frame, metres. */
export type EditorSignalLamp = {
  x: number;
  y: number;
  /** Absolute runtime elevation, NOT a height above anything. */
  z: number;
};

/**
 * A head's real cooked housing, measured off `environment_objects`.
 *
 * ## Why this exists, and why it is nullable
 *
 * Until the `ff4e8233` base the cook replaced every RoadRunner signal asset with
 * one uniform `BP_TLOpenDrive`: housing at a rigid 5.75 m on a 6.01 m arm on its
 * own 7.75 m pole, one per head, 103 of them on Di Rosa. The editor drew that
 * faithfully — it was measured against the cooked boxes to p50 0.00 m — and it
 * was the right thing to draw, because it was what the simulator rendered.
 *
 * That base keeps RoadRunner's own meshes instead. CARLA's `ATrafficLightManager
 * ::SpawnTrafficLights` adopts any type-matching `ATrafficLightBase` within 5 m
 * (`MaxDistanceMatchSqr = 250000` cm², `TrafficLightManager.cpp` @ `ada75f92`)
 * rather than spawning its own, so the controllable actor binds to the authored
 * asset and the uniform blueprint never appears. Measured on the four lit maps
 * of `carla-0.10.0-prod-ff4e8233-20260729`:
 *
 *     housing -> its actor, XY      0.25 m   (p90 0.25, max 0.72)
 *     housing centre above actor z  0.54-0.58 m
 *     lamps per housing             exactly 3
 *     distinct housing heights      4        (1.08/1.16/1.26/1.46 m)
 *     distinct housing elevations   74 of 82 on Di Rosa, 46 of 46 on Yale
 *
 * So the head's position, size, facing and lamp positions are all now DIRECTLY
 * measurable, and nothing about them needs to be inferred from a rule.
 *
 * It stays nullable because the same code serves bundles cooked either way.
 */
export type EditorSignalHousing = {
  /** Housing box centre, runtime frame, metres. `z` is absolute elevation. */
  x: number;
  y: number;
  z: number;
  /** Full extent of the housing box, metres — not half-extents. */
  size_x: number;
  size_y: number;
  size_z: number;
  /** The housing mesh's own yaw, runtime degrees CCW from +x. */
  yaw: number;
  /**
   * Authored housing mounting height above the road, metres.
   *
   * This is the matched head's OpenDRIVE `<signal zOffset>`, supplied when the
   * XODR head and cooked housing meet in `projectEditorTrafficLights`; it is
   * null when no authored `<signal>` matches. It must never be derived from the
   * housing's absolute `z` minus the CARLA actor's `z`: under the new cook the
   * manager adopts the RoadRunner actor at the housing, so that difference is
   * only the asset's fixed origin offset. On Di Rosa, authored `zOffset` spans
   * 3.28–7.70 m and correlates with absolute housing elevation at +0.796, while
   * `housing z - actor z` spans only 0.54–0.71 m and correlates at -0.099.
   */
  height_above_ground_m: number | null;
  /** Lamp lenses, ordered top lens first. Three on every measured head. */
  lamps: EditorSignalLamp[];
  /**
   * The mast this head hangs on, or null when no cooked pole owns it.
   *
   * Heads SHARE a mast — that is the whole point of the field. Draw one pole per
   * distinct {@link EditorSignalMast.id}, not one per head.
   */
  mast: EditorSignalMast | null;
};

/**
 * A real cooked signal mast, measured off `environment_objects`.
 *
 * ## Why this exists
 *
 * The old cook gave every head its own pole and 6 m arm — 103 masts on Di Rosa
 * for 103 signals. When that geometry vanished the editor first went the other
 * way and drew NO mast at all, on the stated belief that the real poles were
 * "not identifiable, indistinguishable from street lighting". That belief was
 * asserted without measuring and is false.
 *
 * Every housing on every lit map sits within 12 m of a tall, thin cooked mesh,
 * at a median of 0.5 m horizontally, and the assignment collapses cleanly:
 *
 *     map            heads   masts   (old cook drew one mast per head)
 *     Di Rosa           82      46
 *     Yale              46      20
 *     San Ramon P1     124      32
 *     Page Mill         68      29
 *
 * Per junction that is Di Rosa 710 at 19 heads on 9 masts, 107 at 16 on 10, 810
 * at 15 on 8 — which is what a real signalized intersection looks like, and
 * matches the ~8-mount figure the 2026-07-27 handoff estimated by eye.
 *
 * Heads-without-masts is not a smaller lie than a mast per head; it is the same
 * mistake with the sign flipped. 19 unsupported boxes read as 19 separate
 * installations, and nothing shows which approach a head governs — the arm
 * reaching out over a lane IS that information in the real world.
 *
 * ## Identifying one
 *
 * Geometric and deliberately type-agnostic: taller than 4 m, footprint under
 * 1 m. `type` is `Other` for most and `NONE` for 5 of San Ramon's, so keying on
 * it would silently drop masts on one map. Many such meshes are ordinary street
 * lighting; the ones that matter are exactly the ones that OWN a head, which is
 * why only poles with at least one housing assigned are ever drawn — 46 of Di
 * Rosa's 197 candidates.
 *
 * The pole usually continues above its heads (median 3.7 m above, on the 10 m
 * poles carrying 66 of Di Rosa's 82 housings). That is not evidence of a
 * streetlight mismatch: it is the standard California combined pole, signal arm
 * at ~6 m and a luminaire arm at the top.
 */
export type EditorSignalMast = {
  /**
   * Stable id for the cooked pole mesh, so heads sharing a mast agree on one.
   *
   * The renderer MUST dedupe on this. Drawing per-head reintroduces the exact
   * over-poling this type exists to remove.
   */
  id: string;
  /** Pole axis, runtime frame, metres. */
  x: number;
  y: number;
  /** Pole base above the road, metres. Near zero for a pole standing on grade. */
  base_height_m: number;
  /** Pole top above the road, metres. */
  top_height_m: number;
};

/** RoadRunner's mounting hardware, parsed from `Signal_3Light_<style>NN`. */
export type EditorSignalMountStyle = "post" | "bare" | "bracket" | "side";

/** The authored geometry of one `<signal>`, resolved into the runtime frame. */
export type XodrSignalGeometry = {
  name: string;
  mount_style: EditorSignalMountStyle | null;
  /** Runtime-frame position under the housing, from `(s, t)`. */
  x: number;
  y: number;
  /** Authored facing, runtime degrees — basis offset already applied. */
  yaw: number;
  z_offset_m: number;
  height_m: number;
  width_m: number;
};

const MOUNT_STYLE_PATTERNS: ReadonlyArray<[RegExp, EditorSignalMountStyle]> = [
  [/post/i, "post"],
  [/bare/i, "bare"],
  [/bracket/i, "bracket"],
  [/side/i, "side"],
];

/** `Signal_3Light_Bracket01` -> `bracket`. Unnamed and unrecognised give null. */
export function mountStyleFromSignalName(
  name: string | null | undefined,
): EditorSignalMountStyle | null {
  if (!name) return null;
  for (const [pattern, style] of MOUNT_STYLE_PATTERNS) {
    if (pattern.test(name)) return style;
  }
  return null;
}

function attributeOf(element: string, name: string): string {
  return element.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
}

function numberAttribute(element: string, name: string): number {
  const parsed = Number(attributeOf(element, name));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Resolve every dynamic `<signal>`'s authored geometry, keyed by OpenDRIVE id.
 *
 * Roads are walked as whole blocks because a signal's `(s, t)` means nothing
 * without its road's reference line: `parseGeometrySegments` needs the `<road>`
 * body, and only then can `resolveSTtoXYWithHeading` place the head. That is the
 * whole reason this is a road-level parse rather than v2's flat
 * `<signal>`-only scan.
 *
 * Regex rather than a DOM parse for the same reason the rest of this pipeline
 * uses one: the bundle XODR runs to tens of megabytes. `dynamic="yes"` is the
 * filter, exactly as `derive-signal-groups.ts` uses — a type test that knows
 * only 1000001 silently drops ~40% of a map's live heads.
 */
export function parseXodrSignalGeometry(
  xodr: string | null | undefined,
): Map<string, XodrSignalGeometry> {
  const index = new Map<string, XodrSignalGeometry>();
  if (!xodr) return index;

  for (const road of xodr.matchAll(/<road\b[^>]*>([\s\S]*?)<\/road>/g)) {
    const body = road[1] ?? "";
    if (!body.includes("<signal")) continue;
    const elements = body.match(/<signal\b[^>]*?(?:\/>|>)/g);
    if (!elements?.length) continue;

    let segments: ReturnType<typeof parseGeometrySegments> | null = null;
    for (const element of elements) {
      if (!/\bdynamic="yes"/.test(element)) continue;
      const id = attributeOf(element, "id").trim();
      if (!id || index.has(id)) continue;

      // Parsed lazily: most roads carry no dynamic signal at all.
      segments ??= parseGeometrySegments(body);
      if (!segments.length) continue;
      const solved = resolveSTtoXYWithHeading(
        segments,
        numberAttribute(element, "s"),
        numberAttribute(element, "t"),
      );
      if (!solved || !Number.isFinite(solved.xy.x) || !Number.isFinite(solved.xy.y)) {
        continue;
      }

      const name = attributeOf(element, "name");
      // `orientation` is deliberately not read here — see the constant's doc.
      const facingRad = solved.heading + numberAttribute(element, "hOffset");
      const yaw =
        (facingRad * 180) / Math.PI + SIGNAL_AUTHORED_FACING_OFFSET_DEG;

      index.set(id, {
        name,
        mount_style: mountStyleFromSignalName(name),
        x: solved.xy.x,
        y: solved.xy.y,
        yaw: normalizeDegrees(yaw),
        z_offset_m: numberAttribute(element, "zOffset"),
        height_m: numberAttribute(element, "height"),
        width_m: numberAttribute(element, "width"),
      });
    }
  }
  return index;
}

/** Into `(-180, 180]`, so a yaw never depends on how many turns produced it. */
function normalizeDegrees(value: number): number {
  let degrees = value % 360;
  if (degrees > 180) degrees -= 360;
  if (degrees <= -180) degrees += 360;
  return degrees;
}

export type EditorTrafficLightIndex = {
  schema_version: typeof EDITOR_TRAFFIC_LIGHTS_SCHEMA_VERSION;
  map_asset_id: string;
  /** The CARLA map the bundle was dumped from — the identity the poses belong to. */
  runtime_map_name: string;
  bundle_version: string;
  traffic_lights: EditorTrafficLight[];
};

/** A bundle `traffic_lights` row, kept structural: optionals are normal. */
export interface RuntimeTrafficLightRowLike {
  actor_id?: number | null;
  opendrive_id?: string | number | null;
  pole_index?: number | null;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  yaw?: number | null;
  /** RAW CARLA frame — `y` is mirrored from the flat `y` above. */
  location?: { x?: number | null; y?: number | null; z?: number | null } | null;
  stop_waypoints?:
    | ReadonlyArray<{
        junction_id?: number | string | null;
        transform?: {
          location?: { x?: number | null; y?: number | null; z?: number | null } | null;
        } | null;
      } | null>
    | null;
  light_boxes?:
    | ReadonlyArray<{
        location?: { x?: number | null; y?: number | null; z?: number | null } | null;
      } | null>
    | null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Millimetres are already far finer than any signal pose is meaningful to. */
function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * The CARLA actor's runtime-frame pose — the fallback when a row's id matches no
 * `<signal>`.
 *
 * Flat `x`/`y` win because they are already runtime. `location` is the raw CARLA
 * fallback and MUST be converted, not copied — see the module header.
 */
function actorPose(
  row: RuntimeTrafficLightRowLike,
): { x: number; y: number; z: number | null } | null {
  if (finite(row.x) && finite(row.y)) {
    return { x: row.x, y: row.y, z: finite(row.z) ? row.z : (row.location?.z ?? null) };
  }
  const carlaX = row.location?.x;
  const carlaY = row.location?.y;
  if (!finite(carlaX) || !finite(carlaY)) return null;
  const runtime = carlaPointToRuntimePoint({ x: carlaX, y: carlaY });
  return {
    x: runtime.x,
    y: runtime.y,
    z: finite(row.location?.z) ? row.location.z : (finite(row.z) ? row.z : null),
  };
}

/**
 * How high CARLA's lamp box sits above the actor's own base.
 *
 * Legacy cooks expose one blueprint-internal `light_boxes[0]`; both its z and
 * the actor z are absolute elevations, so only their difference is meaningful.
 * The `ff4e8233` cook exposes no light boxes. For it, projection attaches the
 * authored `<signal zOffset>` to a matching cooked housing. An unmatched
 * housing has no trustworthy mounting height and stays null.
 */
function lampHeightM(
  row: RuntimeTrafficLightRowLike,
  baseZ: number | null,
  housing: EditorSignalHousing | null,
): number | null {
  const boxZ = row.light_boxes?.[0]?.location?.z;
  if (finite(boxZ) && finite(baseZ)) {
    const height = boxZ - baseZ;
    if (height > 0) return round(height, 2);
  }
  return housing && finite(housing.height_above_ground_m)
    && housing.height_above_ground_m > 0
    ? round(housing.height_above_ground_m, 2)
    : null;
}

function stopPoints(
  row: RuntimeTrafficLightRowLike,
): EditorTrafficLightStopPoint[] {
  const points: EditorTrafficLightStopPoint[] = [];
  for (const waypoint of row.stop_waypoints ?? []) {
    const carla = waypoint?.transform?.location;
    if (!finite(carla?.x) || !finite(carla?.y)) continue;
    const runtime = carlaPointToRuntimePoint({ x: carla.x, y: carla.y });
    const junctionId = Number(waypoint?.junction_id);
    points.push({
      x: round(runtime.x),
      y: round(runtime.y),
      junction_id: Number.isFinite(junctionId) ? junctionId : null,
    });
  }
  return points;
}

function resolveCookedHousing(
  cookedHousing: EditorSignalHousing | null,
  authored: XodrSignalGeometry | undefined,
): EditorSignalHousing | null {
  if (!cookedHousing) return null;
  if (!authored) {
    return {
      ...cookedHousing,
      height_above_ground_m: null,
      mast: null,
    };
  }

  // RoadRunner's zOffset marks the housing base. The cooked bounding box z is
  // its centre, so subtracting half its full height recovers that same base.
  const roadZ =
    cookedHousing.z - authored.z_offset_m - cookedHousing.size_z / 2;
  const mast = cookedHousing.mast
    ? {
        ...cookedHousing.mast,
        base_height_m:
          round(cookedHousing.mast.base_height_m - roadZ, 2) || 0,
        top_height_m:
          round(cookedHousing.mast.top_height_m - roadZ, 2) || 0,
      }
    : null;
  return {
    ...cookedHousing,
    height_above_ground_m: round(authored.z_offset_m, 2),
    mast,
  };
}

/**
 * Project a bundle's `traffic_lights` block into the editor's slim shape.
 *
 * Rows with no resolvable pose are dropped: a head the editor cannot place is a
 * head no surface can draw, attribute or preview, and carrying it would only put
 * a phantom in the candidate hover card's count.
 *
 * `geometry` comes from the SAME bundle's XODR (`parseXodrSignalGeometry`). It
 * is optional so a caller with only the runtime block still gets a valid
 * projection — every such head simply falls back to the CARLA actor's pose,
 * leaves any cooked housing mounting height null, and says so in
 * `facing_source`.
 *
 * `housings` is keyed by original traffic-light row index. Old bundles and soft
 * environment-section failures pass no map and retain `housing: null`.
 */
export function projectEditorTrafficLights(
  rows: readonly (RuntimeTrafficLightRowLike | null | undefined)[] | null | undefined,
  geometry?: ReadonlyMap<string, XodrSignalGeometry> | null,
  housings?: ReadonlyMap<number, EditorSignalHousing> | null,
): EditorTrafficLight[] {
  const lights: EditorTrafficLight[] = [];
  const sourceRows = rows ?? [];
  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
    const row = sourceRows[rowIndex];
    if (!row) continue;
    const openDriveId =
      row.opendrive_id != null ? String(row.opendrive_id).trim() : "";
    const authored = openDriveId ? geometry?.get(openDriveId) : undefined;
    const actor = actorPose(row);
    const cookedHousing = housings?.get(rowIndex) ?? null;
    const housing = resolveCookedHousing(cookedHousing, authored);
    // An authored head needs no actor pose at all; an unauthored one is only a
    // head if CARLA placed it somewhere.
    if (!authored && !actor) continue;

    lights.push({
      opendrive_id: openDriveId || null,
      actor_id: finite(row.actor_id) ? row.actor_id : null,
      pole_index: finite(row.pole_index) ? row.pole_index : null,
      // POSITION from the actor, FACING from the `<signal>` — each from the
      // source measured to be exact for it. See the module header.
      x: round(actor ? actor.x : authored!.x),
      y: round(actor ? actor.y : authored!.y),
      yaw: round(authored ? authored.yaw : finite(row.yaw) ? row.yaw : 0, 2),
      facing_source: authored ? "authored" : "actor",
      mount_height_m: authored ? round(authored.z_offset_m, 2) : null,
      housing_height_m: authored ? round(authored.height_m, 2) : null,
      housing_width_m: authored ? round(authored.width_m, 2) : null,
      mount_style: authored?.mount_style ?? null,
      // Keep the legacy box measurement first. New cooks correctly report zero
      // light boxes, so zero is raw data rather than evidence of zero lenses.
      lamp_height_m: lampHeightM(row, actor?.z ?? null, housing),
      light_box_count: row.light_boxes?.length ?? 0,
      stop_waypoints: stopPoints(row),
      housing,
    });
  }
  return lights;
}
