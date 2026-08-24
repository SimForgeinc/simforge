/** Internal renderer identity. The product execution contract remains OpenSCENARIO. */
export const OPENSCENARIO_RENDERER_RUNTIME = "carla_ue5" as const;
export type OpenScenarioRendererRuntime = typeof OPENSCENARIO_RENDERER_RUNTIME;

export function normalizeOpenScenarioRendererRuntime(
  _value: unknown,
): OpenScenarioRendererRuntime {
  return OPENSCENARIO_RENDERER_RUNTIME;
}

// Transitional names for map/editor code while its data model is moved into
// the SimForge package. These identify an internal renderer, not a public
// scenario runtime contract.
export const CARLA_RUNTIME_UE5 = OPENSCENARIO_RENDERER_RUNTIME;
export type CarlaRuntime = OpenScenarioRendererRuntime;
export const normalizeCarlaRuntime = normalizeOpenScenarioRendererRuntime;
