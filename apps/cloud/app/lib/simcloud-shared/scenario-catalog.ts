import { z } from "zod";

/**
 * Customer-facing scenario catalog: the single registry that maps what the
 * generators actually emit onto the categories a customer sees.
 *
 * Why this exists as an explicit, versioned registry rather than a derivation:
 * the displayed category cannot be reconstructed later from a folder name or a
 * broad generator family. Folder layouts do not distinguish participant type,
 * occlusion, walker profile, or composite-stop subtype — `pedavoid` covers an
 * adult and a child, and `stop` covers causes as different as a braking lead
 * and a pedestrian crossing. So the category is resolved once, at emission,
 * from the generator's own classification, and stored on the scenario.
 *
 * Everything that needs a category — the import bundle validator, the report
 * UI, the filter API, and any future standards mapping — must consume this
 * module rather than re-deriving its own mapping.
 */

export const SCENARIO_CATALOG_VERSION = "simforge.scenario-catalog.v1" as const;

export const ScenarioCatalogGroupSchema = z.enum([
  "Nominal",
  "Control",
  "Highway",
  "VRU",
  "Junction",
  "Cycle",
]);
export type ScenarioCatalogGroup = z.infer<typeof ScenarioCatalogGroupSchema>;

/**
 * `live` categories can be emitted by the current generators and may appear on
 * an imported scenario. `reserved` categories are classifications the code can
 * still *name* but can no longer *produce* — see RESERVED_CATEGORIES below.
 *
 * The distinction is load-bearing for the importer: a reserved hit means the
 * generator changed and this registry did not keep up, which is a different
 * failure from an unrecognized classification and deserves a different error.
 */
export const ScenarioCatalogStatusSchema = z.enum(["live", "reserved"]);
export type ScenarioCatalogStatus = z.infer<typeof ScenarioCatalogStatusSchema>;

export type ScenarioCatalogEntry = {
  /** Stable customer-facing id. Never renumber or reuse across versions. */
  id: string;
  /** Filter facet the customer browses by. */
  group: ScenarioCatalogGroup;
  /** Display name. */
  label: string;
  status: ScenarioCatalogStatus;
  /** The generator classification this resolves from, in prose, for audit. */
  source: string;
  /** Present only on reserved entries: why it cannot currently be emitted. */
  reservedReason?: string;
};

/** The 30 categories the current generators can actually produce. */
export const LIVE_CATEGORIES: readonly ScenarioCatalogEntry[] = [
  // -- Urban nominal ---------------------------------------------------------
  { id: "nominal.lane_keep", group: "Nominal", label: "Urban lane following", status: "live", source: "strategy=lane_keep" },
  { id: "nominal.lane_change_left", group: "Nominal", label: "Lane change left", status: "live", source: "strategy=lane_change_left" },
  { id: "nominal.lane_change_right", group: "Nominal", label: "Lane change right", status: "live", source: "strategy=lane_change_right" },
  { id: "nominal.overtake_left", group: "Nominal", label: "Overtake via left lane", status: "live", source: "strategy=overtake_left" },
  // Added 2026-08-01: a live top-level strategy that the 28-category catalog
  // never named. It is the exact mirror of overtake_left, so naming it is safe.
  { id: "nominal.overtake_right", group: "Nominal", label: "Overtake via right lane", status: "live", source: "strategy=overtake_right" },
  { id: "nominal.turn_left", group: "Nominal", label: "Nominal left turn", status: "live", source: "strategy=turn_left" },
  { id: "nominal.turn_right", group: "Nominal", label: "Nominal right turn", status: "live", source: "strategy=turn_right" },

  // -- Caused stops ----------------------------------------------------------
  // Every stop is caused; the variant names the rendered cause.
  { id: "nominal.stop.lead_brake", group: "Nominal", label: "Lead braking, hold and resume", status: "live", source: "strategy=stop, stopVariant=lead_brake" },
  // Added 2026-08-01. 35% of every stop scene (STOP_VRU_FRACTION) and
  // previously unnamed, so a third of all stops would have failed closed.
  // The id stays under `nominal.*` because the canonical id encodes the
  // generator classification and this is a nominal scene, not a conflict
  // family — but it is grouped with VRU so pedestrian filters reach it.
  { id: "nominal.stop.vru_yield", group: "VRU", label: "Yield to crossing pedestrian", status: "live", source: "strategy=stop, stopVariant=vru_yield" },

  // -- Controls --------------------------------------------------------------
  { id: "control.stop_sign", group: "Control", label: "Stop-sign handling", status: "live", source: "strategy=stop_at_stop_sign" },
  { id: "control.yield_sign", group: "Control", label: "Yield-sign handling", status: "live", source: "strategy=stop_at_yield_sign" },
  { id: "control.traffic_light_stop", group: "Control", label: "Traffic-light stop", status: "live", source: "strategy=stop_at_traffic_light" },
  { id: "control.uncontrolled_junction", group: "Control", label: "Uncontrolled-junction handling", status: "live", source: "strategy=stop_at_uncontrolled" },

  // -- Highway ---------------------------------------------------------------
  { id: "highway.lane_keep", group: "Highway", label: "Highway cruise", status: "live", source: "strategy=highway_lane_keep" },
  { id: "highway.lane_change_left", group: "Highway", label: "Highway lane change left", status: "live", source: "strategy=highway_lane_change_left" },
  { id: "highway.lane_change_right", group: "Highway", label: "Highway lane change right", status: "live", source: "strategy=highway_lane_change_right" },
  { id: "highway.entry", group: "Highway", label: "Highway entry", status: "live", source: "strategy=highway_entry" },
  { id: "highway.exit", group: "Highway", label: "Highway exit", status: "live", source: "strategy=highway_exit" },

  // -- Pedestrian and vulnerable road users ----------------------------------
  { id: "conflict.pedestrian.adult.visible", group: "VRU", label: "Visible adult pedestrian crossing", status: "live", source: "pedestrian_crossing, adult, no occluder" },
  { id: "conflict.pedestrian.adult.occluded", group: "VRU", label: "Occluded adult pedestrian crossing", status: "live", source: "pedestrian_crossing, adult, occluder required" },
  { id: "conflict.pedestrian.child.occluded", group: "VRU", label: "Occluded child emerging", status: "live", source: "pedestrian_crossing, child, occluder required" },
  { id: "conflict.turn_left.pedestrian", group: "VRU", label: "Left turn across pedestrian crosswalk", status: "live", source: "left_turn_ped_crosswalk" },
  { id: "conflict.turn_right.pedestrian", group: "VRU", label: "Right turn across pedestrian crosswalk", status: "live", source: "right_turn_ped_crosswalk" },

  // -- Junction, powered two-wheeler, and cycle conflicts --------------------
  { id: "conflict.turn_left.car", group: "Junction", label: "Left turn across oncoming car", status: "live", source: "unprotected_left_turn, car" },
  { id: "conflict.turn_left.motorcycle", group: "Junction", label: "Left turn across oncoming motorcycle", status: "live", source: "unprotected_left_turn, motorcycle" },
  { id: "conflict.turn_left.bicycle", group: "Junction", label: "Left turn across bicyclist", status: "live", source: "unprotected_left_turn, bicycle" },
  { id: "conflict.turn_right.bicycle", group: "Junction", label: "Right-turn hook with cyclist", status: "live", source: "right_turn_hook, bicycle" },
  { id: "conflict.turn_right.car", group: "Junction", label: "Right-turn conflict with car", status: "live", source: "right_turn_hook, car" },
  { id: "conflict.turn_right.motorcycle", group: "Junction", label: "Right-turn conflict with motorcycle", status: "live", source: "right_turn_hook, motorcycle" },
  { id: "conflict.bicycle_merge", group: "Cycle", label: "Bicyclist merge into ego lane", status: "live", source: "bicycle_merge" },
] as const;

/**
 * Stop variants that exist in `StopVariant` but that the current constants make
 * unreachable, verified 2026-08-01 against batch-scenario-generator/:
 *
 *   variation.ts draws only  r < STOP_SIGN_FRACTION      -> stop_sign
 *                            r < ... + STOP_VRU_FRACTION -> vru_yield
 *                            else                        -> lead_brake
 *
 * and `STOP_SIGN_FRACTION` is 0 (constants.ts), so `stop_sign` never wins its
 * branch. `stopVariantFallbackOrder` can then only ever be seeded with
 * `vru_yield` or `lead_brake`, whose ladders are [vru_yield, lead_brake] and
 * [lead_brake] — so `junction_proceed` and `queue_at_junction` are unreachable
 * too. The `?? "junction_proceed"` default in placement.ts never fires because
 * `stopVariant` is always set for strategy=stop.
 *
 * They are recorded rather than deleted for two reasons. A reserved hit is a
 * precise signal that the generator regained a code path this registry has not
 * caught up with. And when the stop-line placement work described in the
 * STOP_SIGN_FRACTION comment lands, these get customer-facing names without
 * renumbering the live catalog.
 *
 * Note for whoever revives `stop_sign`: it must not be silently aliased to
 * `control.stop_sign` (strategy=stop_at_stop_sign). They are different code
 * paths with different validation contracts, and one customer-facing name for
 * both would make the catalog lie about what was tested.
 */
export const RESERVED_CATEGORIES: readonly ScenarioCatalogEntry[] = [
  {
    id: "reserved.stop.junction_proceed",
    group: "Nominal",
    label: "Stop at junction entry, then proceed",
    status: "reserved",
    source: "strategy=stop, stopVariant=junction_proceed",
    reservedReason:
      "Unreachable: not drawn by variation.ts and not a fallback target of any drawn variant.",
  },
  {
    id: "reserved.stop.queue_at_junction",
    group: "Nominal",
    label: "Queue behind a lead at a junction entry",
    status: "reserved",
    source: "strategy=stop, stopVariant=queue_at_junction",
    reservedReason:
      "Unreachable: not drawn by variation.ts and not a fallback target of any drawn variant.",
  },
  {
    id: "reserved.stop.stop_sign",
    group: "Control",
    label: "Stop-line stop (composite stop variant)",
    status: "reserved",
    source: "strategy=stop, stopVariant=stop_sign",
    reservedReason:
      "Unreachable: STOP_SIGN_FRACTION is 0 pending stop-line-targeted placement.",
  },
] as const;

export const ALL_CATEGORIES: readonly ScenarioCatalogEntry[] = [
  ...LIVE_CATEGORIES,
  ...RESERVED_CATEGORIES,
];

const BY_ID = new Map(ALL_CATEGORIES.map((entry) => [entry.id, entry]));

export function categoryById(id: string): ScenarioCatalogEntry | undefined {
  return BY_ID.get(id);
}

// --------------------------------------------------------------------------
// Resolution
// --------------------------------------------------------------------------

/** What a nominal-batch scenario was generated as. */
export type NominalClassification = {
  kind: "nominal";
  strategy: string;
  /** Required when `strategy` is "stop"; the resolved causal variant. */
  stopVariant?: string | null;
};

/** What a conflict-batch scenario was generated as. */
export type ConflictClassification = {
  kind: "conflict";
  family: string;
  npcVehicleType?: "car" | "bicycle" | "motorcycle" | null;
  walkerProfile?: "adult" | "child" | null;
  /** True when the family required a matched roadside occluder. */
  requireOccluder?: boolean | null;
};

export type GeneratorClassification =
  | NominalClassification
  | ConflictClassification;

export type CategoryResolution =
  | { ok: true; entry: ScenarioCatalogEntry }
  /** The classification is known but cannot currently be produced. */
  | { ok: false; reason: "category_reserved"; id: string; detail: string }
  /** The classification is not in this registry at all. */
  | { ok: false; reason: "category_unmapped"; detail: string };

/** Strategies that map one-to-one onto a category id. */
const STRATEGY_TO_ID: Readonly<Record<string, string>> = {
  lane_keep: "nominal.lane_keep",
  lane_change_left: "nominal.lane_change_left",
  lane_change_right: "nominal.lane_change_right",
  overtake_left: "nominal.overtake_left",
  overtake_right: "nominal.overtake_right",
  turn_left: "nominal.turn_left",
  turn_right: "nominal.turn_right",
  stop_at_stop_sign: "control.stop_sign",
  stop_at_yield_sign: "control.yield_sign",
  stop_at_traffic_light: "control.traffic_light_stop",
  stop_at_uncontrolled: "control.uncontrolled_junction",
  highway_lane_keep: "highway.lane_keep",
  highway_lane_change_left: "highway.lane_change_left",
  highway_lane_change_right: "highway.lane_change_right",
  highway_entry: "highway.entry",
  highway_exit: "highway.exit",
};

/** The composite `stop` strategy resolves through its causal variant. */
const STOP_VARIANT_TO_ID: Readonly<Record<string, string>> = {
  lead_brake: "nominal.stop.lead_brake",
  vru_yield: "nominal.stop.vru_yield",
  junction_proceed: "reserved.stop.junction_proceed",
  queue_at_junction: "reserved.stop.queue_at_junction",
  stop_sign: "reserved.stop.stop_sign",
};

function resolveId(id: string, detail: string): CategoryResolution {
  const entry = BY_ID.get(id);
  if (!entry) return { ok: false, reason: "category_unmapped", detail };
  if (entry.status === "reserved") {
    return {
      ok: false,
      reason: "category_reserved",
      id: entry.id,
      detail: entry.reservedReason ?? detail,
    };
  }
  return { ok: true, entry };
}

function resolveNominal(input: NominalClassification): CategoryResolution {
  if (input.strategy === "stop") {
    const variant = input.stopVariant;
    if (!variant) {
      return {
        ok: false,
        reason: "category_unmapped",
        detail: "strategy=stop requires a stopVariant to resolve a category",
      };
    }
    const id = STOP_VARIANT_TO_ID[variant];
    if (!id) {
      return {
        ok: false,
        reason: "category_unmapped",
        detail: `unknown stopVariant "${variant}"`,
      };
    }
    return resolveId(id, `strategy=stop, stopVariant=${variant}`);
  }

  const id = STRATEGY_TO_ID[input.strategy];
  if (!id) {
    return {
      ok: false,
      reason: "category_unmapped",
      detail: `unknown strategy "${input.strategy}"`,
    };
  }
  return resolveId(id, `strategy=${input.strategy}`);
}

function resolveConflict(input: ConflictClassification): CategoryResolution {
  const { family } = input;
  const detail = `family=${family}`;

  if (family === "pedestrian_crossing") {
    const profile = input.walkerProfile ?? "adult";
    const occluded = input.requireOccluder === true;
    if (profile === "child") {
      // The catalog names only the occluded child (the Euro NCAP CPNCO shape).
      // A visible child is deliberately NOT aliased onto the occluded id: they
      // are different test cases and the occlusion is the point of the child
      // family. If the generator starts emitting one it must be named first.
      if (!occluded) {
        return {
          ok: false,
          reason: "category_unmapped",
          detail:
            "pedestrian_crossing, child, no occluder has no customer category; " +
            "only the occluded child (CPNCO) is named",
        };
      }
      return resolveId("conflict.pedestrian.child.occluded", detail);
    }
    return resolveId(
      occluded
        ? "conflict.pedestrian.adult.occluded"
        : "conflict.pedestrian.adult.visible",
      detail,
    );
  }

  if (family === "left_turn_ped_crosswalk") {
    return resolveId("conflict.turn_left.pedestrian", detail);
  }
  if (family === "right_turn_ped_crosswalk") {
    return resolveId("conflict.turn_right.pedestrian", detail);
  }
  if (family === "bicycle_merge") {
    return resolveId("conflict.bicycle_merge", detail);
  }

  if (family === "unprotected_left_turn" || family === "right_turn_hook") {
    // An omitted npcVehicleType means a car. This mirrors the generator, which
    // resolves `request.npcVehicleType ?? (family === "bicycle_merge" ?
    // "bicycle" : undefined)` and renders the car blueprint for an undefined
    // participant (batch-collision-generator.ts). The default must live here
    // rather than in each caller: verified against a real run, ~40% of
    // left-turn and right-hook scenes omit the field and are ordinary car
    // conflicts, so treating absent as unresolvable would reject them all.
    const participant = input.npcVehicleType ?? "car";
    const side = family === "unprotected_left_turn" ? "turn_left" : "turn_right";
    return resolveId(
      `conflict.${side}.${participant}`,
      `${detail}, ${participant}`,
    );
  }

  return {
    ok: false,
    reason: "category_unmapped",
    detail: `unknown conflict family "${family}"`,
  };
}

/**
 * Resolve a generator classification to a customer-facing category.
 *
 * Fails closed: an unknown or reserved classification never silently becomes a
 * neighbouring category. The importer turns either failure into a rejected
 * item rather than publishing a mislabeled scenario.
 */
export function resolveCategory(
  input: GeneratorClassification,
): CategoryResolution {
  return input.kind === "nominal"
    ? resolveNominal(input)
    : resolveConflict(input);
}

/**
 * The category facts stamped onto every imported scenario. Storing the raw
 * generator dimensions alongside the resolved id is what lets a later taxonomy
 * version re-derive categories without re-running the generator.
 */
export const ImportedCategorySchema = z.object({
  taxonomyVersion: z.literal(SCENARIO_CATALOG_VERSION),
  id: z.string().min(1),
  group: ScenarioCatalogGroupSchema,
  label: z.string().min(1),
  generatorFamily: z.string().min(1),
  generatorStrategy: z.string().min(1).nullable(),
  /** Raw dimensions exactly as the generator reported them. */
  dimensions: z.record(z.union([z.string(), z.number(), z.boolean()])),
});
export type ImportedCategory = z.infer<typeof ImportedCategorySchema>;
