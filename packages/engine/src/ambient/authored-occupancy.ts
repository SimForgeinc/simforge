import type { ActorKind, StaticProp } from '../schema/input.js';
import type { SceneTrace } from '../trace/trace.js';
import {
  sumoNetworkToScene,
  type SumoNetworkWorldTransform,
} from './sumo.js';

/** Provider-neutral proxy kind understood by the browser and headless bridges. */
export type SumoAuthoredOccupancyKind = 'vehicle' | 'pedestrian' | 'bicycle' | 'obstacle';

/** One authored road user or fixed object sampled in scene x/z coordinates. */
export interface SumoAuthoredOccupancySource {
  readonly id: string;
  readonly kind: ActorKind;
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly lengthM: number;
  readonly widthM: number;
  readonly static: boolean;
  readonly present?: boolean;
}

/** Conservative hidden shape sent to SUMO for car-following perception. */
export interface SumoAuthoredOccupancy {
  readonly id: string;
  readonly kind: SumoAuthoredOccupancyKind;
  readonly x: number;
  readonly z: number;
  readonly headingRad: number;
  readonly speedMps: number;
  readonly lengthM: number;
  readonly widthM: number;
}

interface RoadSegment {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly halfWidthM: number;
}

export interface SumoRoadOccupancyIndex {
  readonly segments: readonly RoadSegment[];
}

const ROAD_MARGIN_M = .35;
const VULNERABLE_LOOKAHEAD_S = 3;

/**
 * Extract lane centre-lines from the exact SUMO network used by the provider.
 * Keeping this index in scene coordinates makes the road-relevance decision
 * identical in Studio and the CLI and protects the x/z coordinate contract.
 */
export function buildSumoRoadOccupancyIndex(
  networkXml: string,
  transform: SumoNetworkWorldTransform,
): SumoRoadOccupancyIndex {
  const segments: RoadSegment[] = [];
  const lanePattern = /<lane\b([^>]*)>/g;
  for (const match of networkXml.matchAll(lanePattern)) {
    const attributes = match[1] ?? '';
    const shapeMatch = /\bshape="([^"]+)"/.exec(attributes);
    if (!shapeMatch) continue;
    const widthMatch = /\bwidth="([^"]+)"/.exec(attributes);
    const widthM = Number(widthMatch?.[1] ?? 3.2) * Math.abs(transform.scale);
    if (!(widthM > 0)) continue;
    const points = shapeMatch[1]!.trim().split(/\s+/).map((entry) => {
      const [x, y] = entry.split(',').map(Number);
      return Number.isFinite(x) && Number.isFinite(y)
        ? sumoNetworkToScene({ x: x!, y: y! }, transform)
        : null;
    }).filter((point): point is { x: number; z: number } => point !== null);
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]!;
      const b = points[index]!;
      if (a.x === b.x && a.z === b.z) continue;
      segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, halfWidthM: widthM / 2 });
    }
  }
  return { segments };
}

/**
 * Include only authored shapes whose current footprint touches a driveable
 * lane. Vulnerable users also receive a short swept-path lookahead so a car
 * can yield before, rather than after, they enter the lane. Off-road scenery
 * is never handed to moveToXY, preventing it from snapping onto a road.
 */
export function buildSumoAuthoredOccupancies(
  sources: readonly SumoAuthoredOccupancySource[],
  roads: SumoRoadOccupancyIndex,
): readonly SumoAuthoredOccupancy[] {
  return sources.flatMap((source) => {
    if (source.present === false || !finiteSource(source)) return [];
    const kind = occupancyKind(source.kind, source.static);
    const vulnerable = kind === 'pedestrian' || kind === 'bicycle';
    if (!touchesRoad(source, roads, vulnerable)) return [];
    return [{
      id: source.id,
      kind,
      x: source.x,
      z: source.z,
      headingRad: source.headingRad,
      // A material collision is already represented by zero trace speed. Static
      // objects are always held even if malformed source data reports motion.
      speedMps: source.static || kind === 'obstacle' ? 0 : Math.max(0, source.speedMps),
      lengthM: Math.max(.35, source.lengthM),
      widthM: Math.max(.35, source.widthM),
    }];
  });
}

/** Sample actors and fixed props from the canonical scene trace. */
export function sumoAuthoredOccupancySourcesAt(
  trace: SceneTrace,
  t: number,
): readonly SumoAuthoredOccupancySource[] {
  const sampleIndex = nearestIndex(trace.ticks.t, t);
  const actors = Object.entries(trace.ticks.actors).map(([id, track]) => {
    const metadata = trace.header.actorMetadata?.[id];
    return {
      id,
      kind: metadata?.kind ?? 'vehicle',
      x: track.x[sampleIndex]!,
      z: track.z[sampleIndex]!,
      headingRad: track.headingRad[sampleIndex]!,
      speedMps: track.speedMps[sampleIndex]!,
      lengthM: metadata?.dims.l ?? 4.8,
      widthM: metadata?.dims.w ?? 1.9,
      static: metadata?.static ?? false,
      present: track.present[sampleIndex] === 1,
    } satisfies SumoAuthoredOccupancySource;
  });
  const props = Object.values(trace.header.propMetadata ?? {}).map(propSource);
  return [...actors, ...props];
}

export function sumoAuthoredOccupanciesAt(
  trace: SceneTrace,
  t: number,
  roads: SumoRoadOccupancyIndex,
): readonly SumoAuthoredOccupancy[] {
  return buildSumoAuthoredOccupancies(sumoAuthoredOccupancySourcesAt(trace, t), roads);
}

function propSource(prop: StaticProp): SumoAuthoredOccupancySource {
  return {
    id: `prop:${prop.id}`,
    kind: 'static_object',
    x: prop.pose.x,
    z: prop.pose.z,
    headingRad: prop.pose.headingRad,
    speedMps: 0,
    lengthM: prop.dims.l * prop.scale,
    widthM: prop.dims.w * prop.scale,
    static: true,
    present: true,
  };
}

function occupancyKind(kind: ActorKind, isStatic: boolean): SumoAuthoredOccupancyKind {
  if (isStatic || kind === 'static_object') return 'obstacle';
  if (kind === 'pedestrian' || kind === 'animal') return 'pedestrian';
  if (kind === 'bicycle' || kind === 'scooter') return 'bicycle';
  return 'vehicle';
}

function touchesRoad(
  source: SumoAuthoredOccupancySource,
  roads: SumoRoadOccupancyIndex,
  vulnerable: boolean,
): boolean {
  const headingX = Math.cos(source.headingRad);
  const headingZ = Math.sin(source.headingRad);
  const sweepM = vulnerable ? Math.max(0, source.speedMps) * VULNERABLE_LOOKAHEAD_S : 0;
  const endX = source.x + headingX * sweepM;
  const endZ = source.z + headingZ * sweepM;
  for (const road of roads.segments) {
    const roadAngle = Math.atan2(road.bz - road.az, road.bx - road.ax);
    const relative = source.headingRad - roadAngle;
    const lateralExtent = Math.abs(Math.sin(relative)) * source.lengthM / 2
      + Math.abs(Math.cos(relative)) * source.widthM / 2;
    const clearance = road.halfWidthM + lateralExtent + ROAD_MARGIN_M;
    const distance = sweepM > 0
      ? segmentDistance(source.x, source.z, endX, endZ, road.ax, road.az, road.bx, road.bz)
      : pointSegmentDistance(source.x, source.z, road.ax, road.az, road.bx, road.bz);
    if (distance <= clearance) return true;
  }
  return false;
}

function pointSegmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const denominator = dx * dx + dz * dz;
  const u = denominator > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / denominator, 0, 1) : 0;
  return Math.hypot(px - (ax + u * dx), pz - (az + u * dz));
}

function segmentDistance(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): number {
  if (segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(
    pointSegmentDistance(ax, az, cx, cz, dx, dz),
    pointSegmentDistance(bx, bz, cx, cz, dx, dz),
    pointSegmentDistance(cx, cz, ax, az, bx, bz),
    pointSegmentDistance(dx, dz, ax, az, bx, bz),
  );
}

function segmentsIntersect(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number,
): boolean {
  const cross = (ux: number, uz: number, vx: number, vz: number) => ux * vz - uz * vx;
  const abx = bx - ax;
  const abz = bz - az;
  const cdx = dx - cx;
  const cdz = dz - cz;
  const denominator = cross(abx, abz, cdx, cdz);
  if (Math.abs(denominator) < 1e-9) return false;
  const acx = cx - ax;
  const acz = cz - az;
  const u = cross(acx, acz, cdx, cdz) / denominator;
  const v = cross(acx, acz, abx, abz) / denominator;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}

function nearestIndex(times: readonly number[], t: number): number {
  let low = 0;
  let high = Math.max(0, times.length - 1);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle]! < t) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(times[low - 1]! - t) <= Math.abs(times[low]! - t)) return low - 1;
  return low;
}

function finiteSource(source: SumoAuthoredOccupancySource): boolean {
  return [source.x, source.z, source.headingRad, source.speedMps, source.lengthM, source.widthM].every(Number.isFinite)
    && source.lengthM > 0 && source.widthM > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
