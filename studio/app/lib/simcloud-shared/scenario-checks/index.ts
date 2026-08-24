/**
 * Post-run checklist: turn a 2D-simulation (or CARLA render) trace into a
 * "checks passed/failed" report. This is what the user asked to see after
 * running the 2D simulation — a structured pass/warn/fail list rather than a
 * single opaque verdict.
 */
import type { CarlaTimelineFrame } from "../carla-live-e2e";
import type { EsminiActorTrajectory } from "../scenario-validation-job";
import { runKinematicChecks, type KinematicThresholds } from "./kinematic";
import { runOscRoundTripChecks, type OscCheckSourceActor, type OscRoundTripOptions } from "./osc";
import type { CheckActorTrack, ScenarioCheck, ScenarioCheckReport, ScenarioCheckStatus } from "./types";

export type { CheckActorTrack, CheckTrackSample, ScenarioCheck, ScenarioCheckCategory, ScenarioCheckReport, ScenarioCheckStatus } from "./types";
export { runKinematicChecks, DEFAULT_KINEMATIC_THRESHOLDS, type KinematicThresholds } from "./kinematic";
export { runOscRoundTripChecks, OSC_SUPPORTED_PLACEMENT_MODES, type OscCheckSourceActor, type OscRoundTripOptions } from "./osc";
export { compareRuns, parityToChecks, type ParityResult, type ActorParity, type ParityTolerance } from "./parity";

/** Roll a flat list of checks into a report with an overall verdict. */
export function summarizeChecks(
  checks: ScenarioCheck[],
  generatedAt: string | null = null,
): ScenarioCheckReport {
  let passed = 0;
  let warned = 0;
  let failed = 0;
  for (const c of checks) {
    if (c.status === "fail") failed++;
    else if (c.status === "warn") warned++;
    else passed++;
  }
  const verdict: ScenarioCheckStatus = failed > 0 ? "fail" : warned > 0 ? "warn" : "pass";
  return { verdict, generatedAt, passed, warned, failed, checks };
}

/**
 * Convert esmini/2D-sim actor trajectories (the on-branch trace format) into
 * generic check tracks. `kinds` maps actor_id -> kind so walkers get the walker
 * thresholds; unmapped actors default to "vehicle".
 */
export function tracksFromEsminiTrajectories(
  trajectories: EsminiActorTrajectory[],
  kinds: Record<string, CheckActorTrack["kind"]> = {},
): CheckActorTrack[] {
  return trajectories.map((traj) => ({
    actorId: traj.actor_id,
    kind: kinds[traj.actor_id] ?? "vehicle",
    samples: traj.points.map((p) => ({ t: p.t, x: p.x, y: p.y, yaw: p.yaw, speed: p.speed })),
  }));
}

function timelineActorKey(sample: CarlaTimelineFrame["actors"][number]): string | null {
  if (sample.actor_spec_id) return sample.actor_spec_id;
  if (sample.authored_actor_id) return sample.authored_actor_id;
  if (sample.id != null) return String(sample.id);
  return null;
}

function timelineKind(kind: string | undefined): CheckActorTrack["kind"] {
  if (kind === "walker" || kind === "pedestrian") return "walker";
  if (kind === "prop" || kind === "static") return "prop";
  return "vehicle";
}

/**
 * Convert a CARLA worker `timeline.json` (the 2D-simulate / render trace) into
 * generic check tracks. Yaw is intentionally left undefined so it is derived
 * from the velocity vector — kinematic magnitudes (accel, jerk, |yaw rate|,
 * speed) are invariant under the runtime<->CARLA Y-flip, so the checks are
 * correct regardless of which frame the timeline was recorded in.
 */
export function tracksFromCarlaTimeline(frames: CarlaTimelineFrame[]): CheckActorTrack[] {
  const byActor = new Map<string, { kind: CheckActorTrack["kind"]; samples: CheckActorTrack["samples"] }>();
  for (const frame of frames) {
    for (const sample of frame.actors ?? []) {
      const key = timelineActorKey(sample);
      if (!key) continue;
      let entry = byActor.get(key);
      if (!entry) {
        entry = { kind: timelineKind(sample.kind), samples: [] };
        byActor.set(key, entry);
      }
      const speed =
        sample.speed_mps != null
          ? sample.speed_mps
          : sample.speed_kph != null
            ? sample.speed_kph / 3.6
            : undefined;
      entry.samples.push({ t: frame.timestamp, x: sample.x, y: sample.y, speed });
    }
  }
  const tracks: CheckActorTrack[] = [];
  for (const [actorId, entry] of byActor) {
    entry.samples.sort((a, b) => a.t - b.t);
    tracks.push({ actorId, kind: entry.kind, samples: entry.samples });
  }
  return tracks;
}

export interface PostSimChecklistInput {
  /** The trace produced by the 2D simulation (or a CARLA render). */
  tracks: CheckActorTrack[];
  kinematicThresholds?: KinematicThresholds;
  /**
   * When present, also run the OSC fidelity checks: the source actors and the
   * `.xosc` the writer emitted for them. Omit to produce a lint-only report.
   */
  osc?: {
    sourceActors: OscCheckSourceActor[];
    xml: string;
    options?: OscRoundTripOptions;
  };
  generatedAt?: string | null;
}

/**
 * Build the full post-simulation checklist: OSC fidelity (optional) + kinematic
 * plausibility + trace integrity, summarized into one pass/warn/fail report.
 */
export function buildPostSimChecklist(input: PostSimChecklistInput): ScenarioCheckReport {
  const checks: ScenarioCheck[] = [];
  if (input.osc) {
    checks.push(...runOscRoundTripChecks(input.osc.sourceActors, input.osc.xml, input.osc.options));
  }
  checks.push(...runKinematicChecks(input.tracks, input.kinematicThresholds));
  return summarizeChecks(checks, input.generatedAt ?? null);
}
