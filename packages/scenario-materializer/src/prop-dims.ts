import {
  actorClassesForCatalogEntry,
  getEntry,
  parseExternalCatalogEntries,
  resolveCatalogId,
  type CatalogEntry,
} from '@uniscenarios/prop-catalog/metadata';

/**
 * Browser-safe occluder footprints for `props[]`.
 *
 * `@uniscenarios/prop-catalog` owns the real dimensions. This table remains a
 * browser-safe prop-placement snapshot, while actor validation below imports
 * the catalog's metadata-only entry point (which does not load three.js).
 *
 * These values are copied from `packages/prop-catalog/src/catalog.ts`; the CLI
 * test suite pins the pairs it uses so a drift shows up as a failing test
 * rather than as a silently wrong reveal-to-conflict metric.
 */

export interface PropDims {
  readonly l: number;
  readonly w: number;
  readonly h: number;
}

export const PROP_DIMS: Readonly<Record<string, PropDims>> = {
  'vehicle.sedan': { l: 4.7, w: 1.82, h: 1.45 },
  'vehicle.hatchback': { l: 4.05, w: 1.75, h: 1.46 },
  'vehicle.suv': { l: 4.85, w: 1.95, h: 1.78 },
  'vehicle.pickup': { l: 5.9, w: 2.03, h: 1.95 },
  'vehicle.van': { l: 5.3, w: 2.0, h: 2.4 },
  'vehicle.kia.carnival': { l: 5.15, w: 2, h: 1.78 },
  'vehicle.box_truck': { l: 7.6, w: 2.44, h: 3.4 },
  'vehicle.semi_truck': { l: 20.1, w: 2.6, h: 4.1 },
  'vehicle.bus': { l: 12.2, w: 2.55, h: 3.2 },
  'vehicle.motorcycle': { l: 2.1, w: 0.75, h: 1.23 },
  'vehicle.bicycle': { l: 1.75, w: 0.5, h: 1.71 },
  'vehicle.ambulance': { l: 6.1, w: 2.1, h: 2.65 },
  'vehicle.tram': { l: 30, w: 2.65, h: 3.5 },
  'vehicle.mobility_scooter': { l: 1.35, w: 0.68, h: 1.35 },
  'pedestrian.adult_standing': { l: 0.32, w: 0.5, h: 1.75 },
  'pedestrian.adult_walking': { l: 0.85, w: 0.5, h: 1.75 },
  'pedestrian.child_standing': { l: 0.24, w: 0.35, h: 1.2 },
  'pedestrian.child_walking': { l: 0.58, w: 0.35, h: 1.2 },
  'pedestrian.traffic_marshal': { l: 0.72, w: 0.68, h: 1.88 },
  'animal.deer': { l: 1.76, w: 0.46, h: 1.62 },
  'animal.dog': { l: 1.07, w: 0.3, h: 0.75 },
  'animal.cat': { l: 0.63, w: 0.15, h: 0.35 },
  'vehicle.honda_civic': { l: 4.67, w: 1.8, h: 1.42 },
  'vehicle.toyota_camry': { l: 4.88, w: 1.84, h: 1.45 },
  'vehicle.tesla_model_3': { l: 4.72, w: 1.85, h: 1.44 },
  'vehicle.ford_mustang': { l: 4.81, w: 1.92, h: 1.4 },
  'vehicle.chevrolet_corvette': { l: 4.63, w: 1.93, h: 1.23 },
  'vehicle.porsche_911': { l: 4.52, w: 1.85, h: 1.3 },
  'vehicle.jeep_wrangler': { l: 4.79, w: 1.88, h: 1.87 },
  'vehicle.minivan': { l: 5.15, w: 2, h: 1.78 },
  'vehicle.taxi': { l: 4.9, w: 1.85, h: 1.55 },
  'vehicle.police_cruiser': { l: 5.1, w: 2, h: 1.55 },
  'vehicle.police_suv': { l: 5.1, w: 2, h: 1.9 },
  'vehicle.fire_command_suv': { l: 5.2, w: 2, h: 1.95 },
  'vehicle.fire_engine': { l: 10.2, w: 2.55, h: 3.3 },
  'vehicle.dump_truck': { l: 8.5, w: 2.55, h: 3.3 },
  'vehicle.garbage_truck': { l: 9.2, w: 2.55, h: 3.45 },
  'vehicle.tow_truck': { l: 7.5, w: 2.45, h: 2.8 },
  'vehicle.cement_mixer': { l: 8.8, w: 2.5, h: 3.7 },
  'vehicle.utility_bucket_truck': { l: 8.2, w: 2.5, h: 3.6 },
  'vehicle.tanker_truck': { l: 10.5, w: 2.55, h: 3.6 },
  'vehicle.flatbed_truck': { l: 8, w: 2.5, h: 2.65 },
  'vehicle.school_bus': { l: 10.7, w: 2.55, h: 3.2 },
  'vehicle.shuttle_bus': { l: 7.4, w: 2.3, h: 2.8 },
  'vehicle.delivery_van': { l: 6, w: 2.05, h: 2.65 },
  'pedestrian.adult': { l: 0.32, w: 0.5, h: 1.75 },
  'pedestrian.child': { l: 0.24, w: 0.35, h: 1.2 },
  'sidewalk_robot.delivery_rover': { l: 0.75, w: 0.55, h: 0.8 },
  'sidewalk_robot.cooler_bot': { l: 0.95, w: 0.65, h: 0.95 },
  'sidewalk_robot.quadruped_courier': { l: 1.05, w: 0.5, h: 0.72 },
  'sidewalk_robot.humanoid_general_purpose': { l: 0.58, w: 0.62, h: 1.78 },
  'sidewalk_robot.humanoid_delivery': { l: 0.62, w: 0.68, h: 1.7 },
  'sidewalk_robot.humanoid_warehouse': { l: 0.64, w: 0.7, h: 1.75 },
  'sidewalk_robot.humanoid_public_safety': { l: 0.62, w: 0.68, h: 1.82 },
  'sidewalk_robot.humanoid_construction': { l: 0.66, w: 0.72, h: 1.85 },
  'drone.delivery_quadcopter': { l: 1.1, w: 1.1, h: 0.45 },
  'drone.camera_quadcopter': { l: 0.65, w: 0.65, h: 0.32 },
  'drone.emergency_responder': { l: 1.4, w: 1.4, h: 0.5 },
  'animal.raccoon': { l: 0.85, w: 0.22, h: 0.45 },
  'animal.goose': { l: 0.86, w: 0.5, h: 0.85 },
  'construction.traffic_cone': { l: 0.36, w: 0.36, h: 0.7 },
  'construction.channelizer_drum': { l: 0.58, w: 0.58, h: 1.07 },
  'construction.barricade_type3': { l: 0.62, w: 2.44, h: 1.66 },
  'construction.pedestrian_barrier': { l: 2, w: 0.55, h: 1.1 },
  'construction.jersey_barrier': { l: 3.05, w: 0.61, h: 0.81 },
  'construction.jersey_barrier_run': { l: 12.2, w: 0.61, h: 0.81 },
  'construction.sign_road_work': { l: 0.9, w: 1.73, h: 2.21 },
  'construction.flagger': { l: 0.73, w: 0.7, h: 2.19 },
  'construction.arrow_board': { l: 3.45, w: 2.44, h: 2.53 },
  'construction.excavator': { l: 5.15, w: 2.24, h: 2.71 },
  'construction.portable_toilet': { l: 1.24, w: 1.22, h: 2.26 },
  'construction.spoil_pile': { l: 2.6, w: 2.55, h: 0.9 },
  'construction.temporary_stop_sign': { l: 0.82, w: 0.92, h: 2.16 },
  'construction.portable_signal': { l: 1.45, w: 1.2, h: 3.25 },
  'construction.long_pipe': { l: 8, w: 0.62, h: 0.62 },
  'occluder.dumpster': { l: 1.9, w: 1.52, h: 1.25 },
  'occluder.covered_car': { l: 4.58, w: 1.93, h: 1.48 },
  'occluder.hedge_run': { l: 6, w: 0.8, h: 1.2 },
  'occluder.fence_run': { l: 6, w: 0.065, h: 1.8 },
  'street.mailbox_cluster': { l: 0.54, w: 0.98, h: 1.52 },
  'street.bus_shelter': { l: 4, w: 1.6, h: 2.5 },
  'street.food_cart': { l: 1.84, w: 1, h: 2.18 },
  'street.shopping_cart': { l: 1.05, w: 0.65, h: 1.05 },
  'hazard.tire_debris': { l: 0.74, w: 0.56, h: 0.24 },
  'hazard.cardboard_box': { l: 0.58, w: 0.44, h: 0.47 },
  'hazard.trash_bags': { l: 1.02, w: 0.93, h: 0.58 },
  'hazard.downed_branch': { l: 2.44, w: 1.2, h: 0.45 },
  'hazard.ladder': { l: 3.55, w: 0.44, h: 0.08 },
  'hazard.mattress': { l: 1.86, w: 1.32, h: 0.3 },
  'hazard.debris': { l: 0.88, w: 0.85, h: 0.24 },
};

/**
 * Author-facing synonyms, mirroring `CATALOG_ALIASES` in `@uniscenarios/prop-catalog`.
 *
 * The catalog files a prop under the class that owns it — a tyre carcass is a
 * `hazard`, a cone is `construction`, a trolley is `street` furniture. Authors
 * and LLMs write `object.tyre`, `object.cone`, `object.barrier`, and those used
 * to resolve to nothing at all: not an error, a silent fall-through to a unit
 * cube. Resolving synonyms is a vocabulary fix, not a second copy of every prop.
 */
export const PROP_ALIAS_TARGETS: Readonly<Record<string, string>> = {
  'object.tyre': 'hazard.tire_debris',
  'object.tire': 'hazard.tire_debris',
  'object.box': 'hazard.cardboard_box',
  'object.cardboard_box': 'hazard.cardboard_box',
  'object.branch': 'hazard.downed_branch',
  'object.trash_bags': 'hazard.trash_bags',
  'object.ladder': 'hazard.ladder',
  'object.mattress': 'hazard.mattress',
  'object.debris': 'hazard.debris',
  'object.shed_load': 'hazard.debris',
  'object.shopping_cart': 'street.shopping_cart',
  'object.cone': 'construction.traffic_cone',
  'object.traffic_cone': 'construction.traffic_cone',
  'object.barrel': 'construction.channelizer_drum',
  'object.drum': 'construction.channelizer_drum',
  'object.barrier': 'construction.jersey_barrier',
  'object.jersey_barrier': 'construction.jersey_barrier',
  'object.barrier_run': 'construction.jersey_barrier_run',
  'object.barricade': 'construction.barricade_type3',
  'object.pedestrian_barrier': 'construction.pedestrian_barrier',
  'object.sign_board': 'construction.sign_road_work',
  'object.arrow_board': 'construction.arrow_board',
  'object.stop_sign': 'construction.temporary_stop_sign',
  'animal.doe': 'animal.deer',
  'animal.buck': 'animal.deer',
  'animal.stray_dog': 'animal.dog',
};

/** Canonical catalog id for anything an author might write, else `null`. */
export function resolvePropCatalogId(catalogId: string): string | null {
  if (Object.prototype.hasOwnProperty.call(PROP_DIMS, catalogId)) return catalogId;
  return PROP_ALIAS_TARGETS[catalogId] ?? null;
}

export interface PropBehavior { readonly collidable: boolean; readonly occluder: boolean }

/** Physical defaults for semantic campaign props; authored extensions still override collision. */
export const PROP_BEHAVIOR: Readonly<Record<string, PropBehavior>> = {
  'construction.traffic_cone': { collidable: true, occluder: true },
  'construction.channelizer_drum': { collidable: true, occluder: true },
  'construction.excavator': { collidable: true, occluder: true },
  'construction.barricade_type3': { collidable: true, occluder: true },
  'construction.jersey_barrier': { collidable: true, occluder: true },
  'construction.jersey_barrier_run': { collidable: true, occluder: true },
  'construction.temporary_stop_sign': { collidable: true, occluder: true },
  'construction.portable_signal': { collidable: true, occluder: true },
  'construction.long_pipe': { collidable: true, occluder: true },
  'street.shopping_cart': { collidable: true, occluder: true },
  // Loose objects in the travelled way are physical objects. Whether an ADS
  // *should* brake for a tyre carcass is a behaviour question; whether the tyre
  // is there is not, and a prop the engine cannot hit cannot be an obstacle.
  'hazard.tire_debris': { collidable: true, occluder: true },
  'hazard.cardboard_box': { collidable: true, occluder: true },
  'hazard.downed_branch': { collidable: true, occluder: true },
  'hazard.trash_bags': { collidable: true, occluder: true },
  'hazard.ladder': { collidable: true, occluder: true },
  'hazard.mattress': { collidable: true, occluder: true },
  'hazard.debris': { collidable: true, occluder: true },
  'animal.deer': { collidable: true, occluder: true },
  'animal.dog': { collidable: true, occluder: true },
  'animal.cat': { collidable: true, occluder: true },
  'animal.raccoon': { collidable: true, occluder: true },
  'animal.goose': { collidable: true, occluder: true },
};

export function propBehavior(catalogId: string): PropBehavior {
  const id = resolvePropCatalogId(catalogId) ?? catalogId;
  return PROP_BEHAVIOR[id] ?? { collidable: false, occluder: true };
}

/**
 * Is this a catalog id this package can resolve to real dimensions?
 *
 * `propDims` deliberately falls back for unknown ids so non-Studio consumers stay parseable, and the
 * original note said "renderers reject them loudly". Headless authoring never reaches a renderer, so
 * for an agent the fallback is silent: a template carrying `vehicle.boxTruck` (which does not exist —
 * the real id is `vehicle.box_truck`) validates with exit 0 and materialises at 4.70 x 1.82 x 1.45,
 * i.e. a sedan. An occluder that silently becomes a sedan deletes the point of the scenario, which is
 * pitfall 4 in docs/research/retargeting.md: resolve assets against the catalog at author time and
 * fail loud. Author-time surfaces must call this and refuse unknown ids.
 */
export function isKnownPropCatalogId(catalogId: string): boolean {
  return resolvePropCatalogId(catalogId) !== null;
}

/** Every id this package can resolve, sorted — suitable for a "did you mean" repair hint. */
export function knownPropCatalogIds(): string[] {
  return [...Object.keys(PROP_DIMS), ...Object.keys(PROP_ALIAS_TARGETS)].sort();
}

/** Unknown ids remain parseable for non-Studio consumers; renderers reject them loudly. */
export function propDims(catalogId: string, override?: Partial<PropDims>): PropDims {
  const resolved = resolvePropCatalogId(catalogId);
  const base = (resolved === null ? undefined : PROP_DIMS[resolved]) ?? (catalogId.startsWith('vehicle.')
    ? { l: 4.7, w: 1.82, h: 1.45 }
    : { l: 1, w: 1, h: 1 });
  return {
    l: override?.l ?? base.l,
    w: override?.w ?? base.w,
    h: override?.h ?? base.h,
  };
}

/* --------------------------------------------- actor class / catalog id agreement */

/** Metadata resolver used by built-in and future user-imported asset catalogs. */
export type ActorCatalogResolver = (catalogId: string) => CatalogEntry | null;

export const builtInActorCatalogResolver: ActorCatalogResolver = (catalogId) => {
  const resolved = resolveCatalogId(catalogId);
  return resolved === null ? null : getEntry(resolved);
};

/**
 * Overlay user-imported catalog entries without allowing them to shadow a
 * built-in id. A custom vehicle therefore needs metadata, not a code release.
 */
export function createActorCatalogResolver(entries: readonly CatalogEntry[] = []): ActorCatalogResolver {
  // Custom assets are optional, and the external parser deliberately rejects
  // an empty array. Bundled catalog validation remains a separate boundary:
  // external ids use gallery/CARLA namespaces rather than class prefixes.
  if (entries.length === 0) return builtInActorCatalogResolver;
  const custom = new Map<string, CatalogEntry>();
  for (const entry of parseExternalCatalogEntries(entries)) {
    if (builtInActorCatalogResolver(entry.id) !== null) {
      throw new Error(`custom catalog entry "${entry.id}" shadows a built-in catalog id`);
    }
    if (custom.has(entry.id)) throw new Error(`duplicate custom catalog id "${entry.id}"`);
    custom.set(entry.id, entry);
  }
  return (catalogId) => builtInActorCatalogResolver(catalogId) ?? custom.get(catalogId) ?? null;
}

/** Actor classes acceptable for a catalog id, or `null` if the id is unknown. */
export function actorClassesForCatalogId(
  catalogId: string,
  resolveEntry: ActorCatalogResolver = builtInActorCatalogResolver,
): readonly string[] | null {
  const entry = resolveEntry(catalogId);
  return entry === null ? null : actorClassesForCatalogEntry(entry);
}

/**
 * Why this `class` may not be filled by this `catalogId`, or `null` if it may.
 *
 * Returns a sentence rather than a boolean because the caller's job is to fail
 * loudly and say what to fix. An unknown id is a mismatch too: it is the shape
 * the `vehicle.boxTruck` defect took.
 *
 * The long-term home for this check is `ActorSpecSchema` in
 * `scenario-model/src/schema/v2/roles.ts`, which would reject the document at
 * `template validate` instead of at materialize time; that move needs the
 * catalog id table to be reachable from `scenario-model`, which today would
 * mean a new workspace dependency.
 */
export function actorCatalogMismatch(
  actorClass: string,
  catalogId: string,
  resolveEntry: ActorCatalogResolver = builtInActorCatalogResolver,
): string | null {
  const allowed = actorClassesForCatalogId(catalogId, resolveEntry);
  if (allowed === null) {
    return `catalog id "${catalogId}" does not exist; an unresolved id silently materialises as a default model`;
  }
  if (allowed.includes(actorClass)) return null;
  return `actor class "${actorClass}" cannot be filled by catalog model "${catalogId}" ` +
    `(that model may only be ${allowed.join(', ')})`;
}

/** The catalog model's own footprint, in the scenario-model dims convention. */
export function catalogActorDims(
  catalogId: string,
  resolveEntry: ActorCatalogResolver = builtInActorCatalogResolver,
): { length: number; width: number; height: number } | null {
  const entry = resolveEntry(catalogId);
  if (entry === null) return null;
  return { length: entry.dims.l, width: entry.dims.w, height: entry.dims.h };
}
