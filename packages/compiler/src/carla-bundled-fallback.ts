import { CARLA_VEHICLE_FALLBACK_INVENTORY } from './carla-fallback.js';
import type { PropDims } from './prop-dims.js';

export interface RuntimeCatalogBinding {
  readonly mode: string;
  readonly blueprintId: string;
}

/** Portable slice of one claimed runtime asset-catalog entry. */
export interface RuntimeCatalogEntry {
  readonly id: string;
  readonly class: string;
  readonly actorClass?: string;
  readonly compatibleActorClasses?: readonly string[];
  readonly dims?: PropDims;
  readonly tags?: readonly string[];
  readonly carla?: RuntimeCatalogBinding;
}

/** Measured capability of one blueprint in the target CARLA runtime. */
export interface CarlaBlueprintCapability {
  readonly blueprintId: string;
  readonly dims: PropDims;
  readonly actorClass?: string;
  readonly tags?: readonly string[];
}

type BundledVehicleClass = 'car' | 'van' | 'truck' | 'bus';

export interface BundledVehicleSubstitution {
  readonly actorId: string;
  readonly authoredCatalogId: string;
  readonly fallbackCatalogId: string;
  readonly vehicleClass: BundledVehicleClass;
  readonly lengthDeltaM: number | null;
  readonly widthDeltaM: number | null;
  readonly heightDeltaM: number | null;
}

export interface BundledPropSubstitution {
  readonly actorId: string;
  readonly authoredCatalogId: string;
  readonly fallbackCatalogId: string;
  readonly lengthDeltaM: number | null;
  readonly widthDeltaM: number | null;
  readonly heightDeltaM: number | null;
}

export interface BundledOmittedProp {
  readonly actorId: string;
  readonly catalogId: string;
  readonly reason: 'no_native_carla_counterpart';
  readonly detail: string;
}

export interface BundledUnrenderableActor {
  readonly actorId: string;
  readonly catalogId: string;
  readonly reason: 'no_carla_counterpart_class';
  readonly detail: string;
}

export interface BundledCarlaFallbackPlan<T> {
  readonly actors: readonly T[];
  readonly vehicleSubstitutions: readonly BundledVehicleSubstitution[];
  readonly propSubstitutions: readonly BundledPropSubstitution[];
  readonly omittedProps: readonly BundledOmittedProp[];
  readonly unrenderable: readonly BundledUnrenderableActor[];
}

const PROP_CLASSES: Record<string, true> = {
  construction: true,
  hazard: true,
  occluder: true,
  street: true,
};

const NO_COUNTERPART_DETAILS: Record<string, string> = {
  motorcycle: 'the target CARLA runtime exposes no motorcycle capability',
  bicycle: 'the target CARLA runtime exposes no bicycle capability',
  scooter: 'the target CARLA runtime exposes no scooter capability',
};

const CATALOG_TAG_PREFIX = 'catalog:';

function narrowDims(value: unknown): PropDims | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!('l' in value) || !('w' in value) || !('h' in value)) return undefined;
  const { l, w, h } = value;
  return typeof l === 'number' && typeof w === 'number' && typeof h === 'number' ? { l, w, h } : undefined;
}

/** Narrow a decoded runtime manifest into the portable entry slice. */
export function runtimeCatalogEntries(manifest: unknown): readonly RuntimeCatalogEntry[] {
  if (typeof manifest !== 'object' || manifest === null || !('entries' in manifest) || !Array.isArray(manifest.entries)) return [];
  const entries: RuntimeCatalogEntry[] = [];
  for (const row of manifest.entries) {
    if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string') continue;
    if (!('class' in row) || typeof row.class !== 'string') continue;
    const bindings = 'runtimeBindings' in row && typeof row.runtimeBindings === 'object' && row.runtimeBindings !== null
      && 'carla' in row.runtimeBindings && typeof row.runtimeBindings.carla === 'object' && row.runtimeBindings.carla !== null
      ? row.runtimeBindings.carla : undefined;
    const carla = bindings && 'mode' in bindings && typeof bindings.mode === 'string'
      && 'blueprintId' in bindings && typeof bindings.blueprintId === 'string'
      ? { mode: bindings.mode, blueprintId: bindings.blueprintId } : undefined;
    entries.push({
      id: row.id,
      class: row.class,
      actorClass: 'actorClass' in row && typeof row.actorClass === 'string' ? row.actorClass : undefined,
      compatibleActorClasses: 'compatibleActorClasses' in row && Array.isArray(row.compatibleActorClasses)
        ? row.compatibleActorClasses.filter((item: unknown): item is string => typeof item === 'string') : undefined,
      dims: 'dims' in row ? narrowDims(row.dims) : undefined,
      tags: 'tags' in row && Array.isArray(row.tags)
        ? row.tags.filter((item: unknown): item is string => typeof item === 'string') : undefined,
      carla,
    });
  }
  return entries;
}

/** Narrow a CARLA object-capability document into measured blueprints. */
export function carlaBlueprintCapabilities(document: unknown): readonly CarlaBlueprintCapability[] {
  if (typeof document !== 'object' || document === null || !('objects' in document) || !Array.isArray(document.objects)) return [];
  const capabilities: CarlaBlueprintCapability[] = [];
  for (const row of document.objects) {
    if (typeof row !== 'object' || row === null) continue;
    const dims = 'dims' in row ? narrowDims(row.dims) : undefined;
    const carla = 'carla' in row && typeof row.carla === 'object' && row.carla !== null ? row.carla : undefined;
    const blueprintId = carla && 'blueprintId' in carla && typeof carla.blueprintId === 'string'
      ? carla.blueprintId : undefined;
    if (!blueprintId || !dims) continue;
    capabilities.push({
      blueprintId,
      dims,
      actorClass: 'actorClass' in row && typeof row.actorClass === 'string' ? row.actorClass : undefined,
      tags: 'tags' in row && Array.isArray(row.tags)
        ? row.tags.filter((item: unknown): item is string => typeof item === 'string') : undefined,
    });
  }
  return capabilities;
}

function nativeBinding(entry: RuntimeCatalogEntry): RuntimeCatalogBinding | null {
  return entry.carla?.mode === 'native-blueprint' ? entry.carla : null;
}

function isVehicleClass(value: string | undefined): value is BundledVehicleClass {
  return value === 'car' || value === 'van' || value === 'truck' || value === 'bus';
}

function refineCarClass(dims: PropDims): BundledVehicleClass {
  if (dims.h >= 3 || dims.l >= 6.8) return 'truck';
  if (dims.h >= 2.15 && dims.l >= 4.6) return 'van';
  return 'car';
}

interface VehicleCandidate {
  readonly catalogId: string;
  readonly vehicleClass: BundledVehicleClass;
  readonly dims: PropDims;
}

function vehicleCandidates(
  entries: readonly RuntimeCatalogEntry[],
  capabilities: readonly CarlaBlueprintCapability[],
): readonly VehicleCandidate[] {
  const capabilityByBlueprint = new Map(capabilities.map((item) => [item.blueprintId, item]));
  const preferredIds = new Set(CARLA_VEHICLE_FALLBACK_INVENTORY.map((item) => item.catalogId));
  const byBlueprint = new Map<string, VehicleCandidate>();
  for (const entry of entries) {
    if (entry.class !== 'vehicle' || entry.tags?.some((tag) => tag === 'emergency' || tag === 'service')) continue;
    const binding = nativeBinding(entry);
    if (!binding || !binding.blueprintId.startsWith('vehicle.')) continue;
    const capability = capabilityByBlueprint.get(binding.blueprintId);
    if (!capability || capability.tags?.some((tag) => tag === 'emergency' || tag === 'service')) continue;
    if (!isVehicleClass(capability.actorClass)) continue;
    const candidate = { catalogId: entry.id, vehicleClass: capability.actorClass, dims: capability.dims };
    const existing = byBlueprint.get(binding.blueprintId);
    if (!existing
      || (preferredIds.has(candidate.catalogId) && !preferredIds.has(existing.catalogId))
      || (preferredIds.has(candidate.catalogId) === preferredIds.has(existing.catalogId)
        && candidate.catalogId < existing.catalogId)) byBlueprint.set(binding.blueprintId, candidate);
  }
  return [...byBlueprint.values()];
}

type VehicleSelection = {
  readonly candidate: VehicleCandidate;
  readonly vehicleClass: BundledVehicleClass;
  readonly lengthDeltaM: number | null;
  readonly widthDeltaM: number | null;
  readonly heightDeltaM: number | null;
} | { readonly detail: string };

function selectVehicle(
  entry: RuntimeCatalogEntry,
  candidates: readonly VehicleCandidate[],
): VehicleSelection {
  const declaredClasses = [entry.actorClass, ...(entry.compatibleActorClasses ?? [])]
    .filter((item): item is string => typeof item === 'string')
    .filter((item, index, all) => all.indexOf(item) === index);
  if (declaredClasses.length === 0) return { detail: `catalog entry "${entry.id}" declares no actor class` };
  let firstDetail = '';
  for (const declared of declaredClasses) {
    const vehicleClass = declared === 'car' && entry.dims ? refineCarClass(entry.dims) : declared;
    if (!isVehicleClass(vehicleClass)) {
      firstDetail ||= NO_COUNTERPART_DETAILS[vehicleClass]
        ?? `actor class "${vehicleClass}" of "${entry.id}" has no CARLA road-vehicle counterpart`;
      continue;
    }
    const ranked = candidates.filter((candidate) => candidate.vehicleClass === vehicleClass)
      .map((candidate) => ({
        candidate,
        lengthDeltaM: entry.dims ? candidate.dims.l - entry.dims.l : null,
        widthDeltaM: entry.dims ? candidate.dims.w - entry.dims.w : null,
        heightDeltaM: entry.dims ? candidate.dims.h - entry.dims.h : null,
      }))
      .sort((left, right) => {
        const ld = left.lengthDeltaM === null || left.widthDeltaM === null ? 0 : Math.abs(left.lengthDeltaM) + Math.abs(left.widthDeltaM);
        const rd = right.lengthDeltaM === null || right.widthDeltaM === null ? 0 : Math.abs(right.lengthDeltaM) + Math.abs(right.widthDeltaM);
        return ld - rd || left.candidate.catalogId.localeCompare(right.candidate.catalogId);
      });
    if (ranked[0]) return { ...ranked[0], vehicleClass };
    firstDetail ||= `no natively bound ${vehicleClass}-class catalog id exists for "${entry.id}"`;
  }
  return { detail: firstDetail };
}

/**
 * Rewrite bundled identities that the claimed CARLA runtime cannot spawn.
 * The caller supplies both the runtime manifest and measured CARLA capability
 * document, keeping this lowering independent of repository config paths.
 */
export function planBundledCarlaFallbacks<T extends { readonly id: string; readonly tags: readonly string[] }>(
  actors: readonly T[],
  entries: readonly RuntimeCatalogEntry[] | undefined,
  capabilities: readonly CarlaBlueprintCapability[],
): BundledCarlaFallbackPlan<T> {
  const vehicleSubstitutions: BundledVehicleSubstitution[] = [];
  const propSubstitutions: BundledPropSubstitution[] = [];
  const omittedProps: BundledOmittedProp[] = [];
  const unrenderable: BundledUnrenderableActor[] = [];
  if (!entries?.length) return { actors, vehicleSubstitutions, propSubstitutions, omittedProps, unrenderable };
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const capabilityByBlueprint = new Map(capabilities.map((item) => [item.blueprintId, item]));
  const candidates = vehicleCandidates(entries, capabilities);
  const planned: T[] = [];
  for (const actor of actors) {
    const tagIndex = actor.tags.findIndex((tag) => tag.startsWith(CATALOG_TAG_PREFIX));
    if (tagIndex < 0) { planned.push(actor); continue; }
    const catalogId = actor.tags[tagIndex]!.slice(CATALOG_TAG_PREFIX.length);
    if (catalogId.startsWith('gallery.') || catalogId.startsWith('carla.')) { planned.push(actor); continue; }
    const entry = byId.get(catalogId);
    if (!entry || nativeBinding(entry)) { planned.push(actor); continue; }
    const substitute = (fallbackId: string): T => {
      const tags = [...actor.tags];
      tags[tagIndex] = `${CATALOG_TAG_PREFIX}${fallbackId}`;
      return { ...actor, tags };
    };
    if (entry.class === 'vehicle') {
      const selection = selectVehicle(entry, candidates);
      if ('detail' in selection) {
        unrenderable.push({ actorId: actor.id, catalogId, reason: 'no_carla_counterpart_class', detail: selection.detail });
        planned.push(actor);
      } else {
        vehicleSubstitutions.push({ actorId: actor.id, authoredCatalogId: catalogId,
          fallbackCatalogId: selection.candidate.catalogId, vehicleClass: selection.vehicleClass,
          lengthDeltaM: selection.lengthDeltaM, widthDeltaM: selection.widthDeltaM, heightDeltaM: selection.heightDeltaM });
        planned.push(substitute(selection.candidate.catalogId));
      }
      continue;
    }
    if (PROP_CLASSES[entry.class]) {
      const person = entry.actorClass === 'pedestrian';
      const pool = entries.flatMap((candidate) => {
        const binding = nativeBinding(candidate);
        if (!binding) return [];
        const capability = capabilityByBlueprint.get(binding.blueprintId);
        if (!capability) return [];
        const eligible = person
          ? binding.blueprintId.startsWith('walker.')
          : candidate.class === entry.class
            && !binding.blueprintId.startsWith('vehicle.')
            && !binding.blueprintId.startsWith('walker.');
        return eligible ? [{ candidate, dims: capability.dims }] : [];
      }).sort((a, b) => {
        const ad = entry.dims ? Math.abs(a.dims.l - entry.dims.l) + Math.abs(a.dims.w - entry.dims.w) : 0;
        const bd = entry.dims ? Math.abs(b.dims.l - entry.dims.l) + Math.abs(b.dims.w - entry.dims.w) : 0;
        return ad - bd || a.candidate.id.localeCompare(b.candidate.id);
      });
      const fallback = pool[0];
      if (fallback) {
        propSubstitutions.push({ actorId: actor.id, authoredCatalogId: catalogId, fallbackCatalogId: fallback.candidate.id,
          lengthDeltaM: entry.dims ? fallback.dims.l - entry.dims.l : null,
          widthDeltaM: entry.dims ? fallback.dims.w - entry.dims.w : null,
          heightDeltaM: entry.dims ? fallback.dims.h - entry.dims.h : null });
        planned.push(substitute(fallback.candidate.id));
      } else if (person) {
        unrenderable.push({ actorId: actor.id, catalogId, reason: 'no_carla_counterpart_class',
          detail: `no natively bound walker exists for person-class prop "${catalogId}"` });
        planned.push(actor);
      } else {
        omittedProps.push({ actorId: actor.id, catalogId, reason: 'no_native_carla_counterpart',
          detail: `no natively bound ${entry.class}-class prop exists for "${catalogId}"` });
      }
      continue;
    }
    planned.push(actor);
  }
  return { actors: planned, vehicleSubstitutions, propSubstitutions, omittedProps, unrenderable };
}
