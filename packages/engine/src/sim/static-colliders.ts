/** Lightweight, renderer-independent map collision geometry. */
export type StaticColliderClass = 'building' | 'wall' | 'barrier' | 'prop' | 'road-boundary';

export interface StaticMapCollider {
  /** Stable within a map. The engine exposes contacts as `map:<id>`. */
  readonly id: string;
  readonly class: StaticColliderClass;
  /** Scene-frame OBB (`x/z`, y-up), matching scenario poses. */
  readonly obb: {
    readonly center: { readonly x: number; readonly z: number };
    readonly lengthM: number;
    readonly widthM: number;
    readonly headingRad: number;
  };
}
