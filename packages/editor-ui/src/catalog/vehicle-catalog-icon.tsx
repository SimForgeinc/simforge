import type { CatalogId } from "@uniscenarios/prop-catalog";

import {
  Hatchback,
  Minivan,
  Pickup,
  Sedan,
  Suv,
  Van,
} from "./art/vehicle-art/everyday-cars";
import {
  ChevroletCorvette,
  FordMustang,
  HondaCivic,
  JeepWrangler,
  Porsche911,
  TeslaModel3,
  ToyotaCamry,
} from "./art/vehicle-art/branded-cars";
import {
  Ambulance,
  FireCommandSuv,
  FireEngine,
  PoliceCruiser,
  PoliceSuv,
} from "./art/vehicle-art/emergency";
import {
  BoxTruck,
  CementMixer,
  DumpTruck,
  FlatbedTruck,
  GarbageTruck,
  SemiTruck,
  TankerTruck,
  TowTruck,
  UtilityBucketTruck,
} from "./art/vehicle-art/heavy-trucks";
import {
  Bus,
  DeliveryVan,
  SchoolBus,
  ShuttleBus,
  Taxi,
  Tram,
} from "./art/vehicle-art/transit";
import { Bicycle, MobilityScooter, Motorcycle } from "./art/vehicle-art/micro";

export const VEHICLE_CATALOG_IDS = [
  "vehicle.sedan",
  "vehicle.hatchback",
  "vehicle.suv",
  "vehicle.pickup",
  "vehicle.van",
  "vehicle.kia.carnival",
  "vehicle.box_truck",
  "vehicle.semi_truck",
  "vehicle.bus",
  "vehicle.motorcycle",
  "vehicle.bicycle",
  "vehicle.ambulance",
  "vehicle.tram",
  "vehicle.mobility_scooter",
  "vehicle.honda_civic",
  "vehicle.toyota_camry",
  "vehicle.tesla_model_3",
  "vehicle.ford_mustang",
  "vehicle.chevrolet_corvette",
  "vehicle.porsche_911",
  "vehicle.jeep_wrangler",
  "vehicle.minivan",
  "vehicle.taxi",
  "vehicle.police_cruiser",
  "vehicle.police_suv",
  "vehicle.fire_command_suv",
  "vehicle.fire_engine",
  "vehicle.dump_truck",
  "vehicle.garbage_truck",
  "vehicle.tow_truck",
  "vehicle.cement_mixer",
  "vehicle.utility_bucket_truck",
  "vehicle.tanker_truck",
  "vehicle.flatbed_truck",
  "vehicle.school_bus",
  "vehicle.shuttle_bus",
  "vehicle.delivery_van",
] as const satisfies readonly CatalogId[];

export type VehicleCatalogId = (typeof VEHICLE_CATALOG_IDS)[number];

/**
 * One drawing per vehicle.
 *
 * The previous artwork had thirteen hand-drawn elevations and sent the other
 * twenty-two through three generic shapes, so a Porsche 911, a Dodge Charger
 * and a Lincoln MKZ were the same picture. Each id now resolves to its own
 * side elevation; the shared geometry, palette and lighting live in
 * `vehicle-art/parts.tsx`.
 */
const VEHICLE_ART: Readonly<Record<VehicleCatalogId, () => React.ReactElement>> = {
  "vehicle.sedan": Sedan,
  "vehicle.hatchback": Hatchback,
  "vehicle.suv": Suv,
  "vehicle.pickup": Pickup,
  "vehicle.minivan": Minivan,
  "vehicle.van": Van,
  "vehicle.honda_civic": HondaCivic,
  "vehicle.toyota_camry": ToyotaCamry,
  "vehicle.tesla_model_3": TeslaModel3,
  "vehicle.ford_mustang": FordMustang,
  "vehicle.chevrolet_corvette": ChevroletCorvette,
  "vehicle.porsche_911": Porsche911,
  "vehicle.jeep_wrangler": JeepWrangler,
  "vehicle.kia.carnival": Minivan,
  "vehicle.ambulance": Ambulance,
  "vehicle.police_cruiser": PoliceCruiser,
  "vehicle.police_suv": PoliceSuv,
  "vehicle.fire_command_suv": FireCommandSuv,
  "vehicle.fire_engine": FireEngine,
  "vehicle.semi_truck": SemiTruck,
  "vehicle.box_truck": BoxTruck,
  "vehicle.dump_truck": DumpTruck,
  "vehicle.garbage_truck": GarbageTruck,
  "vehicle.tow_truck": TowTruck,
  "vehicle.cement_mixer": CementMixer,
  "vehicle.utility_bucket_truck": UtilityBucketTruck,
  "vehicle.tanker_truck": TankerTruck,
  "vehicle.flatbed_truck": FlatbedTruck,
  "vehicle.bus": Bus,
  "vehicle.school_bus": SchoolBus,
  "vehicle.shuttle_bus": ShuttleBus,
  "vehicle.tram": Tram,
  "vehicle.taxi": Taxi,
  "vehicle.delivery_van": DeliveryVan,
  "vehicle.motorcycle": Motorcycle,
  "vehicle.bicycle": Bicycle,
  "vehicle.mobility_scooter": MobilityScooter,
};

/** Side-elevation artwork for one catalog vehicle. */
export function VehicleCatalogIcon({ id }: { id: VehicleCatalogId }) {
  const Art = VEHICLE_ART[id];
  if (!Art) throw new Error(`Vehicle catalog artwork is missing for ${id}.`);
  return <Art />;
}
