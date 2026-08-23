import { z } from "zod";

import {
  CARLA_UE5_VEHICLE_BLUEPRINT_METADATA,
  CARLA_UE5_VEHICLE_BLUEPRINTS,
} from "./carla-ue5-vehicle-blueprints";

const CatalogS3ObjectSchema = z.object({
  bucket: z.string().min(1),
  key: z.string().min(1),
  uri: z.string().min(1).optional(),
  sha256: z.string().min(1).optional(),
  size_bytes: z.number().int().nonnegative().optional(),
});

const RuntimeStreetFurniturePointSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  yaw: z.number(),
});

export const RuntimeStreetFurnitureSchema = z.object({
  poles: z.array(RuntimeStreetFurniturePointSchema.extend({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
  }).passthrough()).default([]),
  traffic_lights: z.array(RuntimeStreetFurniturePointSchema.extend({
    actor_id: z.number().optional(),
    type_id: z.string().optional(),
    pole_index: z.number().nullable().optional(),
    opendrive_id: z.string().nullable().optional(),
    stop_waypoints: z.array(RuntimeStreetFurniturePointSchema).optional(),
  }).passthrough()).default([]),
});
export type RuntimeStreetFurnitureContract = z.infer<typeof RuntimeStreetFurnitureSchema>;

export const CarlaActorBlueprintGeometrySchema = z.object({
  length_m: z.number().positive(),
  width_m: z.number().positive(),
  height_m: z.number().positive(),
  runtime_family: z.enum(["carla_ue4", "carla_ue5"]),
  geometry_revision: z.string().min(1),
}).strict();

const CarlaActorBlueprintSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  preview_image: z.string().min(1).optional(),
  tags: z.array(z.string()).default([]),
  attributes: z.record(z.unknown()).default({}),
  geometry: CarlaActorBlueprintGeometrySchema.optional(),
});

export const CarlaActorCatalogSchema = z.object({
  schema_version: z.literal(1),
  catalog_version: z.string().min(1),
  generated_at: z.string().min(1),
  source: z.object({
    carla_version: z.string().nullable(),
    image: z.string().nullable(),
    image_digest: z.string().nullable(),
  }),
  hash: z.string().min(1).optional(),
  defaults: z.object({
    // UE5 keeps a runtime-specific catalog because CARLA 0.10 exposes a
    // different blueprint set than the UE4 image. vehicle is nullable so
    // catalog materialization can represent partial inspection failures.
    vehicle: z.string().min(1).nullable(),
    walker: z.string().min(1),
  }),
  // Keep min(0) for vehicles so a failed/partial actor-catalog scrape is still
  // representable; walkers must always be present because the editor needs a
  // default pedestrian blueprint.
  vehicles: z.array(CarlaActorBlueprintSchema).min(0),
  walkers: z.array(CarlaActorBlueprintSchema).min(1),
});
export type CarlaActorCatalog = z.infer<typeof CarlaActorCatalogSchema>;

export const DEFAULT_CARLA_VEHICLE_BLUEPRINTS = CARLA_UE5_VEHICLE_BLUEPRINTS;

const PEDESTRIAN_PREVIEW_IMAGE_BASE = "/scenario-editor/pedestrians";

type CarlaPedestrianBlueprintMetadata = {
  id: `walker.pedestrian.${string}`;
  label: string;
  age: "adult" | "child" | "teenager";
  gender: "female" | "male";
  generation: number;
  canUseWheelchair: boolean;
  walkSpeedMps: number;
  runSpeedMps: number;
  previewExtension?: "webp" | "png" | null;
  tags?: string[];
};

const CARLA_PEDESTRIAN_BLUEPRINT_METADATA: readonly CarlaPedestrianBlueprintMetadata[] = [
  { id: "walker.pedestrian.0001", label: "Adult pedestrian 1 - variant 1", age: "adult", gender: "female", generation: 1, canUseWheelchair: true, walkSpeedMps: 1.8, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0002", label: "Adult pedestrian 2 - variant 3", age: "adult", gender: "male", generation: 1, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0003", label: "Adult pedestrian 2 - variant 2", age: "adult", gender: "male", generation: 1, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0004", label: "Adult pedestrian 2 - variant 1", age: "adult", gender: "male", generation: 1, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0005", label: "Adult pedestrian 1 - variant 2", age: "adult", gender: "female", generation: 1, canUseWheelchair: true, walkSpeedMps: 1.8, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0006", label: "Adult pedestrian 1 - variant 3", age: "adult", gender: "female", generation: 1, canUseWheelchair: true, walkSpeedMps: 1.8, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0007", label: "Adult pedestrian 1 - variant 4", age: "adult", gender: "female", generation: 1, canUseWheelchair: true, walkSpeedMps: 1.8, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0008", label: "Adult pedestrian 1 - variant 5", age: "adult", gender: "female", generation: 1, canUseWheelchair: true, walkSpeedMps: 1.8, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0009", label: "Child pedestrian 1 - variant 3", age: "child", gender: "female", generation: 1, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0 },
  { id: "walker.pedestrian.0010", label: "Child pedestrian 1 - variant 2", age: "child", gender: "female", generation: 1, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0 },
  { id: "walker.pedestrian.0011", label: "Child pedestrian 1 - variant 1", age: "child", gender: "female", generation: 1, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0 },
  { id: "walker.pedestrian.0012", label: "Child pedestrian 2 - variant 3", age: "child", gender: "male", generation: 1, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0 },
  { id: "walker.pedestrian.0013", label: "Child pedestrian 2 - variant 2", age: "child", gender: "male", generation: 1, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0 },
  { id: "walker.pedestrian.0014", label: "Child pedestrian 2 - variant 1", age: "child", gender: "male", generation: 1, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0 },
  { id: "walker.pedestrian.0015", label: "Adult pedestrian 3 - variant 1", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.8, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0016", label: "Adult pedestrian 4 - variant 1", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0017", label: "Adult pedestrian 4 - variant 2", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0018", label: "Adult pedestrian 5 - variant 2", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0019", label: "Adult pedestrian 3 - variant 2", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0020", label: "Adult pedestrian 6 - variant 2", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0021", label: "Adult pedestrian 6 - variant 1", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0022", label: "Adult pedestrian 7 - variant 2", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0023", label: "Adult pedestrian 7 - variant 1", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0024", label: "Adult pedestrian 8 - variant 1", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0025", label: "Adult pedestrian 8 - variant 2", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0026", label: "Adult pedestrian 5 - variant 1", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0027", label: "Adult pedestrian 9 - variant 1", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0028", label: "Adult pedestrian 9 - variant 3", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0029", label: "Adult pedestrian 9 - variant 2", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0030", label: "Police 1", age: "adult", gender: "male", generation: 2, canUseWheelchair: false, walkSpeedMps: 1.7, runSpeedMps: 4.0, tags: ["police"] },
  { id: "walker.pedestrian.0031", label: "Adult pedestrian 10 - variant 4", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0032", label: "Police 2", age: "adult", gender: "female", generation: 2, canUseWheelchair: false, walkSpeedMps: 1.7, runSpeedMps: 4.0, tags: ["police"] },
  { id: "walker.pedestrian.0033", label: "Adult pedestrian 10 - variant 3", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0034", label: "Adult pedestrian 11 - variant 1", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0035", label: "Adult pedestrian 12 - variant 1", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0036", label: "Adult pedestrian 12 - variant 2", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0037", label: "Adult pedestrian 12 - variant 3", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0038", label: "Adult pedestrian 11 - variant 2", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0039", label: "Adult pedestrian 13 - variant 1", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0040", label: "Adult pedestrian 10 - variant 2", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0041", label: "Adult pedestrian 10 - variant 1", age: "adult", gender: "female", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0042", label: "Adult pedestrian 14 - variant 1", age: "adult", gender: "female", generation: 2, canUseWheelchair: false, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0043", label: "Adult pedestrian 14 - variant 2", age: "adult", gender: "female", generation: 2, canUseWheelchair: false, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0044", label: "Adult pedestrian 14 - variant 3", age: "adult", gender: "female", generation: 2, canUseWheelchair: false, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0045", label: "Adult pedestrian 0045", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0046", label: "Adult pedestrian 15 - variant 2", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0047", label: "Adult pedestrian 15 - variant 1", age: "adult", gender: "male", generation: 2, canUseWheelchair: true, walkSpeedMps: 1.7, runSpeedMps: 4.0 },
  { id: "walker.pedestrian.0048", label: "Child pedestrian 3 - variant 1", age: "child", gender: "female", generation: 2, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0 },
  { id: "walker.pedestrian.0049", label: "Child pedestrian 4 - variant 1", age: "child", gender: "female", generation: 2, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0 },
  { id: "walker.pedestrian.0050", label: "Teen pedestrian 1", age: "teenager", gender: "female", generation: 3, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0, previewExtension: "png" },
  { id: "walker.pedestrian.0051", label: "Teen pedestrian 2", age: "teenager", gender: "male", generation: 3, canUseWheelchair: false, walkSpeedMps: 1.1, runSpeedMps: 2.0, previewExtension: "png" },
  { id: "walker.pedestrian.0052", label: "Adult pedestrian 0052", age: "adult", gender: "male", generation: 3, canUseWheelchair: false, walkSpeedMps: 1.7, runSpeedMps: 4.0, previewExtension: null },
];

function pedestrianPreviewImage(id: string, extension: "webp" | "png" | null): string | undefined {
  if (extension == null) return undefined;
  const suffix = id.split(".").at(-1);
  if (!suffix) return undefined;
  return `${PEDESTRIAN_PREVIEW_IMAGE_BASE}/pedestrian-${suffix}.${extension}`;
}

export const CARLA_PEDESTRIAN_BLUEPRINTS = CARLA_PEDESTRIAN_BLUEPRINT_METADATA.map((item) => {
  const previewExtension = item.previewExtension === undefined ? "webp" : item.previewExtension;
  const previewImage = pedestrianPreviewImage(item.id, previewExtension);
  return {
    id: item.id,
    label: item.label,
    ...(previewImage ? { preview_image: previewImage } : {}),
    tags: [
      item.age,
      item.gender,
      `generation-${item.generation}`,
      ...(item.canUseWheelchair ? ["wheelchair-compatible"] : []),
      ...(item.tags ?? []),
    ],
    attributes: {
      age: item.age,
      gender: item.gender,
      generation: item.generation,
      can_use_wheelchair: item.canUseWheelchair,
      walk_speed_mps: item.walkSpeedMps,
      run_speed_mps: item.runSpeedMps,
    },
  };
}) satisfies z.infer<typeof CarlaActorBlueprintSchema>[];

export const DEFAULT_CARLA_WALKER_BLUEPRINTS = CARLA_PEDESTRIAN_BLUEPRINTS.map(
  (blueprint) => blueprint.id,
);

export const DEFAULT_CARLA_ACTOR_CATALOG: CarlaActorCatalog = {
  schema_version: 1,
  catalog_version: "carla-0.10.0-default",
  generated_at: "1970-01-01T00:00:00.000Z",
  source: {
    carla_version: "0.10.0",
    image: "ghcr.io/simforgeinc/carla-rr-maps@sha256:9cbd72bf3074904e315df7a51cde16c6815886ef98457abcd17d0202bd81161f",
    image_digest: "sha256:9cbd72bf3074904e315df7a51cde16c6815886ef98457abcd17d0202bd81161f",
  },
  defaults: {
    vehicle: "vehicle.taxi.ford",
    walker: "walker.pedestrian.0001",
  },
  vehicles: DEFAULT_CARLA_VEHICLE_BLUEPRINTS.map((id) => ({
    id,
    ...CARLA_UE5_VEHICLE_BLUEPRINT_METADATA[id],
    tags: id.split("."),
    attributes: {},
  })),
  walkers: CARLA_PEDESTRIAN_BLUEPRINTS.map((blueprint) => ({
    ...blueprint,
    tags: [...blueprint.tags],
    attributes: { ...blueprint.attributes },
  })),
};

export const DEFAULT_CARLA_ACTOR_BLUEPRINTS = {
  vehicles: [...DEFAULT_CARLA_VEHICLE_BLUEPRINTS],
  walkers: [...DEFAULT_CARLA_WALKER_BLUEPRINTS],
};

export const RuntimeCatalogMapSchema = z.object({
  map_asset_id: z.string().nullable(),
  name: z.string().min(1),
  carla_map_name: z.string().min(1),
  dataset_map: z.boolean().default(true),
  bundle_ready: z.boolean(),
  bundle_key: z.string().nullable(),
  bundle: CatalogS3ObjectSchema.nullable().optional(),
  drift: z.array(z.string()).default([]),
  auto_created: z.boolean().default(false),
});
export type RuntimeCatalogMap = z.infer<typeof RuntimeCatalogMapSchema>;

export const CarlaRuntimeCatalogSchema = z.object({
  schema_version: z.literal(1),
  catalog_version: z.string().min(1),
  bundle_version: z.string().min(1),
  actor_catalog_version: z.string().min(1),
  generated_at: z.string().min(1),
  source: z.object({
    carla_version: z.string().nullable(),
    image: z.string().nullable(),
    image_digest: z.string().nullable(),
  }),
  maps: z.array(RuntimeCatalogMapSchema),
  drift: z.object({
    missing_map_assets: z.array(z.string()).default([]),
    missing_bundles: z.array(z.string()).default([]),
    stale_bundles: z.array(z.string()).default([]),
    duplicate_carla_map_names: z.array(z.string()).default([]),
  }),
});
export type CarlaRuntimeCatalog = z.infer<typeof CarlaRuntimeCatalogSchema>;
