/**
 * Collision-scenario archetype catalog.
 *
 * The AI Search panel turns natural-language prompts into populated scenario
 * drafts by:
 *   1. picking a `CollisionFamily` for the user's prompt
 *   2. resolving a map location (`MapSearchDocument`) the family fits on
 *   3. instantiating `actorRecipe` entries against that location's geometry
 *
 * Everything family-specific lives here so the LLM service, the draft
 * builder, and (eventually) the editor share a single source of truth. The
 * shape stays declarative on purpose: an entry is a recipe, not a function,
 * so the same data drives the LLM tool schema, the draft builder, and any
 * future variant generator.
 *
 * v1 covered three families — `unprotected_left_turn`, `unsafe_cut_in`,
 * `pedestrian_crossing`; the CA AV Collision corpus pass added three more.
 * Every one of those plants an actual contact. The near-miss families
 * (`near_miss_cut_in`, `near_miss_pedestrian`) reuse the same geometry
 * recipes but are timed to produce a close pass instead, and are graded
 * against `expectedOutcome: "near_miss"`. Adding more is a content-only
 * change to this file.
 */
import type {
  EnvironmentPresetLighting,
  EnvironmentPresetWeather,
  EnvironmentPresetRoadSurface,
} from "../environment-preset";
import type { ScenarioEditorTimelineAction } from "../scenario-editor";
import { SCENARIO_TIMING } from "../scenario-timing";

const DEFAULT_COLLISION_DURATION_SECONDS = SCENARIO_TIMING.defaultDurationSeconds;

// ── Family ids ──────────────────────────────────────────────────────────────

/**
 * Families that plant an actual contact. These are the crash-derived
 * archetypes: each one is either a v1 hand-authored family or was mined from
 * the CA AV Collision corpus, and each is labelable against a real crash
 * narrative.
 */
export const CONTACT_FAMILY_IDS = [
  "unprotected_left_turn",
  "unsafe_cut_in",
  "pedestrian_crossing",
  // Added from the CA AV Collision corpus coverage pass
  // Percentages below are share-of-corpus among 646 real geocoded AV crashes.
  "rear_end", // 40% of the corpus — the single most common real AV crash
  "sideswipe", // ~7% — same-direction lateral contact
  "right_turn_hook", // ~3% — right-hook, cyclist-prone
] as const;

export type ContactFamilyId = (typeof CONTACT_FAMILY_IDS)[number];

/**
 * Families that plant a close pass with NO contact. Deliberately kept
 * separate from `CONTACT_FAMILY_IDS`: a crash corpus contains only contact
 * events, so no real narrative can ever be labeled with one of these, and the
 * offline family classifier must not be asked to cover them.
 */
export const NEAR_MISS_FAMILY_IDS = [
  "near_miss_cut_in", // close-pass variant of `unsafe_cut_in`
  "near_miss_pedestrian", // close-pass variant of `pedestrian_crossing`
] as const;

export type NearMissFamilyId = (typeof NEAR_MISS_FAMILY_IDS)[number];

/** The full family catalog the LLM picks from and the draft builder resolves. */
export const COLLISION_FAMILY_IDS = [
  ...CONTACT_FAMILY_IDS,
  ...NEAR_MISS_FAMILY_IDS,
] as const;

export type CollisionFamilyId = (typeof COLLISION_FAMILY_IDS)[number];

/** Narrowing guard so callers can branch on the graded outcome by id alone. */
export function isNearMissFamily(id: CollisionFamilyId): id is NearMissFamilyId {
  return (NEAR_MISS_FAMILY_IDS as readonly string[]).includes(id);
}

// ── Scenario timing (uniform across families) ───────────────────────────────

/** Total simulated scenario length. ~10s of run-up to the collision,
 *  ~10s post-collision settle. */
export const SCENARIO_DURATION_S = DEFAULT_COLLISION_DURATION_SECONDS;
/** Planned time-of-impact: every actor is back-calculated so the
 *  collision lands here. Uniform — the planner no longer scales arrival
 *  by a per-family fraction of the duration. */
export const TARGET_COLLISION_TIME_S = 10;

/**
 * What the scripted esmini rollout should produce for each family, threaded
 * into the validation verdict. Every contact family plants a collision course
 * (the AV's job in CARLA is to avoid it — including the pedestrian "yield"
 * family, whose kinematic validator also expects a contact). The near-miss
 * families plant the same conflict but time it to resolve without contact, so
 * `verdictFromMetrics` grades them the other way: a contact FAILS and a
 * closest approach inside the near-miss band passes.
 */
export const FAMILY_ESMINI_OUTCOME: Record<CollisionFamilyId, "collision" | "near_miss"> = {
  unprotected_left_turn: "collision",
  unsafe_cut_in: "collision",
  pedestrian_crossing: "collision",
  rear_end: "collision",
  sideswipe: "collision",
  right_turn_hook: "collision",
  near_miss_cut_in: "near_miss",
  near_miss_pedestrian: "near_miss",
};

// ── Slot defaults ───────────────────────────────────────────────────────────

export const NPC_AGGRESSIVENESS_VALUES = ["aggressive", "steady", "hesitant"] as const;
export type NpcAggressiveness = (typeof NPC_AGGRESSIVENESS_VALUES)[number];

/**
 * Required-geometry predicate describing what kind of map document a family
 * can be instantiated on. The draft builder consults this before composing
 * actors so the LLM can't request a left-turn collision at a parking lot.
 *
 * `documentFamilies` is an OR (any of the listed object families match).
 * `requireTagAnyOf` is an OR within the *human-readable* scenarioTags or
 * exactMapAttributes string blob — values are matched case-insensitive
 * substring. `null` means no tag requirement (location-shape alone suffices).
 */
export interface CollisionRequiredGeometry {
  documentFamilies: ReadonlyArray<"junction" | "street" | "poi" | "address">;
  requireTagAnyOf: readonly string[] | null;
}

/**
 * One slot the LLM should fill before drafting. `defaultValue` lets the
 * service skip asking when the prompt is non-ambiguous.
 */
export interface CollisionClarificationSlot {
  id: "npc_aggressiveness" | "weather" | "lighting" | "actor_count";
  question: string;
  /** Suggested chip labels rendered as `followUps` in the assistant turn. */
  options: readonly string[];
  /** Used silently when the LLM decides the prompt is specific enough. */
  defaultValue: string;
}

// ── Actor recipe ────────────────────────────────────────────────────────────

/**
 * Anchor strategy — how the draft builder picks a spawn segment for this
 * role given the resolved geometry report.
 *
 *   - `spawn_on_approach_lane`: a drivable segment on one of the junction's
 *      approach roads, picked closest to the chosen document.
 *   - `spawn_on_opposing_lane`: the inverse-direction lane on the same
 *      approach road (used for oncoming traffic in left-turn scenarios).
 *   - `spawn_on_adjacent_lane`: same road as subject, a different lane index
 *      (used for cut-in NPCs).
 *   - `spawn_on_pedestrian_area`: a sidewalk/walkable lane near the chosen
 *      document, or — when the document is itself a pedestrian-bearing POI
 *      (crosswalk, sidewalk, bus stop, transit stop, parking lot/cluster,
 *      street parking, school/hospital/retail/restaurant/hotel/airport/mall/
 *      gas-station frontage, or a "Pedestrian At …" occlusion candidate) —
 *      a point-placement at the document's projected center. Used by the
 *      pedestrian family for crossing actors.
 *   - `spawn_on_same_lane_behind`: same lane as subject, further upstream
 *      (lead-vehicle / following NPCs).
 */
export const COLLISION_ANCHOR_STRATEGIES = [
  "spawn_on_approach_lane",
  "spawn_on_opposing_lane",
  "spawn_on_adjacent_lane",
  "spawn_on_pedestrian_area",
  "spawn_on_same_lane_behind",
] as const;
export type CollisionAnchorStrategy = (typeof COLLISION_ANCHOR_STRATEGIES)[number];

/**
 * One timeline clip template. Times are seconds since scenario start; the
 * collision is expected ~10 s in (15 s duration leaves runway for entry +
 * post-collision settling).
 */
export interface CollisionTimelineClipTemplate {
  start_time: number;
  end_time?: number;
  action: ScenarioEditorTimelineAction;
  /** Resolved at build time from the actor's role default + family modifier. */
  target_speed_kph?: number;
  /** Filled with the matching role's actor id at build time. */
  target_role?: CollisionActorRole;
  /**
   * Standoff (metres) the pursuit actions hold from `target_role`. Only
   * meaningful for `chase_actor` / `yield_to_actor`; `ram_actor` pins it to
   * zero (drive INTO the target) regardless. This is the knob that turns a
   * converging trajectory into a close pass, so every near-miss family sets
   * it to its `nearMissMargin.targetMissDistanceM`.
   */
  following_distance_m?: number;
}

export const COLLISION_ACTOR_ROLES = [
  "subject",
  "oncoming",
  "lead",
  "adjacent",
  "crossing_pedestrian",
  // Trailing vehicle approaching subject from directly behind in the same lane
  // (rear_end family). Distinct from `lead` (a vehicle ahead of subject).
  "trailing",
] as const;
export type CollisionActorRole = (typeof COLLISION_ACTOR_ROLES)[number];

export interface CollisionActorRecipe {
  role: CollisionActorRole;
  kind: "vehicle" | "walker";
  /** "subject" maps to the scenario subject; everything else is `traffic` / `pedestrian`. */
  scenarioRole: "subject" | "traffic" | "pedestrian";
  /** Blueprint string passed to the editor draft. */
  blueprint: string;
  anchorStrategy: CollisionAnchorStrategy;
  /** Per-clip speed multiplier when family aggressiveness applies. */
  aggressivenessAppliesTo: "speed" | "none";
  baseSpeedKph: number;
  /** Whether CARLA autopilot drives this actor (vs. scripted-only). */
  autopilot: boolean;
  /** Timeline clip templates. */
  timeline: readonly CollisionTimelineClipTemplate[];
}

// ── Near-miss margin ────────────────────────────────────────────────────────

/**
 * How wide a near-miss family's "miss" is meant to be. Present on exactly the
 * families whose `FAMILY_ESMINI_OUTCOME` is `near_miss`.
 *
 * The band is fixed by the esmini grader (`verdictFromMetrics`), which for a
 * `near_miss` intent passes only when the subject's closest approach is ≤
 * `nearMissMaxMeters` AND no contact fired. Below `DEFAULT_CONTACT_GRACE_M`
 * (1 m) the grader treats the pass as a grazing contact, so an authored miss
 * has to land strictly inside (1 m, 5 m] — a narrow target, which is why the
 * near-miss families are authored at lower speeds than their contact parents
 * (see each template's speed comment).
 */
export interface NearMissMargin {
  /**
   * Seconds by which the conflicting actor clears the conflict point before
   * subject reaches it. The planner back-calculates the actor's spawn from
   * `arrivalTime − conflictLeadTimeS` instead of the shared arrival, so the
   * two paths cross with a gap rather than converging on the same instant.
   *
   * Authored so `conflictLeadTimeS × subjectSpeed` lands inside
   * [`targetMissDistanceM`, `maxMissDistanceM`] — i.e. the planned temporal
   * offset alone already produces a gradeable miss, before the runtime
   * standoff (`following_distance_m`) holds it there.
   */
  conflictLeadTimeS: number;
  /** Planned closest approach in metres — what the rollout should produce. */
  targetMissDistanceM: number;
  /**
   * Upper bound handed to `verdictFromMetrics` as `nearMissMaxMeters`. A
   * wider pass means the actors never really conflicted and the scenario is
   * degenerate, so the run fails rather than silently passing as "avoided".
   */
  maxMissDistanceM: number;
}

// ── Family entry ────────────────────────────────────────────────────────────

export interface CollisionFamilyTemplate {
  id: CollisionFamilyId;
  /** Short human-readable label for the draft display name + LLM prompt cue. */
  label: string;
  /** One-line cue the LLM uses to match prompts → family. */
  promptCue: string;
  requiredGeometry: CollisionRequiredGeometry;
  clarificationSlots: readonly CollisionClarificationSlot[];
  actorRecipe: readonly CollisionActorRecipe[];
  /** Default environment if the LLM didn't pick one. */
  defaultEnvironment: {
    lighting: EnvironmentPresetLighting;
    weather: EnvironmentPresetWeather;
    roadSurface: EnvironmentPresetRoadSurface;
  };
  /** Written into the draft's `metadata.notes` for the editor to surface. */
  successCondition: string;
  /** Scenario duration in seconds. 15 s is the v1 default across families. */
  durationSeconds: number;
  /**
   * Optional per-family absolute timing window for the kinematic validator's
   * `collision_occurred` check. When present, the validator accepts a contact
   * iff `min ≤ contactTimeS ≤ max` (instead of the default ±COLLISION_ARRIVAL_TOL_S
   * relative tolerance). `ideal` is the target arrival time passed to the planner.
   *
   * For near-miss families the same window bounds the moment of CLOSEST
   * APPROACH rather than contact — the conflict is still planned for `ideal`,
   * the actors just cross it with a gap. Set for `pedestrian_crossing` and
   * both near-miss families; the remaining contact families leave this
   * undefined and keep legacy behavior unchanged.
   */
  collisionTimeWindow?: { ideal: number; min: number; max: number };
  /**
   * Set on exactly the families that grade as `near_miss`. Carries the miss
   * distance the rollout should produce and the arrival offset the planner
   * uses to produce it. Undefined for every contact family.
   */
  nearMissMargin?: NearMissMargin;
}

// ── The three v1 families ───────────────────────────────────────────────────

const NPC_AGGRESSIVENESS_SLOT: CollisionClarificationSlot = {
  id: "npc_aggressiveness",
  question:
    "How aggressive should the conflicting actor be — does it speed up, hold steady, or hesitate?",
  options: [
    "Aggressive — speeds up",
    "Steady — forces a tight gap",
    "Hesitant — late braking",
  ],
  defaultValue: "Steady — forces a tight gap",
};

export const COLLISION_TEMPLATES: Record<CollisionFamilyId, CollisionFamilyTemplate> = {
  unprotected_left_turn: {
    id: "unprotected_left_turn",
    label: "Unprotected left turn",
    promptCue:
      "subject turns left across oncoming traffic at an intersection without a protected phase — classic permissive-left conflict",
    requiredGeometry: {
      documentFamilies: ["junction"],
      requireTagAnyOf: null,
    },
    clarificationSlots: [NPC_AGGRESSIVENESS_SLOT],
    actorRecipe: [
      {
        role: "subject",
        kind: "vehicle",
        scenarioRole: "subject",
        blueprint: "vehicle.lincoln.mkz",
        anchorStrategy: "spawn_on_approach_lane",
        aggressivenessAppliesTo: "none",
        baseSpeedKph: 40,
        // Autopilot lets CARLA's traffic manager drive the subject forward on
        // its approach lane. The active editor/runtime contract no longer
        // stores turn primitives; the oncoming actor produces the conflict.
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: 10, action: "set_speed", target_speed_kph: 40 },
        ],
      },
      {
        role: "oncoming",
        kind: "vehicle",
        scenarioRole: "traffic",
        blueprint: "vehicle.dodge.charger",
        anchorStrategy: "spawn_on_opposing_lane",
        aggressivenessAppliesTo: "speed",
        baseSpeedKph: 55,
        autopilot: true,
        // `ram_actor` actively drives the oncoming vehicle at the subject's
        // position — the converging trajectory CARLA needs to actually
        // produce a collision. Speed honors the aggressiveness multiplier
        // on the same baseSpeedKph used to spawn it.
        timeline: [
          {
            start_time: 0,
            end_time: DEFAULT_COLLISION_DURATION_SECONDS,
            action: "ram_actor",
            target_role: "subject",
            target_speed_kph: 55,
          },
        ],
      },
    ],
    defaultEnvironment: {
      lighting: "AFTERNOON",
      weather: "CLEAR_SKY",
      roadSurface: "DRY_ROAD",
    },
    successCondition:
      "Subject must complete the left turn through the intersection without contacting the oncoming vehicle.",
    durationSeconds: DEFAULT_COLLISION_DURATION_SECONDS,
  },

  unsafe_cut_in: {
    id: "unsafe_cut_in",
    label: "Unsafe cut-in",
    promptCue:
      "an adjacent-lane vehicle cuts in front of subject with insufficient gap — typical on multi-lane arterials and highways",
    requiredGeometry: {
      documentFamilies: ["street", "junction"],
      requireTagAnyOf: null,
    },
    clarificationSlots: [NPC_AGGRESSIVENESS_SLOT],
    actorRecipe: [
      {
        role: "subject",
        kind: "vehicle",
        scenarioRole: "subject",
        blueprint: "vehicle.lincoln.mkz",
        anchorStrategy: "spawn_on_approach_lane",
        aggressivenessAppliesTo: "none",
        baseSpeedKph: 60,
        // Autopilot drives subject forward at 60 kph; the cut-in dynamic
        // happens when the adjacent NPC steers in front.
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 60 },
        ],
      },
      {
        role: "adjacent",
        kind: "vehicle",
        scenarioRole: "traffic",
        blueprint: "vehicle.dodge.charger",
        anchorStrategy: "spawn_on_adjacent_lane",
        aggressivenessAppliesTo: "speed",
        baseSpeedKph: 65,
        // The active editor/runtime contract no longer stores lane-change
        // primitives, so the conflicting actor uses the same target-driven
        // ram primitive exposed in the road actor panel.
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: 4, action: "set_speed", target_speed_kph: 65 },
          {
            start_time: 4,
            end_time: 7,
            action: "ram_actor",
            target_role: "subject",
            target_speed_kph: 65,
          },
          { start_time: 7, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 40 },
        ],
      },
    ],
    defaultEnvironment: {
      lighting: "AFTERNOON",
      weather: "CLEAR_SKY",
      roadSurface: "DRY_ROAD",
    },
    successCondition:
      "Subject must avoid colliding with the cutting-in vehicle by braking or steering within its lane.",
    durationSeconds: DEFAULT_COLLISION_DURATION_SECONDS,
  },

  pedestrian_crossing: {
    id: "pedestrian_crossing",
    label: "Pedestrian crossing",
    promptCue:
      "a pedestrian moves into subject's path — at a marked crosswalk, mid-block, or stepping out from a bus stop / parked car / storefront — forcing a yield/brake response",
    requiredGeometry: {
      documentFamilies: ["junction", "poi", "street"],
      // Any of these substrings in the document's subtype OR scenarioTags
      // qualifies the location as a pedestrian-spawn point. Mirrors the
      // PEDESTRIAN_SPAWN_PATTERNS list the builder uses at anchor-resolve
      // time. Includes: direct pedestrian infrastructure (crosswalk,
      // sidewalk); transit (bus stop, transit); institutional density
      // (school, hospital); commercial frontages (retail, restaurant,
      // hotel, mall, airport, gas station); curbside parking (parking
      // lot/cluster, street parking); and the literal "pedestrian" tag
      // carried by Pedestrian-At-… occlusion candidates.
      requireTagAnyOf: [
        "crosswalk",
        "sidewalk",
        "pedestrian",
        "bus stop",
        "transit",
        "school",
        "hospital",
        "retail",
        "restaurant",
        "hotel",
        "mall",
        "airport",
        "gas station",
        "parking",
      ],
    },
    clarificationSlots: [
      {
        id: "actor_count",
        question: "How many pedestrians cross — a single jaywalker or a group?",
        options: ["Single pedestrian", "Two pedestrians", "Small group (3)"],
        defaultValue: "Single pedestrian",
      },
    ],
    actorRecipe: [
      {
        role: "subject",
        kind: "vehicle",
        scenarioRole: "subject",
        blueprint: "vehicle.lincoln.mkz",
        anchorStrategy: "spawn_on_approach_lane",
        aggressivenessAppliesTo: "none",
        baseSpeedKph: 35,
        // Autopilot drives subject toward the crosswalk; the walker's
        // crossing trajectory (set on the actor's `timed_waypoints` by
        // the builder) intersects subject's path mid-block.
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 35 },
        ],
      },
      {
        role: "crossing_pedestrian",
        kind: "walker",
        scenarioRole: "pedestrian",
        blueprint: "walker.pedestrian.0001",
        // The builder upgrades this anchor to `placement_mode:
        // "timed_path"` with two timed waypoints (curb → opposite curb,
        // perpendicular to the nearest drivable lane). Walkers can't
        // use follow_route/ram_actor; the timed-path trajectory IS the
        // motion specification. Recipe `timeline` is therefore empty —
        // the builder strips it when emitting a timed-path walker.
        anchorStrategy: "spawn_on_pedestrian_area",
        aggressivenessAppliesTo: "none",
        baseSpeedKph: 5,
        autopilot: false,
        timeline: [],
      },
    ],
    defaultEnvironment: {
      lighting: "AFTERNOON",
      weather: "CLEAR_SKY",
      roadSurface: "DRY_ROAD",
    },
    successCondition:
      "Subject must yield to the crossing pedestrian without contact.",
    durationSeconds: DEFAULT_COLLISION_DURATION_SECONDS,
    /**
     * Aim for contact at 8 s; accept any contact in the absolute window
     * [5 s, 12 s]. This replaces the default ±4 s relative tolerance for
     * pedestrian crossings, which are harder to time precisely due to
     * walker path variability.
     */
    collisionTimeWindow: { ideal: 8, min: 5, max: 12 },
  },

  // ── Families mined from the CA AV Collision corpus ────────────────────────
  // Infrastructure hints in each `requiredGeometry` comment are empirical:
  // they cite the share of that crash cluster occurring at the named
  // infrastructure across 646 real geocoded AV collisions.

  rear_end: {
    id: "rear_end",
    label: "Rear-end (subject struck while stopped/slowing)",
    promptCue:
      "subject is stopped or slowing in its lane — at a light, in queued traffic, or yielding — and a trailing vehicle fails to stop and strikes it from behind; the most common real AV crash",
    requiredGeometry: {
      // Corpus: 71% at intersections, 62% with subject stopped in traffic;
      // remainder mid-block in queued traffic. Any drivable lane supports
      // it, so no tag requirement — junctions and streets both qualify.
      documentFamilies: ["junction", "street"],
      requireTagAnyOf: null,
    },
    clarificationSlots: [NPC_AGGRESSIVENESS_SLOT],
    actorRecipe: [
      {
        role: "subject",
        kind: "vehicle",
        scenarioRole: "subject",
        blueprint: "vehicle.lincoln.mkz",
        anchorStrategy: "spawn_on_approach_lane",
        aggressivenessAppliesTo: "none",
        baseSpeedKph: 30,
        // Subject rolls up to the conflict point then sets target speed to zero,
        // mimicking a red
        // light / queued traffic. The trailing NPC is what produces the
        // collision; subject is the (correctly-behaving) victim here, which is
        // exactly the real-world pattern this family reproduces.
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: 5, action: "set_speed", target_speed_kph: 30 },
          { start_time: 5, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 0 },
        ],
      },
      {
        role: "trailing",
        kind: "vehicle",
        scenarioRole: "traffic",
        blueprint: "vehicle.dodge.charger",
        anchorStrategy: "spawn_on_same_lane_behind",
        aggressivenessAppliesTo: "speed",
        baseSpeedKph: 45,
        // `ram_actor` drives the trailing vehicle into subject's position. The
        // converging trajectory is what CARLA needs to actually rear-end the
        // stopped subject. Aggressiveness scales the closing speed.
        autopilot: true,
        timeline: [
          {
            start_time: 0,
            end_time: DEFAULT_COLLISION_DURATION_SECONDS,
            action: "ram_actor",
            target_role: "subject",
            target_speed_kph: 45,
          },
        ],
      },
    ],
    defaultEnvironment: {
      lighting: "AFTERNOON",
      weather: "CLEAR_SKY",
      roadSurface: "DRY_ROAD",
    },
    successCondition:
      "Subject, correctly stopped in its lane, is struck from behind by the trailing vehicle — the scenario reproduces the failure and tests subject's post-impact behavior and detection.",
    durationSeconds: DEFAULT_COLLISION_DURATION_SECONDS,
  },

  sideswipe: {
    id: "sideswipe",
    label: "Sideswipe (same-direction lateral contact)",
    promptCue:
      "a same-direction vehicle in the adjacent lane drifts or swerves laterally into subject, scraping its side — common on lane-constrained streets and alongside parked vehicles",
    requiredGeometry: {
      // Corpus: ~52% at intersections, 55% with parked vehicles present —
      // i.e. lane-width-constrained streets. Streets and junctions both
      // qualify; no specific tag required.
      documentFamilies: ["street", "junction"],
      requireTagAnyOf: null,
    },
    clarificationSlots: [NPC_AGGRESSIVENESS_SLOT],
    actorRecipe: [
      {
        role: "subject",
        kind: "vehicle",
        scenarioRole: "subject",
        blueprint: "vehicle.lincoln.mkz",
        anchorStrategy: "spawn_on_approach_lane",
        aggressivenessAppliesTo: "none",
        baseSpeedKph: 45,
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 45 },
        ],
      },
      {
        role: "adjacent",
        kind: "vehicle",
        scenarioRole: "traffic",
        blueprint: "vehicle.dodge.charger",
        anchorStrategy: "spawn_on_adjacent_lane",
        aggressivenessAppliesTo: "speed",
        baseSpeedKph: 50,
        // The current runtime stores the lateral conflict as a target-driven
        // ram primitive rather than a separate swerve primitive.
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: 5, action: "set_speed", target_speed_kph: 50 },
          {
            start_time: 5,
            end_time: 8,
            action: "ram_actor",
            target_role: "subject",
            target_speed_kph: 50,
          },
          { start_time: 8, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 50 },
        ],
      },
    ],
    defaultEnvironment: {
      lighting: "AFTERNOON",
      weather: "CLEAR_SKY",
      roadSurface: "DRY_ROAD",
    },
    successCondition:
      "Subject must hold its lane and avoid the laterally-drifting vehicle.",
    durationSeconds: DEFAULT_COLLISION_DURATION_SECONDS,
  },

  right_turn_hook: {
    id: "right_turn_hook",
    label: "Right-turn hook",
    promptCue:
      "subject turns right across a road user continuing straight on its right side — classically a cyclist in a bike lane or a vehicle in a parallel lane (the 'right hook')",
    requiredGeometry: {
      // Corpus: 80% at intersections, cyclist-involved in a notable share.
      // Junctions only — the maneuver is defined by the right turn across a
      // through path at the intersection.
      documentFamilies: ["junction"],
      requireTagAnyOf: null,
    },
    clarificationSlots: [NPC_AGGRESSIVENESS_SLOT],
    actorRecipe: [
      {
        role: "subject",
        kind: "vehicle",
        scenarioRole: "subject",
        blueprint: "vehicle.lincoln.mkz",
        anchorStrategy: "spawn_on_approach_lane",
        aggressivenessAppliesTo: "none",
        baseSpeedKph: 25,
        // Subject approaches the conflict at a controlled speed; the active
        // editor/runtime contract no longer stores turn primitives.
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: 10, action: "set_speed", target_speed_kph: 25 },
        ],
      },
      {
        role: "adjacent",
        kind: "vehicle",
        scenarioRole: "traffic",
        // Defaults to a car; the builder swaps to a bicycle blueprint and
        // lowers base speed when the LLM passes `npcVehicleType: 'bicycle'`
        // (the dominant real right-hook). Kept as a vehicle here so the
        // template is valid even when the user means a car-vs-car hook.
        blueprint: "vehicle.dodge.charger",
        anchorStrategy: "spawn_on_adjacent_lane",
        aggressivenessAppliesTo: "speed",
        baseSpeedKph: 30,
        // Continues straight through the intersection at constant speed on
        // subject's right while subject turns across it.
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 30 },
        ],
      },
    ],
    defaultEnvironment: {
      lighting: "AFTERNOON",
      weather: "CLEAR_SKY",
      roadSurface: "DRY_ROAD",
    },
    successCondition:
      "Subject must complete the right turn without hooking the through road user on its right.",
    durationSeconds: DEFAULT_COLLISION_DURATION_SECONDS,
  },

  // ── Near-miss families ────────────────────────────────────────────────────
  //
  // Same geometry recipes as their contact parents, re-timed so the conflict
  // resolves with a gap. Two knobs carry the miss:
  //
  //   1. `nearMissMargin.conflictLeadTimeS` — the planner offset. The
  //      conflicting actor is back-calculated to clear the conflict point this
  //      long before subject reaches it, so the planned paths cross with a gap
  //      instead of on the same instant.
  //   2. `following_distance_m` on the converging clip — the runtime standoff.
  //      `chase_actor` is `ram_actor` with a non-zero standoff (the CARLA
  //      worker literally pins ram's to 0), so swapping ram → chase is what
  //      turns "drive into subject" into "converge on subject and hold a gap".
  //
  // Both are needed: (1) makes the PLAN a miss so the kinematic validator
  // passes it, (2) keeps the CARLA rollout a miss even as the aggressiveness
  // slot scales the NPC's speed — the standoff is a distance, so a faster or
  // slower conflicting actor changes the approach energy, never the gap.

  near_miss_cut_in: {
    id: "near_miss_cut_in",
    label: "Near-miss cut-in (close pass, no contact)",
    promptCue:
      "an adjacent-lane vehicle merges into subject's lane leaving barely a car length of gap — a close call subject resolves by braking, with no contact",
    requiredGeometry: {
      // Same shape as `unsafe_cut_in` — any multi-lane arterial or junction
      // approach supports an adjacent-lane merge.
      documentFamilies: ["street", "junction"],
      requireTagAnyOf: null,
    },
    clarificationSlots: [NPC_AGGRESSIVENESS_SLOT],
    actorRecipe: [
      {
        role: "subject",
        kind: "vehicle",
        scenarioRole: "subject",
        blueprint: "vehicle.lincoln.mkz",
        anchorStrategy: "spawn_on_approach_lane",
        aggressivenessAppliesTo: "none",
        // 45 kph, not the parent family's 60. The gradeable near-miss band is
        // (1 m, 5 m]; at 60 kph (16.7 m/s) that whole band is under a quarter
        // of a second of arrival offset, which the planner's back-calculation
        // cannot reliably hit. At 45 kph (12.5 m/s) the same 4 m gap is 0.32 s
        // — an offset that survives the planner's sampling and the sim's
        // timestep.
        baseSpeedKph: 45,
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 45 },
        ],
      },
      {
        role: "adjacent",
        kind: "vehicle",
        scenarioRole: "traffic",
        blueprint: "vehicle.dodge.charger",
        anchorStrategy: "spawn_on_adjacent_lane",
        aggressivenessAppliesTo: "speed",
        // Faster tha subject so it genuinely arrives at the conflict point first
        // (the `conflictLeadTimeS` the planner solves for) and so the closing
        // clip below opens the gap again instead of leaving it stalled
        // alongside.
        baseSpeedKph: 55,
        autopilot: true,
        timeline: [
          // Run up in the adjacent lane, gaining on subject.
          { start_time: 0, end_time: 7, action: "set_speed", target_speed_kph: 55 },
          // The merge. `chase_actor` converges on subject and holds
          // `following_distance_m` — the miss distance — through the conflict
          // window. The window brackets the planned conflict at t=10 s.
          {
            start_time: 7,
            end_time: 12,
            action: "chase_actor",
            target_role: "subject",
            target_speed_kph: 55,
            following_distance_m: 3.5,
          },
          // Pull away: the pass completes and the gap reopens, so the closest
          // approach is a single moment rather than a sustained tailgate.
          { start_time: 12, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 60 },
        ],
      },
    ],
    defaultEnvironment: {
      lighting: "AFTERNOON",
      weather: "CLEAR_SKY",
      roadSurface: "DRY_ROAD",
    },
    successCondition:
      "Subject must absorb the cut-in without contact and without an emergency stop — the vehicles pass within a few metres and both drive on.",
    durationSeconds: DEFAULT_COLLISION_DURATION_SECONDS,
    // Closest approach can only happen while the conflicting actor is
    // converging, so the accept window is exactly the chase clip's span.
    // `ideal` matches the uniform TARGET_COLLISION_TIME_S.
    collisionTimeWindow: { ideal: 10, min: 7, max: 12 },
    // 0.32 s × 12.5 m/s (45 kph subject) = 4.0 m planned gap — inside the
    // [3.5 m, 5 m] band, above the 1 m grazing-contact grace.
    nearMissMargin: {
      conflictLeadTimeS: 0.32,
      targetMissDistanceM: 3.5,
      maxMissDistanceM: 5,
    },
  },

  near_miss_pedestrian: {
    id: "near_miss_pedestrian",
    label: "Near-miss pedestrian crossing (pedestrian clears just in time)",
    promptCue:
      "a pedestrian crosses just ahead of subject and clears the lane a moment before it arrives — a close call that forces a hard yield but no contact",
    requiredGeometry: {
      // Identical to `pedestrian_crossing`: the walker still has to spawn on
      // real pedestrian infrastructure, so the qualifying tag list is the same.
      documentFamilies: ["junction", "poi", "street"],
      requireTagAnyOf: [
        "crosswalk",
        "sidewalk",
        "pedestrian",
        "bus stop",
        "transit",
        "school",
        "hospital",
        "retail",
        "restaurant",
        "hotel",
        "mall",
        "airport",
        "gas station",
        "parking",
      ],
    },
    clarificationSlots: [
      {
        id: "actor_count",
        question: "How many pedestrians cross — a single jaywalker or a group?",
        options: ["Single pedestrian", "Two pedestrians", "Small group (3)"],
        defaultValue: "Single pedestrian",
      },
    ],
    actorRecipe: [
      {
        role: "subject",
        kind: "vehicle",
        scenarioRole: "subject",
        blueprint: "vehicle.lincoln.mkz",
        anchorStrategy: "spawn_on_approach_lane",
        aggressivenessAppliesTo: "none",
        // Unchanged from `pedestrian_crossing`: at 35 kph (9.7 m/s) the 0.4 s
        // lead below is a 3.9 m gap, already inside the gradeable band, so
        // this family needs no speed reduction to be plannable.
        baseSpeedKph: 35,
        autopilot: true,
        timeline: [
          { start_time: 0, end_time: DEFAULT_COLLISION_DURATION_SECONDS, action: "set_speed", target_speed_kph: 35 },
        ],
      },
      {
        role: "crossing_pedestrian",
        kind: "walker",
        scenarioRole: "pedestrian",
        blueprint: "walker.pedestrian.0001",
        // Same timed-path treatment as `pedestrian_crossing`: the builder
        // upgrades this to `placement_mode: "timed_path"` and the empty
        // timeline is stripped. Walk speed is deliberately unchanged at 5 kph
        // — the entire difference from the contact family is the walker's
        // curb-hold, solved from `conflictLeadTimeS` so it steps off earlier
        // and is out of the lane by the time subject arrives.
        anchorStrategy: "spawn_on_pedestrian_area",
        aggressivenessAppliesTo: "none",
        baseSpeedKph: 5,
        autopilot: false,
        timeline: [],
      },
    ],
    defaultEnvironment: {
      lighting: "AFTERNOON",
      weather: "CLEAR_SKY",
      roadSurface: "DRY_ROAD",
    },
    successCondition:
      "Subject must yield hard enough that the pedestrian clears the lane untouched — close pass, no contact, no swerve out of lane.",
    durationSeconds: DEFAULT_COLLISION_DURATION_SECONDS,
    // Same window as the contact parent: walker path variability is what makes
    // the moment imprecise, and that is unchanged by re-timing the crossing.
    collisionTimeWindow: { ideal: 8, min: 5, max: 12 },
    // 0.4 s × 9.72 m/s (35 kph subject) = 3.9 m planned gap.
    nearMissMargin: {
      conflictLeadTimeS: 0.4,
      targetMissDistanceM: 3.5,
      maxMissDistanceM: 5,
    },
  },
};

// ── Empirical per-family event prior (Track B, structured-only) ─────────────

/**
 * Per-family crash-event defaults mined from the 646-row CA AV Collision
 * corpus (structured columns only — actor count, conflict actor type, subject
 * stopped state; no narrative LLM extraction, no environment). Source:
 * generated from the CA AV Collision corpus.
 *
 * These are DOCUMENTED EMPIRICAL DEFAULTS, not a runtime gate: they record
 * what a real crash of each family typically looks like so the recipe
 * constants above are defensible and so the draft builder / LLM can fall
 * back on them when the user's prompt is silent on a primitive. They never
 * override an explicit user choice and are not a safety/risk score.
 *
 * Cross-checks against the recipes above:
 *   - every family's modal participant count is 2 (subject + one conflict
 *     actor) — matches each `actorRecipe` having exactly two roles.
 *   - `rear_end` subject-stopped share = 0.638 (n=235) independently
 *     corroborates the rear_end recipe's "subject rolls up then stops" timeline.
 *   - `dominant_conflict_type` is "vehicle" for every family in the
 *     structured data; `pedestrian_crossing`'s conflict actor is
 *     nonetheless fixed to a walker by the family definition (the structured
 *     mix counts the other VEHICLE in multi-party ped crashes — the prior
 *     describes corpus composition, it does not re-pick the recipe actor).
 */
export interface FamilyEventPrior {
  /** Most common total participant count (subject + others). */
  modalActorCount: number;
  /** Share of corpus rows at the modal count (0..1). */
  modalActorCountShare: number;
  /** Dominant non-subject actor type in the structured corpus. */
  dominantConflictType: "vehicle" | "pedestrian" | "bicycle" | "motorcycle" | "other";
  /** Share of rows with subject stopped in traffic at impact (0..1). */
  subjectStoppedShare: number;
  /** Corpus support for this family. */
  n: number;
}

export const FAMILY_EVENT_PRIOR: Record<CollisionFamilyId, FamilyEventPrior> = {
  unprotected_left_turn: {
    modalActorCount: 2,
    modalActorCountShare: 0.9195,
    dominantConflictType: "vehicle",
    subjectStoppedShare: 0.4138,
    n: 87,
  },
  unsafe_cut_in: {
    modalActorCount: 2,
    modalActorCountShare: 0.9565,
    dominantConflictType: "vehicle",
    subjectStoppedShare: 0.2174,
    n: 46,
  },
  pedestrian_crossing: {
    modalActorCount: 2,
    modalActorCountShare: 0.7442,
    dominantConflictType: "vehicle",
    subjectStoppedShare: 0.4651,
    n: 43,
  },
  rear_end: {
    modalActorCount: 2,
    modalActorCountShare: 0.9149,
    dominantConflictType: "vehicle",
    subjectStoppedShare: 0.6383,
    n: 235,
  },
  sideswipe: {
    modalActorCount: 2,
    modalActorCountShare: 0.7619,
    dominantConflictType: "vehicle",
    subjectStoppedShare: 0.3333,
    n: 42,
  },
  right_turn_hook: {
    modalActorCount: 2,
    modalActorCountShare: 0.8158,
    dominantConflictType: "vehicle",
    subjectStoppedShare: 0.3421,
    n: 38,
  },
  // Near-miss families INHERIT their contact parent's composition. A crash
  // corpus records only events that ended in contact, so no row supports a
  // near-miss family directly; what the parent's numbers do describe — the
  // participant count and conflict-actor mix of this conflict geometry — is
  // unchanged by whether the encounter ended in contact or a gap. Read these
  // as "what this conflict looks like", never as independent corpus support.
  near_miss_cut_in: {
    // Inherited from `unsafe_cut_in`.
    modalActorCount: 2,
    modalActorCountShare: 0.9565,
    dominantConflictType: "vehicle",
    subjectStoppedShare: 0.2174,
    n: 46,
  },
  near_miss_pedestrian: {
    // Inherited from `pedestrian_crossing` — including its documented caveat
    // that the structured `dominantConflictType` counts the other VEHICLE in
    // multi-party pedestrian crashes while the recipe's conflict actor is
    // fixed to a walker by the family definition.
    modalActorCount: 2,
    modalActorCountShare: 0.7442,
    dominantConflictType: "vehicle",
    subjectStoppedShare: 0.4651,
    n: 43,
  },
};

// ── Aggressiveness application ──────────────────────────────────────────────

/**
 * Apply the user-selected aggressiveness to a clip's target speed.
 * Centralized so the LLM service + builder + tests use the same multipliers.
 */
export function applyAggressivenessToSpeedKph(
  baseSpeedKph: number,
  aggressiveness: NpcAggressiveness,
): number {
  switch (aggressiveness) {
    case "aggressive":
      return Math.round(baseSpeedKph * 1.25);
    case "hesitant":
      return Math.round(baseSpeedKph * 0.7);
    case "steady":
    default:
      return baseSpeedKph;
  }
}

/**
 * Map a user-facing chip label (e.g. "Aggressive — speeds up") back to the
 * canonical `NpcAggressiveness` slot value. Falls back to "steady" so the
 * builder never trips on unrecognized values from a chatty LLM.
 */
export function parseAggressivenessLabel(value: string | null | undefined): NpcAggressiveness {
  const lower = (value ?? "").toLowerCase();
  if (lower.includes("aggressive") || lower.includes("speeds up")) return "aggressive";
  if (lower.includes("hesitant") || lower.includes("late braking")) return "hesitant";
  return "steady";
}
