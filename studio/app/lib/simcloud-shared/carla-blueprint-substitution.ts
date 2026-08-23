import { z } from "zod";

import { CARLA_PEDESTRIAN_BLUEPRINTS } from "./carla-runtime-catalog";
import { toCarlaUe5VehicleBlueprint } from "./carla-ue5-vehicle-blueprints";

/**
 * Cross-map blueprint substitution (documented relaxation).
 *
 * When a source scenario's exact actor blueprint is not in the target
 * runtime's accepted CARLA actor catalog, transfer may substitute the closest
 * accepted blueprint of the SAME class instead of rejecting the target map.
 * Every substitution is reported to the caller as a
 * `{ kind: "blueprint_substituted" }` relaxation entry carrying the footprint
 * deltas, because downstream clearance assertions depend on actor dimensions.
 *
 * Guarantees:
 * - Exact matches are always preferred: an available blueprint is never
 *   substituted.
 * - Substitution is class-preserving: car -> car, van -> van, truck -> truck,
 *   bus -> bus, motorcycle -> motorcycle, bicycle -> bicycle,
 *   walker -> walker. Props are never substituted here (prop availability is
 *   map-level, not actor-catalog-level).
 * - Selection is deterministic: candidates are ranked by footprint closeness
 *   (|length delta| + |width delta|), footprint ties prefer the curated
 *   legacy->UE5 mapping (toCarlaUe5VehicleBlueprint), and any remaining tie
 *   falls back to codepoint-ordered blueprint id. No randomness.
 * - Substitutes must have a comparable footprint. A candidate whose length or
 *   width deviates beyond the caps below is rejected
 *   (`no_comparable_footprint`) rather than silently accepted.
 *
 * Dimension sources, in priority order:
 * 1. the source actor's runtime-measured footprint (scene-formation member
 *    footprint) and the target catalog's revisioned blueprint geometry;
 * 2. the conservative per-class dimension table below. The shared
 *    CARLA_UE5_VEHICLE_BLUEPRINT_METADATA has no dimension metadata (label and
 *    preview image only) and catalog `geometry` is optional, so this fallback
 *    keeps substitution total. Entries resolved this way are stamped
 *    `dimensionsBasis: "class_estimate"` so consumers know the deltas are
 *    estimates, not measurements.
 */

export type CarlaBlueprintClass =
  | "car"
  | "van"
  | "truck"
  | "bus"
  | "motorcycle"
  | "bicycle"
  | "walker";

export const CARLA_BLUEPRINT_CLASSES = [
  "car",
  "van",
  "truck",
  "bus",
  "motorcycle",
  "bicycle",
  "walker",
] as const satisfies readonly CarlaBlueprintClass[];

/**
 * Conservative representative dimensions per class (meters), used only when a
 * measured footprint / revisioned catalog geometry is unavailable. Values are
 * deliberately mid-class so both smaller and larger members stay within the
 * comparable-footprint caps.
 */
export const CARLA_BLUEPRINT_CLASS_FALLBACK_DIMENSIONS_M: Readonly<
  Record<CarlaBlueprintClass, { lengthM: number; widthM: number; heightM: number }>
> = {
  car: { lengthM: 4.8, widthM: 1.9, heightM: 1.6 },
  van: { lengthM: 5.9, widthM: 2.1, heightM: 2.5 },
  truck: { lengthM: 8.0, widthM: 2.9, heightM: 3.5 },
  bus: { lengthM: 7.0, widthM: 2.1, heightM: 3.1 },
  motorcycle: { lengthM: 2.2, widthM: 0.9, heightM: 1.4 },
  bicycle: { lengthM: 1.7, widthM: 0.6, heightM: 1.5 },
  walker: { lengthM: 0.5, widthM: 0.5, heightM: 1.8 },
};

/** Exact classifications override prefix rules (e.g. ambulances are vans even
 * though most `vehicle.ford.*` ids are cars). */
const EXACT_BLUEPRINT_CLASSES: Readonly<Record<string, CarlaBlueprintClass>> = {
  // UE5-native catalog ids.
  "vehicle.taxi.ford": "car",
  "vehicle.dodge.charger": "car",
  "vehicle.dodgecop.charger": "car",
  "vehicle.mini.cooper": "car",
  "vehicle.lincoln.mkz": "car",
  "vehicle.nissan.patrol": "car",
  "vehicle.sprinter.mercedes": "van",
  "vehicle.ambulance.ford": "van",
  "vehicle.carlacola.actors": "truck",
  "vehicle.firetruck.actors": "truck",
  "vehicle.fuso.mitsubishi": "bus",
  // Legacy / UE4-era ids that a prefix rule would misclassify.
  "vehicle.ford.ambulance": "van",
  "vehicle.mercedes.sprinter": "van",
  "vehicle.volkswagen.t2": "van",
  "vehicle.volkswagen.t2_2021": "van",
  "vehicle.mitsubishi.fusorosa": "bus",
  "vehicle.tesla.cybertruck": "truck",
  "vehicle.carlamotors.carlacola": "truck",
  "vehicle.carlamotors.firetruck": "truck",
  "vehicle.carlamotors.european_hgv": "truck",
};

const PREFIX_BLUEPRINT_CLASSES: ReadonlyArray<readonly [string, CarlaBlueprintClass]> = [
  ["walker.", "walker"],
  ["vehicle.harley-davidson.", "motorcycle"],
  ["vehicle.kawasaki.", "motorcycle"],
  ["vehicle.yamaha.", "motorcycle"],
  ["vehicle.vespa.", "motorcycle"],
  ["vehicle.bh.", "bicycle"],
  ["vehicle.diamondback.", "bicycle"],
  ["vehicle.gazelle.", "bicycle"],
  ["vehicle.carlamotors.", "truck"],
  // Every remaining vehicle id (sedans, hatchbacks, SUVs, pickups) is treated
  // as the car class for substitution purposes.
  ["vehicle.", "car"],
];

/** Classify a CARLA blueprint id. Returns null for props / unknown families. */
export function classifyCarlaBlueprint(blueprint: string): CarlaBlueprintClass | null {
  const exact = EXACT_BLUEPRINT_CLASSES[blueprint];
  if (exact) return exact;
  for (const [prefix, blueprintClass] of PREFIX_BLUEPRINT_CLASSES) {
    if (blueprint.startsWith(prefix)) return blueprintClass;
  }
  return null;
}

export const BlueprintSubstitutionRelaxationSchema = z.object({
  kind: z.literal("blueprint_substituted"),
  actorId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  blueprintClass: z.enum(CARLA_BLUEPRINT_CLASSES),
  /** substitute length minus source length, meters (signed). */
  lengthDeltaM: z.number(),
  /** substitute width minus source width, meters (signed). */
  widthDeltaM: z.number(),
  /** "runtime_catalog" when both sides had measured dimensions; otherwise the
   * deltas were computed against the conservative class table. */
  dimensionsBasis: z.enum(["runtime_catalog", "class_estimate"]),
}).strict();
export type BlueprintSubstitutionRelaxation = z.infer<
  typeof BlueprintSubstitutionRelaxationSchema
>;

/**
 * A signal-plan command that transfer could not carry to the target junction.
 *
 * `no_target_mapping`: the commanded source movement is not bound to any
 * transferred actor's maneuver, so there is no truthful target movement to
 * command (cross-street phases typically land here). `no_signal_heads`: the
 * mapped target movement exists but carries no OpenDRIVE `<signal>` heads, so
 * commanding it would be unenforceable (CARLA warns and no-ops it).
 */
export const SignalCommandDroppedRelaxationSchema = z.object({
  kind: z.literal("signal_command_dropped"),
  sourceJunctionId: z.string().min(1),
  sourceMovementId: z.string().min(1),
  targetJunctionId: z.string().min(1).nullable(),
  targetMovementId: z.string().min(1).nullable(),
  reason: z.enum(["no_target_mapping", "no_signal_heads"]),
}).strict();
export type SignalCommandDroppedRelaxation = z.infer<
  typeof SignalCommandDroppedRelaxationSchema
>;

/**
 * A whole source signal plan that transfer dropped, and why. Emitted so a
 * materialized draft can never silently lose signal authoring:
 * `junction_not_transferred` — no transferred actor maneuvers at that source
 * junction, so it has no target counterpart; `no_commands_transferred` — the
 * junction transferred but none of the plan's commanded movements map to a
 * head-bearing target movement.
 */
export const SignalPlanDroppedRelaxationSchema = z.object({
  kind: z.literal("signal_plan_dropped"),
  sourceJunctionId: z.string().min(1),
  mode: z.enum(["static", "program", "scripted"]),
  reason: z.enum(["junction_not_transferred", "no_commands_transferred"]),
}).strict();
export type SignalPlanDroppedRelaxation = z.infer<
  typeof SignalPlanDroppedRelaxationSchema
>;

/** Cross-map transfer relaxation ledger entry — every documented lossy
 * adaptation transfer may apply instead of rejecting a target. Keep this
 * union open by adding new `kind` literals here. */
export const CrossMapVariationRelaxationSchema = z.discriminatedUnion("kind", [
  BlueprintSubstitutionRelaxationSchema,
  SignalCommandDroppedRelaxationSchema,
  SignalPlanDroppedRelaxationSchema,
]);
export type CrossMapVariationRelaxation = z.infer<typeof CrossMapVariationRelaxationSchema>;

export type BlueprintFootprintDimensions = {
  lengthM: number;
  widthM: number;
};

export type SubstituteCatalogEntry = {
  id: string;
  tags?: readonly string[];
  geometry?: { length_m: number; width_m: number; height_m: number } | null;
};

export type BlueprintSubstituteSelection =
  | {
      ok: true;
      to: string;
      blueprintClass: CarlaBlueprintClass;
      lengthDeltaM: number;
      widthDeltaM: number;
      dimensionsBasis: "runtime_catalog" | "class_estimate";
    }
  | {
      ok: false;
      reason:
        | "unclassified_blueprint"
        | "no_same_class_blueprint"
        | "no_comparable_footprint";
      blueprintClass: CarlaBlueprintClass | null;
    };

/** Comparable-footprint caps: a substitute may deviate from the source by at
 * most max(1.5 m, 35%) in length and max(0.5 m, 30%) in width. */
function maxLengthDeltaM(sourceLengthM: number): number {
  return Math.max(1.5, sourceLengthM * 0.35);
}
function maxWidthDeltaM(sourceWidthM: number): number {
  return Math.max(0.5, sourceWidthM * 0.3);
}

const PEDESTRIAN_TRAITS_BY_ID = new Map<string, { age: string; gender: string }>(
  CARLA_PEDESTRIAN_BLUEPRINTS.map((blueprint) => [
    blueprint.id,
    {
      age: String(blueprint.attributes.age),
      gender: String(blueprint.attributes.gender),
    },
  ]),
);

function walkerTraits(id: string): { age: string; gender: string } | null {
  return PEDESTRIAN_TRAITS_BY_ID.get(id) ?? null;
}

function stableIdCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Deterministically pick the closest same-class substitute for one blueprint. */
export function selectSubstituteBlueprint(input: {
  from: string;
  sourceFootprint: BlueprintFootprintDimensions | null;
  candidates: readonly SubstituteCatalogEntry[];
}): BlueprintSubstituteSelection {
  const blueprintClass = classifyCarlaBlueprint(input.from);
  if (!blueprintClass) return { ok: false, reason: "unclassified_blueprint", blueprintClass: null };
  const pool = input.candidates.filter(
    (candidate) => classifyCarlaBlueprint(candidate.id) === blueprintClass,
  );
  if (pool.length === 0) {
    return { ok: false, reason: "no_same_class_blueprint", blueprintClass };
  }
  const classDims = CARLA_BLUEPRINT_CLASS_FALLBACK_DIMENSIONS_M[blueprintClass];
  const source = input.sourceFootprint ?? { lengthM: classDims.lengthM, widthM: classDims.widthM };
  const sourceMeasured = input.sourceFootprint != null;
  const sourceWalkerTraits = blueprintClass === "walker" ? walkerTraits(input.from) : null;
  // Tie-break equal footprints with the curated legacy->UE5 mapping so an
  // undimensioned catalog still substitutes the vehicle the catalog team
  // curated (e.g. tesla.model3 -> lincoln.mkz), never the alphabetically
  // first same-class id.
  const curated = blueprintClass === "walker" ? null : toCarlaUe5VehicleBlueprint(input.from);
  const ranked = pool
    .map((candidate) => {
      const measured = candidate.geometry ?? null;
      const dims = measured
        ? { lengthM: measured.length_m, widthM: measured.width_m }
        : { lengthM: classDims.lengthM, widthM: classDims.widthM };
      const lengthDeltaM = dims.lengthM - source.lengthM;
      const widthDeltaM = dims.widthM - source.widthM;
      const traits = blueprintClass === "walker" ? walkerTraits(candidate.id) : null;
      const ageMismatch = sourceWalkerTraits && traits && sourceWalkerTraits.age !== traits.age ? 1 : 0;
      const genderMismatch =
        sourceWalkerTraits && traits && sourceWalkerTraits.gender !== traits.gender ? 1 : 0;
      return {
        id: candidate.id,
        lengthDeltaM,
        widthDeltaM,
        footprintScore: Math.abs(lengthDeltaM) + Math.abs(widthDeltaM),
        ageMismatch,
        genderMismatch,
        curatedMismatch: curated != null && candidate.id === curated ? 0 : 1,
        dimensionsBasis: sourceMeasured && measured
          ? ("runtime_catalog" as const)
          : ("class_estimate" as const),
      };
    })
    .filter((candidate) =>
      Math.abs(candidate.lengthDeltaM) <= maxLengthDeltaM(source.lengthM) &&
      Math.abs(candidate.widthDeltaM) <= maxWidthDeltaM(source.widthM))
    .sort((left, right) =>
      left.ageMismatch - right.ageMismatch ||
      left.genderMismatch - right.genderMismatch ||
      left.footprintScore - right.footprintScore ||
      left.curatedMismatch - right.curatedMismatch ||
      stableIdCompare(left.id, right.id));
  const winner = ranked[0];
  if (!winner) return { ok: false, reason: "no_comparable_footprint", blueprintClass };
  return {
    ok: true,
    to: winner.id,
    blueprintClass,
    lengthDeltaM: winner.lengthDeltaM,
    widthDeltaM: winner.widthDeltaM,
    dimensionsBasis: winner.dimensionsBasis,
  };
}

export type BlueprintSubstitutionPlan<T> = {
  /** Copies of the input actors with substituted blueprints applied. Actors
   * that did not need substitution are returned by reference. */
  actors: T[];
  relaxations: BlueprintSubstitutionRelaxation[];
  unresolved: Array<{
    actorId: string;
    blueprint: string;
    blueprintClass: CarlaBlueprintClass | null;
    reason:
      | "unclassified_blueprint"
      | "no_same_class_blueprint"
      | "no_comparable_footprint";
  }>;
};

/**
 * Build the per-target substitution plan for a source actor set.
 *
 * Exact matches are preferred: an actor whose blueprint is in the accepted
 * catalog for its kind keeps it unchanged. Prop actors are never substituted.
 * The result is deterministic for identical inputs.
 */
export function planBlueprintSubstitutions<
  T extends { id: string; kind: "vehicle" | "walker" | "prop"; blueprint: string },
>(input: {
  actors: readonly T[];
  vehicleCandidates: readonly SubstituteCatalogEntry[];
  walkerCandidates: readonly SubstituteCatalogEntry[];
  /** Optional runtime-measured source footprints keyed by actor id. */
  footprintByActorId?: ReadonlyMap<string, BlueprintFootprintDimensions | null>;
}): BlueprintSubstitutionPlan<T> {
  const availableVehicleIds = new Set(input.vehicleCandidates.map((candidate) => candidate.id));
  const availableWalkerIds = new Set(input.walkerCandidates.map((candidate) => candidate.id));
  const relaxations: BlueprintSubstitutionRelaxation[] = [];
  const unresolved: BlueprintSubstitutionPlan<T>["unresolved"] = [];
  const actors = input.actors.map((actor) => {
    if (actor.kind === "prop") return actor;
    const available = actor.kind === "walker" ? availableWalkerIds : availableVehicleIds;
    if (available.has(actor.blueprint)) return actor;
    const selection = selectSubstituteBlueprint({
      from: actor.blueprint,
      sourceFootprint: input.footprintByActorId?.get(actor.id) ?? null,
      candidates: actor.kind === "walker" ? input.walkerCandidates : input.vehicleCandidates,
    });
    if (!selection.ok) {
      unresolved.push({
        actorId: actor.id,
        blueprint: actor.blueprint,
        blueprintClass: selection.blueprintClass,
        reason: selection.reason,
      });
      return actor;
    }
    relaxations.push({
      kind: "blueprint_substituted",
      actorId: actor.id,
      from: actor.blueprint,
      to: selection.to,
      blueprintClass: selection.blueprintClass,
      lengthDeltaM: selection.lengthDeltaM,
      widthDeltaM: selection.widthDeltaM,
      dimensionsBasis: selection.dimensionsBasis,
    });
    return { ...actor, blueprint: selection.to };
  });
  return { actors, relaxations, unresolved };
}
