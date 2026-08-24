// Node-only entry: filesystem-backed map/template IO on top of the portable compiler.
export * from './index.js';
export * from './maps.js';
export * from './template-io.js';
export * from './map-signals-loader.js';
export * from './sites.js';
// Disambiguate: the portable scenario-model MapBundle (types.ts) wins, as it did pre-split.
export type { MapBundle } from './index.js';
