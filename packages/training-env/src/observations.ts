/**
 * Observation builders, version 1.
 *
 * Each channel sits behind its own class so Phase 7 can add pixel
 * observations without touching `EnvSession`. All builders are pure functions
 * of the session snapshot plus the static input — no wall clock, no
 * randomness, no iteration-order dependence (actor lists are re-sorted by id
 * before use).
 */

import {
  buildOccluders,
  hasLineOfSight,
  obbCorners,
  type LaneGraph,
  type OccluderShape,
  type SessionActorSnapshot,
  type SimScenarioInput,
  type Vec2,
} from '@simforge-oss/engine';

import type { BevConfig, BevRaster, ObservationConfig, PerceivedObject } from './types.js';

/** Static facts the builders need every decision; computed once per episode. */
export interface ObservationContextInput {
  readonly input: SimScenarioInput;
  readonly graph: LaneGraph;
  readonly egoId: string;
  readonly config: ObservationConfig;
}

/** One decision's read-only world view handed to the builders. */
export interface ObservationFrame {
  readonly tS: number;
  readonly actors: readonly SessionActorSnapshot[];
  /** Seconds since the previous decision (the decision interval). */
  readonly dtS: number;
}

const NEAREST_RANGE_SENTINEL_M = 1e6;

function wrapPi(angle: number): number {
  let a = angle;
  while (a >= Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/* --------------------------------------------------------- state vector */

/**
 * Ego state vector, fixed layout (documented contract, do not reorder):
 *
 * | idx | meaning                                   | unit   |
 * |----:|-------------------------------------------|--------|
 * | 0   | x (xodr-local, east)                      | m      |
 * | 1   | y (xodr-local, north)                     | m      |
 * | 2   | cos(heading)                              | -      |
 * | 3   | sin(heading)                              | -      |
 * | 4   | speed                                     | m/s    |
 * | 5   | longitudinal acceleration                 | m/s²   |
 * | 6   | lane-relative lateral offset (+left)      | m      |
 * | 7   | lateral rate                              | m/s    |
 * | 8   | route arc length                          | m      |
 * | 9   | range to nearest other present actor      | m      |
 */
export const STATE_VECTOR_SIZE = 10;

export class StateVectorBuilder {
  build(frame: ObservationFrame, ctx: ObservationContextInput): Float64Array {
    const sorted = [...frame.actors].sort((a, b) => (a.id < b.id ? -1 : 1));
    const ego = sorted.find((a) => a.id === ctx.egoId);
    if (!ego) throw new Error(`ego actor ${ctx.egoId} missing from snapshot`);
    let nearest = NEAREST_RANGE_SENTINEL_M;
    for (const a of sorted) {
      if (a.id === ctx.egoId) continue;
      nearest = Math.min(nearest, Math.hypot(a.x - ego.x, a.y - ego.y));
    }
    const v = new Float64Array(STATE_VECTOR_SIZE);
    v[0] = ego.x;
    v[1] = ego.y;
    v[2] = Math.cos(ego.headingRad);
    v[3] = Math.sin(ego.headingRad);
    v[4] = ego.speedMps;
    v[5] = ego.accelMps2;
    v[6] = ego.lateralOffsetM;
    v[7] = ego.lateralRateMps;
    v[8] = ego.s;
    v[9] = nearest;
    return v;
  }
}

/* --------------------------------------------------------- object list */

/**
 * Perception-gated object list.
 *
 * Gating uses the engine's occluder layer: static occluders from the input
 * plus every other present actor's body OBB, with observer/target endpoints
 * excluded exactly like the engine does. When the ego declares sensors, each
 * object must fall inside some sensor's aperture (FOV + far range); otherwise
 * a single 360° range gate applies.
 */
export class ObjectListBuilder {
  private readonly staticOccluders: readonly OccluderShape[];
  private readonly sensorApertures: readonly { horizontalFovDeg: number; farM: number }[];
  private readonly prevRange = new Map<string, number>();
  private lastLosPairs: readonly { observerId: string; targetId: string; visible: boolean }[] = [];
  constructor(ctx: ObservationContextInput) {
    this.staticOccluders = buildOccluders(ctx.input.occluders);
    const ego = ctx.input.actors.find((a) => a.id === ctx.egoId);
    this.sensorApertures = (ego?.sensors ?? [])
      .filter((s) => s.enabled)
      .map((s) => ({ horizontalFovDeg: s.aperture.horizontalFovDeg, farM: s.aperture.farM }));
  }

  /** Drop per-episode range-rate memory on reset. */
  reset(): void {
    this.prevRange.clear();
  }

  /** LOS pairs evaluated by the most recent {@link build} call, for the causal channel. */
  lastLos(): readonly { observerId: string; targetId: string; visible: boolean }[] {
    return this.lastLosPairs;
  }

  build(frame: ObservationFrame, ctx: ObservationContextInput): PerceivedObject[] {
    const sorted = [...frame.actors].sort((a, b) => (a.id < b.id ? -1 : 1));
    const ego = sorted.find((a) => a.id === ctx.egoId);
    if (!ego) throw new Error(`ego actor ${ctx.egoId} missing from snapshot`);
    const occluders: OccluderShape[] = [...this.staticOccluders];
    for (const a of sorted) {
      if (a.id === ctx.egoId) continue;
      const dims = ctx.input.actors.find((spec) => spec.id === a.id)?.dims;
      if (!dims) continue;
      const obb = { center: { x: a.x, y: a.y } as Vec2, lengthM: dims.l, widthM: dims.w, headingRad: a.headingRad };
      occluders.push({ id: a.id, obb, heightM: dims.h, corners: obbCorners(obb) });
    }

    const objects: PerceivedObject[] = [];
    for (const a of sorted) {
      if (a.id === ctx.egoId) continue;
      const dx = a.x - ego.x;
      const dy = a.y - ego.y;
      const range = Math.hypot(dx, dy);
      if (range > ctx.config.objectListRangeM) continue;
      const local = occluders.filter((o) => o.id !== a.id);
      const los = hasLineOfSight({ x: ego.x, y: ego.y }, { x: a.x, y: a.y }, local);
      const bearing = wrapPi(Math.atan2(dy, dx) - ego.headingRad);
      if (this.sensorApertures.length > 0) {
        const seen = this.sensorApertures.some(
          (s) => range <= s.farM && Math.abs(bearing) <= (s.horizontalFovDeg * Math.PI) / 360,
        );
        if (!seen) continue;
      }
      const prev = this.prevRange.get(a.id);
      const rangeRate = prev !== undefined && frame.dtS > 0 ? (range - prev) / frame.dtS : 0;
      this.prevRange.set(a.id, range);
      objects.push({ id: a.id, rangeM: range, bearingRad: bearing, rangeRateMps: rangeRate, lineOfSight: los });
    }
    objects.sort((x, y) => x.rangeM - y.rangeM || (x.id < y.id ? -1 : 1));
    this.lastLosPairs = objects.map((o) => ({
      observerId: ego.id,
      targetId: o.id,
      visible: o.lineOfSight,
    }));
    return objects;
  }
}

/* --------------------------------------------------------- BEV raster */

const BEV_CHANNELS = 3;

/**
 * Ego-centric bird's-eye-view raster, three float channels:
 *
 * - 0: drivable lane surface (all lanes, stamped at their authored width);
 * - 1: the ego's current lane surface;
 * - 2: other-actor OBB occupancy.
 *
 * Layout is row-major, row 0 farthest forward, `[cell].channels` floats per
 * cell. The raster frame is the ego pose: +x forward, +y left, so a policy
 * never sees a world-frame discontinuity when the map frame differs.
 */
export class BevRasterBuilder {
  private readonly cfg: BevConfig;

  constructor(cfg: BevConfig) {
    this.cfg = cfg;
  }

  build(frame: ObservationFrame, ctx: ObservationContextInput): BevRaster {
    const cfg = this.cfg;
    const width = Math.max(1, Math.round((2 * cfg.halfWidthM) / cfg.resolutionM));
    const height = Math.max(1, Math.round((cfg.forwardM + cfg.backwardM) / cfg.resolutionM));
    const data = new Float32Array(width * height * BEV_CHANNELS);

    const sorted = [...frame.actors].sort((a, b) => (a.id < b.id ? -1 : 1));
    const ego = sorted.find((a) => a.id === ctx.egoId);
    if (!ego) throw new Error(`ego actor ${ctx.egoId} missing from snapshot`);
    const cosH = Math.cos(ego.headingRad);
    const sinH = Math.sin(ego.headingRad);
    // World → ego cell: forward = along heading, left = +y in ego frame.
    const toCell = (wx: number, wy: number): { row: number; col: number } => {
      const dx = wx - ego.x;
      const dy = wy - ego.y;
      const fwd = dx * cosH + dy * sinH;
      const left = -dx * sinH + dy * cosH;
      const col = Math.floor((left + cfg.halfWidthM) / cfg.resolutionM);
      const row = Math.floor((cfg.forwardM - fwd) / cfg.resolutionM);
      return { row, col };
    };
    const stampDisc = (wx: number, wy: number, radiusM: number, channel: number, value: number): void => {
      const r = Math.ceil(radiusM / cfg.resolutionM);
      const center = toCell(wx, wy);
      for (let dr = -r; dr <= r; dr++) {
        for (let dc = -r; dc <= r; dc++) {
          if (dr * dr + dc * dc > r * r) continue;
          const row = center.row + dr;
          const col = center.col + dc;
          if (row < 0 || row >= height || col < 0 || col >= width) continue;
          data[(row * width + col) * BEV_CHANNELS + channel] = value;
        }
      }
    };

    // Lane surfaces: sample every lane's polyline densely enough that the
    // stamped discs overlap at any resolution.
    // Cull by a world-axis bounding box around the ego before touching cells:
    // real maps have thousands of lanes and the raster covers ~60 × 40 m.
    const margin = cfg.laneHalfWidthM + cfg.resolutionM * 2;
    const xMin = ego.x - (cfg.forwardM + margin);
    const xMax = ego.x + (cfg.forwardM + margin);
    const yMin = ego.y - (cfg.halfWidthM + margin);
    const yMax = ego.y + (cfg.halfWidthM + margin);
    const step = cfg.resolutionM / 2;
    const egoLane = ego.laneRsl;
    for (const rsl of ctx.graph.laneRsls()) {
      const geom = ctx.graph.geometry(rsl);
      if (!geom) continue;
      let anyVisible = false;
      for (const p of geom.points) {
        if (p.x >= xMin && p.x <= xMax && p.y >= yMin && p.y <= yMax) {
          anyVisible = true;
          break;
        }
      }
      if (!anyVisible) continue;
      const channel = rsl === egoLane ? 1 : 0;
      const halfWidth = Math.max(ctx.graph.widthAt(rsl, geom.lengthM / 2) / 2, cfg.laneHalfWidthM);
      for (let i = 1; i < geom.points.length; i++) {
        const a = geom.points[i - 1]!;
        const b = geom.points[i]!;
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.ceil(segLen / step));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          stampDisc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, halfWidth, channel, 1);
        }
      }
    }

    // Actor OBB occupancy: fill each corner polygon row by row.
    for (const a of sorted) {
      if (a.id === ctx.egoId) continue;
      const dims = ctx.input.actors.find((spec) => spec.id === a.id)?.dims;
      if (!dims) continue;
      const corners = obbCorners({
        center: { x: a.x, y: a.y } as Vec2,
        lengthM: dims.l,
        widthM: dims.w,
        headingRad: a.headingRad,
      }).map((p) => toCell(p.x, p.y));
      const rows = corners.map((c) => c.row);
      const rMin = Math.max(0, Math.min(...rows));
      const rMax = Math.min(height - 1, Math.max(...rows));
      for (let row = rMin; row <= rMax; row++) {
        // Even-odd crossing count along this raster row.
        const xs: number[] = [];
        for (let i = 0; i < corners.length; i++) {
          const p = corners[i]!;
          const q = corners[(i + 1) % corners.length]!;
          if ((p.row <= row && q.row > row) || (q.row <= row && p.row > row)) {
            const t = (row - p.row) / (q.row - p.row);
            xs.push(p.col + (q.col - p.col) * t);
          }
        }
        xs.sort((m, n) => m - n);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const c0 = Math.max(0, Math.ceil(xs[k]!));
          const c1 = Math.min(width - 1, Math.floor(xs[k + 1]!));
          for (let col = c0; col <= c1; col++) {
            data[(row * width + col) * BEV_CHANNELS + 2] = 1;
          }
        }
      }
    }

    return { width, height, channels: BEV_CHANNELS, resolutionM: cfg.resolutionM, data };
  }
}
