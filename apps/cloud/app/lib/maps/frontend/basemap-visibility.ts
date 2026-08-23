"use client";

import { BASEMAPS, type BasemapId } from "./basemaps";
import {
  SATELLITE_MAX_ZOOM,
  SATELLITE_MIN_ZOOM,
  type SatelliteImageryLayer,
} from "./satellite-imagery";

export const BASEMAP_LAYER_GROUPS = [
  { id: "background", label: "Background" },
  { id: "landuse", label: "Landuse" },
  { id: "water", label: "Water" },
  { id: "boundaries", label: "Boundaries" },
  { id: "roads", label: "Roads" },
  { id: "transit", label: "Rail" },
  { id: "roadLabels", label: "Road Labels" },
  { id: "placeLabels", label: "Place Labels" },
  { id: "poi", label: "POI Labels" },
  { id: "aeroway", label: "Aeroway" },
  { id: "buildings", label: "Buildings" },
] as const;

export type BasemapLayerGroupId = (typeof BASEMAP_LAYER_GROUPS)[number]["id"];

export type BasemapLayerVisibility = Record<BasemapLayerGroupId, boolean>;

type BasemapStyleLayer = {
  id?: string;
  source?: string;
  type?: string;
  "source-layer"?: string;
};

type BasemapStyle = {
  version: number;
  name?: string;
  sources: Record<string, unknown>;
  layers: BasemapStyleLayer[];
  glyphs?: string;
  sprite?: string;
  metadata?: Record<string, unknown>;
};

const BASEMAP_STYLE_CACHE = new Map<BasemapId, Promise<BasemapStyle>>();

export const DEFAULT_BASEMAP_LAYER_VISIBILITY: BasemapLayerVisibility = {
  background: true,
  landuse: true,
  water: true,
  boundaries: true,
  roads: true,
  transit: true,
  roadLabels: true,
  placeLabels: true,
  poi: true,
  aeroway: true,
  buildings: true,
};

export const BUILDINGS_ONLY_BASEMAP_LAYER_VISIBILITY: BasemapLayerVisibility = {
  background: true,
  landuse: false,
  water: false,
  boundaries: false,
  roads: false,
  transit: false,
  roadLabels: false,
  placeLabels: false,
  poi: false,
  aeroway: false,
  buildings: true,
};

function sourceLayerFor(layer: BasemapStyleLayer) {
  return layer["source-layer"] ?? "";
}

function classifyTransportationLayer(layer: BasemapStyleLayer): BasemapLayerGroupId {
  const id = (layer.id ?? "").toLowerCase();
  if (id.includes("rail")) return "transit";
  return "roads";
}

function classifyBasemapLayer(layer: BasemapStyleLayer): BasemapLayerGroupId | null {
  const id = (layer.id ?? "").toLowerCase();
  const sourceLayer = sourceLayerFor(layer).toLowerCase();

  if (!sourceLayer) return id === "background" ? "background" : null;
  if (sourceLayer === "landcover" || sourceLayer === "landuse" || sourceLayer === "park") return "landuse";
  if (sourceLayer === "water" || sourceLayer === "waterway") return "water";
  if (sourceLayer === "water_name") return "placeLabels";
  if (sourceLayer === "boundary") return "boundaries";
  if (sourceLayer === "aeroway") return "aeroway";
  if (sourceLayer === "building") return "buildings";
  if (sourceLayer === "place" || sourceLayer === "housenumber") return "placeLabels";
  if (sourceLayer === "poi") return "poi";
  if (sourceLayer === "transportation_name") return "roadLabels";
  if (sourceLayer === "transportation") return classifyTransportationLayer(layer);

  return null;
}

export function isDefaultBasemapLayerVisibility(visibility: BasemapLayerVisibility) {
  return BASEMAP_LAYER_GROUPS.every(
    ({ id }) => visibility[id] === DEFAULT_BASEMAP_LAYER_VISIBILITY[id],
  );
}

export function filterBasemapStyle(
  style: BasemapStyle,
  visibility: BasemapLayerVisibility,
): BasemapStyle {
  return {
    ...style,
    layers: style.layers.filter((layer) => {
      const group = classifyBasemapLayer(layer);
      if (!group) return true;
      return visibility[group];
    }),
  };
}

async function fetchBasemapStyle(basemapId: BasemapId) {
  const existing = BASEMAP_STYLE_CACHE.get(basemapId);
  if (existing) return existing;

  const basemap = BASEMAPS.find((entry) => entry.id === basemapId);
  if (!basemap) {
    throw new Error(`Unknown basemap: ${basemapId}`);
  }

  const promise = fetch(basemap.url, { cache: "force-cache" }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`Failed to fetch basemap style: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<BasemapStyle>;
  });

  BASEMAP_STYLE_CACHE.set(basemapId, promise);
  return promise;
}

export async function resolveBasemapStyle(
  basemapId: BasemapId,
  visibility: BasemapLayerVisibility,
) {
  const basemap = BASEMAPS.find((entry) => entry.id === basemapId);
  if (!basemap) {
    throw new Error(`Unknown basemap: ${basemapId}`);
  }

  if (isDefaultBasemapLayerVisibility(visibility)) {
    return basemap.url;
  }

  const style = await fetchBasemapStyle(basemapId);
  return filterBasemapStyle(style, visibility);
}

/**
 * Resolve the basemap style with satellite raster layers draped on top.
 *
 * Each image service becomes its own raster source + layer, appended after
 * every vector layer (so overlays added by map components stay above the
 * imagery) and stacked in list order — one tileset often covers only part of a
 * map, so several are composited to cover the whole extent. Outside every
 * tileset's bounds/zoom range the vector basemap shows through.
 */
export async function resolveBasemapStyleWithImagery(
  basemapId: BasemapId,
  visibility: BasemapLayerVisibility,
  imageryLayers: SatelliteImageryLayer[] | null,
): Promise<object | string> {
  if (!imageryLayers || imageryLayers.length === 0) {
    return resolveBasemapStyle(basemapId, visibility);
  }

  const style = filterBasemapStyle(await fetchBasemapStyle(basemapId), visibility);
  const rasterSources = Object.fromEntries(
    imageryLayers.map((layer) => [
      layer.id,
      {
        type: "raster",
        tiles: [layer.tiles],
        tileSize: 256,
        minzoom: SATELLITE_MIN_ZOOM,
        maxzoom: SATELLITE_MAX_ZOOM,
        bounds: layer.bounds,
      },
    ]),
  );
  return {
    ...style,
    sources: { ...style.sources, ...rasterSources },
    layers: [
      ...style.layers,
      ...imageryLayers.map((layer) => ({
        id: layer.id,
        type: "raster",
        source: layer.id,
      })),
    ],
  };
}
