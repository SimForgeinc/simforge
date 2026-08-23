import {
  AUTHORING_CATALOG,
  getEntry,
  type CatalogEntry,
  type CatalogId,
} from "@uniscenarios/prop-catalog";
import type { CarlaObjectDto } from "@/app/lib/uniscenario/carla-objects";

/**
 * The author-facing model behind the add-actor panel: which classes exist, how
 * models are grouped into browsable categories, and how a query narrows them.
 * Presentation lives in `ActorLibraryRail`.
 */

export type ViewportTool = "search" | "vehicles" | "two-wheelers" | "pedestrians" | "sidewalk-robots" | "humanoid-robots" | "drones" | "animals" | "objects" | "gallery" | "weather" | "traffic" | "parked";
/** Tools that browse the bundled model catalog. Search and scene tools are not among them. */
export type CatalogTool = Exclude<ViewportTool, "search" | "gallery" | "weather" | "traffic" | "parked">;
export type CatalogFilter = "all" | "vehicle" | "pedestrian" | "sidewalk_robot" | "drone" | "animal" | "prop" | "favorite" | "recent";

export interface ActorCatalogSection {
  id: string;
  label: string;
  entries: CatalogEntry[];
}

export interface ActorCatalogSectionDefinition {
  id: string;
  label: string;
  catalogIds: readonly CatalogId[];
}

export const MAX_CATALOG_RECENTS = 8;

// The runtime asset catalog binds the walking/standing pedestrian variants but
// not the legacy pedestrian.adult/pedestrian.child ids, so scenarios authored
// with the legacy ids export cleanly and then fail to spawn in CARLA. Until an
// asset-catalog release binds the legacy ids, author the runtime-bound
// variants under presentation labels of our own.
const RUNTIME_BOUND_PEDESTRIAN_SWAPS = [
  ["pedestrian.adult_walking", "Adult walking"],
  ["pedestrian.adult_standing", "Adult standing"],
  ["pedestrian.child_walking", "Child walking"],
  ["pedestrian.child_standing", "Child standing"],
] as const;

/** Everything the panel offers before CARLA's optional catalog is merged in. */
export const ACTOR_LIBRARY_CATALOG: readonly CatalogEntry[] = [
  ...AUTHORING_CATALOG.filter(
    (entry) => entry.id !== "pedestrian.adult" && entry.id !== "pedestrian.child",
  ),
  ...RUNTIME_BOUND_PEDESTRIAN_SWAPS.map(([id, label]) => ({
    ...getEntry(id),
    label,
    description: label,
  })),
];

/** Real vehicle models exposed as one-click parked/static objects. */
export const STATIC_CAR_CATALOG_IDS = [
  "vehicle.sedan",
  "vehicle.hatchback",
  "vehicle.suv",
  "vehicle.pickup",
  "vehicle.minivan",
  "vehicle.van",
] as const satisfies readonly CatalogId[];

export function isStaticCarCatalogId(id: CatalogId): boolean {
  return (STATIC_CAR_CATALOG_IDS as readonly CatalogId[]).includes(id);
}

/**
 * The catalog taxonomy is intentionally hand-authored. Actor classes describe
 * runtime behavior; these sections describe how scenario authors look for an
 * actor in the library.
 */
export const ACTOR_CATALOG_SECTIONS: Readonly<Record<CatalogTool, readonly ActorCatalogSectionDefinition[]>> = {
  vehicles: [
    { id: "emergency-response", label: "Emergency response", catalogIds: ["vehicle.ambulance", "vehicle.police_cruiser", "vehicle.police_suv", "vehicle.fire_command_suv", "vehicle.fire_engine"] },
    { id: "everyday-cars", label: "Everyday cars", catalogIds: ["vehicle.sedan", "vehicle.hatchback", "vehicle.suv", "vehicle.pickup", "vehicle.honda_civic", "vehicle.toyota_camry", "vehicle.tesla_model_3", "vehicle.jeep_wrangler", "vehicle.minivan"] },
    { id: "sports-iconic", label: "Sports & iconic", catalogIds: ["vehicle.ford_mustang", "vehicle.chevrolet_corvette", "vehicle.porsche_911"] },
    { id: "public-transport", label: "Public transport", catalogIds: ["vehicle.bus", "vehicle.school_bus", "vehicle.shuttle_bus", "vehicle.tram"] },
    { id: "commercial-delivery", label: "Commercial & delivery", catalogIds: ["vehicle.van", "vehicle.delivery_van", "vehicle.box_truck", "vehicle.taxi"] },
    { id: "heavy-construction", label: "Heavy & construction", catalogIds: ["vehicle.semi_truck", "vehicle.dump_truck", "vehicle.garbage_truck", "vehicle.tow_truck", "vehicle.cement_mixer", "vehicle.utility_bucket_truck", "vehicle.tanker_truck", "vehicle.flatbed_truck"] },
  ],
  "two-wheelers": [
    { id: "motorcycles", label: "Motorcycles", catalogIds: ["vehicle.motorcycle"] },
    { id: "cycling", label: "Cycling", catalogIds: ["vehicle.bicycle"] },
    { id: "personal-mobility", label: "Personal mobility", catalogIds: ["vehicle.mobility_scooter"] },
  ],
  pedestrians: [
    // The legacy pedestrian.adult/pedestrian.child entries have no runtime
    // (CARLA) binding in the asset catalog, so scenarios authored with them
    // export fine but fail to spawn; offer the runtime-bound variants instead.
    { id: "adults", label: "Adults", catalogIds: ["pedestrian.adult_walking", "pedestrian.adult_standing"] },
    { id: "children", label: "Children", catalogIds: ["pedestrian.child_walking", "pedestrian.child_standing"] },
    { id: "traffic-work-crews", label: "Traffic & work crews", catalogIds: ["pedestrian.traffic_marshal"] },
  ],
  "sidewalk-robots": [
    { id: "delivery-robots", label: "Delivery robots", catalogIds: ["sidewalk_robot.delivery_rover", "sidewalk_robot.cooler_bot"] },
    { id: "legged-robots", label: "Legged robots", catalogIds: ["sidewalk_robot.quadruped_courier"] },
  ],
  "humanoid-robots": [
    { id: "general-service", label: "General & service", catalogIds: ["sidewalk_robot.humanoid_general_purpose", "sidewalk_robot.humanoid_public_safety"] },
    { id: "delivery-logistics", label: "Delivery & logistics", catalogIds: ["sidewalk_robot.humanoid_delivery", "sidewalk_robot.humanoid_warehouse"] },
    { id: "construction", label: "Construction", catalogIds: ["sidewalk_robot.humanoid_construction"] },
  ],
  drones: [
    { id: "delivery", label: "Delivery", catalogIds: ["drone.delivery_quadcopter"] },
    { id: "camera-inspection", label: "Camera & inspection", catalogIds: ["drone.camera_quadcopter"] },
    { id: "emergency-response", label: "Emergency response", catalogIds: ["drone.emergency_responder"] },
  ],
  animals: [
    { id: "domestic-animals", label: "Domestic animals", catalogIds: ["animal.dog", "animal.cat"] },
    { id: "wildlife", label: "Wildlife", catalogIds: ["animal.deer", "animal.raccoon"] },
    { id: "birds", label: "Birds", catalogIds: ["animal.goose"] },
  ],
  objects: [
    { id: "static-cars", label: "Static cars", catalogIds: STATIC_CAR_CATALOG_IDS },
    { id: "construction-control", label: "Construction control", catalogIds: ["construction.traffic_cone", "construction.channelizer_drum", "construction.barricade_type3", "construction.pedestrian_barrier", "construction.jersey_barrier", "construction.jersey_barrier_run", "construction.sign_road_work", "construction.flagger", "construction.arrow_board", "construction.temporary_stop_sign", "construction.portable_signal"] },
    { id: "worksite-equipment", label: "Worksite equipment", catalogIds: ["construction.excavator", "construction.portable_toilet", "construction.spoil_pile", "construction.long_pipe"] },
    { id: "visibility-occluders", label: "Visibility & occluders", catalogIds: ["occluder.dumpster", "occluder.covered_car", "occluder.hedge_run", "occluder.fence_run"] },
    { id: "street-furniture", label: "Street furniture", catalogIds: ["street.mailbox_cluster", "street.bus_shelter", "street.food_cart", "street.shopping_cart"] },
    { id: "road-hazards", label: "Road hazards", catalogIds: ["hazard.tire_debris", "hazard.cardboard_box", "hazard.trash_bags", "hazard.downed_branch"] },
  ],
};

export function filterActorCatalog(
  entries: readonly CatalogEntry[],
  filter: CatalogFilter,
  query: string,
  favorites: ReadonlySet<string>,
  recents: readonly string[],
): CatalogEntry[] {
  const needle = query.trim().toLowerCase();
  const recentRank = new Map(recents.map((id, index) => [id, index]));
  return entries
    .filter((entry) => {
      if (filter === "vehicle" && entry.class !== "vehicle") return false;
      if (filter === "pedestrian" && entry.class !== "pedestrian") return false;
      if (filter === "sidewalk_robot" && entry.class !== "sidewalk_robot") return false;
      if (filter === "drone" && entry.class !== "drone") return false;
      if (filter === "animal" && entry.class !== "animal") return false;
      if (filter === "prop" && (entry.class === "vehicle" || entry.class === "pedestrian")) return false;
      if (filter === "favorite" && !favorites.has(entry.id)) return false;
      if (filter === "recent" && !recentRank.has(entry.id)) return false;
      if (!needle) return true;
      return `${entry.label} ${entry.id} ${entry.description} ${entry.class} ${entry.tags.join(" ")}`
        .toLowerCase()
        .includes(needle);
    })
    .sort((a, b) => {
      if (filter === "recent") {
        return (recentRank.get(a.id) ?? Infinity) - (recentRank.get(b.id) ?? Infinity);
      }
      return a.label.localeCompare(b.label);
    });
}

export function pushActorCatalogRecent(recents: readonly string[], id: string): string[] {
  return [id, ...recents.filter((item) => item !== id)].slice(0, MAX_CATALOG_RECENTS);
}

export function isTwoWheelerCatalogEntry(entry: CatalogEntry): boolean {
  return entry.class === "vehicle" && entry.tags.includes("vru");
}

export function isHumanoidRobotCatalogEntry(entry: CatalogEntry): boolean {
  return entry.class === "sidewalk_robot" && entry.animation?.rig === "humanoid";
}

export function pickRandomCar(
  entries: readonly CatalogEntry[],
  random: () => number = Math.random,
): CatalogEntry | null {
  const cars = entries.filter((entry) => entry.class === "vehicle" && !isTwoWheelerCatalogEntry(entry));
  if (!cars.length) return null;
  const index = Math.min(cars.length - 1, Math.floor(random() * cars.length));
  return cars[index] ?? null;
}

export function catalogEntryMatchesTool(entry: CatalogEntry, tool: ViewportTool | null): boolean {
  const carlaEntry = entry.id.startsWith("carla.");
  if (tool === "vehicles") return entry.class === "vehicle" && (carlaEntry || !isTwoWheelerCatalogEntry(entry));
  if (tool === "two-wheelers") return !carlaEntry && isTwoWheelerCatalogEntry(entry);
  if (tool === "pedestrians") return entry.class === "pedestrian";
  if (tool === "sidewalk-robots") return entry.class === "sidewalk_robot" && !isHumanoidRobotCatalogEntry(entry);
  if (tool === "humanoid-robots") return isHumanoidRobotCatalogEntry(entry);
  if (tool === "drones") return entry.class === "drone";
  if (tool === "animals") return entry.class === "animal";
  if (tool === "objects")
    return (
      isStaticCarCatalogId(entry.id as CatalogId) ||
      !["vehicle", "pedestrian", "sidewalk_robot", "drone", "animal"].includes(entry.class)
    );
  return false;
}

type MutableCatalogSectionDefinition = Omit<ActorCatalogSectionDefinition, "catalogIds"> & {
  catalogIds: CatalogId[];
};

/**
 * CARLA actors use the same author-facing taxonomy as bundled actors. Vehicles
 * are classified by operational use before size; pedestrian labels carry the
 * measured age group; non-actors map directly from their prop class.
 */
export function mergeCarlaCatalogSections(
  objects: readonly CarlaObjectDto[],
): Record<CatalogTool, readonly ActorCatalogSectionDefinition[]> {
  const merged: Record<CatalogTool, MutableCatalogSectionDefinition[]> = {
    vehicles: ACTOR_CATALOG_SECTIONS.vehicles.map(copyCatalogSection),
    "two-wheelers": ACTOR_CATALOG_SECTIONS["two-wheelers"].map(copyCatalogSection),
    pedestrians: ACTOR_CATALOG_SECTIONS.pedestrians.map(copyCatalogSection),
    "sidewalk-robots": ACTOR_CATALOG_SECTIONS["sidewalk-robots"].map(copyCatalogSection),
    "humanoid-robots": ACTOR_CATALOG_SECTIONS["humanoid-robots"].map(copyCatalogSection),
    drones: ACTOR_CATALOG_SECTIONS.drones.map(copyCatalogSection),
    animals: ACTOR_CATALOG_SECTIONS.animals.map(copyCatalogSection),
    objects: ACTOR_CATALOG_SECTIONS.objects.map(copyCatalogSection),
  };

  for (const object of objects) {
    let tool: CatalogTool;
    let sectionId: string;
    if (object.class === "vehicle") {
      tool = "vehicles";
      sectionId = object.tags.includes("emergency")
        ? "emergency-response"
        : object.dims.l >= 7.5
          ? "heavy-construction"
          : object.tags.some((tag) => tag === "commercial" || tag === "delivery") || object.actorClass === "van"
            ? "commercial-delivery"
            : "everyday-cars";
    } else if (object.class === "pedestrian") {
      tool = "pedestrians";
      sectionId = /\b(child|teenager)\b/i.test(object.label) ? "children" : "adults";
    } else {
      tool = "objects";
      sectionId = object.class === "construction"
        ? "construction-control"
        : object.class === "occluder"
          ? "visibility-occluders"
          : object.class === "street"
            ? "street-furniture"
            : "road-hazards";
    }
    const section = merged[tool].find((candidate) => candidate.id === sectionId);
    if (section) section.catalogIds.push(object.catalogId as CatalogId);
  }
  return merged;
}

function copyCatalogSection(
  definition: ActorCatalogSectionDefinition,
): MutableCatalogSectionDefinition {
  return { ...definition, catalogIds: [...definition.catalogIds] };
}

function compareBundledThenCarla(left: CatalogEntry, right: CatalogEntry): number {
  const leftIsCarla = left.id.startsWith("carla.");
  const rightIsCarla = right.id.startsWith("carla.");
  if (leftIsCarla !== rightIsCarla) return leftIsCarla ? 1 : -1;
  return left.label.localeCompare(right.label);
}

export function groupActorCatalog(
  entries: readonly CatalogEntry[],
  tool: CatalogTool,
  definitions: readonly ActorCatalogSectionDefinition[] = ACTOR_CATALOG_SECTIONS[tool],
): ActorCatalogSection[] {
  const visibleById = new Map(entries.map((entry) => [entry.id, entry]));
  const assigned = new Set<string>();
  const sections = definitions.map((definition) => {
    const sectionEntries = definition.catalogIds.flatMap((id) => {
      const entry = visibleById.get(id);
      if (!entry) return [];
      assigned.add(id);
      return [entry];
    });
    sectionEntries.sort(compareBundledThenCarla);
    return { id: definition.id, label: definition.label, entries: sectionEntries };
  }).filter((section) => section.entries.length > 0);

  const uncategorized = entries.filter((entry) => !assigned.has(entry.id));
  if (uncategorized.length) {
    sections.push({ id: "other", label: "Other", entries: uncategorized.sort(compareBundledThenCarla) });
  }
  return sections;
}
