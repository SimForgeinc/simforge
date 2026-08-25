"use client";

import { useState, useMemo } from "react";
import { Route, GitFork, PersonStanding, Footprints, Bike, SquareParking, ChevronRight, Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/app/components/ui/tooltip";
import { cn } from "@/app/lib/utils";
import type { MapAsset, MapAssetEnrichmentSnapshot, CandidateLocation } from "@simforge/studio-shared";
import type { ScenarioSummary } from "@/app/lib/scenarios";
import { CopyButton } from "@/app/components/CopyButton";
import { MapMetadataSection } from "@/app/dashboard/map-assets/map-detail-sections/MapMetadataSection";
import { ArtifactsSection } from "@/app/dashboard/map-assets/map-detail-sections/ArtifactsSection";
import { VideosSection } from "@/app/dashboard/map-assets/map-detail-sections/VideosSection";
import { FLYBY_PREVIEW_ARTIFACT_TYPE, flybyPreviewKeyForOriginalKey } from "@/app/lib/maps/flyby-preview";
import { buildScenarioFamilyGroups } from "@/app/lib/scenario-intelligence-ui";
import { getFamilyIcon } from "@/app/lib/scenario-family-icons";

/** Extract the bare S3 object key from an `s3://bucket/key` URI, or null. */
function s3KeyFromUri(uri: string): string | null {
  if (!uri.startsWith("s3://")) return null;
  const rest = uri.slice("s3://".length);
  const slash = rest.indexOf("/");
  return slash === -1 ? null : rest.slice(slash + 1);
}

interface QuickStatCardProps {
  icon: React.ReactNode;
  value: string;
  label: React.ReactNode;
  /** Tooltip lines shown on hover. */
  tooltip?: string[];
}

function QuickStatCard({ icon, value, label, tooltip }: QuickStatCardProps) {
  const card = (
    <div className="p-3 rounded-lg bg-secondary/50 border border-border hover:bg-secondary/70 transition-colors">
      <div className="flex items-center gap-2 text-muted-foreground mb-2">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p className="text-lg font-semibold text-foreground font-mono">{value}</p>
    </div>
  );

  if (!tooltip || tooltip.length === 0) return card;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{card}</TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs leading-relaxed">
          {tooltip.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

interface OverviewTabProps {
  asset: MapAsset;
  runs: ScenarioSummary[];
  enrichment: MapAssetEnrichmentSnapshot | null;
  enrichmentLoading: boolean;
  candidateLocations: CandidateLocation[];
  candidateLocationsLoading: boolean;
  selectedCandidateLocationId: string | null;
  onSelectCandidateLocationId?: (id: string | null) => void;
  onViewArtifact?: (info: { proxyUrl: string; label?: string }) => void;
  onPopulateMetadata: () => void;
  populateBusy: boolean;
  populateErr: string | null;
  /** Switch to Scenarios tab, optionally focusing a specific family. */
  onSwitchToInsightsTab: (focusFamilyId?: string) => void;
  onSwitchToStatsTab: () => void;
  /** Dedup'd count of Overture crosswalks not covered by in-house data (≥0). */
  overtureCrosswalkSurvivors?: number;
}

/** Overview tab with map stats, media, metadata, artifacts, and scenario insights summary. */
export function OverviewTab({
  asset,
  runs: _runs,
  enrichment,
  enrichmentLoading: _enrichmentLoading,
  candidateLocations,
  candidateLocationsLoading,
  selectedCandidateLocationId: _selectedCandidateLocationId,
  onSelectCandidateLocationId: _onSelectCandidateLocationId,
  onViewArtifact,
  onPopulateMetadata,
  populateBusy,
  populateErr,
  onSwitchToInsightsTab,
  onSwitchToStatsTab,
  overtureCrosswalkSurvivors,
}: OverviewTabProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [videosOpen, setVideosOpen] = useState(true);
  const [showAllFamilies, setShowAllFamilies] = useState(false);


  function copy(text: string, key: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 1500);
      })
      .catch(() => {});
  }

  const stats = asset.map_stats;
  const rn = stats?.road_network;
  const centerlineLengthM = rn?.total_centerline_length_m;
  const mileageKm = centerlineLengthM != null ? centerlineLengthM / 1000 : null;
  const speedLimits = rn?.speed_limits_mph;
  const maxGrade = rn?.max_grade_pct;
  const gradeAbove4LengthM = rn?.length_above_4pct_grade_m;
  const gradeAbove4Km = gradeAbove4LengthM != null ? gradeAbove4LengthM / 1000 : null;
  const junctions = stats?.feature_inventory?.junctions?.total ?? rn?.total_junctions;
  const signalJunctions = stats?.feature_inventory?.junctions?.signalized;
  const stopJunctions = stats?.feature_inventory?.junctions?.stop_sign_controlled;
  const sidewalkLengthM = stats?.road_network?.sidewalk_length_m;
  const sidewalkKm = sidewalkLengthM != null ? sidewalkLengthM / 1000 : null;
  const bikeLaneLengthM = stats?.road_network?.bike_lane_length_m;
  const bikeLaneKm = bikeLaneLengthM != null ? bikeLaneLengthM / 1000 : null;
  const inHouseCrosswalks = stats?.feature_inventory?.crosswalks?.total;
  const overtureCrosswalks = overtureCrosswalkSurvivors ?? 0;
  // Merged total mirrors the search-index pipeline: in-house XODR crosswalks +
  // Overture survivors (Overture features not within 15 m of any XODR one).
  // Render undefined when in-house metadata hasn't been computed yet so we
  // don't claim "0" for an unmeasured map.
  const crosswalks =
    inHouseCrosswalks != null ? inHouseCrosswalks + overtureCrosswalks : undefined;
  const parkingSpacesFromStats = stats?.feature_inventory?.parking_spaces;
  const parkingLaneLengthM = stats?.road_network?.parking_lane_length_m;
  const parkingLaneKm = parkingLaneLengthM != null ? parkingLaneLengthM / 1000 : null;

  // Candidate-derived parking counts. Parking lots come from the standalone-lot
  // clusterer (kind "parking_lot"); street-parking candidates come from the
  // dedicated-lane extractor + narrow-street adjacency pass.
  const parkingLotCandidates = useMemo(
    () => candidateLocations.filter((c) => c.kind === "parking_lot"),
    [candidateLocations],
  );
  const streetParkingCandidates = useMemo(
    () => candidateLocations.filter((c) => c.kind === "street_parking"),
    [candidateLocations],
  );
  const parkingLotCount = parkingLotCandidates.length;
  const streetParkingCount = streetParkingCandidates.length;
  // Prefer the map-stats spaces count when available (whole-map scan); fall
  // back to summing per-lot space_count primitives.
  const parkingSpacesFromCandidates = useMemo(() => {
    let total = 0;
    for (const lot of parkingLotCandidates) {
      for (const ev of lot.evidence) {
        const n = ev.primitives?.space_count;
        if (typeof n === "number") total += n;
      }
    }
    return total > 0 ? total : null;
  }, [parkingLotCandidates]);
  const parkingSpaces = parkingSpacesFromStats ?? parkingSpacesFromCandidates;
  // Street parking length: sum of per-candidate length_m primitives.
  const streetParkingLengthM = useMemo(() => {
    let total = 0;
    for (const sp of streetParkingCandidates) {
      for (const ev of sp.evidence) {
        const n = ev.primitives?.length_m;
        if (typeof n === "number") total += n;
      }
    }
    return total > 0 ? total : null;
  }, [streetParkingCandidates]);

  // Fly-by videos, each paired with its auto-generated low-res preview clip when
  // one exists (matched by deriving the preview key from the original mp4 key,
  // identical to the map-flyby-preview Lambda). The static map thumbnail is used
  // as the preview poster while the first frame loads.
  const thumbnailUri =
    asset.artifacts.find((a) => a.artifact_type === "thumbnail")?.uri ?? null;
  const previewUriByKey = new Map<string, string>();
  for (const a of asset.artifacts) {
    if (a.artifact_type !== FLYBY_PREVIEW_ARTIFACT_TYPE) continue;
    const key = s3KeyFromUri(a.uri);
    if (key) previewUriByKey.set(key, a.uri);
  }
  const mp4Artifacts = asset.artifacts
    .filter((a) => a.artifact_type === "mp4")
    .map((a) => {
      const key = s3KeyFromUri(a.uri);
      const previewKey = key ? flybyPreviewKeyForOriginalKey(key) : null;
      const previewUri = previewKey ? previewUriByKey.get(previewKey) ?? null : null;
      return { uri: a.uri, artifact_type: a.artifact_type, label: a.label, previewUri };
    });

  const hasExtractedMetadata = Boolean(
    asset.map_source ||
      asset.map_coordinate_ref ||
      asset.place_context ||
      asset.map_stats ||
      asset.metadata_last_populated_at,
  );

  const tags = useMemo(() => asset.tags ?? [], [asset.tags]);
  const familyGroups = useMemo(
    () => buildScenarioFamilyGroups(tags, candidateLocations),
    [tags, candidateLocations],
  );
  const totalHighConfidence = useMemo(
    () => candidateLocations.filter((c) => c.confidence >= 0.85).length,
    [candidateLocations],
  );
  const visibleFamilies = showAllFamilies ? familyGroups : familyGroups.slice(0, 6);

  return (
    <div className="space-y-5">
      {/* Map name + location + description */}
      <section>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-snug">{asset.name}</h2>
            {(() => {
              const place = asset.place_context;
              const location = [place?.city, place?.state, place?.country]
                .filter((s): s is string => Boolean(s && s.trim()))
                .join(", ");
              if (!location) return null;
              return (
                <p className="mt-0.5 text-[11px] text-muted-foreground">{location}</p>
              );
            })()}
          </div>
          <CopyButton
            text={asset.map_asset_id}
            label="ID"
            title={`Copy map ID: ${asset.map_asset_id}`}
          />
        </div>
        {asset.description && (
          <div className="mt-1">
            <p
              className={cn(
                "text-xs leading-relaxed text-muted-foreground",
                !descExpanded && "line-clamp-2",
              )}
            >
              {asset.description}
            </p>
            <button
              type="button"
              onClick={() => setDescExpanded((o) => !o)}
              className="mt-0.5 text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              {descExpanded ? "Show less" : "Show more"}
            </button>
          </div>
        )}
      </section>

      {/* Hero media */}
      {mp4Artifacts.length > 0 && onViewArtifact && (
        <VideosSection
          open={videosOpen}
          onToggleOpen={() => setVideosOpen((o) => !o)}
          mp4Artifacts={mp4Artifacts}
          assetId={asset.map_asset_id}
          thumbnailUri={thumbnailUri}
          onViewArtifact={onViewArtifact}
        />
      )}

      {/* Quick stats — same card for both 2D and 3D views */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Quick Stats
          </h3>
          <button
            type="button"
            onClick={onSwitchToStatsTab}
            className="flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 transition-colors"
          >
            View all
            <ChevronRight className="size-3" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <QuickStatCard
            icon={<Route className="size-4" />}
            value={mileageKm != null ? `${mileageKm.toFixed(1)} km` : "—"}
            label="Roads"
            tooltip={[
              mileageKm != null ? `Centerline length: ${mileageKm.toFixed(1)} km` : null,
              speedLimits && speedLimits.length > 0 ? `Speed limits (mph): ${speedLimits.join(", ")}` : null,
              gradeAbove4Km != null ? `Roads above 4% grade: ${gradeAbove4Km.toFixed(1)} km` : null,
              maxGrade != null ? `Max road grade: ${maxGrade}%` : null,
            ].filter((l): l is string => l != null)}
          />
          <QuickStatCard
            icon={<GitFork className="size-4" />}
            value={junctions != null ? String(junctions) : "—"}
            label="Junctions"
            tooltip={signalJunctions != null ? [
              junctions != null ? `${junctions} junctions` : null,
              `${signalJunctions} signal-controlled junctions`,
              `${stopJunctions ?? 0} stop-sign controlled junctions`,
            ].filter((l): l is string => l != null) : undefined}
          />
          <QuickStatCard
            icon={<PersonStanding className="size-4" />}
            value={sidewalkKm != null ? `${sidewalkKm.toFixed(1)} km` : "—"}
            label="Sidewalks"
          />
          <QuickStatCard
            icon={<Footprints className="size-4" />}
            value={crosswalks != null ? String(crosswalks) : "—"}
            label="Crosswalks"
            tooltip={
              crosswalks != null
                ? [
                    `${crosswalks} total crosswalks`,
                    `${inHouseCrosswalks ?? 0} in-house annotated crosswalks`,
                    `${overtureCrosswalks} third party sourced crosswalks`,
                  ]
                : undefined
            }
          />
          <QuickStatCard
            icon={<Bike className="size-4" />}
            value={bikeLaneKm != null ? `${bikeLaneKm.toFixed(1)} km` : "—"}
            label="Bike Lns"
          />
          <QuickStatCard
            icon={<SquareParking className="size-4" />}
            value={parkingSpaces != null ? String(parkingSpaces) : "—"}
            label="Parking"
            tooltip={[
              parkingSpaces != null
                ? `${parkingSpaces} parking space${parkingSpaces === 1 ? "" : "s"}`
                : null,
              `${parkingLotCount} parking lot${parkingLotCount === 1 ? "" : "s"}`,
              `${streetParkingCount} street parking location${streetParkingCount === 1 ? "" : "s"}`,
              streetParkingLengthM != null
                ? `${(streetParkingLengthM / 1000).toFixed(2)} km of street parking`
                : parkingLaneKm != null
                  ? `${parkingLaneKm.toFixed(1)} km of street parking`
                  : null,
            ].filter((l): l is string => l != null)}
          />
        </div>
      </section>

      {/* Scenario Insights */}
      {(tags.length > 0 || candidateLocations.length > 0 || candidateLocationsLoading) && (
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Scenario Insights
            </h3>
            <button
              type="button"
              onClick={() => onSwitchToInsightsTab()}
              className="flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 transition-colors"
            >
              View all
              <ChevronRight className="size-3" />
            </button>
          </div>

          {/* Stats row */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            <span className="inline-flex items-center gap-1 rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
              {candidateLocationsLoading ? (
                <>
                  <Loader2 className="size-2.5 animate-spin" aria-hidden="true" />
                  <span>Loading locations…</span>
                </>
              ) : (
                <>
                  {candidateLocations.length} location{candidateLocations.length !== 1 ? "s" : ""}
                </>
              )}
            </span>
            <span className="inline-flex items-center rounded-full bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground">
              {familyGroups.length} scenario {familyGroups.length !== 1 ? "families" : "family"}
            </span>
            {totalHighConfidence > 0 && (
              <span className="inline-flex items-center rounded-full bg-emerald-950/40 px-2 py-0.5 text-[10px] text-emerald-400 border border-emerald-700/30">
                {totalHighConfidence} high-confidence
              </span>
            )}
          </div>

          {/* Family summary cards — 2 columns */}
          <TooltipProvider delayDuration={200}>
            <div className="grid grid-cols-2 gap-2">
              {visibleFamilies.map((group) => {
                const Icon = getFamilyIcon(group.family);
                const tagCount = group.tags.length;
                const locCount = group.candidates.length;
                return (
                  <Tooltip key={group.family.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onSwitchToInsightsTab(group.family.id)}
                        className="min-w-0 rounded-lg border border-border bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
                      >
                        <div className="flex items-center gap-2">
                          <Icon className="size-3.5 text-primary shrink-0" />
                          <span className="truncate text-xs font-medium text-foreground">{group.family.name}</span>
                        </div>
                        <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                          {locCount} location{locCount !== 1 ? "s" : ""}, {tagCount} tag{tagCount !== 1 ? "s" : ""}
                        </p>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs space-y-1 text-xs leading-relaxed">
                      <div>
                        <span className="font-semibold">Scenario Family:</span> {group.family.name}
                      </div>
                      <div>
                        <span className="font-semibold">Description:</span> {group.family.description}
                      </div>
                      <div>
                        {tagCount} tag{tagCount !== 1 ? "s" : ""}, {locCount} location{locCount !== 1 ? "s" : ""}
                      </div>
                      <div className="text-muted-foreground">Click to inspect candidate locations</div>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>

          {/* Expand / collapse remaining families */}
          {familyGroups.length > 6 && (
            <button
              type="button"
              onClick={() => setShowAllFamilies((o) => !o)}
              className="mt-2 flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80 transition-colors"
            >
              {showAllFamilies
                ? "Show fewer"
                : `+${familyGroups.length - 6} more ${familyGroups.length - 6 !== 1 ? "families" : "family"}`}
              <ChevronRight className={cn("size-3 transition-transform", showAllFamilies && "rotate-90")} />
            </button>
          )}
        </section>
      )}

      {/* Map Provenance */}
      <MapMetadataSection
        open={metadataOpen}
        onToggleOpen={() => setMetadataOpen((o) => !o)}
        asset={asset}
        hasExtractedMetadata={hasExtractedMetadata}
        showPopulateMetadata={false}
        populateBusy={populateBusy}
        populateErr={populateErr}
        onPopulateMetadata={onPopulateMetadata}
        copiedKey={copiedKey}
        onCopy={copy}
        title="Source Metadata"
        enrichment={enrichment}
      />

      {/* Artifacts */}
      {asset.artifacts.length > 0 && (
        <ArtifactsSection
          open={artifactsOpen}
          onToggleOpen={() => setArtifactsOpen((o) => !o)}
          artifacts={asset.artifacts}
          assetId={asset.map_asset_id}
          onViewArtifact={onViewArtifact}
        />
      )}

    </div>
  );
}
