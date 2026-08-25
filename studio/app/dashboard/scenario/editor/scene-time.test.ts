import assert from "node:assert/strict";
import test from "node:test";

import type { Environment } from "@simforge/scenario";

import {
  FRESH_SCENARIO_MINUTES,
  resolveExactSceneMinutes,
  withSceneMinutes,
} from "./scene-time";

const BASE_ENVIRONMENT: Environment = {
  weather: "clear",
  timeOfDay: "noon",
  sunAzimuthDeg: 180,
  sunElevationDeg: 65,
  surfacePatches: [],
};

test("fresh scenario baseline is deterministic 06:30 dawn", () => {
  const environment = withSceneMinutes(BASE_ENVIRONMENT, FRESH_SCENARIO_MINUTES);

  assert.equal(FRESH_SCENARIO_MINUTES, 390);
  assert.equal(resolveExactSceneMinutes(environment), 390);
  assert.equal(environment.timeOfDay, "dawn");
  assert.equal(environment.sunAzimuthDeg, 97.5);
  assert.ok((environment.sunElevationDeg ?? 0) > 0);
});
