import {
  resolveLintConfig,
  type LintConfig,
  type LintThreshold,
  type ResolvedLintConfig,
} from "./config";
import {
  SCENARIO_LINT_SCHEMA_VERSION,
  type LintActorReport,
  type LintActorTrack,
  type LintMetricSample,
  type LintReport,
  type LintSeverity,
  type LintTrackSample,
  type LintViolation,
  type LintViolationKind,
} from "./types";

interface NormalizedTrack {
  actorId: string;
  kind: LintActorTrack["kind"];
  samples: LintTrackSample[];
  speeds: number[];
  headings: number[];
}

interface DiscontinuityEvent {
  index: number;
  tStart: number;
  tEnd: number;
  peakValue: number;
  threshold: number;
}

interface MetricDescriptor {
  kind: LintViolationKind;
  threshold: LintThreshold;
  value: (sample: LintMetricSample) => number;
}

function finite(name: string, value: number, actorId: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${actorId}: ${name} must be finite`);
  }
}

function normalizeAngle(angle: number): number {
  let normalized = angle % (2 * Math.PI);
  if (normalized > Math.PI) normalized -= 2 * Math.PI;
  if (normalized <= -Math.PI) normalized += 2 * Math.PI;
  return normalized;
}

function intervalSpeed(a: LintTrackSample, b: LintTrackSample): number {
  return Math.hypot(b.x - a.x, b.y - a.y) / (b.t - a.t);
}

function deriveSpeeds(samples: LintTrackSample[]): number[] {
  if (samples.length === 0) return [];
  if (samples.length === 1) {
    return [Math.abs(samples[0]!.speed ?? 0)];
  }
  const intervals = samples.slice(1).map((sample, index) =>
    intervalSpeed(samples[index]!, sample),
  );
  return samples.map((sample, index) => {
    if (sample.speed !== undefined) return Math.abs(sample.speed);
    if (index === 0) return intervals[0]!;
    if (index === samples.length - 1) return intervals[intervals.length - 1]!;
    const beforeDt = sample.t - samples[index - 1]!.t;
    const afterDt = samples[index + 1]!.t - sample.t;
    return (
      (intervals[index - 1]! * beforeDt + intervals[index]! * afterDt) /
      (beforeDt + afterDt)
    );
  });
}

function motionHeading(
  samples: LintTrackSample[],
  index: number,
  stationarySpeedEpsilonMps: number,
): number | null {
  if (samples.length < 2) return null;
  const before = index === 0 ? samples[0]! : samples[index - 1]!;
  const after =
    index === samples.length - 1 ? samples[index]! : samples[index + 1]!;
  const dt = after.t - before.t;
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  if (dt <= 0 || Math.hypot(dx, dy) / dt < stationarySpeedEpsilonMps) {
    return null;
  }
  return Math.atan2(dy, dx);
}

function deriveHeadings(
  samples: LintTrackSample[],
  stationarySpeedEpsilonMps: number,
): number[] {
  const raw = samples.map(
    (sample, index) =>
      sample.yaw ??
      motionHeading(samples, index, stationarySpeedEpsilonMps),
  );
  const firstKnown = raw.find((heading) => heading !== null) ?? 0;
  let lastKnown = firstKnown;
  const held = raw.map((heading) => {
    if (heading !== null) lastKnown = heading;
    return lastKnown;
  });
  if (held.length === 0) return held;
  const unwrapped = [held[0]!];
  for (let index = 1; index < held.length; index += 1) {
    unwrapped.push(
      unwrapped[index - 1]! +
        normalizeAngle(held[index]! - unwrapped[index - 1]!),
    );
  }
  return unwrapped;
}

function normalizeTrack(
  track: LintActorTrack,
  config: ResolvedLintConfig,
): NormalizedTrack {
  if (!track.actorId.trim()) {
    throw new TypeError("actorId must be non-empty");
  }
  const samples = track.samples.map((sample) => ({ ...sample }));
  samples.forEach((sample) => {
    finite("sample.t", sample.t, track.actorId);
    finite("sample.x", sample.x, track.actorId);
    finite("sample.y", sample.y, track.actorId);
    if (sample.yaw !== undefined) finite("sample.yaw", sample.yaw, track.actorId);
    if (sample.speed !== undefined) {
      finite("sample.speed", sample.speed, track.actorId);
    }
  });
  samples.sort((a, b) => a.t - b.t);
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index]!.t <= samples[index - 1]!.t) {
      throw new RangeError(
        `${track.actorId}: sample timestamps must be strictly increasing`,
      );
    }
  }
  return {
    actorId: track.actorId,
    kind: track.kind,
    samples,
    speeds: deriveSpeeds(samples),
    headings: deriveHeadings(samples, config.stationarySpeedEpsilonMps),
  };
}

function smooth(
  times: number[],
  values: number[],
  windowS: number,
): number[] {
  const halfWindow = windowS / 2;
  return values.map((_value, index) => {
    const localTimes: number[] = [];
    const localValues: number[] = [];
    for (let cursor = 0; cursor < values.length; cursor += 1) {
      if (Math.abs(times[cursor]! - times[index]!) <= halfWindow + 1e-12) {
        localTimes.push(times[cursor]!);
        localValues.push(values[cursor]!);
      }
    }
    if (localValues.length < 2) return values[index]!;
    const meanTime =
      localTimes.reduce((sum, time) => sum + time, 0) / localTimes.length;
    const meanValue =
      localValues.reduce((sum, value) => sum + value, 0) / localValues.length;
    let covariance = 0;
    let timeVariance = 0;
    for (let cursor = 0; cursor < localValues.length; cursor += 1) {
      const centeredTime = localTimes[cursor]! - meanTime;
      covariance += centeredTime * (localValues[cursor]! - meanValue);
      timeVariance += centeredTime * centeredTime;
    }
    if (timeVariance <= Number.EPSILON) return meanValue;
    const slope = covariance / timeVariance;
    return meanValue + slope * (times[index]! - meanTime);
  });
}

function derivative(times: number[], values: number[]): number[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [0];
  return values.map((_value, index) => {
    if (index === 0) {
      return (values[1]! - values[0]!) / (times[1]! - times[0]!);
    }
    if (index === values.length - 1) {
      return (
        (values[index]! - values[index - 1]!) /
        (times[index]! - times[index - 1]!)
      );
    }
    return (
      (values[index + 1]! - values[index - 1]!) /
      (times[index + 1]! - times[index - 1]!)
    );
  });
}

function computeMetrics(
  track: NormalizedTrack,
  config: ResolvedLintConfig,
): LintMetricSample[] {
  const times = track.samples.map((sample) => sample.t);
  const speeds = smooth(times, track.speeds, config.smoothingWindowS);
  const headings = smooth(times, track.headings, config.smoothingWindowS);
  const signedAcceleration = derivative(times, speeds);
  const yawRates = derivative(times, headings);
  const jerks = derivative(times, signedAcceleration);
  return times.map((t, index) => ({
    t,
    speed: speeds[index]!,
    longitudinalAcceleration: Math.max(signedAcceleration[index]!, 0),
    longitudinalDeceleration: Math.max(-signedAcceleration[index]!, 0),
    lateralAcceleration: speeds[index]! * yawRates[index]!,
    longitudinalJerk: jerks[index]!,
    yawRate: yawRates[index]!,
  }));
}

function metricDescriptors(
  kind: LintActorTrack["kind"],
  config: ResolvedLintConfig,
): MetricDescriptor[] {
  if (kind === "walker") {
    return [
      {
        kind: "speed",
        threshold: config.thresholds.walker.speed,
        value: (sample) => sample.speed,
      },
    ];
  }
  return [
    {
      kind: "longitudinal_acceleration",
      threshold: config.thresholds.vehicle.longitudinalAcceleration,
      value: (sample) => sample.longitudinalAcceleration,
    },
    {
      kind: "longitudinal_deceleration",
      threshold: config.thresholds.vehicle.longitudinalDeceleration,
      value: (sample) => sample.longitudinalDeceleration,
    },
    {
      kind: "lateral_acceleration",
      threshold: config.thresholds.vehicle.lateralAcceleration,
      value: (sample) => Math.abs(sample.lateralAcceleration),
    },
    {
      kind: "longitudinal_jerk",
      threshold: config.thresholds.vehicle.longitudinalJerk,
      value: (sample) => Math.abs(sample.longitudinalJerk),
    },
  ];
}

function metricViolations(
  actorId: string,
  samples: LintMetricSample[],
  descriptor: MetricDescriptor,
): LintViolation[] {
  const severityAt = samples.map((sample): LintSeverity | null => {
    const value = descriptor.value(sample);
    if (value > descriptor.threshold.violation) return "violation";
    if (value > descriptor.threshold.warning) return "warning";
    return null;
  });
  const violations: LintViolation[] = [];
  let start = 0;
  while (start < samples.length) {
    const severity = severityAt[start]!;
    if (severity === null) {
      start += 1;
      continue;
    }
    let end = start;
    while (
      end + 1 < samples.length &&
      severityAt[end + 1] === severity
    ) {
      end += 1;
    }
    const threshold = descriptor.threshold[severity];
    const peakValue = Math.max(
      ...samples.slice(start, end + 1).map(descriptor.value),
    );
    const duration = samples[end]!.t - samples[start]!.t;
    if (
      severity === "violation" ||
      descriptor.threshold.warningMinDurationS === 0 ||
      duration > descriptor.threshold.warningMinDurationS
    ) {
      violations.push({
        actorId,
        kind: descriptor.kind,
        tStart: samples[start]!.t,
        tEnd: samples[end]!.t,
        peakValue,
        threshold,
        severity,
      });
    }
    start = end + 1;
  }
  return violations;
}

function positionReferenceSpeed(
  track: NormalizedTrack,
  segmentEndIndex: number,
): number {
  const start = segmentEndIndex - 1;
  const explicit =
    track.samples[start]!.speed ?? track.samples[segmentEndIndex]!.speed;
  if (explicit !== undefined) return Math.abs(explicit);
  if (start > 0) {
    return intervalSpeed(track.samples[start - 1]!, track.samples[start]!);
  }
  if (segmentEndIndex + 1 < track.samples.length) {
    return intervalSpeed(
      track.samples[segmentEndIndex]!,
      track.samples[segmentEndIndex + 1]!,
    );
  }
  return track.speeds[start] ?? 0;
}

function discontinuityEvents(
  track: NormalizedTrack,
  config: ResolvedLintConfig,
): Record<
  | "position_discontinuity"
  | "speed_discontinuity"
  | "heading_discontinuity",
  DiscontinuityEvent[]
> {
  const events = {
    position_discontinuity: [] as DiscontinuityEvent[],
    speed_discontinuity: [] as DiscontinuityEvent[],
    heading_discontinuity: [] as DiscontinuityEvent[],
  };
  for (let index = 1; index < track.samples.length; index += 1) {
    const previous = track.samples[index - 1]!;
    const current = track.samples[index]!;
    const dt = current.t - previous.t;
    const positionJump = Math.hypot(
      current.x - previous.x,
      current.y - previous.y,
    );
    const positionThreshold = Math.max(
      positionReferenceSpeed(track, index) *
        dt *
        config.discontinuities.positionSpeedMultiplier,
      config.discontinuities.positionJumpFloorM,
    );
    if (positionJump > positionThreshold) {
      events.position_discontinuity.push({
        index,
        tStart: previous.t,
        tEnd: current.t,
        peakValue: positionJump,
        threshold: positionThreshold,
      });
    }

    const impliedAcceleration =
      Math.abs(track.speeds[index]! - track.speeds[index - 1]!) / dt;
    if (
      impliedAcceleration > config.discontinuities.speedAccelerationMps2
    ) {
      events.speed_discontinuity.push({
        index,
        tStart: previous.t,
        tEnd: current.t,
        peakValue: impliedAcceleration,
        threshold: config.discontinuities.speedAccelerationMps2,
      });
    }

    const headingJump = Math.abs(
      normalizeAngle(track.headings[index]! - track.headings[index - 1]!),
    );
    if (headingJump > config.discontinuities.headingJumpRad) {
      events.heading_discontinuity.push({
        index,
        tStart: previous.t,
        tEnd: current.t,
        peakValue: headingJump,
        threshold: config.discontinuities.headingJumpRad,
      });
    }
  }
  return events;
}

function mergeDiscontinuityEvents(
  actorId: string,
  kind: LintViolationKind,
  events: DiscontinuityEvent[],
): LintViolation[] {
  const violations: LintViolation[] = [];
  let start = 0;
  while (start < events.length) {
    let end = start;
    while (
      end + 1 < events.length &&
      events[end + 1]!.index === events[end]!.index + 1
    ) {
      end += 1;
    }
    const window = events.slice(start, end + 1);
    const peak = window.reduce((best, event) =>
      event.peakValue > best.peakValue ? event : best,
    );
    violations.push({
      actorId,
      kind,
      tStart: window[0]!.tStart,
      tEnd: window[window.length - 1]!.tEnd,
      peakValue: peak.peakValue,
      threshold: peak.threshold,
      severity: "violation",
    });
    start = end + 1;
  }
  return violations;
}

function lintTrack(
  input: LintActorTrack,
  config: ResolvedLintConfig,
): LintActorReport {
  const track = normalizeTrack(input, config);
  const samples = computeMetrics(track, config);
  const violations = metricDescriptors(track.kind, config).flatMap(
    (descriptor) => metricViolations(track.actorId, samples, descriptor),
  );
  const discontinuities = discontinuityEvents(track, config);
  for (const kind of [
    "position_discontinuity",
    "speed_discontinuity",
    "heading_discontinuity",
  ] as const) {
    violations.push(
      ...mergeDiscontinuityEvents(
        track.actorId,
        kind,
        discontinuities[kind],
      ),
    );
  }
  violations.sort(
    (a, b) =>
      a.tStart - b.tStart ||
      a.tEnd - b.tEnd ||
      a.kind.localeCompare(b.kind) ||
      a.severity.localeCompare(b.severity),
  );
  return {
    actorId: track.actorId,
    kind: track.kind,
    samples,
    violations,
  };
}

export function lintActorTracks(
  tracks: LintActorTrack[],
  config?: LintConfig,
): LintReport {
  const resolvedConfig = resolveLintConfig(config);
  const actorIds = new Set<string>();
  for (const track of tracks) {
    if (actorIds.has(track.actorId)) {
      throw new RangeError(`duplicate actorId: ${track.actorId}`);
    }
    actorIds.add(track.actorId);
  }
  const perActor = tracks.map((track) => lintTrack(track, resolvedConfig));
  const violations = perActor.flatMap((actor) => actor.violations);
  const violationCount = violations.filter(
    (violation) => violation.severity === "violation",
  ).length;
  const warningCount = violations.length - violationCount;
  const byKind: Record<string, number> = {};
  for (const violation of violations) {
    byKind[violation.kind] = (byKind[violation.kind] ?? 0) + 1;
  }
  return {
    schemaVersion: SCENARIO_LINT_SCHEMA_VERSION,
    perActor,
    violations,
    summary: {
      verdict:
        violationCount > 0 ? "fail" : warningCount > 0 ? "warn" : "pass",
      violationCount,
      warningCount,
      byKind,
    },
  };
}
