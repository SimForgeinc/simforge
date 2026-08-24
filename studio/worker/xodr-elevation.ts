import type { LaneGeometry, LaneGraph } from "@simforge/engine";

type Poly3 = { s: number; a: number; b: number; c: number; d: number };
type RoadProfile = { length: number; sectionStarts: number[]; elevations: Poly3[] };

const LANE_EDGE_TOLERANCE_M = 0.15;
const AMBIGUOUS_DISTANCE_EPSILON_M = 0.001;
const DISTINCT_SURFACE_EPSILON_M = 0.05;
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
    const id = finite(roadAttrs.id, "road.id");
    const length = finite(roadAttrs.length, `road.${id}.length`);
    const body = match[2]!;
    const sectionStarts = [...body.matchAll(/<laneSection\b([^>]*)>/g)]
      .map((item) => finite(attrs(item[1]!).s, `road.${id}.laneSection.s`)).sort((a, b) => a - b);
    const elevations = [...body.matchAll(/<elevation\b([^>]*)\/?\s*>/g)].map((item): Poly3 => {
      const values = attrs(item[1]!);
      return { s: finite(values.s, `road.${id}.elevation.s`), a: finite(values.a, `road.${id}.elevation.a`), b: finite(values.b, `road.${id}.elevation.b`), c: finite(values.c, `road.${id}.elevation.c`), d: finite(values.d, `road.${id}.elevation.d`) };
    }).sort((a, b) => a.s - b.s);
    if (result.has(id)) throw new Error(`xodr_elevation_duplicate_road:${id}`);
    result.set(id, { length, sectionStarts, elevations });
  }
  if (result.size === 0) throw new Error("xodr_elevation_no_roads");
  return result;
}

function evaluate(records: readonly Poly3[], s: number): number {
  if (records.length === 0) return 0;
  let record = records[0]!;
  for (const candidate of records) { if (candidate.s > s) break; record = candidate; }
  const ds = s - record.s;
  return record.a + record.b * ds + record.c * ds ** 2 + record.d * ds ** 3;
}

function projectSampledLane(points: readonly { readonly x: number; readonly y: number }[], cumulative: readonly number[], x: number, y: number): { arcS: number; sampleFraction: number; d: number } | null {
  if (points.length < 2 || cumulative.length !== points.length) return null;
  let best: { arcS: number; sampleFraction: number; d2: number } | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!; const b = points[index]!;
    const dx = b.x - a.x; const dy = b.y - a.y; const length2 = dx * dx + dy * dy;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2)) : 0;
    const px = a.x + t * dx; const py = a.y + t * dy; const d2 = (x - px) ** 2 + (y - py) ** 2;
    if (best === null || d2 < best.d2) best = { arcS: cumulative[index - 1]! + t * (cumulative[index]! - cumulative[index - 1]!), sampleFraction: (index - 1 + t) / (points.length - 1), d2 };
  }
  return best && { arcS: best.arcS, sampleFraction: best.sampleFraction, d: Math.sqrt(best.d2) };
}

export function buildXodrElevationResolver(xodr: string, graph: LaneGraph): (position: { readonly x: number; readonly y: number; readonly actorId?: string }) => number {
  const profiles = parseProfiles(xodr);
  const laneRecords = new Map<string, { geometry: LaneGeometry; road: RoadProfile; sectionStart: number; sectionEnd: number }>();
  const cells = new Map<string, Set<string>>();
  for (const rsl of graph.laneRsls()) {
    const geometry = graph.geometry(rsl);
    if (!geometry || geometry.lane.laneType !== "driving") continue;
    const road = profiles.get(geometry.lane.roadId); const sectionStart = road?.sectionStarts[geometry.lane.section];
    if (!road || sectionStart === undefined) throw new Error(`xodr_elevation_topology_mismatch:${rsl}`);
    const sectionEnd = road.sectionStarts[geometry.lane.section + 1] ?? road.length;
    if (!(sectionEnd > sectionStart) || !(geometry.lengthM > 0)) throw new Error(`xodr_elevation_degenerate_lane:${rsl}`);
    laneRecords.set(rsl, { geometry, road, sectionStart, sectionEnd });
    const halfWidth = Math.max(geometry.lane.representativeWidthM ?? 0, ...(geometry.lane.widthSamples ?? []).map((sample) => sample.widthM)) / 2 + LANE_EDGE_TOLERANCE_M;
    const xs = geometry.points.map((point) => point.x); const ys = geometry.points.map((point) => point.y);
    for (let cellX = Math.floor((Math.min(...xs) - halfWidth) / SPATIAL_CELL_M); cellX <= Math.floor((Math.max(...xs) + halfWidth) / SPATIAL_CELL_M); cellX += 1) {
      for (let cellY = Math.floor((Math.min(...ys) - halfWidth) / SPATIAL_CELL_M); cellY <= Math.floor((Math.max(...ys) + halfWidth) / SPATIAL_CELL_M); cellY += 1) {
        const key = `${cellX},${cellY}`; const members = cells.get(key) ?? new Set<string>(); members.add(rsl); cells.set(key, members);
      }
    }
  }
  return ({ x, y, actorId }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("xodr_elevation_non_finite_position");
    const candidates: Array<{ rsl: string; d: number; elevation: number }> = [];
    const nearby = cells.get(`${Math.floor(x / SPATIAL_CELL_M)},${Math.floor(y / SPATIAL_CELL_M)}`) ?? [];
    for (const rsl of nearby) {
      const { geometry, road, sectionStart, sectionEnd } = laneRecords.get(rsl)!;
      const projected = projectSampledLane(geometry.points, geometry.cum, x, y);
      if (!projected || projected.d > graph.widthAt(rsl, projected.arcS) / 2 + LANE_EDGE_TOLERANCE_M) continue;
      candidates.push({ rsl, d: projected.d, elevation: evaluate(road.elevations, sectionStart + projected.sampleFraction * (sectionEnd - sectionStart)) });
    }
    candidates.sort((a, b) => a.d - b.d || a.rsl.localeCompare(b.rsl));
    const best = candidates[0]; const label = actorId ? `:${actorId}` : "";
    if (!best) throw new Error(`xodr_elevation_unresolvable${label}`);
    const conflicting = candidates.find((candidate) => candidate !== best && Math.abs(candidate.d - best.d) <= AMBIGUOUS_DISTANCE_EPSILON_M && Math.abs(candidate.elevation - best.elevation) > DISTINCT_SURFACE_EPSILON_M);
    if (conflicting) throw new Error(`xodr_elevation_ambiguous${label}:${best.rsl}:${conflicting.rsl}`);
    if (!Number.isFinite(best.elevation)) throw new Error(`xodr_elevation_non_finite_surface:${best.rsl}`);
    return best.elevation;
  };
}
