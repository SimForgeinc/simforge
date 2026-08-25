import type { CrosswalkEntity, JunctionEntity } from "../../map-intelligence";

export type CrosswalkPrimitives = {
  is_near_junction: boolean;
  is_midblock: boolean;
  is_marked: true;
  is_signalized: boolean;
  nearest_junction_approach_count: number | undefined;
};

export function computeCrosswalkPrimitives(
  entity: CrosswalkEntity,
  junctions: JunctionEntity[],
): CrosswalkPrimitives {
  const nearestJunction = entity.nearestJunctionEntityId
    ? junctions.find((j) => j.entityId === entity.nearestJunctionEntityId)
    : undefined;

  const isSignalized = nearestJunction?.isSignalized ?? false;

  return {
    is_near_junction: entity.isNearJunction,
    is_midblock: !entity.isNearJunction,
    is_marked: true,
    is_signalized: entity.isNearJunction && isSignalized,
    nearest_junction_approach_count: nearestJunction?.approachCount,
  };
}
