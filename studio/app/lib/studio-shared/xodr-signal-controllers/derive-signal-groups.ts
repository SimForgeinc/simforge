/**
 * Derive traffic-signal movement grouping from a raw OpenDRIVE (.xodr) file.
 *
 * ## Why this module exists
 *
 * Our RoadRunner-exported maps carry `<signal>` elements but no
 * `<controller>`/`<control>` elements, and nothing anywhere joins a signal to
 * the junction it controls: `build-topology-index.ts` has no signal handling at
 * all, and the `signals_geojson` overlay carries `road_id`/`s`/`t` but no
 * junction id. So the two halves of "which lights govern this approach" live in
 * two artifacts that never meet.
 *
 * This module performs that join, purely from the xodr, and is the source the
 * `<controller>` enrichment (`enrich-xodr.ts`) and the authoring UI both read.
 *
 * ## Approach identity is NOT invented here
 *
 * Approach ids follow `scenario-signals.ts` exactly —
 * `"<road_id>.<section>.<side>"`, side `l`/`r` from the lane-id sign — and are
 * derived with the same rule `buildMapTopologyIndex` uses for its gates
 * (`build-topology-index.ts`: `rslOf(incoming.id, incSec, ll.from)` with
 * `incSec` chosen by which end of the incoming road meets the junction). The
 * ids produced here are therefore byte-identical to
 * `approachIdFromLaneRsl(gate.approachLaneRsl)`, which is what lets
 * `attachSignalIdsToGates` hand signal ids straight to
 * `deriveJunctionMovements` without a translation table.
 *
 * We re-derive rather than depend on a built `MapTopologyIndex` because the
 * enrichment runs offline against raw xodr bytes, before any topology artifact
 * exists.
 *
 * ## Where signals actually sit
 *
 * Both exporters in the corpus put controlled lights on the *connecting* roads
 * inside the junction rather than on the approach roads (RoadRunner: see the
 * note at `apps/web/app/lib/maps/metadata/xodr.ts` `junction_control_counts`;
 * DeepMap: 49 of 51 controller-referenced signals in the reference corpus). A
 * connecting road maps 1:1 onto `(incomingRoad, laneLink.from)`, i.e. onto an
 * approach — which is why the primary assignment rule needs no geometry at all
 * and no orientation heuristic. Signals sitting directly on approach roads are
 * handled by a secondary rule that does use `orientation`/`t`.
 *
 * A physical head usually governs SEVERAL of those connecting roads, and
 * OpenDRIVE says so with one `<signal>` definition plus a `<signalReference>` on
 * every other road it governs. Both count here; see
 * {@link resolveSignalReferences} for why reading only `<signal>` left most of a
 * lit junction's approaches looking unsignalized.
 *
 * ## Consequence worth knowing
 *
 * One signal head serves a whole approach, so the `left`, `straight` and
 * `right` movements off one approach necessarily carry identical `signal_ids`.
 * Distinguishing a protected-left arrow head would require splitting on signal
 * `subtype` (1000011 subtypes 10/20/30 are the arrow variants); that is
 * deliberately not done here.
 */

import {
  parseGeometrySegments,
  resolveSTtoXYWithHeading,
  type GeometrySegment,
} from "../enrichment/xodr-geometry";
import {
  classifyTurn,
  junctionTurnForRelation,
  parseXodr,
} from "../map-topology/build-topology-index";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Which side of the road reference line an approach's lanes sit on. */
export type ApproachSide = "l" | "r";

/** One signalized approach into a junction. */
export type XodrApproachSignals = {
  /** `"<road_id>.<section>.<side>"` — the `scenario-signals.ts` convention. */
  approach_id: string;
  road_id: string;
  section: number;
  side: ApproachSide;
  /** OpenDRIVE `<signal>` ids governing this approach, sorted, deduped. */
  signal_ids: string[];
  /**
   * Direction of travel ENTERING the junction, radians, in the xodr's local
   * frame (+x east, +y north — the OpenDRIVE reference-line basis, NOT the
   * y-flipped CARLA basis that `scenario-signals.ts` compass labels assume).
   */
  approach_heading_rad: number | null;
};

/**
 * A set of approaches that should go green together — one OpenDRIVE
 * `<controller>`.
 *
 * The phase group, not the approach, is the controller grain, because that is
 * what a controller *means* to CARLA: an `ATrafficLightGroup` cycles its
 * `UTrafficLightController`s one at a time, greening one and holding the rest
 * red. One controller per opposing pair gives a 4-way the realistic
 * north-south / east-west cycle; one controller per approach would green each
 * arm alone.
 *
 * No movement id ever appears in the xodr. `controller/@name` is
 * `"sf:<junction_id>:<key>"` and `key` embeds an APPROACH id, since a physical
 * head serves a whole approach and choosing between that approach's `:left`
 * and `:straight` movements would be arbitrary.
 */
export type XodrPhaseGroup = {
  /**
   * Content-derived, stable key: `"<axis>:<lowest approach_id>"`, axis one of
   * `ns` / `ew` / `xx` (unknown). Keyed on content rather than an index so that
   * adding an arm to a junction cannot renumber the other groups.
   */
  key: string;
  approach_ids: string[];
  signal_ids: string[];
  /** Allocated `<controller id>`. Integer string, unique across the document. */
  controller_id: string;
  /** `<controller name>` — `"sf:<junction_id>:<key>"`. */
  controller_name: string;
};

/** How a junction's approaches were partitioned into phase groups. */
export type XodrPhaseGrouping = "opposing_pairs" | "axis_fallback";

/**
 * One movement's heads, when the map distinguishes them.
 *
 * Most approaches have a single head serving every turn, and then this table
 * just restates the approach. But real maps DO wire per-movement heads: in the
 * reference corpus 16 approaches across 3 maps carry a different signal set on
 * each connecting road off the same approach (e.g. junction 195 approach road
 * 17: connecting road 18 has heads 241/242, connecting road 152 has 245/246).
 * That is a protected left, and it is recoverable from the connecting-road
 * association alone — no `subtype` arrow parsing needed.
 *
 * This is a REFINEMENT, never the primary binding. `turn` is classified from
 * the connecting road's REFERENCE-LINE heading change, whereas
 * `buildMapTopologyIndex` classifies from the connecting LANE's polyline. The
 * two agree except near the 20 deg / 135 deg thresholds, so a movement id
 * derived here can occasionally disagree with the topology's. That is why
 * `refineMovementSignalIds` matches on the caller's movement id and silently
 * declines when it does not recognise one: a disagreement degrades to the
 * approach-level union, and can never produce a wrong binding.
 */
export type XodrMovementSignals = {
  /** `"<approach_id>:<turn>"` — the `scenario-signals.ts` convention. */
  movement_id: string;
  approach_id: string;
  turn: "left" | "right" | "straight" | "uturn";
  signal_ids: string[];
  /** Connecting roads whose heads this movement's ids came from. */
  connecting_road_ids: string[];
};

export type XodrJunctionSignalGroup = {
  /** OpenDRIVE `<junction id>`, stringified. */
  junction_id: string;
  approaches: XodrApproachSignals[];
  /**
   * Per-movement heads where the map wires them separately. Empty when every
   * approach has one head for all turns — the common case.
   */
  movements: XodrMovementSignals[];
  phase_groups: XodrPhaseGroup[];
  grouping: XodrPhaseGrouping;
  /**
   * True when the junction already carried `<controller>` references before
   * enrichment. Enrichment leaves these junctions alone.
   */
  had_existing_controllers: boolean;
};

export type DeriveXodrSignalGroupsResult = {
  junctions: XodrJunctionSignalGroup[];
  /** Traffic-light signals found that could not be tied to any junction. */
  unassigned_signal_ids: string[];
  /** First controller id allocated; ids run upward from here. */
  controller_id_base: number;
};

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * How far from antiparallel two approach headings may be and still count as
 * opposing arms of one street. 40 deg absorbs skewed intersections without
 * pairing perpendicular arms (which are 90 deg away from antiparallel).
 */
const OPPOSING_TOLERANCE_RAD = (40 * Math.PI) / 180;

/**
 * Max distance from a road's junction end at which a signal sitting on an
 * approach road is still taken to govern that junction. Only the secondary
 * assignment rule uses it; the connecting-road rule is exact.
 */
const APPROACH_SIGNAL_MAX_DISTANCE_M = 60;

// ---------------------------------------------------------------------------
// Signal parsing
// ---------------------------------------------------------------------------

type ParsedSignal = {
  id: string;
  roadId: number;
  s: number;
  t: number;
  /** `+`, `-`, `none`, or `both`. */
  orientation: string;
};

const ATTR_RE = /([A-Za-z_][\w.-]*)="([^"]*)"/g;

function parseAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(text)) !== null) out[m[1]!] = m[2]!;
  return out;
}

/**
 * OpenDRIVE signal types that carry a commandable light.
 *
 * A live box probe over all 11 dev maps (2026-07-26) found `dynamic="yes"`
 * exactly equal to type ∈ {1000001, 1000011, 1000002}, and ~40% of live light
 * actors bound to 1000011 rather than 1000001 (San Ramon P1: 91 vs 57). So a
 * type test that knows only 1000001 silently drops most of a map's lights;
 * `dynamic` is the reliable discriminator and these three are its equivalent.
 */
const TRAFFIC_LIGHT_SIGNAL_TYPES = ["1000001", "1000011", "1000002"];

/**
 * Is this `<signal>` a traffic light rather than a static sign?
 *
 * Three independent signals of intent, because the corpus disagrees on which
 * one it populates: `dynamic="yes"` (both exporters, and the one the probe
 * confirmed tracks the live actor count on every map), the OpenDRIVE signal
 * types above (DeepMap, and what esmini's `traffic_light_type_map` keys on),
 * and RoadRunner's `Signal_3Light_*` / `*walk_light*` naming (which is what
 * `classifyAndEnrichSignal` keys on — that classifier is not reused here
 * because it lives in apps/web and pulls in the MUTCD sign table).
 */
function isTrafficLightSignal(attrs: Record<string, string>): boolean {
  if ((attrs.dynamic ?? "").toLowerCase() === "yes") return true;
  const type = (attrs.type ?? "").trim();
  if (TRAFFIC_LIGHT_SIGNAL_TYPES.includes(type)) return true;
  const name = attrs.name ?? "";
  return /signal_.*light|walk_light|trafficlight/i.test(name);
}

/**
 * One line-oriented pass collecting traffic-light `<signal>` elements per road,
 * plus each road's reference-line geometry.
 *
 * `<signal\b` cannot match the `<signals>` container or `<signalReference>` —
 * the word boundary requires a non-word character after "signal" — which is the
 * same tag-disambiguation trick `parseXodr` relies on. `<signalReference>` is
 * therefore matched by its own pattern and resolved separately; see
 * {@link resolveSignalReferences}.
 */
function parseSignalsAndGeometry(xodr: string): {
  signalsByRoad: Map<number, ParsedSignal[]>;
  geometryByRoad: Map<number, GeometrySegment[]>;
  maxNumericId: number;
} {
  const signalsByRoad = new Map<number, ParsedSignal[]>();
  const geometryByRoad = new Map<number, GeometrySegment[]>();
  /**
   * Ids of the `<signal>` definitions classified as lights, document-wide.
   * A `<signalReference>` carries no type of its own, so this set is the only
   * thing that can say whether one points at a light or at a stop sign.
   */
  const trafficLightIds = new Set<string>();
  /** Resolved after the road pass — a reference may precede its definition. */
  const references: ParsedSignal[] = [];
  let maxNumericId = 0;

  const noteId = (raw: string | undefined) => {
    if (raw === undefined) return;
    const n = Number(raw);
    if (Number.isFinite(n) && n > maxNumericId) maxNumericId = n;
  };

  const roadBlockRe = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = roadBlockRe.exec(xodr)) !== null) {
    const roadAttrs = parseAttrs(rm[1]!);
    const body = rm[2]!;
    const roadId = Number(roadAttrs.id);
    if (!Number.isFinite(roadId)) continue;
    noteId(roadAttrs.id);

    geometryByRoad.set(roadId, parseGeometrySegments(body));

    if (!body.includes("<signal")) continue;
    const signalRe = /<signal\b([^>]*?)\/?>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = signalRe.exec(body)) !== null) {
      const a = parseAttrs(sm[1]!);
      const id = (a.id ?? "").trim();
      if (!id) continue;
      noteId(id);
      if (!isTrafficLightSignal(a)) continue;
      trafficLightIds.add(id);
      const s = Number(a.s ?? "0");
      const t = Number(a.t ?? "0");
      const list = signalsByRoad.get(roadId) ?? [];
      list.push({
        id,
        roadId,
        s: Number.isFinite(s) ? s : 0,
        t: Number.isFinite(t) ? t : 0,
        orientation: (a.orientation ?? "none").trim(),
      });
      signalsByRoad.set(roadId, list);
    }

    const referenceRe = /<signalReference\b([^>]*?)\/?>/gi;
    while ((sm = referenceRe.exec(body)) !== null) {
      const a = parseAttrs(sm[1]!);
      const id = (a.id ?? "").trim();
      if (!id) continue;
      const s = Number(a.s ?? "0");
      const t = Number(a.t ?? "0");
      references.push({
        id,
        roadId,
        s: Number.isFinite(s) ? s : 0,
        t: Number.isFinite(t) ? t : 0,
        orientation: (a.orientation ?? "none").trim(),
      });
    }
  }

  resolveSignalReferences(references, trafficLightIds, signalsByRoad);

  // Controller and junction ids share the numeric id space in practice (the
  // DeepMap corpus allocates controller 221 right after signals 219/220), so
  // new controller ids are allocated above every id in the document.
  for (const re of [/<controller\b([^>]*)>/gi, /<junction\b([^>]*)>/gi]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(xodr)) !== null) noteId(parseAttrs(m[1]!).id);
  }

  return { signalsByRoad, geometryByRoad, maxNumericId };
}

/**
 * Fold `<signalReference>` elements into the per-road signal lists.
 *
 * ## Why this exists
 *
 * A physical head hangs over the middle of an intersection and governs several
 * connecting roads at once. OpenDRIVE says that with ONE `<signal>` definition
 * on one road plus a `<signalReference>` on every other road the same head
 * governs — the reference carries the referenced `id` and that road's own
 * `s`/`t`/`orientation`, and no `type`, `subtype`, `dynamic` or `name`.
 *
 * Reading only `<signal>` therefore sees a shared head on exactly one of the
 * roads it serves, and every other approach through it comes out unsignalized.
 * That is the SHARED-HEAD case, and it is not rare: on the Yale St runtime
 * bundle 146 of 185 `<signalReference>` elements point at a traffic light, and
 * 41 of the map's 46 heads are referenced from at least one further road.
 *
 * A reference carries no type, so it cannot be classified on its own — it is
 * resolved against the ids of the `<signal>` definitions this pass already
 * classified as lights. A reference to a stop sign or a crosswalk marking
 * therefore resolves to nothing, which is what keeps `1656`/`1712`-style static
 * signs out of the light tables even though half a junction's connecting roads
 * reference them.
 *
 * Deduped per (road, id): a road that both defines and references the same head
 * (or references it twice) must not double-count it, because
 * `buildMovementTable` compares head SETS to decide whether an approach wires
 * its turns separately.
 */
function resolveSignalReferences(
  references: readonly ParsedSignal[],
  trafficLightIds: ReadonlySet<string>,
  signalsByRoad: Map<number, ParsedSignal[]>,
): void {
  for (const reference of references) {
    if (!trafficLightIds.has(reference.id)) continue;
    const list = signalsByRoad.get(reference.roadId) ?? [];
    if (list.some((signal) => signal.id === reference.id)) continue;
    list.push(reference);
    signalsByRoad.set(reference.roadId, list);
  }
}

/**
 * What the document already says about signal control.
 *
 * Both halves matter. A junction that references controllers is obviously
 * already grouped; but so is a junction whose lights are named by a top-level
 * `<controller>` that no junction references — the DeepMap corpus is exactly
 * that shape (21 controllers, zero junction back-references). Adding our own
 * controllers over either would leave two controllers fighting for the same
 * lights in CARLA.
 */
function existingControlState(xodr: string): {
  junctionIds: Set<string>;
  controlledSignalIds: Set<string>;
} {
  const junctionIds = new Set<string>();
  const junctionBlockRe = /<junction\b([^>]*)>([\s\S]*?)<\/junction>/gi;
  let m: RegExpExecArray | null;
  while ((m = junctionBlockRe.exec(xodr)) !== null) {
    if (!/<controller\b/i.test(m[2]!)) continue;
    const id = parseAttrs(m[1]!).id;
    if (id) junctionIds.add(id.trim());
  }

  const controlledSignalIds = new Set<string>();
  const controllerBlockRe = /<controller\b[^>]*>([\s\S]*?)<\/controller>/gi;
  while ((m = controllerBlockRe.exec(xodr)) !== null) {
    const controlRe = /<control\b([^>]*?)\/?>/gi;
    let c: RegExpExecArray | null;
    while ((c = controlRe.exec(m[1]!)) !== null) {
      const signalId = parseAttrs(c[1]!).signalId;
      if (signalId) controlledSignalIds.add(signalId.trim());
    }
  }

  return { junctionIds, controlledSignalIds };
}

// ---------------------------------------------------------------------------
// Heading helpers
// ---------------------------------------------------------------------------

/** Wrap to (-pi, pi]. */
function normalizeAngle(rad: number): number {
  let a = rad;
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

/** Unsigned angular separation in [0, pi]. */
function angularDistance(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}

/**
 * Direction of travel entering the junction for one (road, side) approach.
 *
 * Right-side lanes (negative ids) travel with `+s` and meet the junction at the
 * road's far end; left-side lanes travel against `+s` and meet it at `s = 0`,
 * so their travel heading is the reference-line heading rotated by pi.
 */
function approachHeading(
  segments: GeometrySegment[] | undefined,
  roadLength: number,
  side: ApproachSide,
): number | null {
  if (!segments || segments.length === 0) return null;
  const s = side === "r" ? Math.max(0, roadLength) : 0;
  const resolved = resolveSTtoXYWithHeading(segments, s, 0);
  if (!resolved || !Number.isFinite(resolved.heading)) return null;
  return normalizeAngle(side === "r" ? resolved.heading : resolved.heading + Math.PI);
}

/** `ns` when the heading runs more north-south than east-west, else `ew`. */
function axisOf(headingRad: number | null): "ns" | "ew" | "xx" {
  if (headingRad == null) return "xx";
  const fromEast = Math.abs(normalizeAngle(headingRad));
  // Fold onto [0, pi/2]: distance of the *axis* from the east-west line.
  const folded = fromEast > Math.PI / 2 ? Math.PI - fromEast : fromEast;
  return folded > Math.PI / 4 ? "ns" : "ew";
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

type ApproachAccumulator = {
  approachId: string;
  roadId: number;
  section: number;
  side: ApproachSide;
  signalIds: Set<string>;
  heading: number | null;
};

/** One (approach, connecting road) pairing — the movement path through the junction. */
type MovementPath = {
  approachId: string;
  connectingRoadId: number;
  /** Lane id on the connecting road; its sign gives the travel direction. */
  connectingLaneId: number;
  signalIds: Set<string>;
};

/**
 * Turn class of a connecting road, in the driver's frame.
 *
 * Mirrors `laneTravelHeadingChange` + `classifyTurn` from
 * `build-topology-index.ts`, including the sign flip for positive-id lanes
 * (which travel against `+s`), but samples the road's reference line rather
 * than the lane polyline — this module has no lane-width machinery. See the
 * `XodrMovementSignals` doc for why the approximation is safe.
 */
function connectingRoadTurn(
  segments: GeometrySegment[] | undefined,
  roadLength: number,
  connectingLaneId: number,
): XodrMovementSignals["turn"] | null {
  if (!segments || segments.length === 0 || !(roadLength > 0)) return null;
  const start = resolveSTtoXYWithHeading(segments, 0, 0);
  const end = resolveSTtoXYWithHeading(segments, roadLength, 0);
  if (!start || !end) return null;
  const delta = normalizeAngle(end.heading - start.heading);
  if (!Number.isFinite(delta)) return null;
  return junctionTurnForRelation(classifyTurn(connectingLaneId > 0 ? -delta : delta));
}

/**
 * Collapse movement paths into the per-movement table, keeping only junctions
 * where the split actually carries information.
 *
 * A movement whose heads are identical to its approach's full set tells the
 * caller nothing, so an approach is emitted only when its connecting roads
 * disagree — which is exactly the protected-left signature.
 */
function buildMovementTable(
  paths: readonly MovementPath[],
  approaches: ReadonlyMap<string, ApproachAccumulator>,
  geometryByRoad: ReadonlyMap<number, GeometrySegment[]>,
  roadLengths: ReadonlyMap<number, number>,
): XodrMovementSignals[] {
  const byApproach = new Map<string, MovementPath[]>();
  for (const path of paths) {
    if (path.signalIds.size === 0) continue;
    const list = byApproach.get(path.approachId) ?? [];
    list.push(path);
    byApproach.set(path.approachId, list);
  }

  const movements: XodrMovementSignals[] = [];
  for (const [approachId, list] of byApproach) {
    const distinct = new Set(
      list.map((path) => [...path.signalIds].sort(compareSignalIds).join(",")),
    );
    if (distinct.size < 2) continue; // one head for the whole approach

    const grouped = new Map<
      XodrMovementSignals["turn"],
      { signalIds: Set<string>; connectingRoadIds: Set<string> }
    >();
    let unclassified = false;
    for (const path of list) {
      const turn = connectingRoadTurn(
        geometryByRoad.get(path.connectingRoadId),
        roadLengths.get(path.connectingRoadId) ?? 0,
        path.connectingLaneId,
      );
      if (!turn) {
        unclassified = true;
        break;
      }
      const entry = grouped.get(turn) ?? {
        signalIds: new Set<string>(),
        connectingRoadIds: new Set<string>(),
      };
      for (const id of path.signalIds) entry.signalIds.add(id);
      entry.connectingRoadIds.add(String(path.connectingRoadId));
      grouped.set(turn, entry);
    }
    // A movement path we cannot classify would silently fold its heads into
    // whichever turn happened to classify, so drop the whole approach and let
    // the approach-level union stand.
    if (unclassified) continue;

    const approach = approaches.get(approachId);
    for (const [turn, entry] of grouped) {
      const signalIds = [...entry.signalIds].sort(compareSignalIds);
      // Nothing gained if this turn sees every head the approach has.
      if (approach && signalIds.length === approach.signalIds.size) continue;
      movements.push({
        movement_id: `${approachId}:${turn}`,
        approach_id: approachId,
        turn,
        signal_ids: signalIds,
        connecting_road_ids: [...entry.connectingRoadIds].sort(compareSignalIds),
      });
    }
  }
  return movements.sort((a, b) => a.movement_id.localeCompare(b.movement_id));
}

/**
 * Build the junction → approach → signal-id table for a whole map.
 *
 * Pure and deterministic: junctions ascend by numeric id, approaches and phase
 * groups sort by their own ids, and controller ids are allocated in that same
 * traversal order, so identical input bytes always yield identical output.
 */
export function deriveXodrSignalGroups(xodr: string): DeriveXodrSignalGroupsResult {
  const { roads, junctions } = parseXodr(xodr);
  const { signalsByRoad, geometryByRoad, maxNumericId } = parseSignalsAndGeometry(xodr);
  const existingControl = existingControlState(xodr);

  const assignedSignals = new Set<string>();
  const lastSection = (roadId: number) =>
    Math.max(0, (roads.get(roadId)?.sections.length ?? 1) - 1);

  const orderedJunctions = [...junctions].sort((a, b) => a.id - b.id);
  const approachesByJunction = new Map<string, Map<string, ApproachAccumulator>>();
  const pathsByJunction = new Map<string, MovementPath[]>();
  const roadLengths = new Map<number, number>(
    [...roads.values()].map((road) => [road.id, road.length]),
  );

  // ---- Pass 1: every approach of every junction.
  for (const junction of orderedJunctions) {
    const junctionId = String(junction.id);
    const approaches = new Map<string, ApproachAccumulator>();
    // Which approaches a connecting road feeds. One connecting road can serve
    // several (a shared left-turn pocket), so this is a set, not a scalar.
    const approachesByConnectingRoad = new Map<number, Set<string>>();

    const remember = (incomingId: number, section: number, side: ApproachSide): string => {
      const approachId = `${incomingId}.${section}.${side}`;
      if (!approaches.has(approachId)) {
        const incoming = roads.get(incomingId);
        approaches.set(approachId, {
          approachId,
          roadId: incomingId,
          section,
          side,
          signalIds: new Set(),
          heading: approachHeading(
            geometryByRoad.get(incomingId),
            incoming?.length ?? 0,
            side,
          ),
        });
      }
      return approachId;
    };

    for (const connection of junction.connections) {
      const incoming = roads.get(connection.incomingRoad);
      if (!incoming) continue;
      // Which end of the incoming road meets this junction — the same test
      // `buildMapTopologyIndex` applies when it builds gate approach rsls.
      const junctionAtEnd =
        incoming.successor?.elementType === "junction" &&
        incoming.successor.elementId === junctionId;
      const section = junctionAtEnd ? lastSection(incoming.id) : 0;

      const approachIds: string[] = [];
      const paths = pathsByJunction.get(junctionId) ?? [];
      for (const laneLink of connection.laneLinks) {
        if (laneLink.from === 0) continue; // centre lane is not drivable
        const approachId = remember(incoming.id, section, laneLink.from < 0 ? "r" : "l");
        approachIds.push(approachId);
        // One path per lane link: the movement this connecting lane carries.
        paths.push({
          approachId,
          connectingRoadId: connection.connectingRoad,
          connectingLaneId: laneLink.to,
          signalIds: new Set(),
        });
      }
      pathsByJunction.set(junctionId, paths);
      if (approachIds.length === 0) {
        // `<laneLink>` is optional in OpenDRIVE and real exports omit it (the
        // DeepMap corpus has bare `<connection incomingRoad="59" .../>`
        // elements). Without it there is no lane-id sign to read the side off,
        // so fall back to which end of the road meets the junction: `+s`
        // traffic arrives at the end, `-s` traffic at s = 0.
        const side: ApproachSide | null = junctionAtEnd
          ? "r"
          : incoming.predecessor?.elementType === "junction" &&
              incoming.predecessor.elementId === junctionId
            ? "l"
            : null;
        if (!side) continue;
        approachIds.push(remember(incoming.id, section, side));
      }

      const forConnecting =
        approachesByConnectingRoad.get(connection.connectingRoad) ?? new Set<string>();
      for (const approachId of approachIds) forConnecting.add(approachId);
      approachesByConnectingRoad.set(connection.connectingRoad, forConnecting);
    }

    // Rule 1 (primary): a signal on a connecting road governs every approach
    // that connecting road serves. Exact — no geometry, no orientation.
    const paths = pathsByJunction.get(junctionId) ?? [];
    for (const [connectingRoadId, approachIds] of approachesByConnectingRoad) {
      for (const signal of signalsByRoad.get(connectingRoadId) ?? []) {
        for (const approachId of approachIds) {
          approaches.get(approachId)?.signalIds.add(signal.id);
        }
        // Same heads, kept at movement-path grain so a per-turn split stays
        // recoverable when connecting roads off one approach disagree.
        for (const path of paths) {
          if (path.connectingRoadId === connectingRoadId) path.signalIds.add(signal.id);
        }
        assignedSignals.add(signal.id);
      }
    }

    approachesByJunction.set(junctionId, approaches);
  }

  // ---- Pass 2: signals sitting on the approach road itself.
  //
  // Global rather than per-junction, because one road can be an approach to a
  // junction at each end: a signal is awarded to the NEAREST compatible
  // junction end only, so a light for one intersection cannot also be claimed
  // by the next one down the street.
  const approachesByRoad = new Map<number, ApproachAccumulator[]>();
  for (const approaches of approachesByJunction.values()) {
    for (const approach of approaches.values()) {
      const list = approachesByRoad.get(approach.roadId) ?? [];
      list.push(approach);
      approachesByRoad.set(approach.roadId, list);
    }
  }
  for (const [roadId, approaches] of approachesByRoad) {
    const road = roads.get(roadId);
    if (!road || road.junction !== -1) continue;
    for (const signal of signalsByRoad.get(roadId) ?? []) {
      let best: ApproachAccumulator | undefined;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const approach of approaches) {
        // `orientation` picks the side when the exporter sets it; the sign of
        // `t` is the fallback (lanes right of the reference line have negative
        // ids and negative t).
        if (!signalAppliesToSide(signal, approach.side)) continue;
        const distance = Math.abs(signal.s - (approach.side === "r" ? road.length : 0));
        if (distance > APPROACH_SIGNAL_MAX_DISTANCE_M) continue;
        if (
          distance < bestDistance ||
          (distance === bestDistance &&
            best !== undefined &&
            approach.approachId.localeCompare(best.approachId) < 0)
        ) {
          best = approach;
          bestDistance = distance;
        }
      }
      if (!best) continue;
      best.signalIds.add(signal.id);
      assignedSignals.add(signal.id);
    }
  }

  // ---- Pass 3: phase groups and controller ids.
  const results: XodrJunctionSignalGroup[] = [];
  for (const junction of orderedJunctions) {
    const junctionId = String(junction.id);
    const approaches = approachesByJunction.get(junctionId);
    if (!approaches) continue;
    const signalized = [...approaches.values()]
      .filter((a) => a.signalIds.size > 0)
      .sort((a, b) => a.approachId.localeCompare(b.approachId));
    if (signalized.length === 0) continue;

    const { groups, grouping } = partitionIntoPhaseGroups(signalized);

    results.push({
      junction_id: junctionId,
      movements: buildMovementTable(
        pathsByJunction.get(junctionId) ?? [],
        approaches,
        geometryByRoad,
        roadLengths,
      ),
      approaches: signalized.map((a) => ({
        approach_id: a.approachId,
        road_id: String(a.roadId),
        section: a.section,
        side: a.side,
        signal_ids: [...a.signalIds].sort(compareSignalIds),
        approach_heading_rad: a.heading,
      })),
      // Controller ids are filled in below, once every junction is known, so
      // that allocation order is the junction traversal order.
      phase_groups: groups.map((group) => ({
        key: group.key,
        approach_ids: group.approachIds,
        signal_ids: group.signalIds,
        controller_id: "",
        controller_name: `sf:${junctionId}:${group.key}`,
      })),
      grouping,
      had_existing_controllers:
        existingControl.junctionIds.has(junctionId) ||
        signalized.some((approach) =>
          [...approach.signalIds].some((id) => existingControl.controlledSignalIds.has(id)),
        ),
    });
  }

  const controllerIdBase = maxNumericId + 1;
  let nextControllerId = controllerIdBase;
  for (const junction of results) {
    for (const group of junction.phase_groups) {
      group.controller_id = String(nextControllerId);
      nextControllerId += 1;
    }
  }

  const unassigned: string[] = [];
  for (const list of signalsByRoad.values()) {
    for (const signal of list) {
      if (!assignedSignals.has(signal.id)) unassigned.push(signal.id);
    }
  }

  return {
    junctions: results,
    unassigned_signal_ids: [...new Set(unassigned)].sort(compareSignalIds),
    controller_id_base: controllerIdBase,
  };
}

/** Numeric where both ids are numeric (the common case), lexical otherwise. */
function compareSignalIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.localeCompare(b);
}

function signalAppliesToSide(signal: ParsedSignal, side: ApproachSide): boolean {
  // orientation "+" is valid for traffic travelling with +s, which is the
  // right-side (negative-id) lanes; "-" is the left side. "none"/"both" leave
  // it open, so fall back to which side of the reference line the head sits on.
  const orientation = signal.orientation;
  if (orientation === "+") return side === "r";
  if (orientation === "-") return side === "l";
  if (signal.t === 0) return true;
  return signal.t < 0 ? side === "r" : side === "l";
}

type RawPhaseGroup = { key: string; approachIds: string[]; signalIds: string[] };

/**
 * Partition signalized approaches into groups that share a green.
 *
 * Preferred: pair each approach with the arm most nearly antiparallel to it —
 * the opposing arm of the same street, which is what really runs concurrently
 * at a real intersection. Greedy over all candidate pairs sorted by how close
 * to antiparallel they are, with ties broken on approach id, so the result does
 * not depend on input order.
 *
 * Fallback (plan section 7, risk 2): when headings are missing, split on the
 * north-south / east-west axis; with no headings at all that degenerates to a
 * single group, which is still a usable (if conservative) all-red-then-green
 * program rather than nothing.
 */
function partitionIntoPhaseGroups(
  approaches: readonly ApproachAccumulator[],
): { groups: RawPhaseGroup[]; grouping: XodrPhaseGrouping } {
  const byId = new Map(approaches.map((a) => [a.approachId, a]));
  const withHeading = approaches.filter((a) => a.heading != null);

  if (withHeading.length === approaches.length && approaches.length > 1) {
    const candidates: Array<{ a: string; b: string; delta: number }> = [];
    for (let i = 0; i < approaches.length; i += 1) {
      for (let j = i + 1; j < approaches.length; j += 1) {
        const left = approaches[i]!;
        const right = approaches[j]!;
        // Opposing arms enter the junction from opposite sides, so their
        // travel headings are ~pi apart.
        const delta = Math.abs(
          angularDistance(left.heading!, right.heading!) - Math.PI,
        );
        if (delta <= OPPOSING_TOLERANCE_RAD) {
          candidates.push({ a: left.approachId, b: right.approachId, delta });
        }
      }
    }
    candidates.sort(
      (x, y) => x.delta - y.delta || x.a.localeCompare(y.a) || x.b.localeCompare(y.b),
    );

    const paired = new Set<string>();
    const groups: string[][] = [];
    for (const candidate of candidates) {
      if (paired.has(candidate.a) || paired.has(candidate.b)) continue;
      paired.add(candidate.a);
      paired.add(candidate.b);
      groups.push([candidate.a, candidate.b].sort());
    }
    if (groups.length > 0) {
      for (const approach of approaches) {
        if (!paired.has(approach.approachId)) groups.push([approach.approachId]);
      }
      return { groups: groups.map((ids) => buildGroup(ids, byId)).sort(byKey), grouping: "opposing_pairs" };
    }
  }

  const buckets = new Map<string, string[]>();
  for (const approach of approaches) {
    const axis = axisOf(approach.heading);
    const bucket = buckets.get(axis) ?? [];
    bucket.push(approach.approachId);
    buckets.set(axis, bucket);
  }
  const groups = [...buckets.values()].map((ids) => buildGroup([...ids].sort(), byId));
  return { groups: groups.sort(byKey), grouping: "axis_fallback" };
}

function byKey(a: RawPhaseGroup, b: RawPhaseGroup): number {
  return a.key.localeCompare(b.key);
}

function buildGroup(
  approachIds: readonly string[],
  byId: Map<string, ApproachAccumulator>,
): RawPhaseGroup {
  const sorted = [...approachIds].sort();
  const signalIds = new Set<string>();
  const headings: number[] = [];
  for (const id of sorted) {
    const approach = byId.get(id);
    if (!approach) continue;
    for (const signalId of approach.signalIds) signalIds.add(signalId);
    if (approach.heading != null) headings.push(approach.heading);
  }
  // The group's axis, from the arm whose id sorts first — a content-derived
  // choice, so the key cannot shift when an unrelated arm is added.
  const axis = axisOf(byId.get(sorted[0]!)?.heading ?? null);
  return {
    key: `${axis}:${sorted[0]!}`,
    approachIds: sorted,
    signalIds: [...signalIds].sort(compareSignalIds),
  };
}

// ---------------------------------------------------------------------------
// Reverse index: signal id -> what it governs
// ---------------------------------------------------------------------------

/** What a single OpenDRIVE `<signal>` governs. */
export type XodrSignalPlacement = {
  junction_id: string;
  /** Approaches this head serves, sorted. Usually one; two on a shared mast. */
  approach_ids: string[];
  /** `key` of the phase group the head belongs to. */
  phase_group_key: string;
};

/**
 * Invert the grouping: OpenDRIVE `<signal>` id → the approaches it governs.
 *
 * For the canvas: clicking a bulb glyph resolves to its approaches, and the
 * intersection panel composes movement ids from those with the turns it already
 * has (`formatMovementId(approach_id, turn)`). The turn cannot come from here —
 * the xodr has no turn labels, and a head serves every turn off its approach.
 */
export function buildSignalPlacementIndex(
  result: DeriveXodrSignalGroupsResult,
): Record<string, XodrSignalPlacement> {
  const index: Record<string, XodrSignalPlacement> = {};
  for (const junction of result.junctions) {
    const groupKeyByApproach = new Map<string, string>();
    for (const group of junction.phase_groups) {
      for (const approachId of group.approach_ids) {
        groupKeyByApproach.set(approachId, group.key);
      }
    }
    for (const approach of junction.approaches) {
      for (const signalId of approach.signal_ids) {
        const entry = index[signalId] ?? {
          junction_id: junction.junction_id,
          approach_ids: [],
          phase_group_key: groupKeyByApproach.get(approach.approach_id) ?? "",
        };
        if (!entry.approach_ids.includes(approach.approach_id)) {
          entry.approach_ids.push(approach.approach_id);
          entry.approach_ids.sort();
        }
        index[signalId] = entry;
      }
    }
  }
  return index;
}

// ---------------------------------------------------------------------------
// The seam into scenario-signals.ts
// ---------------------------------------------------------------------------

/** Structural view of `JunctionGateInput` — kept structural so this module carries no dependency on scenario-signals.ts. */
export interface GateWithSignals {
  approach_lane_rsl: string;
  signal_ids?: readonly string[];
  [key: string]: unknown;
}

/**
 * Fill `signal_ids` on gates produced by `junctionGatesFromTopology`.
 *
 * The topology index has no signal data, so this is the step that closes the
 * loop: `junctionGatesFromTopology(index, jid)` → `attachSignalIdsToGates(...)`
 * → `deriveJunctionMovements(...)` yields movement bindings whose `signal_ids`
 * are populated.
 *
 * Gates already carrying signal ids keep them (union, not overwrite). Every
 * gate off one approach inherits that approach's heads, so `left`, `straight`
 * and `right` off the same approach share ids — see the module header.
 */
export function attachSignalIdsToGates<T extends GateWithSignals>(
  gates: readonly T[],
  group: XodrJunctionSignalGroup | undefined,
): T[] {
  if (!group) return [...gates];
  const byApproach = new Map(
    group.approaches.map((approach) => [approach.approach_id, approach.signal_ids]),
  );
  return gates.map((gate) => {
    const approachId = approachIdOfLaneRsl(gate.approach_lane_rsl);
    const derived = approachId ? byApproach.get(approachId) : undefined;
    if (!derived || derived.length === 0) return gate;
    const merged = [...new Set([...(gate.signal_ids ?? []), ...derived])].sort(
      compareSignalIds,
    );
    return { ...gate, signal_ids: merged };
  });
}

/** Structural view of `JunctionMovementBinding` — the two fields refinement touches. */
export interface MovementBindingWithSignals {
  movement_id: string;
  signal_ids?: readonly string[];
  [key: string]: unknown;
}

/**
 * Narrow already-derived movement bindings to their own heads, where the map
 * wires per-movement signals.
 *
 * Run this AFTER `deriveJunctionMovements`. `attachSignalIdsToGates` gives
 * every turn off an approach that approach's full head set, which is correct
 * whenever one head serves the approach; this replaces that union with the
 * narrower set on the movements that genuinely have their own head — the
 * protected-left case. It is what makes "left red, through green" authorable
 * rather than a `shared_signal_heads` warning.
 *
 * Deliberately conservative. A binding is only ever touched when its
 * `movement_id` matches exactly, so a turn this module classifies differently
 * from `buildMapTopologyIndex` simply does not match and keeps whatever it had.
 * Bindings are otherwise returned untouched, spread not rebuilt.
 *
 * Two cases, and they differ. A binding that already carries approach-level ids
 * is intersected with the narrower set, so the result is always a subset of
 * what the caller had. A binding carrying NO ids is given the narrowed set
 * outright — an addition, not a narrowing. That is intentional: an empty
 * `signal_ids` sends the worker down its `approach_lane_rsls` matching
 * fallback, so real heads are strictly better than none.
 */
export function refineMovementSignalIds<T extends MovementBindingWithSignals>(
  bindings: readonly T[],
  group: XodrJunctionSignalGroup | undefined,
): T[] {
  if (!group || group.movements.length === 0) return [...bindings];
  const byMovement = new Map(
    group.movements.map((movement) => [movement.movement_id, movement.signal_ids]),
  );
  return bindings.map((binding) => {
    const narrowed = byMovement.get(binding.movement_id);
    if (!narrowed || narrowed.length === 0) return binding;
    // Intersect when the caller has ids (never invent one it did not know
    // about); adopt outright when it has none. See the doc comment.
    const known = new Set(binding.signal_ids ?? []);
    const kept = known.size > 0 ? narrowed.filter((id) => known.has(id)) : [...narrowed];
    if (kept.length === 0) return binding;
    return { ...binding, signal_ids: kept };
  });
}

/**
 * `"<road>:<section>:<lane>"` → `"<road>.<section>.<side>"`.
 *
 * Duplicated from `approachIdFromLaneRsl` in `scenario-signals.ts` rather than
 * imported, to keep this module free of a dependency on the authoring schema
 * (which imports the behavior schema, which imports zod). The two are covered
 * by an equivalence test.
 */
function approachIdOfLaneRsl(rsl: string): string | null {
  const parts = rsl.trim().split(":");
  if (parts.length !== 3) return null;
  const [roadId, section, lane] = parts as [string, string, string];
  const laneId = Number(lane);
  if (!roadId || !section || !Number.isFinite(laneId) || laneId === 0) return null;
  return `${roadId}.${section}.${laneId < 0 ? "r" : "l"}`;
}
