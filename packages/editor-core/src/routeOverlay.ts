import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  LinearFilter,
  SRGBColorSpace,
  type Texture,
  type Raycaster,
} from 'three';
import {
  buildRoute,
  contentHash,
  type RouteSpec,
  type SimActor,
  type SimScenarioInput,
  type SceneTrace,
} from '@uniscenarios/sim-engine';
import type { Interaction, ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import type { LaneIndex } from './laneIndex';

export type RouteMarkerKind = 'turn-left' | 'turn-right' | 'reroute' | 'lane-change' | 'stop' | 'speed-change' | 'near-miss';

export interface RoutePoint { readonly x: number; readonly z: number }
export interface RouteTraceSpan { readonly points: readonly RoutePoint[] }
export interface RouteTimeAnnotation {
  readonly startTimeS: number;
  readonly endTimeS: number;
  readonly label: string;
  readonly point: RoutePoint;
  /** Labels sharing a world-space crossing are vertically stacked, not hidden. */
  readonly stackIndex: number;
  readonly stackCount: number;
}
export interface VehicleRouteOverlay {
  readonly actorId: string;
  readonly actorKind?: 'vehicle' | 'pedestrian';
  readonly ambient: boolean;
  readonly color: string;
  readonly planned: readonly RoutePoint[];
  readonly actual: readonly RoutePoint[];
  /** Exact, gap-preserving native trace geometry. Playback consumes this trace. */
  readonly canonicalSpans?: readonly RouteTraceSpan[];
  /** Exact scenario-time labels sampled from the same native trace. */
  readonly timeAnnotations?: readonly RouteTimeAnnotation[];
  readonly markers: readonly { kind: RouteMarkerKind; point: RoutePoint }[];
  readonly triggerPoint?: RoutePoint;
  readonly triggerRadiusM?: number;
  readonly invalidReason?: string;
}

export interface RouteOverlayOptions {
  readonly showAmbient: boolean;
  readonly showActual: boolean;
  readonly selectedActorIds: ReadonlySet<string>;
  /** In a multi-selection, only the primary actor receives gold emphasis/text. */
  readonly primarySelectedActorId?: string | null;
}

export interface DraftRouteOptions {
  /** Labels for committed points; a trailing cursor preview intentionally has none. */
  readonly timeLabels?: readonly string[];
  readonly selectedPointIndex?: number | null;
  /**
   * A point the author cannot move. On a timed route the 0th point is the actor's own
   * position rather than an independently editable waypoint, so it is drawn as a mark
   * instead of a grab handle. It stays pickable so a click on it can say why.
   */
  readonly pinnedPointIndex?: number | null;
  readonly committedPointCount?: number;
}

export type RouteHeightSampler = (x: number, z: number) => number | null;

const VEHICLE_KINDS = new Set<SimActor['kind']>(['vehicle', 'car', 'truck', 'bus', 'van', 'motorcycle', 'bicycle', 'scooter']);
const PALETTE = ['#55a7ff', '#ff8a65', '#8bd17c', '#d590ef', '#ffd166', '#54d6c4', '#ef6f9b'];
const ROUTE_CACHE_LIMIT = 256;
const routeGeometryCache = new Map<string, readonly RoutePoint[]>();
let dottedOverlayCache = new WeakMap<readonly RoutePoint[], readonly RoutePoint[]>();
let arrowOverlayCache = new WeakMap<readonly RoutePoint[], readonly number[]>();

/** Test/diagnostic hook: route edits add one entry without evicting unrelated actors. */
export function routeGeometryCacheSize(): number { return routeGeometryCache.size; }
export function clearRouteGeometryCache(): void {
  routeGeometryCache.clear();
  dottedOverlayCache = new WeakMap();
  arrowOverlayCache = new WeakMap();
}

/** Stable presentation color when an actor has no authored body color. */
export function routeColor(actorId: string, authored?: string): string {
  if (authored && /^#[0-9a-f]{6}$/i.test(authored)) {
    // Vehicle paint is often charcoal/black. It is a useful identity cue but a
    // one-pixel black route disappears on asphalt, so preserve its hue while
    // lifting it into a high-contrast guide colour.
    const color = new Color(authored);
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    color.setHSL(hsl.h, Math.max(.72, hsl.s), Math.max(.62, hsl.l));
    return `#${color.getHexString()}`;
  }
  let hash = 2166136261;
  for (let i = 0; i < actorId.length; i++) hash = Math.imul(hash ^ actorId.charCodeAt(i), 16777619);
  return PALETTE[(hash >>> 0) % PALETTE.length]!;
}

/** Resolve through the same Route implementation used to construct RuntimeWorld actors. */
export function resolvedRoutePoints(
  spec: RouteSpec,
  index: LaneIndex,
  start?: { readonly laneRsl: string; readonly storageS: number },
): readonly RoutePoint[] {
  const graphDigest = index.stats.xodrSha256 ?? `${index.stats.mapName}:${index.stats.lanes}:${index.stats.segments}`;
  const key = `${graphDigest}:${contentHash(spec)}:${start ? `${start.laneRsl}@${start.storageS.toFixed(3)}` : 'full'}`;
  const cached = routeGeometryCache.get(key);
  if (cached) return cached;
  const built = buildRoute(index.graph, spec);
  if (!built.ok || built.route.lengthM <= 0) return [];
  const points: RoutePoint[] = [];
  const startS = start && spec.kind === 'lanePath' && spec.lanes[0] === start.laneRsl
    ? built.route.sOfLaneStorage(start.laneRsl, start.storageS) ?? 0
    : 0;
  // Two-metre samples retain junction curvature while bounding 32 typical
  // routes to a few thousand vertices. Exact leg boundaries are also sampled.
  const samples = new Set<number>([startS, built.route.lengthM]);
  for (let s = startS + 2; s < built.route.lengthM; s += 2) samples.add(s);
  for (const leg of built.route.legs) {
    if (leg.sStart >= startS) samples.add(leg.sStart);
    if (leg.sStart + leg.lengthM >= startS) samples.add(leg.sStart + leg.lengthM);
  }
  for (const s of [...samples].sort((a, b) => a - b)) {
    const pose = built.route.poseAt(s);
    const x = Object.is(pose.point.x, -0) ? 0 : pose.point.x;
    const rawZ = -pose.point.y;
    points.push({ x, z: Object.is(rawZ, -0) ? 0 : rawZ });
  }
  const stable = Object.freeze(points);
  routeGeometryCache.set(key, stable);
  if (routeGeometryCache.size > ROUTE_CACHE_LIMIT) routeGeometryCache.delete(routeGeometryCache.keys().next().value!);
  return stable;
}

function routePoints(actor: SimActor, index: LaneIndex): readonly RoutePoint[] {
  const laneRef = actor.initial.laneRef;
  return resolvedRoutePoints(actor.behavior.route, index, laneRef
    ? { laneRsl: laneRef.rsl, storageS: laneRef.s }
    : undefined);
}

function canonicalTracePath(actorId: string, trace?: SceneTrace): {
  readonly points: RoutePoint[];
  readonly spans: RouteTraceSpan[];
  readonly annotations: RouteTimeAnnotation[];
} {
  const track = trace?.ticks.actors[actorId];
  if (!track || !trace) return { points: [], spans: [], annotations: [] };
  const out: RoutePoint[] = [];
  const spans: RouteTraceSpan[] = [];
  let span: RoutePoint[] = [];
  for (let i = 0; i < track.x.length; i++) {
    if (track.present[i] === 0) {
      if (span.length) spans.push({ points: span });
      span = [];
      continue;
    }
    const point = { x: track.x[i]!, z: track.z[i]! };
    out.push(point);
    const last = span.at(-1);
    // Keep the exact endpoints while avoiding thousands of zero-length line
    // segments for stopped actors. Time labels retain the unmodified samples.
    if (!last || Math.hypot(last.x - point.x, last.z - point.z) >= .02) span.push(point);
  }
  if (span.length) spans.push({ points: span });
  return { points: out, spans, annotations: timeAnnotationsFromTrace(trace, actorId) };
}

function pointAtScenarioTime(trace: SceneTrace, actorId: string, timeS: number): RoutePoint | null {
  const times = trace.ticks.t;
  const track = trace.ticks.actors[actorId];
  if (!track || times.length === 0 || timeS < times[0]! - 1e-9 || timeS > times.at(-1)! + 1e-9) return null;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (times[mid]! < timeS - 1e-9) lo = mid + 1;
    else hi = mid;
  }
  if (Math.abs(times[lo]! - timeS) <= 1e-9) {
    return track.present[lo] ? { x: track.x[lo]!, z: track.z[lo]! } : null;
  }
  const before = lo - 1;
  if (before < 0 || !track.present[before] || !track.present[lo]) return null;
  const duration = times[lo]! - times[before]!;
  if (duration <= 0) return null;
  const alpha = (timeS - times[before]!) / duration;
  return {
    x: track.x[before]! + (track.x[lo]! - track.x[before]!) * alpha,
    z: track.z[before]! + (track.z[lo]! - track.z[before]!) * alpha,
  };
}

function compactTime(timeS: number): string {
  return Number.isInteger(timeS) ? `${timeS}s` : `${Number(timeS.toFixed(3))}s`;
}

/** Exact absolute-second annotations, interpolated by time rather than tick index. */
export function timeAnnotationsFromTrace(trace: SceneTrace, actorId: string): RouteTimeAnnotation[] {
  const times = trace.ticks.t;
  if (!trace.ticks.actors[actorId] || times.length === 0) return [];
  const requested: Array<{ timeS: number; point: RoutePoint }> = [];
  const firstInteger = Math.ceil(Math.max(0, times[0]!));
  const end = Math.min(trace.header?.clipSeconds ?? times.at(-1)!, times.at(-1)!);
  for (let timeS = firstInteger; timeS <= Math.floor(end + 1e-9); timeS++) {
    const point = pointAtScenarioTime(trace, actorId, timeS);
    if (point) requested.push({ timeS, point });
  }
  // A non-integer final frame is valuable when the authored clip does not end
  // on a whole second, but do not duplicate an integer end marker.
  if (Math.abs(end - Math.round(end)) > 1e-6) {
    const point = pointAtScenarioTime(trace, actorId, end);
    if (point) requested.push({ timeS: end, point });
  }

  // Consecutive labels occupying essentially the same position describe a
  // stop. Collapse them into a readable range instead of painting a pile.
  const grouped: Array<Omit<RouteTimeAnnotation, 'stackIndex' | 'stackCount'>> = [];
  for (const item of requested) {
    const previous = grouped.at(-1);
    if (previous
      && Math.abs(item.timeS - previous.endTimeS - 1) <= 1e-6
      && Math.hypot(item.point.x - previous.point.x, item.point.z - previous.point.z) < .3) {
      grouped[grouped.length - 1] = {
        ...previous,
        endTimeS: item.timeS,
        label: `${compactTime(previous.startTimeS).replace(/s$/, '')}–${compactTime(item.timeS)}`,
      };
    } else {
      grouped.push({ startTimeS: item.timeS, endTimeS: item.timeS, label: compactTime(item.timeS), point: item.point });
    }
  }

  // Preserve distinct times at self-intersections by stacking them vertically.
  const clusters: number[][] = [];
  for (let i = 0; i < grouped.length; i++) {
    const cluster = clusters.find((indices) => {
      const anchor = grouped[indices[0]!]!.point;
      return Math.hypot(anchor.x - grouped[i]!.point.x, anchor.z - grouped[i]!.point.z) < .7;
    });
    if (cluster) cluster.push(i); else clusters.push([i]);
  }
  const stack = new Map<number, { index: number; count: number }>();
  for (const indices of clusters) indices.forEach((item, index) => stack.set(item, { index, count: indices.length }));
  return grouped.map((annotation, index) => ({
    ...annotation,
    stackIndex: stack.get(index)?.index ?? 0,
    stackCount: stack.get(index)?.count ?? 1,
  }));
}

function turnMarkers(points: readonly RoutePoint[]): Array<{ kind: RouteMarkerKind; point: RoutePoint }> {
  const result: Array<{ kind: RouteMarkerKind; point: RoutePoint }> = [];
  for (let i = 2; i < points.length - 2; i++) {
    const before = points[i - 2]!;
    const at = points[i]!;
    const after = points[i + 2]!;
    const a = Math.atan2(at.z - before.z, at.x - before.x);
    const b = Math.atan2(after.z - at.z, after.x - at.x);
    const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
    if (Math.abs(delta) < Math.PI / 5) continue;
    if (result.at(-1) && Math.hypot(result.at(-1)!.point.x - at.x, result.at(-1)!.point.z - at.z) < 10) continue;
    result.push({ kind: delta < 0 ? 'turn-left' : 'turn-right', point: at });
  }
  return result;
}

function actionMarkers(actorId: string, interactions: readonly SimScenarioInput['interactions'][number][], trace?: SceneTrace) {
  const track = trace?.ticks.actors[actorId];
  if (!track || !trace) return [];
  const result: Array<{ kind: RouteMarkerKind; point: RoutePoint }> = [];
  for (const action of interactions) {
    if (action.actorId !== actorId || (action.verb !== 'speed' && action.verb !== 'changeLane')) continue;
    const fired = trace.events.find((event) => 'interactionId' in event && event.interactionId === action.id);
    const triggerTime = fired?.t ?? (action.trigger.kind === 'at' ? action.trigger.t : null);
    if (triggerTime === null) continue;
    let tick = 0;
    while (tick + 1 < trace.ticks.t.length && trace.ticks.t[tick + 1]! <= triggerTime) tick++;
    const kind: RouteMarkerKind = action.verb === 'changeLane'
      ? 'lane-change'
      : action.target.mode === 'stop' ? 'stop' : 'speed-change';
    result.push({ kind, point: { x: track.x[tick]!, z: track.z[tick]! } });
  }
  return result;
}

function authoredTimedRouteAnnotations(
  actor: SimActor,
  interactions: readonly SimScenarioInput['interactions'][number][],
): RouteTimeAnnotation[] {
  const interactionPoints = interactions.flatMap((interaction) =>
    interaction.actorId === actor.id
      && interaction.verb === 'route'
      && interaction.target.kind === 'timedPolyline'
      ? interaction.target.points
      : []);
  const points = interactionPoints.length
    ? interactionPoints
    : actor.behavior.route.kind === 'timedPolyline' ? actor.behavior.route.points : [];
  const clusterIndices = new Map<string, number[]>();
  points.forEach((point, index) => {
    const key = `${point.x.toFixed(3)},${point.z.toFixed(3)}`;
    const cluster = clusterIndices.get(key);
    if (cluster) cluster.push(index); else clusterIndices.set(key, [index]);
  });
  const stack = new Map<number, { index: number; count: number }>();
  for (const indices of clusterIndices.values()) {
    indices.forEach((pointIndex, stackIndex) => stack.set(pointIndex, { index: stackIndex, count: indices.length }));
  }
  return points.map((point, index) => ({
    startTimeS: point.timeS,
    endTimeS: point.timeS,
    label: compactTime(point.timeS),
    point: { x: point.x, z: point.z },
    stackIndex: stack.get(index)?.index ?? 0,
    stackCount: stack.get(index)?.count ?? 1,
  }));
}

/** Build overlays from the exact concrete simulator input. Static actors and pedestrians are excluded. */
export function routesFromSimulation(
  input: Pick<SimScenarioInput, 'actors' | 'interactions' | 'nearMissCriteria'>,
  index: LaneIndex,
  trace?: SceneTrace,
  authoredColors: ReadonlyMap<string, string | undefined> = new Map(),
): VehicleRouteOverlay[] {
  return [...input.actors]
    .filter((actor) => !actor.static && (VEHICLE_KINDS.has(actor.kind) || actor.kind === 'pedestrian'))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((actor) => {
      const planned = routePoints(actor, index);
      const canonical = canonicalTracePath(actor.id, trace);
      const authoredTimedAnnotations = authoredTimedRouteAnnotations(actor, input.interactions);
      const actual = canonical.points;
      const nearMiss = input.nearMissCriteria?.find((criterion) => criterion.pedestrianId === actor.id);
      let nearMissPoint: RoutePoint | undefined;
      if (nearMiss && trace) {
        let tick = 0;
        while (tick + 1 < trace.ticks.t.length && trace.ticks.t[tick + 1]! <= nearMiss.predictedClosestApproachS) tick++;
        const track = trace.ticks.actors[actor.id];
        if (track?.present[tick]) nearMissPoint = { x: track.x[tick]!, z: track.z[tick]! };
      }
      const ambient = actor.id.startsWith('ambient-') || actor.tags.some((tag) => tag === 'ambient' || tag.startsWith('ambient:'));
      return {
        actorId: actor.id,
        actorKind: actor.kind === 'pedestrian' ? 'pedestrian' as const : 'vehicle' as const,
        ambient,
        color: routeColor(actor.id, authoredColors.get(actor.id)),
        planned,
        actual,
        ...(canonical.spans.length ? {
          canonicalSpans: canonical.spans,
          timeAnnotations: authoredTimedAnnotations.length ? authoredTimedAnnotations : canonical.annotations,
        } : {}),
        markers: [...turnMarkers(planned), ...actionMarkers(actor.id, input.interactions, trace)],
        ...(nearMissPoint && nearMiss ? { triggerPoint: nearMissPoint, triggerRadiusM: nearMiss.clearanceM } : {}),
      };
    })
    .filter((route) => route.planned.length > 1 || route.actual.length > 1);
}

export interface RouteExecutionParity {
  readonly ok: boolean;
  readonly authoredHash: string;
  readonly compiledHash: string;
  readonly mismatches: readonly string[];
}

/**
 * Fail-closed contract between the persisted authoring plan and the concrete
 * simulator input installed by Play. It deliberately covers only map-bound
 * route-bearing geometry; appearance, ambient population and signal-engine
 * choices cannot change this hash.
 */
export function routeExecutionParity(
  template: ScenarioTemplateV2,
  input: Pick<SimScenarioInput, 'actors' | 'interactions'>,
): RouteExecutionParity {
  const routeRoles = template.roles
    .flatMap((role) => role.kind === 'scene_absolute' && role.initialRoute?.lanes.length ? [role] : [])
    .sort((a, b) => a.id.localeCompare(b.id));
  const canonicalAuthoredInteraction = (interaction: Interaction): unknown | null => {
    if (interaction.verb === 'route' && interaction.target.mode === 'lanePath') {
      return { id: interaction.id, verb: 'route', lanes: interaction.target.lanes };
    }
    if (interaction.verb === 'changeLane') {
      const target = interaction.target.mode === 'relative'
        ? { mode: interaction.target.dk > 0 ? 'left' : 'right', count: Math.abs(interaction.target.dk) }
        : interaction.target.mode === 'absolute'
          ? { mode: 'lane' }
          : { mode: 'actorLane', actorId: interaction.target.role };
      return { id: interaction.id, verb: 'changeLane', target };
    }
    if (interaction.verb === 'laneOffset') {
      return { id: interaction.id, verb: 'laneOffset', target: { mode: 'fraction', value: interaction.target.tFrac } };
    }
    return null;
  };
  const authored = routeRoles.map((role) => ({
    id: role.id,
    initialRoute: role.initialRoute!.lanes,
    interactions: template.choreography.interactions
      .filter((interaction) => interaction.actor === role.id)
      .map(canonicalAuthoredInteraction)
      .filter((interaction) => interaction !== null),
  }));
  const canonicalCompiledInteraction = (interaction: SimScenarioInput['interactions'][number]): unknown | null => {
    if (interaction.verb === 'route' && interaction.target.kind === 'lanePath') {
      return { id: interaction.id, verb: 'route', lanes: interaction.target.lanes };
    }
    if (interaction.verb === 'changeLane') {
      const target = interaction.target.mode === 'lane'
        ? { mode: 'lane' }
        : interaction.target.mode === 'actorLane'
          ? { mode: 'actorLane', actorId: interaction.target.actorId }
          : { mode: interaction.target.mode, count: interaction.target.count };
      return { id: interaction.id, verb: 'changeLane', target };
    }
    if (interaction.verb === 'laneOffset') {
      return { id: interaction.id, verb: 'laneOffset', target: interaction.target };
    }
    return null;
  };
  const compiled = routeRoles.map((role) => {
    const actor = input.actors.find((candidate) => candidate.id === role.id);
    return {
      id: role.id,
      initialRoute: actor?.behavior.route.kind === 'lanePath' ? actor.behavior.route.lanes : null,
      interactions: input.interactions
        .filter((interaction) => interaction.actorId === role.id)
        .map(canonicalCompiledInteraction)
        .filter((interaction) => interaction !== null),
    };
  });
  const mismatches = authored.flatMap((plan, index) =>
    contentHash(plan) === contentHash(compiled[index]) ? [] : [plan.id]);
  return {
    ok: mismatches.length === 0,
    authoredHash: contentHash(authored),
    compiledHash: contentHash(compiled),
    mismatches,
  };
}

/**
 * Canonical authoring overlay. While a new document revision is compiling,
 * return no behavioral trajectory. Once complete, both the preview line and
 * Play are driven by the exact same native fixed-step samples.
 */
export function authoringRoutes(
  template: ScenarioTemplateV2,
  index: LaneIndex,
  concrete?: Pick<SimScenarioInput, 'actors' | 'interactions' | 'nearMissCriteria'>,
  trace?: SceneTrace,
): VehicleRouteOverlay[] {
  const traceComplete = Boolean(trace && (trace.ticks.t.at(-1) ?? -Infinity) >= (trace.header?.clipSeconds ?? Infinity) - 1e-9);
  if (!concrete || !trace || !traceComplete) return [];
  const authoredColors = new Map(template.roles.map((role) => [
    role.id,
    typeof role.extensions?.['studio.presentation.bodyColor'] === 'string'
      ? role.extensions['studio.presentation.bodyColor'] as string
      : undefined,
  ]));
  return routesFromSimulation(concrete, index, trace, authoredColors).map((route) => {
    const customRoute = template.choreography.interactions.find((interaction) =>
      interaction.actor === route.actorId &&
      interaction.verb === 'route' &&
      (interaction.target.mode === 'customRoute' || interaction.target.mode === 'customTimedRoute'),
    );
    const customRoutePoints = customRoute?.verb === 'route' &&
      (customRoute.target.mode === 'customRoute' || customRoute.target.mode === 'customTimedRoute')
      ? customRoute.target.points.map((point) => ({ x: point.x, z: point.z }))
      : null;
    return {
      ...route,
      planned: customRoutePoints ?? route.actual,
    };
  });
}

/**
 * Visual-only authored geometry for placement/edit affordances before the
 * current document revision has a complete deterministic trace.
 *
 * Playback must use {@link authoringRoutes}; this compatibility projection is
 * intentionally limited to editor guides.
 */
export function routesFromTemplate(
  template: ScenarioTemplateV2,
  index: LaneIndex,
): VehicleRouteOverlay[] {
  return template.roles.flatMap((role) => {
    if (
      role.actor.static
      || role.actor.class === 'pedestrian'
      || role.actor.class === 'static_object'
    ) return [];
    const lanes = role.kind === 'scene_absolute' ? role.initialRoute?.lanes : undefined;
    if (!lanes?.length) return [];
    const planned = resolvedRoutePoints(
      { kind: 'lanePath', lanes },
      index,
      role.kind === 'scene_absolute' && role.laneRef
        ? {
          laneRsl: `${role.laneRef.roadId}:${role.laneRef.section}:${role.laneRef.laneId}`,
          storageS: role.laneRef.s,
        }
        : undefined,
    );
    if (planned.length < 2) return [];
    const authoredColor = role.extensions?.['studio.presentation.bodyColor'];
    return [{
      actorId: role.id,
      actorKind: 'vehicle' as const,
      ambient: false,
      color: routeColor(
        role.id,
        typeof authoredColor === 'string' ? authoredColor : undefined,
      ),
      planned,
      actual: [],
      markers: turnMarkers(planned),
    }];
  }).sort((a, b) => a.actorId.localeCompare(b.actorId));
}

/** Backwards-compatible name for callers outside the editor shell. */
export const routesForAuthoringPreview = authoringRoutes;

function pushSegment(target: number[], a: RoutePoint, b: RoutePoint, y: number): void {
  target.push(a.x, y, a.z, b.x, y, b.z);
}

/** Converts a polyline into fixed-world-length dashes, independent of source sampling density. */
export function dashedSegments(points: readonly RoutePoint[], dashM = 2.2, gapM = 1.4): number[] {
  const out: number[] = [];
  let phase = 0;
  let drawing = true;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-5) continue;
    let cursor = 0;
    while (cursor < length) {
      const remaining = (drawing ? dashM : gapM) - phase;
      const end = Math.min(length, cursor + remaining);
      if (drawing) pushSegment(out,
        { x: a.x + (b.x - a.x) * cursor / length, z: a.z + (b.z - a.z) * cursor / length },
        { x: a.x + (b.x - a.x) * end / length, z: a.z + (b.z - a.z) * end / length }, 0);
      phase += end - cursor;
      cursor = end;
      if (phase >= (drawing ? dashM : gapM) - 1e-6) { drawing = !drawing; phase = 0; }
    }
  }
  return out;
}

/** Fixed-world-spacing route dots, stable across source sampling density. */
export function dottedPoints(points: readonly RoutePoint[], spacingM = 1.8): RoutePoint[] {
  if (points.length === 0) return [];
  const out: RoutePoint[] = [points[0]!];
  let carried = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (length < 1e-5) continue;
    let at = spacingM - carried;
    while (at <= length + 1e-6) {
      const t = Math.min(1, at / length);
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      at += spacingM;
    }
    carried = (carried + length) % spacingM;
  }
  const last = points.at(-1)!;
  if (Math.hypot(out.at(-1)!.x - last.x, out.at(-1)!.z - last.z) > spacingM * .45) out.push(last);
  return out;
}

function appendArrows(target: number[], points: readonly RoutePoint[], y: number): void {
  let travelled = 0;
  // Put the first arrow close enough to a newly placed actor to be visible
  // when it is framed, then repeat frequently enough to communicate direction.
  let next = 6;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    while (travelled + length >= next && length > 0) {
      const t = (next - travelled) / length;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const ux = (b.x - a.x) / length;
      const uz = (b.z - a.z) / length;
      const tip = { x: x + ux * 1.1, z: z + uz * 1.1 };
      pushSegment(target, tip, { x: x - ux * .65 - uz * .7, z: z - uz * .65 + ux * .7 }, y);
      pushSegment(target, tip, { x: x - ux * .65 + uz * .7, z: z - uz * .65 - ux * .7 }, y);
      next += 16;
    }
    travelled += length;
  }
}

function cachedDottedPoints(points: readonly RoutePoint[]): readonly RoutePoint[] {
  const cached = dottedOverlayCache.get(points);
  if (cached) return cached;
  const dotted = dottedPoints(points);
  dottedOverlayCache.set(points, dotted);
  return dotted;
}

function cachedArrowSegments(points: readonly RoutePoint[]): readonly number[] {
  const cached = arrowOverlayCache.get(points);
  if (cached) return cached;
  const arrows: number[] = [];
  appendArrows(arrows, points, 0);
  arrowOverlayCache.set(points, arrows);
  return arrows;
}

export class VehicleRouteOverlayRenderer {
  readonly group = new Group();
  private objects: Array<LineSegments | Points | Sprite> = [];
  private draftObjects: Array<LineSegments | Mesh | Points | Sprite> = [];
  private draftPointHandles: Mesh[] = [];
  private textures: Texture[] = [];
  private draftTextures: Texture[] = [];
  private draftRoute: readonly RoutePoint[] | null = null;
  private draftTimeLabels: readonly string[] = [];
  private draftSelectedPointIndex: number | null = null;
  private draftPinnedPointIndex: number | null = null;
  private draftCommittedPointCount = 0;
  private labelGeneration = 0;

  constructor(private readonly sampleHeight?: RouteHeightSampler) {
    this.group.name = 'vehicle-route-overlays';
    this.group.renderOrder = 20;
  }

  sync(routes: readonly VehicleRouteOverlay[], options: RouteOverlayOptions): void {
    const labelGeneration = ++this.labelGeneration;
    this.clear();
    const visible = routes.filter((route) => !route.ambient || options.showAmbient);
    const primarySelectedActorId = options.primarySelectedActorId
      ?? visible.find((route) => options.selectedActorIds.has(route.actorId))?.actorId
      ?? null;
    // One dot batch and one arrow batch for all paths. Selection is encoded in
    // vertex colour so adding actors never adds draw calls.
    const plannedPositions: number[] = [];
    const plannedColors: number[] = [];
    const pedestrianPositions: number[] = [];
    const pedestrianColors: number[] = [];
    const arrowPositions: number[] = [];
    const arrowColors: number[] = [];
    const selectedPositions: number[] = [];
    const selectedColors: number[] = [];
    for (const route of visible) {
      const selected = options.selectedActorIds.has(route.actorId);
      const primary = route.actorId === primarySelectedActorId;
      const color = new Color(route.invalidReason ? '#ff5568' : route.color).multiplyScalar(selected ? .86 : .32);
      const spans = route.canonicalSpans ?? [{ points: route.planned }];
      if (primary && route.canonicalSpans?.length) {
        const gold = new Color('#ffc857');
        for (const traceSpan of route.canonicalSpans) {
          for (let i = 1; i < traceSpan.points.length; i++) {
            const a = traceSpan.points[i - 1]!;
            const b = traceSpan.points[i]!;
            const ay = (this.sampleHeight?.(a.x, a.z) ?? 0) + .48;
            const by = (this.sampleHeight?.(b.x, b.z) ?? 0) + .48;
            selectedPositions.push(a.x, ay, a.z, b.x, by, b.z);
            selectedColors.push(gold.r, gold.g, gold.b, gold.r, gold.g, gold.b);
          }
        }
        continue;
      }
      if (route.actorKind === 'pedestrian') {
        for (const traceSpan of spans) {
          const segments = dashedSegments(traceSpan.points, 1.1, .65);
          for (let i = 0; i < segments.length; i += 3) {
            const x = segments[i]!; const z = segments[i + 2]!;
            pedestrianPositions.push(x, (this.sampleHeight?.(x, z) ?? 0) + (selected ? .46 : .34), z);
            pedestrianColors.push(color.r, color.g, color.b);
          }
        }
      } else for (const traceSpan of spans) for (const point of cachedDottedPoints(traceSpan.points)) {
          plannedPositions.push(point.x, (this.sampleHeight?.(point.x, point.z) ?? 0) + (selected ? .38 : .27), point.z);
          plannedColors.push(color.r, color.g, color.b);
        }
      for (const traceSpan of spans) {
        const arrows = cachedArrowSegments(traceSpan.points);
        for (let i = 0; i < arrows.length; i += 3) {
          const x = arrows[i]!;
          const z = arrows[i + 2]!;
          arrowPositions.push(x, (this.sampleHeight?.(x, z) ?? 0) + (selected ? .4 : .29), z);
          arrowColors.push(color.r, color.g, color.b);
        }
      }
    }
    if (selectedPositions.length) {
      const black = new Color('#17120a');
      const haloColors = new Array<number>(selectedPositions.length);
      for (let index = 0; index < haloColors.length; index += 3) {
        haloColors[index] = black.r;
        haloColors[index + 1] = black.g;
        haloColors[index + 2] = black.b;
      }
      this.addLines(selectedPositions, haloColors, .82, 'selected-route-halo', 5, 28);
      this.addLines(selectedPositions, selectedColors, 1, 'selected-route-gold', 2.5, 29);
    }
    if (pedestrianPositions.length) this.addLines(pedestrianPositions, pedestrianColors, .98, 'pedestrian-projected-paths');
    if (plannedPositions.length) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(Float32Array.from(plannedPositions), 3));
      geometry.setAttribute('color', new BufferAttribute(Float32Array.from(plannedColors), 3));
      geometry.computeBoundingSphere();
      const points = new Points(geometry, new PointsMaterial({ size: .48, vertexColors: true, transparent: true, opacity: .98, depthTest: false, depthWrite: false, sizeAttenuation: true }));
      points.name = 'planned-route-dots';
      points.renderOrder = 21;
      points.raycast = () => undefined;
      this.group.add(points); this.objects.push(points);
    }
    if (arrowPositions.length) this.addLines(arrowPositions, arrowColors, .98, 'planned-route-arrows');
    if (options.showActual) {
      const positions: number[] = [];
      const colors: number[] = [];
      for (const route of visible) {
        const color = new Color(route.color);
        const actualSpans = route.canonicalSpans ?? [{ points: route.actual }];
        for (const traceSpan of actualSpans) {
          for (let i = 1; i < traceSpan.points.length; i++) {
            const a = traceSpan.points[i - 1]!;
            const b = traceSpan.points[i]!;
            positions.push(
              a.x, (this.sampleHeight?.(a.x, a.z) ?? 0) + .38, a.z,
              b.x, (this.sampleHeight?.(b.x, b.z) ?? 0) + .38, b.z,
            );
            colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
          }
        }
      }
      if (positions.length) this.addLines(positions, colors, .9);
    }
    const markerPositions: number[] = [];
    const markerColors: number[] = [];
    for (const route of visible) for (const marker of route.markers) {
      markerPositions.push(marker.point.x, (this.sampleHeight?.(marker.point.x, marker.point.z) ?? 0) + .52, marker.point.z);
      const color = marker.kind === 'stop' ? new Color('#ff4d5a') : marker.kind === 'speed-change' ? new Color('#ffd166') : new Color(route.color);
      markerColors.push(color.r, color.g, color.b);
    }
    if (markerPositions.length) {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(Float32Array.from(markerPositions), 3));
      geometry.setAttribute('color', new BufferAttribute(Float32Array.from(markerColors), 3));
      const points = new Points(geometry, new PointsMaterial({ size: .9, vertexColors: true, transparent: true, opacity: 1, depthTest: false, depthWrite: false, sizeAttenuation: true }));
      points.name = 'route-action-markers';
      points.renderOrder = 23;
      points.frustumCulled = true;
      points.raycast = () => undefined;
      this.group.add(points); this.objects.push(points);
    }
    const triggerPositions: number[] = [];
    const triggerColors: number[] = [];
    for (const route of visible) {
      if (!route.triggerPoint) continue;
      const color = new Color(route.invalidReason ? '#ff5568' : '#ffe08a');
      const radius = Math.max(.5, route.triggerRadiusM ?? .65);
      const steps = Math.max(16, Math.min(64, Math.ceil(radius * 3)));
      for (let i = 0; i < steps; i++) {
        const a = i / steps * Math.PI * 2; const b = (i + 1) / steps * Math.PI * 2;
        for (const angle of [a, b]) {
          const x = route.triggerPoint.x + Math.cos(angle) * radius;
          const z = route.triggerPoint.z + Math.sin(angle) * radius;
          triggerPositions.push(x, (this.sampleHeight?.(x, z) ?? 0) + .32, z);
          triggerColors.push(color.r, color.g, color.b);
        }
      }
    }
    if (triggerPositions.length) this.addLines(triggerPositions, triggerColors, .82, 'pedestrian-trigger-envelopes');

    const selectedRoute = visible.find((route) => route.actorId === primarySelectedActorId);
    if (selectedRoute?.canonicalSpans?.length) {
      const annotations = selectedRoute.timeAnnotations ?? [];
      // Canvas-backed labels are presentation detail, not selection geometry.
      // Defer their texture work so selecting a full trace stays inside the
      // interaction frame; a newer sync or disposal invalidates the task.
      queueMicrotask(() => {
        if (this.labelGeneration !== labelGeneration) return;
        for (const annotation of annotations) this.addTimeLabel(annotation);
      });
    }
  }

  /** Show the exact in-progress points captured by the custom-route map tool. */
  setDraftRoute(points: readonly RoutePoint[] | null, options: DraftRouteOptions = {}): void {
    this.clearDraftRoute();
    this.draftRoute = points ? [...points] : null;
    this.draftTimeLabels = points ? [...(options.timeLabels ?? [])] : [];
    this.draftSelectedPointIndex = options.selectedPointIndex ?? null;
    this.draftPinnedPointIndex = options.pinnedPointIndex ?? null;
    this.draftCommittedPointCount = points ? Math.min(points.length, options.committedPointCount ?? points.length) : 0;
    this.renderDraftRoute();
  }

  /** Pick an individually editable 3D waypoint handle. */
  draftPointIndexAt(raycaster: Raycaster): number | null {
    const hit = raycaster.intersectObjects(this.draftPointHandles, false)[0];
    return typeof hit?.object.userData.routePointIndex === 'number'
      ? hit.object.userData.routePointIndex
      : null;
  }

  dispose(): void {
    this.labelGeneration += 1;
    this.clear();
    this.clearDraftRoute();
    this.group.removeFromParent();
  }

  private addLines(
    positions: number[],
    colors: number[],
    opacity: number,
    name = 'route-lines',
    linewidth = 1,
    renderOrder = opacity > .9 ? 22 : 21,
    collection: Array<LineSegments | Mesh | Points | Sprite> = this.objects,
  ): void {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
    geometry.setAttribute('color', new BufferAttribute(Float32Array.from(colors), 3));
    geometry.computeBoundingSphere();
    const lines = new LineSegments(geometry, new LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthTest: false, depthWrite: false, linewidth }));
    lines.name = name;
    lines.renderOrder = renderOrder;
    lines.frustumCulled = true;
    lines.raycast = () => undefined;
    this.group.add(lines); collection.push(lines);
  }

  private renderDraftRoute(): void {
    const points = this.draftRoute;
    if (!points?.length) return;
    const gold = new Color('#E8E044');
    const positions: number[] = [];
    const colors: number[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]!;
      const b = points[index]!;
      positions.push(
        a.x, (this.sampleHeight?.(a.x, a.z) ?? 0) + .62, a.z,
        b.x, (this.sampleHeight?.(b.x, b.z) ?? 0) + .62, b.z,
      );
      colors.push(gold.r, gold.g, gold.b, gold.r, gold.g, gold.b);
    }
    if (positions.length) this.addLines(positions, colors, 1, 'custom-route-draft', 3, 34, this.draftObjects);
    const pointPositions = points.flatMap((point) => [
      point.x,
      (this.sampleHeight?.(point.x, point.z) ?? 0) + .68,
      point.z,
    ]);
    const pointColors = points.flatMap(() => [gold.r, gold.g, gold.b]);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(Float32Array.from(pointPositions), 3));
    geometry.setAttribute('color', new BufferAttribute(Float32Array.from(pointColors), 3));
    // Half the original .95. These sit on the ground the author is aiming at,
    // so at the zoom used to place a point accurately the old dots covered the
    // spot being picked.
    const markers = new Points(geometry, new PointsMaterial({ size: .475, vertexColors: true, depthTest: false, depthWrite: false }));
    markers.name = 'custom-route-waypoints';
    markers.renderOrder = 35;
    markers.raycast = () => undefined;
    this.group.add(markers);
    this.draftObjects.push(markers);
    points.slice(0, this.draftCommittedPointCount).forEach((point, index) => {
      const pinned = index === this.draftPinnedPointIndex;
      const selected = !pinned && index === this.draftSelectedPointIndex;
      // Half of .48/.36, matching the dots above so the grab handle stays the
      // same size as the mark it belongs to. A pinned point is drawn smaller and
      // duller than any handle: it is the actor's position showing through, and an
      // identical sphere that refuses to drag reads as a broken handle.
      const geometry = new SphereGeometry(pinned ? .12 : selected ? .24 : .18, 16, 10);
      const material = new MeshBasicMaterial({ color: pinned ? '#8f8a3c' : selected ? '#ffffff' : '#E8E044', depthTest: false, depthWrite: false });
      const handle = new Mesh(geometry, material);
      handle.position.set(point.x, (this.sampleHeight?.(point.x, point.z) ?? 0) + .72, point.z);
      handle.name = index === 0 ? 'custom-route-waypoints-3d' : 'custom-route-waypoint-3d';
      handle.renderOrder = 37;
      handle.userData.routePointIndex = index;
      this.group.add(handle);
      this.draftObjects.push(handle);
      this.draftPointHandles.push(handle);
    });
    for (let index = 0; index < Math.min(points.length, this.draftTimeLabels.length); index += 1) {
      const label = this.draftTimeLabels[index]!;
      // A point inside a wait carries an empty label: the run is labelled once,
      // on its last point. Rendering the blanks would stack invisible sprites
      // on the marker the author is trying to see past.
      if (!label) continue;
      this.addTimeLabel({
        startTimeS: 0,
        endTimeS: 0,
        label,
        point: points[index]!,
        stackIndex: 0,
        stackCount: 1,
      }, {
        name: 'custom-route-time-label',
        renderOrder: 36,
        objects: this.draftObjects,
        textures: this.draftTextures,
      });
    }
  }

  private clearDraftRoute(): void {
    for (const object of this.draftObjects) {
      object.removeFromParent();
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    }
    this.draftObjects = [];
    this.draftPointHandles = [];
    for (const texture of this.draftTextures) texture.dispose();
    this.draftTextures = [];
    this.draftTimeLabels = [];
    this.draftSelectedPointIndex = null;
    this.draftPinnedPointIndex = null;
    this.draftCommittedPointCount = 0;
  }

  private addTimeLabel(
    annotation: RouteTimeAnnotation,
    destination: {
      readonly name: string;
      readonly renderOrder: number;
      readonly objects: Array<LineSegments | Mesh | Points | Sprite>;
      readonly textures: Texture[];
    } = {
      name: 'selected-route-time-label',
      renderOrder: 31 + annotation.stackIndex,
      objects: this.objects,
      textures: this.textures,
    },
  ): void {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(15, 13, 10, .88)';
    context.strokeStyle = '#ffc857';
    context.lineWidth = 5;
    context.beginPath();
    context.roundRect(7, 7, 242, 82, 22);
    context.fill();
    context.stroke();
    context.font = '700 42px ui-sans-serif, system-ui, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.strokeStyle = 'rgba(0, 0, 0, .95)';
    context.lineWidth = 9;
    context.strokeText(annotation.label, 128, 50);
    context.fillStyle = '#ffe19a';
    context.fillText(annotation.label, 128, 50);
    const texture = new CanvasTexture(canvas);
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    const material = new SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new Sprite(material);
    const baseY = (this.sampleHeight?.(annotation.point.x, annotation.point.z) ?? 0) + 1.25;
    sprite.position.set(annotation.point.x, baseY + annotation.stackIndex * .62, annotation.point.z);
    sprite.scale.set(2.35, .88, 1);
    sprite.name = destination.name;
    sprite.renderOrder = destination.renderOrder;
    sprite.frustumCulled = true;
    sprite.userData.routeTimeAnnotation = annotation;
    sprite.raycast = () => undefined;
    this.group.add(sprite);
    destination.objects.push(sprite);
    destination.textures.push(texture);
  }

  private clear(): void {
    for (const object of this.objects) {
      object.removeFromParent(); object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    }
    this.objects = [];
    for (const texture of this.textures) texture.dispose();
    this.textures = [];
  }
}
