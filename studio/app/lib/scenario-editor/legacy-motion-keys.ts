import type { ScenarioEditorActorDraft } from "@simcloud/shared";

/**
 * The motion fields the one-motion model deletes, and whether a draft still
 * carries them.
 *
 * ## Why a runtime check and not just a schema removal
 *
 * `ScenarioEditorActorDraftSchema` is `.passthrough()`. Deleting a field from the
 * schema neither strips it from stored JSON nor stops a writer from sending it —
 * the key simply survives unvalidated, which is worse than before, because now
 * nothing agrees on what it means. So the deletion needs an assertion at the
 * write boundary, and that assertion has to exist BEFORE the fields go
 * (`plans/2026-07-29-one-motion-model.md` §2.5, Phase G).
 *
 * ## Why it only reports, for now
 *
 * Every one of these keys is still what the worker reads: payload build
 * materializes them from the base clip on the way out
 * (`legacyPlacementProjection`). Rejecting a PUT that carries them today would
 * reject every draft in the corpus. So this ships silent for one release — it
 * counts what is still being written, per key, so the reject can be turned on
 * against evidence rather than hope, and so a writer nobody remembered surfaces
 * as a number instead of as a 422 in someone's editor.
 *
 * `enforce` is the switch. It stays `false` until the corpus is migrated (Phase
 * E) and the worker no longer needs the fields.
 */

/**
 * Deleted by §2.5. `spawn`, `spawn_point` and `spawn_yaw` are NOT here: a
 * placement is still a placement, and the world point remains the walker/prop
 * authority.
 *
 * The schema-prune keys (wave 2b) are the second block: `autopilot`,
 * `timeline`, `compiled_route_stamp` were already listed; `timedInstructions`,
 * the reaction trio and `notes` joined when the load-time migration started
 * stripping them. A write carrying any of them is RESIDUAL — the migration
 * converts and strips it on the way through, so the count here is "writers
 * still speaking the old dialect", not "data at risk".
 */
export const LEGACY_MOTION_KEYS = [
  "placement_mode",
  "autopilot",
  "is_static",
  "route",
  "route_direction",
  "destination",
  "destination_point",
  "path_placement",
  "path_timing",
  "path_cadence_s",
  "path_spacing",
  "compiled_route_stamp",
  "timeline",
  "timedInstructions",
  "reactive_braking",
  "anti_plow",
  "collision_target_id",
  "notes",
] as const;

export type LegacyMotionKey = (typeof LEGACY_MOTION_KEYS)[number];

export type LegacyMotionKeyReport = {
  /** How many actors carried each key. Keys nobody sent are absent. */
  counts: Partial<Record<LegacyMotionKey, number>>;
  /** Actors carrying at least one, by id, capped so a log line stays a log line. */
  actorIds: string[];
  /**
   * Generated ambient actors that were not examined. Reported, not silent: an
   * exemption nobody can see the size of is indistinguishable from a bug.
   */
  generatedSkipped: number;
  total: number;
};

/**
 * A default is not an assertion.
 *
 * Most of these keys have schema defaults, so a normalized draft carries them
 * whether or not the client sent them — `placement_mode: "road"`, `route: []`,
 * `autopilot: true`. Counting those would report the schema to itself. What
 * matters is a MEANINGFUL value: a non-empty route, an explicit mode, a stamp.
 */
function carriesMeaningfully(actor: Record<string, unknown>, key: LegacyMotionKey): boolean {
  const value = actor[key];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (key === "autopilot") return value === true;
  if (key === "is_static") return value === true;
  // `placement_mode: "road"` is the default and says nothing; any other mode is
  // an author having picked one of the shapes this model removes.
  if (key === "placement_mode") return value !== "road";
  // Same for the two other enum-with-a-default fields. `route_direction:
  // "forward"` is on every actor ever written and would flag the whole corpus.
  if (key === "route_direction") return value !== "forward";
  if (key === "path_timing") return value !== "ordering";
  return true;
}

/**
 * Machine-generated ambient traffic, which carries these keys as OUTPUT rather
 * than as authored intent.
 *
 * 112 of the corpus's actors are a traffic region's expansion that got saved —
 * `carla-traffic:unified:vehicle:N`, each stamped `ambient_generated: true`. Every
 * one carries `autopilot: true`, and that is correct: §2.4 keeps the Traffic
 * Manager driving background traffic, because statistical behaviour is right for
 * background and only ever wrong as authored intent.
 *
 * Counting them would make Phase G unflippable for a reason that has nothing to do
 * with authoring. Worse, "fixing" them means reconstructing a region from twelve
 * resolved spawn points and re-expanding it, which produces a statistically
 * similar but DIFFERENT scene — and the twelve scenarios involved (H2's density
 * sweep, H4's region polygon, C1's heavy ambient) exist precisely because of the
 * density they have. That is a re-author, not a migration, and it is not
 * something this check should be able to force.
 *
 * So the assertion is about what an AUTHOR writes. Generated actors are exempt,
 * and the report says how many were skipped so the exemption cannot quietly grow
 * into a hole.
 */
function isGenerated(actor: Record<string, unknown>): boolean {
  return actor.ambient_generated === true;
}

export function collectLegacyMotionKeys(
  actors: readonly ScenarioEditorActorDraft[] | readonly Record<string, unknown>[],
): LegacyMotionKeyReport {
  const counts: Partial<Record<LegacyMotionKey, number>> = {};
  const actorIds: string[] = [];
  let generatedSkipped = 0;
  for (const raw of actors) {
    const actor = raw as Record<string, unknown>;
    if (isGenerated(actor)) {
      generatedSkipped += 1;
      continue;
    }
    let carries = false;
    for (const key of LEGACY_MOTION_KEYS) {
      if (!carriesMeaningfully(actor, key)) continue;
      counts[key] = (counts[key] ?? 0) + 1;
      carries = true;
    }
    if (carries && actorIds.length < 20) {
      actorIds.push(typeof actor.id === "string" ? actor.id : "<no id>");
    }
  }
  return {
    counts,
    actorIds,
    generatedSkipped,
    total: Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0),
  };
}

/**
 * Whether to REJECT a draft carrying them, rather than just count.
 *
 * Flipping this is the last step of Phase G and it needs two things first: the
 * corpus migrated off the fields (Phase E) and a worker release that no longer
 * reads them. Env-overridable so the assertion can be exercised end to end in a
 * test environment before it is true everywhere.
 */
export function enforceLegacyMotionKeys(): boolean {
  return process.env.SIMFORGE_ENFORCE_NO_LEGACY_MOTION_KEYS === "1";
}
