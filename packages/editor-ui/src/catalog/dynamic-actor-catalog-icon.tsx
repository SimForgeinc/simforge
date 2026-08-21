import type { CatalogId } from "@uniscenarios/prop-catalog";

import { Cat, Deer, Dog, Goose, Raccoon } from "./art/actor-art/animals";
import {
  CameraQuadcopter,
  DeliveryQuadcopter,
  EmergencyResponder,
} from "./art/actor-art/drones";
import {
  HumanoidConstruction,
  HumanoidDelivery,
  HumanoidGeneralPurpose,
  HumanoidPublicSafety,
  HumanoidWarehouse,
} from "./art/actor-art/humanoid-robots";
import {
  CoolerBot,
  DeliveryRover,
  QuadrupedCourier,
} from "./art/actor-art/sidewalk-robots";

export const DYNAMIC_ACTOR_CATALOG_IDS = [
  'sidewalk_robot.delivery_rover',
  'sidewalk_robot.cooler_bot',
  'sidewalk_robot.quadruped_courier',
  'sidewalk_robot.humanoid_general_purpose',
  'sidewalk_robot.humanoid_delivery',
  'sidewalk_robot.humanoid_warehouse',
  'sidewalk_robot.humanoid_public_safety',
  'sidewalk_robot.humanoid_construction',
  'drone.delivery_quadcopter',
  'drone.camera_quadcopter',
  'drone.emergency_responder',
  'animal.dog',
  'animal.cat',
  'animal.deer',
  'animal.raccoon',
  'animal.goose',
] as const satisfies readonly CatalogId[];

export type DynamicActorCatalogId = (typeof DYNAMIC_ACTOR_CATALOG_IDS)[number];

export function isDynamicActorCatalogId(id: CatalogId): id is DynamicActorCatalogId {
  return (DYNAMIC_ACTOR_CATALOG_IDS as readonly string[]).includes(id);
}

/**
 * One drawing per actor. The previous artwork drew these sixteen from four
 * shapes: every humanoid robot was the same picture, and every animal was the
 * same picture with an "antlers" and a "bird" flag. Shared geometry, palette
 * and lighting live in `vehicle-art/parts.tsx`.
 */
const DYNAMIC_ACTOR_ART: Readonly<
  Record<DynamicActorCatalogId, () => React.ReactElement>
> = {
  "sidewalk_robot.delivery_rover": DeliveryRover,
  "sidewalk_robot.cooler_bot": CoolerBot,
  "sidewalk_robot.quadruped_courier": QuadrupedCourier,
  "sidewalk_robot.humanoid_general_purpose": HumanoidGeneralPurpose,
  "sidewalk_robot.humanoid_delivery": HumanoidDelivery,
  "sidewalk_robot.humanoid_warehouse": HumanoidWarehouse,
  "sidewalk_robot.humanoid_public_safety": HumanoidPublicSafety,
  "sidewalk_robot.humanoid_construction": HumanoidConstruction,
  "drone.delivery_quadcopter": DeliveryQuadcopter,
  "drone.camera_quadcopter": CameraQuadcopter,
  "drone.emergency_responder": EmergencyResponder,
  "animal.dog": Dog,
  "animal.cat": Cat,
  "animal.deer": Deer,
  "animal.raccoon": Raccoon,
  "animal.goose": Goose,
};

/** Side-elevation artwork for one robot, drone or animal. */
export function DynamicActorCatalogIcon({ id }: { id: DynamicActorCatalogId }) {
  const Art = DYNAMIC_ACTOR_ART[id];
  return <Art />;
}
