import {
  GeneratedScenarioMetadataSchema,
  environmentPresetToCarlaWeather,
  type GeneratedScenarioMetadata,
  type ScenarioEditorActorDraft,
  type ScenarioIntention,
} from "@simforge-oss/studio-shared";
import {
  EnvironmentPresetSchema,
} from "@simforge-oss/scenario/contracts";

export type ScenarioMetadataSoftwareVersions =
  GeneratedScenarioMetadata["testCase"]["softwareVersions"];

function generatorIdentity(reference: string): { id: string; version: string } {
  const match = /^(.*)\.v([^.]*)$/.exec(reference.trim());
  return match
    ? { id: match[1]!, version: match[2]! }
    : { id: reference.trim(), version: "1" };
}

function weatherFromInput(
  environmentPreset: unknown,
  weatherHint: string | null | undefined,
): GeneratedScenarioMetadata["odd"]["weather"] {
  const preset = EnvironmentPresetSchema.safeParse(environmentPreset);
  if (preset.success) {
    const weather = environmentPresetToCarlaWeather(preset.data);
    return {
      precipitation: weather.rain,
      fog: weather.fog_density,
      wetness: weather.wetness,
    };
  }
  const hint = weatherHint?.toLowerCase() ?? "";
  return {
    precipitation: /rain/.test(hint) ? 0.55 : 0,
    fog: /fog/.test(hint) ? 0.75 : /rain/.test(hint) ? 0.2 : 0,
    wetness: /rain|wet|puddle/.test(hint) ? 0.75 : 0,
  };
}

function lightingFromInput(
  environmentPreset: unknown,
): GeneratedScenarioMetadata["odd"]["lighting"] {
  const preset = EnvironmentPresetSchema.safeParse(environmentPreset);
  if (!preset.success) return "daylight";
  switch (preset.data.lighting) {
    case "NIGHT":
      return "night";
    case "SUNRISE":
    case "BLUE_HOUR":
      return "dawn";
    case "SUNSET":
    case "TWILIGHT":
    case "GOLDEN_HOUR":
      return "dusk";
    default:
      return "daylight";
  }
}

function actorType(actor: ScenarioEditorActorDraft): string {
  if (actor.kind === "walker" || actor.role === "pedestrian") {
    return "pedestrian";
  }
  if (/bike|bicycle|crossbike|omafiets|century/i.test(actor.blueprint)) {
    return "bicycle";
  }
  if (/motor|yamaha|harley|kawasaki|vespa/i.test(actor.blueprint)) {
    return "motorcycle";
  }
  if (actor.kind === "prop" || actor.role === "prop") return "prop";
  return actor.kind ?? "vehicle";
}

function interactionType(
  subject: ScenarioIntention["subject"],
): GeneratedScenarioMetadata["tags"]["interaction_type"] {
  switch (subject) {
    case "pedestrian":
      return "vehicle_pedestrian";
    case "bicycle":
      return "vehicle_cyclist";
    case "motorcycle":
      return "vehicle_motorcyclist";
    case "vehicle":
      return "vehicle_vehicle";
    default:
      return "none";
  }
}

function relativeDirection(
  intention: ScenarioIntention,
): GeneratedScenarioMetadata["tags"]["relative_direction"] {
  switch (intention.context) {
    case "unprotected_left":
      return "opposing";
    case "junction_crossing":
    case "right_turn":
    case "occluded":
      return "crossing";
    case "lane_change":
    case "adjacent_lane":
    case "overtake":
      return "merging";
    case "rear_approach":
    case "highway":
    case "mid_block":
    case "stop_sign":
      return "same_direction";
  }
}

function criticality(
  outcome: ScenarioIntention["outcome"],
): 1 | 2 | 3 | 4 | 5 {
  switch (outcome) {
    case "collision":
      return 5;
    case "near_miss":
      return 4;
    case "collision_avoidance":
      return 3;
    case "nominal":
      return 1;
  }
}

function legality(
  actors: ReadonlyArray<ScenarioEditorActorDraft>,
): GeneratedScenarioMetadata["tags"]["legality"] {
  const classes = new Set(
    actors.map((actor) => actor.behaviorMetadata?.behavior_class),
  );
  if (classes.has("infeasible_diagnostic")) return "diagnostic";
  if (classes.has("violating") || classes.has("adversarial")) {
    return classes.has("compliant") ? "mixed" : "illegal";
  }
  return "compliant";
}

/**
 * Shared classifier for generation and backfill. The caller supplies an M2.1
 * intention record, keeping family/maneuver taxonomy authority in one place.
 */
export function buildScenarioMetadata(input: {
  generator: string;
  seed?: string | number;
  classificationReference: string;
  scenarioIntention: ScenarioIntention;
  actors: ReadonlyArray<ScenarioEditorActorDraft>;
  traffic: "normal" | "medium" | "heavy";
  weather?: string | null;
  environmentPreset?: unknown;
  softwareVersions?: ScenarioMetadataSoftwareVersions;
  sourceType?: "generator" | "backfill";
  sourceConfidence?: number;
}): GeneratedScenarioMetadata {
  const intention = input.scenarioIntention;
  const speeds = input.actors
    .map((actor) => actor.speed_kph)
    .filter((speed): speed is number => Number.isFinite(speed));
  const junctionTypes: NonNullable<
    GeneratedScenarioMetadata["odd"]["junction_types"]
  > = [];
  if (
    intention.context === "junction_crossing" ||
    intention.context === "unprotected_left" ||
    intention.context === "right_turn" ||
    intention.context === "stop_sign"
  ) {
    junctionTypes.push(
      intention.modifiers.signalized
        ? "signalized_intersection"
        : "unsignalized_intersection",
    );
  }
  if (
    intention.context === "lane_change" ||
    intention.context === "adjacent_lane"
  ) {
    junctionTypes.push("merge");
  }
  if (intention.subject === "pedestrian") {
    junctionTypes.push("pedestrian_crossing");
  }

  const environmental = [
    input.traffic === "heavy"
      ? "traffic_high"
      : input.traffic === "medium"
        ? "traffic_medium"
        : "traffic_low",
    intention.modifiers.weather === "wet_raining"
      ? "wet_raining"
      : "clear",
    ...(intention.modifiers.occlusion
      ? [`occlusion_${intention.modifiers.occlusion}`]
      : []),
  ];
  const metrics: NonNullable<
    GeneratedScenarioMetadata["testCase"]["metrics"]
  > = [
    intention.outcome === "collision" ? "intended_contact" : "collision",
    "lane_departure",
    "route_completion",
    ...(intention.subject === "pedestrian"
      ? (["yield_compliance"] as const)
      : []),
    ...(intention.outcome === "collision"
      ? []
      : (["max_deceleration", "minimum_clearance"] as const)),
  ];
  const generated: GeneratedScenarioMetadata = {
    schema_version: "simforge.scenario-metadata.v1",
    odd: {
      road_type: intention.context === "highway" ? "highway" : "urban",
      junction_types: [...new Set(junctionTypes)],
      ...(speeds.length > 0
        ? {
            speed_range_kph: {
              min: Math.min(...speeds),
              max: Math.max(...speeds),
            },
          }
        : {}),
      weather: weatherFromInput(input.environmentPreset, input.weather),
      lighting: lightingFromInput(input.environmentPreset),
      traffic_density:
        input.traffic === "heavy"
          ? "high"
          : input.traffic === "medium"
            ? "medium"
            : "low",
    },
    tags: {
      actor_types: [...new Set(input.actors.map(actorType))],
      maneuver: [intention.primary_maneuver_category],
      interaction_type: interactionType(intention.subject),
      legality: legality(input.actors),
      occlusion: intention.modifiers.occlusion ? "partial" : "none",
      relative_direction: relativeDirection(intention),
      criticality: criticality(intention.outcome),
      environmental,
      source: {
        type: input.sourceType ?? "generator",
        reference: input.classificationReference,
        confidence: input.sourceConfidence ?? 1,
      },
    },
    testCase: {
      objective: intention.nav_prompt,
      expected_ego_outcomes: [
        {
          no_collision: intention.outcome !== "collision",
          remain_in_lane: true,
          ...(intention.subject === "pedestrian"
            ? { yield_to_pedestrian: intention.outcome !== "collision" }
            : {}),
          ...(intention.outcome !== "collision"
            ? {
                max_decel_mps2: 8,
                min_clearance_m: intention.outcome === "near_miss" ? 0.5 : 1,
              }
            : {}),
        },
      ],
      metrics: [...new Set(metrics)],
      seed: input.seed ?? 0,
      generator: generatorIdentity(input.generator),
      ...(input.softwareVersions
        ? { softwareVersions: input.softwareVersions }
        : {}),
    },
  };
  return GeneratedScenarioMetadataSchema.parse(generated);
}
