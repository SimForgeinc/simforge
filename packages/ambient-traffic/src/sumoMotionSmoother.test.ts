import { describe, expect, it } from "vitest";
import type { ActorView } from "@uniscenarios/city-renderer";
import { interpolateSumoActorViews } from "./sumoMotionSmoother";

function actor(overrides: Partial<ActorView> = {}): ActorView {
  return {
    id: "sumo:1",
    catalogId: "vehicle.sedan",
    x: 0,
    y: 1,
    z: 0,
    headingRad: 0,
    dims: { l: 4.5, w: 1.8, h: 1.5 },
    speedMps: 4,
    ...overrides,
  };
}

describe("SUMO visual interpolation", () => {
  it("smoothly blends position and speed without changing actor identity", () => {
    const [result] = interpolateSumoActorViews(
      [actor()],
      [actor({ x: 10, y: 3, z: -4, speedMps: 8 })],
      0.25,
    );

    expect(result).toMatchObject({
      id: "sumo:1",
      x: 2.5,
      y: 1.5,
      z: -1,
      speedMps: 5,
    });
  });

  it("turns across the shortest heading arc", () => {
    const degrees = (value: number) => (value * Math.PI) / 180;
    const [result] = interpolateSumoActorViews(
      [actor({ headingRad: degrees(170) })],
      [actor({ headingRad: degrees(-170) })],
      0.5,
    );

    expect(Math.abs(result!.headingRad)).toBeCloseTo(Math.PI, 8);
  });

  it("clamps interpolation and publishes newly spawned actors immediately", () => {
    const target = actor({ id: "sumo:new", x: 12 });
    expect(interpolateSumoActorViews([], [target], 0.5)).toEqual([target]);
    expect(interpolateSumoActorViews([actor()], [actor({ x: 12 })], 2)[0]!.x).toBe(12);
  });
});
