"use client";

import { ChevronRight, Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@/app/components/ui/button";

import { cn } from "@/app/lib/utils";
import type { MapAsset, MapAssetEnrichmentSnapshot } from "@simforge-oss/studio-shared";

/** Props for the MapMetadataSection component. */
type MapMetadataSectionProps = {
  open: boolean;
  onToggleOpen: () => void;
  asset: MapAsset;
  hasExtractedMetadata: boolean;
  showPopulateMetadata: boolean;
  populateBusy: boolean;
  populateErr: string | null;
  onPopulateMetadata: () => void;
  copiedKey: string | null;
  onCopy: (text: string, key: string) => void;
  /** Override the section header title (default: "Map Metadata"). */
  title?: string;
  /** Optional enrichment snapshot to display as a sub-section. */
  enrichment?: MapAssetEnrichmentSnapshot | null;
};

/** Display extracted map metadata (source, coordinate ref, location) with populate action. */
export function MapMetadataSection({
  open,
  onToggleOpen,
  asset,
  hasExtractedMetadata,
  showPopulateMetadata,
  populateBusy,
  populateErr,
  onPopulateMetadata,
  copiedKey,
  onCopy,
  title = "Map Metadata",
  enrichment,
}: MapMetadataSectionProps) {
  return (
    <section>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex flex-1 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={open}
        >
          <ChevronRight
            className={cn("size-3 shrink-0 transition-transform duration-150", open && "rotate-90")}
          />
          {title}
        </button>
        {(asset.map_source != null || asset.map_coordinate_ref != null) && (
          <button
            type="button"
            onClick={() =>
              onCopy(
                JSON.stringify(
                  { map_source: asset.map_source, map_coordinate_ref: asset.map_coordinate_ref },
                  null,
                  2
                ),
                "mapMetadata"
              )
            }
            aria-label="Copy map metadata as JSON"
            title="Copy map metadata as JSON"
            className="shrink-0 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
          >
            {copiedKey === "mapMetadata" ? (
              <Check className="size-3 text-green-400" />
            ) : (
              <Copy className="size-3" />
            )}
          </button>
        )}
      </div>
      {open && (
        <div className="mt-2 space-y-3">
          {!hasExtractedMetadata && (
            <p className="text-xs text-muted-foreground leading-relaxed">
              No extracted fields yet. Upload geojson, xodr, and rrdata_xml for this map, then run{" "}
              <span className="text-foreground/80">Populate metadata</span> below (or create a new map with all
              three files).
            </p>
          )}
          {asset.place_context && (
            <div>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Location
              </h4>
              <p className="text-xs text-foreground/90">
                {[
                  asset.place_context.city,
                  asset.place_context.state,
                  asset.place_context.country_code,
                ]
                  .filter(Boolean)
                  .join(", ")}
              </p>
            </div>
          )}
          {asset.map_source && (
            <div>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Map source
              </h4>
              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {asset.map_source.tool != null && (
                  <>
                    <dt className="text-muted-foreground/70">Tool</dt>
                    <dd className="font-mono text-foreground/90">{asset.map_source.tool}</dd>
                  </>
                )}
                {asset.map_source.tool_version != null && (
                  <>
                    <dt className="text-muted-foreground/70">Version</dt>
                    <dd className="break-all font-mono text-foreground/90">{asset.map_source.tool_version}</dd>
                  </>
                )}
                {asset.map_source.vendor != null && (
                  <>
                    <dt className="text-muted-foreground/70">Vendor</dt>
                    <dd className="font-mono text-foreground/90">{asset.map_source.vendor}</dd>
                  </>
                )}
                {asset.map_source.opendrive_version != null && (
                  <>
                    <dt className="text-muted-foreground/70">OpenDRIVE</dt>
                    <dd className="font-mono text-foreground/90">{asset.map_source.opendrive_version}</dd>
                  </>
                )}
                {asset.map_source.rrdata_schema_version != null && (
                  <>
                    <dt className="text-muted-foreground/70">RR schema</dt>
                    <dd className="font-mono text-foreground/90">{asset.map_source.rrdata_schema_version}</dd>
                  </>
                )}
                {asset.map_source.exported_at != null && (
                  <>
                    <dt className="text-muted-foreground/70">Exported</dt>
                    <dd className="break-all font-mono text-foreground/90">{asset.map_source.exported_at}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {asset.map_coordinate_ref && (
            <div>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Coordinate reference
              </h4>
              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {asset.map_coordinate_ref.origin_lat != null &&
                  asset.map_coordinate_ref.origin_lon != null && (
                    <>
                      <dt className="text-muted-foreground/70">Origin</dt>
                      <dd className="font-mono text-foreground/90">
                        {asset.map_coordinate_ref.origin_lat.toFixed(6)},{" "}
                        {asset.map_coordinate_ref.origin_lon.toFixed(6)}
                      </dd>
                    </>
                  )}
                {asset.map_coordinate_ref.utm_zone != null && (
                  <>
                    <dt className="text-muted-foreground/70">UTM</dt>
                    <dd className="font-mono text-foreground/90">{asset.map_coordinate_ref.utm_zone}</dd>
                  </>
                )}
                {asset.map_coordinate_ref.editor_offset_m != null && (
                  <>
                    <dt className="text-muted-foreground/70">Editor offset</dt>
                    <dd className="font-mono text-foreground/90">
                      {asset.map_coordinate_ref.editor_offset_m.x.toFixed(2)},{" "}
                      {asset.map_coordinate_ref.editor_offset_m.y.toFixed(2)} m
                    </dd>
                  </>
                )}
                {asset.map_coordinate_ref.projection_type != null && (
                  <>
                    <dt className="text-muted-foreground/70">Projection</dt>
                    <dd className="font-mono text-foreground/90">{asset.map_coordinate_ref.projection_type}</dd>
                  </>
                )}
                {asset.map_coordinate_ref.proj_string != null && (
                  <>
                    <dt className="text-muted-foreground/70 shrink-0">PROJ</dt>
                    <dd className="break-all font-mono text-[10px] leading-snug text-foreground/85">
                      {asset.map_coordinate_ref.proj_string}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {asset.carla_map_name && (
            <div>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                CARLA Metadata
              </h4>
              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                <dt className="text-muted-foreground/70">Carla Map Name</dt>
                <dd className="break-all font-mono text-foreground/90">{asset.carla_map_name}</dd>
              </dl>
            </div>
          )}
          {asset.metadata_last_populated_at && (
            <p className="text-[10px] text-muted-foreground/60">
              Metadata last computed {new Date(asset.metadata_last_populated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </p>
          )}
          {enrichment && (
            <div>
              <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Third-Party Enrichment Source
              </h4>
              <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                {enrichment.provider && (
                  <>
                    <dt className="text-muted-foreground/70">Provider</dt>
                    <dd className="font-mono text-foreground/90">{enrichment.provider}</dd>
                  </>
                )}
                {enrichment.provider_release && (
                  <>
                    <dt className="text-muted-foreground/70">Snapshot</dt>
                    <dd className="font-mono text-foreground/90">{enrichment.provider_release}</dd>
                  </>
                )}
                {enrichment.computed_at && (
                  <>
                    <dt className="text-muted-foreground/70">Computed</dt>
                    <dd className="font-mono text-foreground/90">
                      {new Date(enrichment.computed_at).toLocaleDateString()}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          )}
          {showPopulateMetadata && (
            <div className="pt-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-full"
                disabled={populateBusy}
                onClick={onPopulateMetadata}
              >
                {populateBusy ? (
                  <>
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    Populating…
                  </>
                ) : (
                  "Populate metadata"
                )}
              </Button>
              {populateErr && <p className="mt-1.5 text-xs text-destructive">{populateErr}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
