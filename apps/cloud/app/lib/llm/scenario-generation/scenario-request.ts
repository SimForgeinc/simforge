/**
 * `ScenarioRequest` — the structured intent the LLM emits and the deterministic
 * batch generator consumes (stage-1 Phase 2). The LLM is a PARSER, not a
 * planner: it turns a natural-language prompt into this object and nothing else.
 * Everything downstream — finding sites, placing actors, timing — is
 * deterministic code (`generateCollisionScenarioBatch`).
 *
 * `count` is what makes this a BATCH request: "generate N pedestrian-crossing
 * scenarios across this map" — the dataset-scale lever. `outcome` is a
 * first-class knob (both collisions and near-misses are valid training data).
 * `locationConstraints` are SEMANTIC (never coordinates); the deterministic
 * site search maps them onto the candidate index — minimal today, with room to
 * grow (see the constraint-vocabulary open question in the plan).
 */
import { z } from "zod";

/** Families the deterministic batch generator can enumerate sites for today. */
export const SCENARIO_REQUEST_FAMILIES = [
  "pedestrian_crossing",
  "unprotected_left_turn",
  "right_turn_hook",
  // Cyclist steers out of a parallel bike lane into the subject's lane (bike-merge).
  "bicycle_merge",
  // Turn-across-crosswalk pedestrian conflict (dib 2026-07-21): the subject turns
  // left/right at a junction while a pedestrian crosses the DESTINATION-leg
  // crosswalk (the leg the subject turns onto). Avoidance = the subject yields/brakes
  // mid-turn (the VLA-priority variant); collision = it doesn't. Composes the
  // turn-gate geometry (buildGatePolyline exit leg + the turn primitive /
  // reactive arc-follower) with the pedestrian_crossing walker timing.
  "left_turn_ped_crosswalk",
  "right_turn_ped_crosswalk",
] as const;

export const ScenarioRequestSchema = z.object({
  scenarioFamily: z.enum(SCENARIO_REQUEST_FAMILIES),
  /** How many scenarios to generate (the batch size). */
  count: z.number().int().positive().max(200).default(1),
  /** Intended outcome — both are valid labeled training data. */
  outcome: z.enum(["collision", "near_miss"]).default("collision"),
  /**
   * Semantic location constraints (never coordinates). Mapped onto candidate
   * tags by the deterministic site search. Filtering on these is minimal today
   * — the fields are reserved so the contract is stable as it grows.
   */
  locationConstraints: z
    .object({
      nearPoi: z.array(z.string()).optional(),
      signalized: z.boolean().optional(),
      requiredTags: z.array(z.string()).optional(),
    })
    .default({}),
  /** Subject cruise speed (kph). */
  subjectSpeedKph: z.number().positive().max(130).default(35),
  /** Conflicting NPC speed (kph); defaults to the subject speed. Turn families. */
  npcSpeedKph: z.number().positive().max(130).optional(),
  /** Conflicting NPC vehicle type for the turn families. */
  npcVehicleType: z.enum(["car", "bicycle", "motorcycle"]).optional(),
  /** Aggressiveness band (scales the NPC closing speed in the recipe). */
  aggressiveness: z.enum(["aggressive", "steady", "hesitant"]).optional(),
  /** Require-occluder gate (pedestrian_crossing / right_turn_hook): when true,
   *  only emit conflicts that have a matched roadside occluder — the pedestrian /
   *  cyclist must emerge from behind a bus/large-vehicle/parked-car (low
   *  time-to-react). Rejects open, fully-visible conflicts (the "no occlusion,
   *  implausible" reviews). Default false keeps open crossings eligible. */
  requireOccluder: z.boolean().default(false),
  /** Occluder vehicle CLASS for the truck-warranting occlusion sites (street
   *  parking near the conflict / commercial delivery bays). "large" (default) =
   *  box truck / firetruck — best occlusion, but frequently `null_handle`s in 3D
   *  at tight sites (dib 2026-07-17: carlacola failed to spawn x8 across many
   *  spots). "medium" = the Sprinter-class van — a DISTINCT variation with less
   *  occlusion than a truck but far more believable than none, and much likelier
   *  to spawn. Bus-stop + plain parked-car sites are unaffected.
   *
   *  "car" (dib 2026-07-29) forces the plain parked-CAR body at EVERY occlusion
   *  subtype, including the bus stop and the truck-warranting ones. The operator
   *  on the CPNCO review: "the category is child emerges from behind occlusion -
   *  the occluder can just be a simple car - no need for a medium occluder". A
   *  kerbside car is also the commonest real CPNCO occluder, and it is the
   *  smallest body, so it clears the placement guards at the most sites. */
  occluderClass: z.enum(["large", "medium", "car"]).default("large"),
  /**
   * Stature of the CONFLICT pedestrian. `child` selects the 0.10 image's only
   * small models (walker.pedestrian.0048/0049, measured 1.11 m against 1.84 m
   * adults) and the slower child gait, which shifts the whole crossing solve —
   * the walker takes ~18% longer to reach the conflict point, so the hold and
   * the subject's arrival are re-solved rather than inherited.
   *
   * This is what makes the medium-occluder families a genuine Euro NCAP CPNCO
   * analogue: that cell is specifically a CHILD emerging from behind an
   * obstruction, and we have been staging adults. Sites are school frontages
   * AND residential streets — a kid stepping out between parked cars is the
   * same interaction and the commoner one.
   */
  walkerProfile: z.enum(["adult", "child"]).default("adult"),
  /**
   * Gait of the CONFLICT pedestrian. Euro NCAP's CPNCO-50 is explicitly a child
   * "crossing its path RUNNING from behind an obstruction from the nearside"
   * (AEB/LSS VRU Test Protocol v4.5.1) — we have been walking it, so `run` is
   * the faithful reading of the cell rather than a new one.
   *
   * This re-solves the crossing exactly the way `walkerProfile` does, and by
   * more: a running child covers the curb→lane-centre leg in 55% of the walking
   * time, so the curb hold grows and the subject's reveal window shrinks ~45%.
   * Default `walk` keeps every existing scenario byte-identical.
   */
  walkerGait: z.enum(["walk", "run"]).default("walk"),
  /**
   * Number of pedestrians in the CONFLICT GROUP, principal included (1 = the
   * single conflict ped we ship today). 2-3 stages the operator's ask: "versions
   * of this where there are 2-3 kids running into the street instead of just
   * walking".
   *
   * A group is NOT the same thing as the existing `extraPedestrians` companion
   * dressing. Companions already share the principal's corridor, but they carry
   * a ±1.5 s Gaussian release jitter and draw from the whole 37-model pool, so
   * 2-3 of them read as unrelated adults who happened to cross together. A GROUP
   * correlates the release, draws from the principal's own (child) pool, and
   * biases every member to the occluder-shadow side — see
   * `buildCompanionWalkers`. The principal keeps its validated geometry and
   * stays the only conflict actor; group members remain `bg-` dressing.
   */
  walkerGroupSize: z.number().int().min(1).max(3).default(1),
  /**
   * Trailing-cyclist stream size behind a bicycle conflict NPC (right-hook /
   * merge families). DEFAULT 0: the companion schedule currently fails the
   * kinematic jerk lint and takes the whole site with it (measured 2026-08-01,
   * munich/bikemergeavoid: 2 -> 0 of 32 sites accepted; 0 -> 3 of 3). Restore
   * the default to 2 once the companion re-timing lands.
   *
   * A REQUEST field, not an env read inside the generator, because the replay
   * sidecar captures the request verbatim and promises request + map reproduce
   * the scene byte-for-byte — generation must not depend on process state the
   * sidecar cannot see (Codex P1 on #484). The emit harness resolves
   * EMIT_EXTRA_CYCLISTS into this field.
   */
  extraCyclists: z.number().int().min(0).max(3).default(0),
  /**
   * Adult companion that HOLDS at the curb and then pursues once the child steps
   * off (operator, on the CPNCO review: "why is the adult just running in place -
   * it would be better if the adult was stopped and start running after the child
   * to stop the collision").
   *
   * Distinct from a group member: the group crosses WITH the child, the reactive
   * companion reacts TO it. It is authored as a timed path whose hold ends at the
   * principal's solved step-off, and it is deliberately stopped short of the subject
   * corridor so a caretaker lunging after a child never becomes a second conflict
   * actor. Only meaningful on pedestrian-crossing families.
   */
  reactiveCompanion: z.boolean().default(false),
  /** Sightline VAN occluder (P2, dib 2026-07-24 review): place a physics-frozen
   *  parked van ON the subject→conflict sightline so the crossing pedestrian is hidden
   *  behind it and emerges LATE — the harder, more realistic reveal the review
   *  sketches show (subject turns right into a driveway / at a junction; a parked van
   *  hides the ped on the exit leg). Layered in the population step on top of the
   *  already-authored subject+ped geometry, so it composes with ANY ped family —
   *  including the turn-across-crosswalk scenes — WITHOUT re-authoring the ped.
   *  Distinct from `occluderClass` (which selects the collision generator's own
   *  straight-crossing occluder body). Omit → no van (existing scenes unchanged). */
  sightlineOccluder: z.enum(["van"]).optional(),
  /** Restrict turn-across-crosswalk site selection to ENTRANCE TURN-IN sites
   *  (lot/apron entrances — the category formerly mis-named "driveway"; operator
   *  2026-07-28: true residential driveways are not modeled in current XODRs). */
  entranceOnly: z.boolean().optional(),
  /** @deprecated alias of `entranceOnly` (the category's old name). */
  drivewayOnly: z.boolean().optional(),
  /** Collision-AVOIDED variant (Fix 7): the subject carries `reactive_braking` so the
   * worker brakes late+hard for the conflict walker and resumes after it clears —
   * an alpamayo edge-case STOP scene from the same planned-collision geometry. */
  subjectReactive: z.boolean().default(false),
  /**
   * Background scene population — realism layer that does NOT disrupt the
   * primary collision (kept out of the conflict zone + subject corridor). All
   * default 0, so an unpopulated request is unchanged.
   */
  population: z
    .object({
      /** Named density preset (light / medium / heavy) for moving traffic. Fills
       *  the counts below when they're left at 0; explicit counts take precedence. */
      density: z.enum(["light", "medium", "heavy"]).optional(),
      vehicles: z.number().int().nonnegative().max(60).default(0),
      pedestrians: z.number().int().nonnegative().max(40).default(0),
      cyclists: z.number().int().nonnegative().max(20).default(0),
      /** Parking density (light / medium / heavy) — a SEPARATE knob from traffic
       *  density: static curb-parked cars from the map's Parking lanes. Fills
       *  `parked` when it's left at 0; explicit `parked` takes precedence. */
      parkedDensity: z.enum(["light", "medium", "heavy"]).optional(),
      parked: z.number().int().nonnegative().max(60).default(0),
    })
    .default({}),
  /** Environment knobs (stage-2 variations; reserved). */
  environment: z
    .object({
      timeOfDay: z.string().optional(),
      weather: z.string().optional(),
      roadCondition: z.string().optional(),
    })
    .optional(),
  /** Seed for reproducible, auditable batch generation. */
  seed: z.number().int().nonnegative().default(0),
});

export type ScenarioRequest = z.infer<typeof ScenarioRequestSchema>;
export type ScenarioRequestFamily = (typeof SCENARIO_REQUEST_FAMILIES)[number];

/** Parse + default an untrusted request (e.g. LLM output); throws on invalid. */
export function parseScenarioRequest(input: unknown): ScenarioRequest {
  return ScenarioRequestSchema.parse(input);
}
