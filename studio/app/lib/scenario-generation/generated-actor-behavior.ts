import {
  migrateActorDraft,
  migrateActorDraftReactionProfile,
  normalizeActorBaseClip,
  type RuntimeScenarioEditorActor,
  type ScenarioEditorActorDraft,
  type TimedInstructions,
} from "@simforge-oss/studio-shared";

export type GeneratedActorBehaviorIntent = {
  timedInstructionIntents?: TimedInstructions["intent"];
  reactiveBraking?: boolean;
  antiPlow?: boolean;
};

/**
 * Finish generator output in the editor's authored behavior dialect.
 *
 * The shared legacy migration is deliberately the only instruction/action
 * mapping used here. Generators may still assemble their deterministic plans
 * through the established intermediate fields, but those fields never escape
 * the generator boundary: emitted actors carry behavior clips and a direct
 * reaction profile instead.
 */
export function finalizeGeneratedActorBehavior(
  actor: ScenarioEditorActorDraft,
  actors: readonly ScenarioEditorActorDraft[],
  intent?: GeneratedActorBehaviorIntent,
): ScenarioEditorActorDraft {
  const migrationSource: RuntimeScenarioEditorActor = {
    ...actor,
    ...(intent?.timedInstructionIntents
      ? {
          timedInstructions: {
            schemaVersion: "simforge.timed-instructions.v1",
            intent: [...intent.timedInstructionIntents],
            resolvedPlan: null,
            status: "draft",
            manifest: [],
          },
        }
      : {}),
    ...(intent?.reactiveBraking ? { reactive_braking: true } : {}),
    ...(intent?.antiPlow ? { anti_plow: true } : {}),
  };
  const migrationActors = actors.map((candidate) =>
    candidate.id === actor.id ? migrationSource : candidate,
  );
  const carriesLegacyWriter =
    (migrationSource.timeline ?? []).length > 0 ||
    (migrationSource.timedInstructions?.intent ?? []).length > 0 ||
    migrationSource.reactive_braking === true ||
    migrationSource.anti_plow === true;
  const migration =
    !actor.behavior || carriesLegacyWriter
      ? migrateActorDraft(migrationSource, { actors: migrationActors })
      : null;
  const behavior = actor.behavior
    ? migration
      ? {
          ...actor.behavior,
          clips: [
            ...actor.behavior.clips,
            ...migration.behavior.clips.filter(
              (clip) =>
                clip.action.kind !== "follow_path" &&
                clip.action.kind !== "walk_path",
            ),
          ],
        }
      : actor.behavior
    : migration!.behavior;
  const reactionProfile =
    actor.reaction_profile ??
    migration?.reaction_profile ??
    migrateActorDraftReactionProfile(migrationSource);
  const {
    timedInstructions: _timedInstructions,
    reactive_braking: _reactiveBraking,
    anti_plow: _antiPlow,
    ...withoutLegacyWriters
  } = actor;
  // `anti_plow` is a WORKER-ONLY passthrough with no reaction-profile equivalent:
  // it is the narrow stopped-vehicles-only scan that keeps a staged crosser
  // assertive THROUGH the conflict, and the worker reads the legacy flag directly
  // (behavior_program.anti_plow_enabled). Stripping it here while the migration
  // rewrote it as `mode: "brake"` inverted the worker's own gate —
  //     anti_plow_only = anti_plow_enabled(spec) and not reactive_braking_enabled(spec)
  // — because the synthesised brake profile makes the second half False. The
  // staged conflict actor then braked like ordinary traffic for the very ego it
  // exists to cross in front of. Measured on the bicyclist families (dib
  // 2026-07-30): the conflict cyclist came to rest 7.6 m from the yielding ego
  // mid-crossing, so the ego could never see it "fully cross". The certified
  // turn-avoidance batch pre-dates the migration and emits `anti_plow: true` with
  // a null profile, which is the shape the worker expects — so carry the flag.
  const antiPlow = migrationSource.anti_plow === true;
  // ...and do not let anti_plow ALONE synthesise the `brake` profile that
  // disqualifies it. `mode: "brake"` is the wide reactive scan; anti_plow is the
  // narrow one, and the schema's own migration note concedes the narrow scan "is
  // NOT representable as a mode". An actor whose only braking writer is anti_plow
  // therefore emits the legacy flag and NO profile — again, the certified shape.
  // An actor that also asked for reactive_braking, or that carries exemptions,
  // keeps its profile.
  const antiPlowOnly =
    antiPlow &&
    migrationSource.reactive_braking !== true &&
    !actor.reaction_profile &&
    (reactionProfile?.exempt_actor_ids ?? []).length === 0;

  return normalizeActorBaseClip({
    ...withoutLegacyWriters,
    timeline: [],
    behavior,
    ...(antiPlow ? { anti_plow: true } : {}),
    // A `mode: "none"` profile is not a reaction, it is the absence of one, and
    // the legacy shape it replaces wrote no field at all for that case. Emitting
    // it would hang an inert profile — with an exempt list it will never use —
    // off every non-reactive generated actor.
    ...(reactionProfile && reactionProfile.mode !== "none" && !antiPlowOnly
      ? { reaction_profile: reactionProfile }
      : {}),
  });
}

/** Finalize a complete actor set together so cross-actor triggers migrate faithfully. */
export function finalizeGeneratedActorBehaviors(
  actors: readonly ScenarioEditorActorDraft[],
  intentsByActorId: Readonly<Record<string, GeneratedActorBehaviorIntent>> = {},
): ScenarioEditorActorDraft[] {
  return actors.map((actor) =>
    finalizeGeneratedActorBehavior(actor, actors, intentsByActorId[actor.id]),
  );
}
