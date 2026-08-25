import { describe, expect, it } from "vitest";

import {
  BlueprintSubstitutionRelaxationSchema,
  classifyCarlaBlueprint,
  planBlueprintSubstitutions,
  selectSubstituteBlueprint,
} from "../carla-blueprint-substitution";

const geometry = (lengthM: number, widthM: number, heightM = 1.6) => ({
  length_m: lengthM,
  width_m: widthM,
  height_m: heightM,
});

describe("classifyCarlaBlueprint", () => {
  it("classifies vehicles into transfer classes", () => {
    expect(classifyCarlaBlueprint("vehicle.tesla.model3")).toBe("car");
    expect(classifyCarlaBlueprint("vehicle.nissan.patrol")).toBe("car");
    expect(classifyCarlaBlueprint("vehicle.mercedes.sprinter")).toBe("van");
    expect(classifyCarlaBlueprint("vehicle.ambulance.ford")).toBe("van");
    expect(classifyCarlaBlueprint("vehicle.carlamotors.european_hgv")).toBe("truck");
    expect(classifyCarlaBlueprint("vehicle.tesla.cybertruck")).toBe("truck");
    expect(classifyCarlaBlueprint("vehicle.mitsubishi.fusorosa")).toBe("bus");
    expect(classifyCarlaBlueprint("vehicle.fuso.mitsubishi")).toBe("bus");
    expect(classifyCarlaBlueprint("vehicle.kawasaki.ninja")).toBe("motorcycle");
    expect(classifyCarlaBlueprint("vehicle.gazelle.omafiets")).toBe("bicycle");
    expect(classifyCarlaBlueprint("walker.pedestrian.0001")).toBe("walker");
  });

  it("returns null for props and unknown families", () => {
    expect(classifyCarlaBlueprint("static.prop.trafficcone01")).toBeNull();
    expect(classifyCarlaBlueprint("sensor.camera.rgb")).toBeNull();
  });
});

describe("selectSubstituteBlueprint", () => {
  const carCandidates = [
    { id: "vehicle.mini.cooper", geometry: geometry(3.85, 1.68) },
    { id: "vehicle.lincoln.mkz", geometry: geometry(4.92, 1.86) },
    { id: "vehicle.carlacola.actors", geometry: geometry(9.2, 2.9) },
  ];

  it("picks the same-class candidate with the closest footprint", () => {
    const selection = selectSubstituteBlueprint({
      from: "vehicle.tesla.model3",
      sourceFootprint: { lengthM: 4.69, widthM: 1.85 },
      candidates: carCandidates,
    });
    expect(selection).toMatchObject({
      ok: true,
      to: "vehicle.lincoln.mkz",
      blueprintClass: "car",
      dimensionsBasis: "runtime_catalog",
    });
    if (selection.ok) {
      expect(selection.lengthDeltaM).toBeCloseTo(0.23, 5);
      expect(selection.widthDeltaM).toBeCloseTo(0.01, 5);
    }
  });

  it("is deterministic under candidate reordering", () => {
    const forward = selectSubstituteBlueprint({
      from: "vehicle.tesla.model3",
      sourceFootprint: { lengthM: 4.69, widthM: 1.85 },
      candidates: carCandidates,
    });
    const reversed = selectSubstituteBlueprint({
      from: "vehicle.tesla.model3",
      sourceFootprint: { lengthM: 4.69, widthM: 1.85 },
      candidates: [...carCandidates].reverse(),
    });
    expect(reversed).toEqual(forward);
  });

  it("breaks exact footprint ties by codepoint-ordered blueprint id", () => {
    const selection = selectSubstituteBlueprint({
      from: "vehicle.tesla.model3",
      sourceFootprint: { lengthM: 4.9, widthM: 1.86 },
      candidates: [
        { id: "vehicle.zeta.same", geometry: geometry(4.92, 1.86) },
        { id: "vehicle.alpha.same", geometry: geometry(4.92, 1.86) },
      ],
    });
    expect(selection).toMatchObject({ ok: true, to: "vehicle.alpha.same" });
  });

  it("never substitutes across classes", () => {
    const selection = selectSubstituteBlueprint({
      from: "vehicle.mercedes.sprinter",
      sourceFootprint: { lengthM: 5.9, widthM: 2.06 },
      candidates: carCandidates,
    });
    expect(selection).toMatchObject({
      ok: false,
      reason: "no_same_class_blueprint",
      blueprintClass: "van",
    });
  });

  it("rejects same-class candidates outside the comparable-footprint caps", () => {
    const selection = selectSubstituteBlueprint({
      from: "vehicle.tesla.model3",
      sourceFootprint: { lengthM: 4.69, widthM: 1.85 },
      candidates: [{ id: "vehicle.stretch.limousine", geometry: geometry(9.4, 2.0) }],
    });
    expect(selection).toMatchObject({
      ok: false,
      reason: "no_comparable_footprint",
      blueprintClass: "car",
    });
  });

  it("prefers the curated legacy mapping when footprints tie (undimensioned catalog)", () => {
    // Today's live UE5 actor catalogs carry no geometry, so every same-class
    // candidate ties at delta zero; the curated mapping must win, not the
    // alphabetically first car.
    const ue5Cars = [
      { id: "vehicle.dodge.charger" },
      { id: "vehicle.dodgecop.charger" },
      { id: "vehicle.lincoln.mkz" },
      { id: "vehicle.mini.cooper" },
      { id: "vehicle.nissan.patrol" },
      { id: "vehicle.taxi.ford" },
    ];
    const selection = selectSubstituteBlueprint({
      from: "vehicle.tesla.model3",
      sourceFootprint: null,
      candidates: ue5Cars,
    });
    expect(selection).toMatchObject({ ok: true, to: "vehicle.lincoln.mkz" });
  });

  it("falls back to the conservative class table when no geometry exists", () => {
    const selection = selectSubstituteBlueprint({
      from: "vehicle.tesla.model3",
      sourceFootprint: null,
      candidates: [{ id: "vehicle.lincoln.mkz" }],
    });
    expect(selection).toMatchObject({
      ok: true,
      to: "vehicle.lincoln.mkz",
      dimensionsBasis: "class_estimate",
      lengthDeltaM: 0,
      widthDeltaM: 0,
    });
  });

  it("prefers a walker of the same age class", () => {
    const selection = selectSubstituteBlueprint({
      from: "walker.pedestrian.0009", // child, female
      sourceFootprint: null,
      candidates: [
        { id: "walker.pedestrian.0001" }, // adult, female
        { id: "walker.pedestrian.0049" }, // child, female
      ],
    });
    expect(selection).toMatchObject({ ok: true, to: "walker.pedestrian.0049" });
  });
});

describe("planBlueprintSubstitutions", () => {
  const vehicleCandidates = [
    { id: "vehicle.lincoln.mkz", geometry: geometry(4.92, 1.86) },
    { id: "vehicle.mini.cooper", geometry: geometry(3.85, 1.68) },
  ];
  const walkerCandidates = [{ id: "walker.pedestrian.0049" }];

  it("prefers the exact blueprint when it is available", () => {
    const plan = planBlueprintSubstitutions({
      actors: [{ id: "ego", kind: "vehicle" as const, blueprint: "vehicle.lincoln.mkz" }],
      vehicleCandidates,
      walkerCandidates,
    });
    expect(plan.relaxations).toEqual([]);
    expect(plan.unresolved).toEqual([]);
    expect(plan.actors[0]?.blueprint).toBe("vehicle.lincoln.mkz");
  });

  it("substitutes unavailable blueprints and reports each as a relaxation", () => {
    const footprints = new Map([["ego", { lengthM: 4.69, widthM: 1.85 }]]);
    const plan = planBlueprintSubstitutions({
      actors: [
        { id: "ego", kind: "vehicle" as const, blueprint: "vehicle.tesla.model3" },
        { id: "ped", kind: "walker" as const, blueprint: "walker.pedestrian.0009" },
        { id: "cones", kind: "prop" as const, blueprint: "static.prop.trafficcone01" },
      ],
      vehicleCandidates,
      walkerCandidates,
      footprintByActorId: footprints,
    });
    expect(plan.unresolved).toEqual([]);
    expect(plan.actors.map((actor) => actor.blueprint)).toEqual([
      "vehicle.lincoln.mkz",
      "walker.pedestrian.0049",
      "static.prop.trafficcone01",
    ]);
    expect(plan.relaxations).toHaveLength(2);
    expect(plan.relaxations[0]).toMatchObject({
      kind: "blueprint_substituted",
      actorId: "ego",
      from: "vehicle.tesla.model3",
      to: "vehicle.lincoln.mkz",
      blueprintClass: "car",
      dimensionsBasis: "runtime_catalog",
    });
    expect(plan.relaxations[0]?.lengthDeltaM).toBeCloseTo(0.23, 5);
    expect(plan.relaxations[0]?.widthDeltaM).toBeCloseTo(0.01, 5);
    for (const relaxation of plan.relaxations) {
      expect(BlueprintSubstitutionRelaxationSchema.parse(relaxation)).toEqual(relaxation);
    }
  });

  it("reports unresolved actors when no same-class candidate exists", () => {
    const plan = planBlueprintSubstitutions({
      actors: [{ id: "moto", kind: "vehicle" as const, blueprint: "vehicle.kawasaki.ninja" }],
      vehicleCandidates,
      walkerCandidates,
    });
    expect(plan.relaxations).toEqual([]);
    expect(plan.unresolved).toEqual([{
      actorId: "moto",
      blueprint: "vehicle.kawasaki.ninja",
      blueprintClass: "motorcycle",
      reason: "no_same_class_blueprint",
    }]);
    expect(plan.actors[0]?.blueprint).toBe("vehicle.kawasaki.ninja");
  });

  it("does not treat an exact walker id in the vehicle catalog as available", () => {
    const plan = planBlueprintSubstitutions({
      actors: [{ id: "ped", kind: "walker" as const, blueprint: "vehicle.lincoln.mkz" }],
      vehicleCandidates,
      walkerCandidates,
    });
    expect(plan.unresolved).toEqual([{
      actorId: "ped",
      blueprint: "vehicle.lincoln.mkz",
      blueprintClass: "car",
      reason: "no_same_class_blueprint",
    }]);
  });
});
