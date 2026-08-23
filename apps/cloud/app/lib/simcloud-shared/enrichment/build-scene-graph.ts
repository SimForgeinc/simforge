/**
 * Scene graph assembly — orchestrates all builders to produce a MapSceneGraph.
 *
 * Pure function, browser-compatible. Takes raw map file texts and a coordinate
 * transform, returns the complete scene graph.
 */

import type { MapSceneGraph } from "../map-intelligence";
import type { XodrJunctionMatchInfo } from "./extractors/geojson-junction-extractor";
import type { CoordTransform } from "./xodr-geometry";
import { extractGeoReferenceText } from "./xodr-utils";
import { parseProjOrigin } from "./parse-proj";
import { buildJunctions } from "./builders/junction-builder";
import { buildRoadSegments } from "./builders/road-segment-builder";
import { buildCrosswalks } from "./builders/crosswalk-builder";
import { buildParkingClusters } from "./builders/parking-builder";
import { buildSignals } from "./builders/signal-builder";

export type BuildSceneGraphOptions = {
  mapAssetId: string;
  geojsonText: string;
  xodrText: string;
  /** Coordinate transform. If not provided, derived from XODR geoReference. */
  coordTransform?: CoordTransform;
  /** Per-junction XODR data. If not provided, junctions use GeoJSON-only extraction. */
  xodrJunctionInfo?: XodrJunctionMatchInfo[];
};

export type BuildSceneGraphResult = {
  sceneGraph: MapSceneGraph;
  warnings: string[];
};

export function buildMapSceneGraph(opts: BuildSceneGraphOptions): BuildSceneGraphResult {
  const { mapAssetId, geojsonText, xodrText, xodrJunctionInfo } = opts;
  const warnings: string[] = [];

  // Derive coordinate transform from XODR if not provided
  let coordTransform = opts.coordTransform;
  if (!coordTransform) {
    const projString = extractGeoReferenceText(xodrText);
    const origin = projString ? parseProjOrigin(projString) : null;
    coordTransform = {
      originLat: origin?.lat ?? 0,
      originLon: origin?.lon ?? 0,
    };
    if (!origin) {
      warnings.push("scene-graph: no geoReference found in XODR, using origin (0,0)");
    }
  }

  // Build all entity types
  const junctionResult = buildJunctions(geojsonText, xodrJunctionInfo);
  warnings.push(...junctionResult.warnings);

  const roadResult = buildRoadSegments(xodrText, coordTransform);
  warnings.push(...roadResult.warnings);

  const crosswalkResult = buildCrosswalks(xodrText, coordTransform, junctionResult.entities);
  warnings.push(...crosswalkResult.warnings);

  const parkingResult = buildParkingClusters(geojsonText);
  warnings.push(...parkingResult.warnings);

  const signalResult = buildSignals(xodrText, coordTransform);
  warnings.push(...signalResult.warnings);

  return {
    sceneGraph: {
      mapAssetId,
      computedAt: new Date().toISOString(),
      junctions: junctionResult.entities,
      roadSegments: roadResult.entities,
      crosswalks: crosswalkResult.entities,
      parkingClusters: parkingResult.entities,
      signals: signalResult.signals,
      signs: signalResult.signs,
    },
    warnings,
  };
}
