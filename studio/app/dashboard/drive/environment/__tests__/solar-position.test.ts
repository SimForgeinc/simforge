import { describe, expect, it } from "vitest";

import {
  lightingForSolarPosition,
  solarPosition,
  solarPositionMoved,
  type SolarPosition,
} from "../solar-position";

const RICHMOND = { lat: 37.566667, lon: -77.45 } as const;

describe("solarPosition", () => {
  it("matches NOAA near local solar noon in Richmond", () => {
    const position = solarPosition(new Date("2024-06-21T17:00:00.000Z"), RICHMOND.lat, RICHMOND.lon);

    // NOAA Solar Calculator: elevation 75.6503°, azimuth 169.0480°.
    expect(position.elevationDeg).toBeCloseTo(75.6503, 0);
    expect(position.azimuthDeg).toBeCloseTo(169.0480, 0);
    expect(position.equationOfTimeMinutes).toBeCloseTo(-1.98, 0);
  });

  it("matches NOAA for a winter night in Richmond", () => {
    const position = solarPosition(new Date("2024-12-21T05:00:00.000Z"), RICHMOND.lat, RICHMOND.lon);

    // NOAA calcAzEl: elevation -75.7673°, azimuth 352.5373°.
    expect(position.elevationDeg).toBeCloseTo(-75.7673, 0);
    expect(position.azimuthDeg).toBeCloseTo(352.5373, 0);
    expect(position.equationOfTimeMinutes).toBeCloseTo(1.82, 0);
  });

  it("treats equivalent offset and UTC timestamps as the same instant", () => {
    const utc = solarPosition(new Date("2024-06-21T17:00:00.000Z"), RICHMOND.lat, RICHMOND.lon);
    const easternDaylight = solarPosition(
      new Date("2024-06-21T13:00:00.000-04:00"),
      RICHMOND.lat,
      RICHMOND.lon,
    );

    expect(easternDaylight).toEqual(utc);
  });
});

describe("lightingForSolarPosition", () => {
  it("maps a below-civil-twilight sun to a lit night scene without quantising its direction", () => {
    const night = solarPosition(new Date("2024-12-21T05:00:00.000Z"), RICHMOND.lat, RICHMOND.lon);
    const lighting = lightingForSolarPosition(night);

    expect(lighting.timeOfDay).toBe("night_lit");
    expect(lighting.appearanceMinutes).toBe(0);
    expect(lighting.sceneAzimuthDeg).toBeCloseTo(187.4396, 3);
    expect(night.elevationDeg).toBeLessThan(-6);
  });

  it("keeps the exact sun until its angular movement reaches the lighting threshold", () => {
    const base: SolarPosition = {
      elevationDeg: 20,
      azimuthDeg: 359.9,
      hourAngleDeg: -40,
      equationOfTimeMinutes: 0,
    };
    const wrapped: SolarPosition = { ...base, elevationDeg: 20.1, azimuthDeg: 0.1 };
    const moved: SolarPosition = { ...base, elevationDeg: 20.3, azimuthDeg: 0.1 };

    expect(solarPositionMoved(base, wrapped)).toBe(false);
    expect(solarPositionMoved(base, moved)).toBe(true);
    const lighting = lightingForSolarPosition(base);
    expect(lighting.timeOfDay).toBe("noon");
    expect(lighting.sceneAzimuthDeg).toBeCloseTo(180.1, 10);
  });
});
