import { EXTERNAL_CATALOG_PREFIXES, type CatalogEntry } from '@simforge-oss/asset-catalog/metadata';
import type { PropDims } from './prop-dims.js';
import type { ActorCatalogResolver } from './prop-dims.js';

/**
 * Deterministic CARLA similar-vehicle fallback for authored models with no
 * CARLA binding (product decision, 2026-08-24).
 *
 * An authored scenario must always be renderable in CARLA. A gallery-uploaded
 * vehicle keeps its authored GLB everywhere the browser renders, but the CARLA
 * runtime can only spawn blueprints that exist in the container, and the
 * runtime asset catalog binds those blueprints to *bundled* catalog ids. So a
 * vehicle whose catalog id has no runtime binding falls back — at the
 * compile/export boundary, never in the shared materialized input — to the
 * nearest CARLA-native bundled vehicle of the SAME class, and the substitution
 * is recorded in the export's provenance instead of failing the render.
 *
 * Guarantees (mirrors `carla-blueprint-substitution.ts` in SimCloud shared,
 * which substitutes between *known blueprints* for cross-map transfer; this
 * module substitutes for *unknown authored models* using class + dimensions):
 * - Class-preserving: car → car, van → van, truck → truck. Never a
 *   cross-class swap.
 * - Deterministic: candidates are ranked by footprint closeness
 *   (|Δlength| + |Δwidth|), ties fall back to codepoint-ordered catalog id.
 *   No randomness — the same authored entry always maps to the same fallback.
 * - Comparable footprint: a candidate deviating beyond max(1.5 m, 35 %) in
 *   length or max(0.5 m, 30 %) in width is rejected; with no comparable
 *   candidate the actor keeps failing closed (`no_comparable_footprint`).
 * - Fail closed for non-vehicles and classes with no CARLA counterpart in the
 *   0.10.0 container (bus, bicycle, motorcycle, scooter): those actors keep
 *   their authored id and the CARLA worker keeps rejecting them loudly.
 */

/** Road-vehicle classes the 0.10.0-kia container can actually spawn. */
export type CarlaFallbackVehicleClass = 'car' | 'van' | 'truck';

export interface CarlaVehicleFallbackCandidate {
  /**
   * Bundled catalog id with a native `runtimeBindings.carla` entry in every
   * published asset-catalog manifest. This — not a raw blueprint id — is the
   * substitution target, because the CARLA worker resolves actors through the
   * manifest and the manifest owns catalog-id → blueprint resolution.
   */
  readonly catalogId: string;
  /**
   * Container blueprint the repo-canonical catalog binds this id to
   * (config/scenario/carla/carla-object-catalog.json). Dimension
   * provenance only: the manifest active at render time decides the spawn.
   */
  readonly blueprintId: string;
  readonly vehicleClass: CarlaFallbackVehicleClass;
  /** Container-measured blueprint extents, metres. */
  readonly dims: PropDims;
}

/**
 * Plain-liveried CARLA-native vehicles measured from the
 * carla-rfs-munich-belmont:0.10.0-kia container. One bundled id per
 * (blueprint, class): emergency/taxi liveries are deliberately excluded — an
 * unknown family car must never come back painted as a police cruiser.
 */
export const CARLA_VEHICLE_FALLBACK_INVENTORY: readonly CarlaVehicleFallbackCandidate[] = [
  { catalogId: 'vehicle.sedan', blueprintId: 'vehicle.lincoln.mkz', vehicleClass: 'car', dims: { l: 4.892, w: 1.836, h: 1.524 } },
  { catalogId: 'vehicle.hatchback', blueprintId: 'vehicle.mini.cooper', vehicleClass: 'car', dims: { l: 4.553, w: 2.096, h: 1.772 } },
  { catalogId: 'vehicle.suv', blueprintId: 'vehicle.nissan.patrol', vehicleClass: 'car', dims: { l: 5.591, w: 2.147, h: 2.059 } },
  { catalogId: 'vehicle.ford_mustang', blueprintId: 'vehicle.dodge.charger', vehicleClass: 'car', dims: { l: 5.006, w: 1.881, h: 1.54 } },
  { catalogId: 'vehicle.van', blueprintId: 'vehicle.sprinter.mercedes', vehicleClass: 'van', dims: { l: 5.915, w: 1.988, h: 2.726 } },
  { catalogId: 'vehicle.kia.carnival', blueprintId: 'vehicle.kia.carnival', vehicleClass: 'van', dims: { l: 5.162, w: 2.351, h: 1.803 } },
  { catalogId: 'vehicle.box_truck', blueprintId: 'vehicle.carlacola.actors', vehicleClass: 'truck', dims: { l: 8.004, w: 2.912, h: 4.055 } },
];

/** Comparable-footprint caps, kept in parity with carla-blueprint-substitution. */
function maxLengthDeltaM(sourceLengthM: number): number {
  return Math.max(1.5, sourceLengthM * 0.35);
}
function maxWidthDeltaM(sourceWidthM: number): number {
  return Math.max(0.5, sourceWidthM * 0.3);
}

const NO_COUNTERPART_CLASSES: Readonly<Record<string, string>> = {
  bus: 'no bundled catalog id natively binds a bus in the CARLA 0.10.0 container catalog',
  motorcycle: 'the CARLA 0.10.0 container ships no motorcycle blueprint',
  bicycle: 'the CARLA 0.10.0 container ships no bicycle blueprint',
  scooter: 'the CARLA 0.10.0 container ships no scooter blueprint',
};

/**
 * Resolve the road-vehicle class an authored entry falls back within.
 *
 * The asset gallery collapses every road vehicle to actorClass `car`
 * (`galleryCatalogEntry`), so `car` really means "road vehicle, subclass
 * unknown" and is refined by shape: a 3 m-tall or 7 m-long "car" is a truck,
 * a tall cargo-van silhouette is a van. Explicit `van`/`truck` declarations
 * are honoured as-is. Returns `null` when the class has no CARLA counterpart.
 */
export function classifyCarlaFallbackVehicleClass(
  actorClass: string | undefined,
  dims: PropDims,
): CarlaFallbackVehicleClass | null {
  switch (actorClass) {
    case 'van':
    case 'truck':
      return actorClass;
    case 'car':
      if (dims.h >= 3.0 || dims.l >= 6.8) return 'truck';
      if (dims.h >= 2.15 && dims.l >= 4.6) return 'van';
      return 'car';
    default:
      return null;
  }
}

export type CarlaVehicleFallbackSelection =
  | {
      readonly ok: true;
      readonly catalogId: string;
      readonly vehicleClass: CarlaFallbackVehicleClass;
      readonly lengthDeltaM: number;
      readonly widthDeltaM: number;
      readonly heightDeltaM: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'not_a_road_vehicle' | 'no_carla_counterpart_class' | 'no_comparable_footprint';
      readonly detail: string;
    };


/** Deterministically pick the nearest same-class CARLA-native vehicle. */
export function selectCarlaVehicleFallback(
  entry: Pick<CatalogEntry, 'id' | 'class' | 'actorClass' | 'dims'>,
  inventory: readonly CarlaVehicleFallbackCandidate[] = CARLA_VEHICLE_FALLBACK_INVENTORY,
): CarlaVehicleFallbackSelection {
  if (entry.class !== 'vehicle') {
    return {
      ok: false,
      reason: 'not_a_road_vehicle',
      detail: `catalog entry "${entry.id}" is class "${entry.class}", not a road vehicle`,
    };
  }
  const noCounterpart = entry.actorClass === undefined ? undefined : NO_COUNTERPART_CLASSES[entry.actorClass];
  const vehicleClass = classifyCarlaFallbackVehicleClass(entry.actorClass, entry.dims);
  if (vehicleClass === null) {
    return {
      ok: false,
      reason: 'no_carla_counterpart_class',
      detail: noCounterpart
        ?? `actor class "${String(entry.actorClass)}" of "${entry.id}" has no CARLA road-vehicle counterpart`,
    };
  }
  const ranked = inventory
    .filter((candidate) => candidate.vehicleClass === vehicleClass)
    .map((candidate) => ({
      candidate,
      lengthDeltaM: candidate.dims.l - entry.dims.l,
      widthDeltaM: candidate.dims.w - entry.dims.w,
      heightDeltaM: candidate.dims.h - entry.dims.h,
    }))
    .filter((scored) =>
      Math.abs(scored.lengthDeltaM) <= maxLengthDeltaM(entry.dims.l)
      && Math.abs(scored.widthDeltaM) <= maxWidthDeltaM(entry.dims.w))
    .sort((left, right) =>
      (Math.abs(left.lengthDeltaM) + Math.abs(left.widthDeltaM))
        - (Math.abs(right.lengthDeltaM) + Math.abs(right.widthDeltaM))
      // Codepoint order on the catalog id keeps footprint ties deterministic.
      || (left.candidate.catalogId < right.candidate.catalogId ? -1
        : left.candidate.catalogId > right.candidate.catalogId ? 1 : 0));
  const winner = ranked[0];
  if (!winner) {
    return {
      ok: false,
      reason: 'no_comparable_footprint',
      detail: `no ${vehicleClass}-class CARLA vehicle is within the comparable-footprint caps of `
        + `${entry.dims.l.toFixed(2)}x${entry.dims.w.toFixed(2)}x${entry.dims.h.toFixed(2)} m for "${entry.id}"`,
    };
  }
  return {
    ok: true,
    catalogId: winner.candidate.catalogId,
    vehicleClass,
    lengthDeltaM: winner.lengthDeltaM,
    widthDeltaM: winner.widthDeltaM,
    heightDeltaM: winner.heightDeltaM,
  };
}

/** One recorded runtime-identity substitution, exported into provenance. */
export interface CarlaVehicleSubstitution {
  readonly actorId: string;
  readonly authoredCatalogId: string;
  readonly fallbackCatalogId: string;
  readonly vehicleClass: CarlaFallbackVehicleClass;
  readonly lengthDeltaM: number;
  readonly widthDeltaM: number;
  readonly heightDeltaM: number;
}

/** One actor left failing closed for CARLA, with the reason made visible. */
export interface CarlaUnrenderableActor {
  readonly actorId: string;
  readonly catalogId: string;
  readonly reason: 'not_a_road_vehicle' | 'no_carla_counterpart_class' | 'no_comparable_footprint';
  readonly detail: string;
}

export interface CarlaVehicleFallbackPlan<T> {
  /** Actors with external vehicle `catalog:` tags swapped to their fallback id. */
  readonly actors: readonly T[];
  readonly substitutions: readonly CarlaVehicleSubstitution[];
  readonly unrenderable: readonly CarlaUnrenderableActor[];
}

const CATALOG_TAG_PREFIX = 'catalog:';


/**
 * Rewrite the CARLA runtime identity of every actor bound to an external
 * (gallery/CARLA-namespace) vehicle entry that has no runtime binding.
 *
 * This runs on the *export* input only, after the concrete-input digest is
 * computed: browser renders keep the authored `catalog:gallery.*` identity
 * (and with it the authored GLB), while the OpenSCENARIO export the CARLA
 * worker consumes carries the fallback id the asset-catalog manifest can
 * bind. Bundled ids are untouched — their renderability is the manifest's
 * decision, not this module's. Substitutions and still-unrenderable actors
 * are returned for the caller to record in provenance; nothing is silent.
 */
export function planCarlaVehicleFallbacks<T extends { readonly id: string; readonly tags: readonly string[] }>(
  actors: readonly T[],
  resolveCatalogEntry: ActorCatalogResolver,
  inventory: readonly CarlaVehicleFallbackCandidate[] = CARLA_VEHICLE_FALLBACK_INVENTORY,
): CarlaVehicleFallbackPlan<T> {
  const substitutions: CarlaVehicleSubstitution[] = [];
  const unrenderable: CarlaUnrenderableActor[] = [];
  const planned = actors.map((actor) => {
    const tagIndex = actor.tags.findIndex((tag) => tag.startsWith(CATALOG_TAG_PREFIX));
    if (tagIndex === -1) return actor;
    const catalogId = actor.tags[tagIndex]!.slice(CATALOG_TAG_PREFIX.length);
    if (!EXTERNAL_CATALOG_PREFIXES.some((prefix) => catalogId.startsWith(prefix))) return actor;
    const entry = resolveCatalogEntry(catalogId);
    // An unresolvable external id is the materializer's fail-closed case and
    // cannot reach a valid export; leave it for that stronger boundary.
    if (entry === null) return actor;
    const selection = selectCarlaVehicleFallback(entry, inventory);
    if (!selection.ok) {
      unrenderable.push({
        actorId: actor.id,
        catalogId,
        reason: selection.reason,
        detail: selection.detail,
      });
      return actor;
    }
    substitutions.push({
      actorId: actor.id,
      authoredCatalogId: catalogId,
      fallbackCatalogId: selection.catalogId,
      vehicleClass: selection.vehicleClass,
      lengthDeltaM: selection.lengthDeltaM,
      widthDeltaM: selection.widthDeltaM,
      heightDeltaM: selection.heightDeltaM,
    });
    const tags = [...actor.tags];
    tags[tagIndex] = `${CATALOG_TAG_PREFIX}${selection.catalogId}`;
    return { ...actor, tags };
  });
  return { actors: planned, substitutions, unrenderable };
}
