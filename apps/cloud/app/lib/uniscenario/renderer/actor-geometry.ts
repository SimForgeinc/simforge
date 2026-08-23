/**
 * Display geometry for the renderer-neutral map preview.
 *
 * These dimensions describe catalog actors in metres. They are presentation
 * metadata only; OpenSCENARIO compilation and runtime physics remain owned by
 * the pinned UniScenarios release.
 */
export type VehicleCategory =
  | "car"
  | "van"
  | "truck"
  | "bus"
  | "bicycle"
  | "motorbike";

export type VehicleGeometry = {
  lengthM: number;
  widthM: number;
  heightM: number;
  category: VehicleCategory;
};

export const UE5_VEHICLE_GEOMETRY: Readonly<Record<string, VehicleGeometry>> = {
  "vehicle.lincoln.mkz": { lengthM: 4.93, widthM: 2.13, heightM: 1.48, category: "car" },
  "vehicle.dodge.charger": { lengthM: 5.02, widthM: 2.05, heightM: 1.48, category: "car" },
  "vehicle.dodgecop.charger": { lengthM: 5.02, widthM: 2.05, heightM: 1.55, category: "car" },
  "vehicle.mini.cooper": { lengthM: 3.82, widthM: 1.93, heightM: 1.41, category: "car" },
  "vehicle.nissan.patrol": { lengthM: 4.94, widthM: 2, heightM: 1.86, category: "car" },
  "vehicle.taxi.ford": { lengthM: 5.4, widthM: 2.02, heightM: 1.55, category: "car" },
  "vehicle.ambulance.ford": { lengthM: 6.1, widthM: 2.45, heightM: 2.6, category: "van" },
  "vehicle.sprinter.mercedes": { lengthM: 5.93, widthM: 2.02, heightM: 2.6, category: "van" },
  "vehicle.carlacola.actors": { lengthM: 6.6, widthM: 2.6, heightM: 3.1, category: "truck" },
  "vehicle.firetruck.actors": { lengthM: 8.4, widthM: 2.72, heightM: 3.3, category: "truck" },
  "vehicle.fuso.mitsubishi": { lengthM: 7.5, widthM: 2.35, heightM: 3, category: "bus" },
  "vehicle.bh.crossbike": { lengthM: 1.509, widthM: 0.866, heightM: 1.612, category: "bicycle" },
  "vehicle.diamondback.century": { lengthM: 1.656, widthM: 0.582, heightM: 1.62, category: "bicycle" },
  "vehicle.gazelle.omafiets": { lengthM: 1.843, widthM: 0.659, heightM: 1.776, category: "bicycle" },
  "vehicle.harley.lowrider": { lengthM: 2.35, widthM: 0.766, heightM: 1.649, category: "motorbike" },
  "vehicle.kawasaki.ninja": { lengthM: 2.044, widthM: 0.797, heightM: 1.523, category: "motorbike" },
  "vehicle.vespa.zx125": { lengthM: 1.817, widthM: 0.866, heightM: 1.59, category: "motorbike" },
  "vehicle.yamaha.yzf": { lengthM: 2.191, widthM: 0.866, heightM: 1.53, category: "motorbike" },
};

export const DEFAULT_VEHICLE_GEOMETRY: VehicleGeometry = {
  lengthM: 4.5,
  widthM: 2.1,
  heightM: 1.8,
  category: "car",
};
