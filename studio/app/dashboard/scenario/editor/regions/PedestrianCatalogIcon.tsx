import type { CatalogId } from "@simforge-oss/asset-catalog";

import {
  Adult,
  AdultStanding,
  AdultWalking,
  Child,
  ChildStanding,
  ChildWalking,
  TrafficMarshal,
} from "./actor-art/pedestrians";

export const PEDESTRIAN_CATALOG_IDS = [
  "pedestrian.adult",
  "pedestrian.adult_walking",
  "pedestrian.adult_standing",
  "pedestrian.child",
  "pedestrian.child_walking",
  "pedestrian.child_standing",
  "pedestrian.traffic_marshal",
] as const satisfies readonly CatalogId[];

export type PedestrianCatalogId = (typeof PEDESTRIAN_CATALOG_IDS)[number];

/**
 * One drawing per person. Adults and children differ in height and in
 * head-to-body ratio, and each pose says what the person is doing, so a
 * scenario's crowd is readable at tile size instead of seven identical
 * figures. Shared geometry and palette live in `vehicle-art/parts.tsx`.
 */
const PEDESTRIAN_ART: Readonly<
  Record<PedestrianCatalogId, () => React.ReactElement>
> = {
  "pedestrian.adult": Adult,
  "pedestrian.adult_walking": AdultWalking,
  "pedestrian.adult_standing": AdultStanding,
  "pedestrian.child": Child,
  "pedestrian.child_walking": ChildWalking,
  "pedestrian.child_standing": ChildStanding,
  "pedestrian.traffic_marshal": TrafficMarshal,
};

/** Side-elevation artwork for one catalog pedestrian. */
export function PedestrianCatalogIcon({ id }: { id: PedestrianCatalogId }) {
  const Art = PEDESTRIAN_ART[id];
  return <Art />;
}
