/**
 * Public types for the occlusion-likelihood detector module.
 *
 * Two entry points — one per ingestion phase. Inputs are kept narrow on
 * purpose: each detector reads the smallest set of upstream artifacts it
 * needs so the metadata-phase route doesn't pay for buildings it doesn't
 * have, and the Lambda doesn't pay for raw XODR if a map's profile is
 * unavailable.
 */

import type { MapSceneGraph } from "../../map-intelligence";
import type { CoordTransform } from "../xodr-geometry";

export type LatLng = { lat: number; lng: number };

export type OcclusionMetadataPhaseInput = {
  mapAssetId: string;
  xodrText: string;
  coordTransform: CoordTransform;
  sceneGraph: MapSceneGraph;
};

export type OcclusionBuilding = {
  lat: number;
  lng: number;
  /** Building height in meters, when Overture supplies it. */
  height: number | null;
  /** Polygon footprint outer ring in [lng, lat] pairs (optional). */
  footprint?: [number, number][];
};

export type OcclusionPoi = {
  lat: number;
  lng: number;
  /** Coarse Overture-derived type ("retail", "restaurant", etc). */
  type: string;
  name?: string;
};

export type OcclusionEnrichmentPhaseInput = {
  mapAssetId: string;
  /**
   * Raw XODR text for road-width / lane-count lookups. Optional — when
   * absent, narrow-corridor detection downgrades to a building-density
   * heuristic against Overture road segments.
   */
  xodrText: string | null;
  coordTransform: CoordTransform;
  buildings: OcclusionBuilding[];
  busStops: LatLng[];
  /** Commercial POIs (retail, restaurant, hotel). Used by COMMERCIAL_DELIVERY. */
  commercialPois: OcclusionPoi[];
  /** Crosswalk centroids carried over from the metadata phase. */
  crosswalks: LatLng[];
  /** Junction centroids carried over from the metadata phase. */
  junctions: LatLng[];
};
