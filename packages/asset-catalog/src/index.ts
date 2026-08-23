/**
 * `@simforge/asset-catalog` — the placeable-object library.
 *
 * Every object in the catalog is generated from `BufferGeometry` primitives at
 * runtime: no model files, no downloads, no licences to track. That keeps the
 * library parametric (a hedge run takes a length, a work zone takes a taper)
 * and tiny, and it means the visual bar is set by silhouette and dimensional
 * accuracy rather than by asset budget. Hi-fi meshes can be swapped in later
 * behind the same catalog ids.
 *
 * ```ts
 * import { buildProp, queryCatalog, buildWorkZone } from '@simforge/asset-catalog';
 *
 * const van = buildProp('vehicle.van', { color: '#e8e9ea' });
 * van.position.set(x, groundY, z);          // ground-centred, +X forward
 *
 * const blockers = queryCatalog({ tags: ['occlusion:high'] });
 * scene.add(buildWorkZone({ length: 80, side: 'right' }));
 * ```
 */

export type {
  CatalogEntry,
  CatalogActorClass,
  CatalogAnimationProfile,
  Dims,
  ExternalModelBinding,
  ParamValue,
  PropClass,
  PropTag,
} from './types';
export { PROP_CLASSES, PROP_TAGS } from './types';

export {
  CATALOG,
  CATALOG_ALIASES,
  CATALOG_IDS,
  AUTHORING_CATALOG,
  EXTERNAL_CATALOG_PREFIXES,
  actorClassForCatalogEntry,
  actorClassesForCatalogEntry,
  clearExternalCatalogEntries,
  externalModelBinding,
  type ExternalCatalogEntry,
  type CatalogId,
  type CatalogQuery,
  getEntry,
  isExternalCatalogId,
  listExternalCatalogEntries,
  onExternalCatalogChange,
  isCatalogId,
  queryCatalog,
  resolveCatalogId,
  registerExternalCatalogEntry,
  unregisterExternalCatalogEntry,
} from './catalog';

export { BUILDER_IDS, buildProp, type PropParamMap } from './registry';

export {
  buildParkedRow,
  buildWorkZone,
  type ParkedRowParams,
  type WorkZoneCounts,
  type WorkZoneParams,
} from './composites';

export { parseCatalog } from './schema';

export {
  disposeMaterials,
  material,
  type MaterialKey,
  PALETTE,
  VEHICLE_COLORS,
  vehicleColor,
} from './materials';

// Direct builder access, for callers that want a specific parametric variant
// without going through the catalog defaults.
export type { VehicleParams } from './builders/shell';
export type { PedestrianParams } from './builders/pedestrians';
export type { RobotParams } from './builders/robots';
export type { DroneParams } from './builders/drones';
export type { AnimalParams } from './builders/animals';
export type {
  ArrowBoardParams,
  BarrierParams,
  BarrierRunParams,
  ConeParams,
  FlaggerParams,
  SignParams,
  SpoilPileParams,
} from './builders/construction';
export type { RunParams } from './builders/street';
export type { TrashBagParams } from './builders/hazards';
