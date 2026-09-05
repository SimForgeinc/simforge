/**
 * Pure builder for the map topology index (schema v2) — **pure XODR**.
 *
 * No I/O. Parses OpenDRIVE text and returns a `MapTopologyIndex` built
 * from the XODR's own directed connectivity (lane/road `<link>` + junction
 * `<connection>`), keyed by `road:section:lane` (the runtime/CARLA key).
 * Turn labels are derived from each connecting road's `<planView>` net
 * heading change. See `types.ts` for the rationale (CARLA never sees the
 * geojson; XODR connectivity is unambiguously directed → R3 dissolves).
 *
 * v2: every lane now carries a sampled centerline `polyline` in
 * runtime-world meters. The reference line is integrated from each
 * `<geometry>` (line / arc / spiral) in `<planView>`, then per-lane
 * widths and `<laneOffset>` polynomials place the lane center
 * perpendicular to the reference line. The polyline is stored in
 * reference-line s-increasing order regardless of lane sign — callers
 * orient by endpoint proximity at concatenation time. This lets the
 * gate-driven planner resolve gate geometry without consulting the
 * geojson-derived runtime lane-graph (which doesn't cover every XODR
 * lane the topology references — the bug Path A solves).
 *
 * v3: Timed instructions lane changes need cached lane width, adjacency, and
 * permission metadata. The builder materializes conservative same-section,
 * same-direction adjacency and permission intervals from the XODR lane stack.
 */
import { classifyJunctionTurn, type JunctionTurn } from "../junction-direction";
import { laneTravelIncreasesSByConvention } from "./lane-travel";
import {
  CARLA_RUNTIME_ALLOWED_LANE_TYPES,
  MAP_TOPOLOGY_SCHEMA_VERSION,
  type MapTopologyIndex,
  type TopologyGate,
  type TopologyJunction,
  type TopologyLane,
  type TurnRelation,
  type Vec2,
} from "./types";

// ── XODR parse (bounded line scan; never DOM — Page_Mill is 34 MB) ──────────

type Poly3 = { sOffset: number; a: number; b: number; c: number; d: number };

interface XLane {
  id: number;
  type: string;
  predIds: number[];
  succIds: number[];
  widths: Poly3[];
  /**
   * RoadRunner lane GUID from `<userData><vectorLane laneId="{…}">`, brace form
   * preserved. This is the SAME id the authored RoadRunner GeoJSON carries as a
   * lane feature's `Id`, so it links a reconstructed lane polygon back to its
   * centerline feature exactly — no geometric matching needed.
   */
  guid?: string;
}
interface XSection {
  /** Start `s` of this section in road frame (m). */
  s: number;
  lanes: XLane[];
}
interface XRoadLink {
  elementType: string;
  elementId: string;
  contactPoint: string | null;
}
type XGeomKind =
  | { kind: "line" }
  | { kind: "arc"; curvature: number }
  | { kind: "spiral"; curvStart: number; curvEnd: number };
interface XGeom {
  /** Start s of this geometry block in road frame (m). */
  s: number;
  /** Start position (world). */
  x: number;
  y: number;
  /** Start heading (rad). */
  hdg: number;
  /** Arc length of this geometry block (m). */
  length: number;
  kind: XGeomKind;
}
interface XRoad {
  id: number;
  junction: number; // -1 = not a connecting road
  /** XODR `<road length>` (m). */
  length: number;
  speedKph: number | null;
  predecessor: XRoadLink | null;
  successor: XRoadLink | null;
  sections: XSection[];
  geom: XGeom[];
  /** Lateral shifts of the reference line, indexed by start s. */
  laneOffsets: Poly3[];
}
interface XLaneLink {
  from: number;
  to: number;
}
interface XConnection {
  incomingRoad: number;
  connectingRoad: number;
  contactPoint: string; // start | end
  laneLinks: XLaneLink[];
}
interface XJunction {
  id: number;
  connections: XConnection[];
}

// OpenDRIVE does not constrain attribute order, and exporters disagree
// (`<road id name junction>` vs `<road name junction id>`; `<lane id type>`
// vs `<lane type id>`; …). So every tag is matched by NAME only, and its
// attributes are read by KEY from `parseAttrs` — never positionally. The
// `\b` after the tag name keeps siblings apart: `/<lane\b/` ignores
// `<lanes>`, `<laneSection>`, `<laneLink>`, `<laneOffset>` (a word char
// follows "lane" in each). The scan stays line-oriented — a single tag
// whose attributes are split across physical lines is not supported (no
// exporter in the corpus does that, and per-tag buffering of 34 MB files
// is not worth the regression surface).
const RE_ROAD_OPEN = /<road\b/;
const RE_LINK_EL = /<(predecessor|successor)\b/;
const RE_SPEED = /<speed\b/;
const RE_SECTION = /<laneSection\b/;
const RE_LANE = /<lane\b/;
const RE_VECTOR_LANE = /<vectorLane\b/;
const RE_GEOM = /<geometry\b/;
const RE_ARC = /<arc\b/;
const RE_SPIRAL = /<spiral\b/;
const RE_LINE_SELFCLOSING = /<line\s*\/>/;
const RE_LANE_OFFSET = /<laneOffset\b/;
const RE_WIDTH = /<width\b/;
const RE_JUNCTION = /<junction\b/;
const RE_CONNECTION = /<connection\b/;
const RE_LANELINK = /<laneLink\b/;

/** Every `key="value"` pair on a tag line, keyed by name (order-free). */
const ATTR_RE = /([A-Za-z_][\w.-]*)="([^"]*)"/g;
function parseAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(line)) !== null) out[m[1]!] = m[2]!;
  return out;
}
/**
 * Numeric attribute by key, or `undefined` when absent/empty/non-numeric.
 *
 * Non-numeric values resolve to `undefined`, not `NaN`: every caller
 * gates on `!== undefined`, so a `NaN` id would otherwise be accepted and
 * propagated (e.g. several non-numeric road ids collapsing onto a single
 * `NaN` Map key and overwriting each other). Treating malformed numeric
 * attributes as missing matches the old positional-regex behaviour, which
 * required `\d+` and silently skipped anything else.
 */
function attrNum(a: Record<string, string>, k: string): number | undefined {
  const v = a[k];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isNaN(n) ? undefined : n;
}

interface ParsedXodr {
  roads: Map<number, XRoad>;
  junctions: XJunction[];
}

export function parseXodr(xodr: string): ParsedXodr {
  const roads = new Map<number, XRoad>();
  const junctions: XJunction[] = [];

  let road: XRoad | null = null;
  let section: XSection | null = null;
  let lane: XLane | null = null;
  let inLaneLinkScope = false;
  let pendingGeom: XGeom | null = null;
  let junction: XJunction | null = null;
  let connection: XConnection | null = null;

  const poly3 = (a: Record<string, string>): Poly3 | null => {
    // `<width>` keys on `sOffset`; `<laneOffset>` keys on `s`.
    const sOffset = attrNum(a, "sOffset") ?? attrNum(a, "s");
    const A = attrNum(a, "a");
    const B = attrNum(a, "b");
    const C = attrNum(a, "c");
    const D = attrNum(a, "d");
    if (
      sOffset === undefined || A === undefined || B === undefined ||
      C === undefined || D === undefined
    ) {
      return null;
    }
    return { sOffset, a: A, b: B, c: C, d: D };
  };

  for (const line of xodr.split("\n")) {
    if (RE_JUNCTION.test(line)) {
      const id = attrNum(parseAttrs(line), "id");
      if (id !== undefined) {
        junction = { id, connections: [] };
        junctions.push(junction);
        connection = null;
        continue;
      }
    }
    if (junction) {
      if (RE_CONNECTION.test(line)) {
        const a = parseAttrs(line);
        const incomingRoad = attrNum(a, "incomingRoad");
        const connectingRoad = attrNum(a, "connectingRoad");
        if (incomingRoad !== undefined && connectingRoad !== undefined) {
          connection = {
            incomingRoad,
            connectingRoad,
            contactPoint: a.contactPoint ?? "start",
            laneLinks: [],
          };
          junction.connections.push(connection);
          continue;
        }
      }
      if (connection && RE_LANELINK.test(line)) {
        const a = parseAttrs(line);
        const from = attrNum(a, "from");
        const to = attrNum(a, "to");
        if (from !== undefined && to !== undefined) {
          connection.laneLinks.push({ from, to });
          continue;
        }
      }
      if (line.includes("</junction>")) {
        junction = null;
        connection = null;
      }
      continue;
    }

    // Road open — attributes in any order; read each by name.
    if (RE_ROAD_OPEN.test(line)) {
      const a = parseAttrs(line);
      const id = attrNum(a, "id");
      const junctionId = attrNum(a, "junction");
      if (id !== undefined && junctionId !== undefined) {
        road = {
          id,
          junction: junctionId,
          length: attrNum(a, "length") ?? 0,
          speedKph: null,
          predecessor: null,
          successor: null,
          sections: [],
          geom: [],
          laneOffsets: [],
        };
        roads.set(road.id, road);
        section = null;
        lane = null;
        pendingGeom = null;
        continue;
      }
    }
    if (!road) continue;

    // Road-level `<predecessor>`/`<successor>` (carry `elementType`). Lane-
    // level links (only an `id`) are handled later, inside lane link scope.
    const rl = !lane ? RE_LINK_EL.exec(line) : null;
    if (rl) {
      const a = parseAttrs(line);
      if (a.elementType !== undefined) {
        const link: XRoadLink = {
          elementType: a.elementType,
          elementId: a.elementId ?? "",
          contactPoint: a.contactPoint ?? null,
        };
        if (rl[1] === "predecessor") road.predecessor = link;
        else road.successor = link;
        continue;
      }
    }

    if (RE_GEOM.test(line)) {
      const a = parseAttrs(line);
      const s = attrNum(a, "s");
      const x = attrNum(a, "x");
      const y = attrNum(a, "y");
      const hdg = attrNum(a, "hdg");
      const length = attrNum(a, "length");
      if (
        s !== undefined && x !== undefined && y !== undefined &&
        hdg !== undefined && length !== undefined
      ) {
        pendingGeom = {
          s, x, y, hdg, length,
          // Filled by the child element on the next line(s).
          kind: { kind: "line" },
        };
        road.geom.push(pendingGeom);
        continue;
      }
    }
    if (pendingGeom) {
      if (RE_LINE_SELFCLOSING.test(line)) {
        pendingGeom.kind = { kind: "line" };
        pendingGeom = null;
        continue;
      }
      if (RE_ARC.test(line)) {
        const curvature = attrNum(parseAttrs(line), "curvature");
        if (curvature !== undefined) {
          pendingGeom.kind = { kind: "arc", curvature };
          pendingGeom = null;
          continue;
        }
      }
      if (RE_SPIRAL.test(line)) {
        const a = parseAttrs(line);
        const curvStart = attrNum(a, "curvStart");
        const curvEnd = attrNum(a, "curvEnd");
        if (curvStart !== undefined && curvEnd !== undefined) {
          pendingGeom.kind = { kind: "spiral", curvStart, curvEnd };
          pendingGeom = null;
          continue;
        }
      }
    }

    if (!lane && RE_LANE_OFFSET.test(line)) {
      const rec = poly3(parseAttrs(line));
      if (rec) {
        road.laneOffsets.push(rec);
        continue;
      }
    }

    if (road.speedKph == null && RE_SPEED.test(line)) {
      const a = parseAttrs(line);
      const v = attrNum(a, "max");
      if (v !== undefined) {
        road.speedKph = /mph/i.test(a.unit ?? "")
          ? Math.round(v * 1.609344)
          : Math.round(v);
      }
    }

    if (RE_SECTION.test(line)) {
      section = { s: attrNum(parseAttrs(line), "s") ?? 0, lanes: [] };
      road.sections.push(section);
      lane = null;
      continue;
    }
    if (section && RE_LANE.test(line)) {
      const a = parseAttrs(line);
      const id = attrNum(a, "id");
      const type = a.type;
      if (id !== undefined && type !== undefined) {
        lane = {
          id,
          type: type.toLowerCase(),
          predIds: [],
          succIds: [],
          widths: [],
        };
        section.lanes.push(lane);
        inLaneLinkScope = false;
        continue;
      }
    }
    if (lane && RE_VECTOR_LANE.test(line)) {
      const laneId = parseAttrs(line).laneId;
      if (laneId) {
        lane.guid = laneId;
        continue;
      }
    }
    if (lane && RE_WIDTH.test(line)) {
      const rec = poly3(parseAttrs(line));
      if (rec) {
        lane.widths.push(rec);
        continue;
      }
    }
    if (line.includes("<link>") && lane) inLaneLinkScope = true;
    if (line.includes("</link>")) inLaneLinkScope = false;
    const lll = lane && inLaneLinkScope ? RE_LINK_EL.exec(line) : null;
    if (lll && lane) {
      const a = parseAttrs(line);
      const id = attrNum(a, "id");
      if (id !== undefined && a.elementType === undefined) {
        if (lll[1] === "predecessor") lane.predIds.push(id);
        else lane.succIds.push(id);
      }
    }
  }

  // Sort poly3 records by s so the "last record with s ≤ query" lookup is
  // a simple linear walk in order. XODR usually emits them sorted, but
  // hand-edited files have surprised us.
  for (const r of roads.values()) {
    r.laneOffsets.sort((a, b) => a.sOffset - b.sOffset);
    for (const sec of r.sections) {
      for (const ln of sec.lanes) ln.widths.sort((a, b) => a.sOffset - b.sOffset);
    }
  }

  return { roads, junctions };
}

// ── Reference-line + lane polyline sampling ─────────────────────────────────

/** Sampling step in meters. Junction-internal lanes and the actual
 *  sampler use a finer step (0.5m) for curvature fidelity; long
 *  non-junction lanes can coast at 1.0m. */
const STEP_NORMAL_M = 1.0;
const STEP_JUNCTION_M = 0.5;
/** Spiral integration micro-step (must be ≤ STEP_*M so each sample
 *  step does ≥1 integration step). */
const SPIRAL_MICRO_M = 0.1;

/** Point on a single planView geometry block at local arclength `t` ∈ [0,length]. */
function pointOnGeom(g: XGeom, t: number): { x: number; y: number; hdg: number } {
  const tt = Math.max(0, Math.min(g.length, t));
  if (g.kind.kind === "line") {
    return {
      x: g.x + tt * Math.cos(g.hdg),
      y: g.y + tt * Math.sin(g.hdg),
      hdg: g.hdg,
    };
  }
  if (g.kind.kind === "arc") {
    const k = g.kind.curvature;
    if (Math.abs(k) < 1e-12) {
      return {
        x: g.x + tt * Math.cos(g.hdg),
        y: g.y + tt * Math.sin(g.hdg),
        hdg: g.hdg,
      };
    }
    const theta = g.hdg + k * tt;
    const x = g.x + (Math.sin(theta) - Math.sin(g.hdg)) / k;
    const y = g.y - (Math.cos(theta) - Math.cos(g.hdg)) / k;
    return { x, y, hdg: theta };
  }
  // Clothoid: curvature varies linearly κ(u) = κ0 + (κ1-κ0)·u/L.
  // Integrate cos/sin of θ(u) = hdg + κ0·u + (κ1-κ0)·u²/(2L).
  const { curvStart: k0, curvEnd: k1 } = g.kind;
  const L = Math.max(1e-9, g.length);
  const microSteps = Math.max(1, Math.ceil(tt / SPIRAL_MICRO_M));
  const du = tt / microSteps;
  let x = g.x;
  let y = g.y;
  for (let i = 0; i < microSteps; i++) {
    const um = (i + 0.5) * du;
    const thetaMid = g.hdg + k0 * um + ((k1 - k0) * um * um) / (2 * L);
    x += du * Math.cos(thetaMid);
    y += du * Math.sin(thetaMid);
  }
  const hdgEnd = g.hdg + k0 * tt + ((k1 - k0) * tt * tt) / (2 * L);
  return { x, y, hdg: hdgEnd };
}

/** Point on the road's reference line at absolute road `s`. */
export function refLineAt(road: XRoad, s: number): { x: number; y: number; hdg: number } | null {
  if (road.geom.length === 0) return null;
  // Bracket: find the geometry block containing `s`.
  let g = road.geom[0]!;
  for (const candidate of road.geom) {
    if (candidate.s <= s + 1e-9) g = candidate;
    else break;
  }
  const local = s - g.s;
  return pointOnGeom(g, local);
}

/** Evaluate the latest poly3 record with `sOffset ≤ tQuery` at t=tQuery-sOffset. */
function evalPoly3(records: Poly3[], tQuery: number): number {
  if (records.length === 0) return 0;
  let chosen = records[0]!;
  for (const r of records) {
    if (r.sOffset <= tQuery + 1e-9) chosen = r;
    else break;
  }
  const t = tQuery - chosen.sOffset;
  return chosen.a + chosen.b * t + chosen.c * t * t + chosen.d * t * t * t;
}

/** Lateral offset of the reference line at road `s` (positive = left). */
function laneOffsetAt(road: XRoad, s: number): number {
  return evalPoly3(road.laneOffsets, s);
}

/** Width of a lane at section-local `t` (sectionLocalS = roadS - section.s). */
function laneWidthAt(lane: XLane, sectionLocalS: number): number {
  return evalPoly3(lane.widths, sectionLocalS);
}

function laneWidthSamples(section: XSection, lane: XLane, roadLength: number) {
  const nextSectionS = Number.POSITIVE_INFINITY;
  const sectionEndS = Math.min(roadLength, nextSectionS);
  const length = Math.max(0, sectionEndS - section.s);
  const sampleOffsets = Array.from(new Set([0, length / 2, length]))
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((a, b) => a - b);
  return sampleOffsets
    .map((s) => ({ s, widthM: laneWidthAt(lane, s) }))
    .filter((sample) => Number.isFinite(sample.widthM) && sample.widthM > 0);
}

function representativeLaneWidthM(section: XSection, lane: XLane, roadLength: number) {
  const samples = laneWidthSamples(section, lane, roadLength);
  if (samples.length === 0) return null;
  return samples.reduce((sum, sample) => sum + sample.widthM, 0) / samples.length;
}

/**
 * Centerline lateral position of the target lane at road `s`, relative
 * to the reference line (positive = left of reference line direction).
 *
 * Walks the lane stack outward from `id=0` to `targetLaneId`, summing
 * intermediate lane widths plus half the target lane's width. For
 * left lanes (id>0) this is a sum to the left; for right lanes (id<0)
 * a sum to the right (negated). The `<laneOffset>` shifts the whole
 * stack laterally.
 */
function laneCenterLateral(
  section: XSection,
  targetLaneId: number,
  laneOffset: number,
  sectionLocalS: number,
): number | null {
  if (targetLaneId === 0) return laneOffset;
  const byId = new Map(section.lanes.map((l) => [l.id, l]));
  const sign = targetLaneId > 0 ? 1 : -1;
  const stop = Math.abs(targetLaneId);
  let lateral = laneOffset;
  for (let step = 1; step < stop; step += 1) {
    const inner = byId.get(sign * step);
    if (!inner) {
      // Missing intermediate lane (rare) — bail rather than misplace.
      return null;
    }
    lateral += sign * laneWidthAt(inner, sectionLocalS);
  }
  const target = byId.get(targetLaneId);
  if (!target) return null;
  lateral += sign * (laneWidthAt(target, sectionLocalS) / 2);
  return lateral;
}

/**
 * Sample a lane's centerline polyline in runtime-world meters, in the
 * reference line's s-increasing order (regardless of lane sign).
 *
 * Returns an empty array when the lane has no geometry or any required
 * lane in the lateral stack is missing.
 */
function sampleLanePolyline(
  road: XRoad,
  sectionIdx: number,
  laneId: number,
): Vec2[] {
  const section = road.sections[sectionIdx];
  if (!section) return [];
  const sStart = section.s;
  const sEnd =
    sectionIdx + 1 < road.sections.length
      ? road.sections[sectionIdx + 1]!.s
      : road.length || sStart;
  const length = Math.max(0, sEnd - sStart);
  if (length < 1e-6) return [];

  const step = road.junction !== -1 ? STEP_JUNCTION_M : STEP_NORMAL_M;
  const samples = Math.max(2, Math.ceil(length / step) + 1);
  const out: Vec2[] = [];
  for (let i = 0; i < samples; i += 1) {
    const t = (i / (samples - 1)) * length;
    const s = sStart + t;
    const ref = refLineAt(road, s);
    if (!ref) return [];
    const laneOffset = laneOffsetAt(road, s);
    const lateral = laneCenterLateral(section, laneId, laneOffset, t);
    if (lateral == null) return [];
    // Perpendicular-left at heading h is (-sin h, cos h).
    const px = ref.x + lateral * -Math.sin(ref.hdg);
    const py = ref.y + lateral * Math.cos(ref.hdg);
    out.push({ x: px, y: py });
  }
  return out;
}

// ── Lane-area polygon sampling ──────────────────────────────────────────────

/** A filled lane-area polygon in runtime-world meters (XODR planView frame). */
export interface LanePolygonLocal {
  roadId: number;
  section: number;
  laneId: number;
  /** Lowercased XODR lane `type` (driving / sidewalk / biking / …). */
  laneType: string;
  isJunction: boolean;
  /**
   * RoadRunner lane GUID (`<vectorLane laneId>`), matching the authored GeoJSON
   * lane feature's `Id`. Undefined for lanes the XODR didn't tag (rare).
   */
  laneGuid?: string;
  /**
   * Closed outer ring (last point == first) tracing the lane's inner edge
   * forward then its outer edge back. Reference-line s-increasing order.
   */
  ring: Vec2[];
}

/**
 * Sample the closed ribbon polygon between a lane's inner and outer boundary.
 *
 * Mirrors {@link sampleLanePolyline} but walks both lateral edges instead of
 * the center: at each station the lane center (from {@link laneCenterLateral})
 * is offset by ±half the XODR `<width>` to the inner/outer edge, perpendicular
 * to the reference-line heading. Returns `[]` for degenerate lanes (missing
 * geometry, missing intermediate lane in the stack, or width ~0 everywhere).
 */
function sampleLaneRing(road: XRoad, sectionIdx: number, laneId: number): Vec2[] {
  const section = road.sections[sectionIdx];
  if (!section) return [];
  const sStart = section.s;
  const sEnd =
    sectionIdx + 1 < road.sections.length
      ? road.sections[sectionIdx + 1]!.s
      : road.length || sStart;
  const length = Math.max(0, sEnd - sStart);
  if (length < 1e-6) return [];

  const lane = section.lanes.find((l) => l.id === laneId);
  if (!lane) return [];
  const sign = laneId > 0 ? 1 : -1;

  const step = road.junction !== -1 ? STEP_JUNCTION_M : STEP_NORMAL_M;
  const samples = Math.max(2, Math.ceil(length / step) + 1);

  const inner: Vec2[] = [];
  const outer: Vec2[] = [];
  let maxWidth = 0;
  for (let i = 0; i < samples; i += 1) {
    const t = (i / (samples - 1)) * length;
    const s = sStart + t;
    const ref = refLineAt(road, s);
    if (!ref) return [];
    const laneOffset = laneOffsetAt(road, s);
    const center = laneCenterLateral(section, laneId, laneOffset, t);
    if (center == null) return [];
    const width = laneWidthAt(lane, t);
    if (width > maxWidth) maxWidth = width;
    const half = width / 2;
    // Perpendicular-left at heading h is (-sin h, cos h).
    const nx = -Math.sin(ref.hdg);
    const ny = Math.cos(ref.hdg);
    const innerLat = center - sign * half;
    const outerLat = center + sign * half;
    inner.push({ x: ref.x + innerLat * nx, y: ref.y + innerLat * ny });
    outer.push({ x: ref.x + outerLat * nx, y: ref.y + outerLat * ny });
  }
  if (maxWidth < 1e-3) return [];

  const ring: Vec2[] = [...inner, ...outer.reverse()];
  ring.push(ring[0]!);
  return ring;
}

/**
 * Build a filled lane-area polygon for every drivable/markable lane in the
 * XODR (lane id 0, the reference lane, is skipped — it has no width). Geometry
 * is in the same runtime-world-meter frame as {@link sampleLanePolyline};
 * callers project the ring to WGS84. Pure: no I/O.
 */
export function buildLanePolygonsLocal(xodr: string): LanePolygonLocal[] {
  const { roads } = parseXodr(xodr);
  const out: LanePolygonLocal[] = [];
  for (const road of roads.values()) {
    road.sections.forEach((section, sIdx) => {
      for (const ln of section.lanes) {
        if (ln.id === 0) continue;
        const ring = sampleLaneRing(road, sIdx, ln.id);
        if (ring.length < 4) continue;
        out.push({
          roadId: road.id,
          section: sIdx,
          laneId: ln.id,
          laneType: ln.type || "none",
          isJunction: road.junction !== -1,
          laneGuid: ln.guid,
          ring,
        });
      }
    });
  }
  return out;
}

// ── Turn classification from connecting-road geometry ───────────────────────

function normPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

// (The road's net heading change in +s direction was the previous
// source of truth for gate turnRelation. It's been replaced by
// `laneTravelHeadingChange`, which samples the connecting lane's
// polyline directly and sign-flips for positive-id lanes — the
// driver's actual frame.)

/**
 * `classifyJunctionTurn`, widened to this module's five-way `TurnRelation`.
 *
 * The thresholds used to be spelled here as radian literals (0.349 and 2.356)
 * that were *meant* to be 20° and 135°, and were off by 0.004° and 0.015°. Two
 * copies of a boundary that a connector can land within 0.4° of is how the same
 * branch gets called a Left by the gate table and a straight-through by
 * `junctionTurnForBranch`, so there is now one copy and it lives in
 * `junction-direction.ts`.
 *
 * The extra width here is only the U-turn's SIDE, which `JunctionTurn` folds
 * away because nothing downstream of it steers differently for the two.
 */
export function turnRelationForHeadingChangeDeg(deltaDeg: number): TurnRelation {
  const turn = classifyJunctionTurn(deltaDeg);
  if (turn === "left") return "Left";
  if (turn === "right") return "Right";
  if (turn === "straight") return "Straight";
  // The side is read off the caller's own value rather than the normalized one:
  // at exactly ±180° the two disagree about the sign (a perfect reversal has no
  // handedness), and the gate tables in the field were built with this reading.
  return deltaDeg > 0 ? "UTurnLeft" : "UTurnRight";
}

export function classifyTurn(deltaRad: number): TurnRelation {
  return turnRelationForHeadingChangeDeg((normPi(deltaRad) * 180) / Math.PI);
}

/**
 * The inverse fold: drop a U-turn's side.
 *
 * `TurnRelation` distinguishes `UTurnLeft` from `UTurnRight` and `JunctionTurn`
 * does not, because nothing downstream of the latter steers differently for the
 * two. Written once here rather than as the private lookup it used to be in
 * every module that needed it.
 */
export function junctionTurnForRelation(relation: TurnRelation): JunctionTurn {
  switch (relation) {
    case "Left":
      return "left";
    case "Right":
      return "right";
    case "Straight":
      return "straight";
    default:
      return "uturn";
  }
}

/**
 * Heading change a vehicle experiences traversing a lane in its
 * **actual travel direction**, signed (+CCW).
 *
 * The lane's polyline is sampled in s-increasing order. Positive-id
 * lanes (left of the reference line; US right-hand-drive convention)
 * travel OPPOSITE to `+s` — so for them, the traversal heading change
 * is the negation of the polyline's stored heading change. Negative-
 * id lanes travel WITH `+s` (no flip). Returns 0 for degenerate
 * polylines (<4 points) where heading sampling is unstable.
 */
function laneTravelHeadingChange(lane: TopologyLane): number {
  const poly = lane.polyline;
  if (poly.length < 4) return 0;
  // Heading of the lane in the polyline's stored (+s) direction.
  // Use first/last *non-degenerate* segments to dodge ε-length first
  // or last samples from the planView discretizer.
  const a0 = poly[0]!;
  const a1 = poly[1]!;
  const b0 = poly[poly.length - 2]!;
  const b1 = poly[poly.length - 1]!;
  const startHdg = Math.atan2(a1.y - a0.y, a1.x - a0.x);
  const endHdg = Math.atan2(b1.y - b0.y, b1.x - b0.x);
  const sIncreasingDelta = normPi(endHdg - startHdg);
  // The lane-id sign convention, unavoidably — and, measured, harmlessly.
  //
  // This runs during the XODR parse, BEFORE the CARLA crawl is bound, so the
  // resolved direction on the bound index does not exist yet. That reads like a
  // bug waiting to happen: `lane-travel.ts` warns that guessing travel direction
  // "puts cars head-on into traffic", and a negated heading change turns every
  // left into a right.
  //
  // It was measured rather than assumed. Across all eight published maps the
  // crawl's resolved direction agrees with this convention on 7099 of 7099 gate
  // lanes — every one, on every map (`scripts/agent/audit-gate-turn-recompute.mjs`,
  // 2026-07-30). Recomputing after binding was implemented and then dropped: it
  // corrected nothing, and the approach-relative measure it necessarily came with
  // took `MOVEMENT_TURN_MISMATCH` from 51 to 64 — Easterbrook has 168-184 m
  // "connectors" inside one campus junction, and `BRANCH_HEADING_MAX_M`'s 80 m cap
  // reads them as straight when the turn happens past the cap.
  //
  // So: reopen this only for a map where the convention DOES fail (a left-hand-
  // drive import is the obvious candidate), and detect that case rather than
  // recomputing everywhere. The other route is the OpenDRIVE `rule` (RHT/LHT)
  // attribute, which `parseXodr` does not read and RoadRunner exports frequently
  // omit.
  //
  // For a lane traversed in s-decreasing direction both the entry/exit
  // segments are reversed AND the rotation sign flips, so the travel-direction
  // delta is `-sIncreasingDelta`.
  return laneTravelIncreasesSByConvention(lane.laneId)
    ? sIncreasingDelta
    : -sIncreasingDelta;
}

// ── Build ───────────────────────────────────────────────────────────────────

/**
 * The `generatedAt` stamp used when a caller does not supply `now`.
 *
 * A topology index is a pure function of its XODR — it is content-addressed by
 * `source.xodrSha256`, cached on section digests, and hashed wholesale into the
 * `payloadSha256` that `/api/internal/autogen/maps/{id}/topology` serves. A
 * wall-clock `generatedAt` breaks all three: the same unchanged map compiles to
 * a different byte string on every call, so the digest that is supposed to pin
 * "which map bytes did this batch draw against" changes without the map
 * changing.
 *
 * So the DEFAULT is a constant, and a real timestamp is opt-in via `now`.
 * Callers that want to record when a compile happened should record it beside
 * the index (as the semantic-graph publication store does with `publishedAt`)
 * rather than inside a digest-bound artifact.
 */
export const TOPOLOGY_CONTENT_EPOCH = "1970-01-01T00:00:00.000Z";

export interface BuildTopologyArgs {
  mapName: string;
  xodr: string;
  xodrSha256?: string | null;
  /**
   * Override the `generatedAt` stamp. Defaults to {@link TOPOLOGY_CONTENT_EPOCH}
   * so an index stays a pure function of its input; pass one only when the
   * output is NOT digest-bound.
   */
  now?: () => string;
}

const rslOf = (road: number, section: number, lane: number): string =>
  `${road}:${section}:${lane}`;

/**
 * Constrain a topology to the CARLA runtime lane-type allow-list, mutating
 * `lanes` in place. Drops every lane whose `laneType` is outside
 * {@link CARLA_RUNTIME_ALLOWED_LANE_TYPES} so the planner only ever anchors
 * to lanes CARLA actually loads.
 *
 * Lanes referenced by a gate (its approach / connecting / exit lanes) are
 * preserved REGARDLESS of type — junction-internal connecting lanes are
 * sometimes typed `none` in the XODR, and dropping them would collapse the
 * turn graph the planner walks. Dangling predecessor/successor edges (to
 * dropped lanes) are pruned; gates themselves are never dropped here.
 *
 * Expects `predecessors`/`successors` to already be flushed onto the lane
 * nodes (so it can prune them). Call before building the junction index.
 */
export function constrainTopologyToRuntimeLaneTypes(
  lanes: Record<string, TopologyLane>,
  gates: readonly TopologyGate[],
): void {
  const gateReferenced = new Set<string>();
  for (const g of gates) {
    gateReferenced.add(g.approachLaneRsl);
    gateReferenced.add(g.connectingLaneRsl);
    for (const exitRsl of g.exitLaneRsls) gateReferenced.add(exitRsl);
  }
  for (const rsl of Object.keys(lanes)) {
    const lane = lanes[rsl]!;
    const allowed = CARLA_RUNTIME_ALLOWED_LANE_TYPES.has(
      lane.laneType.toLowerCase(),
    );
    if (!allowed && !gateReferenced.has(rsl)) delete lanes[rsl];
  }
  for (const node of Object.values(lanes)) {
    node.predecessors = node.predecessors.filter((p) => lanes[p]);
    node.successors = node.successors.filter((s) => lanes[s]);
  }
}

function materializeLaneChangeAdjacency(
  lanes: Record<string, TopologyLane>,
): void {
  const laneLengthM = (lane: TopologyLane) => lane.polyline.reduce(
    (total, point, index) => {
      if (index === 0) return total;
      const previous = lane.polyline[index - 1]!;
      return total + Math.hypot(point.x - previous.x, point.y - previous.y);
    },
    0,
  );
  const byRoadSectionLane = new Map<string, TopologyLane>();
  for (const lane of Object.values(lanes)) {
    byRoadSectionLane.set(`${lane.roadId}:${lane.section}:${lane.laneId}`, lane);
  }

  for (const lane of Object.values(lanes)) {
    if (lane.isJunction || lane.laneId === 0) continue;
    for (const side of ["left", "right"] as const) {
      const adjacentLaneId = lane.laneId + (side === "left" ? 1 : -1);
      if (
        adjacentLaneId === 0 ||
        Math.sign(adjacentLaneId) !== Math.sign(lane.laneId)
      ) {
        continue;
      }
      const adjacent = byRoadSectionLane.get(
        `${lane.roadId}:${lane.section}:${adjacentLaneId}`,
      );
      if (
        !adjacent ||
        adjacent.isJunction ||
        adjacent.laneType.toLowerCase() !== lane.laneType.toLowerCase()
      ) {
        continue;
      }
      const permissionId = `${lane.rsl}:${side}:${adjacent.rsl}`;
      lane.laneChangePermissions = [
        ...(lane.laneChangePermissions ?? []),
        {
        id: permissionId,
        side,
        startS: 0,
        // Permission stations are metric arc length, not sample indices.
        endS: laneLengthM(lane),
        allowed: true,
        marking: "derived_same_section",
        source: "derived_same_section",
        },
      ];
      lane.adjacentLanes = lane.adjacentLanes ?? {};
      lane.adjacentLanes[side] = {
        side,
        laneRsl: adjacent.rsl,
        sameDirection: true,
        permissionIds: [permissionId],
      };
    }
  }
}

export function buildMapTopologyIndex(args: BuildTopologyArgs): MapTopologyIndex {
  const { roads, junctions } = parseXodr(args.xodr);

  const lanes: Record<string, TopologyLane> = {};
  const predAcc = new Map<string, Set<string>>();
  const succAcc = new Map<string, Set<string>>();
  const addEdge = (fromRsl: string, toRsl: string) => {
    (succAcc.get(fromRsl) ?? succAcc.set(fromRsl, new Set()).get(fromRsl)!).add(toRsl);
    (predAcc.get(toRsl) ?? predAcc.set(toRsl, new Set()).get(toRsl)!).add(fromRsl);
  };

  let drivingLanes = 0;
  for (const road of roads.values()) {
    road.sections.forEach((sec, sIdx) => {
      for (const ln of sec.lanes) {
        if (ln.id === 0) continue; // centre reference lane, not drivable
        const rsl = rslOf(road.id, sIdx, ln.id);
        if (ln.type === "driving") drivingLanes += 1;
        const widthSamples = laneWidthSamples(sec, ln, road.length);
        const representativeWidth = representativeLaneWidthM(sec, ln, road.length);
        lanes[rsl] = {
          rsl,
          roadId: road.id,
          section: sIdx,
          laneId: ln.id,
          laneType: ln.type || "none",
          isJunction: road.junction !== -1,
          junctionId: road.junction !== -1 ? String(road.junction) : null,
          predecessors: [],
          successors: [],
          speedLimitKph: road.speedKph,
          representativeWidthM: representativeWidth,
          widthSamples,
          adjacentLanes: {
            left: {
              side: "left",
              laneRsl: null,
              sameDirection: false,
              permissionIds: [],
            },
            right: {
              side: "right",
              laneRsl: null,
              sameDirection: false,
              permissionIds: [],
            },
          },
          laneChangePermissions: [],
          polyline: sampleLanePolyline(road, sIdx, ln.id),
        };
        // Intra-road, across laneSections.
        if (sIdx + 1 < road.sections.length) {
          for (const sId of ln.succIds) {
            addEdge(rsl, rslOf(road.id, sIdx + 1, sId));
          }
        }
        if (sIdx > 0) {
          for (const pId of ln.predIds) {
            addEdge(rslOf(road.id, sIdx - 1, pId), rsl);
          }
        }
      }
    });
  }

  const lastSec = (rid: number) =>
    Math.max(0, (roads.get(rid)?.sections.length ?? 1) - 1);
  const secByContact = (rid: number, cp: string | null) =>
    cp === "end" ? lastSec(rid) : 0;

  // Road↔road boundary links (elementType="road"). Lane-id correspondence
  // across a road boundary is identity in OpenDRIVE when no junction.
  for (const road of roads.values()) {
    // Junction connecting roads are directed by the junction's
    // <connection>/<laneLink> records below. Processing their road-level
    // predecessor/successor links here as well creates the reverse edge for
    // contactPoint="end" / positive-id lanes (for example Yale junction 115:
    // 27:0:3 -> 133:0:1 -> 109:0:4 becomes bidirectional). The junction record
    // is the authoritative movement definition, so never synthesize a second
    // set of boundary edges for its internal roads.
    if (road.junction !== -1) continue;
    const endSec = lastSec(road.id);
    const link = (l: XRoadLink | null, fromSec: number, dir: "succ" | "pred") => {
      if (!l || l.elementType !== "road") return;
      const other = Number(l.elementId);
      if (!roads.has(other)) return;
      const otherSec = secByContact(other, l.contactPoint);
      for (const ln of road.sections[fromSec]?.lanes ?? []) {
        if (ln.id === 0) continue;
        const a = rslOf(road.id, fromSec, ln.id);
        const ids = dir === "succ" ? ln.succIds : ln.predIds;
        for (const oid of ids.length ? ids : [ln.id]) {
          const b = rslOf(other, otherSec, oid);
          if (dir === "succ") addEdge(a, b);
          else addEdge(b, a);
        }
      }
    };
    link(road.successor, endSec, "succ");
    link(road.predecessor, 0, "pred");
  }

  // Junction connections = the gates. Each laneLink is a directed edge
  // approach→connecting; the connecting road's far end gives the exit.
  let connectionsParsed = 0;
  let gatesDropped = 0;
  const gates: TopologyGate[] = [];
  const turnHistogram: Record<string, number> = {};

  for (const j of junctions) {
    for (let ci = 0; ci < j.connections.length; ci++) {
      const conn = j.connections[ci]!;
      connectionsParsed += 1;
      const incoming = roads.get(conn.incomingRoad);
      const connecting = roads.get(conn.connectingRoad);
      if (!incoming || !connecting) {
        gatesDropped += conn.laneLinks.length;
        continue;
      }
      // Which end of the incoming road meets this junction.
      const incJunctionAtEnd =
        incoming.successor?.elementType === "junction" &&
        incoming.successor.elementId === String(j.id);
      const incSec = incJunctionAtEnd ? lastSec(incoming.id) : 0;
      const connSec = secByContact(connecting.id, conn.contactPoint);
      // The connecting road's OTHER end → exit road/lane(s).
      const exitLink =
        conn.contactPoint === "end"
          ? connecting.predecessor
          : connecting.successor;
      // (Per-LANE travel-direction heading change is computed inside
      // the laneLinks loop via laneTravelHeadingChange — the road's
      // own +s heading change is no longer the source of truth, since
      // it sign-flips for positive-id lanes.)

      for (const ll of conn.laneLinks) {
        const approachRsl = rslOf(incoming.id, incSec, ll.from);
        const connectingRsl = rslOf(connecting.id, connSec, ll.to);
        if (!lanes[approachRsl] || !lanes[connectingRsl]) {
          gatesDropped += 1;
          continue;
        }
        addEdge(approachRsl, connectingRsl);
        // Turn classification must be in the LANE'S TRAVEL direction,
        // not the road's reference-line `+s` direction. Positive-id
        // lanes (left of reference line, US right-hand-drive
        // convention) travel OPPOSITE to `+s`, so a road with a +97°
        // heading change in `+s` corresponds to a -97° rotation in
        // the lane's travel direction — a Right turn, not Left. We
        // sample directly from the connecting lane's polyline so the
        // classification reflects what CARLA will actually drive.
        const connectingLane = lanes[connectingRsl]!;
        const laneTravelHeadingRad = laneTravelHeadingChange(connectingLane);
        const turnRelation = classifyTurn(laneTravelHeadingRad);

        const exitRsls: string[] = [];
        if (exitLink && exitLink.elementType === "road") {
          const exitRoad = Number(exitLink.elementId);
          const exitSec = secByContact(exitRoad, exitLink.contactPoint);
          const connLane = connecting.sections[connSec]?.lanes.find(
            (x) => x.id === ll.to,
          );
          const exitIds = (exitLink === connecting.successor
            ? connLane?.succIds
            : connLane?.predIds) ?? [];
          for (const eid of exitIds.length ? exitIds : [ll.to]) {
            const exitRsl = rslOf(exitRoad, exitSec, eid);
            if (lanes[exitRsl]) {
              exitRsls.push(exitRsl);
              addEdge(connectingRsl, exitRsl);
            }
          }
        }

        const id = `${j.id}:${ci}:${ll.from}-${ll.to}`;
        gates.push({
          id,
          junctionId: String(j.id),
          turnRelation,
          // headingChangeRad reports the lane's actual travel-direction
          // rotation, signed +CCW. Consumers (validator, planner) use
          // this as ground truth for "what turn does ego execute".
          headingChangeRad: laneTravelHeadingRad,
          connectingLaneRsl: connectingRsl,
          approachLaneRsl: approachRsl,
          exitLaneRsls: exitRsls,
        });
        turnHistogram[turnRelation] = (turnHistogram[turnRelation] ?? 0) + 1;
      }
    }
  }

  // Flush accumulated edges onto the lane nodes.
  for (const [rsl, node] of Object.entries(lanes)) {
    node.predecessors = [...(predAcc.get(rsl) ?? [])];
    node.successors = [...(succAcc.get(rsl) ?? [])];
  }
  materializeLaneChangeAdjacency(lanes);

  // Constrain to the lane types CARLA's runtime crawl surfaces, so the
  // planner anchors only to lanes that exist in the runtime bundle. Done
  // after the edge flush (it prunes dangling edges) and before the junction
  // index (built from the surviving lanes/gates).
  constrainTopologyToRuntimeLaneTypes(lanes, gates);
  drivingLanes = Object.values(lanes).filter(
    (l) => l.laneType.toLowerCase() === "driving",
  ).length;

  const junctionsOut: Record<string, TopologyJunction> = {};
  for (const j of junctions) {
    const jid = String(j.id);
    const jGates = gates.filter((g) => g.junctionId === jid);
    const internal = Object.values(lanes)
      .filter((l) => l.junctionId === jid)
      .map((l) => l.rsl);
    junctionsOut[jid] = {
      junctionId: jid,
      gateIds: jGates.map((g) => g.id),
      internalLaneRsls: internal,
      approachLaneRsls: [...new Set(jGates.map((g) => g.approachLaneRsl))],
    };
  }

  return {
    schemaVersion: MAP_TOPOLOGY_SCHEMA_VERSION,
    mapName: args.mapName,
    generatedAt: (args.now ?? (() => TOPOLOGY_CONTENT_EPOCH))(),
    source: {
      xodrSha256: args.xodrSha256 ?? null,
      generationTool: "buildMapTopologyIndex",
      generationToolVersion: "timed-instructions-v1",
      runtimeCatalogVersion: null,
    },
    lanes,
    gates,
    junctions: junctionsOut,
    stats: {
      roads: roads.size,
      lanes: Object.keys(lanes).length,
      drivingLanes,
      junctions: junctions.length,
      gates: gates.length,
      connectionsParsed,
      gatesDropped,
      turnHistogram,
      geojsonTurnAgreementPct: null,
    },
  };
}
