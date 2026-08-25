import type { EsminiActorTrajectory } from "../scenario-validation-job";
import type {
  LintActorKind,
  LintActorTrack,
  LintTrackSample,
} from "./types";

export type LintActorKinds = Readonly<Record<string, LintActorKind>>;

export interface PreviewActorSample {
  id: string | number;
  x: number;
  y: number;
  /** Radians, matching LintActorTrack. */
  yaw?: number;
  /** Meters per second. */
  speed?: number;
}

export interface PreviewFrame {
  timestamp: number;
  actors: PreviewActorSample[];
}

function actorKind(
  actorId: string,
  kinds: LintActorKinds,
): LintActorKind {
  return kinds[actorId] ?? "vehicle";
}

/**
 * Convert esmini's shared `actor_trajectories` shape. Esmini trajectories do
 * not carry actor kinds, so callers may supply an actor-id map; vehicle is the
 * default for backward-compatible trajectory artifacts.
 */
export function fromEsminiTrajectories(
  trajectories: EsminiActorTrajectory[],
  kinds: LintActorKinds = {},
): LintActorTrack[] {
  return trajectories.map((trajectory) => ({
    actorId: trajectory.actor_id,
    kind: actorKind(trajectory.actor_id, kinds),
    samples: trajectory.points.map((point) => ({
      t: point.t,
      x: point.x,
      y: point.y,
      yaw: point.yaw,
      speed: point.speed,
    })),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredFinite(
  value: unknown,
  path: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}

function optionalFinite(
  value: unknown,
  path: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredFinite(value, path);
}

function carlaActorId(actor: Record<string, unknown>, path: string): string {
  for (const field of ["actor_spec_id", "authored_actor_id", "id", "label"]) {
    const value = actor[field];
    if (
      (typeof value === "string" && value.trim()) ||
      typeof value === "number"
    ) {
      return String(value);
    }
  }
  throw new TypeError(`${path} needs actor_spec_id, authored_actor_id, id, or label`);
}

function carlaKind(actor: Record<string, unknown>): LintActorKind | null {
  const kind = String(actor.kind ?? "").toLowerCase();
  if (kind === "prop") return null;
  if (kind === "walker" || kind === "pedestrian") return "walker";
  if (kind === "vehicle") return "vehicle";
  const role = String(actor.role ?? "").toLowerCase();
  if (role === "prop") return null;
  return role === "walker" || role === "pedestrian" ? "walker" : "vehicle";
}

/**
 * Convert the CARLA worker's compact `actor_track.json` sidecar.
 *
 * The sidecar's emitted x/y plane is consumed as-is: distance, curvature, and
 * finite differences are invariant to world-frame origin and handedness, so
 * linting needs no coordinate-frame conversion. Worker yaw is degrees and is
 * normalized to the lint API's radians; speed_mps is already SI.
 * Static props are outside LintActorTrack's vehicle/walker domain and omitted.
 */
export function fromCarlaActorTrack(json: unknown): LintActorTrack[] {
  if (!isRecord(json) || !Array.isArray(json.frames)) {
    throw new TypeError("CARLA actor track must be an object with frames[]");
  }
  const tracks = new Map<
    string,
    { kind: LintActorKind; samples: LintTrackSample[] }
  >();
  json.frames.forEach((frameValue, frameIndex) => {
    const framePath = `frames[${frameIndex}]`;
    if (!isRecord(frameValue) || !Array.isArray(frameValue.actors)) {
      throw new TypeError(`${framePath} must contain actors[]`);
    }
    const t = requiredFinite(frameValue.timestamp, `${framePath}.timestamp`);
    const seen = new Set<string>();
    frameValue.actors.forEach((actorValue, actorIndex) => {
      const path = `${framePath}.actors[${actorIndex}]`;
      if (!isRecord(actorValue)) {
        throw new TypeError(`${path} must be an object`);
      }
      const kind = carlaKind(actorValue);
      if (kind === null) return;
      const actorId = carlaActorId(actorValue, path);
      if (seen.has(actorId)) {
        throw new RangeError(`${framePath} contains duplicate actor ${actorId}`);
      }
      seen.add(actorId);
      const yawDegrees = optionalFinite(actorValue.yaw, `${path}.yaw`);
      const speedMps = optionalFinite(
        actorValue.speed_mps,
        `${path}.speed_mps`,
      );
      const speedKph = optionalFinite(
        actorValue.speed_kph,
        `${path}.speed_kph`,
      );
      const sample: LintTrackSample = {
        t,
        x: requiredFinite(actorValue.x, `${path}.x`),
        y: requiredFinite(actorValue.y, `${path}.y`),
      };
      if (yawDegrees !== undefined) sample.yaw = yawDegrees * (Math.PI / 180);
      if (speedMps !== undefined) sample.speed = speedMps;
      else if (speedKph !== undefined) sample.speed = speedKph / 3.6;

      const existing = tracks.get(actorId);
      if (existing && existing.kind !== kind) {
        throw new TypeError(`${path}.kind changed for actor ${actorId}`);
      }
      if (existing) existing.samples.push(sample);
      else tracks.set(actorId, { kind, samples: [sample] });
    });
  });
  return [...tracks].map(([actorId, track]) => ({
    actorId,
    kind: track.kind,
    samples: track.samples.sort((a, b) => a.t - b.t),
  }));
}

/**
 * Convert editor preview frames. Preview frames do not carry actor kinds, so
 * callers may provide a kind map; unlisted actors default to vehicles.
 */
export function fromPreviewFrames(
  frames: PreviewFrame[],
  kinds: LintActorKinds = {},
): LintActorTrack[] {
  const tracks = new Map<string, LintTrackSample[]>();
  frames.forEach((frame, frameIndex) => {
    if (!Number.isFinite(frame.timestamp)) {
      throw new TypeError(`frames[${frameIndex}].timestamp must be finite`);
    }
    const seen = new Set<string>();
    frame.actors.forEach((actor, actorIndex) => {
      const actorId = String(actor.id);
      if (seen.has(actorId)) {
        throw new RangeError(
          `frames[${frameIndex}] contains duplicate actor ${actorId}`,
        );
      }
      seen.add(actorId);
      for (const [field, value] of Object.entries({
        x: actor.x,
        y: actor.y,
        yaw: actor.yaw,
        speed: actor.speed,
      })) {
        if (value !== undefined && !Number.isFinite(value)) {
          throw new TypeError(
            `frames[${frameIndex}].actors[${actorIndex}].${field} must be finite`,
          );
        }
      }
      const samples = tracks.get(actorId) ?? [];
      samples.push({
        t: frame.timestamp,
        x: actor.x,
        y: actor.y,
        yaw: actor.yaw,
        speed: actor.speed,
      });
      tracks.set(actorId, samples);
    });
  });
  return [...tracks].map(([actorId, samples]) => ({
    actorId,
    kind: actorKind(actorId, kinds),
    samples: samples.sort((a, b) => a.t - b.t),
  }));
}
