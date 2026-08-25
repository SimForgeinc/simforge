import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_SCENE_STATE_VERSION,
  LEGACY_SCENE_STATE_VERSION,
  sceneStateSchema,
} from "@simforge/engine/scene-state";
import nextConfig from "../next.config";
import { simforgeEnv } from "../lib/compat-env";
import { GET as healthHandler } from "../app/api/simforge/internal/health/route";

const EMPTY_SCENE_STATE = {
  mapId: "compat-map",
  frame: "scene-yup" as const,
  dt: 0.02,
  tickHz: 50,
  tickCount: 0,
  weather: { preset: "clear" as const, fogDensity: 0, rainIntensity: 0, wetness: 0 },
  timeOfDay: 12,
  profile: "sensor" as const,
  groundY: null,
  actors: [],
  frames: [],
};

test("legacy and canonical scene-state ids parse to identical documents", () => {
  const legacy = sceneStateSchema.parse({
    ...EMPTY_SCENE_STATE,
    version: LEGACY_SCENE_STATE_VERSION,
  });
  const canonical = sceneStateSchema.parse({
    ...EMPTY_SCENE_STATE,
    version: CANONICAL_SCENE_STATE_VERSION,
  });
  assert.deepEqual(
    { ...legacy, version: CANONICAL_SCENE_STATE_VERSION },
    canonical,
  );
});

test("SIMFORGE env wins and the legacy env is a warned fallback", () => {
  const previousCanonical = process.env.SIMFORGE_WIRE_COMPAT_TEST;
  const previousLegacy = process.env.UNISCENARIO_WIRE_COMPAT_TEST;
  const warnings: string[] = [];
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error) => {
    warnings.push(String(warning));
  }) as typeof process.emitWarning;
  try {
    delete process.env.SIMFORGE_WIRE_COMPAT_TEST;
    process.env.UNISCENARIO_WIRE_COMPAT_TEST = "legacy";
    assert.equal(simforgeEnv("WIRE_COMPAT_TEST"), "legacy");
    assert.equal(simforgeEnv("WIRE_COMPAT_TEST"), "legacy");
    process.env.SIMFORGE_WIRE_COMPAT_TEST = "canonical";
    assert.equal(simforgeEnv("WIRE_COMPAT_TEST"), "canonical");
  } finally {
    process.emitWarning = originalEmitWarning;
    if (previousCanonical === undefined) delete process.env.SIMFORGE_WIRE_COMPAT_TEST;
    else process.env.SIMFORGE_WIRE_COMPAT_TEST = previousCanonical;
    if (previousLegacy === undefined) delete process.env.UNISCENARIO_WIRE_COMPAT_TEST;
    else process.env.UNISCENARIO_WIRE_COMPAT_TEST = previousLegacy;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /SIMFORGE_WIRE_COMPAT_TEST/);
});

test("legacy and canonical API paths dispatch to the same handler tree", async () => {
  assert.equal(typeof nextConfig.rewrites, "function");
  const rewrites = await nextConfig.rewrites!();
  const rules = Array.isArray(rewrites) ? rewrites : rewrites.afterFiles;
  const alias = rules.find((rule) => rule.source === "/api/uniscenario/:path*");
  assert.deepEqual(alias, {
    source: "/api/uniscenario/:path*",
    destination: "/api/simforge/:path*",
  });

  const legacyResponse = await healthHandler(new Request(
    "http://localhost/api/uniscenario/internal/health",
  ));
  const canonicalResponse = await healthHandler(new Request(
    "http://localhost/api/simforge/internal/health",
  ));
  assert.equal(legacyResponse.status, canonicalResponse.status);
  assert.equal(await legacyResponse.text(), await canonicalResponse.text());
});
