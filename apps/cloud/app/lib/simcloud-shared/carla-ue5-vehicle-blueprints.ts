/**
 * Spawn-verified vehicle blueprints exposed by the SimForge CARLA UE5 image.
 *
 * Keep this list aligned with scripts/agent/fixtures/ue5-catalog/ue5-actor-catalog.json.
 * Scenario authoring and transfer must persist these runtime-native ids rather
 * than relying on worker-side UE4 compatibility substitution.
 */
export const CARLA_UE5_VEHICLE_BLUEPRINTS = [
  "vehicle.taxi.ford",
  "vehicle.carlacola.actors",
  "vehicle.firetruck.actors",
  "vehicle.fuso.mitsubishi",
  "vehicle.sprinter.mercedes",
  "vehicle.nissan.patrol",
  "vehicle.ambulance.ford",
  "vehicle.dodgecop.charger",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.lincoln.mkz",
  // Two-wheelers (BACKLOG #38, 2026-07-29). Absent from the 11-vehicle
  // `0.10.0_22.06_v3` image, present and spawn-probed on the maps image
  // `carla-rr-maps:0.10.0-prod-worker`. Until that image is the only one in
  // service, a bike id reaching an older runtime FAILS CLOSED at the worker's
  // approved-substitution gate rather than rendering a car — see the class
  // note on PREFIX_LEGACY_BLUEPRINT_MAPPINGS below.
  "vehicle.bh.crossbike",
  "vehicle.diamondback.century",
  "vehicle.gazelle.omafiets",
  "vehicle.harley.lowrider",
  "vehicle.kawasaki.ninja",
  "vehicle.vespa.zx125",
  "vehicle.yamaha.yzf",
] as const;

export type CarlaUe5VehicleBlueprint = (typeof CARLA_UE5_VEHICLE_BLUEPRINTS)[number];

export const CARLA_UE5_VEHICLE_BLUEPRINT_METADATA: Readonly<
  Record<CarlaUe5VehicleBlueprint, { label: string; preview_image: string }>
> = {
  "vehicle.taxi.ford": {
    label: "Ford Taxi",
    preview_image: "/scenario-editor/vehicles/ford-crown-simforge.png",
  },
  "vehicle.carlacola.actors": {
    label: "Carlacola Truck",
    preview_image: "/scenario-editor/vehicles/carlamotors-carlacola-simforge.png",
  },
  "vehicle.firetruck.actors": {
    label: "Firetruck",
    preview_image: "/scenario-editor/vehicles/carlamotors-firetruck-simforge.png",
  },
  "vehicle.fuso.mitsubishi": {
    label: "Mitsubishi Fuso",
    preview_image: "/scenario-editor/vehicles/mitsubishi-fusorosa-simforge.png",
  },
  "vehicle.sprinter.mercedes": {
    label: "Mercedes Sprinter",
    preview_image: "/scenario-editor/vehicles/mercedes-sprinter-simforge.png",
  },
  "vehicle.nissan.patrol": {
    label: "Nissan Patrol",
    preview_image: "/scenario-editor/vehicles/nissan-patrol-simforge.png",
  },
  "vehicle.ambulance.ford": {
    label: "Ford Ambulance",
    preview_image: "/scenario-editor/vehicles/ford-ambulance-simforge.png",
  },
  "vehicle.dodgecop.charger": {
    label: "Dodge Charger Police",
    preview_image: "/scenario-editor/vehicles/dodge-charger-police-simforge.png",
  },
  "vehicle.dodge.charger": {
    label: "Dodge Charger",
    preview_image: "/scenario-editor/vehicles/dodge-charger-2020-simforge.png",
  },
  "vehicle.mini.cooper": {
    label: "Mini Cooper",
    preview_image: "/scenario-editor/vehicles/mini-cooper-s-simforge.png",
  },
  "vehicle.lincoln.mkz": {
    label: "Lincoln MKZ",
    preview_image: "/scenario-editor/vehicles/lincoln-mkz-2020-simforge.png",
  },
  "vehicle.bh.crossbike": {
    label: "BH Crossbike",
    preview_image: "/scenario-editor/vehicles/bh-crossbike-simforge.png",
  },
  "vehicle.diamondback.century": {
    label: "Diamondback Century",
    preview_image: "/scenario-editor/vehicles/diamondback-century-simforge.png",
  },
  "vehicle.gazelle.omafiets": {
    label: "Gazelle Omafiets",
    preview_image: "/scenario-editor/vehicles/gazelle-omafiets-simforge.png",
  },
  "vehicle.harley.lowrider": {
    label: "Harley-Davidson Low Rider",
    preview_image: "/scenario-editor/vehicles/harley-davidson-low-rider-simforge.png",
  },
  "vehicle.kawasaki.ninja": {
    label: "Kawasaki Ninja",
    preview_image: "/scenario-editor/vehicles/kawasaki-ninja-simforge.png",
  },
  "vehicle.vespa.zx125": {
    label: "Vespa ZX 125",
    preview_image: "/scenario-editor/vehicles/vespa-zx125-simforge.png",
  },
  "vehicle.yamaha.yzf": {
    label: "Yamaha YZF",
    preview_image: "/scenario-editor/vehicles/yamaha-yzf-simforge.png",
  },
};

export const CARLA_UE5_STREET_VEHICLE_BLUEPRINTS = [
  "vehicle.lincoln.mkz",
  "vehicle.dodge.charger",
  "vehicle.mini.cooper",
  "vehicle.nissan.patrol",
  "vehicle.taxi.ford",
] as const satisfies readonly CarlaUe5VehicleBlueprint[];

export const CARLA_UE5_HEAVY_VEHICLE_BLUEPRINTS = [
  "vehicle.fuso.mitsubishi",
  "vehicle.carlacola.actors",
  "vehicle.firetruck.actors",
  "vehicle.sprinter.mercedes",
] as const satisfies readonly CarlaUe5VehicleBlueprint[];

/**
 * Pedal cycles. These are VRUs, so they are deliberately NOT in
 * `CARLA_UE5_STREET_VEHICLE_BLUEPRINTS`: ambient traffic draws from the street
 * pool, and a cyclist is a conflict subject a scenario places on purpose, not
 * background filler.
 */
export const CARLA_UE5_BICYCLE_BLUEPRINTS = [
  "vehicle.bh.crossbike",
  "vehicle.diamondback.century",
  "vehicle.gazelle.omafiets",
] as const satisfies readonly CarlaUe5VehicleBlueprint[];

/** Powered two-wheelers. Also VRUs, also excluded from the ambient street pool. */
export const CARLA_UE5_MOTORCYCLE_BLUEPRINTS = [
  "vehicle.harley.lowrider",
  "vehicle.kawasaki.ninja",
  "vehicle.vespa.zx125",
  "vehicle.yamaha.yzf",
] as const satisfies readonly CarlaUe5VehicleBlueprint[];

const UE5_TWO_WHEELER_SET = new Set<string>([
  ...CARLA_UE5_BICYCLE_BLUEPRINTS,
  ...CARLA_UE5_MOTORCYCLE_BLUEPRINTS,
]);

/** True for pedal cycles and powered two-wheelers alike. */
export function isCarlaUe5TwoWheeler(blueprint: string): boolean {
  return UE5_TWO_WHEELER_SET.has(blueprint);
}

const UE5_VEHICLE_SET = new Set<string>(CARLA_UE5_VEHICLE_BLUEPRINTS);

const EXACT_LEGACY_BLUEPRINT_MAPPINGS: Readonly<Record<string, CarlaUe5VehicleBlueprint>> = {
  "vehicle.carlamotors.carlacola": "vehicle.carlacola.actors",
  "vehicle.carlamotors.european_hgv": "vehicle.firetruck.actors",
  "vehicle.carlamotors.firetruck": "vehicle.firetruck.actors",
  "vehicle.ford.ambulance": "vehicle.ambulance.ford",
  "vehicle.mercedes.sprinter": "vehicle.sprinter.mercedes",
  "vehicle.mitsubishi.fusorosa": "vehicle.fuso.mitsubishi",
  "vehicle.dodge.charger_police": "vehicle.dodgecop.charger",
  "vehicle.dodge.charger_police_2020": "vehicle.dodgecop.charger",
  "vehicle.jeep.wrangler_rubicon": "vehicle.nissan.patrol",
  "vehicle.nissan.patrol_2021": "vehicle.nissan.patrol",
  "vehicle.tesla.cybertruck": "vehicle.nissan.patrol",
};

const PREFIX_LEGACY_BLUEPRINT_MAPPINGS: ReadonlyArray<
  readonly [prefix: string, replacement: CarlaUe5VehicleBlueprint]
> = [
  ["vehicle.carlamotors.", "vehicle.carlacola.actors"],
  ["vehicle.mitsubishi.", "vehicle.fuso.mitsubishi"],
  ["vehicle.volkswagen.", "vehicle.sprinter.mercedes"],
  ["vehicle.mercedes.", "vehicle.sprinter.mercedes"],
  ["vehicle.jeep.", "vehicle.nissan.patrol"],
  ["vehicle.tesla.cybertruck", "vehicle.nissan.patrol"],
  ["vehicle.nissan.", "vehicle.nissan.patrol"],
  ["vehicle.dodge.charger_police", "vehicle.dodgecop.charger"],
  ["vehicle.dodge.", "vehicle.dodge.charger"],
  ["vehicle.ford.ambulance", "vehicle.ambulance.ford"],
  ["vehicle.ford.", "vehicle.taxi.ford"],
  ["vehicle.mini.", "vehicle.mini.cooper"],
  ["vehicle.micro.", "vehicle.mini.cooper"],
  // Two-wheelers map WITHIN their class. Before the maps image these all
  // resolved to `vehicle.mini.cooper`, which is not a model swap but a class
  // change: it turned a 0.86 m-wide VRU into a 1.93 m-wide car, silently
  // invalidating every clearance, occlusion and conflict-geometry calculation
  // downstream — and quietly deleting the VRU from a VRU scenario.
  ["vehicle.bh.", "vehicle.bh.crossbike"],
  ["vehicle.diamondback.", "vehicle.diamondback.century"],
  ["vehicle.gazelle.", "vehicle.gazelle.omafiets"],
  ["vehicle.harley-davidson.", "vehicle.harley.lowrider"],
  ["vehicle.harley.", "vehicle.harley.lowrider"],
  ["vehicle.kawasaki.", "vehicle.kawasaki.ninja"],
  ["vehicle.vespa.", "vehicle.vespa.zx125"],
  ["vehicle.yamaha.", "vehicle.yamaha.yzf"],
  ["vehicle.lincoln.", "vehicle.lincoln.mkz"],
  ["vehicle.audi.", "vehicle.lincoln.mkz"],
  ["vehicle.bmw.", "vehicle.lincoln.mkz"],
  ["vehicle.chevrolet.", "vehicle.lincoln.mkz"],
  ["vehicle.citroen.", "vehicle.mini.cooper"],
  ["vehicle.seat.", "vehicle.mini.cooper"],
  ["vehicle.tesla.", "vehicle.lincoln.mkz"],
  ["vehicle.toyota.", "vehicle.lincoln.mkz"],
];

export function isCarlaUe5VehicleBlueprint(
  blueprint: string,
): blueprint is CarlaUe5VehicleBlueprint {
  return UE5_VEHICLE_SET.has(blueprint);
}

/** Map any historical CARLA vehicle id to a runtime-native UE5 id. */
export function toCarlaUe5VehicleBlueprint(blueprint: string): CarlaUe5VehicleBlueprint {
  if (isCarlaUe5VehicleBlueprint(blueprint)) return blueprint;
  const exact = EXACT_LEGACY_BLUEPRINT_MAPPINGS[blueprint];
  if (exact) return exact;
  for (const [prefix, replacement] of PREFIX_LEGACY_BLUEPRINT_MAPPINGS) {
    if (blueprint.startsWith(prefix)) return replacement;
  }
  return "vehicle.lincoln.mkz";
}
