/**
 * The runtime's own account of how the schedule went, read back for the editor.
 *
 * The sim emits one `timed_point_arrival` per runtime polyline vertex carrying
 * the lateness it actually accrued, and at most one
 * `timed_points_schedule_shifted` for the moment it stopped trying to catch up.
 * Both land in `simulationStore.behaviorEvents` alongside the behavior program's
 * own events. This module is the only place that knows their shape.
 *
 * Why the reads are defensive: `BehaviorEvent` is typed (and, on the CARLA path,
 * PARSED) as the four common fields, so the diagnostic payload rides along as
 * untyped extras. The browser engine writes the store directly and keeps them;
 * `readBehaviorEvents` strips them from a worker artifact, which means a CARLA
 * run degrades to "no lateness reported" rather than to wrong numbers. Every
 * field here is therefore optional at the type level and absent-tolerant at
 * runtime.
 */

import type { BehaviorEvent } from "@simforge/studio-shared";

export const SCHEDULE_EVENT_ARRIVAL = "timed_point_arrival";
export const SCHEDULE_EVENT_SHIFTED = "timed_points_schedule_shifted";

/**
 * Lateness an author should be told about. Under half a second is inside the
 * controller's own settling and reporting it would tint a healthy schedule.
 */
export const SCHEDULE_LATE_SECONDS = 0.5;
/**
 * Lateness at which the drive stops resembling the authored one.
 *
 * Mirrors the engine's `TIMED_POINTS_MAX_LAG_S` (preview-engine/constants.ts,
 * itself mirroring `worker/actor_control.py`), which is the accrued lag that
 * trips the one-shot schedule shift. Duplicated rather than imported because
 * that constant is engine-internal and the editor must not reach into it; if
 * the engine's ceiling ever moves, this comment is the trail.
 */
export const SCHEDULE_MISSED_SECONDS = 2;

/**
 * How far from an authored point the car may pass and still be said to have
 * driven THROUGH it.
 *
 * Lateness answers WHEN and cannot answer WHETHER: a car that cuts a corner
 * cleanly sails past the point it was told to hit, on time, and a
 * lateness-only readout calls that a perfect arrival. `closest_approach_m`
 * (added by the steering lane in da66184cf) is the other half, and half a metre
 * is roughly the slop a lane-snapped point already carries — tighter would mark
 * every corner.
 */
export const SCHEDULE_MISSED_BY_METRES = 0.5;

export interface ScheduleArrival {
  /** Index into the RUNTIME polyline (hold clusters already collapsed). */
  runtimeIndex: number;
  scheduledSeconds: number;
  actualSeconds: number;
  latenessSeconds: number;
  /**
   * Nearest the car's swept path came to the authored point, in metres. `null`
   * on a run that predates the field — absent must read as "not measured",
   * never as "drove straight through it".
   */
  closestApproachM: number | null;
}

export interface ScheduleShift {
  atSeconds: number;
  lagSeconds: number;
}

export interface ActorScheduleReport {
  /**
   * Arrivals keyed by their SCHEDULED time, in whole milliseconds.
   *
   * NOT by `point_index`, deliberately. That index addresses the runtime
   * polyline, whose construction belongs to the runtime and is changing under us
   * right now — the steering lane is making both languages prepend the spawn
   * point, which shifts every index by one. The engine's own comment names
   * `scheduled_timestamp_seconds` the unambiguous identifier, and an editor that
   * joined on the index would quietly attribute every arrival to the point
   * before it the day that lands.
   */
  arrivalsByScheduledMs: Map<number, ScheduleArrival>;
  /** The one-shot give-up, or null when the actor kept its schedule. */
  shift: ScheduleShift | null;
}

/** Scheduled seconds as an integer-millisecond key; the engine rounds to 3. */
function scheduledKey(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** The arrival the runtime reported for a point scheduled at `seconds`. */
export function scheduleArrivalAt(
  report: ActorScheduleReport | null | undefined,
  scheduledSeconds: number,
): ScheduleArrival | null {
  return report?.arrivalsByScheduledMs.get(scheduledKey(scheduledSeconds)) ?? null;
}

/** How a dock tick should read: the point was hit, hit late, or never hit. */
export type ScheduleTickState = "on_time" | "late" | "missed";

function extra(event: BehaviorEvent, key: string): number | null {
  const value = (event as unknown as Record<string, unknown>)[key];
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Group every schedule diagnostic in a run by actor.
 *
 * Returns an empty map for a run that carries none, which is the common case
 * (no drive-by-points actor, or a CARLA artifact whose extras were parsed off).
 * Callers must treat "no report" as "nothing to say", never as "on time".
 */
export function readScheduleDiagnostics(
  events: readonly BehaviorEvent[],
): Map<string, ActorScheduleReport> {
  const byActor = new Map<string, ActorScheduleReport>();
  const reportFor = (actorId: string): ActorScheduleReport => {
    const existing = byActor.get(actorId);
    if (existing) return existing;
    const created: ActorScheduleReport = {
      arrivalsByScheduledMs: new Map(),
      shift: null,
    };
    byActor.set(actorId, created);
    return created;
  };

  for (const event of events) {
    if (event.kind === SCHEDULE_EVENT_ARRIVAL) {
      const runtimeIndex = extra(event, "point_index");
      const latenessSeconds = extra(event, "lateness_seconds");
      const scheduledSeconds = extra(event, "scheduled_timestamp_seconds");
      if (runtimeIndex === null || latenessSeconds === null || scheduledSeconds === null) {
        continue;
      }
      reportFor(event.actor_id).arrivalsByScheduledMs.set(
        scheduledKey(scheduledSeconds),
        {
          runtimeIndex,
          scheduledSeconds,
          actualSeconds: extra(event, "actual_timestamp_seconds") ?? event.t,
          latenessSeconds,
          closestApproachM: extra(event, "closest_approach_m"),
        },
      );
      continue;
    }
    if (event.kind === SCHEDULE_EVENT_SHIFTED) {
      const report = reportFor(event.actor_id);
      // One shot per run by construction; if a malformed artifact carries two,
      // the FIRST is the one that describes when the schedule stopped holding.
      if (report.shift === null) {
        report.shift = {
          atSeconds: extra(event, "elapsed_seconds") ?? event.t,
          lagSeconds: extra(event, "lag_seconds") ?? 0,
        };
      }
    }
  }
  return byActor;
}

/**
 * How one authored point fared, or null when the run says nothing about it.
 *
 * ABSENCE IS NEVER A VERDICT, and that is a finding rather than a preference:
 * the runtime produces no arrival for either END of a polyline. It never
 * reports the vertex it starts from (the reporting loop begins one past it),
 * and it never reports the last one either, because the controller converges to
 * a stop AT the final vertex and the progress cursor approaches its arc length
 * without crossing it. Reading absence as "the car never got there" therefore
 * painted the first and last tick of every scheduled actor red on runs that
 * went perfectly — caught by the end-to-end test against the engine, which is
 * why that test exists.
 *
 * So the only verdicts here are the ones the runtime measured: it arrived late,
 * or it did not come near enough to have driven through the point at all.
 */
export function scheduleTickState(
  arrival: ScheduleArrival | null,
): ScheduleTickState | null {
  if (!arrival) return null;
  // Missing the point in SPACE outranks any timing verdict, on-time included:
  // a corner cut clean past the point is the failure lateness cannot see.
  if (
    arrival.closestApproachM !== null &&
    arrival.closestApproachM > SCHEDULE_MISSED_BY_METRES
  ) {
    return "missed";
  }
  if (arrival.latenessSeconds >= SCHEDULE_MISSED_SECONDS) return "missed";
  if (arrival.latenessSeconds > SCHEDULE_LATE_SECONDS) return "late";
  return "on_time";
}

/**
 * `arrived 1.8s late, missed by 1.2m` — the numbers, on the tick's own tooltip.
 *
 * WHEN and WHETHER are independent failures and the tooltip says both when both
 * happened: "on time" next to a corner the car cut is the misreading this whole
 * field exists to prevent.
 */
export function describeScheduleArrival(arrival: ScheduleArrival | null): string {
  if (!arrival) return "";
  const parts: string[] = [];
  const lateness = arrival.latenessSeconds;
  if (lateness > SCHEDULE_LATE_SECONDS) parts.push(`arrived ${formatLag(lateness)}s late`);
  else if (lateness < -SCHEDULE_LATE_SECONDS) {
    parts.push(`arrived ${formatLag(-lateness)}s early`);
  }
  if (
    arrival.closestApproachM !== null &&
    arrival.closestApproachM > SCHEDULE_MISSED_BY_METRES
  ) {
    parts.push(`missed by ${formatMetres(arrival.closestApproachM)}m`);
  }
  if (parts.length === 0) return "arrived on time";
  // "arrived 1.8s late, missed by 1.2m" — never "on time, missed by 1.2m",
  // which is a sentence that argues with itself.
  return parts.join(", ");
}

/** `schedule shifted +2.0s here` — the badge's own words. */
export function describeScheduleShift(shift: ScheduleShift): string {
  return `schedule shifted +${formatLag(shift.lagSeconds)}s here`;
}

function formatLag(seconds: number): string {
  return (Math.round(seconds * 10) / 10).toFixed(1);
}

function formatMetres(metres: number): string {
  return (Math.round(metres * 10) / 10).toFixed(1);
}

/** Actors whose one-shot shift had already fired by `timestampSeconds`. */
export function shiftedActorIdsAt(
  reports: ReadonlyMap<string, ActorScheduleReport>,
  timestampSeconds: number | null,
): Set<string> {
  const shifted = new Set<string>();
  if (timestampSeconds == null || !Number.isFinite(timestampSeconds)) return shifted;
  for (const [actorId, report] of reports) {
    if (report.shift && report.shift.atSeconds <= timestampSeconds) shifted.add(actorId);
  }
  return shifted;
}
