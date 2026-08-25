export * from './src/index';
export * from './compat-viewer-shim';
// rc.45 vendor-compat name: the platform imports the map entry by its old name.
export type { ScenarioMapEntry as UniScenarioMapEntry } from './src/map';
