import type { LaneGeometry, LaneGraph } from '@simforge-oss/engine';

type Poly3 = { s: number; a: number; b: number; c: number; d: number };
type RoadProfile = { length: number; sectionStarts: number[]; elevations: Poly3[] };

const LANE_EDGE_TOLERANCE_M = 0.15;
const AMBIGUOUS_DISTANCE_EPSILON_M = 0.001;
const DISTINCT_SURFACE_EPSILON_M = 0.05;
const CONTINUOUS_SURFACE_MAX_GAP_M = 1;
const SPATIAL_CELL_M = 25;

function attrs(tag: string): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2/g)) result[match[1]!] = match[3]!;
  return result;
}

function finite(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`xodr_elevation_invalid:${label}`);
  return parsed;
}

function parseProfiles(xodr: string): Map<number, RoadProfile> {
  const result = new Map<number, RoadProfile>();
  for (const match of xodr.matchAll(/<road\b([^>]*)>([\s\S]*?)<\/road>/g)) {
    const roadAttrs = attrs(match[1]!);
    const id = finite(roadAttrs.id, 'road.id');
    const length = finite(roadAttrs.length, `road.${id}.length`);
    const body = match[2]!;
    const sectionStarts = [...body.matchAll(/<laneSection\b([^>]*)>/g)]
      .map((item) => finite(attrs(item[1]!).s, `road.${id}.laneSection.s`))
      .sort((a, b) => a - b);
    const elevations = [...body.matchAll(/<elevation\b([^>]*)\/?\s*>/g)]
      .map((item): Poly3 => {
        const values = attrs(item[1]!);
        return {
          s: finite(values.s, `road.${id}.elevation.s`),
          a: finite(values.a, `road.${id}.elevation.a`),
          b: finite(values.b, `road.${id}.elevation.b`),
          c: finite(values.c, `road.${id}.elevation.c`),
          d: finite(values.d, `road.${id}.elevation.d`),
        };
      })
      .sort((a, b) => a.s - b.s);
    if (result.has(id)) throw new Error(`xodr_elevation_duplicate_road:${id}`);
    result.set(id, { length, sectionStarts, elevations });
  }
  if (result.size === 0) throw new Error('xodr_elevation_no_roads');
  return result;
}

function evaluate(records: readonly Poly3[], s: number): number {
  if (records.length === 0) return 0;
  let record = records[0]!;
  for (const candidate of records) {
    if (candidate.s > s) break;
    record = candidate;
  }
  const ds = s - record.s;
  return record.a + record.b * ds + record.c * ds ** 2 + record.d * ds ** 3;
}

function projectSampledLane(
  points: readonly { readonly x: number; readonly y: number }[],
  cumulative: readonly number[],
  x: number,
  y: number,
): { arcS: number; sampleFraction: number; d: number } | null {
  if (points.length < 2 || cumulative.length !== points.length) return null;
  let best: { arcS: number; sampleFraction: number; d2: number } | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0;
    const px = a.x + t * dx;
    const py = a.y + t * dy;
    const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (best === null || d2 < best.d2) {
      best = {
        arcS: cumulative[index - 1]! + t * (cumulative[index]! - cumulative[index - 1]!),
        sampleFraction: (index - 1 + t) / (points.length - 1),
        d2,
      };
    }
  }
  return best && { arcS: best.arcS, sampleFraction: best.sampleFraction, d: Math.sqrt(best.d2) };
}

/**
 * Build an absolute OpenDRIVE road-surface resolver from immutable lane
 * topology. XY is accepted only inside concrete lane ribbons (with a bounded
 * off-road projection for parking and plazas). Overlapping surfaces use the
 * actor's authored roads when supplied and otherwise fail closed when distinct
 * unconnected decks are equally plausible.
 */
export function buildXodrElevationResolver(
  xodr: string,
  graph: LaneGraph,
  preferredRoadsByActor?: ReadonlyMap<string, ReadonlySet<string>>,
): (position: { readonly x: number; readonly y: number; readonly actorId?: string }) => number {
  const profiles = parseProfiles(xodr);
  const laneRecords = new Map<string, {
    geometry: LaneGeometry;
    road: RoadProfile;
    sectionStart: number;
    sectionEnd: number;
    driving: boolean;
    roadId: number;
  }>();
  const roadNeighbors = new Map<number, Set<number>>();
  const linkRoads = (a: number, b: number) => {
    if (a === b) return;
    const forward = roadNeighbors.get(a) ?? new Set<number>();
    forward.add(b);
    roadNeighbors.set(a, forward);
    const backward = roadNeighbors.get(b) ?? new Set<number>();
    backward.add(a);
    roadNeighbors.set(b, backward);
  };
  const cells = new Map<string, Set<string>>();
  for (const rsl of graph.laneRsls()) {
    const geometry = graph.geometry(rsl);
    if (!geometry) continue;
    const driving = geometry.lane.laneType === 'driving';
    const road = profiles.get(geometry.lane.roadId);
    const sectionStart = road?.sectionStarts[geometry.lane.section];
    if (!road || sectionStart === undefined) throw new Error(`xodr_elevation_topology_mismatch:${rsl}`);
    const sectionEnd = road.sectionStarts[geometry.lane.section + 1] ?? road.length;
    if (!(sectionEnd > sectionStart) || !(geometry.lengthM > 0)) throw new Error(`xodr_elevation_degenerate_lane:${rsl}`);
    laneRecords.set(rsl, { geometry, road, sectionStart, sectionEnd, driving, roadId: geometry.lane.roadId });
    for (const linked of [...(geometry.lane.predecessors ?? []), ...(geometry.lane.successors ?? [])]) {
      const linkedRoad = Number(linked.split(':')[0]);
      if (Number.isFinite(linkedRoad)) linkRoads(geometry.lane.roadId, linkedRoad);
    }
    const halfWidth = Math.max(
      geometry.lane.representativeWidthM ?? 0,
      ...(geometry.lane.widthSamples ?? []).map((sample) => sample.widthM),
    ) / 2 + LANE_EDGE_TOLERANCE_M;
    const xs = geometry.points.map((point) => point.x);
    const ys = geometry.points.map((point) => point.y);
    const minX = Math.floor((Math.min(...xs) - halfWidth) / SPATIAL_CELL_M);
    const maxX = Math.floor((Math.max(...xs) + halfWidth) / SPATIAL_CELL_M);
    const minY = Math.floor((Math.min(...ys) - halfWidth) / SPATIAL_CELL_M);
    const maxY = Math.floor((Math.max(...ys) + halfWidth) / SPATIAL_CELL_M);
    for (let cellX = minX; cellX <= maxX; cellX += 1) {
      for (let cellY = minY; cellY <= maxY; cellY += 1) {
        const key = `${cellX},${cellY}`;
        const members = cells.get(key) ?? new Set<string>();
        members.add(rsl);
        cells.set(key, members);
      }
    }
  }
  const roadsContinuous = (a: number, b: number): boolean => {
    if (a === b) return true;
    const aNeighbors = roadNeighbors.get(a);
    const bNeighbors = roadNeighbors.get(b);
    if (!aNeighbors || !bNeighbors) return false;
    if (aNeighbors.has(b) || bNeighbors.has(a)) return true;
    const [small, large] = aNeighbors.size <= bNeighbors.size ? [aNeighbors, bNeighbors] : [bNeighbors, aNeighbors];
    for (const road of small) if (large.has(road)) return true;
    return false;
  };
  return ({ x, y, actorId }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('xodr_elevation_non_finite_position');
    const candidates: Array<{ rsl: string; d: number; elevation: number; driving: boolean; roadId: number }> = [];
    const nearby = cells.get(`${Math.floor(x / SPATIAL_CELL_M)},${Math.floor(y / SPATIAL_CELL_M)}`) ?? [];
    for (const rsl of nearby) {
      const { geometry, road, sectionStart, sectionEnd, driving, roadId } = laneRecords.get(rsl)!;
      const projected = projectSampledLane(geometry.points, geometry.cum, x, y);
      if (!projected || projected.d > graph.widthAt(rsl, projected.arcS) / 2 + LANE_EDGE_TOLERANCE_M) continue;
      const roadS = sectionStart + projected.sampleFraction * (sectionEnd - sectionStart);
      candidates.push({ rsl, d: projected.d, elevation: evaluate(road.elevations, roadS), driving, roadId });
    }
    let tier = candidates.filter((candidate) => candidate.driving);
    if (tier.length === 0) tier = candidates;
    const preferredRoads = actorId ? preferredRoadsByActor?.get(actorId) : undefined;
    if (preferredRoads && preferredRoads.size > 0) {
      const onRoute = tier.filter((candidate) => preferredRoads.has(candidate.rsl.split(':')[0]!));
      if (onRoute.length > 0) tier = onRoute;
    }
    tier.sort((a, b) => a.d - b.d || a.rsl.localeCompare(b.rsl));
    const best = tier[0];
    const label = actorId ? `:${actorId}` : '';
    if (!best) {
      const cellX = Math.floor(x / SPATIAL_CELL_M);
      const cellY = Math.floor(y / SPATIAL_CELL_M);
      let nearest: { d: number; rsl: string; elevation: number } | null = null;
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (const rsl of cells.get(`${cellX + dx},${cellY + dy}`) ?? []) {
            const { geometry, road, sectionStart, sectionEnd } = laneRecords.get(rsl)!;
            const projected = projectSampledLane(geometry.points, geometry.cum, x, y);
            if (!projected) continue;
            const roadS = sectionStart + projected.sampleFraction * (sectionEnd - sectionStart);
            const elevation = evaluate(road.elevations, roadS);
            if (!nearest || projected.d < nearest.d || (projected.d === nearest.d && rsl.localeCompare(nearest.rsl) < 0)) {
              nearest = { d: projected.d, rsl, elevation };
            }
          }
        }
      }
      if (!nearest || nearest.d > SPATIAL_CELL_M) throw new Error(`xodr_elevation_unresolvable${label}`);
      return nearest.elevation;
    }
    const conflicting = tier.find((candidate) =>
      candidate !== best
      && Math.abs(candidate.d - best.d) <= AMBIGUOUS_DISTANCE_EPSILON_M
      && Math.abs(candidate.elevation - best.elevation) > DISTINCT_SURFACE_EPSILON_M
      && !(Math.abs(candidate.elevation - best.elevation) <= CONTINUOUS_SURFACE_MAX_GAP_M
        && roadsContinuous(best.roadId, candidate.roadId)));
    if (conflicting) throw new Error(`xodr_elevation_ambiguous${label}:${best.rsl}:${conflicting.rsl}`);
    if (!Number.isFinite(best.elevation)) throw new Error(`xodr_elevation_non_finite_surface:${best.rsl}`);
    return best.elevation;
  };
}
