import { getEntry } from "@simforge-oss/asset-catalog";
import {
  carlaCompatibilityFor,
  type CarlaCompatibilityTable,
} from "@/app/lib/scenario/carla-compatibility";

import { userSafeErrorDetail } from "./status/notification-model";

export type SimulationIssueSeverity = "error" | "warning";

export type SimulationIssue = {
  readonly id: string;
  readonly severity: SimulationIssueSeverity;
  readonly title: string;
  readonly detail: string;
  readonly solution?: string;
  readonly readinessSection?: "realism" | "behavior" | "export";
};

const AUTHORING_ISSUE_SOLUTIONS: Readonly<Record<string, string>> = {
  anchor_unconstrained:
    "Choose the road or junction where this scenario should occur, or pin it to one specific map location.",
  axis_conflict:
    "Remove one of the overlapping motion instructions so the actor has only one command controlling that movement at that time.",
  axis_conflict_possible:
    "Review the overlapping motion instructions and adjust their timing so they cannot control the same movement at once.",
  illegal_lane_change:
    "Move the lane change to a section where the neighboring lane is connected and the lane marking permits crossing.",
  metric_subject_missing:
    "Select the main vehicle or actor whose safety and behavior should be measured, then mark it as the scenario subject.",
  non_portable_role:
    "If this scenario must work on other map builds, re-place the actor relative to a road, lane, junction, or anchor. Keep absolute placement only when the scenario is intentionally tied to this map.",
  occluder_dropped:
    "Mark this occluding object as required instead of cosmetic so it cannot be removed when the scene is simplified.",
  pin_site_unresolved:
    "Choose the exact road or junction for this scenario on the selected map. This assigns the missing site and lets SimCloud bind the scenario to a real location.",
  route_disconnected:
    "Edit the actor's route so every segment connects to the next and the route starts from the lane where the actor is placed.",
  runway_insufficient:
    "Move the actor farther back on the approach or shorten the requested maneuver so there is enough road to complete it.",
  speed_over_limit:
    "Lower the actor's requested speed to the mapped speed limit, or choose a road segment whose limit supports that speed.",
  trigger_out_of_clip:
    "Move the trigger inside the scenario timeline or extend the scenario duration so the event can occur.",
  trigger_unbindable:
    "Add a concrete timing or arrival relationship for this actor so SimCloud knows when the interaction should happen.",
};

/** Plain-language operator action for a scenario-model validation finding. */
export function solutionForAuthoringIssue(code: string, path: string): string {
  return AUTHORING_ISSUE_SOLUTIONS[code] ??
    `Open the affected scenario setting (${path}), correct the value described above, and run the preview again.`;
}

/** Guarantees that every issue shown in the readiness drawer has a next step. */
export function solutionForSimulationIssue(issue: SimulationIssue): string {
  if (issue.solution) return issue.solution;

  const searchable = `${issue.id} ${issue.title} ${issue.detail}`.toLowerCase();
  if (searchable.includes("duration")) {
    return "Increase the scenario duration so the timeline has time to play.";
  }
  if (searchable.includes("export") || searchable.includes("approximated") || searchable.includes("not included")) {
    return "Replace the unsupported action with one supported by the selected export format, then generate the export again.";
  }
  if (searchable.includes("collision") || searchable.includes("clearance") || searchable.includes("overlap")) {
    return "Adjust the actors' starting positions, speeds, or timing until the preview has the intended safe spacing.";
  }
  if (searchable.includes("route") || searchable.includes("lane") || searchable.includes("off road")) {
    return "Re-place the actor on a valid driving lane and rebuild its route using connected, legal lane segments.";
  }
  if (searchable.includes("transport") || searchable.includes("network")) {
    return "Check the connection, then retry the preview. If it fails again, copy the debug information and send it to support.";
  }
  if (issue.severity === "error") {
    return "Correct the setting described above, then start the preview again. If it still fails, copy the debug information and send it to support.";
  }
  return "Review the affected scenario setting, make the change described above, and run the preview again to confirm it is resolved.";
}

export function collectSimulationIssues(input: {
  experience?: "simple" | "advanced" | null;
  actorNames?: Readonly<Record<string, string>>;
  preparationMessage?: string | null;
  preparationFailed?: boolean;
  playbackError?: string | null;
  bundle?: { readonly startTime: number; readonly endTime: number } | null;
  materializationNotes?: unknown;
  engineIssues?: unknown;
  transportError?: string | null;
  carlaCompatibilityTable?: CarlaCompatibilityTable | null;
  placedActors?: readonly {
    readonly id: string;
    readonly label: string;
    readonly catalogId: string;
  }[];
}): SimulationIssue[] {
  const issues: SimulationIssue[] = [];
  const preparationFailed = Boolean(
    input.preparationFailed ||
      input.preparationMessage?.toLowerCase().includes("unavailable"),
  );
  if (preparationFailed) {
    issues.push({
      id: "preview",
      severity: "error",
      title: "Browser simulation could not be prepared",
      detail: userSafeErrorDetail(
        input.preparationMessage,
        "The scenario preview failed before a playback controller was created.",
      ),
      solution: "Retry the preview. If it fails again, copy the debug information and send it to support.",
    });
  }
  if (input.playbackError) {
    issues.push({
      id: "playback",
      severity: "error",
      title: "Playback controller failed",
      detail: userSafeErrorDetail(input.playbackError),
      solution: "Restart the preview. If the same error returns, copy the debug information and send it to support.",
    });
  }
  if (
    input.bundle &&
    input.bundle.endTime - input.bundle.startTime <= Number.EPSILON
  ) {
    issues.push({
      id: "duration",
      severity: "error",
      title: "Simulation has no playable duration",
      detail: "Increase the scenario duration so the playhead has time to advance.",
      solution: "Set the scenario end time later than its start time, then restart the preview.",
    });
  }
  for (const [index, note] of materializationNotes(input.materializationNotes).entries()) {
    if (note.impact === "informational") continue;
    const interactionMissed = note.path.includes("interactions");
    issues.push({
      id: `materialization-note-${index}`,
      severity: "warning",
      title: interactionMissed ? "Interaction was not included" : "Scenario detail was approximated",
      detail: note.reason,
      solution: interactionMissed
        ? "Replace the unsupported interaction with a supported action, then rebuild the preview or export."
        : "Review the approximation in the preview. If it changes the intended behavior, simplify or replace the affected action.",
    });
  }
  for (const [index, issue] of engineIssues(input.engineIssues).entries()) {
    if (input.experience === "simple" && [
      "traffic_control_route_unbound",
      "timed_route_turn_unreachable",
      "target_timing_infeasible",
    ].includes(issue.code ?? "")) {
      continue;
    }
    const actorName = actorNameForIssue(issue.path, input.actorNames);
    const timingWarning = issue.code === "timed_route_turn_unreachable"
      || issue.code === "target_timing_infeasible";
    issues.push({
      id: `engine-issue-${index}`,
      severity: issue.severity,
      title: timingWarning
        ? `${actorName ?? "Actor"} may be moving too fast`
        : issue.severity === "error" ? "Scenario could not be validated" : "Check the scenario",
      detail: timingWarning
        ? "Add a point in between or give the actor more time."
        : issue.reason,
      solution: solutionForEngineIssue(issue.code, issue.path),
    });
  }
  if (input.transportError) {
    issues.push({
      id: "transport",
      severity: "error",
      title: "Simulation could not start",
      detail: userSafeErrorDetail(input.transportError),
      solution: "Check the connection and retry. If it fails again, copy the debug information and send it to support.",
    });
  }
  issues.push(...carlaCompatibilityIssues(
    input.carlaCompatibilityTable,
    input.placedActors,
  ));
  return issues;
}

function carlaCompatibilityIssues(
  table: CarlaCompatibilityTable | null | undefined,
  actors: readonly {
    readonly id: string;
    readonly label: string;
    readonly catalogId: string;
  }[] | undefined,
): SimulationIssue[] {
  if (!table || !actors?.length) return [];

  const incompatibleByCatalogId = new Map<string, {
    readonly status: "generated-pack" | "browser-only";
    readonly reason: string;
    readonly actors: Array<{ readonly id: string; readonly label: string }>;
  }>();
  let readyActorCount = 0;

  for (const actor of actors) {
    const compatibility = carlaCompatibilityFor(actor.catalogId, table);
    if (compatibility.status === "native") {
      readyActorCount += 1;
      continue;
    }
    const existing = incompatibleByCatalogId.get(actor.catalogId);
    if (existing) {
      existing.actors.push(actor);
    } else {
      incompatibleByCatalogId.set(actor.catalogId, {
        status: compatibility.status,
        reason: compatibility.reason,
        actors: [actor],
      });
    }
  }

  if (incompatibleByCatalogId.size === 0) return [];

  const incompatibleActorCount = actors.length - readyActorCount;
  const issues: SimulationIssue[] = [{
    id: "carla_compatibility_summary",
    severity: "warning",
    readinessSection: "export",
    title: `${readyActorCount} of ${actors.length} actors are CARLA ready`,
    detail: `${incompatibleActorCount} ${incompatibleActorCount === 1 ? "actor needs" : "actors need"} attention before a CARLA render.`,
    solution: "Review the CARLA compatibility warnings below and replace or prepare each affected model before queueing a CARLA render.",
  }];

  for (const [catalogId, incompatible] of incompatibleByCatalogId) {
    issues.push({
      id: `carla_incompatible:${catalogId}`,
      severity: "warning",
      readinessSection: "export",
      title: `${catalogLabel(catalogId)} will not render in CARLA`,
      detail: `Affected actors: ${actorNames(incompatible.actors)}. Recorded reason: ${incompatible.reason}`,
      solution: incompatible.status === "generated-pack"
        ? "The scenario still runs in browser preview and browser-recorded renders. A CARLA render needs a generated runtime pack for this model."
        : "Gallery uploads have no CARLA blueprint. Swap to a CARLA-ready model for a CARLA render.",
    });
  }

  return issues;
}

function catalogLabel(catalogId: string): string {
  try {
    return getEntry(catalogId).label;
  } catch {
    return catalogId;
  }
}

function actorNames(
  actors: readonly { readonly id: string; readonly label: string }[],
): string {
  const visible = actors.slice(0, 4).map((actor) => actor.label || actor.id);
  const remaining = actors.length - visible.length;
  return remaining > 0
    ? `${visible.join(", ")}, +${remaining} more`
    : visible.join(", ");
}

function materializationNotes(value: unknown): Array<{
  path: string;
  reason: string;
  impact?: "informational";
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.reason !== "string") {
      return [];
    }
    return [{
      path: entry.path,
      reason: entry.reason,
      ...(entry.impact === "informational" ? { impact: "informational" as const } : {}),
    }];
  });
}

function engineIssues(value: unknown): Array<{
  code?: string;
  path: string;
  reason: string;
  severity: SimulationIssueSeverity;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.reason !== "string" ||
      (entry.severity !== "error" && entry.severity !== "warning")
    ) {
      return [];
    }
    return [{
      ...(typeof entry.code === "string" ? { code: entry.code } : {}),
      path: entry.path,
      reason: entry.reason,
      severity: entry.severity,
    }];
  });
}

function solutionForEngineIssue(code: string | undefined, _path: string): string {
  switch (code?.toLowerCase()) {
    case "timed_route_turn_unreachable":
    case "target_timing_infeasible":
      return "Give the actor more time to reach the waypoint, reduce its speed, or widen the turn so the vehicle can physically follow the route.";
    case "illegal_lane_change":
      return "Move the lane change to a connected neighboring lane where the road marking permits crossing.";
    case "curb_crossing":
    case "swept_clearance_neighbor":
    case "swept_violation":
      return "Move or reshape the route so the full vehicle body stays on the roadway and clears curbs, medians, and nearby actors.";
    case "runtime_lane_missing_in_topology":
    case "topology_lane_missing_at_runtime":
    case "semantic_entity_unbound":
      return "Republish the map's runtime and semantic data from the same OpenDRIVE build, then remap the scenario to that published map version.";
    case "runtime_catalog_mismatch":
    case "runtime_xodr_hash_mismatch":
    case "xodr_runtime_mismatch":
      return "Select matching map and runtime builds, or republish the runtime sidecar for the current map version before retrying.";
    default:
      return "Review the highlighted setting, then try the preview again.";
  }
}

function actorNameForIssue(
  path: string,
  actorNames: Readonly<Record<string, string>> | undefined,
): string | null {
  if (!actorNames) return null;
  const actorId = Object.keys(actorNames).find((id) => path.includes(id));
  return actorId ? (actorNames[actorId] ?? null) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
