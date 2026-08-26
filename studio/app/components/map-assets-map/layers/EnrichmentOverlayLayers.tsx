import { Layer, Source } from "react-map-gl/maplibre";
import type { MapOverlayLayer, MapOverlayLayerId } from "@simforge-oss/studio-shared";
import { C, OVERLAY_STYLES } from "../map-layer-constants";
import { ENRICHMENT_GLYPH_ICON, ENRICHMENT_LINE_CHIP_ICON } from "../map-icons";
import type { EnrichmentLayerStyle } from "@/app/lib/scenario-editor/layer-styles";

/** Props for the EnrichmentOverlayLayers component. */
type EnrichmentOverlayLayersProps = {
  layers: MapOverlayLayer[];
  showLineChips?: boolean;
  styleOverrides?: Partial<Record<MapOverlayLayerId, EnrichmentLayerStyle>>;
  visible?: boolean;
};

// A point with a POI glyph renders as a colored "chip": the existing circle
// stays a small dot when zoomed out and grows into a chip as the white glyph
// fades in around z14, so dots and glyphs never double-stamp the same spot.
const GLYPH_OPACITY = ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 1];
const GLYPH_SIZE = ["interpolate", ["linear"], ["zoom"], 14, 0.55, 17, 0.85];

// Polyline chips for LineString overlays: a round pedestrian/crosswalk glyph
// stamped on the line so users can read it without a label. Long sidewalks
// repeat sparsely along the line; short crosswalks get a single centered chip.
const LINE_CHIP_SIZE = ["interpolate", ["linear"], ["zoom"], 13, 0.5, 17, 0.8];
const LINE_CHIP_OPACITY = ["interpolate", ["linear"], ["zoom"], 13, 0, 14.5, 0.95];
const LINE_CHIP_SPACING = ["interpolate", ["linear"], ["zoom"], 13, 220, 17, 440];

/** Circle radius for a chip: a `base`-sized dot zoomed out, chip-sized zoomed in. */
function chipRadius(base: number) {
  return ["interpolate", ["linear"], ["zoom"], 12, base, 14, Math.max(base, 8), 17, 11];
}

/** Render enrichment overlay layers for points, lines, and polygons. */
export function EnrichmentOverlayLayers({
  layers,
  showLineChips = false,
  styleOverrides = {},
  visible = true,
}: EnrichmentOverlayLayersProps) {
  const visibility = visible ? "visible" : "none";

  return (
    <>
      {layers.map((layer) => {
        const baseStyle = OVERLAY_STYLES[layer.layer_id];
        if (!baseStyle) return null;
        const style = {
          ...baseStyle,
          lineWidth: 3,
          ...(styleOverrides[layer.layer_id] ?? {}),
        };
        const sourceId = `enrichment-${layer.layer_id}`;

        if (layer.geometry_type === "Point") {
          // Address points carry a street number — render dots when zoomed
          // out and switch to the number label once the user has zoomed in
          // enough to read individual buildings. The circle fades out as the
          // text fades in so the two don't double-stamp the same spot.
          const isAddresses = layer.layer_id === "addresses";
          const glyph = ENRICHMENT_GLYPH_ICON[layer.layer_id];
          return (
            <Source key={sourceId} id={sourceId} type="geojson" data={layer.data as never}>
              <Layer
                id={`${sourceId}-circle`}
                type="circle"
                layout={{ visibility }}
                paint={{
                  "circle-radius": (glyph ? chipRadius(style.radius) : style.radius) as never,
                  "circle-color": style.color,
                  "circle-opacity": isAddresses
                    ? ([
                        "interpolate",
                        ["linear"],
                        ["zoom"],
                        15,
                        style.opacity,
                        16.5,
                        0,
                      ] as never)
                    : style.opacity,
                  "circle-stroke-width": 1,
                  "circle-stroke-color": C.bg,
                }}
              />
              {isAddresses && (
                <Layer
                  id={`${sourceId}-number`}
                  type="symbol"
                  minzoom={15}
                  filter={["!=", ["get", "number"], null] as never}
                  layout={{
                    visibility,
                    "text-field": ["to-string", ["get", "number"]],
                    "text-font": ["Open Sans Bold"],
                    "text-size": [
                      "interpolate",
                      ["linear"],
                      ["zoom"],
                      15,
                      10,
                      18,
                      13,
                    ] as never,
                    "text-anchor": "center",
                    "text-allow-overlap": false,
                    "text-ignore-placement": false,
                  }}
                  paint={{
                    "text-color": "#e2e8f0",
                    "text-halo-color": C.bg,
                    "text-halo-width": 1.4,
                    "text-opacity": [
                      "interpolate",
                      ["linear"],
                      ["zoom"],
                      15,
                      0,
                      16,
                      1,
                    ] as never,
                  }}
                />
              )}
              {glyph && (
                <Layer
                  id={`${sourceId}-glyph`}
                  type="symbol"
                  minzoom={12}
                  layout={{
                    visibility,
                    "icon-image": glyph,
                    "icon-size": GLYPH_SIZE as never,
                    "icon-allow-overlap": false,
                    "icon-optional": true,
                  }}
                  paint={{ "icon-opacity": GLYPH_OPACITY as never }}
                />
              )}
            </Source>
          );
        }

        if (layer.geometry_type === "LineString") {
          const lineChip = ENRICHMENT_LINE_CHIP_ICON[layer.layer_id];
          // Crosswalks are short, discrete features → one centered chip reads
          // cleanly; sidewalks run for blocks → repeat sparsely along the line.
          const chipPlacement = layer.layer_id === "crosswalks" ? "line-center" : "line";
          return (
            <Source key={sourceId} id={sourceId} type="geojson" data={layer.data as never}>
              <Layer
                id={`${sourceId}-line`}
                type="line"
                layout={{ visibility }}
                paint={{
                  "line-color": style.color,
                  "line-width": style.lineWidth,
                  "line-opacity": style.opacity,
                }}
              />
              {showLineChips && lineChip && (
                <Layer
                  id={`${sourceId}-chip`}
                  type="symbol"
                  minzoom={13}
                  layout={{
                    visibility,
                    "symbol-placement": chipPlacement,
                    "symbol-spacing": LINE_CHIP_SPACING as never,
                    "icon-image": lineChip,
                    "icon-size": LINE_CHIP_SIZE as never,
                    "icon-rotation-alignment": "viewport",
                    "icon-allow-overlap": false,
                    "icon-optional": true,
                  }}
                  paint={{ "icon-opacity": LINE_CHIP_OPACITY as never }}
                />
              )}
            </Source>
          );
        }

        if (layer.geometry_type === "GeoJSON") {
          // Heterogeneous layer — features carry mixed geometry types.
          // Stack four filtered MapLibre layers on the same source so each
          // feature renders with the right primitive: Point/MultiPoint →
          // circle, LineString/MultiLineString → line, Polygon/MultiPolygon
          // → fill+outline. The `match` expression returns true when the
          // feature's geometry-type matches any of the listed values, so
          // each filter covers both the singular and the multi variant.
          const polygonFilter: ["match", ["geometry-type"], string[], boolean, boolean] = [
            "match",
            ["geometry-type"],
            ["Polygon", "MultiPolygon"],
            true,
            false,
          ];
          const lineFilter: ["match", ["geometry-type"], string[], boolean, boolean] = [
            "match",
            ["geometry-type"],
            ["LineString", "MultiLineString"],
            true,
            false,
          ];
          const pointFilter: ["match", ["geometry-type"], string[], boolean, boolean] = [
            "match",
            ["geometry-type"],
            ["Point", "MultiPoint"],
            true,
            false,
          ];
          const glyph = ENRICHMENT_GLYPH_ICON[layer.layer_id];
          return (
            <Source key={sourceId} id={sourceId} type="geojson" data={layer.data as never}>
              <Layer
                id={`${sourceId}-fill`}
                type="fill"
                filter={polygonFilter}
                layout={{ visibility }}
                paint={{
                  "fill-color": style.fill,
                  "fill-opacity": style.opacity,
                }}
              />
              <Layer
                id={`${sourceId}-polygon-outline`}
                type="line"
                filter={polygonFilter}
                layout={{ visibility }}
                paint={{
                  "line-color": style.color,
                  "line-width": style.lineWidth,
                  "line-opacity": Math.min(style.opacity + 0.2, 1),
                }}
              />
              <Layer
                id={`${sourceId}-line`}
                type="line"
                filter={lineFilter}
                layout={{ visibility }}
                paint={{
                  "line-color": style.color,
                  "line-width": style.lineWidth,
                  "line-opacity": style.opacity,
                }}
              />
              <Layer
                id={`${sourceId}-circle`}
                type="circle"
                filter={pointFilter}
                layout={{ visibility }}
                paint={{
                  "circle-radius": (glyph ? chipRadius(style.radius) : style.radius) as never,
                  "circle-color": style.color,
                  "circle-opacity": style.opacity,
                  "circle-stroke-width": 1,
                  "circle-stroke-color": C.bg,
                }}
              />
              {glyph && (
                <Layer
                  id={`${sourceId}-glyph`}
                  type="symbol"
                  minzoom={12}
                  filter={pointFilter}
                  layout={{
                    visibility,
                    "icon-image": glyph,
                    "icon-size": GLYPH_SIZE as never,
                    "icon-allow-overlap": false,
                    "icon-optional": true,
                  }}
                  paint={{ "icon-opacity": GLYPH_OPACITY as never }}
                />
              )}
              {glyph && (
                <Layer
                  id={`${sourceId}-centroid-glyph`}
                  type="symbol"
                  minzoom={13}
                  filter={polygonFilter}
                  layout={{
                    visibility,
                    "icon-image": glyph,
                    "icon-size": GLYPH_SIZE as never,
                    "icon-allow-overlap": false,
                    "icon-optional": true,
                  }}
                  paint={{ "icon-opacity": GLYPH_OPACITY as never }}
                />
              )}
            </Source>
          );
        }

        // Default: Polygon layer.
        const polygonGlyph = ENRICHMENT_GLYPH_ICON[layer.layer_id];
        return (
          <Source key={sourceId} id={sourceId} type="geojson" data={layer.data as never}>
            <Layer
              id={`${sourceId}-fill`}
              type="fill"
              layout={{ visibility }}
              paint={{
                "fill-color": style.fill,
                "fill-opacity": style.opacity,
              }}
            />
            <Layer
              id={`${sourceId}-line`}
              type="line"
              layout={{ visibility }}
              paint={{
                "line-color": style.color,
                "line-width": style.lineWidth,
                "line-opacity": Math.min(style.opacity + 0.2, 1),
              }}
            />
            {polygonGlyph && (
              <Layer
                id={`${sourceId}-centroid-glyph`}
                type="symbol"
                minzoom={13}
                layout={{
                  visibility,
                  "icon-image": polygonGlyph,
                  "icon-size": GLYPH_SIZE as never,
                  "icon-allow-overlap": false,
                  "icon-optional": true,
                }}
                paint={{ "icon-opacity": GLYPH_OPACITY as never }}
              />
            )}
          </Source>
        );
      })}
    </>
  );
}
