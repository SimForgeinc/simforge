// Node-only entry: offline map-intel build pipeline (filesystem-backed).
export * from './index.js';
export { loadMapSources, type MapSources } from './intel/build/sources.js';
export { KNOWN_MAPS, emitBuild, readEmitted } from './intel/cli/build-map.js';
