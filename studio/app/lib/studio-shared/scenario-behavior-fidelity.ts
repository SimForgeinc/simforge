import type {
  BehaviorClip,
  BehaviorFidelity,
  BehaviorRoadAnchor,
  BehaviorTrigger,
} from "./scenario-behavior";
import type { JunctionSignalPlan } from "./scenario-signals";
import type {
  ScenarioEditorActorDraft,
  TimedInstructionResolvedPlan,
} from "./scenario-editor";

function actorDrivesByPoints(
  actor: Pick<ScenarioEditorActorDraft, "kind" | "placement_mode" | "path_timing">,
): boolean {
  return (
    (actor.placement_mode ?? "road") === "timed_path" &&
    actor.kind !== "walker" &&
    actor.path_timing === "schedule"
  );
}

/**
 * EXPORT FIDELITY — one answer to "what happens to this clip when I export?",
 * shared by the writer and the dock (plan 2026-07-24, principle "export fidelity
 * is visible at authoring time").
 *
 * The writer computes it to stamp its manifest and its diagnostics; the dock
 * computes it to draw the per-clip badge and the header rollup. They MUST agree,
 * which is why this is one pure module and not two similar switches: a badge
 * that says "faithful" over a clip the writer silently dropped is worse than no
 * badge at all.
 *
 * ## The three verdicts
 *
 * * `faithful` — the export emits an OSC construct with the same meaning. A
 *   `cruise` becomes a `SpeedAction`, a `walk_path` becomes a
 *   `FollowTrajectoryAction`; replaying the .xosc reproduces the authored intent.
 * * `approximated` — the export emits a REDUCED form. Something related lands in
 *   the file, but it is not the authored maneuver: a junction turn with no
 *   resolved geometry, a Traffic-Manager handoff, an `intercept` flattened to a
 *   single acquire-position. The scenario still runs; it does not run the same.
 * * `captured_only` — NOTHING is emitted. The maneuver is closed-loop reactive
 *   (`yield_to`, `follow_actor`, `avoid`): its behaviour is a function of what
 *   the other actor does at runtime, and OSC 1.0 has no condition-driven
 *   controller to express that. The only faithful record is a captured CARLA run.
 *
 * The split between the last two is deliberate and load-bearing for the badge.
 * "Approximated" tells an author their scenario exports differently;
 * "captured only" tells them it exports *without this clip at all*, which is a
 * different decision (re-author it, or accept that the export is a partial
 * record). Both are still exports — neither blocks.
 *
 * ## What this module is NOT
 *
 * It never reads a map, a catalog, or a target profile. Fidelity is a property
 * of the AUTHORED clip against the OSC 1.0 / ScenarioRunner 1.0 vocabulary, so
 * the dock can render it on every keystroke without a round trip. Facts that
 * depend on the export target (an unverifiable signal id, a missing `<xodr>`
 * controller) are the writer's DIAGNOSTICS, not fidelity.
 */

export type { BehaviorFidelity };

/** A verdict plus the sentence the badge tooltip shows. */
export type ClipFidelityVerdict = {
  fidelity: BehaviorFidelity;
  /** One sentence, author-facing. Always present, including for `faithful`. */
  reason: string;
};

/**
 * What the clip's owning actor contributes to the verdict.
 *
 * Only two facts matter, and both are about geometry the CLIP does not carry:
 * whether a junction turn can be compiled to a real trajectory, and whether the
 * clip's start is a wall-clock time (which is what lets a scheduled follow-up
 * event — `lane_offset`'s auto-return — be emitted at all).
 *
 * Build it with `fidelityContextForActor`; passing `{}` is legal and yields the
 * conservative answer.
 */
export type ClipFidelityContext = {
  /**
   * True when the actor carries route geometry in WORLD coordinates that a
   * `turn_at_next_intersection` can be compiled against. Without it the turn is
   * a lane-graph instruction with no OSC analogue.
   */
  hasResolvedRouteGeometry?: boolean;
  /**
   * True when the actor opted into drive-by-points (plan 2026-07-25 §3.2).
   *
   * A `follow_path{timed}` clip is byte-identical in the export either way —
   * `placementClip` deliberately emits `timed: true` for every timed path — but
   * what the CARLA runtime DOES with those times is not, and the fidelity
   * reason is the only place that difference is stated to the author.
   */
  drivesByPoints?: boolean;
};

/**
 * Does this road anchor carry the authoritative world position the writer needs?
 *
 * The `world_anchor` doctrine (scenario-editor.ts:41-53) forbids exporting a
 * lane-relative OSC position derived from a road id, because UE5 renumbers road
 * ids across map rebuilds. So a route anchor without `world_anchor` is not a
 * position the writer may emit — it is a cache key it must decline.
 */
function anchorIsResolvable(anchor: BehaviorRoadAnchor): boolean {
  const world = anchor.world_anchor;
  return (
    world != null && Number.isFinite(world.x) && Number.isFinite(world.y)
  );
}

/** `at_time` starts are the only ones a follow-up event can be scheduled from. */
function isScheduledStart(trigger: BehaviorTrigger): boolean {
  return trigger.kind === "at_time";
}

/**
 * The export verdict for one clip.
 *
 * Pure, total over `BehaviorActionKind`, and the single source of truth for both
 * consumers. Adding an action kind fails `tsc` here first, which is the point.
 */
export function clipFidelity(
  clip: BehaviorClip,
  context: ClipFidelityContext = {},
): ClipFidelityVerdict {
  const verdict = actionFidelity(clip, context);
  // A duration is measured from the clip's start, and a condition-started clip
  // has no wall-clock start to measure from — OSC's StopTrigger conditions are
  // absolute simulation time, not "N seconds after this event began". So the
  // duration is dropped and the maneuver runs to completion. That downgrade
  // outranks a faithful ACTION verdict: the clip does export, but it does not
  // stop when the author said it would.
  if (
    verdict.fidelity === "faithful" &&
    clip.end.kind === "duration" &&
    !isScheduledStart(clip.trigger)
  ) {
    return {
      fidelity: "approximated",
      reason: `${verdict.reason} Its ${clip.end.seconds}s duration is dropped, though: this clip starts on a condition, and there is no wall clock to measure the duration from.`,
    };
  }
  return verdict;
}

function actionFidelity(
  clip: BehaviorClip,
  context: ClipFidelityContext,
): ClipFidelityVerdict {
  const action = clip.action;
  switch (action.kind) {
    case "cruise":
    case "creep":
    case "reverse":
      return {
        fidelity: "faithful",
        reason: "Exports as a SpeedAction with shaped dynamics.",
      };
    case "stop":
      return {
        fidelity: "faithful",
        reason: action.deceleration_mps2
          ? "Exports as a SpeedAction to 0 with the authored deceleration rate."
          : "Exports as a SpeedAction to 0 over the authored deceleration window.",
      };
    case "hold":
      return {
        fidelity: "faithful",
        reason: "Exports as a SpeedAction to 0 — OSC 1.0's standstill.",
      };
    case "lane_change":
      return {
        fidelity: "faithful",
        reason: "Exports as a LaneChangeAction one lane to the authored side.",
      };
    case "lane_offset": {
      if (action.return_after_s != null && !isScheduledStart(clip.trigger)) {
        return {
          fidelity: "approximated",
          reason:
            "The lateral offset exports as a LaneOffsetAction, but its auto-return needs a wall-clock start to schedule against — this clip starts on a condition, so the return is dropped.",
        };
      }
      return {
        fidelity: "faithful",
        reason:
          action.return_after_s == null
            ? "Exports as a LaneOffsetAction."
            : "Exports as a LaneOffsetAction plus a scheduled return to lane centre.",
      };
    }
    case "turn_at_next_intersection":
      return context.hasResolvedRouteGeometry
        ? {
            fidelity: "faithful",
            reason:
              "Exports as a FollowTrajectoryAction along the resolved route through the junction.",
          }
        : {
            fidelity: "approximated",
            reason:
              "A junction turn is a lane-graph instruction; without resolved route geometry there is no trajectory to export, so the actor keeps its previous maneuver.",
          };
    case "follow_route": {
      const resolvable = action.anchors.every(anchorIsResolvable);
      return resolvable && context.hasResolvedRouteGeometry !== false
        ? {
            fidelity: "faithful",
            reason:
              "Exports as a FollowTrajectoryAction through the resolved lane-graph corridor.",
          }
        : {
            fidelity: "approximated",
            reason: !resolvable
              ? "Some route anchors carry no world position, and a road id alone is not exportable (road ids renumber across map rebuilds) — the route exports only as far as its resolved anchors."
              : "No resolved lane-graph corridor is available, so the trajectory falls back to the sparse route anchors and may not follow the authored road corridor.",
          };
    }
    case "divert_path":
      // The same OSC action as an untimed `follow_path`, and faithful for the
      // same reason: a trajectory with no time reference is exactly what the
      // author drew. What differs is only WHEN it is issued, and OSC has no
      // trouble with a maneuver partway through a story.
      //
      // Unlike an untimed `follow_path`, nothing is prepended to the vertices:
      // that prepends the SPAWN pose, and a divert starts where the actor
      // happens to be several seconds in. The editor anchors the first drawn
      // point there, so the authored waypoints already begin at the manoeuvre.
      return {
        fidelity: "faithful",
        reason:
          "Exports as a FollowTrajectoryAction with no time reference, issued when the clip fires.",
      };
    case "follow_path":
      if (!action.timed) {
        return {
          fidelity: "faithful",
          reason: "Exports as a FollowTrajectoryAction with no time reference.",
        };
      }
      return {
        fidelity: "faithful",
        reason: context.drivesByPoints
          ? "Exports as a time-referenced FollowTrajectoryAction. CARLA drives the arrival times on the UE5 runtime; on UE4 it falls back to following the same shape at the spacing-implied speed, so holds and lateness are approximate there."
          : "Exports as a time-referenced FollowTrajectoryAction.",
      };
    case "walk_path":
      return {
        fidelity: "faithful",
        reason: "Exports as a time-referenced FollowTrajectoryAction.",
      };
    case "go_to":
      return {
        fidelity: "faithful",
        reason: "Exports as an AcquirePositionAction at the authored point.",
      };
    case "cut_in":
      return {
        fidelity: "faithful",
        reason: action.gap_m
          ? "Exports as a LaneChangeAction gated on a RelativeDistanceCondition to the target."
          : "Exports as a LaneChangeAction toward the target's side.",
      };
    case "intercept":
      return {
        fidelity: "approximated",
        reason:
          "Ramming tracks a moving target every tick; the export flattens it to an AcquirePositionAction at the target's start, so the two only meet if the target holds still.",
      };
    case "autopilot":
      return {
        fidelity: "approximated",
        reason:
          "Traffic-Manager control has no OSC equivalent — the exported actor keeps whatever maneuver was last commanded instead of driving itself.",
      };
    case "yield_to":
      return {
        fidelity: "captured_only",
        reason:
          "Yielding is closed-loop: it depends on where the other actor is each tick, which OSC 1.0 cannot express. Nothing is exported for this clip; a captured CARLA run records it exactly.",
      };
    case "follow_actor":
      return {
        fidelity: "captured_only",
        reason:
          "Following holds a headway to a moving actor every tick, which OSC 1.0 cannot express. Nothing is exported for this clip; a captured CARLA run records it exactly.",
      };
    case "avoid":
      return {
        fidelity: "captured_only",
        reason:
          "Swerving around an obstacle and returning is solved at runtime from live clearance, which OSC 1.0 cannot express. Nothing is exported for this clip; a captured CARLA run records it exactly.",
      };
  }
}

/**
 * The fidelity context for an actor's clips.
 *
 * `hasResolvedRouteGeometry` is true when the actor's own route carries at least
 * two world-anchored waypoints, or when its timed-instruction compiler already
 * resolved a `follow_route` plan with a sampled trace — the two shapes the
 * writer can build a junction-turn trajectory out of.
 */
export function fidelityContextForActor(
  actor: ScenarioEditorActorDraft,
): ClipFidelityContext {
  const drivesByPoints = actorDrivesByPoints(actor);
  const anchored = actor.route.filter((anchor) => anchorIsResolvable(anchor));
  if (anchored.length >= 2) {
    return { hasResolvedRouteGeometry: true, drivesByPoints };
  }
  // Legacy timed instructions no longer live on the schema; a raw record (or
  // a runtime actor whose boundary expansion re-materialized them, or the
  // migration's `legacy_wire` envelope) can still carry a resolved plan.
  const record = actor as Record<string, unknown>;
  const timedInstructions = (record.timedInstructions ??
    actor.legacy_wire?.timedInstructions) as
    | { resolvedPlan?: TimedInstructionResolvedPlan | null }
    | undefined;
  const plan = timedInstructions?.resolvedPlan;
  if (plan?.kind === "follow_route" && plan.traceSamples.length >= 2) {
    return { hasResolvedRouteGeometry: true, drivesByPoints };
  }
  return { hasResolvedRouteGeometry: false, drivesByPoints };
}

/**
 * A signal plan's export verdict.
 *
 * Unlike a clip, this depends on the MAP: a `TrafficSignalStateAction` naming a
 * signal id the map does not carry as a dynamic light makes esmini hard-quit, so
 * the writer refuses to emit an id it cannot verify. `verifiedSignalIds` is that
 * verification set — pass the writer's signal catalog, or omit it to get the
 * verdict for "no catalog available", which is `approximated` for every mode
 * that commands anything.
 *
 * `map_default` is always `faithful`: it commands nothing, so nothing is lost.
 */
export function signalPlanFidelity(
  plan: Pick<JunctionSignalPlan, "mode" | "movements">,
  verifiedSignalIds?: ReadonlySet<string>,
): ClipFidelityVerdict {
  if (plan.mode === "map_default") {
    return {
      fidelity: "faithful",
      reason: "The junction runs the map's own signal timing; nothing is exported.",
    };
  }
  const referenced = plan.movements.flatMap((movement) => movement.signal_ids);
  if (referenced.length === 0) {
    return {
      fidelity: "approximated",
      reason:
        "No movement of this junction resolves to an OpenDRIVE signal id, so there is nothing for a TrafficSignalStateAction to name.",
    };
  }
  if (!verifiedSignalIds) {
    return {
      fidelity: "approximated",
      reason:
        "This junction's signal ids could not be checked against the map — an unverifiable id makes esmini quit, so the export omits them.",
    };
  }
  const unverified = referenced.filter((id) => !verifiedSignalIds.has(id));
  if (unverified.length === referenced.length) {
    return {
      fidelity: "approximated",
      reason:
        "None of this junction's signal ids are dynamic traffic lights in the map, so no signal state is exported.",
    };
  }
  if (unverified.length > 0) {
    return {
      fidelity: "approximated",
      reason: `${unverified.length} of this junction's ${referenced.length} signal ids are not dynamic traffic lights in the map and are omitted from the export.`,
    };
  }
  return {
    fidelity: "faithful",
    reason:
      "Every movement resolves to a dynamic traffic light; the plan exports as per-signal TrafficSignalStateActions.",
  };
}

/** Per-verdict counts, for the dock header rollup and the export manifest. */
export type FidelitySummary = {
  faithful: number;
  approximated: number;
  captured_only: number;
};

export function emptyFidelitySummary(): FidelitySummary {
  return { faithful: 0, approximated: 0, captured_only: 0 };
}

export function summarizeFidelity(
  verdicts: Iterable<BehaviorFidelity | ClipFidelityVerdict>,
): FidelitySummary {
  const summary = emptyFidelitySummary();
  for (const entry of verdicts) {
    const fidelity = typeof entry === "string" ? entry : entry.fidelity;
    summary[fidelity] += 1;
  }
  return summary;
}

/** True when anything in the summary would surprise an author at export time. */
export function hasFidelityLoss(summary: FidelitySummary): boolean {
  return summary.approximated > 0 || summary.captured_only > 0;
}

export const BEHAVIOR_FIDELITY_LABELS: Record<BehaviorFidelity, string> = {
  faithful: "Exports faithfully",
  approximated: "Exports approximated",
  captured_only: "Not exported — captured runs only",
};

/** Short glyph label for the dock badge (kept to one or two characters). */
export const BEHAVIOR_FIDELITY_GLYPHS: Record<BehaviorFidelity, string> = {
  faithful: "●",
  approximated: "◐",
  captured_only: "○",
};
