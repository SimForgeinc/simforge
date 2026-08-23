import { z } from "zod";

export const ScenarioStatus = z.enum(["DRAFT", "FINALIZED"]);
export type ScenarioStatus = z.infer<typeof ScenarioStatus>;

export const SCENARIO_STATUS_VALUES: readonly ScenarioStatus[] = ScenarioStatus.options;

export const SimulationStatus = z.enum(["QUEUED", "RUNNING", "COMPLETED", "FAILED"]);
export type SimulationStatus = z.infer<typeof SimulationStatus>;

export const SIMULATION_STATUS_VALUES: readonly SimulationStatus[] = SimulationStatus.options;
