/**
 * The base clip: an actor's baseline locomotion, expressed as the first clip on
 * its timeline rather than as a separate "navigation mode".
 *
 * ## Why this exists
 *
 * An actor used to be controlled from two places at once. `placement_mode` /
 * `autopilot` / `is_static` decided how it moved by default, and the behavior
 * timeline decided what it did over time. Those are the same question asked
 * twice, and they could disagree: authoring a `cruise` clip on an autopilot
 * actor produced a program the runtime read two ways, which is why
 * `claimAutopilotActorWithClip` had to silently flip `autopilot` off, and why
 * `runtime-submit-validation` rejects a longitudinal clip on a drive-by-points
 * actor at submit time instead of the editor preventing it.
 *
 * The fix is not to delete one surface — a timeline is inherently SPARSE, and
 * something must drive the actor at t=0 and between clips. It is to make the
 * baseline itself a clip. Every actor's program now opens with one, and the
 * timeline becomes the single place motion is authored.
 *
 * ## Explicit identity
 *
 * Normalized clips carry `role: "base"` or `role: "interaction"`. Legacy
 * programs without markers still resolve through the original shape rule on
 * first load, then normalization stamps the resolved identity.
 *
 * ## Direction of compilation
 *
 * Before: mode -> clip (`migrateActorDraftToBehaviorProgram`).
 * Now:    clip -> mode (`placementFieldsFromBaseClip`).
 *
 * The legacy executable fields are still written into the runtime payload, so
 * the Python worker is untouched by this change. They are simply outputs now,
 * not things a user edits.
 */

import {
  ACTOR_ROUTE_ACTION_KINDS,
  BEHAVIOR_ROUTE_ANCHOR_CAP,
  DEFAULT_BEHAVIOR_CLIP_END,
  emptyActorBehaviorProgram,
  migrateActorDraftReactionProfile,
  migrateActorDraftToBehaviorProgram,
  type ActorBehaviorMigrationContext,
  type ActorBehaviorProgram,
  type BehaviorAction,
  type BehaviorActionKind,
  type BehaviorClip,
} from "./scenario-behavior";
import {
  ACTOR_LEGACY_MOTION_KEYS,
  ACTOR_LEGACY_MOTION_SCHEMA_VERSION,
  readLegacyActorMotion,
  type RuntimeScenarioEditorActor,
  type ScenarioEditorActorDraft,
  type ScenarioEditorActorLegacyMotion,
  type ScenarioEditorActorLegacyWire,
} from "./scenario-editor";

/**
 * Actions that can serve as a baseline — the ones that answer "what is this
 * actor doing when nothing else is telling it otherwise".
 *
 * Deliberately narrow. A maneuver like `lane_change` or `stop` is an EVENT: it
 * completes and leaves the actor needing something else to do. Only these run
 * open-endedly, which is what a baseline has to do.
 */
const BASE_LOCOMOTION_ACTION_KINDS = [
  /** Traffic Manager drives it by lane rules. Needs a lane-anchored spawn. */
  "autopilot",
  /**
   * An autopilot intent compiled to explicit lane-graph geometry
   * (`compileAutopilotRoute`). Deterministic and exportable, where `autopilot`
   * is neither. Only ever created by that compile — never derived from legacy
   * fields, so `baseActionForDraft` does not produce it.
   */
  "follow_route",
  /** Our controller holds a target speed along the lane. */
  "cruise",
  /** Drive by points: spacing is the speed. */
  "follow_path",
  /** Walk by points. */
  "walk_path",
  /** Parked: frozen at the authored pose. */
  "hold",
] as const satisfies readonly BehaviorActionKind[];

type BaseLocomotionActionKind =
  (typeof BASE_LOCOMOTION_ACTION_KINDS)[number];

function isBaseLocomotionAction(
  kind: BehaviorActionKind,
): kind is BaseLocomotionActionKind {
  return (BASE_LOCOMOTION_ACTION_KINDS as readonly BehaviorActionKind[]).includes(
    kind,
  );
}

/** The stable id every synthesized base clip gets, so edits are idempotent. */
const BASE_CLIP_ID_PREFIX = "bhv_base_";

export function baseClipId(actorId: string): string {
  return `${BASE_CLIP_ID_PREFIX}${actorId}`;
}

/** Locomotion whose geometry IS the actor's placement path. */
function isPathAction(kind: BehaviorActionKind): boolean {
  return kind === "follow_path" || kind === "walk_path";
}

/**
 * Locomotion whose geometry lives on the ACTOR rather than in the clip, and
 * which is therefore only legal as the baseline. Same list the schema refuses in
 * the interaction layer — imported rather than re-spelled so the two cannot say
 * different things.
 */
function isRouteAction(kind: BehaviorActionKind): boolean {
  return (ACTOR_ROUTE_ACTION_KINDS as readonly BehaviorActionKind[]).includes(kind);
}

/**
 * A clip qualifies as the baseline in one of two ways.
 *
 * The ordinary way is starting the scenario and running open-endedly. `t <= 0`
 * rather than `t === 0` because a legacy migration could quantize a negative
 * authored time, and a baseline that starts before the scenario starts is still
 * the baseline.
 *
 * A PATH clip qualifies whatever its trigger, because its waypoints are the
 * actor's placement path and an actor has exactly one of those. The case that
 * forces this is the conflict walker: its crossing is migrated as a `walk_path`
 * armed by `proximity` to the ego rather than by the clock
 * (`crossWhenClip`/`_maintain_walker_conflict_trigger`). That crossing is its
 * baseline — it is the only motion the walker has. Requiring `at_time` here
 * would fail to see it and prepend a SECOND `walk_path` at t=0, and the walker
 * would step into the road immediately instead of waiting for the car.
 */
function isBaseClipShape(clip: BehaviorClip): boolean {
  if (!isBaseLocomotionAction(clip.action.kind)) return false;
  if (isPathAction(clip.action.kind)) return true;
  return clip.trigger.kind === "at_time" && clip.trigger.t <= 0;
}

/** Index of the actor's base clip, or `-1` when its program has none. */
export function baseClipIndex(program: ActorBehaviorProgram): number {
  const explicitIndex = program.clips.findIndex((clip) => clip.role === "base");
  if (explicitIndex !== -1) return explicitIndex;
  return program.clips.findIndex(isBaseClipShape);
}

/** The actor's base clip, or `null` when its program has none. */
export function baseClip(program: ActorBehaviorProgram): BehaviorClip | null {
  const index = baseClipIndex(program);
  return index === -1 ? null : (program.clips[index] ?? null);
}

/**
 * True when this clip is the one the dock pins at t=0 and refuses to delete.
 * Identity, not shape: a SECOND locomotion clip at t=0 is an ordinary clip.
 */
export function isBaseClip(
  program: ActorBehaviorProgram,
  clipId: string,
): boolean {
  return baseClip(program)?.id === clipId;
}

// ---------------------------------------------------------------------------
// Synthesis: legacy fields -> base clip
// ---------------------------------------------------------------------------

/**
 * The legacy `autopilot` reading of a draft that has not been migrated yet.
 *
 * The schema no longer declares the field (schema-prune, wave 2b), so a value
 * only exists as a passthrough key: on raw stored records the load migration
 * has not touched, on generator-built intermediates that still write the
 * literal, and on runtime actors whose payload boundary compiled it. ABSENT
 * means TRUE — the historical schema default (`.default(true)`), which is what
 * every stored row without the key has always parsed to.
 */
function legacyAutopilotHint(draft: ScenarioEditorActorDraft): boolean {
  return (draft as Record<string, unknown>).autopilot !== false;
}

/**
 * The baseline a draft's legacy control fields describe.
 *
 * This is the same reading `actorNavigationMode` did, plus the waypoint
 * geometry, so an actor authored before base clips existed opens its timeline
 * showing exactly the motion it already had.
 */
export function baseActionForDraft(
  draft: ScenarioEditorActorDraft,
  options?: {
    /** Explicit legacy autopilot value; defaults to the passthrough hint. */
    autopilot?: boolean;
    /** Load-migration mapping: `autopilot: true` + a non-empty `route` becomes
     * a `follow_route` base, because the worker already gives the route
     * precedence and spawns with TM autopilot force-disabled
     * (report-autopilot-concept finding 12) — the boolean was dead weight. */
    routeToFollowRoute?: boolean;
  },
): BehaviorAction {
  if (draft.is_static || draft.kind === "prop") return { kind: "hold" };

  const waypoints = draft.timed_waypoints ?? [];
  const onPath =
    draft.placement_mode === "timed_path" || draft.placement_mode === "path";

  if (draft.kind === "walker") {
    // A walker with no points is inert; `hold` says that honestly rather than
    // synthesizing an empty path the schema would reject (`min(1)`).
    return waypoints.length > 0
      ? {
          kind: "walk_path",
          waypoints: [...waypoints],
          ...(draft.speed_kph != null ? { speed_kph: draft.speed_kph } : {}),
        }
      : { kind: "hold" };
  }

  if (onPath) {
    return waypoints.length > 0
      ? {
          kind: "follow_path",
          waypoints: [...waypoints],
          timed: draft.placement_mode === "timed_path",
        }
      : { kind: "hold" };
  }

  const autopilot = options?.autopilot ?? legacyAutopilotHint(draft);
  if (autopilot) {
    if (options?.routeToFollowRoute) {
      const anchors = (draft.route ?? []).slice(0, BEHAVIOR_ROUTE_ANCHOR_CAP);
      if (anchors.length > 0) return { kind: "follow_route", anchors: [...anchors] };
    }
    // Autopilot's `speed_kph` is deliberately NOT seeded from the draft.
    //
    // Compilation runs on every edit, so a clip that carries a speed OWNS it:
    // the recompile would overwrite any later direct write to `draft.speed_kph`
    // (generators, the .xosc importer, `replaceFromServer`) with the clip's
    // stale copy. Leaving it absent keeps the draft field freely writable until
    // an author states an opinion in the inspector, at which point the clip
    // taking ownership is exactly what was asked for. `cruise` differs because
    // its speed is REQUIRED — a cruise with no speed is not a baseline at all.
    return { kind: "autopilot", enabled: true };
  }
  return { kind: "cruise", speed_kph: draft.speed_kph ?? 0 };
}

/** The baseline clip a draft's legacy control fields describe. */
function baseClipForDraft(draft: ScenarioEditorActorDraft): BehaviorClip {
  return {
    id: baseClipId(draft.id),
    enabled: true,
    trigger: { kind: "at_time", t: 0 },
    end: DEFAULT_BEHAVIOR_CLIP_END,
    action: baseActionForDraft(draft),
  };
}

/**
 * Guarantee the program opens with a baseline, without disturbing one it
 * already has.
 *
 * Idempotent: an actor whose migration already emitted a `follow_path` /
 * `walk_path` clip at t=0 (every drive-by-points actor) is returned untouched,
 * because that clip already IS the baseline. Only autopilot, cruising, and
 * parked actors — whose baseline lived in `placement_mode`/`autopilot` and
 * nowhere else — gain a clip here.
 */
function withBaseClip(
  program: ActorBehaviorProgram,
  draft: ScenarioEditorActorDraft,
): ActorBehaviorProgram {
  if (baseClipIndex(program) !== -1) return program;
  return { ...program, clips: [baseClipForDraft(draft), ...program.clips] };
}

/** Set (or introduce) the actor's baseline action, preserving clip identity. */
export function withBaseAction(
  program: ActorBehaviorProgram,
  draft: ScenarioEditorActorDraft,
  action: BehaviorAction,
): ActorBehaviorProgram {
  const index = baseClipIndex(program);
  if (index === -1) {
    return {
      ...program,
      clips: [{ ...baseClipForDraft(draft), action }, ...program.clips],
    };
  }
  return {
    ...program,
    clips: program.clips.map((clip, position) =>
      position === index ? { ...clip, action } : clip,
    ),
  };
}

// ---------------------------------------------------------------------------
// Compilation: base clip -> legacy executable fields
// ---------------------------------------------------------------------------

/**
 * The compiled placement tuple the runtime still reads. `placement_mode`,
 * `is_static` and `speed_kph` remain declared draft fields; `autopilot` does
 * NOT — the schema prune removed it from the authored surface, so here it is
 * a boundary-only output: the payload build spreads it onto the wire actor and
 * the persistence serializers strip it (`migrateLegacyScenarioEditorActor`).
 */
export type CompiledActorPlacementFields = Partial<
  Pick<ScenarioEditorActorDraft, "placement_mode" | "is_static" | "speed_kph">
> & {
  /** Compiled from the base clip; the wire still carries it. Never persisted. */
  autopilot?: boolean;
};

/**
 * The placement/control fields the worker still reads, derived from the base
 * clip. The inverse of `baseActionForDraft`.
 *
 * `spawn` provenance is deliberately NOT touched: where an actor sits is a
 * placement decision made on the map, and a lane-anchored actor stays
 * lane-anchored through every baseline change. The one exception is `hold`
 * arriving on a `timed_path` actor — that placement mode means "my position is
 * a function of time", which parking contradicts, so it falls back to `point`.
 */
export function placementFieldsFromBaseClip(
  draft: ScenarioEditorActorDraft,
): CompiledActorPlacementFields {
  const program = draft.behavior;
  const action = program ? baseClip(program)?.action : undefined;
  if (!action) return {};

  switch (action.kind) {
    case "autopilot":
      return {
        placement_mode: "road",
        autopilot: action.enabled,
        is_static: false,
        // Absent means "no opinion": keep whatever the draft carries rather
        // than compiling a 0 that the worker would hand the TM as a desired
        // speed of zero.
        ...(action.speed_kph != null ? { speed_kph: action.speed_kph } : {}),
      };
    case "cruise":
      return {
        placement_mode: "road",
        autopilot: false,
        is_static: false,
        speed_kph: action.speed_kph,
      };
    // A compiled route is lane-anchored and driven by our own controller. The
    // anchors themselves are NOT compiled back onto `draft.route`; the compile
    // action writes both together, and one-way flow is what keeps them from
    // drifting.
    case "follow_route":
      return { placement_mode: "road", autopilot: false, is_static: false };
    // Path geometry is deliberately NOT compiled back onto the draft. It flows
    // one way — map -> clip, via `withSyncedBasePath` — because the map is
    // where space is authored. The reverse direction is also unrepresentable:
    // a behavior waypoint's `time` is optional (an untimed path has none) while
    // a draft's `timed_waypoints` requires one, so compiling back would have to
    // invent arrival times.
    case "follow_path":
      return {
        placement_mode: action.timed ? "timed_path" : "path",
        autopilot: false,
        is_static: false,
      };
    case "walk_path":
      return {
        placement_mode: "timed_path",
        autopilot: false,
        is_static: false,
        ...(action.speed_kph != null ? { speed_kph: action.speed_kph } : {}),
      };
    case "hold": {
      // `hold` means two different things, told apart by whether the actor
      // still has a point list at all.
      //
      // An actor in drive-by-points mode that has no points drawn YET holds
      // because it has nowhere to go. It is not parked: it keeps its path
      // placement and stays non-static, so the first point the author drops
      // promotes it straight to `follow_path`. Compiling it to `is_static`
      // here would freeze a car the author is in the middle of routing, and
      // bounce the mode selector back to Parked between the click and the
      // first point.
      //
      // An actor with no list at all is genuinely parked. `timed_path` is the
      // one placement that cannot survive that, because it means "my position
      // is a function of time".
      const onPath =
        draft.placement_mode === "timed_path" || draft.placement_mode === "path";
      if (onPath && draft.timed_waypoints !== undefined) {
        return { autopilot: false, is_static: false };
      }
      return {
        placement_mode:
          draft.placement_mode === "timed_path" ? "point" : draft.placement_mode,
        autopilot: false,
        is_static: true,
        speed_kph: 0,
      };
    }
    default:
      // A non-locomotion action can never be the base clip (`isBaseClipShape`
      // gates on `isBaseLocomotionAction`), so there is nothing to compile.
      return {};
  }
}

/**
 * The draft with its compiled control fields recompiled from its base clip.
 *
 * `autopilot` is deliberately NOT written here. It left the persisted schema
 * (wave 2b), so writing it into every in-memory draft would just re-create the
 * key the serializers then have to strip. It is compiled where it is consumed:
 * the runtime boundary (`expandLegacyWireActor`), which both the CARLA payload
 * build and preview ingestion run.
 */
export function withCompiledBaseClip(
  draft: ScenarioEditorActorDraft,
): ScenarioEditorActorDraft {
  const { autopilot: _autopilot, ...fields } = placementFieldsFromBaseClip(draft);
  return { ...draft, ...fields };
}

/**
 * Set the actor's commanded speed, writing it through to the base clip when the
 * baseline is one that carries a speed of its own.
 *
 * Without this, the detail panel's speed slider and a `cruise` baseline would be
 * the dual-authority problem in miniature: the slider writes `speed_kph`, the
 * recompile immediately overwrites it from the clip, and the control appears
 * not to work. Speed is motion, so the clip owns it and the slider is a second
 * view onto the same field.
 */
export function withBaseSpeed(
  draft: ScenarioEditorActorDraft,
  speedKph: number,
): ScenarioEditorActorDraft {
  const next: ScenarioEditorActorDraft = { ...draft, speed_kph: speedKph };
  const current = next.behavior ? baseClip(next.behavior) : null;
  if (!current) return next;
  const action = current.action;
  // `autopilot` is deliberately absent even though it CAN carry a speed. Its
  // speed is opt-in (`baseActionForDraft` never seeds one) precisely so
  // `draft.speed_kph` stays writable; letting this helper claim it would hand
  // ownership to the clip behind the author's back and start clobbering the
  // very writes the omission protects.
  if (action.kind !== "cruise" && action.kind !== "walk_path") return next;
  return withCompiledBaseClip({
    ...next,
    behavior: withBaseAction(next.behavior!, next, {
      ...action,
      speed_kph: speedKph,
    }),
  });
}

/**
 * Re-derive the base action when the actor's PATH is the thing that moved.
 *
 * Geometry is authored on the map, not in the dock — the runtime requires a
 * `follow_path` clip's waypoints to equal the actor's placement path, which is
 * why the inspector renders them read-only (`MAP_AUTHORED_ACTION_KINDS`). So
 * the split is: the clip owns HOW the actor moves, `timed_waypoints` owns
 * WHERE. Whenever the actor is on a path placement, the clip's copy of the
 * geometry is refreshed from the draft rather than the other way round.
 *
 * This is also what promotes a freshly placed drive-by-points car off `hold`:
 * it has no points yet (and `walk_path`/`follow_path` require at least one), so
 * its baseline starts as a truthful "not going anywhere" and becomes a path the
 * moment the first point lands.
 */
function withSyncedBasePath(
  program: ActorBehaviorProgram,
  draft: ScenarioEditorActorDraft,
): ActorBehaviorProgram {
  const current = baseClip(program);
  const onPath =
    draft.placement_mode === "timed_path" || draft.placement_mode === "path";
  const wasPath =
    current?.action.kind === "follow_path" || current?.action.kind === "walk_path";
  if (!onPath && !wasPath) return program;
  return withBaseAction(program, draft, baseActionForDraft(draft));
}

/**
 * Rewrite a route action that is NOT the baseline into the speed command it
 * actually is.
 *
 * `ActorBehaviorProgramSchema` refuses a route action in the interaction layer:
 * its geometry lives on the actor, so only the base clip may carry it. Stamping
 * roles without honouring that rule is how normalization came to emit drafts its
 * own schema rejects — and because the load path dropped what it could not
 * parse, the actor then disappeared from the editor and the next save deleted it
 * from the database. Measured 2026-07-29: eval scenario
 * `68b1d66e-c43f-4c3b-9f29-446f4443b2ea` persisted with its second car gone,
 * 125 more drafts in dev carrying the same shape.
 *
 * The rewrite is `cruise`, because that is what these clips already do. In BOTH
 * runtimes a non-base `follow_route` sets the commanded speed and clears the
 * stop flag (`applyTimelineClipAction`, `_tick_follow_route`), and a non-base
 * `follow_path` / `walk_path` does the same and lets the path controller resume
 * (`releaseToPlacementPath`, `_begin_follow_path`) — neither re-routes anything,
 * because the polyline was resolved at spawn from the ACTOR. A cruise at the
 * same speed issues the same command.
 *
 * Two differences, both deliberate and both recorded here rather than hidden:
 *
 * - `cruise` has a completion probe and the route actions do not, so a clip
 *   ending on `completion` now ends when the actor reaches the speed instead of
 *   never ending. Anything chained `after_clip` on it was therefore waiting on a
 *   clip that could not end — a dead chain that now fires. The clip ID is
 *   preserved so the chain still resolves.
 * - A route action's speed is optional and a cruise's is required, so the
 *   actor's own commanded speed is used when the clip named none. For a path
 *   actor that IS the speed it was already driving.
 */
function withRouteActionsInTheBaseSlotOnly(
  program: ActorBehaviorProgram,
  draft: ScenarioEditorActorDraft,
  baseIndex: number,
): ActorBehaviorProgram {
  const offenders = program.clips.some(
    (clip, index) => index !== baseIndex && isRouteAction(clip.action.kind),
  );
  if (!offenders) return program;
  return {
    ...program,
    clips: program.clips.map((clip, index) => {
      if (index === baseIndex || !isRouteAction(clip.action.kind)) return clip;
      const speedKph =
        ("speed_kph" in clip.action ? clip.action.speed_kph : undefined) ??
        draft.speed_kph ??
        0;
      return { ...clip, action: { kind: "cruise", speed_kph: speedKph } };
    }),
  };
}

/**
 * Give a draft a baseline, sync its path geometry, and recompile its legacy
 * fields from the result. The normalization entry point.
 *
 * Idempotent by construction, which matters because it runs on every actor on
 * every edit: normalizing an already-normalized draft is a no-op, so nothing
 * drifts and no edit fights the previous one.
 *
 * Its output is also SCHEMA-LEGAL by construction — `ActorBehaviorProgramSchema`
 * accepts everything this returns. That is not a nicety: the load path parses
 * before it normalizes, so a normalization that emits an illegal draft makes the
 * actor unparseable the next time the scenario is opened, and the actor is lost.
 * `base-clip-normalization-round-trip.test.ts` pins it over the whole corpus.
 */
export function normalizeActorBaseClip(
  draft: ScenarioEditorActorDraft,
): ScenarioEditorActorDraft {
  const resolvedProgram = withSyncedBasePath(
    withBaseClip(draft.behavior ?? emptyActorBehaviorProgram(), draft),
    draft,
  );
  const baseIndex = baseClipIndex(resolvedProgram);
  // Before the roles are stamped, not after: stamping `interaction` on a route
  // action is precisely what makes the program illegal.
  const legalProgram = withRouteActionsInTheBaseSlotOnly(
    resolvedProgram,
    draft,
    baseIndex,
  );
  const rolesAreStamped = legalProgram.clips.every(
    (clip, index) =>
      clip.role === (index === baseIndex ? "base" : "interaction"),
  );
  const program = rolesAreStamped
    ? legalProgram
    : {
        ...legalProgram,
        clips: legalProgram.clips.map((clip, index) => ({
          ...clip,
          role: index === baseIndex ? "base" as const : "interaction" as const,
        })),
      };
  return withCompiledBaseClip({ ...draft, behavior: program });
}

// ---------------------------------------------------------------------------
// The ONE legacy migration (schema-prune, wave 2b)
// ---------------------------------------------------------------------------

/**
 * Build the wire-compat envelope out of the legacy keys a record still carries,
 * merged over whatever envelope it already had (a round-tripped pruned draft).
 *
 * A key that is PRESENT top-level overrides the envelope — including presence
 * of an EMPTY timeline, which clears a stale envelope copy — so the raw record
 * is always the most recent statement. `null` means "no residue at all".
 */
function legacyWireEnvelope(
  record: Record<string, unknown>,
  legacy: ScenarioEditorActorLegacyMotion,
  existing: ScenarioEditorActorLegacyWire | undefined,
): ScenarioEditorActorLegacyWire | null {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(record, key);
  const next: ScenarioEditorActorLegacyWire = {
    ...(existing ?? {}),
    schema_version: ACTOR_LEGACY_MOTION_SCHEMA_VERSION,
  };
  if (has("timeline")) {
    if (legacy.timeline.length > 0) next.timeline = legacy.timeline;
    else delete next.timeline;
  }
  if (has("timedInstructions")) {
    if (legacy.timedInstructions !== undefined)
      next.timedInstructions = legacy.timedInstructions;
    else delete next.timedInstructions;
  }
  if (has("reactive_braking")) {
    if (legacy.reactive_braking !== undefined)
      next.reactive_braking = legacy.reactive_braking;
    else delete next.reactive_braking;
  }
  if (has("anti_plow")) {
    if (legacy.anti_plow !== undefined) next.anti_plow = legacy.anti_plow;
    else delete next.anti_plow;
  }
  if (has("collision_target_id")) {
    if (legacy.collision_target_id !== undefined)
      next.collision_target_id = legacy.collision_target_id;
    else delete next.collision_target_id;
  }
  return Object.keys(next).some((key) => key !== "schema_version") ? next : null;
}

/**
 * Migrate one actor record off the legacy authored surface. THE load-time
 * migration (spec: schema-prune step 3) — `draft-normalization.ts` runs it on
 * every loaded and every saved actor, and
 * `scripts/agent/migrate-corpus-to-one-motion.mjs` runs the same function so
 * the durable rewrite cannot drift from the load path.
 *
 * What it does, in order:
 *
 * 1. Parses the legacy keys through the versioned legacy schema
 *    (`readLegacyActorMotion` — same defaults the pruned fields used to carry,
 *    same strictness the old inline declarations had) and STRIPS them.
 * 2. An actor with no behavior program gets the full plan-3.3 migration:
 *    `timeline`/`timedInstructions`/`timed_waypoints` become clips, the
 *    reaction trio becomes `reaction_profile`, and the baseline becomes an
 *    explicit base clip — `autopilot: true` with a route migrates to a
 *    `follow_route` base (the worker already executed exactly that: route
 *    precedence + spawn-time TM disable), `autopilot: true` alone keeps TM
 *    semantics as an `autopilot` base clip (stored Auto actors are NOT
 *    silently converted to cruise), everything else lands where
 *    `baseActionForDraft` always put it.
 * 3. Wire-load-bearing residue (non-empty timeline, timedInstructions, the
 *    reaction trio) moves into the `legacy_wire` envelope so the payload
 *    boundary can keep the worker wire byte-identical.
 * 4. Normalizes the base clip, which recompiles the placement tuple.
 *
 * Idempotent: a pruned draft re-runs to itself, which is what lets the
 * persistence serializers call it defensively on every save.
 */
export function migrateLegacyScenarioEditorActor(
  parsed: ScenarioEditorActorDraft,
  context?: ActorBehaviorMigrationContext,
): ScenarioEditorActorDraft {
  const record = parsed as unknown as Record<string, unknown>;
  const { legacy } = readLegacyActorMotion(record);

  const next = { ...parsed } as ScenarioEditorActorDraft & Record<string, unknown>;
  for (const key of ACTOR_LEGACY_MOTION_KEYS) delete next[key];

  let program = next.behavior;
  if (!program) {
    program = migrateActorDraftToBehaviorProgram(parsed, context);
    const reaction = migrateActorDraftReactionProfile(parsed);
    if (reaction && !next.reaction_profile) next.reaction_profile = reaction;
  }
  // Base synthesis happens HERE, with the legacy `autopilot` value in hand,
  // for BOTH branches: an actor that already had a program can still lack a
  // base-shaped clip (interaction clips only), and pre-prune it was
  // `normalizeActorBaseClip` reading the stored boolean that decided between
  // an `autopilot` and a `cruise` baseline. After the strip that boolean only
  // exists right here.
  if (baseClipIndex(program) === -1) {
    program = {
      ...program,
      clips: [
        {
          id: baseClipId(next.id),
          enabled: true,
          trigger: { kind: "at_time", t: 0 },
          end: DEFAULT_BEHAVIOR_CLIP_END,
          action: baseActionForDraft(next, {
            autopilot: legacy.autopilot,
            routeToFollowRoute: true,
          }),
        },
        ...program.clips,
      ],
    };
  }
  next.behavior = program;

  const envelope = legacyWireEnvelope(record, legacy, parsed.legacy_wire);
  if (envelope) next.legacy_wire = envelope;
  else delete next.legacy_wire;

  return normalizeActorBaseClip(next);
}

/**
 * Expand a pruned actor into the RUNTIME shape both engines consume: the
 * migration's wire-compat envelope back under its ORIGINAL wire spellings,
 * plus the compiled `autopilot` boolean the schema no longer carries.
 *
 * - `timeline` is ALWAYS materialized. The old schema defaulted it to `[]`, so
 *   every actor the worker has ever validated carried the key; the boundary
 *   re-emits it to keep the wire byte-identical.
 * - `autopilot` compiles from the base clip (`placementFieldsFromBaseClip`),
 *   falling back to the legacy passthrough reading for an actor with no base
 *   clip — which is exactly the value the old schema default produced.
 *
 * Runs at BOTH runtime boundaries — the CARLA payload build
 * (`runtimeActorPayload.ts::compileRuntimeActorWireFields`) and preview
 * simulation ingestion — so the two engines keep reading one spec. The
 * envelope itself never ships: provenance the runtime cannot act on does not
 * ride the wire.
 */
/**
 * The compiled `autopilot` value, tolerating the malformed programs preview
 * ingestion can be handed: a spec whose `behavior` the program parser will
 * reject must degrade to the legacy reading here, not crash the whole preview
 * before the parser gets to report it per-actor.
 */
function compiledAutopilotOf(actor: ScenarioEditorActorDraft): boolean | undefined {
  const clips = (actor.behavior as { clips?: unknown } | undefined)?.clips;
  if (!Array.isArray(clips)) return undefined;
  try {
    return placementFieldsFromBaseClip(actor).autopilot;
  } catch {
    return undefined;
  }
}

export function expandLegacyWireActor(
  actor: ScenarioEditorActorDraft,
): RuntimeScenarioEditorActor {
  const envelope = actor.legacy_wire;
  // A key still present TOP-LEVEL (a raw legacy record, a generator
  // intermediate, the ambient expander's members) is the more recent statement
  // and wins over the envelope — the same precedence the migration itself uses.
  const has = (key: string) => Object.prototype.hasOwnProperty.call(actor, key);
  const expanded: RuntimeScenarioEditorActor = {
    ...actor,
    // A pruned actor (the normal case: nothing top-level) gets the value
    // `withCompiledBaseClip` used to write — compiled from the base clip, with
    // the legacy reading (absent = true, the old schema default) only deciding
    // for an actor that has no base clip at all. An EXPLICIT top-level value
    // wins instead, because the worker reads the wire literal as sent and the
    // two engines must keep reading one spec.
    ...(has("autopilot")
      ? {}
      : { autopilot: compiledAutopilotOf(actor) ?? legacyAutopilotHint(actor) }),
    ...(has("timeline")
      ? {}
      : { timeline: envelope?.timeline ? [...envelope.timeline] : [] }),
    ...(!has("timedInstructions") && envelope?.timedInstructions !== undefined
      ? { timedInstructions: envelope.timedInstructions }
      : {}),
    ...(!has("reactive_braking") && envelope?.reactive_braking !== undefined
      ? { reactive_braking: envelope.reactive_braking }
      : {}),
    ...(!has("anti_plow") && envelope?.anti_plow !== undefined
      ? { anti_plow: envelope.anti_plow }
      : {}),
    ...(!has("collision_target_id") && envelope?.collision_target_id !== undefined
      ? { collision_target_id: envelope.collision_target_id }
      : {}),
  };
  delete expanded.legacy_wire;
  return expanded;
}
