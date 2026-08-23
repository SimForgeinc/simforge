"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Copy, Check, MapPin, X } from "lucide-react";
import type { SelectedGeoJSONFeaturePayload } from "@/app/lib/maps/frontend/feature-inspection-types";
import { useStreetFactsByFeatureId } from "@/app/lib/maps/frontend/use-street-facts-index";
import { JsonTreeView } from "@/app/components/JsonTreeView";
import { cn } from "@/app/lib/utils";

/** Props for the MapElementInspector component. */
export type MapElementInspectorProps = {
  selectedFeatures: SelectedGeoJSONFeaturePayload[];
  selectedFeatureId: number | null;
  onSelectFeatureId?: (id: number) => void;
  onClearSelection?: () => void;
  onHighlightId?: (guid: string) => void;
  onSelectId?: (guid: string) => void;
  knownGuids?: Set<string>;
  /** When provided, lane features show their street's search-index facts
   *  (resolved name, road class, Overture posted speed limit). */
  mapAssetId?: string;
};

/** Inspect selected GeoJSON features showing their properties and geometry type. */
export function MapElementInspector({
  selectedFeatures,
  selectedFeatureId,
  onSelectFeatureId,
  onClearSelection,
  onHighlightId,
  onSelectId,
  knownGuids,
  mapAssetId,
}: MapElementInspectorProps) {
  const [expandedFeatureId, setExpandedFeatureId] = useState<number | null>(null);
  const [copiedFeatureId, setCopiedFeatureId] = useState<number | null>(null);
  const streetFactsByFeatureId = useStreetFactsByFeatureId(
    mapAssetId,
    selectedFeatures.length > 0,
  );

  useEffect(() => {
    if (selectedFeatures.length > 0) {
      const id = selectedFeatureId ?? selectedFeatures[0]?.id ?? null;
      setExpandedFeatureId(id);
    } else {
      setExpandedFeatureId(null);
    }
  }, [selectedFeatures, selectedFeatureId]);

  if (selectedFeatures.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8 text-center text-muted-foreground">
        <MapPin className="size-8 opacity-50" />
        <p className="text-xs">Click a feature on the map to inspect it.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="map-element-inspector">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground">
          Selected Features ({selectedFeatures.length})
        </p>
        {onClearSelection && (
          <button
            type="button"
            onClick={onClearSelection}
            title="Clear selection"
            className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="space-y-1">
        {selectedFeatures.map((f) => {
          const isSelected = f.id === selectedFeatureId;
          const isExpanded = f.id === expandedFeatureId;
          return (
            <div
              key={f.id}
              className={cn(
                "rounded-md border text-left transition-colors",
                isSelected
                  ? "border-primary bg-primary/10"
                  : "border-border bg-muted/20 hover:bg-muted/40"
              )}
            >
              <button
                type="button"
                onClick={() => {
                  if (f.id === expandedFeatureId) {
                    setExpandedFeatureId(null);
                  } else {
                    setExpandedFeatureId(f.id);
                    onSelectFeatureId?.(f.id);
                  }
                }}
                className="flex w-full items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-foreground"
              >
                <ChevronRight
                  className={cn("size-3.5 shrink-0 transition-transform duration-150", isExpanded && "rotate-90")}
                />
                <span className="min-w-0 truncate" data-testid="selected-feature-summary">
                  {f.summary}
                </span>
              </button>
              {isExpanded && (
                <div className="border-t border-border px-2.5 py-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted-foreground">
                      Geometry: <span className="font-medium text-foreground">{f.geometryType}</span>
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        const geojsonFeature = {
                          type: "Feature" as const,
                          geometry: f.geometry ?? { type: f.geometryType, coordinates: f.coordinates ?? [] },
                          properties: f.properties,
                        };
                        navigator.clipboard.writeText(JSON.stringify(geojsonFeature, null, 2)).then(() => {
                          setCopiedFeatureId(f.id);
                          setTimeout(() => setCopiedFeatureId(null), 2000);
                        }).catch(() => {});
                      }}
                      title="Copy feature as GeoJSON"
                      className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                    >
                      {copiedFeatureId === f.id ? (
                        <Check className="size-3 text-green-500" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                      Copy GeoJSON
                    </button>
                  </div>
                  {/* Street facts from the search index — shown for driving
                      lanes so the road's resolved name, OSM road class, and
                      Overture posted limit are visible without opening the
                      raw properties tree. */}
                  {(() => {
                    const street = streetFactsByFeatureId?.get(f.id);
                    if (!street) return null;
                    return (
                      <div className="mb-2 space-y-1" data-testid="street-facts">
                        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Street facts
                        </h3>
                        <div className="flex items-baseline gap-2 text-xs">
                          <span className="shrink-0 text-muted-foreground">Street</span>
                          <span className="font-medium text-foreground">{street.streetName}</span>
                        </div>
                        {street.roadClass && (
                          <div className="flex items-baseline gap-2 text-xs">
                            <span className="shrink-0 text-muted-foreground">Road class</span>
                            <span className="font-medium text-foreground">{street.roadClass}</span>
                          </div>
                        )}
                        {street.overtureSpeedLimitMph != null && (
                          <div className="flex items-baseline gap-2 text-xs">
                            <span className="shrink-0 text-muted-foreground">Posted limit</span>
                            <span className="font-medium text-foreground">
                              {street.overtureSpeedLimitMph} mph
                              <span className="ml-1 font-normal text-muted-foreground">(Overture)</span>
                            </span>
                          </div>
                        )}
                        {street.laneCount != null && (
                          <div className="flex items-baseline gap-2 text-xs">
                            <span className="shrink-0 text-muted-foreground">Lanes</span>
                            <span className="font-medium text-foreground">{street.laneCount}</span>
                          </div>
                        )}
                        <div className="border-b border-border/50 pt-1" />
                      </div>
                    );
                  })()}
                  {/* Key identifiers pulled to top */}
                  {(() => {
                    const props = f.properties as Record<string, unknown>;
                    const id = props.Id ?? props.id;
                    const type = props.Type ?? props.type;
                    const remaining = Object.fromEntries(
                      Object.entries(props).filter(
                        ([k]) => !["Id", "id", "Type", "type"].includes(k),
                      ),
                    );
                    return (
                      <>
                        {(id != null || type != null) && (
                          <div className="space-y-1 mb-2">
                            {type != null && (
                              <div className="flex items-baseline gap-2 text-xs">
                                <span className="shrink-0 text-muted-foreground">Type</span>
                                <span className="font-medium text-foreground">{String(type)}</span>
                              </div>
                            )}
                            {id != null && (
                              <div className="flex items-baseline gap-2 text-xs">
                                <span className="shrink-0 text-muted-foreground">Id</span>
                                <span className="font-mono text-foreground/80 text-[10px] break-all">
                                  {String(id).replace(/^\{|\}$/g, "")}
                                </span>
                              </div>
                            )}
                            <div className="border-b border-border/50 pt-1" />
                          </div>
                        )}
                        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Properties
                        </h3>
                        <JsonTreeView
                          data={remaining}
                          collapseArrays
                          onHighlightId={onHighlightId}
                          onSelectId={onSelectId}
                          knownIds={knownGuids}
                        />
                      </>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
