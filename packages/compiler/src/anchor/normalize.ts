/**
 * The **normalizer seam** with `packages/maps`.
 *
 * `map-intel` is being built in a parallel lane and emits
 * `dev-assets/<map>/derived/topology-derived.json`. Rather than couple to a
 * moving import, this module accepts *any* object that carries the derived
 * facts and adapts it onto {@link DerivedMapIndex}:
 *
 * - lanes/gates/junctions are adopted (with a polyline-order sniff, so it does
 *   not matter whether the producer stores OpenDRIVE-`s` or travel order);
 * - `segments`, `junctionDescriptors` (incl. `conflictPairs`) and `factIndex`
 *   are adopted **when present and well-formed**, and re-derived from the lane
 *   graph otherwise;
 * - `crossings` / `parkingZones` become {@link PointFeature}s and flip the
 *   corresponding capability flags.
 *
 * The result is that the matcher runs identically on map-intel output and on a
 * self-derived index, and the only thing that changes is
 * `provenance.source`.
 */

import { buildFactIndex, deriveMapIndexFromTopology, relationFromHeadings } from './derive.js';
import type { RawSearchIndex, RawTopologyIndex, RawTopologyLane } from './derive.js';
import { dist, headingAtS, projectPoint } from './geometry.js';
import { DERIVED_INDEX_CONTRACT_VERSION } from './version.js';
import type {
  ConflictPair,
  DerivedMapIndex,
  JunctionDescriptor,
  LaneRsl,
  Point2,
  PointFeature,
  Segment,
} from './types/map-index.js';
import type { JunctionControl } from './types/anchor.js';

interface AnyRecord {
  [key: string]: unknown;
}

const isRecord = (v: unknown): v is AnyRecord => typeof v === 'object' && v !== null;

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.keys(value).sort().map((k) => value[k]);
  return [];
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function points(value: unknown): Point2[] {
  if (!Array.isArray(value)) return [];
  const out: Point2[] = [];
  for (const p of value) {
    if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
      out.push({ x: p[0], y: p[1] });
    } else if (isRecord(p) && typeof p['x'] === 'number' && typeof p['y'] === 'number') {
      out.push({ x: p['x'], y: p['y'] });
    }
  }
  return out;
}

/**
 * Sniff whether lane polylines are stored in OpenDRIVE `s` order (the raw
 * topology index) or already in travel order (a producer that normalized).
 *
 * Test: under the `s`-order hypothesis a positive-id lane must be reversed for
 * its travel end to meet its gate's connecting lane. Score both hypotheses over
 * the gates that involve a positive-id lane and take the winner.
 */
export function detectPolylineOrder(
  lanes: Record<string, { laneId: number; polyline: Point2[] }>,
  gates: Array<{ approachLaneRsl: string; connectingLaneRsl: string }>,
): 'odr' | 'travel' {
  let odrScore = 0;
  let travelScore = 0;
  for (const gate of gates) {
    const a = lanes[gate.approachLaneRsl];
    const b = lanes[gate.connectingLaneRsl];
    if (!a || !b || a.polyline.length < 2 || b.polyline.length < 2) continue;
    if (a.laneId <= 0 && b.laneId <= 0) continue; // uninformative
    const odrA = a.laneId > 0 ? [...a.polyline].reverse() : a.polyline;
    const odrB = b.laneId > 0 ? [...b.polyline].reverse() : b.polyline;
    const odrGap = dist(odrA[odrA.length - 1] as Point2, odrB[0] as Point2);
    const travelGap = dist(a.polyline[a.polyline.length - 1] as Point2, b.polyline[0] as Point2);
    if (odrGap < travelGap) odrScore += 1;
    else if (travelGap < odrGap) travelScore += 1;
  }
  return travelScore > odrScore ? 'travel' : 'odr';
}

const CONTROL_ALIASES: Record<string, JunctionControl> = {
  signalized: 'signalized',
  signal: 'signalized',
  traffic_light: 'signalized',
  trafficLight: 'signalized',
  all_way_stop: 'all_way_stop',
  allWayStop: 'all_way_stop',
  four_way_stop: 'all_way_stop',
  minor_stop: 'minor_stop',
  stop: 'minor_stop',
  two_way_stop: 'minor_stop',
  yield: 'yield',
  give_way: 'yield',
  uncontrolled: 'uncontrolled',
  none: 'uncontrolled',
  roundabout: 'roundabout',
};

export function normalizeControl(value: unknown): JunctionControl | 'unknown' {
  if (typeof value !== 'string') return 'unknown';
  return CONTROL_ALIASES[value] ?? 'unknown';
}

function adoptConflictPairs(value: unknown): ConflictPair[] | null {
  const arr = Array.isArray(value) ? value : null;
  if (!arr) return null;
  const out: ConflictPair[] = [];
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const gateA = str(item['gateA'] ?? item['a'] ?? item['fromGate'], '');
    const gateB = str(item['gateB'] ?? item['b'] ?? item['toGate'], '');
    if (!gateA || !gateB) continue;
    // map-intel emits `pointXY: [x, y]` and `crossingAngleRad`; earlier drafts
    // of the contract used `point: {x, y}` and degrees. Accept both.
    const pt = isRecord(item['point']) ? (item['point'] as AnyRecord) : {};
    const xy = Array.isArray(item['pointXY']) ? (item['pointXY'] as unknown[]) : null;
    const angleDeg =
      typeof item['crossingAngleRad'] === 'number'
        ? (item['crossingAngleRad'] * 180) / Math.PI
        : num(item['crossingAngleDeg'] ?? item['angleDeg'], 90);
    out.push({
      gateA,
      gateB,
      point: xy
        ? { x: num(xy[0], 0), y: num(xy[1], 0) }
        : { x: num(pt['x'], 0), y: num(pt['y'], 0) },
      sOnA: num(item['sOnA'], 0),
      sOnB: num(item['sOnB'], 0),
      crossingAngleDeg: angleDeg,
      relation: ((): ConflictPair['relation'] => {
        const r = str(item['relation'], 'merge');
        if (r === 'opposing' || r === 'from_left' || r === 'from_right' || r === 'merge') return r;
        if (r === 'left') return 'from_left';
        if (r === 'right') return 'from_right';
        // map-intel's vocabulary for a converging movement.
        if (r === 'same_dir_merge') return 'merge';
        return 'merge';
      })(),
    });
  }
  out.sort((a, b) => (a.gateA === b.gateA ? (a.gateB < b.gateB ? -1 : 1) : a.gateA < b.gateA ? -1 : 1));
  return out;
}

/** True when an object under `junctions` is a *descriptor*, not the raw spine. */
function looksLikeDescriptor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    'conflictPairs' in value ||
    'control' in value ||
    'armCount' in value ||
    'approaches' in value
  );
}

/**
 * Location-catalog entries (`locations.json`) that the matcher can bind roles
 * to. Only the four kinds with a lane anchor are consumed; everything else in
 * the catalog is the studio's business, not the matcher's.
 */
const LOCATION_KIND_MAP: Record<string, PointFeature['kind']> = {
  crosswalk: 'crossing',
  crossing: 'crossing',
  parking_space: 'parking_zone',
  parking_area: 'parking_zone',
  parking_lane: 'parking_zone',
  bus_stop: 'bus_stop',
  driveway: 'driveway',
  school_zone: 'school_zone',
  work_zone_suitable: 'work_zone_suitable',
  occlusion_zone: 'occlusion_zone',
};

/**
 * Keep the facts a clause can actually evaluate.
 *
 * Scalars pass through. Arrays of strings pass through **as arrays** — the
 * previous filter silently deleted them, which is why the
 * `supported_scenario_templates` whitelist on all 275 occlusion zones was
 * invisible to the matcher. Anything else (nested objects, mixed arrays) is
 * still dropped: there is no clause vocabulary for it.
 */
export function normalizeFacts(input: unknown): Record<string, string | number | boolean | readonly string[]> | undefined {
  if (!isRecord(input)) return undefined;
  const out: Record<string, string | number | boolean | readonly string[]> = {};
  for (const [key, value] of Object.entries(input as AnyRecord)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
      out[key] = value as string[];
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The location type a `crest` point feature is derived from.
 *
 * map-intel does not publish a `crest` location kind; it publishes a
 * `crest_present: true` fact on the driving corridor that carries the brow.
 * That is the whole of the evidence, so that is exactly the condition. There is
 * no `sag` counterpart in the fact vocabulary, so no `sag` kind is derived.
 */
const CREST_SOURCE_TYPE = 'driving_corridor';

/** Adapt `locations.json` into {@link PointFeature}s (crossings, parking, …). */
export function pointFeaturesFromLocations(locations: unknown): PointFeature[] {
  const out: PointFeature[] = [];
  for (const item of asArray(locations)) {
    if (!isRecord(item)) continue;
    const facts = normalizeFacts(item['facts']);
    const type = str(item['type'], '');
    const kind: PointFeature['kind'] | undefined =
      LOCATION_KIND_MAP[type] ??
      (type === CREST_SOURCE_TYPE && facts?.['crest_present'] === true ? 'crest' : undefined);
    if (!kind) continue;
    const anchor = isRecord(item['anchor']) ? (item['anchor'] as AnyRecord) : {};
    const road = isRecord(anchor['road']) ? (anchor['road'] as AnyRecord) : {};
    const laneRsl = str(road['rsl'], '');
    if (!laneRsl) continue;
    const offset = num(road['offsetM'], 0);
    const extent = isRecord(item['extent']) ? item['extent'] as AnyRecord : undefined;
    const radiusM = extent ? num(extent['radiusM'], Number.NaN) : Number.NaN;
    const enrichedFacts = {
      ...(facts ?? {}),
      ...(kind === 'crossing' && Number.isFinite(radiusM) && radiusM > 0 && facts?.['crossing_length_m'] === undefined
        ? { crossing_length_m: radiusM * 2 }
        : {}),
      // A parking zone's contiguous length: the measured fact when map-intel
      // has one, otherwise the zone's own extent. Without this a `lengthM`
      // clause is unanswerable on 155 of the 176 parking lanes.
      ...(kind === 'parking_zone' && Number.isFinite(radiusM) && radiusM > 0 &&
        facts?.['parking_length_m'] === undefined && facts?.['length_m'] === undefined
        ? { parking_extent_length_m: radiusM * 2 }
        : {}),
      ...(kind === 'parking_zone' && typeof item['subtype'] === 'string' && facts?.['parking_orientation'] === undefined
        ? { parking_orientation: item['subtype'] }
        : {}),
    };
    out.push({
      id: str(item['id'], `${kind}:${laneRsl}`),
      kind,
      laneRsl,
      s: num(road['s'], 0),
      ...(sceneAnchorPoint(item as AnyRecord) ? { point: sceneAnchorPoint(item as AnyRecord) } : {}),
      side: offset > 0 ? 'left' : offset < 0 ? 'right' : 'both',
      ...(typeof road['junctionId'] === 'string' ? { junctionId: road['junctionId'] } : {}),
      ...(Object.keys(enrichedFacts).length > 0 ? { facts: enrichedFacts } : {}),
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function sceneAnchorPoint(item: AnyRecord): PointFeature['point'] | undefined {
  const anchor = isRecord(item['anchor']) ? (item['anchor'] as AnyRecord) : {};
  const scene = isRecord(anchor['scene']) ? (anchor['scene'] as AnyRecord) : {};
  const x = num(scene['x'], Number.NaN);
  const z = num(scene['z'], Number.NaN);
  return Number.isFinite(x) && Number.isFinite(z) ? { x, y: -z } : undefined;
}

function pointFromRecord(item: AnyRecord): PointFeature['point'] | undefined {
  const point = isRecord(item['point']) ? (item['point'] as AnyRecord) : item;
  const x = num(point['x'], Number.NaN);
  const y = num(point['y'], Number.NaN);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function adoptPointFeatures(input: AnyRecord): PointFeature[] {
  const out: PointFeature[] = [];
  const push = (kind: PointFeature['kind'], items: unknown[]): void => {
    for (const item of items) {
      if (!isRecord(item)) continue;
      const laneRsl = str(item['laneRsl'] ?? item['rsl'], '');
      if (!laneRsl) continue;
      const side = str(item['side'], '');
      const facts = normalizeFacts(item['facts']);
      out.push({
        id: str(item['id'], `${kind}:${laneRsl}@${num(item['s'], 0).toFixed(1)}`),
        kind,
        laneRsl,
        s: num(item['s'], 0),
        ...(pointFromRecord(item) ? { point: pointFromRecord(item) } : {}),
        ...(side === 'left' || side === 'right' || side === 'both' ? { side } : {}),
        ...(typeof item['junctionId'] === 'string' ? { junctionId: item['junctionId'] } : {}),
        ...(facts && Object.keys(facts).length > 0 ? { facts } : {}),
      });
    }
  };
  push('crossing', asArray(input['crossings']));
  push('parking_zone', asArray(input['parkingZones'] ?? input['parking_zones']));
  push('bus_stop', asArray(input['busStops'] ?? input['bus_stops']));
  push('driveway', asArray(input['driveways']));
  push('school_zone', asArray(input['schoolZones'] ?? input['school_zones']));
  push('work_zone_suitable', asArray(input['workZones'] ?? input['work_zones']));
  push('occlusion_zone', asArray(input['occlusionZones'] ?? input['occlusion_zones']));
  push('crest', asArray(input['crests']));
  const explicit = asArray(input['pointFeatures']);
  for (const item of explicit) {
    if (!isRecord(item)) continue;
    const kind = str(item['kind'], '');
    if (kind === 'crossing' || kind === 'parking_zone' || kind === 'bus_stop' || kind === 'driveway' || kind === 'school_zone' || kind === 'work_zone_suitable' || kind === 'occlusion_zone' || kind === 'crest') {
      push(kind, [item]);
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

export interface NormalizeOptions {
  mapId?: string;
  searchIndex?: RawSearchIndex;
  handedness?: 'right' | 'left';
  /**
   * The lane/gate spine. map-intel's `topology-derived.json` carries only the
   * *derived* layers (segments, junction descriptors, fact index) and leaves
   * lanes and gates in `topology-index.json`, so both files are needed.
   */
  topology?: RawTopologyIndex;
  /** `locations.json` — supplies crossings, parking zones and bus stops. */
  locations?: unknown;
}

/**
 * Adapt an external derived index (or a raw topology index) onto
 * {@link DerivedMapIndex}.
 *
 * Never throws on unknown extra keys — a sibling adding fields must not break
 * this lane.
 */
export function normalizeDerivedMapIndex(
  input: unknown,
  options: NormalizeOptions = {},
): DerivedMapIndex {
  if (!isRecord(input)) throw new TypeError('derived map index must be an object');

  const topology = options.topology;
  const lanesIn = isRecord(input['lanes'])
    ? (input['lanes'] as Record<string, unknown>)
    : ((topology?.lanes ?? {}) as unknown as Record<string, unknown>);
  const gatesIn = Array.isArray(input['gates'])
    ? (input['gates'] as unknown[])
    : ((topology?.gates ?? []) as unknown[]);
  // `junctions` is overloaded across producers: the raw index keys the *spine*
  // by id, map-intel emits an array of *descriptors*. Route each to its slot.
  const junctionsField = input['junctions'];
  const junctionsAreDescriptors =
    Array.isArray(junctionsField) ||
    (isRecord(junctionsField) &&
      Object.values(junctionsField).some((v) => looksLikeDescriptor(v)));
  const junctionsIn: Record<string, unknown> = junctionsAreDescriptors
    ? ((topology?.junctions ?? {}) as unknown as Record<string, unknown>)
    : isRecord(junctionsField)
      ? (junctionsField as Record<string, unknown>)
      : ((topology?.junctions ?? {}) as unknown as Record<string, unknown>);

  // --- lanes -------------------------------------------------------------
  const rawLanes: Record<string, RawTopologyLane> = {};
  for (const rsl of Object.keys(lanesIn).sort()) {
    const lane = lanesIn[rsl];
    if (!isRecord(lane)) continue;
    const adj = isRecord(lane['adjacentLanes']) ? (lane['adjacentLanes'] as AnyRecord) : {};
    const sideRef = (key: string): { laneRsl: string | null; sameDirection: boolean } => {
      const ref = isRecord(adj[key]) ? (adj[key] as AnyRecord) : {};
      const value = ref['laneRsl'];
      return {
        laneRsl: typeof value === 'string' ? value : null,
        sameDirection: ref['sameDirection'] === true,
      };
    };
    const [roadIdRaw, sectionRaw, laneIdRaw] = rsl.split(':');
    rawLanes[rsl] = {
      rsl,
      roadId: num(lane['roadId'], Number(roadIdRaw ?? 0)),
      section: num(lane['section'], Number(sectionRaw ?? 0)),
      laneId: num(lane['laneId'], Number(laneIdRaw ?? 0)),
      laneType: str(lane['laneType'], 'driving'),
      isJunction: lane['isJunction'] === true || typeof lane['junctionId'] === 'string',
      junctionId: typeof lane['junctionId'] === 'string' ? lane['junctionId'] : null,
      predecessors: asArray(lane['predecessors']).filter((v): v is string => typeof v === 'string'),
      successors: asArray(lane['successors']).filter((v): v is string => typeof v === 'string'),
      speedLimitKph: num(lane['speedLimitKph'], 50),
      representativeWidthM: num(lane['representativeWidthM'] ?? lane['widthM'], 3.5),
      widthSamples: asArray(lane['widthSamples'])
        .filter(isRecord)
        .map((w) => ({ s: num(w['s'], 0), widthM: num(w['widthM'] ?? w['width'], 3.5) })),
      adjacentLanes: { left: sideRef('left'), right: sideRef('right') },
      laneChangePermissions: asArray(lane['laneChangePermissions'])
        .filter(isRecord)
        .map((p) => ({
          side: p['side'] === 'left' ? ('left' as const) : ('right' as const),
          startS: num(p['startS'], 0),
          endS: num(p['endS'], 0),
          allowed: p['allowed'] !== false,
        })),
      polyline: points(lane['polyline'] ?? lane['centerline']),
    };
  }

  // --- gates -------------------------------------------------------------
  const rawGates: RawTopologyIndex['gates'] = [];
  for (const gate of gatesIn) {
    if (!isRecord(gate)) continue;
    const approach = str(gate['approachLaneRsl'] ?? gate['approachLane'], '');
    const connecting = str(gate['connectingLaneRsl'] ?? gate['connectingLane'], '');
    if (!approach || !connecting) continue;
    rawGates.push({
      id: str(gate['id'], `${approach}->${connecting}`),
      junctionId: str(gate['junctionId'], ''),
      turnRelation: str(gate['turnRelation'] ?? gate['turn'], 'Straight'),
      headingChangeRad: num(gate['headingChangeRad'], 0),
      connectingLaneRsl: connecting,
      approachLaneRsl: approach,
      exitLaneRsls: asArray(gate['exitLaneRsls'] ?? gate['exitLanes']).filter(
        (v): v is string => typeof v === 'string',
      ),
    });
  }

  // Polyline-order sniff: flip travel-ordered input back to `s` order so the
  // shared derivation sees exactly one convention.
  const order = detectPolylineOrder(rawLanes, rawGates);
  if (order === 'travel') {
    for (const lane of Object.values(rawLanes)) {
      if (lane.laneId > 0) lane.polyline = [...lane.polyline].reverse();
    }
  }

  // --- junctions ---------------------------------------------------------
  const rawJunctions: RawTopologyIndex['junctions'] = {};
  for (const id of Object.keys(junctionsIn).sort()) {
    const j = junctionsIn[id];
    if (!isRecord(j)) continue;
    rawJunctions[id] = {
      junctionId: str(j['junctionId'], id),
      gateIds: asArray(j['gateIds']).filter((v): v is string => typeof v === 'string'),
      internalLaneRsls: asArray(j['internalLaneRsls'] ?? j['internalLanes']).filter(
        (v): v is string => typeof v === 'string',
      ),
      approachLaneRsls: asArray(j['approachLaneRsls'] ?? j['approachLanes']).filter(
        (v): v is string => typeof v === 'string',
      ),
    };
  }
  // Some producers omit the junction table and keep everything on descriptors.
  if (Object.keys(rawJunctions).length === 0) {
    for (const gate of rawGates) {
      if (!gate.junctionId) continue;
      const entry = (rawJunctions[gate.junctionId] ??= {
        junctionId: gate.junctionId,
        gateIds: [],
        internalLaneRsls: [],
        approachLaneRsls: [],
      });
      entry.gateIds.push(gate.id);
      entry.internalLaneRsls.push(gate.connectingLaneRsl);
      entry.approachLaneRsls.push(gate.approachLaneRsl);
    }
  }

  const source = isRecord(input['source']) ? (input['source'] as AnyRecord) : {};
  const base = deriveMapIndexFromTopology(
    {
      schemaVersion: num(input['schemaVersion'], 0),
      mapName: typeof input['mapName'] === 'string' ? input['mapName'] : undefined,
      source: { xodrSha256: typeof source['xodrSha256'] === 'string' ? source['xodrSha256'] : undefined },
      lanes: rawLanes,
      gates: rawGates,
      junctions: rawJunctions,
    },
    {
      mapId: options.mapId ?? str(input['mapId'] ?? input['mapName'], 'unknown-map'),
      ...(options.searchIndex ? { searchIndex: options.searchIndex } : {}),
      ...(options.handedness ? { handedness: options.handedness } : {}),
      ...(typeof input['topologyDigest'] === 'string'
        ? { topologyDigest: input['topologyDigest'] }
        : {}),
    },
  );

  // --- adopt the producer's derived layers where they exist --------------
  const notes = [...base.provenance.notes];
  let adopted = false;
  let junctionCrossingLayer = false;
  let armCountDisagreements = 0;
  let relationDisagreements = 0;
  let arcLengthChecks = 0;
  let arcLengthDisagreements = 0;
  let conflictPairsAdopted = 0;
  const gateById = new Map(base.gates.map((g) => [g.id, g]));

  const descriptorsIn = input['junctionDescriptors'] ?? (junctionsAreDescriptors ? junctionsField : undefined);
  const descriptorList = Array.isArray(descriptorsIn)
    ? descriptorsIn
    : isRecord(descriptorsIn)
      ? Object.keys(descriptorsIn).sort().map((k) => (descriptorsIn as AnyRecord)[k])
      : [];
  for (const d of descriptorList) {
    if (!isRecord(d)) continue;
    const id = str(d['junctionId'] ?? d['id'], '');
    const existing: JunctionDescriptor | undefined = base.junctionDescriptors[id];
    if (!existing) continue;
    adopted = true;
    // Adopt what the producer has *more evidence* for than we do — junction
    // control comes from signal heads and phase timing, which we cannot see —
    // and keep what is purely geometric.
    const control = normalizeControl(d['control'] ?? d['controlType']);
    if (control !== 'unknown') existing.control = control;

    // `arms` **is** adopted now. It used not to be: map-intel reported 6-7 arms
    // at Yale's big El Camino junctions where outward-leg clustering says 4, so
    // adopting it failed every `arms: [4, 4]` clause at exactly the junctions
    // the worked example is about. That is fixed upstream — measured over all
    // five dev maps the two derivations now agree at 235/246 junctions, and the
    // residue is 1-vs-2 arms on degenerate stubs, never a 4-way. The producer
    // has road names and outward-leg evidence we do not, so it wins; every
    // disagreement is still counted into `provenance.notes`.
    if (typeof d['armCount'] === 'number') {
      if (d['armCount'] !== existing.arms) armCountDisagreements += 1;
      existing.arms = d['armCount'];
    }

    const pairs = adoptConflictPairs(d['conflictPairs'] ?? d['conflicts']);
    if (pairs && pairs.length > 0) {
      // `relation` and the two arc lengths are **adopted**, and verified rather
      // than recomputed.
      //
      // Both used to be re-derived here, for good reasons that no longer hold:
      // map-intel measured `s` along OpenDRIVE `s` (wrong end of every
      // positive-id connecting lane) and labelled relations with a different
      // convention. Both are fixed upstream, and the fix is measurable:
      // over all five dev maps, 2559/2559 relation labels agree with
      // `relationFromHeadings`, and 5118/5118 arc lengths reproject to within
      // 1 mm. What is *not* adopted from the old path is the local
      // `crossingAngleDeg <= 30 → merge` override, which was relabelling 32-42 %
      // of pairs per map — including genuine opposing conflicts at skew
      // junctions, which is precisely the movement a left-turn-across-oncoming
      // template needs.
      //
      // The verification stays because adoption without it is trust. Relations
      // are checked on every pair (two heading lookups); arc lengths are
      // checked on a deterministic 1-in-16 sample, which is enough to catch a
      // convention flip and cheap enough to run on every load.
      existing.conflictPairs = pairs;
      conflictPairsAdopted += pairs.length;
      for (let i = 0; i < pairs.length; i += 1) {
        const pair = pairs[i] as ConflictPair;
        const approachA = base.lanes[gateById.get(pair.gateA)?.approachLaneRsl ?? ''];
        const approachB = base.lanes[gateById.get(pair.gateB)?.approachLaneRsl ?? ''];
        if (approachA && approachB) {
          const expected = relationFromHeadings(
            headingAtS(approachA.polyline, approachA.lengthM),
            headingAtS(approachB.polyline, approachB.lengthM),
          );
          if (expected !== pair.relation) relationDisagreements += 1;
        }
        if (i % 16 === 0) {
          for (const [gateId, s] of [
            [pair.gateA, pair.sOnA],
            [pair.gateB, pair.sOnB],
          ] as Array<[string, number]>) {
            const lane = base.lanes[gateById.get(gateId)?.connectingLaneRsl ?? ''];
            if (!lane || lane.polyline.length < 2) continue;
            arcLengthChecks += 1;
            if (Math.abs(projectPoint(lane.polyline, pair.point).s - s) > 1) {
              arcLengthDisagreements += 1;
            }
          }
        }
      }
    }
    const crossings = d['crossingsByApproach'];
    if (isRecord(crossings)) {
      const map: Record<string, string[]> = {};
      for (const key of Object.keys(crossings).sort()) {
        map[key] = asArray(crossings[key]).filter((v): v is string => typeof v === 'string');
      }
      existing.crossingsByApproach = map;
    } else if (Array.isArray(d['crossingLocationIds'])) {
      // map-intel knows crossings per junction, not per approach. Keep them
      // under a whole-junction key: enough for `hasCrossingOnLeg`, and honest
      // about not knowing which leg.
      junctionCrossingLayer = true;
      const ids = asArray(d['crossingLocationIds']).filter((v): v is string => typeof v === 'string');
      existing.crossingsByApproach = ids.length > 0 ? { '*': ids } : {};
    }
  }
  if (adopted) notes.push('adopted junctionDescriptors from the external index');
  if (conflictPairsAdopted > 0) {
    notes.push(
      `adopted ${conflictPairsAdopted} conflict pair(s); ${relationDisagreements} relation label(s) and ${arcLengthDisagreements}/${arcLengthChecks} sampled arc length(s) disagreed with the local derivation`,
    );
  }
  // A handful of edge cases is normal; a large fraction means the two packages
  // have drifted apart on a *convention*, which silently unbinds whole
  // scenario families. Say so loudly rather than scoring it away.
  if (relationDisagreements > 0.05 * Math.max(1, conflictPairsAdopted)) {
    notes.push(
      `WARNING: ${((100 * relationDisagreements) / Math.max(1, conflictPairsAdopted)).toFixed(1)} % of adopted conflict relations disagree with this package's geometry — the producers have drifted on the approach-relation convention`,
    );
  }
  if (arcLengthDisagreements > 0) {
    notes.push(
      `WARNING: ${arcLengthDisagreements} sampled conflict arc length(s) are more than 1 m from their reprojection — the producers may have drifted on polyline ordering`,
    );
  }
  if (armCountDisagreements > 0) {
    notes.push(
      `adopted the external arm count at ${armCountDisagreements} junction(s) where the local derivation disagreed`,
    );
  }

  // --- segments ----------------------------------------------------------
  // Adopting these matters beyond convenience: a corridor-anchored `siteId`
  // includes the segment id, so re-deriving our own ids would desynchronise
  // stored bindings from the production catalog.
  const segmentsIn = asArray(input['segments']).filter(isRecord);
  const adoptedSegments: Segment[] = [];
  for (const s of segmentsIn) {
    const laneRsls = asArray(s['laneRsls'] ?? s['laneRefs']).filter(
      (v): v is string => typeof v === 'string',
    );
    if (laneRsls.length === 0) continue;
    const id = str(s['id'], `seg:${laneRsls[0]}`);
    const adjacent: string[] = [];
    if (s['hasParkingAdjacent'] === true) adjacent.push('parking');
    if (s['hasBikeAdjacent'] === true) adjacent.push('biking');
    if (s['hasSidewalkAdjacent'] === true) adjacent.push('sidewalk');
    if (s['hasShoulderAdjacent'] === true) adjacent.push('shoulder');
    if (s['hasMedianAdjacent'] === true) adjacent.push('median');
    if (s['isOneWay'] === false) adjacent.push('opposing');
    const profile = asArray(s['profile'])
      .filter(isRecord)
      .map((p) => ({
        s: num(p['s'], 0),
        laneRsl: str(p['laneRsl'], laneRsls[0] as string),
        throughLanesSameDir: num(p['throughLanesSameDir'] ?? p['lanesSameDir'], 1),
        throughLanesOpposing: num(p['throughLanesOpposing'] ?? p['lanesOpposing'], 0),
        laneWidthM: num(p['laneWidthM'], 3.5),
        speedLimitKph: num(p['speedLimitKph'], 50),
        curvatureDegPer10m: num(p['curvatureDegPer10m'], 0),
        adjacentKinds: adjacent.sort(),
      }));
    const counts = profile.map((p) => p.throughLanesSameDir);
    const speeds = profile.map((p) => p.speedLimitKph);
    adoptedSegments.push({
      id,
      laneRsls,
      lengthM: num(s['lengthM'], 0),
      profile,
      entryJunctionId: typeof s['entryJunctionId'] === 'string' ? s['entryJunctionId'] : null,
      exitJunctionId: typeof s['exitJunctionId'] === 'string' ? s['exitJunctionId'] : null,
      minThroughLanesSameDir: num(
        s['minThroughLanesSameDir'] ?? s['minLanesSameDir'],
        counts.length ? Math.min(...counts) : 1,
      ),
      maxThroughLanesSameDir: num(
        s['maxThroughLanesSameDir'] ?? s['maxLanesSameDir'],
        counts.length ? Math.max(...counts) : 1,
      ),
      minSpeedLimitKph: num(s['minSpeedLimitKph'], speeds.length ? Math.min(...speeds) : 0),
      maxSpeedLimitKph: num(s['maxSpeedLimitKph'], speeds.length ? Math.max(...speeds) : 0),
    });
  }
  adoptedSegments.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const segments = adoptedSegments.length > 0 ? adoptedSegments : base.segments;
  if (adoptedSegments.length > 0) {
    adopted = true;
    notes.push(`adopted ${adoptedSegments.length} segments from the external index`);
  }

  const pointFeatures = [
    ...adoptPointFeatures(input),
    ...(options.locations === undefined
      ? []
      : pointFeaturesFromLocations(
          isRecord(options.locations) && 'locations' in options.locations
            ? (options.locations as AnyRecord)['locations']
            : options.locations,
        )),
  ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const pointFeaturesByKind: Record<string, string[]> = {};
  for (const pf of pointFeatures) (pointFeaturesByKind[pf.kind] ??= []).push(pf.id);

  const hasCrossings =
    pointFeatures.some((p) => p.kind === 'crossing') ||
    junctionCrossingLayer ||
    Object.values(base.junctionDescriptors).some(
      (d) => Object.keys(d.crossingsByApproach).length > 0,
    );

  // The fact index has to be rebuilt over the *adopted* facts: candidate
  // generation keys off junction control and lane counts, and adopting a better
  // control layer while querying the old index would silently lose junctions.
  const factIndex = buildFactIndex(base.lanes, base.junctionDescriptors, segments);

  return {
    ...base,
    segments,
    pointFeatures,
    factIndex: { ...factIndex, pointFeaturesByKind },
    capabilities: {
      ...base.capabilities,
      crossings: hasCrossings,
      parkingZones: pointFeatures.some((p) => p.kind === 'parking_zone'),
      workZones: pointFeatures.some((p) => p.kind === 'work_zone_suitable'),
      occlusionZones: pointFeatures.some((p) => p.kind === 'occlusion_zone'),
      junctionControl: Object.values(base.junctionDescriptors).some((d) => d.control !== 'unknown'),
    },
    provenance: {
      source: adopted ? 'map-intel' : 'self-derived',
      contractVersion: DERIVED_INDEX_CONTRACT_VERSION,
      notes: [...notes, `polyline order detected: ${order}`],
    },
  };
}

/** Convenience: is this object a raw `topology-index.json` payload? */
export function looksLikeRawTopologyIndex(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return isRecord(input['lanes']) && Array.isArray(input['gates']) && isRecord(input['junctions']);
}

export { headingAtS };
