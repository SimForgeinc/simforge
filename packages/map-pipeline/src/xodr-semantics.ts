import { CoordinateFrame } from '@simforge-oss/maps/coordinate-frame';
import { parseXodr, refLineAt } from './ported/map-topology/build-topology-index.js';
import type { MapTopologyIndex } from './ported/map-topology/types.js';

export type SemanticFeature = { type: 'Feature'; geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> };
export type SemanticCollection = { type: 'FeatureCollection'; features: SemanticFeature[] };
export const collection = (features: SemanticFeature[]): SemanticCollection => ({ type: 'FeatureCollection', features });

function attrs(text: string): Record<string, string> {
  return Object.fromEntries([...text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((m) => [m[1]!, (m[2] ?? m[3] ?? '').replace(/&(?:amp|quot|apos|lt|gt);/g, (v) => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[v]!)]));
}

function isPositive(value: string | undefined): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function category(a: Record<string, string>): string {
  const name = (a.name ?? '').replace(/_/g, ' ');
  const code = `${a.type ?? ''}-${a.subtype ?? ''} ${name}`;
  if (/stop.?line/i.test(code)) return 'stop_line';
  if (/\bR1-1\b|\bstop(?:\s*sign)?\b/i.test(code) || (a.country?.toUpperCase() === 'DE' && a.type === '206')) return 'stop_sign';
  if (/\bR2-1\b|speed.?limit/i.test(code) || (a.country?.toUpperCase() === 'DE' && a.type === '274')) return 'speed_limit_sign';
  if (/street.?name/i.test(code)) return 'street_name_sign';
  if (/\bno.?parking\b/i.test(name)) return 'parking_sign';
  if (/\b(?:left.?and.?u.?turn|left.?turn|no.?left.?turn|no.?turn.?on.?red|no.?u.?turns?|right.?lane.?must.?turn|one.?way)\b/i.test(name)) return 'turn_restriction_sign';
  if (/\bbike.?lane\b/i.test(name)) return 'regulatory_sign';
  if (/\broad.?work(?:.?ahead)?\b/i.test(name)) return 'warning_sign';
  // RoadRunner also uses these type ids for zero-sized, gate-only routing
  // records. Dimensions or an authored head name are the physical evidence.
  const physicalHead = isPositive(a.height) && isPositive(a.width);
  const authoredHeadName = /signal.?3.?light|traffic.?light|traffic.?signal|signal.?head/i.test(name);
  if (a.dynamic === 'yes' && (authoredHeadName || (physicalHead && (a.type === '1000001' || a.type === '1000011')))) return 'traffic_light';
  return 'unknown';
}

function unresolvedSignalReason(a: Record<string, string>): string {
  const name = (a.name ?? '').replace(/_/g, ' ');
  if (a.dynamic === 'yes' && (a.type === '1000001' || a.type === '1000011') && !name.trim() && !isPositive(a.height) && !isPositive(a.width)) {
    return 'non-physical-dynamic-gate';
  }
  if (a.type === '1000002' || /walk.?light|pedestrian.?signal/i.test(name)) return 'unsupported-pedestrian-signal-category';
  return 'unclassified-signal-type';
}

function speedLimit(a: Record<string, string>): { key: 'speed_limit_mph' | 'speed_limit_kph'; value: number } | null {
  const authoredValue = Number(a.value);
  const namedValue = /speed.?limit[^\d]*(\d+(?:\.\d+)?)/i.exec(a.name ?? '')?.[1];
  const value = Number.isFinite(authoredValue) && authoredValue > 0 ? authoredValue : Number(namedValue);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = a.unit?.trim().toLowerCase();
  if (unit === 'mph' || ((!unit || unit === '') && (a.country?.toUpperCase() === 'US' || /(?:^|_)US(?:_|$)/i.test(a.name ?? '')))) {
    return { key: 'speed_limit_mph', value };
  }
  if (unit === 'km/h' || unit === 'kmh' || unit === 'kph') return { key: 'speed_limit_kph', value };
  if (unit === 'm/s') return { key: 'speed_limit_kph', value: value * 3.6 };
  return null;
}

/** Extract physical entities only: references remain applicability, never extra heads. */
export function extractXodrSemantics(xodr: string, topology: MapTopologyIndex, frame: CoordinateFrame) {
  // The shared topology parser is line-oriented. Normalising tag boundaries also
  // supports compact exports without changing the immutable original XODR bytes.
  const normalised = xodr.replace(/>\s*</g, '>\n<');
  const { roads } = parseXodr(normalised);
  const signals: SemanticFeature[] = [];
  const objects: SemanticFeature[] = [];
  const roadNames: Record<string, string> = {};
  const applicability: Record<string, unknown>[] = [];
  const unresolved: Record<string, unknown>[] = [];
  for (const match of xodr.matchAll(/<road\b([^>]*)>([\s\S]*?)<\/road>/g)) {
    const roadAttrs = attrs(match[1]!);
    const roadId = roadAttrs.id!;
    if (roadAttrs.name?.trim()) roadNames[roadId] = roadAttrs.name.trim();
    const road = roads.get(Number(roadId));
    for (const entity of match[2]!.matchAll(/<(signalReference|signal|object)\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/\1\s*>)/g)) {
      const a = attrs(entity[2]!);
      const body = entity[3] ?? '';
      const validity = [...body.matchAll(/<validity\b([^>]*)\/?\s*>/g)].map((v) => attrs(v[1]!)).map((v) => ({ fromLane: Number(v.fromLane), toLane: Number(v.toLane) }));
      applicability.push({ kind: entity[1], id: a.id, roadId, orientation: a.orientation ?? 'none', validity, s: Number(a.s), t: Number(a.t ?? 0) });
      if (entity[1] === 'signalReference') continue;
      const s = Number(a.s), t = Number(a.t ?? 0);
      const ref = road && Number.isFinite(s) && s >= 0 && s <= road.length ? refLineAt(road, s) : null;
      if (!a.id || !ref || !Number.isFinite(t)) { unresolved.push({ kind: entity[1], id: a.id ?? null, roadId, reason: 'missing-or-invalid-source-position' }); continue; }
      const point = frame.localToWgs84(ref.x - Math.sin(ref.hdg) * t, ref.y + Math.cos(ref.hdg) * t);
      const signalCategory = category(a);
      if (signalCategory === 'unknown' && entity[1] === 'signal') unresolved.push({ ...a, kind: 'signal', id: a.id, roadId, reason: unresolvedSignalReason(a) });
      const properties: Record<string, unknown> = { ...a, feature_kind: entity[1], id: a.id, road_id: roadId, s, t, hdg: ref.hdg + (a.orientation === '-' ? Math.PI : 0) + Number(a.hOffset ?? 0), z_offset: Number(a.zOffset ?? 0), signal_category: signalCategory, validity, source: 'opendrive' };
      if (signalCategory === 'speed_limit_sign') {
        const parsed = speedLimit(a);
        if (parsed) properties[parsed.key] = parsed.value;
      }
      const feature: SemanticFeature = { type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties };
      if (entity[1] === 'signal' || signalCategory !== 'unknown') signals.push(feature);
      if (entity[1] === 'object') objects.push({ ...feature, properties: { ...properties, Type: a.type ?? 'Object', Id: a.id, source_object_xml: entity[0] } });
    }
  }
  const rawLanes = Object.entries(topology.lanes).map(([rsl, lane]): SemanticFeature => {
    const sourceLane = roads.get(lane.roadId)?.sections[lane.section]?.lanes.find((l) => l.id === lane.laneId);
    return { type: 'Feature', geometry: { type: 'LineString', coordinates: lane.polyline.map((p) => frame.localToWgs84(p.x, p.y)) }, properties: { Type: 'Lane', Id: sourceLane?.guid ?? rsl, LaneType: lane.laneType, road_id: String(lane.roadId), section_id: lane.section, lane_id: lane.laneId, name: roadNames[String(lane.roadId)] ?? '', ...(lane.speedLimitKph == null ? {} : { SpeedLimit: `${lane.speedLimitKph} km/h` }), source: 'opendrive' } };
  });
  return { signals: collection(signals), mapGeojson: collection([...rawLanes, ...objects]), roadNames, applicability, unresolved, rawLaneCount: rawLanes.length, objectCount: objects.length };
}
