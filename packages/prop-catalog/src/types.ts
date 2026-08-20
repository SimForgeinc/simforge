/**
 * Catalog vocabulary.
 *
 * ## Conventions every builder in this package obeys
 *
 * - **Units**: metres. Every dimension is the real-world dimension of the thing
 *   being represented; semantic correctness beats visual fidelity.
 * - **Frame**: y-up (the scene frame `city-renderer` and `xodr-tools` use).
 *   `+X` is the object's facing / run direction, `+Z` is its left-to-right
 *   extent. A vehicle drives towards `+X`; a sign faces `+X`; a barrier or
 *   hedge *run* extends along `+X`.
 * - **Origin**: ground-centre. The bounding box of a built prop is centred on
 *   the origin in X and Z and starts at `y = 0` (wheels/feet/base touch the
 *   ground plane), so placement is `group.position.set(x, groundY, z)` plus a
 *   yaw about Y — no per-prop offsets to remember.
 * - **Dims**: `l` is the extent along X, `w` along Z, `h` along Y.
 */

/** Broad semantic bucket. Agents filter on this first, then on tags. */
export type PropClass =
  | 'vehicle'
  | 'pedestrian'
  | 'sidewalk_robot'
  | 'drone'
  | 'animal'
  | 'construction'
  | 'occluder'
  | 'hazard'
  | 'street';

export const PROP_CLASSES: readonly PropClass[] = [
  'vehicle',
  'pedestrian',
  'sidewalk_robot',
  'drone',
  'animal',
  'construction',
  'occluder',
  'hazard',
  'street',
] as const;

/**
 * Machine-usable tag vocabulary. Free-form strings are rejected by the schema
 * so that an agent picking props by tag can rely on a closed set.
 *
 * - `occlusion:*` — how much of the road scene this thing hides. `high` blocks
 *   a whole lane's sightline (semi trailer, box truck, bus shelter), `medium`
 *   hides a crossing pedestrian (van, dumpster, hedge), `low` is a low object
 *   you can see over (cone, debris).
 * - `vru` — vulnerable road user (pedestrian, cyclist, motorcyclist).
 * - `workzone` — belongs to a temporary traffic control setup.
 * - `roadway` / `roadside` / `sidewalk` — where the thing is normally placed.
 * - `mobile` — has wheels and can legitimately be given a velocity.
 * - `parkable` — sensible member of a parked row.
 * - `run` — parametric linear element (length is a build parameter).
 * - `debris` — unexpected object in the travelled way.
 * - `large-vehicle` — heavy vehicle, wide turning envelope.
 */
export type PropTag =
  | 'occlusion:high'
  | 'occlusion:medium'
  | 'occlusion:low'
  | 'vru'
  | 'workzone'
  | 'roadway'
  | 'roadside'
  | 'sidewalk'
  | 'mobile'
  | 'parkable'
  | 'run'
  | 'debris'
  | 'large-vehicle'
  | 'autonomous'
  | 'aerial'
  | 'delivery'
  | 'emergency'
  | 'service'
  | 'passenger'
  | 'commercial'
  | 'wildlife'
  | 'domestic';

export const PROP_TAGS: readonly PropTag[] = [
  'occlusion:high',
  'occlusion:medium',
  'occlusion:low',
  'vru',
  'workzone',
  'roadway',
  'roadside',
  'sidewalk',
  'mobile',
  'parkable',
  'run',
  'debris',
  'large-vehicle',
  'autonomous',
  'aerial',
  'delivery',
  'emergency',
  'service',
  'passenger',
  'commercial',
  'wildlife',
  'domestic',
] as const;

/** Animation contract shared by procedural previews and authored GLB replacements. */
export interface CatalogAnimationProfile {
  /** Skeleton/mechanism family expected from a high-detail replacement model. */
  readonly rig: 'wheeled' | 'rotorcraft' | 'quadruped' | 'humanoid' | 'avian';
  /** Required, case-sensitive glTF clip names. */
  readonly clips: readonly string[];
  readonly idleClip: string;
  readonly locomotionClip: string;
  /** Height above the ground plane while airborne. */
  readonly hoverHeightM?: number;
}

/** Extents in metres: `l` along +X (facing), `w` along Z, `h` along Y. */
export interface Dims {
  l: number;
  w: number;
  h: number;
}

/** Physics/controller family used when a catalog model becomes an actor. */
export type CatalogActorClass =
  | 'car'
  | 'truck'
  | 'bus'
  | 'van'
  | 'motorcycle'
  | 'bicycle'
  | 'scooter'
  | 'pedestrian'
  | 'sidewalk_robot'
  | 'drone'
  | 'animal'
  | 'static_object';

export const CATALOG_ACTOR_CLASSES: readonly CatalogActorClass[] = [
  'car',
  'truck',
  'bus',
  'van',
  'motorcycle',
  'bicycle',
  'scooter',
  'pedestrian',
  'sidewalk_robot',
  'drone',
  'animal',
  'static_object',
] as const;

/** Build parameters are plain JSON so the catalog can round-trip as data. */
export type ParamValue = number | string | boolean;

/** A model that is not procedurally built. */
export type ExternalModelBinding =
  | {
      readonly kind: 'glb';
      /** Fetchable URL for the GLB. May be signed and short-lived; never persisted in a scenario. */
      readonly url: string;
      /** Lowercase sha256 hex of the GLB bytes. The cache key; stable across signed URL rotation. */
      readonly contentHash: string;
      /** Uniform scale applied to the loaded scene before normalisation. Defaults to 1. */
      readonly scale?: number;
      /** Yaw applied about +Y before normalisation, radians. Defaults to 0. */
      readonly yawRad?: number;
      /** The GLB carries animation clips and must render as an animated clone, not an instance. */
      readonly animated?: boolean;
      /** Clip names, when animated. */
      readonly clips?: { readonly idle?: string; readonly locomotion?: string };
    }
  | { readonly kind: 'proxy'; readonly tint?: string };

export interface CatalogEntry {
  /** Stable `<class>.<name>` identifier. The contract other packages hold. */
  readonly id: string;
  /** Human label for pickers. */
  readonly label: string;
  readonly class: PropClass;
  /**
   * Authoritative simulation/physics class. Vehicle entries must declare it;
   * other classes may override their broad catalog class for mobile exceptions.
   */
  readonly actorClass?: CatalogActorClass;
  /** Additional legacy or deliberately interchangeable actor classes. */
  readonly compatibleActorClasses?: readonly CatalogActorClass[];
  /**
   * One sentence, written for an LLM choosing props for a scenario: what it is
   * and what it is useful for in a driving scene.
   */
  readonly description: string;
  /** Real-world extents of the default build, metres. */
  readonly dims: Dims;
  readonly tags: readonly PropTag[];
  /** Parameters the builder is called with when none are supplied. */
  readonly defaultParams: Readonly<Record<string, ParamValue>>;
  /**
   * Canonical replacement for a compatibility-only id. Legacy aliases remain
   * resolvable for saved scenarios but are omitted from new-authoring pickers.
   */
  readonly legacyAliasOf?: string;
  /** Present for every actor whose authored model must ship with animation. */
  readonly animation?: CatalogAnimationProfile;
  readonly model?: ExternalModelBinding;
}
