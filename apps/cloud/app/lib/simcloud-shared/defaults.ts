/**
 * Shared default values used across the SimForge platform.
 * Both the editor and dashboard should reference these as the single source of truth.
 */
import { SCENARIO_TIMING } from "./scenario-timing";

/** Default recording dimensions and field of view for CARLA camera output. */
export const RECORDING_DEFAULTS = {
  width: 1280,
  height: 720,
  fov: 90,
} as const;

/** Default simulation timing parameters. */
export const SIMULATION_DEFAULTS = {
  durationSeconds: SCENARIO_TIMING.defaultDurationSeconds,
  fixedDeltaSeconds: 0.05,
  physicsProfileId: "carla_default",
} as const;

/** Default Cosmos (GPU world-gen) parameters. */
export const COSMOS_DEFAULTS = {
  maxFrames: 9999,
  resolution: 720,
  guidance: 3,
  numSteps: {
    full: 35,
    distilled: 4,
  },
} as const;
