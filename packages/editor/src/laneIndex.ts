/**
 * Lane geometry, indexed for interactive snapping.
 *
 * ## Why not raycast
 *
 * The lane *surfaces* are already in the scene as an overlay mesh, so a picking
 * ray would find them — but a ray gives a triangle, and what placement needs is
 * a **centreline**: a point, a tangent, an arc length and a signed lateral
 * offset. `topology-index.json.gz` ships exactly that (`lanes[rsl].polyline`,
 * 25,909 vertices over Yale Street's 622 driving lanes), so this index reads the
 * centrelines directly and never touches the scene graph.
 *
 * ## Frames
 *
 * The index stores **scene** coordinates. The topology file is OpenDRIVE-local
 * (x-east, y-north, z-up); the scene is y-up with `scene = (x, height, -y)`, the
 * same transform `CoordinateFrame.localToScene` applies. Doing it once at build
 * time keeps every query in the frame the renderer and `scenario-model` already
 * use.
 *
 * Headings are radians CCW about +Y from +X — `Object3D.rotation.y`, and
 * numerically the OpenDRIVE heading (see `scenario-model/schema/v1.ts`). From a
 * scene delta that is `atan2(-dz, dx)`.
 *
 * ## Direction of travel
 *
 * OpenDRIVE's rule is that a lane with a negative id runs along `+s` and a
 * positive id runs against it. Polylines are stored in `s` order, so a positive
 * lane's *travel* heading is the reverse of its stored tangent. That rule is not
 * assumed here — it was checked against the index's own `adjacentLanes[side]
 * .sameDirection` flags on Yale Street: **138 of 138 neighbouring driving-lane
 * pairs agree**. `s` therefore stays in storage order (so it keeps its
 * OpenDRIVE meaning within the section) and {@link IndexedLane.forward} carries
 * the direction; use {@link advanceAlongTravel} to move an actor "forwards".
 *
 * `s` is measured from the **start of the lane's section**, not the start of the
 * road: the topology index gives no per-section `s` offset (its own
 * `widthSamples` also start at 0 for every section). For single-section roads —
 * the common case in these maps — the two are identical.
 *
 * ## Cost
 *
 * Build is a single pass plus a uniform-grid bin, ~15 ms for Yale Street.
 * `nearest()` is a ring search over 8 m cells: ~3 segments per occupied cell, so
 * a query is a few dozen point-segment projections and stays well inside a
 * frame budget even when it runs on every `pointermove`.
 */

import {
  buildLaneGraph,
  decodeTopologyIndex,
  type LaneGraph,
  type TopologyIndex,
} from '@simforge/engine';

/** `road:section:lane`, the topology index's lane key. */
export type LaneRsl = string;

/** Lane types the index will snap to. */
export type LaneType = 'driving' | 'biking' | 'parking' | 'sidewalk' | 'shoulder' | string;

/** One lane's centreline, in scene metres. */
export interface IndexedLane {
  readonly rsl: LaneRsl;
  readonly roadId: string;
  readonly section: number;
  readonly laneId: number;
  readonly laneType: LaneType;
  readonly isJunction: boolean;
  /** Lane width in metres, for clamping the lateral offset. */
  readonly widthM: number;
  readonly speedLimitKph: number | null;
  /** `true` when travel runs along increasing `s` (negative OpenDRIVE lane id). */
  readonly forward: boolean;
  /** Scene X per vertex, in storage (`s`) order. */
  readonly xs: Float64Array;
  /** Scene Z per vertex, in storage (`s`) order. */
  readonly zs: Float64Array;
  /** Arc length at each vertex; `cum[0] === 0`. */
  readonly cum: Float64Array;
  /** Total centreline length in metres. */
  readonly length: number;
}

/** Where a query landed on the network. */
export interface LaneHit {
  readonly lane: IndexedLane;
  /** Arc length along the stored polyline, metres. */
  readonly s: number;
  /** Signed lateral offset from the centreline, metres, positive to the left of travel. */
  readonly t: number;
  /** Distance from the query point to the centreline, metres. */
  readonly distance: number;
  readonly x: number;
  readonly z: number;
  /** Travel heading at `s`, radians CCW about +Y from +X. */
  readonly headingRad: number;
}

/** A point on a lane. */
export interface LanePose {
  readonly x: number;
  readonly z: number;
  /** Travel heading, radians. */
  readonly headingRad: number;
}

/** Raw shape of `topology-index.json`, narrowed to what this module reads. */
interface TopologyFile {
  mapName?: string;
  source?: { xodrSha256?: string };
  lanes: Record<
    string,
    {
      roadId: number | string;
      section: number;
      laneId: number;
      laneType: string;
      isJunction?: boolean;
      junctionId?: string | null;
      predecessors?: string[];
      successors?: string[];
      speedLimitKph?: number | null;
      representativeWidthM?: number | null;
      widthSamples?: Array<{ s: number; widthM: number }>;
      adjacentLanes?: TopologyIndex['lanes'][string]['adjacentLanes'];
      laneChangePermissions?: TopologyIndex['lanes'][string]['laneChangePermissions'];
      polyline?: Array<{ x: number; y: number }> | number[][];
    }
  >;
  gates?: TopologyIndex['gates'];
  junctions?: TopologyIndex['junctions'];
}

export interface LaneIndexStats {
  mapName: string;
  xodrSha256: string | null;
  /** Lanes in the file. */
  totalLanes: number;
  /** Lanes actually indexed (after the type filter). */
  lanes: number;
  segments: number;
  cellSize: number;
  cells: number;
  occupiedCells: number;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  buildMs: number;
  fetchMs: number;
  bytes: number;
}

export interface LaneIndexOptions {
  /** Lane types to index. Default `['driving']` — what a vehicle may be placed on. */
  laneTypes?: readonly LaneType[];
  /** Grid cell size in metres. Default `8`. */
  cellSize?: number;
  signal?: AbortSignal;
}

const DEFAULT_LANE_TYPES: readonly LaneType[] = ['driving'];
const DEFAULT_CELL = 8;
/** A true oncoming lane is comfortably beyond perpendicular; cross streets are not. */
const OPPOSING_MIN_DEG = 120;
/** Below this a "lane" is a stub the snapper should not fight the user over. */
const MIN_LANE_LENGTH_M = 1;
/** Overlapping OpenDRIVE centrelines inside junctions are effectively the same pointer target. */
const PLACEMENT_PREFERENCE_TOLERANCE_M = 0.75;

function now(): number {
  return performance.now();
}

/** Fold a heading into `(-π, π]`, matching `scenario-model`'s normalisation. */
export function normalizeHeading(rad: number): number {
  const tau = Math.PI * 2;
  let out = rad % tau;
  if (out > Math.PI) out -= tau;
  if (out <= -Math.PI) out += tau;
  return out;
}

/** Smallest signed rotation from `a` to `b`, radians. */
export function headingDelta(a: number, b: number): number {
  return normalizeHeading(b - a);
}

/**
 * Move `s` by `distance` metres **along the lane's direction of travel**.
 *
 * Positive is forwards. Handles the sign flip for positive-id lanes and clamps
 * to the lane's extent, so callers never have to think about storage order.
 */
export function advanceAlongTravel(lane: IndexedLane, s: number, distance: number): number {
  const next = lane.forward ? s + distance : s - distance;
  return Math.min(lane.length, Math.max(0, next));
}

/** Read a polyline vertex from either `{x, y}` or `[x, y]` form. */
function vertexOf(p: { x: number; y: number } | number[]): { x: number; y: number } | null {
  if (Array.isArray(p)) {
    const x = p[0];
    const y = p[1];
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
  }
  return typeof p?.x === 'number' && typeof p?.y === 'number' ? { x: p.x, y: p.y } : null;
}

/**
 * Lane centrelines with a uniform-grid nearest-segment query.
 *
 * Build once per map (see {@link LaneIndex.load}); it holds plain typed arrays,
 * no GPU resources and no scene-graph references.
 */
export class LaneIndex {
  readonly stats: LaneIndexStats;
  /** Directed connectivity over the same decoded topology payload. */
  readonly graph: LaneGraph;

  private readonly lanes: IndexedLane[];
  private readonly byRsl = new Map<LaneRsl, IndexedLane>();
  /** Per segment: lane index and first-vertex index, parallel arrays. */
  private readonly segLane: Int32Array;
  private readonly segVertex: Int32Array;
  /** CSR grid: `starts[cell]..starts[cell+1]` indexes into `items`. */
  private readonly starts: Int32Array;
  private readonly items: Int32Array;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly cellSize: number;
  private readonly nx: number;
  private readonly nz: number;

  private constructor(parts: {
    lanes: IndexedLane[];
    segLane: Int32Array;
    segVertex: Int32Array;
    starts: Int32Array;
    items: Int32Array;
    minX: number;
    minZ: number;
    cellSize: number;
    nx: number;
    nz: number;
    stats: LaneIndexStats;
    graph: LaneGraph;
  }) {
    this.lanes = parts.lanes;
    this.segLane = parts.segLane;
    this.segVertex = parts.segVertex;
    this.starts = parts.starts;
    this.items = parts.items;
    this.minX = parts.minX;
    this.minZ = parts.minZ;
    this.cellSize = parts.cellSize;
    this.nx = parts.nx;
    this.nz = parts.nz;
    this.stats = parts.stats;
    this.graph = parts.graph;
    for (const lane of this.lanes) this.byRsl.set(lane.rsl, lane);
  }

  /** Fetch and decode `topology-index.json.gz`, then {@link build}. */
  static async load(url: string, options: LaneIndexOptions = {}): Promise<LaneIndex> {
    const t0 = now();
    const res = await fetch(url, options.signal ? { signal: options.signal } : {});
    if (!res.ok) throw new Error(`topology index ${res.status} ${url}`);
    const raw = await res.arrayBuffer();
    // The simulation package owns artifact decoding and validates the topology
    // envelope before authoring indexes it.
    const json = await decodeTopologyIndex(raw) as TopologyFile;
    const fetchMs = now() - t0;
    return LaneIndex.build(json, { ...options, fetchMs, bytes: raw.byteLength });
  }

  /** Index an already-parsed topology file. */
  static build(
    file: TopologyFile,
    options: LaneIndexOptions & { fetchMs?: number; bytes?: number } = {},
  ): LaneIndex {
    const t0 = now();
    const laneTypes = new Set(options.laneTypes ?? DEFAULT_LANE_TYPES);
    const cellSize = options.cellSize ?? DEFAULT_CELL;

    const lanes: IndexedLane[] = [];
    let segments = 0;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    const keys = Object.keys(file.lanes ?? {}).sort();
    for (const rsl of keys) {
      const record = file.lanes[rsl];
      if (!record || !laneTypes.has(record.laneType)) continue;
      const raw = record.polyline ?? [];
      const xs: number[] = [];
      const zs: number[] = [];
      for (const p of raw) {
        const v = vertexOf(p);
        if (!v) continue;
        // local (x east, y north, z up) -> scene (x, up, -y)
        const x = v.x;
        const z = -v.y;
        const lastX = xs[xs.length - 1];
        const lastZ = zs[zs.length - 1];
        // Duplicate vertices make headings NaN.
        if (lastX !== undefined && Math.abs(lastX - x) < 1e-9 && Math.abs((lastZ as number) - z) < 1e-9) {
          continue;
        }
        xs.push(x);
        zs.push(z);
      }
      if (xs.length < 2) continue;

      const cum = new Float64Array(xs.length);
      for (let i = 1; i < xs.length; i++) {
        const dx = (xs[i] as number) - (xs[i - 1] as number);
        const dz = (zs[i] as number) - (zs[i - 1] as number);
        cum[i] = (cum[i - 1] as number) + Math.hypot(dx, dz);
      }
      const length = cum[cum.length - 1] as number;
      if (length < MIN_LANE_LENGTH_M) continue;

      for (let i = 0; i < xs.length; i++) {
        const x = xs[i] as number;
        const z = zs[i] as number;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }

      const width = record.representativeWidthM;
      lanes.push({
        rsl,
        roadId: String(record.roadId),
        section: record.section,
        laneId: record.laneId,
        laneType: record.laneType,
        isJunction: record.isJunction === true,
        widthM: width && width > 0 ? width : 3.5,
        speedLimitKph: record.speedLimitKph ?? null,
        forward: record.laneId < 0,
        xs: Float64Array.from(xs),
        zs: Float64Array.from(zs),
        cum,
        length,
      });
      segments += xs.length - 1;
    }

    if (lanes.length === 0) {
      throw new Error('lane index: the topology file has no lanes of the requested type');
    }

    // --- flatten segments, then bin them ---------------------------------
    const segLane = new Int32Array(segments);
    const segVertex = new Int32Array(segments);
    let w = 0;
    for (let li = 0; li < lanes.length; li++) {
      const lane = lanes[li] as IndexedLane;
      for (let i = 0; i < lane.xs.length - 1; i++) {
        segLane[w] = li;
        segVertex[w] = i;
        w++;
      }
    }

    const pad = 1;
    const gx = minX - pad;
    const gz = minZ - pad;
    const nx = Math.max(1, Math.ceil((maxX + pad - gx) / cellSize));
    const nz = Math.max(1, Math.ceil((maxZ + pad - gz) / cellSize));
    const cells = nx * nz;

    const forEachCell = (seg: number, visit: (cell: number) => void): void => {
      const lane = lanes[segLane[seg] as number] as IndexedLane;
      const i = segVertex[seg] as number;
      const ax = lane.xs[i] as number;
      const az = lane.zs[i] as number;
      const bx = lane.xs[i + 1] as number;
      const bz = lane.zs[i + 1] as number;
      let i0 = Math.floor((Math.min(ax, bx) - gx) / cellSize);
      let i1 = Math.floor((Math.max(ax, bx) - gx) / cellSize);
      let j0 = Math.floor((Math.min(az, bz) - gz) / cellSize);
      let j1 = Math.floor((Math.max(az, bz) - gz) / cellSize);
      if (i0 < 0) i0 = 0;
      if (j0 < 0) j0 = 0;
      if (i1 >= nx) i1 = nx - 1;
      if (j1 >= nz) j1 = nz - 1;
      for (let j = j0; j <= j1; j++) {
        const row = j * nx;
        for (let i2 = i0; i2 <= i1; i2++) visit(row + i2);
      }
    };

    const counts = new Int32Array(cells);
    for (let s = 0; s < segments; s++) {
      forEachCell(s, (c) => {
        counts[c] = (counts[c] as number) + 1;
      });
    }
    const starts = new Int32Array(cells + 1);
    let acc = 0;
    let occupied = 0;
    for (let c = 0; c < cells; c++) {
      starts[c] = acc;
      const n = counts[c] as number;
      if (n > 0) occupied++;
      acc += n;
    }
    starts[cells] = acc;
    const items = new Int32Array(acc);
    const cursor = starts.slice(0, cells);
    for (let s = 0; s < segments; s++) {
      forEachCell(s, (c) => {
        items[cursor[c] as number] = s;
        cursor[c] = (cursor[c] as number) + 1;
      });
    }

    const bytes =
      options.bytes ??
      lanes.reduce((sum, l) => sum + l.xs.byteLength + l.zs.byteLength + l.cum.byteLength, 0);

    const graph = buildLaneGraph({
      mapName: file.mapName,
      source: file.source,
      lanes: Object.fromEntries(Object.entries(file.lanes).map(([rsl, lane]) => [rsl, {
        rsl,
        roadId: Number(lane.roadId),
        section: lane.section,
        laneId: lane.laneId,
        laneType: lane.laneType,
        isJunction: lane.isJunction === true,
        junctionId: lane.junctionId ?? null,
        predecessors: lane.predecessors ?? [],
        successors: lane.successors ?? [],
        speedLimitKph: lane.speedLimitKph ?? null,
        ...(lane.representativeWidthM && lane.representativeWidthM > 0
          ? { representativeWidthM: lane.representativeWidthM }
          : {}),
        ...(lane.widthSamples ? { widthSamples: lane.widthSamples } : {}),
        ...(lane.adjacentLanes ? { adjacentLanes: lane.adjacentLanes } : {}),
        ...(lane.laneChangePermissions ? { laneChangePermissions: lane.laneChangePermissions } : {}),
        polyline: (lane.polyline ?? []).flatMap((point) => {
          const value = vertexOf(point);
          return value ? [value] : [];
        }),
      }])),
      gates: file.gates ?? [],
      junctions: file.junctions ?? {},
    });

    return new LaneIndex({
      lanes,
      segLane,
      segVertex,
      starts,
      items,
      minX: gx,
      minZ: gz,
      cellSize,
      nx,
      nz,
      stats: {
        mapName: file.mapName ?? 'unknown',
        xodrSha256: file.source?.xodrSha256 ?? null,
        totalLanes: keys.length,
        lanes: lanes.length,
        segments,
        cellSize,
        cells,
        occupiedCells: occupied,
        bounds: { minX, minZ, maxX, maxZ },
        buildMs: now() - t0,
        fetchMs: options.fetchMs ?? 0,
        bytes,
      },
      graph,
    });
  }

  /** Every indexed lane. */
  get all(): readonly IndexedLane[] {
    return this.lanes;
  }

  lane(rsl: LaneRsl): IndexedLane | undefined {
    return this.byRsl.get(rsl);
  }

  /** Look a lane up the way `scenario-model` stores it. */
  laneFor(roadId: string, section: number, laneId: number): IndexedLane | undefined {
    return this.byRsl.get(`${roadId}:${section}:${laneId}`);
  }

  /**
   * Nearest centreline point to a scene XZ.
   *
   * @param maxRadius Give up beyond this many metres. Default `30` — about the
   *   width of a four-lane road plus its verge, i.e. far enough to catch the
   *   lane the user meant and near enough that pointing at a rooftop snaps to
   *   nothing.
   */
  nearest(x: number, z: number, maxRadius = 30): LaneHit | null {
    return this.search(x, z, maxRadius, null);
  }

  /**
   * Nearest lane for a newly placed motor vehicle.
   *
   * OpenDRIVE commonly overlays an approach/through lane with one or more
   * junction connector lanes. Within a sub-metre ambiguity band, prefer the
   * lane whose topology preserves straight travel. A visibly closer curved
   * connector still wins, so intentional turn placement remains possible.
   */
  nearestForVehiclePlacement(x: number, z: number, maxRadius = 30): LaneHit | null {
    return this.search(
      x,
      z,
      maxRadius,
      null,
      (hit) => this.vehiclePlacementRank(hit.lane),
      PLACEMENT_PREFERENCE_TOLERANCE_M,
    );
  }

  /**
   * Nearest centreline that genuinely *oncomes* relative to `headingRad`.
   *
   * This is what Tab does during placement: on a two-way street the opposing
   * lane is 3-4 m away and is otherwise unreachable, because the nearest lane to
   * the cursor is by definition the one under it.
   *
   * "Opposing" means at least {@link OPPOSING_MIN_DEG} away, not merely "more
   * than 90°". At an intersection the nearest lane pointing the other side of
   * perpendicular is usually the *cross street* — measured at 91.4° on Yale
   * Street — so the loose test made Tab drop the car onto a road it was not
   * being placed on. A carriageway that curves away from its opposite number
   * still clears 120° comfortably.
   */
  nearestOpposing(x: number, z: number, headingRad: number, maxRadius = 30): LaneHit | null {
    const limit = Math.cos((OPPOSING_MIN_DEG * Math.PI) / 180);
    return this.search(x, z, maxRadius, (hit) => Math.cos(hit.headingRad - headingRad) < limit);
  }

  /** Opposing-lane variant with the same through-lane preference as placement. */
  nearestOpposingForVehiclePlacement(
    x: number,
    z: number,
    headingRad: number,
    maxRadius = 30,
  ): LaneHit | null {
    const limit = Math.cos((OPPOSING_MIN_DEG * Math.PI) / 180);
    return this.search(
      x,
      z,
      maxRadius,
      (hit) => Math.cos(hit.headingRad - headingRad) < limit,
      (hit) => this.vehiclePlacementRank(hit.lane),
      PLACEMENT_PREFERENCE_TOLERANCE_M,
    );
  }

  /** Point and travel heading at arc length `s` (clamped to the lane). */
  poseAt(lane: IndexedLane, s: number, t = 0): LanePose {
    const clamped = Math.min(lane.length, Math.max(0, s));
    const i = this.segmentAt(lane, clamped);
    const ax = lane.xs[i] as number;
    const az = lane.zs[i] as number;
    const bx = lane.xs[i + 1] as number;
    const bz = lane.zs[i + 1] as number;
    const segStart = lane.cum[i] as number;
    const segLen = (lane.cum[i + 1] as number) - segStart;
    const f = segLen > 0 ? (clamped - segStart) / segLen : 0;
    const px = ax + (bx - ax) * f;
    const pz = az + (bz - az) * f;
    const stored = Math.atan2(-(bz - az), bx - ax);
    const headingRad = normalizeHeading(lane.forward ? stored : stored + Math.PI);
    // Left of travel in the scene plane: rotate the travel direction +90° about
    // +Y, i.e. (cos h, -sin h) -> (-sin h, -cos h).
    const lx = -Math.sin(headingRad);
    const lz = -Math.cos(headingRad);
    return { x: px + lx * t, z: pz + lz * t, headingRad };
  }

  /** Widest lateral offset that keeps a body of `bodyWidth` inside the lane. */
  lateralLimit(lane: IndexedLane, bodyWidth = 0): number {
    return Math.max(0, lane.widthM / 2 - bodyWidth / 2);
  }

  /**
   * Project a point onto one specific lane — the operation a lane-anchored drag
   * needs (slide along *this* lane, do not jump to a neighbour).
   */
  project(lane: IndexedLane, x: number, z: number): LaneHit {
    let bestDist = Infinity;
    let bestS = 0;
    for (let i = 0; i < lane.xs.length - 1; i++) {
      const ax = lane.xs[i] as number;
      const az = lane.zs[i] as number;
      const dx = (lane.xs[i + 1] as number) - ax;
      const dz = (lane.zs[i + 1] as number) - az;
      const len2 = dx * dx + dz * dz;
      let f = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      if (f < 0) f = 0;
      else if (f > 1) f = 1;
      const qx = ax + f * dx;
      const qz = az + f * dz;
      const d = (qx - x) ** 2 + (qz - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestS = (lane.cum[i] as number) + f * Math.sqrt(len2);
      }
    }
    return this.hitFrom(lane, bestS, x, z, Math.sqrt(bestDist));
  }

  // ------------------------------------------------------------- internals

  private search(
    x: number,
    z: number,
    maxRadius: number,
    accept: ((hit: LaneHit) => boolean) | null,
    preference: ((hit: LaneHit) => number) | null = null,
    preferenceToleranceM = 0,
  ): LaneHit | null {
    const ci = Math.floor((x - this.minX) / this.cellSize);
    const cj = Math.floor((z - this.minZ) / this.cellSize);
    const rings = Math.max(1, Math.ceil(maxRadius / this.cellSize));
    let bestDist = maxRadius * maxRadius;
    let best: LaneHit | null = null;
    const preferredHits = new Map<number, LaneHit>();

    for (let r = 0; r <= rings; r++) {
      // A cell in ring r cannot hold anything closer than (r-1) cells.
      if (
        best &&
        (r - 1) * this.cellSize > Math.sqrt(bestDist) + preferenceToleranceM
      ) break;
      for (let j = cj - r; j <= cj + r; j++) {
        if (j < 0 || j >= this.nz) continue;
        const onJEdge = Math.abs(j - cj) === r;
        for (let i = ci - r; i <= ci + r; i++) {
          if (!onJEdge && Math.abs(i - ci) !== r) continue;
          if (i < 0 || i >= this.nx) continue;
          const cell = j * this.nx + i;
          const end = this.starts[cell + 1] as number;
          for (let k = this.starts[cell] as number; k < end; k++) {
            const seg = this.items[k] as number;
            const lane = this.lanes[this.segLane[seg] as number] as IndexedLane;
            const vi = this.segVertex[seg] as number;
            const ax = lane.xs[vi] as number;
            const az = lane.zs[vi] as number;
            const dx = (lane.xs[vi + 1] as number) - ax;
            const dz = (lane.zs[vi + 1] as number) - az;
            const len2 = dx * dx + dz * dz;
            let f = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
            if (f < 0) f = 0;
            else if (f > 1) f = 1;
            const qx = ax + f * dx;
            const qz = az + f * dz;
            const d = (qx - x) ** 2 + (qz - z) ** 2;
            const preferenceLimit = Math.sqrt(bestDist) + preferenceToleranceM;
            if (d >= preferenceLimit * preferenceLimit) continue;
            const s = (lane.cum[vi] as number) + f * Math.sqrt(len2);
            const hit = this.hitFrom(lane, s, x, z, Math.sqrt(d));
            if (accept && !accept(hit)) continue;
            if (d < bestDist) {
              bestDist = d;
              best = hit;
            }
            if (preference) {
              const rank = preference(hit);
              const ranked = preferredHits.get(rank);
              if (!ranked || hit.distance < ranked.distance) preferredHits.set(rank, hit);
            }
          }
        }
      }
    }
    if (preference && best) {
      return [...preferredHits.entries()]
        .filter(([, hit]) => hit.distance <= best.distance + preferenceToleranceM)
        .sort(([rankA, hitA], [rankB, hitB]) =>
          rankA - rankB || hitA.distance - hitB.distance || hitA.lane.rsl.localeCompare(hitB.lane.rsl)
        )[0]?.[1] ?? best;
    }
    return best;
  }

  private vehiclePlacementRank(lane: IndexedLane): number {
    const connectorRelation = this.graph.turnRelationOf(lane.rsl);
    if (connectorRelation === 'Straight') return 0;
    if (connectorRelation !== null) return 3;
    const movements = this.graph.gatesFrom(lane.rsl);
    if (movements.some((gate) => gate.turnRelation === 'Straight')) return 0;
    if (movements.length > 0) return 2;
    return lane.isJunction ? 2 : 1;
  }

  /**
   * Build a hit from an arc length.
   *
   * The segment is re-derived with {@link segmentAt} rather than taken from the
   * caller, and that is load-bearing. A point off the outside of a turn projects
   * onto the shared *vertex* of two segments: `f` clamps to 1 on the first and 0
   * on the second, both at the same distance, so which one a scan happens to
   * visit first is arbitrary — but `s` is identical either way. If the heading
   * came from the caller's segment, a placement could be stored with the
   * incoming segment's heading while its own anchor (`poseAt(s)`, which uses
   * `segmentAt`) resolves to the outgoing one. On Yale Street that is a 3.3°
   * lie: the car is drawn straight but its `laneRef` says it is turning, and the
   * next operation to re-derive the pose (an inspector edit, a duplicate, a
   * reload of a v2 file) would snap it. Deriving both from `s` makes the anchor
   * and the pose the same statement by construction.
   */
  private hitFrom(lane: IndexedLane, s: number, x: number, z: number, distance: number): LaneHit {
    const segment = this.segmentAt(lane, Math.min(lane.length, Math.max(0, s)));
    const ax = lane.xs[segment] as number;
    const az = lane.zs[segment] as number;
    const bx = lane.xs[segment + 1] as number;
    const bz = lane.zs[segment + 1] as number;
    const stored = Math.atan2(-(bz - az), bx - ax);
    const headingRad = normalizeHeading(lane.forward ? stored : stored + Math.PI);
    const segStart = lane.cum[segment] as number;
    const segLen = (lane.cum[segment + 1] as number) - segStart;
    const f = segLen > 0 ? (s - segStart) / segLen : 0;
    const px = ax + (bx - ax) * f;
    const pz = az + (bz - az) * f;
    // Signed lateral: positive to the left of travel.
    const lx = -Math.sin(headingRad);
    const lz = -Math.cos(headingRad);
    const t = (x - px) * lx + (z - pz) * lz;
    return { lane, s, t, distance, x: px, z: pz, headingRad };
  }

  private segmentAt(lane: IndexedLane, s: number): number {
    // Binary search over the cumulative table.
    let lo = 0;
    let hi = lane.cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if ((lane.cum[mid] as number) <= s) lo = mid;
      else hi = mid;
    }
    return Math.min(lo, lane.xs.length - 2);
  }
}
