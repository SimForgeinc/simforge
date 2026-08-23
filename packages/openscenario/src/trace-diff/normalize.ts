import { contentHash, type SimTrace } from '@simforge/engine';
import {
  COMMON_DURATION_S,
  COMMON_SAMPLE_HZ,
  type EntityMappingOptions,
  type EntityMappingResult,
  type FrameTransform,
  type NormalizedActorTrack,
  type NormalizedTrace,
  type ObservableCollision,
  type ObservableEpisodeMetrics,
  type ObservableEvent,
  type ObservableSignalState,
  type RawExternalTrace,
  type RawTraceEntity,
  type RawTraceSample,
} from './types.js';

const EPS = 1e-9;

export function commonTimeline(): number[] {
  return Array.from({ length: COMMON_DURATION_S * COMMON_SAMPLE_HZ + 1 }, (_, i) => i / COMMON_SAMPLE_HZ);
}

export function wrapHeadingRad(value: number): number {
  let wrapped = (value + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) wrapped += 2 * Math.PI;
  return wrapped - Math.PI;
}

export function headingDeltaRad(a: number, b: number): number {
  return wrapHeadingRad(a - b);
}

function normalizedName(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '');
}

export function mapEntities(
  canonicalIds: readonly string[],
  externalEntities: readonly Pick<RawTraceEntity, 'id' | 'name'>[],
  options: EntityMappingOptions = {},
): EntityMappingResult {
  const canonical = [...new Set(canonicalIds)].sort();
  const external = [...externalEntities].sort((a, b) => a.id.localeCompare(b.id));
  const usedCanonical = new Set<string>();
  const entries: Array<EntityMappingResult['entries'][number]> = [];
  const ambiguous = new Set<string>();
  const aliases = new Map<string, string[]>();
  for (const id of canonical) {
    for (const alias of options.aliases?.[id] ?? []) {
      const key = normalizedName(alias);
      aliases.set(key, [...(aliases.get(key) ?? []), id]);
    }
  }
  for (const entity of external) {
    const explicit = options.explicit?.[entity.id];
    if (explicit !== undefined) {
      if (!canonical.includes(explicit) || usedCanonical.has(explicit)) {
        ambiguous.add(entity.id);
      } else {
        entries.push({ canonicalId: explicit, externalId: entity.id, basis: 'explicit' });
        usedCanonical.add(explicit);
      }
      continue;
    }
    if (canonical.includes(entity.id) && !usedCanonical.has(entity.id)) {
      entries.push({ canonicalId: entity.id, externalId: entity.id, basis: 'exact-id' });
      usedCanonical.add(entity.id);
      continue;
    }
    const candidates = new Set<string>();
    for (const token of [entity.id, entity.name].filter((v): v is string => Boolean(v))) {
      for (const id of aliases.get(normalizedName(token)) ?? []) if (!usedCanonical.has(id)) candidates.add(id);
    }
    if (candidates.size === 1) {
      const id = [...candidates][0]!;
      entries.push({ canonicalId: id, externalId: entity.id, basis: 'unique-alias' });
      usedCanonical.add(id);
      continue;
    }
    if (candidates.size > 1) {
      ambiguous.add(entity.id);
      continue;
    }
    const normalizedCandidates = canonical.filter((id) =>
      !usedCanonical.has(id)
      && [entity.id, entity.name].some((value) => value !== undefined && normalizedName(value) === normalizedName(id)),
    );
    if (normalizedCandidates.length === 1) {
      const id = normalizedCandidates[0]!;
      entries.push({ canonicalId: id, externalId: entity.id, basis: 'unique-normalized-name' });
      usedCanonical.add(id);
    } else if (normalizedCandidates.length > 1) {
      ambiguous.add(entity.id);
    }
  }
  const mappedExternal = new Set(entries.map((entry) => entry.externalId));
  return {
    entries: entries.sort((a, b) => a.canonicalId.localeCompare(b.canonicalId)),
    missingCanonicalIds: canonical.filter((id) => !usedCanonical.has(id)),
    extraExternalIds: external.map((entity) => entity.id).filter((id) => !mappedExternal.has(id) && !ambiguous.has(id)),
    ambiguousExternalIds: [...ambiguous].sort(),
  };
}

function transformed(sample: RawTraceSample, transform: FrameTransform, timeOffsetS: number): RawTraceSample {
  const scale = transform.scale ?? 1;
  const cos = Math.cos(transform.rotationRad);
  const sin = Math.sin(transform.rotationRad);
  const sx = sample.x * scale;
  const sy = sample.y * scale;
  return {
    ...sample,
    t: sample.t + timeOffsetS,
    x: sx * cos - sy * sin + transform.translationM[0],
    y: sx * sin + sy * cos + transform.translationM[1],
    z: (sample.z ?? 0) * scale + (transform.translationM[2] ?? 0),
    headingRad: wrapHeadingRad(sample.headingRad + transform.rotationRad),
    ...(sample.speedMps === undefined ? {} : { speedMps: sample.speedMps * Math.abs(scale) }),
    ...(sample.accelerationMps2 === undefined ? {} : { accelerationMps2: sample.accelerationMps2 * Math.abs(scale) }),
  };
}

function interpolateNumber(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function nullableNumber(a: number | null | undefined, b: number | null | undefined, alpha: number): number | null {
  if (a == null || b == null) return a ?? b ?? null;
  return interpolateNumber(a, b, alpha);
}

function sampleEntity(entity: RawTraceEntity, transform: FrameTransform, timeOffsetS: number): NormalizedActorTrack {
  const samples = entity.samples
    .map((sample) => transformed(sample, transform, timeOffsetS))
    .sort((a, b) => a.t - b.t);
  if (samples.length === 0) throw new Error(`Trace entity ${entity.id} has no samples`);
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.t - samples[i - 1]!.t <= EPS) throw new Error(`Trace entity ${entity.id} timestamps are not strictly increasing`);
  }
  const t = commonTimeline();
  const x: number[] = [], y: number[] = [], z: number[] = [], headingRad: number[] = [];
  const speedMps: number[] = [], accelerationMps2: number[] = [];
  const roadId: (string | null)[] = [], laneId: (string | null)[] = [], laneRsl: (string | null)[] = [];
  const s: (number | null)[] = [], offsetM: (number | null)[] = [], present: boolean[] = [];
  let upper = 0;
  for (const tick of t) {
    while (upper < samples.length && samples[upper]!.t < tick - EPS) upper++;
    const after = samples[Math.min(upper, samples.length - 1)]!;
    const before = samples[Math.max(0, Math.min(upper - 1, samples.length - 1))]!;
    const inside = tick >= samples[0]!.t - EPS && tick <= samples[samples.length - 1]!.t + EPS;
    const span = after.t - before.t;
    const alpha = span > EPS ? Math.max(0, Math.min(1, (tick - before.t) / span)) : 0;
    const nearest = alpha < 0.5 ? before : after;
    x.push(interpolateNumber(before.x, after.x, alpha));
    y.push(interpolateNumber(before.y, after.y, alpha));
    z.push(interpolateNumber(before.z ?? 0, after.z ?? 0, alpha));
    headingRad.push(wrapHeadingRad(before.headingRad + headingDeltaRad(after.headingRad, before.headingRad) * alpha));
    speedMps.push(nullableNumber(before.speedMps, after.speedMps, alpha) ?? Number.NaN);
    accelerationMps2.push(nullableNumber(before.accelerationMps2, after.accelerationMps2, alpha) ?? Number.NaN);
    roadId.push(nearest.roadId ?? null);
    laneId.push(nearest.laneId ?? null);
    laneRsl.push(nearest.laneRsl ?? null);
    s.push(nullableNumber(before.s, after.s, alpha));
    offsetM.push(nullableNumber(before.offsetM, after.offsetM, alpha));
    present.push(inside && (nearest.present ?? true));
  }
  fillDerived(speedMps, x, y, t);
  fillDerived(accelerationMps2, speedMps, undefined, t);
  return { x, y, z, headingRad, speedMps, accelerationMps2, roadId, laneId, laneRsl, s, offsetM, present };
}

function fillDerived(target: number[], a: number[], b: number[] | undefined, t: number[]): void {
  for (let i = 0; i < target.length; i++) {
    if (Number.isFinite(target[i])) continue;
    const lo = Math.max(0, i - 1);
    const hi = Math.min(target.length - 1, i + 1);
    const dt = t[hi]! - t[lo]!;
    target[i] = dt <= EPS ? 0 : b
      ? Math.hypot(a[hi]! - a[lo]!, b[hi]! - b[lo]!) / dt
      : (a[hi]! - a[lo]!) / dt;
  }
}

function normalizeEvents(events: readonly ObservableEvent[], mapping: ReadonlyMap<string, string>, offset: number): ObservableEvent[] {
  return events.map((event) => ({
    ...event,
    t: event.t + offset,
    actorIds: event.actorIds.map((id) => mapping.get(id) ?? id).sort(),
  })).filter((event) => event.t >= -EPS && event.t <= COMMON_DURATION_S + EPS)
    .sort((a, b) => a.t - b.t || a.kind.localeCompare(b.kind) || a.actorIds.join('|').localeCompare(b.actorIds.join('|')));
}

function normalizeCollisions(collisions: readonly ObservableCollision[], mapping: ReadonlyMap<string, string>, offset: number): ObservableCollision[] {
  return collisions.map((collision) => ({
    t: collision.t + offset,
    actorIds: collision.actorIds.map((id) => mapping.get(id) ?? id).sort() as [string, string],
  })).filter((event) => event.t >= -EPS && event.t <= COMMON_DURATION_S + EPS)
    .sort((a, b) => a.t - b.t || a.actorIds.join('|').localeCompare(b.actorIds.join('|')));
}

function normalizeSignals(signals: readonly ObservableSignalState[], offset: number): ObservableSignalState[] {
  return signals.map((signal) => ({ ...signal, t: signal.t + offset }))
    .filter((signal) => signal.t >= -EPS && signal.t <= COMMON_DURATION_S + EPS)
    .sort((a, b) => a.t - b.t || a.signalId.localeCompare(b.signalId) || a.state.localeCompare(b.state));
}

function finishTrace(base: Omit<NormalizedTrace, 'contentHash'>): NormalizedTrace {
  return { ...base, contentHash: contentHash(base) };
}

export function normalizeExternalTrace(
  trace: RawExternalTrace,
  canonicalActorIds: readonly string[],
  mappingOptions: EntityMappingOptions = {},
): { readonly trace: NormalizedTrace; readonly mapping: EntityMappingResult } {
  const mapping = mapEntities(canonicalActorIds, trace.entities, mappingOptions);
  const byExternal = new Map(trace.entities.map((entity) => [entity.id, entity]));
  const idMap = new Map(mapping.entries.map((entry) => [entry.externalId, entry.canonicalId]));
  const actors: Record<string, NormalizedActorTrack> = {};
  for (const entry of mapping.entries) {
    actors[entry.canonicalId] = sampleEntity(byExternal.get(entry.externalId)!, trace.frameTransform, trace.timeOffsetS ?? 0);
  }
  const offset = trace.timeOffsetS ?? 0;
  const allTimes = mapping.entries.flatMap((entry) => byExternal.get(entry.externalId)!.samples.map((sample) => sample.t + offset));
  const coverageComplete = allTimes.length > 0
    && Math.min(...allTimes) <= 1 / COMMON_SAMPLE_HZ + EPS
    && Math.max(...allTimes) >= COMMON_DURATION_S - 1 / COMMON_SAMPLE_HZ - EPS;
  return {
    mapping,
    trace: finishTrace({
      side: 'external',
      source: `${trace.simulator.name}@${trace.simulator.version}:${trace.format}`,
      sampleHz: COMMON_SAMPLE_HZ,
      durationS: COMMON_DURATION_S,
      t: commonTimeline(),
      actors,
      events: normalizeEvents(trace.events ?? [], idMap, offset),
      collisions: normalizeCollisions(trace.collisions ?? [], idMap, offset),
      signals: normalizeSignals(trace.signals ?? [], offset),
      metrics: trace.metrics ?? {},
      completed: trace.completed && coverageComplete && Math.abs(trace.durationS - COMMON_DURATION_S) <= 1 / COMMON_SAMPLE_HZ + EPS,
      sourceDurationS: trace.durationS,
    }),
  };
}

function traceMetrics(trace: SimTrace): ObservableEpisodeMetrics {
  const minClearance = trace.metrics.minDistance.reduce<number | null>((best, item) => best === null || item.minDistanceM < best ? item.minDistanceM : best, null);
  return {
    minClearanceM: minClearance,
    minTtcS: trace.metrics.minTTC?.value ?? null,
    minPetS: trace.metrics.minPET?.value ?? null,
  };
}

export function normalizeCanonicalTrace(trace: SimTrace): NormalizedTrace {
  const entities: RawTraceEntity[] = trace.header.actorIds.map((id) => {
    const track = trace.ticks.actors[id];
    if (!track) throw new Error(`Canonical trace is missing actor track ${id}`);
    return {
      id,
      samples: trace.ticks.t.map((t, i) => ({
        t,
        x: track.x[i]!,
        y: track.y[i]!,
        z: 0,
        headingRad: track.headingRad[i]!,
        speedMps: track.speedMps[i]!,
        laneRsl: track.laneRsl[i] ?? null,
        s: track.s[i] ?? null,
        present: Boolean(track.present[i]),
      })),
    };
  });
  const actors = Object.fromEntries(entities.map((entity) => [entity.id, sampleEntity(entity, {
    translationM: [0, 0, 0], rotationRad: 0,
  }, 0)]));
  const events: ObservableEvent[] = trace.events.map((event) => {
    if ('actorId' in event) return { t: event.t, kind: event.kind, actorIds: [event.actorId], sourceId: 'interactionId' in event ? event.interactionId : undefined };
    return { t: event.t, kind: event.kind, actorIds: [event.a, event.b].sort() };
  });
  const collisions = trace.metrics.collisions.map((item) => ({ t: item.t, actorIds: [item.a, item.b].sort() as [string, string] }));
  const signals: ObservableSignalState[] = Object.entries(trace.ticks.signals ?? {}).flatMap(([signalId, track]) => {
    const edges: ObservableSignalState[] = [];
    let previous: string | undefined;
    for (let index = 0; index < trace.ticks.t.length; index++) {
      const state = track.phase[index];
      if (state !== undefined && state !== previous) edges.push({ t: trace.ticks.t[index]!, signalId, state });
      previous = state;
    }
    return edges;
  });
  return finishTrace({
    side: 'canonical',
    source: `uniscenarios@${trace.header.engineVersion}`,
    sampleHz: COMMON_SAMPLE_HZ,
    durationS: COMMON_DURATION_S,
    t: commonTimeline(),
    actors,
    events: normalizeEvents(events, new Map(), 0),
    collisions: normalizeCollisions(collisions, new Map(), 0),
    signals: normalizeSignals(signals, 0),
    metrics: traceMetrics(trace),
    completed: Math.abs(trace.header.clipSeconds - COMMON_DURATION_S) <= EPS
      && Math.abs((trace.ticks.t.at(-1) ?? -Infinity) - COMMON_DURATION_S) <= EPS,
    sourceDurationS: trace.header.clipSeconds,
  });
}
