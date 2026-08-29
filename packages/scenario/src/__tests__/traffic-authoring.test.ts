import { describe, expect, it } from "vitest";

import {
  AGGRESSIVENESS_PARAMS,
  CarLedTrafficAuthoringSchema,
  DEFAULT_CUSTOM_VEHICLE_MIX,
  DEFAULT_SEEDED_CARS_PER_ACTOR,
  DENSITY_VEHICLE_COUNTS,
  GlobalTrafficAuthoringSchema,
  LEGACY_ENVIRONMENT_FALLBACK,
  MIXED_VEHICLE_MIX,
  NEW_DOCUMENT_ENVIRONMENT_DEFAULT,
  TRAFFIC_AUTHORING_DEFAULTS,
  TRAFFIC_AUTHORING_LIMITS,
  TrafficAuthoringSchema,
  TrafficVehicleMixWeightsSchema,
  resolveLegacyEnvironmentFallback,
  resolveNewDocumentEnvironment,
  vehicleMixForPreset,
} from "../contracts.js";

describe("environment authoring defaults", () => {
  it("keeps new-document and legacy missing-environment semantics explicit", () => {
    expect(NEW_DOCUMENT_ENVIRONMENT_DEFAULT).toMatchObject({
      weather: "cloudy",
      timeOfDay: "dusk",
    });
    expect(resolveNewDocumentEnvironment()).toEqual(NEW_DOCUMENT_ENVIRONMENT_DEFAULT);

    expect(LEGACY_ENVIRONMENT_FALLBACK).toMatchObject({
      weather: "clear",
      timeOfDay: "noon",
    });
    expect(resolveLegacyEnvironmentFallback(undefined)).toEqual(
      LEGACY_ENVIRONMENT_FALLBACK,
    );
    expect(resolveLegacyEnvironmentFallback({ weather: "heavy_rain" })).toMatchObject({
      weather: "heavy_rain",
      timeOfDay: "dusk",
    });
  });
});

describe("traffic authoring contract", () => {
  it("publishes every preset-card value", () => {
    expect(DENSITY_VEHICLE_COUNTS).toEqual({ light: 10, moderate: 30, heavy: 60 });
    expect(DEFAULT_SEEDED_CARS_PER_ACTOR).toBe(12);
    expect(DEFAULT_CUSTOM_VEHICLE_MIX).toEqual({ passenger: 70, truck: 20, bus: 10 });
    expect(MIXED_VEHICLE_MIX).toEqual([
      { type: "passenger", weight: 0.8 },
      { type: "truck", weight: 0.15 },
      { type: "bus", weight: 0.05 },
    ]);
    expect(vehicleMixForPreset("cars_only")).toEqual([
      { type: "passenger", weight: 1 },
    ]);
    expect(vehicleMixForPreset("mixed")).toEqual(MIXED_VEHICLE_MIX);
    expect(AGGRESSIVENESS_PARAMS).toEqual({
      calm: { sigma: "0.2", speedFactor: "0.85", minGap: "3.0" },
      normal: { sigma: "0.5", speedFactor: "1.0", minGap: "2.5" },
      aggressive: { sigma: "0.8", speedFactor: "1.15", minGap: "1.5" },
    });
  });

  it("normalizes absent setup and legacy load values to one canonical state", () => {
    expect(TrafficAuthoringSchema.parse({})).toEqual({
      carLed: TRAFFIC_AUTHORING_DEFAULTS.carLed,
      global: {
        ...TRAFFIC_AUTHORING_DEFAULTS.global,
        vehicleCount: DENSITY_VEHICLE_COUNTS.moderate,
      },
    });
    expect(GlobalTrafficAuthoringSchema.parse({ density: "heavy" }).vehicleCount).toBe(60);
    expect(TrafficVehicleMixWeightsSchema.parse({ passenger: -5, truck: 200 })).toEqual({
      passenger: 0,
      truck: 100,
      bus: 10,
    });
  });

  it("rounds and clamps every numeric traffic field", () => {
    const normalized = CarLedTrafficAuthoringSchema.parse({
      carsPerActor: 99,
      radiusMeters: 1,
      minimumSpacingMeters: 99,
      baseSpeedKph: 2,
      variantSeed: -4,
    });
    expect(normalized).toMatchObject({
      carsPerActor: TRAFFIC_AUTHORING_LIMITS.carLed.carsPerActor.max,
      radiusMeters: TRAFFIC_AUTHORING_LIMITS.carLed.radiusMeters.min,
      minimumSpacingMeters: TRAFFIC_AUTHORING_LIMITS.carLed.minimumSpacingMeters.max,
      baseSpeedKph: TRAFFIC_AUTHORING_LIMITS.carLed.baseSpeedKph.min,
      variantSeed: TRAFFIC_AUTHORING_LIMITS.carLed.variantSeed.min,
    });
    expect(GlobalTrafficAuthoringSchema.parse({ vehicleCount: 0 }).vehicleCount).toBe(
      TRAFFIC_AUTHORING_LIMITS.global.vehicleCount.min,
    );
  });
});
