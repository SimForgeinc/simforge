import { getEntry, type CatalogId } from '@simforge/asset-catalog';
import { firstOverlap, type Footprint } from './obb';

/** Clearance shared with ordinary actor placement. */
export const GROUP_PLACEMENT_CLEARANCE_M = 0.3;

/** One actor in a cursor-attached, free-form group placement gesture. */
export interface GroupPlacementActor {
  readonly catalogId: CatalogId;
  readonly dx: number;
  readonly dz: number;
  readonly fallbackY: number;
  readonly headingRad: number;
}

/** Exact free-form pose previewed and committed for one group member. */
export interface GroupPlacementPose extends GroupPlacementActor {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface GroupPlacementObstacle extends Footprint {
  readonly id: string;
}

export interface ResolvedGroupPlacement {
  readonly poses: readonly GroupPlacementPose[];
  readonly valid: boolean;
  readonly blockerId: string | null;
}

/**
 * Resolve a copied group around the cursor without road semantics. The same
 * exact poses feed the live ghost and the eventual commit, so clicking cannot
 * move or snap an actor after preview. Existing actors and earlier members of
 * the group are both collision obstacles.
 */
export function resolveFreeGroupPlacement(
  actors: readonly GroupPlacementActor[],
  anchor: { readonly x: number; readonly z: number },
  sampleHeight: (x: number, z: number, fallbackY: number) => number,
  existing: readonly GroupPlacementObstacle[],
): ResolvedGroupPlacement {
  const poses: GroupPlacementPose[] = [];
  const placed: GroupPlacementObstacle[] = [];
  let blockerId: string | null = null;

  for (let index = 0; index < actors.length; index++) {
    const actor = actors[index]!;
    const x = anchor.x + actor.dx;
    const z = anchor.z + actor.dz;
    const pose: GroupPlacementPose = {
      ...actor,
      x,
      y: sampleHeight(x, z, actor.fallbackY),
      z,
    };
    poses.push(pose);

    const dims = getEntry(actor.catalogId).dims;
    const footprint: Footprint = {
      x,
      z,
      length: dims.l,
      width: dims.w,
      headingRad: actor.headingRad,
    };
    const blocker = firstOverlap(footprint, existing, GROUP_PLACEMENT_CLEARANCE_M)
      ?? firstOverlap(footprint, placed, GROUP_PLACEMENT_CLEARANCE_M);
    if (blocker && blockerId === null) blockerId = blocker.id;
    placed.push({ ...footprint, id: `paste-${index}` });
  }

  return { poses, valid: blockerId === null, blockerId };
}
