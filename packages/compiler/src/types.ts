import type { DerivedTopology, LocationCatalog } from '@simforge/maps';
import type { DerivedMapIndex } from './anchor/index.js';
import type { LaneGraph, TopologyIndex } from '@simforge/engine';
import type { MapSignalCatalog } from './map-signals.js';

/** Fully decoded map materialization data. Loading is deliberately owned by callers. */
export interface MapBundle {
  readonly mapId: string;
  readonly catalog: LocationCatalog;
  readonly derived: DerivedTopology;
  readonly topology: TopologyIndex;
  readonly index: DerivedMapIndex;
  readonly graph: LaneGraph;
  readonly signalCatalog: MapSignalCatalog;
}
