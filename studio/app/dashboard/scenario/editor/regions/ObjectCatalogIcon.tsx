import type { CatalogId } from "@simforge-oss/asset-catalog";

import {
  BarricadeType3,
  ChannelizerDrum,
  Flagger,
  JerseyBarrier,
  JerseyBarrierRun,
  PedestrianBarrier,
  SignRoadWork,
  TrafficCone,
} from "./actor-art/work-zone-props";
import {
  ArrowBoard,
  PortableSignal,
  TemporaryStopSign,
} from "./actor-art/work-zone-trailers";
import { Debris, Ladder, Mattress, UnknownProp } from "./actor-art/misc-props";
import { CoveredCar, Dumpster, FenceRun, HedgeRun } from "./actor-art/occluders";
import { CardboardBox, DownedBranch, TireDebris, TrashBags } from "./actor-art/hazards";
import { Excavator, LongPipe, PortableToilet, SpoilPile } from "./actor-art/site-props";
import {
  BusShelter,
  FoodCart,
  MailboxCluster,
  ShoppingCart,
} from "./actor-art/street-furniture";

export const OBJECT_CATALOG_IDS = [
  "construction.traffic_cone",
  "construction.channelizer_drum",
  "construction.barricade_type3",
  "construction.pedestrian_barrier",
  "construction.jersey_barrier",
  "construction.jersey_barrier_run",
  "construction.sign_road_work",
  "construction.flagger",
  "construction.arrow_board",
  "construction.excavator",
  "construction.portable_toilet",
  "construction.spoil_pile",
  "construction.temporary_stop_sign",
  "construction.portable_signal",
  "construction.long_pipe",
  "occluder.dumpster",
  "occluder.covered_car",
  "occluder.hedge_run",
  "occluder.fence_run",
  "street.mailbox_cluster",
  "street.bus_shelter",
  "street.food_cart",
  "street.shopping_cart",
  "hazard.tire_debris",
  "hazard.cardboard_box",
  "hazard.trash_bags",
  "hazard.downed_branch",
  "hazard.ladder",
  "hazard.mattress",
  "hazard.debris",
] as const satisfies readonly CatalogId[];

export type ObjectCatalogId = (typeof OBJECT_CATALOG_IDS)[number];

/**
 * One drawing per prop. The previous artwork drew all twenty-seven from a
 * handful of blocks, so a dumpster, a hedge and a pile of bin bags were the
 * same rectangle. Shared geometry and palette live in `vehicle-art/parts.tsx`.
 */
const OBJECT_ART: Readonly<Record<ObjectCatalogId, () => React.ReactElement>> = {
  "construction.traffic_cone": TrafficCone,
  "construction.channelizer_drum": ChannelizerDrum,
  "construction.barricade_type3": BarricadeType3,
  "construction.pedestrian_barrier": PedestrianBarrier,
  "construction.jersey_barrier": JerseyBarrier,
  "construction.jersey_barrier_run": JerseyBarrierRun,
  "construction.sign_road_work": SignRoadWork,
  "construction.flagger": Flagger,
  "construction.arrow_board": ArrowBoard,
  "construction.excavator": Excavator,
  "construction.portable_toilet": PortableToilet,
  "construction.spoil_pile": SpoilPile,
  "construction.temporary_stop_sign": TemporaryStopSign,
  "construction.portable_signal": PortableSignal,
  "construction.long_pipe": LongPipe,
  "occluder.dumpster": Dumpster,
  "occluder.covered_car": CoveredCar,
  "occluder.hedge_run": HedgeRun,
  "occluder.fence_run": FenceRun,
  "street.mailbox_cluster": MailboxCluster,
  "street.bus_shelter": BusShelter,
  "street.food_cart": FoodCart,
  "street.shopping_cart": ShoppingCart,
  "hazard.tire_debris": TireDebris,
  "hazard.cardboard_box": CardboardBox,
  "hazard.trash_bags": TrashBags,
  "hazard.downed_branch": DownedBranch,
  "hazard.ladder": Ladder,
  "hazard.mattress": Mattress,
  "hazard.debris": Debris,
};

/**
 * Side-elevation artwork for one catalog prop.
 *
 * Accepts any catalog id, not just the drawn ones: the panel also routes
 * user-uploaded gallery models and any prop added to the catalog after this
 * file through here, and an editor must not fall over for want of a picture.
 */
export function ObjectCatalogIcon({ id }: { id: ObjectCatalogId | CatalogId }) {
  const Art = OBJECT_ART[id as ObjectCatalogId];
  return Art ? <Art /> : <UnknownProp id={id} />;
}
