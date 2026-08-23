import {
  resolveParityConfig,
  type DeepPartial,
  type ParityConfig,
} from "./config";
import {
  PARITY_REPORT_VERSION,
  ParityReportSchema,
  type ParityActorResult,
  type ParityExcludedActor,
  type ParityReport,
} from "./report";

export type ParityFrameActor = {
  id: string | number;
  x: number;
  y: number;
  yaw?: number;
  speed?: number;
  speed_mps?: number;
  kind?: string;
};

export type ParityFrame = {
  timestamp: number;
  actors: ParityFrameActor[];
};

export type ParityCollisionEvent = {
  pair: readonly [string, string];
  t: number;
};

export type ParityRunEvents = {
  collisions?: readonly ParityCollisionEvent[];
};

export type ParityEventInputs = {
  reference?: ParityRunEvents;
  candidate?: ParityRunEvents;
};

type TrackPoint = {
  t: number;
  x: number;
  y: number;
  yaw?: number;
  speed?: number;
};

type ActorTrack = {
  kind: "vehicle" | "walker";
  points: TrackPoint[];
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function actorKind(actor: ParityFrameActor): "vehicle" | "walker" {
  const identity = `${actor.kind ?? ""} ${String(actor.id)}`;
  return /walker|pedestrian|\bped\b/i.test(identity) ? "walker" : "vehicle";
}

function buildTracks(frames: readonly ParityFrame[]): Map<string, ActorTrack> {
  const tracks = new Map<string, ActorTrack>();
  const ordered = [...frames].sort((a, b) => a.timestamp - b.timestamp);
  for (const frame of ordered) {
    if (!finite(frame.timestamp) || frame.timestamp < 0) continue;
    for (const actor of frame.actors) {
      if (!finite(actor.x) || !finite(actor.y)) continue;
      const id = String(actor.id).trim();
      if (!id) continue;
      const track = tracks.get(id) ?? {
        kind: actorKind(actor),
        points: [],
      };
      const speed = finite(actor.speed)
        ? actor.speed
        : finite(actor.speed_mps)
          ? actor.speed_mps
          : undefined;
      track.points.push({
        t: frame.timestamp,
        x: actor.x,
        y: actor.y,
        ...(finite(actor.yaw) ? { yaw: actor.yaw } : {}),
        ...(speed !== undefined ? { speed } : {}),
      });
      tracks.set(id, track);
    }
  }
  for (const track of tracks.values()) {
    track.points.sort((a, b) => a.t - b.t);
  }
  return tracks;
}

function shortestAngleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function interpolate(points: readonly TrackPoint[], t: number): TrackPoint | null {
  if (points.length === 0) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (t < first.t - 1e-9 || t > last.t + 1e-9) return null;
  if (t <= first.t + 1e-9) return first;
  if (t >= last.t - 1e-9) return last;

  let low = 0;
  let high = points.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (points[middle]!.t <= t) low = middle;
    else high = middle;
  }
  const before = points[low]!;
  const after = points[high]!;
  const span = after.t - before.t;
  if (span <= 0) return before;
  const alpha = (t - before.t) / span;
  const yaw =
    before.yaw !== undefined && after.yaw !== undefined
      ? before.yaw + shortestAngleDelta(before.yaw, after.yaw) * alpha
      : undefined;
  const speed =
    before.speed !== undefined && after.speed !== undefined
      ? before.speed + (after.speed - before.speed) * alpha
      : undefined;
  return {
    t,
    x: before.x + (after.x - before.x) * alpha,
    y: before.y + (after.y - before.y) * alpha,
    ...(yaw !== undefined ? { yaw } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
}

function frameExtent(frames: readonly ParityFrame[]): {
  start: number | null;
  end: number | null;
  duration: number;
} {
  const timestamps = frames
    .map((frame) => frame.timestamp)
    .filter((timestamp) => finite(timestamp) && timestamp >= 0);
  if (timestamps.length === 0) {
    return { start: null, end: null, duration: 0 };
  }
  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);
  return { start, end, duration: Math.max(0, end - start) };
}

function gridStartAtOrAfter(t: number, sampleRateHz: number): number {
  return Math.ceil(t * sampleRateHz - 1e-8) / sampleRateHz;
}

function gridEndAtOrBefore(t: number, sampleRateHz: number): number {
  return Math.floor(t * sampleRateHz + 1e-8) / sampleRateHz;
}

function smoothedMaxAbs(
  samples: readonly { t: number; delta: number }[],
  windowSeconds: number,
): number | null {
  if (samples.length === 0) return null;
  const halfWindow = windowSeconds / 2;
  let maximum = 0;
  for (const sample of samples) {
    let sum = 0;
    let count = 0;
    for (const candidate of samples) {
      if (Math.abs(candidate.t - sample.t) <= halfWindow + 1e-9) {
        sum += candidate.delta;
        count += 1;
      }
    }
    if (count > 0) maximum = Math.max(maximum, Math.abs(sum / count));
  }
  return maximum;
}

function compareActor(
  actorId: string,
  reference: ActorTrack,
  candidate: ActorTrack,
  config: ParityConfig,
): ParityActorResult | null {
  const start = gridStartAtOrAfter(
    Math.max(reference.points[0]!.t, candidate.points[0]!.t),
    config.sampleRateHz,
  );
  const end = gridEndAtOrBefore(
    Math.min(
      reference.points[reference.points.length - 1]!.t,
      candidate.points[candidate.points.length - 1]!.t,
    ),
    config.sampleRateHz,
  );
  if (end < start - 1e-9) return null;

  const deviations: number[] = [];
  const speedDeltas: { t: number; delta: number }[] = [];
  const step = 1 / config.sampleRateHz;
  for (let index = 0; start + index * step <= end + 1e-9; index += 1) {
    const t = Number((start + index * step).toFixed(10));
    const referencePoint = interpolate(reference.points, t);
    const candidatePoint = interpolate(candidate.points, t);
    if (!referencePoint || !candidatePoint) continue;
    deviations.push(
      Math.hypot(
        referencePoint.x - candidatePoint.x,
        referencePoint.y - candidatePoint.y,
      ),
    );
    if (
      referencePoint.speed !== undefined &&
      candidatePoint.speed !== undefined
    ) {
      speedDeltas.push({
        t,
        delta: referencePoint.speed - candidatePoint.speed,
      });
    }
  }
  if (deviations.length === 0) return null;

  const maxDeviation = Math.max(...deviations);
  const rmse = Math.sqrt(
    deviations.reduce((sum, deviation) => sum + deviation ** 2, 0) /
      deviations.length,
  );
  const endStateDelta = deviations[deviations.length - 1]!;
  const maxSpeedDelta = smoothedMaxAbs(
    speedDeltas,
    config.speed.smoothingWindowSeconds,
  );
  const kind =
    reference.kind === "walker" || candidate.kind === "walker"
      ? "walker"
      : "vehicle";
  const positionThreshold =
    config.position.maxDeviationMeters[kind];
  const verdict =
    maxDeviation <= positionThreshold + 1e-9 &&
    rmse <= config.position.rmseMeters + 1e-9 &&
    endStateDelta <= config.position.endStateMeters + 1e-9 &&
    (maxSpeedDelta === null ||
      maxSpeedDelta <= config.speed.maxDeltaMetersPerSecond + 1e-9)
      ? "pass"
      : "fail";
  return {
    actorId,
    actorKind: kind,
    sampleCount: deviations.length,
    maxDeviation,
    rmse,
    endStateDelta,
    maxSpeedDelta,
    verdict,
  };
}

function eventMap(
  events: readonly ParityCollisionEvent[] | undefined,
): Map<string, { pair: [string, string]; t: number }> {
  const result = new Map<string, { pair: [string, string]; t: number }>();
  for (const event of events ?? []) {
    const pair = [event.pair[0], event.pair[1]].sort() as [string, string];
    if (!pair[0] || !pair[1] || pair[0] === pair[1] || !finite(event.t)) continue;
    const key = `${pair[0]}\u0000${pair[1]}`;
    const existing = result.get(key);
    if (!existing || event.t < existing.t) result.set(key, { pair, t: event.t });
  }
  return result;
}

function compareCollisions(
  inputs: ParityEventInputs | undefined,
  config: ParityConfig,
): ParityReport["collisions"] {
  if (!inputs?.reference?.collisions || !inputs.candidate?.collisions) {
    return { evaluated: false, verdict: "not_evaluated", pairs: [] };
  }
  const reference = eventMap(inputs.reference.collisions);
  const candidate = eventMap(inputs.candidate.collisions);
  const keys = [...new Set([...reference.keys(), ...candidate.keys()])].sort();
  const pairs = keys.map((key) => {
    const referenceEvent = reference.get(key);
    const candidateEvent = candidate.get(key);
    const timingDelta =
      referenceEvent && candidateEvent
        ? Math.abs(referenceEvent.t - candidateEvent.t)
        : null;
    const presenceMatches = Boolean(referenceEvent) === Boolean(candidateEvent);
    const verdict =
      (!config.collisionEvents.presenceExact || presenceMatches) &&
      (timingDelta === null ||
        timingDelta <= config.collisionEvents.maxTimingDeltaSeconds + 1e-9)
        ? "pass" as const
        : "fail" as const;
    return {
      pair: (referenceEvent ?? candidateEvent)!.pair,
      referenceTime: referenceEvent?.t ?? null,
      candidateTime: candidateEvent?.t ?? null,
      timingDelta,
      presence: {
        reference: Boolean(referenceEvent),
        candidate: Boolean(candidateEvent),
      },
      verdict,
    };
  });
  return {
    evaluated: true,
    verdict: pairs.every((pair) => pair.verdict === "pass") ? "pass" : "fail",
    pairs,
  };
}

export function compareRuns(
  referenceFrames: readonly ParityFrame[],
  candidateFrames: readonly ParityFrame[],
  configOverride?: DeepPartial<ParityConfig>,
  eventInputs?: ParityEventInputs,
): ParityReport {
  const config = resolveParityConfig(configOverride);
  const referenceTracks = buildTracks(referenceFrames);
  const candidateTracks = buildTracks(candidateFrames);
  const referenceIds = new Set(referenceTracks.keys());
  const candidateIds = new Set(candidateTracks.keys());
  const excludedActors: ParityExcludedActor[] = [];

  for (const actorId of [...referenceIds].sort()) {
    if (!candidateIds.has(actorId)) {
      excludedActors.push({ actorId, reason: "missing_from_candidate" });
    }
  }
  for (const actorId of [...candidateIds].sort()) {
    if (!referenceIds.has(actorId)) {
      excludedActors.push({ actorId, reason: "missing_from_reference" });
    }
  }

  const actors: ParityActorResult[] = [];
  for (const actorId of [...referenceIds].filter((id) => candidateIds.has(id)).sort()) {
    const result = compareActor(
      actorId,
      referenceTracks.get(actorId)!,
      candidateTracks.get(actorId)!,
      config,
    );
    if (result) actors.push(result);
    else excludedActors.push({ actorId, reason: "no_common_time_window" });
  }

  const referenceExtent = frameExtent(referenceFrames);
  const candidateExtent = frameExtent(candidateFrames);
  const commonStart =
    referenceExtent.start === null || candidateExtent.start === null
      ? null
      : Math.max(referenceExtent.start, candidateExtent.start);
  const commonEnd =
    referenceExtent.end === null || candidateExtent.end === null
      ? null
      : Math.min(referenceExtent.end, candidateExtent.end);
  const commonDuration =
    commonStart === null || commonEnd === null
      ? 0
      : Math.max(0, commonEnd - commonStart);
  const durationDelta = Math.abs(
    referenceExtent.duration - candidateExtent.duration,
  );
  const durationVerdict =
    durationDelta <= config.duration.maxDeltaSeconds + 1e-9 ? "pass" : "fail";
  const collisions = compareCollisions(eventInputs, config);
  const hasFailure =
    durationVerdict === "fail" ||
    actors.some((actor) => actor.verdict === "fail") ||
    collisions.verdict === "fail";
  const verdict = hasFailure
    ? "fail"
    : excludedActors.length > 0
      ? "partial"
      : "pass";

  return ParityReportSchema.parse({
    schemaVersion: PARITY_REPORT_VERSION,
    verdict,
    config,
    timeline: {
      referenceDuration: referenceExtent.duration,
      candidateDuration: candidateExtent.duration,
      commonStart,
      commonDuration,
      durationDelta,
      durationVerdict,
    },
    actors,
    excludedActors,
    collisions,
  });
}
