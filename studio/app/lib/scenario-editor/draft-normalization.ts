import {
  SCENARIO_TIMING,
  SIMULATION_DEFAULTS,
  normalizePhysicsProfileId,
  type PhysicsProfileId,
  type ScenarioEditorActorDraft,
  type ScenarioEditorAmbientTraffic,
  ScenarioEditorActorDraftSchema,
  ScenarioEditorAmbientTrafficSchema,
  migrateLegacyScenarioEditorActor,
  type ScenarioEditorDraft,
  SceneFormationSchema,
  SCENE_FORMATION_SCHEMA_VERSION,
  type SceneFormation,
  SceneFormationSolutionSchema,
  SCENE_FORMATION_SOLUTION_SCHEMA_VERSION,
  type SceneFormationSolution,
  JunctionSignalPlanSchema,
  type JunctionSignalPlan,
  type ScenarioValidationIntent,
  ScenarioValidationIntentSchema,
  type ScenarioIntention,
  ScenarioIntentionSchema,
  type ScenarioMetadata,
  ScenarioMetadataSchema,
  SensorSchema,
  type Sensor,
  type SensorOutputModality,
  TrafficCardSchema,
  type TrafficCard,
  TrafficManagerSchema,
  type TrafficManager,
  type TrafficAggressiveness,
  type TrafficDensity,
  type VehicleMixPreset,
} from "@simcloud/shared";
import type { EnvironmentPreset } from "@simcloud/shared";
import { z } from "zod";
import { lenientEnvironmentPreset } from "@/app/lib/scenario-editor/environment-preset-input";
import {
  DEFAULT_CUSTOM_VEHICLE_MIX,
  DENSITY_VEHICLE_COUNTS,
  type TrafficVehicleMixWeights,
} from "@/app/lib/scenario-editor/traffic-cards";
import {
  STREET_CAMERA_YAW_BASIS_VERSION,
  upgradeLegacyStreetCameraYaws,
} from "@/app/lib/scenario-editor/street-camera-yaw";
import {
  parseRenderConfig,
  type ScenarioSetupRenderConfig,
} from "@/app/lib/scenario-editor/draft-render-config";

export type { ScenarioSetupRenderConfig } from "@/app/lib/scenario-editor/draft-render-config";

export type PersistedScenarioDraft = Record<string, unknown>;

export const SCENARIO_SETUP_SCHEMA_VERSION = "simforge.scenario-setup.v3";
export const PERSISTED_NATIVE_DRAFT_SCHEMA_VERSION =
  "simforge.persisted-native-draft.v3";

export type ScenarioSetupJsonV3 = {
  schemaVersion: typeof SCENARIO_SETUP_SCHEMA_VERSION;
  metadata?: {
    name?: string;
    notes?: string;
    worldSensorYawBasis?: string;
    validationIntent?: ScenarioValidationIntent;
    scenarioIntention?: ScenarioIntention;
    scenarioMetadata?: ScenarioMetadata;
  };
  map: {
    mapName: string;
    backendMapName: string | null;
    mapAssetId: string | null;
  };
  simulation: {
    durationSeconds: number;
    fixedDeltaSeconds: number;
    physicsProfileId: PhysicsProfileId;
  };
  /**
   * Authored weather/lighting/road-surface preset. Absent means "no preset"
   * (the export compiles as clear noon, with an `environment_defaulted`
   * diagnostic). Before scenario-eval defect #24 this had no home in the
   * portable setup at all, so every save dropped it.
   */
  environment?: EnvironmentPreset;
  scene: {
    actors: ScenarioEditorActorDraft[];
    /**
     * The declarative ambient-traffic spec — THE one persisted home for the
     * region configuration (bounds, count, seeds, pools, speed,
     * aggressiveness). See `ScenarioEditorAmbientTrafficSchema`. The expanded
     * members never persist; they are recomputed from this at payload build.
     */
    ambientTraffic?: ScenarioEditorAmbientTraffic;
    semanticFormations?: SceneFormation[];
    semanticFormationSolutions?: SceneFormationSolution[];
    signalPlans?: JunctionSignalPlan[];
    worldSensors: Sensor[];
  };
  traffic: {
    carLed: {
      enabled: boolean;
      carsPerActor: number;
      radiusMeters: number;
      minimumSpacingMeters: number;
      aggressiveness: TrafficAggressiveness;
      baseSpeedKph: number;
      variantSeed: number;
    };
    global: {
      enabled: boolean;
      density: TrafficDensity;
      aggressiveness: TrafficAggressiveness;
      vehicleCount: number;
      vehicleMix: VehicleMixPreset;
      vehicleMixWeights: TrafficVehicleMixWeights;
    };
  };
  renderConfig?: ScenarioSetupRenderConfig;
};

/**
 * An actor the draft carries that this build cannot read.
 *
 * Kept rather than dropped, because dropping it is what deleted a car. See
 * `asValidatedArray`.
 */
export type UnloadableActor = {
  /** Position in the persisted actor array, so the row can be repaired by index. */
  index: number;
  /** Best-effort id from the raw record — the schema failure may be the id itself. */
  actorId: string | null;
  /** One line per zod issue, already formatted for display. */
  issues: string[];
};

export type NormalizedScenarioDraft = {
  mapName: string;
  actors: ScenarioEditorActorDraft[];
  /**
   * Actors the draft declares and this build could not parse. Non-empty means
   * the loaded document is INCOMPLETE: it must not be presented as the whole
   * scenario, and it must not be saved back over the complete one.
   */
  unloadableActors: UnloadableActor[];
  semanticFormations: SceneFormation[];
  semanticFormationSolutions: SceneFormationSolution[];
  /**
   * The scene's declarative ambient-traffic spec, or null when it has none.
   * Optional so callers that build normalized drafts by hand stay valid; both
   * normalize paths always set it, and the serializers round-trip it into
   * `setup.scene.ambientTraffic` — the omission that used to drop every region
   * a draft PUT hoisted (report-generators.md finding 1).
   */
  ambientTraffic?: ScenarioEditorAmbientTraffic | null;
  /** One plan per junction the author touched. Empty means every junction runs `map_default`. */
  signalPlans: JunctionSignalPlan[];
  selectedActorId: string | null;
  durationSeconds: number;
  fixedDeltaSeconds: number;
  physicsProfileId: PhysicsProfileId;
  worldSensors: Sensor[];
  carLedTrafficEnabled: boolean;
  carLedTrafficCarsPerActor: number;
  carLedTrafficRadiusMeters: number;
  carLedTrafficMinimumSpacingMeters: number;
  carLedTrafficAggressiveness?: TrafficAggressiveness;
  carLedTrafficBaseSpeedKph?: number;
  carLedTrafficVariantSeed?: number;
  trafficEnabled: boolean;
  trafficDensity: TrafficDensity;
  trafficAggressiveness: TrafficAggressiveness;
  trafficVehicleCount: number;
  trafficVehicleMix: VehicleMixPreset;
  trafficVehicleMixWeights: TrafficVehicleMixWeights;
  trafficManager: TrafficManager | null;
  trafficCards: TrafficCard[];
  selectedTrafficCardId: string | null;
  renderConfig: ScenarioSetupRenderConfig | null;
  /**
   * Authored environment preset, whichever spelling it arrived in
   * (`setup.environment`, `renderConfig.environmentPreset`, top-level
   * `environment_preset` struct or name). Optional so callers that build
   * normalized drafts by hand stay valid; both normalize paths always set it.
   */
  environmentPreset?: EnvironmentPreset | null;
  metadata: {
    sourceScenarioId: string | null;
    mapAssetId: string | null;
    mapName: string;
    backendMapName: string | null;
    activeScenarioSimulationId: string | null;
    latestScenarioSimulationId: string | null;
    notes: string;
    worldSensorYawBasis: string | null;
    validationIntent: ScenarioValidationIntent | null;
    scenarioIntention: ScenarioIntention | null;
    scenarioMetadata: ScenarioMetadata | null;
    /** Generation-pinned actor-randomness seed (rule 3) — see
     *  ScenarioEditorMetadataSchema.actorRandomnessSeed. Absent/null on
     *  hand-authored or pre-pin drafts (semantic_default applies). */
    actorRandomnessSeed?: number | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
  raw: PersistedScenarioDraft;
};

/** Parse a persisted `validationIntent` blob, dropping anything malformed. */
function readValidationIntent(
  metadata: Record<string, unknown>,
): ScenarioValidationIntent | null {
  const parsed = ScenarioValidationIntentSchema.safeParse(metadata.validationIntent);
  return parsed.success ? parsed.data : null;
}

/** Generation-pinned actor-randomness seed (rule 3): a non-negative safe
 *  integer, else null (semantic_default applies). */
function readActorRandomnessSeed(metadata: Record<string, unknown>): number | null {
  const value = metadata.actorRandomnessSeed;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Parse a persisted `scenarioIntention` blob, dropping anything malformed. */
function readScenarioIntention(
  metadata: Record<string, unknown>,
): ScenarioIntention | null {
  const parsed = ScenarioIntentionSchema.safeParse(metadata.scenarioIntention);
  return parsed.success ? parsed.data : null;
}

/** Parse a persisted `scenarioMetadata` blob, dropping anything malformed. */
function readScenarioMetadata(
  metadata: Record<string, unknown>,
): ScenarioMetadata | null {
  const parsed = ScenarioMetadataSchema.safeParse(metadata.scenarioMetadata);
  return parsed.success ? parsed.data : null;
}

const DEFAULT_DURATION_SECONDS = SCENARIO_TIMING.defaultDurationSeconds;
const DEFAULT_FIXED_DELTA_SECONDS = 0.05;
const DEFAULT_PHYSICS_PROFILE_ID = SIMULATION_DEFAULTS.physicsProfileId;

type DraftNormalizationOptions = {
  fallbackMapName?: string | null;
  scenarioId?: string | null;
  mapAssetId?: string | null;
  backendMapName?: string | null;
  activeScenarioSimulationId?: string | null;
  latestScenarioSimulationId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asValidatedArray<T>(
  value: unknown,
  parser: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = parser.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Every actor arrives carrying a behavior program — and leaves the legacy
 * authoring surface behind.
 *
 * This is THE load-time migration (schema-prune, wave 2b). The legacy keys the
 * actor schema no longer declares (`timeline`, `timedInstructions`,
 * `autopilot`, the reaction trio, `notes`, `compiled_route_stamp`) parse
 * through the versioned legacy schema, convert into `behavior` /
 * `reaction_profile` / an explicit base clip, and are STRIPPED from the
 * normalized draft — so saving writes only the pruned shape. Wire-load-bearing
 * residue (a non-empty timeline, timedInstructions, the reaction trio) moves
 * into the actor's `legacy_wire` envelope, which the payload boundary expands
 * back to the original wire spellings so the CARLA worker receives
 * byte-identical actors. All of that lives in ONE shared function,
 * `migrateLegacyScenarioEditorActor`, which the corpus migration script runs
 * too — the load path and the durable rewrite cannot drift.
 *
 * The load stays a fixed point: a pruned draft re-runs the migration to
 * itself, and the motion an actor shows after normalizing is the motion it
 * had before.
 *
 * ## What happens to an actor this build cannot read
 *
 * It is REPORTED, never dropped. `asValidatedArray` used to return only the
 * survivors, so an actor whose shape this build rejects simply vanished from the
 * editor — and because the autosave baseline is seeded from the loaded document,
 * the next unrelated edit wrote the deletion to the database.
 *
 * Measured 2026-07-29: `[eval] S02`
 * (`68b1d66e-c43f-4c3b-9f29-446f4443b2ea`) persisted as `["subject"]` where two cars
 * had been authored, some sibling rows down to zero actors, and CARLA still
 * showing the second car because its job had been submitted before the loss. The
 * rejection was normalization's own output — see
 * `base-clip-normalization-round-trip.test.ts`.
 *
 * The caller gets both halves and is responsible for refusing to save while the
 * second half is non-empty (`useDraftPersistenceController`).
 */
export function normalizeLoadedActorDrafts(value: unknown): {
  actors: ScenarioEditorActorDraft[];
  unloadable: UnloadableActor[];
} {
  if (!Array.isArray(value)) return { actors: [], unloadable: [] };

  const parsed: Array<{ actor: ScenarioEditorActorDraft; index: number }> = [];
  const unloadable: UnloadableActor[] = [];
  value.forEach((entry, index) => {
    const result = ScenarioEditorActorDraftSchema.safeParse(entry);
    if (result.success) {
      parsed.push({ actor: result.data, index });
      return;
    }
    unloadable.push({
      index,
      actorId: asStringOrNull(asRecord(entry).id, true),
      issues: result.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join(".") || "actor"}: ${issue.message}`),
    });
  });

  // The migration context is the RAW parse output: `conflictEgoFor` needs the
  // siblings' not-yet-stripped `collision_target_id` to rebuild the walker
  // conflict trigger, exactly as before the prune.
  const contextActors = parsed.map((entry) => entry.actor);
  const actors: ScenarioEditorActorDraft[] = [];
  for (const { actor, index } of parsed) {
    try {
      actors.push(migrateLegacyScenarioEditorActor(actor, { actors: contextActors }));
    } catch (error) {
      // The legacy keys used to be validated by the actor schema itself; the
      // versioned legacy parse keeps that strictness, and its failures surface
      // exactly like any other unreadable actor: reported, never dropped.
      unloadable.push({
        index,
        actorId: asStringOrNull((actor as { id?: unknown }).id, true),
        issues:
          error instanceof z.ZodError
            ? error.issues
                .slice(0, 4)
                .map((issue) => `${issue.path.join(".") || "actor"}: ${issue.message}`)
            : [error instanceof Error ? error.message : String(error)],
      });
    }
  }
  unloadable.sort((left, right) => left.index - right.index);
  return { actors, unloadable };
}

function asValidatedFormationArray(value: unknown): SceneFormation[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("SEMANTIC_FORMATION_INVALID: semanticFormations must be an array.");
  }
  return value.map((entry, index) => {
    const parsed = SceneFormationSchema.safeParse(entry);
    if (!parsed.success) {
      const record = asRecord(entry);
      const version = asStringOrNull(record.schemaVersion, true) ?? "missing";
      throw new Error(
        `SEMANTIC_FORMATION_VERSION_UNSUPPORTED: formation ${index} uses ${version}; ${SCENE_FORMATION_SCHEMA_VERSION} is required.`,
      );
    }
    return parsed.data;
  });
}

function asValidatedFormationSolutionArray(value: unknown): SceneFormationSolution[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("SEMANTIC_FORMATION_SOLUTION_INVALID: semanticFormationSolutions must be an array.");
  }
  return value.map((entry, index) => {
    const parsed = SceneFormationSolutionSchema.safeParse(entry);
    if (!parsed.success) {
      const version = asStringOrNull(asRecord(entry).schemaVersion, true) ?? "missing";
      throw new Error(
        `SEMANTIC_FORMATION_SOLUTION_VERSION_UNSUPPORTED: solution ${index} uses ${version}; ${SCENE_FORMATION_SOLUTION_SCHEMA_VERSION} is required.`,
      );
    }
    return parsed.data;
  });
}

/**
 * Junction signal plans off a persisted draft.
 *
 * Unlike the formation arrays above, a plan that fails to parse is DROPPED
 * rather than thrown on: a plan's movement ids are cached against one map
 * revision (`scenario-signals.ts` module header), so a draft reopened after a
 * UE5 map rebuild can legitimately carry a plan the current schema rejects.
 * Throwing there would lock the author out of a whole scenario over one
 * junction they can re-author in a click.
 */
function asValidatedSignalPlanArray(value: unknown): JunctionSignalPlan[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = JunctionSignalPlanSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function defaultOutputModalityForSensorCategory(
  sensorCategory: unknown,
): SensorOutputModality | null {
  return sensorCategory === "camera" ? "rgb" : null;
}

function normalizeLegacySensorInput(
  value: unknown,
  options: { defaultAttachTo?: string } = {},
): unknown {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return value;
  const sensorCategory =
    record.sensorCategory ?? record.sensor_category ?? record.kind;
  const outputModality =
    record.outputModality ??
    record.output_modality ??
    defaultOutputModalityForSensorCategory(sensorCategory);
  const attachTo = record.attachTo ?? record.attach_to ?? options.defaultAttachTo;

  return {
    ...record,
    ...(sensorCategory ? { sensorCategory } : {}),
    ...(outputModality ? { outputModality } : {}),
    ...(attachTo ? { attachTo } : {}),
  };
}

function asValidatedSensorArray(
  value: unknown,
  options: { defaultAttachTo?: string } = {},
): Sensor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = SensorSchema.safeParse(normalizeLegacySensorInput(entry, options));
    return parsed.success ? [parsed.data] : [];
  });
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringOrNull(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 && !allowEmpty) return null;
  return trimmed;
}

function readStringFromRecord(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = asStringOrNull(record[key]);
    if (value) return value;
  }
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stripUndefinedAndLegacy(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => stripUndefinedAndLegacy(entry))
      .filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      entry === undefined ||
      key === "selectedActorId" ||
      key === "selected_actor_id" ||
      key === "selectedTrafficCardId" ||
      key === "selected_traffic_card_id" ||
      key === "trafficManager" ||
      key === "trafficCards" ||
      key === "savedPreviewTimeline" ||
      key === "editorHistory" ||
      key === "previewFrameHistory" ||
      key === "previewFrames" ||
      key === "recording" ||
      key === "recordings" ||
      key === "artifacts" ||
      key === "simulations" ||
      key === "configJson" ||
      key === "createdAt" ||
      key === "updatedAt" ||
      key === "created_at" ||
      key === "updated_at"
    ) {
      continue;
    }
    output[key] = stripUndefinedAndLegacy(entry);
  }
  return output;
}

/**
 * The actors a draft may PERSIST: everything except expanded ambient members.
 *
 * A member carries `origin.kind === "ambient_region"` — the expander's stamp —
 * and exists only between payload builds; the region spec
 * (`setup.scene.ambientTraffic`) is what saves, and the members are recomputed
 * from it. Writing one into storage would freeze one draw of the region as
 * authored fact and double the cars on the next expansion.
 *
 * Deliberately NOT keyed on `ambient_generated`: pre-migration drafts carry
 * baked snapshot cars with that flag and no origin, and those must keep
 * persisting — re-expanding them would re-randomize a scene somebody accepted
 * (`draft/route.ts` records the same rule for the hoist).
 */
function persistableActorDrafts(
  actors: ScenarioEditorActorDraft[],
): ScenarioEditorActorDraft[] {
  // Saving writes only the PRUNED shape. The migration is idempotent, so for
  // an actor the load path already migrated this is a no-op; for anything a
  // caller hands the serializer directly it is the same one migration the load
  // runs — legacy keys convert and strip rather than leak into storage.
  return actors
    .filter((actor) => actor.origin?.kind !== "ambient_region")
    .map((actor) => migrateLegacyScenarioEditorActor(actor, { actors }));
}

/** The first parseable ambient-traffic spec among `sources`, else null. */
function readAmbientTraffic(
  ...sources: unknown[]
): ScenarioEditorAmbientTraffic | null {
  for (const source of sources) {
    if (source == null) continue;
    const parsed = ScenarioEditorAmbientTrafficSchema.safeParse(source);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function portableActorDrafts(actors: ScenarioEditorActorDraft[]): ScenarioEditorActorDraft[] {
  return persistableActorDrafts(actors).map((actor) => {
    const portable = stripUndefinedAndLegacy(cloneJson(actor));
    const parsed = ScenarioEditorActorDraftSchema.safeParse(portable);
    return parsed.success ? parsed.data : actor;
  });
}

function portableSensors(sensors: Sensor[]): Sensor[] {
  return sensors.map((sensor) => {
    const portable = stripUndefinedAndLegacy(cloneJson(sensor));
    const parsed = SensorSchema.safeParse(portable);
    return parsed.success ? parsed.data : sensor;
  });
}

function extractScenarioSetup(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.schemaVersion === SCENARIO_SETUP_SCHEMA_VERSION) return raw;
  if (raw.schemaVersion === PERSISTED_NATIVE_DRAFT_SCHEMA_VERSION) {
    const setup = asRecord(raw.setup);
    return setup.schemaVersion === SCENARIO_SETUP_SCHEMA_VERSION ? setup : null;
  }
  if (raw.version === 3) {
    const setup = asRecord(raw.setup);
    return setup.schemaVersion === SCENARIO_SETUP_SCHEMA_VERSION ? setup : null;
  }
  return null;
}

function normalizeScenarioSetupDraft(
  rawDraft: unknown,
  options?: DraftNormalizationOptions,
): NormalizedScenarioDraft | null {
  const raw = asRecord(rawDraft);
  const setup = extractScenarioSetup(raw);
  if (!setup) return null;

  const persistence = asRecord(raw.persistence);
  const map = asRecord(setup.map);
  const simulation = asRecord(setup.simulation);
  const scene = asRecord(setup.scene);
  const setupMetadata = asRecord(setup.metadata);
  const traffic = asRecord(setup.traffic);
  const carLed = asRecord(traffic.carLed);
  const globalTraffic = asRecord(traffic.global);
  const { actors, unloadable: unloadableActors } = normalizeLoadedActorDrafts(scene.actors);
  const semanticFormations = asValidatedFormationArray(scene.semanticFormations);
  const semanticFormationSolutions = asValidatedFormationSolutionArray(scene.semanticFormationSolutions);
  const signalPlans = asValidatedSignalPlanArray(scene.signalPlans);
  const worldSensorYawBasis =
    readStringFromRecord(setupMetadata, "worldSensorYawBasis") ?? null;
  const worldSensors = normalizeWorldSensorYawBasis(
    asValidatedSensorArray(scene.worldSensors, { defaultAttachTo: "world" }),
    worldSensorYawBasis,
  );
  const mapName =
    asStringOrNull(options?.fallbackMapName, true) ??
    readStringFromRecord(map, "mapName", "backendMapName") ??
    "";
  const mapAssetId =
    asStringOrNull(options?.mapAssetId) ??
    readStringFromRecord(map, "mapAssetId") ??
    readStringFromRecord(persistence, "mapAssetId") ??
    null;
  const backendMapName =
    asStringOrNull(options?.backendMapName) ??
    readStringFromRecord(map, "backendMapName") ??
    mapName;
  const sourceScenarioId =
    asStringOrNull(options?.scenarioId) ??
    readStringFromRecord(persistence, "sourceScenarioId") ??
    null;

  return {
    mapName,
    actors,
    unloadableActors,
    semanticFormations,
    semanticFormationSolutions,
    // `setup.scene.ambientTraffic` is the canonical home; the wrapper top level
    // covers the draft PUT route's hoist output (it writes the field beside
    // `setup`, not inside it) and merged payloads that predate the scene home.
    ambientTraffic: readAmbientTraffic(scene.ambientTraffic, raw.ambientTraffic),
    signalPlans,
    selectedActorId: null,
    durationSeconds: asNumber(simulation.durationSeconds, DEFAULT_DURATION_SECONDS),
    fixedDeltaSeconds: asNumber(
      simulation.fixedDeltaSeconds,
      DEFAULT_FIXED_DELTA_SECONDS,
    ),
    physicsProfileId: normalizePhysicsProfileId(
      simulation.physicsProfileId ??
        simulation.physics_profile_id ??
        DEFAULT_PHYSICS_PROFILE_ID,
    ),
    worldSensors,
    carLedTrafficEnabled: carLed.enabled === true,
    carLedTrafficCarsPerActor: Math.max(
      1,
      Math.min(20, Math.round(asNumber(carLed.carsPerActor, 4))),
    ),
    carLedTrafficRadiusMeters: Math.max(
      5,
      Math.min(100, Math.round(asNumber(carLed.radiusMeters, 30))),
    ),
    carLedTrafficMinimumSpacingMeters: Math.max(
      2,
      Math.min(40, Math.round(asNumber(carLed.minimumSpacingMeters, 8))),
    ),
    carLedTrafficAggressiveness: parseTrafficAggressiveness(carLed.aggressiveness),
    carLedTrafficBaseSpeedKph: Math.max(
      5,
      Math.min(130, Math.round(asNumber(carLed.baseSpeedKph, 50))),
    ),
    carLedTrafficVariantSeed: Math.max(
      0,
      Math.round(asNumber(carLed.variantSeed, 0)),
    ),
    trafficEnabled: globalTraffic.enabled === true,
    trafficDensity: parseTrafficDensity(globalTraffic.density),
    trafficAggressiveness: parseTrafficAggressiveness(
      globalTraffic.aggressiveness,
    ),
    trafficVehicleCount: Math.max(
      1,
      Math.round(
        asNumber(
          globalTraffic.vehicleCount,
          DENSITY_VEHICLE_COUNTS[parseTrafficDensity(globalTraffic.density)],
        ),
      ),
    ),
    trafficVehicleMix: parseVehicleMixPreset(globalTraffic.vehicleMix),
    trafficVehicleMixWeights: parseVehicleMixWeights(
      globalTraffic.vehicleMixWeights,
    ),
    trafficManager: null,
    trafficCards: [],
    selectedTrafficCardId: null,
    renderConfig: parseRenderConfig(setup.renderConfig),
    // `setup.environment` is the canonical home; the renderConfig rider and the
    // top-level spellings cover drafts saved before it existed (and merged PUT
    // payloads that carry the preset at the top level). Read structurally, NOT
    // through parseRenderConfig — that returns null whenever outputSpec fails
    // to parse and used to take the authored weather down with it (defect #24).
    environmentPreset:
      lenientEnvironmentPreset(setup.environment) ??
      lenientEnvironmentPreset(asRecord(setup.renderConfig).environmentPreset) ??
      lenientEnvironmentPreset(raw.environmentPreset ?? raw.environment_preset),
    metadata: {
      sourceScenarioId,
      mapAssetId,
      mapName,
      backendMapName,
      activeScenarioSimulationId:
        asStringOrNull(options?.activeScenarioSimulationId) ??
        readStringFromRecord(persistence, "activeScenarioSimulationId") ??
        null,
      latestScenarioSimulationId:
        asStringOrNull(options?.latestScenarioSimulationId) ??
        readStringFromRecord(persistence, "latestScenarioSimulationId") ??
        null,
      notes: asStringOrNull(setupMetadata.notes, true) ?? "",
      worldSensorYawBasis: STREET_CAMERA_YAW_BASIS_VERSION,
      validationIntent: readValidationIntent(setupMetadata),
      scenarioIntention: readScenarioIntention(setupMetadata),
      scenarioMetadata: readScenarioMetadata(setupMetadata),
      actorRandomnessSeed: readActorRandomnessSeed(setupMetadata),
      createdAt: asStringOrNull(options?.createdAt) ?? null,
      updatedAt: asStringOrNull(options?.updatedAt) ?? null,
    },
    raw,
  };
}

function parseTrafficDensity(value: unknown): TrafficDensity {
  return value === "light" || value === "moderate" || value === "heavy"
    ? value
    : "moderate";
}

function parseTrafficAggressiveness(value: unknown): TrafficAggressiveness {
  return value === "calm" || value === "normal" || value === "aggressive"
    ? value
    : "normal";
}

function parseVehicleMixPreset(value: unknown): VehicleMixPreset {
  return value === "cars_only" || value === "mixed" || value === "custom"
    ? value
    : "mixed";
}

function parseVehicleMixWeights(value: unknown): TrafficVehicleMixWeights {
  const record = asRecord(value);
  return {
    passenger: Math.max(0, Math.min(100, asNumber(record.passenger, DEFAULT_CUSTOM_VEHICLE_MIX.passenger))),
    truck: Math.max(0, Math.min(100, asNumber(record.truck, DEFAULT_CUSTOM_VEHICLE_MIX.truck))),
    bus: Math.max(0, Math.min(100, asNumber(record.bus, DEFAULT_CUSTOM_VEHICLE_MIX.bus))),
  };
}

function readSimulationConfig(raw: Record<string, unknown>) {
  return asRecord(raw.simulationConfig);
}

function readMetadata(
  raw: Record<string, unknown>,
  options: DraftNormalizationOptions | undefined,
  mapName: string,
) {
  const metadata = asRecord(raw.metadata);
  const optionScenarioId = asStringOrNull(options?.scenarioId);
  const optionMapAssetId = asStringOrNull(options?.mapAssetId);
  const optionBackendMapName = asStringOrNull(options?.backendMapName);
  const optionActiveSimulationId = asStringOrNull(options?.activeScenarioSimulationId);
  const optionLatestSimulationId = asStringOrNull(options?.latestScenarioSimulationId);
  const optionCreatedAt = asStringOrNull(options?.createdAt);
  const optionUpdatedAt = asStringOrNull(options?.updatedAt);

  return {
    sourceScenarioId:
      optionScenarioId ??
      readStringFromRecord(metadata, "sourceScenarioId") ??
      null,
    mapAssetId:
      optionMapAssetId ??
      readStringFromRecord(metadata, "mapAssetId") ??
      null,
    mapName,
    backendMapName:
      optionBackendMapName ??
      readStringFromRecord(metadata, "backendMapName") ??
      (mapName || null),
    activeScenarioSimulationId:
      optionActiveSimulationId ??
      readStringFromRecord(metadata, "activeScenarioSimulationId") ??
      null,
    latestScenarioSimulationId:
      optionLatestSimulationId ??
      readStringFromRecord(metadata, "latestScenarioSimulationId") ??
      null,
    notes: asStringOrNull(metadata.notes, true) ?? "",
    worldSensorYawBasis:
      readStringFromRecord(metadata, "worldSensorYawBasis") ??
      null,
    validationIntent: readValidationIntent(metadata),
    scenarioIntention: readScenarioIntention(metadata),
    scenarioMetadata: readScenarioMetadata(metadata),
    createdAt:
      optionCreatedAt ??
      readStringFromRecord(metadata, "createdAt") ??
      null,
    updatedAt:
      optionUpdatedAt ??
      readStringFromRecord(metadata, "updatedAt") ??
      null,
  };
}

function normalizeWorldSensorYawBasis(
  sensors: Sensor[],
  worldSensorYawBasis: string | null,
): Sensor[] {
  if (worldSensorYawBasis === STREET_CAMERA_YAW_BASIS_VERSION) {
    return sensors;
  }
  return upgradeLegacyStreetCameraYaws(sensors);
}

function buildNativeDraft(
  draft: Pick<
    NormalizedScenarioDraft,
    | "mapName"
    | "actors"
    | "selectedActorId"
    | "durationSeconds"
    | "fixedDeltaSeconds"
    | "physicsProfileId"
    | "worldSensors"
    | "carLedTrafficEnabled"
    | "carLedTrafficCarsPerActor"
    | "carLedTrafficRadiusMeters"
    | "carLedTrafficMinimumSpacingMeters"
    | "carLedTrafficAggressiveness"
    | "carLedTrafficBaseSpeedKph"
    | "carLedTrafficVariantSeed"
    | "trafficEnabled"
    | "trafficDensity"
    | "trafficAggressiveness"
    | "trafficVehicleCount"
    | "trafficVehicleMix"
    | "trafficVehicleMixWeights"
    | "trafficManager"
    | "trafficCards"
    | "selectedTrafficCardId"
    | "renderConfig"
    | "metadata"
  > & Partial<
    Pick<
      NormalizedScenarioDraft,
      | "semanticFormations"
      | "semanticFormationSolutions"
      | "signalPlans"
      | "environmentPreset"
      | "ambientTraffic"
    >
  >,
): ScenarioEditorDraft {
  const createdAt = draft.metadata.createdAt ?? new Date().toISOString();
  const updatedAt = draft.metadata.updatedAt ?? createdAt;
  // The native draft's only environment carrier is `renderConfig.environmentPreset`
  // (the spelling `environmentPresetFromDraft` and the render lane both read), so
  // a preset must ride there even when the draft has no other render config.
  const strippedRenderConfig = draft.renderConfig
    ? (stripUndefinedAndLegacy(
        cloneJson(draft.renderConfig),
      ) as ScenarioSetupRenderConfig)
    : null;
  const environmentPreset =
    draft.environmentPreset ??
    (strippedRenderConfig?.environmentPreset as EnvironmentPreset | undefined) ??
    null;
  const renderConfig =
    strippedRenderConfig || environmentPreset
      ? ({
          ...(strippedRenderConfig ?? {}),
          ...(environmentPreset
            ? { environmentPreset: environmentPreset as Record<string, unknown> }
            : {}),
        } as ScenarioSetupRenderConfig)
      : null;

  return {
    version: 2,
    metadata: {
      sourceScenarioId: draft.metadata.sourceScenarioId ?? "",
      mapAssetId: draft.metadata.mapAssetId ?? "",
      mapName: draft.metadata.mapName || draft.mapName,
      backendMapName: draft.metadata.backendMapName ?? undefined,
      activeScenarioSimulationId: draft.metadata.activeScenarioSimulationId ?? undefined,
      latestScenarioSimulationId: draft.metadata.latestScenarioSimulationId ?? undefined,
      notes: draft.metadata.notes,
      worldSensorYawBasis: STREET_CAMERA_YAW_BASIS_VERSION,
      validationIntent: draft.metadata.validationIntent ?? undefined,
      scenarioIntention: draft.metadata.scenarioIntention ?? undefined,
      scenarioMetadata: draft.metadata.scenarioMetadata ?? undefined,
      createdAt,
      updatedAt,
    },
    simulationConfig: {
      duration_seconds: draft.durationSeconds,
      fixed_delta_seconds: draft.fixedDeltaSeconds,
      physics_profile_id: draft.physicsProfileId,
    },
    // The expanded ambient members are ephemeral; only the region spec below
    // may travel on a draft.
    actors: persistableActorDrafts(draft.actors),
    semanticFormations: draft.semanticFormations ?? [],
    semanticFormationSolutions: draft.semanticFormationSolutions ?? [],
    // `.optional()` on the schema: writing the key on every draft that has no
    // ambient traffic would churn the persisted document on open.
    ...(draft.ambientTraffic ? { ambientTraffic: draft.ambientTraffic } : {}),
    // `.optional()` on the schema: an empty array would write a meaningless key
    // into every legacy draft and churn the persisted document on open.
    ...(draft.signalPlans?.length ? { signal_plans: draft.signalPlans } : {}),
    selectedActorId: draft.selectedActorId,
    worldSensors: draft.worldSensors,
    carLedTrafficEnabled: draft.carLedTrafficEnabled,
    carLedTrafficCarsPerActor: draft.carLedTrafficCarsPerActor,
    carLedTrafficRadiusMeters: draft.carLedTrafficRadiusMeters,
    carLedTrafficMinimumSpacingMeters: draft.carLedTrafficMinimumSpacingMeters,
    carLedTrafficAggressiveness: draft.carLedTrafficAggressiveness,
    carLedTrafficBaseSpeedKph: draft.carLedTrafficBaseSpeedKph,
    carLedTrafficVariantSeed: draft.carLedTrafficVariantSeed,
    trafficEnabled: draft.trafficEnabled,
    trafficDensity: draft.trafficDensity,
    trafficAggressiveness: draft.trafficAggressiveness,
    trafficVehicleCount: draft.trafficVehicleCount,
    trafficVehicleMix: draft.trafficVehicleMix,
    trafficVehicleMixWeights: draft.trafficVehicleMixWeights,
    trafficManager: undefined,
    trafficCards: [],
    selectedTrafficCardId: null,
    ...(renderConfig ? { renderConfig } : {}),
  };
}

export function toNativeScenarioDraft(
  draft: Pick<
    NormalizedScenarioDraft,
    | "mapName"
    | "actors"
    | "selectedActorId"
    | "durationSeconds"
    | "fixedDeltaSeconds"
    | "physicsProfileId"
    | "worldSensors"
    | "carLedTrafficEnabled"
    | "carLedTrafficCarsPerActor"
    | "carLedTrafficRadiusMeters"
    | "carLedTrafficMinimumSpacingMeters"
    | "carLedTrafficAggressiveness"
    | "carLedTrafficBaseSpeedKph"
    | "carLedTrafficVariantSeed"
    | "trafficEnabled"
    | "trafficDensity"
    | "trafficAggressiveness"
    | "trafficVehicleCount"
    | "trafficVehicleMix"
    | "trafficVehicleMixWeights"
    | "trafficManager"
    | "trafficCards"
    | "selectedTrafficCardId"
    | "renderConfig"
    | "metadata"
  > & Partial<
    Pick<
      NormalizedScenarioDraft,
      | "semanticFormations"
      | "semanticFormationSolutions"
      | "signalPlans"
      | "environmentPreset"
      | "ambientTraffic"
    >
  >,
): ScenarioEditorDraft {
  return buildNativeDraft(draft);
}

export function normalizeScenarioDraft(
  rawDraft: unknown,
  options?: DraftNormalizationOptions,
): NormalizedScenarioDraft {
  const setupDraft = normalizeScenarioSetupDraft(rawDraft, options);
  if (setupDraft) return setupDraft;

  const raw = asRecord(rawDraft);
  const simulationConfig = readSimulationConfig(raw);
  const { actors, unloadable: unloadableActors } = normalizeLoadedActorDrafts(raw.actors);
  const semanticFormations = asValidatedFormationArray(raw.semanticFormations);
  const semanticFormationSolutions = asValidatedFormationSolutionArray(raw.semanticFormationSolutions);
  const signalPlans = asValidatedSignalPlanArray(raw.signal_plans ?? raw.signalPlans);
  const hasNewTrafficFields = hasOwn(raw, "trafficEnabled");
  const parsedTrafficManager = hasNewTrafficFields
    ? { success: false as const }
    : TrafficManagerSchema.safeParse(raw.trafficManager);
  const trafficManager = parsedTrafficManager.success
    ? parsedTrafficManager.data
    : null;
  const trafficCards = hasNewTrafficFields
    ? []
    : asValidatedArray(raw.trafficCards, TrafficCardSchema);
  const rawSelectedTrafficCardId =
    readStringFromRecord(raw, "selectedTrafficCardId", "selected_traffic_card_id") ??
    null;
  const trafficCardIds = new Set(trafficCards.map((card) => card.id));
  const selectedTrafficCardId =
    rawSelectedTrafficCardId && trafficCardIds.has(rawSelectedTrafficCardId)
      ? rawSelectedTrafficCardId
      : null;
  const camelWorldSensors = asValidatedSensorArray(raw.worldSensors, {
    defaultAttachTo: "world",
  });
  const worldSensors =
    camelWorldSensors.length > 0
      ? camelWorldSensors
      : asValidatedSensorArray(raw.world_sensors, { defaultAttachTo: "world" });
  const mapName =
    asStringOrNull(options?.fallbackMapName, true) ??
    readStringFromRecord(asRecord(raw.metadata), "mapName", "backendMapName") ??
    readStringFromRecord(raw, "map_name", "mapName") ??
    "";
  const metadata = readMetadata(raw, options, mapName);
  const selectedActorId =
    readStringFromRecord(raw, "selectedActorId", "selected_actor_id") ??
    null;
  const actorIds = new Set(actors.map((actor) => actor.id));
  const stableSelectedActorId = selectedActorId && actorIds.has(selectedActorId)
    ? selectedActorId
    : null;

  return {
    mapName,
    actors,
    unloadableActors,
    semanticFormations,
    semanticFormationSolutions,
    // The native draft's spelling of the scene field
    // (`ScenarioEditorDraftSchema.ambientTraffic`).
    ambientTraffic: readAmbientTraffic(raw.ambientTraffic),
    signalPlans,
    selectedActorId: stableSelectedActorId,
    durationSeconds: asNumber(
      simulationConfig.duration_seconds ?? raw.duration_seconds ?? raw.durationSeconds,
      DEFAULT_DURATION_SECONDS,
    ),
    fixedDeltaSeconds: asNumber(
      simulationConfig.fixed_delta_seconds ?? raw.fixed_delta_seconds ?? raw.fixedDeltaSeconds,
      DEFAULT_FIXED_DELTA_SECONDS,
    ),
    physicsProfileId: normalizePhysicsProfileId(
      simulationConfig.physics_profile_id ??
        simulationConfig.physicsProfileId ??
        raw.physics_profile_id ??
        raw.physicsProfileId ??
        DEFAULT_PHYSICS_PROFILE_ID,
    ),
    worldSensors: normalizeWorldSensorYawBasis(
      worldSensors,
      metadata.worldSensorYawBasis,
    ),
    carLedTrafficEnabled: raw.carLedTrafficEnabled === true,
    carLedTrafficCarsPerActor: Math.max(
      1,
      Math.min(20, Math.round(asNumber(raw.carLedTrafficCarsPerActor, 4))),
    ),
    carLedTrafficRadiusMeters: Math.max(
      5,
      Math.min(100, Math.round(asNumber(raw.carLedTrafficRadiusMeters, 30))),
    ),
    carLedTrafficMinimumSpacingMeters: Math.max(
      2,
      Math.min(40, Math.round(asNumber(raw.carLedTrafficMinimumSpacingMeters, 8))),
    ),
    carLedTrafficAggressiveness: parseTrafficAggressiveness(
      raw.carLedTrafficAggressiveness,
    ),
    carLedTrafficBaseSpeedKph: Math.max(
      5,
      Math.min(130, Math.round(asNumber(raw.carLedTrafficBaseSpeedKph, 50))),
    ),
    carLedTrafficVariantSeed: Math.max(
      0,
      Math.round(asNumber(raw.carLedTrafficVariantSeed, 0)),
    ),
    trafficEnabled: hasNewTrafficFields ? raw.trafficEnabled === true : false,
    trafficDensity: parseTrafficDensity(raw.trafficDensity),
    trafficAggressiveness: parseTrafficAggressiveness(raw.trafficAggressiveness),
    trafficVehicleCount: Math.max(
      1,
      Math.round(
        asNumber(
          raw.trafficVehicleCount,
          DENSITY_VEHICLE_COUNTS[parseTrafficDensity(raw.trafficDensity)],
        ),
      ),
    ),
    trafficVehicleMix: parseVehicleMixPreset(raw.trafficVehicleMix),
    trafficVehicleMixWeights: parseVehicleMixWeights(raw.trafficVehicleMixWeights),
    trafficManager,
    trafficCards,
    selectedTrafficCardId,
    renderConfig: parseRenderConfig(raw.renderConfig),
    // Same structural read as the setup path: the preset must not depend on the
    // rest of renderConfig parsing (defect #24).
    environmentPreset:
      lenientEnvironmentPreset(raw.environmentPreset ?? raw.environment_preset) ??
      lenientEnvironmentPreset(asRecord(raw.renderConfig).environmentPreset),
    metadata: {
      ...metadata,
      worldSensorYawBasis: STREET_CAMERA_YAW_BASIS_VERSION,
    },
    raw,
  };
}

export function toScenarioSetupJson(
  draft: Pick<
    NormalizedScenarioDraft,
    | "mapName"
    | "actors"
    | "semanticFormations"
    | "semanticFormationSolutions"
    | "signalPlans"
    | "durationSeconds"
    | "fixedDeltaSeconds"
    | "physicsProfileId"
    | "worldSensors"
    | "carLedTrafficEnabled"
    | "carLedTrafficCarsPerActor"
    | "carLedTrafficRadiusMeters"
    | "carLedTrafficMinimumSpacingMeters"
    | "carLedTrafficAggressiveness"
    | "carLedTrafficBaseSpeedKph"
    | "carLedTrafficVariantSeed"
    | "trafficEnabled"
    | "trafficDensity"
    | "trafficAggressiveness"
    | "trafficVehicleCount"
    | "trafficVehicleMix"
    | "trafficVehicleMixWeights"
    | "renderConfig"
    | "metadata"
  > & Partial<Pick<NormalizedScenarioDraft, "environmentPreset" | "ambientTraffic">>,
  options?: DraftNormalizationOptions & {
    renderConfig?: ScenarioSetupRenderConfig | null;
    name?: string | null;
    notes?: string | null;
  },
): ScenarioSetupJsonV3 {
  const canonicalMapName =
    asStringOrNull(options?.fallbackMapName, true) ??
    draft.mapName;
  const canonicalBackendMapName =
    asStringOrNull(options?.backendMapName) ??
    draft.metadata.backendMapName ??
    canonicalMapName;
  const canonicalMapAssetId =
    asStringOrNull(options?.mapAssetId) ??
    draft.metadata.mapAssetId;
  const renderConfig = options?.renderConfig ?? draft.renderConfig ?? null;
  const portableRenderConfig = renderConfig
    ? (stripUndefinedAndLegacy(cloneJson(renderConfig)) as ScenarioSetupRenderConfig)
    : undefined;

  return {
    schemaVersion: SCENARIO_SETUP_SCHEMA_VERSION,
    metadata: {
      ...(asStringOrNull(options?.name, true)
        ? { name: asStringOrNull(options?.name, true) ?? undefined }
        : {}),
      notes:
        asStringOrNull(options?.notes, true) ??
        asStringOrNull(draft.metadata.notes, true) ??
        "",
      worldSensorYawBasis: STREET_CAMERA_YAW_BASIS_VERSION,
      ...(draft.metadata.validationIntent
        ? { validationIntent: draft.metadata.validationIntent }
        : {}),
      ...(draft.metadata.scenarioIntention
        ? { scenarioIntention: draft.metadata.scenarioIntention }
        : {}),
      ...(draft.metadata.scenarioMetadata
        ? { scenarioMetadata: draft.metadata.scenarioMetadata }
        : {}),
      ...(draft.metadata.actorRandomnessSeed != null
        ? { actorRandomnessSeed: draft.metadata.actorRandomnessSeed }
        : {}),
    },
    map: {
      mapName: canonicalMapName,
      backendMapName: canonicalBackendMapName,
      mapAssetId: canonicalMapAssetId,
    },
    simulation: {
      durationSeconds: draft.durationSeconds,
      fixedDeltaSeconds: draft.fixedDeltaSeconds,
      physicsProfileId: draft.physicsProfileId,
    },
    // Fall back to the renderConfig rider so presets survive callers that
    // still pass drafts predating the first-class field.
    ...(draft.environmentPreset ??
    (renderConfig?.environmentPreset as EnvironmentPreset | undefined)
      ? {
          environment:
            draft.environmentPreset ??
            (renderConfig?.environmentPreset as EnvironmentPreset),
        }
      : {}),
    scene: {
      actors: portableActorDrafts(draft.actors),
      // The one persisted home for the ambient region spec; omitted rather
      // than null so drafts without ambient traffic do not churn on save.
      ...(draft.ambientTraffic ? { ambientTraffic: draft.ambientTraffic } : {}),
      semanticFormations: draft.semanticFormations,
      semanticFormationSolutions: draft.semanticFormationSolutions,
      ...(draft.signalPlans.length > 0 ? { signalPlans: draft.signalPlans } : {}),
      worldSensors: portableSensors(draft.worldSensors),
    },
    traffic: {
      carLed: {
        enabled: draft.carLedTrafficEnabled,
        carsPerActor: draft.carLedTrafficCarsPerActor,
        radiusMeters: draft.carLedTrafficRadiusMeters,
        minimumSpacingMeters: draft.carLedTrafficMinimumSpacingMeters,
        // The portable JSON always carries a concrete value; the draft field is
        // optional so pre-existing drafts (and every fixture literal) stay
        // valid without restating a default they never had.
        aggressiveness: draft.carLedTrafficAggressiveness ?? "normal",
        baseSpeedKph: draft.carLedTrafficBaseSpeedKph ?? 50,
        variantSeed: draft.carLedTrafficVariantSeed ?? 0,
      },
      global: {
        enabled: draft.trafficEnabled,
        density: draft.trafficDensity,
        aggressiveness: draft.trafficAggressiveness,
        vehicleCount: draft.trafficVehicleCount,
        vehicleMix: draft.trafficVehicleMix,
        vehicleMixWeights: draft.trafficVehicleMixWeights,
      },
    },
    ...(portableRenderConfig ? { renderConfig: portableRenderConfig } : {}),
  };
}

export function toPersistedScenarioSetupDraft(
  draft: Pick<
    NormalizedScenarioDraft,
    | "mapName"
    | "actors"
    | "semanticFormations"
    | "semanticFormationSolutions"
    | "signalPlans"
    | "durationSeconds"
    | "fixedDeltaSeconds"
    | "physicsProfileId"
    | "worldSensors"
    | "carLedTrafficEnabled"
    | "carLedTrafficCarsPerActor"
    | "carLedTrafficRadiusMeters"
    | "carLedTrafficMinimumSpacingMeters"
    | "carLedTrafficAggressiveness"
    | "carLedTrafficBaseSpeedKph"
    | "carLedTrafficVariantSeed"
    | "trafficEnabled"
    | "trafficDensity"
    | "trafficAggressiveness"
    | "trafficVehicleCount"
    | "trafficVehicleMix"
    | "trafficVehicleMixWeights"
    | "renderConfig"
    | "metadata"
  > & Partial<Pick<NormalizedScenarioDraft, "environmentPreset" | "ambientTraffic">>,
  _previous?: PersistedScenarioDraft | null,
  options?: DraftNormalizationOptions & {
    renderConfig?: ScenarioSetupRenderConfig | null;
    name?: string | null;
    notes?: string | null;
  },
): PersistedScenarioDraft {
  return {
    version: 3,
    schemaVersion: PERSISTED_NATIVE_DRAFT_SCHEMA_VERSION,
    persistence: {
      sourceScenarioId:
        asStringOrNull(options?.scenarioId) ??
        draft.metadata.sourceScenarioId,
      mapAssetId:
        asStringOrNull(options?.mapAssetId) ??
        draft.metadata.mapAssetId,
      activeScenarioSimulationId:
        asStringOrNull(options?.activeScenarioSimulationId) ??
        draft.metadata.activeScenarioSimulationId,
      latestScenarioSimulationId:
        asStringOrNull(options?.latestScenarioSimulationId) ??
        draft.metadata.latestScenarioSimulationId,
    },
    setup: toScenarioSetupJson(draft, options),
  };
}

export function toPersistedScenarioDraft(
  draft: Pick<
    NormalizedScenarioDraft,
    | "mapName"
    | "actors"
    | "selectedActorId"
    | "durationSeconds"
    | "fixedDeltaSeconds"
    | "physicsProfileId"
    | "worldSensors"
    | "carLedTrafficEnabled"
    | "carLedTrafficCarsPerActor"
    | "carLedTrafficRadiusMeters"
    | "carLedTrafficMinimumSpacingMeters"
    | "carLedTrafficAggressiveness"
    | "carLedTrafficBaseSpeedKph"
    | "carLedTrafficVariantSeed"
    | "trafficEnabled"
    | "trafficDensity"
    | "trafficAggressiveness"
    | "trafficVehicleCount"
    | "trafficVehicleMix"
    | "trafficVehicleMixWeights"
    | "trafficManager"
    | "trafficCards"
    | "selectedTrafficCardId"
    | "renderConfig"
    | "metadata"
  > & Partial<
    Pick<
      NormalizedScenarioDraft,
      | "semanticFormations"
      | "semanticFormationSolutions"
      | "signalPlans"
      | "environmentPreset"
      | "ambientTraffic"
    >
  >,
  previous?: PersistedScenarioDraft | null,
  options?: DraftNormalizationOptions,
): PersistedScenarioDraft {
  const next = { ...(previous ?? {}) };
  const canonicalMapName =
    asStringOrNull(options?.fallbackMapName, true) ??
    draft.mapName;
  const canonicalMapAssetId =
    asStringOrNull(options?.mapAssetId) ??
    draft.metadata.mapAssetId;
  const canonicalBackendMapName =
    asStringOrNull(options?.backendMapName) ??
    draft.metadata.backendMapName ??
    canonicalMapName;
  const nativeDraft = buildNativeDraft({
    ...draft,
    metadata: {
      ...draft.metadata,
      mapName: canonicalMapName,
      sourceScenarioId:
        asStringOrNull(options?.scenarioId) ??
        draft.metadata.sourceScenarioId,
      mapAssetId: canonicalMapAssetId,
      backendMapName: canonicalBackendMapName,
      activeScenarioSimulationId:
        asStringOrNull(options?.activeScenarioSimulationId) ??
        draft.metadata.activeScenarioSimulationId,
      latestScenarioSimulationId:
        asStringOrNull(options?.latestScenarioSimulationId) ??
        draft.metadata.latestScenarioSimulationId,
      createdAt:
        asStringOrNull(options?.createdAt) ??
        draft.metadata.createdAt,
      updatedAt:
        asStringOrNull(options?.updatedAt) ??
        draft.metadata.updatedAt ??
        draft.metadata.createdAt ??
        asStringOrNull(options?.createdAt),
    },
  });

  next.version = nativeDraft.version;
  next.metadata = {
    ...asRecord(next.metadata),
    ...nativeDraft.metadata,
  };
  next.simulationConfig = {
    ...asRecord(next.simulationConfig),
    ...nativeDraft.simulationConfig,
  };
  next.map_name = canonicalMapName;
  next.mapName = canonicalMapName;
  next.actors = persistableActorDrafts(draft.actors);
  next.semanticFormations = draft.semanticFormations ?? [];
  next.semanticFormationSolutions = draft.semanticFormationSolutions ?? [];
  // Same shape rule as `environmentPreset` below: carried when present,
  // removed when the draft has none, so a deleted region does not resurrect
  // from a stale key on the previous document.
  if (draft.ambientTraffic) {
    next.ambientTraffic = draft.ambientTraffic;
  } else if (hasOwn(next, "ambientTraffic")) {
    delete next.ambientTraffic;
  }
  next.signalPlans = draft.signalPlans ?? [];
  next.selectedActorId = draft.selectedActorId;
  next.selected_actor_id = draft.selectedActorId;
  next.duration_seconds = draft.durationSeconds;
  next.durationSeconds = draft.durationSeconds;
  next.fixed_delta_seconds = draft.fixedDeltaSeconds;
  next.fixedDeltaSeconds = draft.fixedDeltaSeconds;
  next.physics_profile_id = draft.physicsProfileId;
  next.physicsProfileId = draft.physicsProfileId;
  next.world_sensors = draft.worldSensors;
  next.worldSensors = draft.worldSensors;
  next.carLedTrafficEnabled = draft.carLedTrafficEnabled;
  next.carLedTrafficCarsPerActor = draft.carLedTrafficCarsPerActor;
  next.carLedTrafficRadiusMeters = draft.carLedTrafficRadiusMeters;
  next.carLedTrafficMinimumSpacingMeters = draft.carLedTrafficMinimumSpacingMeters;
  next.carLedTrafficAggressiveness = draft.carLedTrafficAggressiveness;
  next.carLedTrafficBaseSpeedKph = draft.carLedTrafficBaseSpeedKph;
  next.carLedTrafficVariantSeed = draft.carLedTrafficVariantSeed;
  next.trafficEnabled = draft.trafficEnabled;
  next.trafficDensity = draft.trafficDensity;
  next.trafficAggressiveness = draft.trafficAggressiveness;
  next.trafficVehicleCount = draft.trafficVehicleCount;
  next.trafficVehicleMix = draft.trafficVehicleMix;
  next.trafficVehicleMixWeights = draft.trafficVehicleMixWeights;
  next.trafficManager = null;
  next.trafficCards = [];
  next.selectedTrafficCardId = null;
  if (draft.renderConfig) {
    next.renderConfig = stripUndefinedAndLegacy(
      cloneJson(draft.renderConfig),
    );
  }
  // The environment preset lives on the native draft's renderConfig
  // (`buildNativeDraft`), but this legacy persist writes renderConfig from the
  // normalized draft directly — carry the preset explicitly so a draft with no
  // other render config does not lose its weather (defect #24).
  if (draft.environmentPreset) {
    next.environmentPreset = draft.environmentPreset;
  } else if (hasOwn(next, "environmentPreset")) {
    delete next.environmentPreset;
  }
  return next;
}
