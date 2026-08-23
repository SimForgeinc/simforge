/** Identifier for a virtual-world map feature category. */
export type FeatureId =
  | "intersection"
  | "parking"
  | "single_lane_road"
  | "single_lane_each_way"
  | "two_lane_one_way"
  | "two_lane_each_way"
  | "crosswalk"
  | "stop_control";

/** Catalog of map feature definitions with labels, colors, and search aliases. */
export const featureDefinitions: Array<{
  id: FeatureId;
  label: string;
  color: string;
  aliases: string[];
}> = [
  {
    id: "intersection",
    label: "Intersections",
    color: "#ff8f4d",
    aliases: ["intersection", "intersections", "junction", "junctions"],
  },
  {
    id: "parking",
    label: "Parking",
    color: "#ffd166",
    aliases: ["parking", "parking space", "parking spaces", "park"],
  },
  {
    id: "single_lane_road",
    label: "Single-Lane",
    color: "#8ecae6",
    aliases: ["single lane", "single lane road", "one lane"],
  },
  {
    id: "single_lane_each_way",
    label: "1x1 Roads",
    color: "#90be6d",
    aliases: ["1x1", "one each way", "single lane each way", "two-way single lane"],
  },
  {
    id: "two_lane_one_way",
    label: "2-Wide One-Way",
    color: "#f4a261",
    aliases: ["2 wide lane", "two wide lane", "two lane one way", "2 lane one way"],
  },
  {
    id: "two_lane_each_way",
    label: "2x2 Roads",
    color: "#e76f51",
    aliases: ["2x2", "two lane each way", "two by two"],
  },
  {
    id: "crosswalk",
    label: "Crosswalks",
    color: "#06d6a0",
    aliases: ["crosswalk", "crosswalks", "pedestrian crossing"],
  },
  {
    id: "stop_control",
    label: "Stop Control",
    color: "#ef476f",
    aliases: ["stop", "stop line", "stop sign", "stop control"],
  },
];

/** Lookup from feature ID to its human-readable label. */
export const featureLabels = Object.fromEntries(
  featureDefinitions.map((feature) => [feature.id, feature.label]),
) as Record<FeatureId, string>;
