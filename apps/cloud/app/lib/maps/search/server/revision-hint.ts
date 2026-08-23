import type { ScenarioValidationReport } from "@simcloud/shared";

/**
 * Turn a failing kinematic-validation report into ONE concrete
 * instruction the LLM can act on in the revise pass (step f2 of the
 * map-search playbook).
 *
 * By the time this runs, deterministic Tier-1 (speed grid) and Tier-2
 * (pedestrian timing solve) auto-repair have already had their shot — a
 * fail here means the miss is something only a *different LLM choice*
 * can fix. So we name the specific lever to pull (location vs. approach
 * vs. conflict-shape), prioritised most-fundamental-first, rather than
 * handing the model raw failure prose and hoping it infers the fix.
 *
 * Returns null when the verdict is a pass (nothing to revise).
 */
export function buildRevisionHint(
  validation: ScenarioValidationReport,
): string | null {
  if (validation.verdict !== "fail") return null;
  const failed = (id: ScenarioValidationReport["checks"][number]["id"]) =>
    validation.checks.find((c) => c.id === id && c.status === "fail");

  // Priority: an unresolvable route is the most fundamental; a region
  // miss is a placement problem; a plain conflict miss (post auto-repair)
  // is a conflict-shape problem.
  if (failed("route_resolvable")) {
    return "No drivable route resolved for a principal actor at this location. Re-propose with a different `documentId` — a junction or street with connected drivable lanes. Adjusting speed, family, or aggressiveness will NOT help.";
  }
  const region = failed("collision_in_region");
  if (region) {
    return `The collision landed ${
      region.measuredValue != null ? `${region.measuredValue.toFixed(0)} m ` : ""
    }away from the requested location${
      region.threshold != null ? ` (max ${region.threshold} m)` : ""
    }. Re-propose with approach streets that feed straight into the location (set or change \`approachStreetIds\`), or pick a tighter junction \`documentId\`.`;
  }
  if (failed("collision_occurred")) {
    return validation.family === "pedestrian_crossing"
      ? "Ego and the pedestrian still miss after deterministic timing auto-repair — the ego most likely does not drive through this crosswalk. Re-propose at a different crosswalk `documentId` where an approach street feeds straight through it, or pass a simpler `approachStreetIds`."
      : "The two actors never make contact even after speed auto-repair — their planned paths don't intersect. Re-propose with a different `npcVehicleType` or `aggressivenessLabel`, or a different approach (`approachStreetIds`), so the routes actually cross.";
  }
  return (
    validation.reasons[0] ??
    "The drafted scenario did not produce the requested collision near the location. Revise the family, NPC aggressiveness, NPC vehicle type, or the chosen approach/anchor and call propose_scenario_draft again."
  );
}
