export const ALL_SUMO_SIGNALS_GREEN_EXTENSION_KEY =
  "studio.ambientTraffic.allSignalsGreen.v1";

export function allSumoSignalsGreenFromExtensions(
  extensions: Readonly<Record<string, unknown>> | undefined,
): boolean {
  return extensions?.[ALL_SUMO_SIGNALS_GREEN_EXTENSION_KEY] === true;
}
