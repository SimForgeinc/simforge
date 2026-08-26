"use client";

import { useState, useCallback, useMemo } from "react";
import type {
  CandidateLocation,
  MapAssetEnrichmentSnapshot,
  MapStats,
} from "@simforge-oss/studio-shared";
import { Route, Gauge, PersonStanding, Bike, SquareParking, GitFork, ArrowUpDown, ChevronRight, ChevronsUpDown, Database } from "lucide-react";
import { cn } from "@/app/lib/utils";

function fmt(n: number | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtKm(meters: number | undefined): string {
  if (meters == null) return "—";
  return (meters / 1000).toFixed(1) + " km";
}

function CollapsibleSection({
  icon: Icon,
  label,
  open,
  onToggle,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 pb-1.5 group"
        aria-expanded={open}
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <Icon className="size-3 text-muted-foreground shrink-0" />
        <span className="text-xs font-semibold">{label}</span>
      </button>
      {open && <div className="space-y-0.5 ml-[18px]">{children}</div>}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium tabular-nums text-right">{value}</span>
    </div>
  );
}

type SectionKey = "road" | "pedestrian" | "cyclist" | "parking" | "junction" | "signals" | "turns" | "third_party";

const ALL_SECTIONS: SectionKey[] = ["road", "pedestrian", "cyclist", "parking", "junction", "signals", "turns", "third_party"];

// Display order + label for third-party feature_counts. Order is curated so
// related categories cluster together (transit/transit_stop, retail/mall,
// services/government). Layers omitted from the count display when 0.
const THIRD_PARTY_FEATURE_LABELS: Array<{ key: keyof NonNullable<MapAssetEnrichmentSnapshot["summary"]["feature_counts"]>; label: string }> = [
  { key: "bus_stops", label: "Bus stops" },
  { key: "transit_stop", label: "Transit hubs" },
  { key: "schools", label: "Schools" },
  { key: "hospitals", label: "Hospitals" },
  { key: "gas_stations", label: "Gas stations" },
  { key: "parking_lots", label: "Parking lots" },
  { key: "retail", label: "Retail" },
  { key: "shopping_mall", label: "Shopping malls" },
  { key: "restaurant", label: "Restaurants" },
  { key: "hotel", label: "Hotels" },
  { key: "airport", label: "Airports" },
  { key: "crosswalks", label: "Crosswalks" },
];

/** Render detailed map statistics grouped by road network, signals, junctions, and infrastructure. */
export function MapStatsDisplay({
  stats,
  candidateLocations,
  overtureCrosswalkSurvivors,
  enrichment,
}: {
  stats: MapStats;
  /**
   * Optional candidate locations for this map. When provided, the parking
   * section surfaces counts of detected parking lots and street-parking
   * candidates alongside the map-metadata-derived stats.
   */
  candidateLocations?: CandidateLocation[];
  /**
   * Count of Overture crosswalks that survive dedup against the in-house XODR
   * crosswalks (15 m threshold, same as the search-index pipeline). When > 0
   * the Pedestrian Infrastructure section shows the merged total alongside
   * the in-house and Overture splits. Omit / 0 keeps the legacy XODR-only row.
   */
  overtureCrosswalkSurvivors?: number;
  /**
   * Optional enrichment snapshot. When provided, a "Third-party data" section
   * surfaces the per-category counts plus required Overture attribution, so
   * users can see at a glance how much of the map's POI coverage came from
   * the licensed Overture corpus. The section is omitted entirely when no
   * enrichment exists or when feature_counts is empty.
   */
  enrichment?: MapAssetEnrichmentSnapshot | null;
}) {
  const rn = stats.road_network;
  const sig = stats.signalization;
  const fi = stats.feature_inventory;

  const parkingLotCount = useMemo(
    () => (candidateLocations ?? []).filter((c) => c.kind === "parking_lot").length,
    [candidateLocations],
  );
  const streetParkingCount = useMemo(
    () => (candidateLocations ?? []).filter((c) => c.kind === "street_parking").length,
    [candidateLocations],
  );
  const hasParkingCandidateCounts = candidateLocations != null && (parkingLotCount > 0 || streetParkingCount > 0);

  const jd = rn?.junction_road_degree_counts;
  const tm = fi?.turn_movements;
  const uturnTotal = (tm?.uturn_left ?? 0) + (tm?.uturn_right ?? 0);

  // All sections start expanded
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(ALL_SECTIONS));

  const toggle = useCallback((key: SectionKey) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const allExpanded = openSections.size === ALL_SECTIONS.length;

  function toggleAll() {
    setOpenSections(allExpanded ? new Set() : new Set(ALL_SECTIONS));
  }

  return (
    <div className="space-y-3 pt-1">
      {/* Expand / Collapse all */}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={toggleAll}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronsUpDown className="size-3" />
          {allExpanded ? "Collapse all" : "Expand all"}
        </button>
      </div>

      {/* Road Network */}
      {rn && (
        <CollapsibleSection icon={Route} label="Road Network" open={openSections.has("road")} onToggle={() => toggle("road")}>
          <StatRow label="Junctions" value={fmt(rn.total_junctions)} />
          <StatRow label="Centerline length" value={fmtKm(rn.total_centerline_length_m)} />
          {rn.speed_limits_mph && rn.speed_limits_mph.length > 0 && (
            <StatRow
              label="Speed limits (mph)"
              value={
                <span className="flex flex-wrap gap-1 justify-end">
                  {rn.speed_limits_mph.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center rounded border border-border px-1.5 py-px text-[10px] font-medium"
                    >
                      {s}
                    </span>
                  ))}
                </span>
              }
            />
          )}
          <StatRow label="Road segments" value={fmt(rn.total_roads)} />
          {rn.max_grade_pct != null && (
            <StatRow label="Max grade" value={`${rn.max_grade_pct}%`} />
          )}
          {rn.length_above_4pct_grade_m != null && (
            <StatRow label="Roads above 4% grade" value={fmtKm(rn.length_above_4pct_grade_m)} />
          )}
        </CollapsibleSection>
      )}

      {/* Pedestrian Infrastructure */}
      {(rn?.sidewalk_length_m != null ||
        fi?.crosswalks != null) && (
        <CollapsibleSection icon={PersonStanding} label="Pedestrian Infrastructure" open={openSections.has("pedestrian")} onToggle={() => toggle("pedestrian")}>
          {rn?.sidewalk_length_m != null && (
            <StatRow label="Sidewalk length" value={fmtKm(rn.sidewalk_length_m)} />
          )}
          {fi?.crosswalks?.total != null && (
            <StatRow
              label="Crosswalks"
              value={
                overtureCrosswalkSurvivors && overtureCrosswalkSurvivors > 0 ? (
                  <>
                    {fmt(fi.crosswalks.total + overtureCrosswalkSurvivors)}
                    <span className="ml-1 text-muted-foreground">
                      ({fmt(fi.crosswalks.total)} in-house + {fmt(overtureCrosswalkSurvivors)} Overture)
                    </span>
                  </>
                ) : (
                  fmt(fi.crosswalks.total)
                )
              }
            />
          )}
        </CollapsibleSection>
      )}

      {/* Cyclists & Active Transport */}
      {(rn?.bike_lane_length_m != null) && (
        <CollapsibleSection icon={Bike} label="Cyclists & Active Transport" open={openSections.has("cyclist")} onToggle={() => toggle("cyclist")}>
          <StatRow label="Bike lane coverage" value={fmtKm(rn.bike_lane_length_m)} />
          {rn.shared_bike_lane_length_m != null && rn.shared_bike_lane_length_m > 0 && (
            <StatRow label="Shared bike lane coverage" value={fmtKm(rn.shared_bike_lane_length_m)} />
          )}
        </CollapsibleSection>
      )}

      {/* Parking */}
      {(fi?.parking_spaces != null || rn?.parking_lane_length_m != null || hasParkingCandidateCounts) && (
        <CollapsibleSection icon={SquareParking} label="Parking" open={openSections.has("parking")} onToggle={() => toggle("parking")}>
          {hasParkingCandidateCounts && (
            <>
              <StatRow label="Parking lots" value={fmt(parkingLotCount)} />
              <StatRow label="Street parking locations" value={fmt(streetParkingCount)} />
            </>
          )}
          {rn?.parking_lane_length_m != null && (
            <StatRow label="Street parking coverage" value={fmtKm(rn.parking_lane_length_m)} />
          )}
          {fi?.parking_spaces != null && (
            <StatRow label="Parking spaces" value={fmt(fi.parking_spaces)} />
          )}
        </CollapsibleSection>
      )}

      {/* Junction Complexity */}
      {jd && (
        <CollapsibleSection icon={GitFork} label="Junction Complexity" open={openSections.has("junction")} onToggle={() => toggle("junction")}>
          <StatRow label="Simple (≤2 roads)" value={fmt(jd["2_or_fewer"])} />
          <StatRow label="3-way" value={fmt(jd["3"])} />
          <StatRow label="4-way" value={fmt(jd["4"])} />
          <StatRow label="Complex (5+ roads)" value={fmt(jd["5_plus"])} />
        </CollapsibleSection>
      )}

      {/* Traffic Signals & Signs */}
      {sig && (
        <CollapsibleSection icon={Gauge} label="Traffic Signals & Signs" open={openSections.has("signals")} onToggle={() => toggle("signals")}>
          {/* Junction-level control counts (primary) with raw counts as secondary detail.
              Falls back to raw counts for maps that haven't been re-processed. */}
          {fi?.junctions?.signalized != null ? (
            <div>
              <StatRow label="Signalized Junctions" value={fmt(fi.junctions.signalized)} />
              {rn?.signal_breakdown?.traffic_lights != null && rn.signal_breakdown.traffic_lights > 0 && (
                <div className="ml-2">
                  <span className="text-[10px] text-muted-foreground/60">({fmt(rn.signal_breakdown.traffic_lights)} traffic lights)</span>
                </div>
              )}
            </div>
          ) : rn?.signal_breakdown?.traffic_lights != null && rn.signal_breakdown.traffic_lights > 0 ? (
            <StatRow label="Traffic Lights" value={fmt(rn.signal_breakdown.traffic_lights)} />
          ) : null}
          {fi?.junctions?.stop_sign_controlled != null ? (
            <div>
              <StatRow label="Stop Junctions" value={fmt(fi.junctions.stop_sign_controlled)} />
              {rn?.signal_breakdown?.stop_signs != null && rn.signal_breakdown.stop_signs > 0 && (
                <div className="ml-2">
                  <span className="text-[10px] text-muted-foreground/60">({fmt(rn.signal_breakdown.stop_signs)} stop signs)</span>
                </div>
              )}
            </div>
          ) : rn?.signal_breakdown?.stop_signs != null && rn.signal_breakdown.stop_signs > 0 ? (
            <StatRow label="Stop Signs" value={fmt(rn.signal_breakdown.stop_signs)} />
          ) : null}
          {fi?.junctions?.allway_stop != null && (
            <StatRow label="All-Way Stop Junctions" value={fmt(fi.junctions.allway_stop)} />
          )}
          {/* Remaining sign types (not junction-level) */}
          {rn?.signal_breakdown && (() => {
            const sb = rn.signal_breakdown;
            const rows: [string, number | undefined][] = [
              ["Yield Signs", sb.yield_signs],
              ["Speed Limit Signs", sb.speed_limit_signs],
              ["Regulatory Signs", sb.regulatory_signs],
              ["Turn Restrictions", sb.turn_restriction_signs],
              ["Parking Signs", sb.parking_signs],
              ["Warning Signs", sb.warning_signs],
              ["School Signs", sb.school_signs],
              ["Street Name Signs", sb.street_name_signs],
              ["Bus Stops", sb.bus_stops],
              ["Stop Lines", sb.stop_lines],
              ["Other Signs", sb.other_signs],
            ];
            const activeRows = rows.filter(([, v]) => v != null && v > 0);
            return activeRows.length > 0 ? (
              <>
                {activeRows.map(([label, value]) => (
                  <StatRow key={label} label={label} value={fmt(value)} />
                ))}
              </>
            ) : null;
          })()}
          <StatRow label="Total Signs & Signals" value={fmt(sig.signal_controlled_object_count)} />
          <StatRow
            label="Phase timing"
            value={
              sig.has_signal_phase_timing ? (
                <span className="inline-flex items-center rounded-sm bg-green-500/10 px-1.5 py-px text-[10px] font-medium text-green-600 dark:text-green-400">
                  Available
                </span>
              ) : (
                <span className="inline-flex items-center rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                  Not available
                </span>
              )
            }
          />
          {sig.junctions_with_phases != null && sig.junctions_with_phases > 0 && (
            <StatRow label="Junctions with phases" value={fmt(sig.junctions_with_phases)} />
          )}
          {sig.signal_phase_count != null && sig.signal_phase_count > 0 && (
            <StatRow label="Signal phases" value={fmt(sig.signal_phase_count)} />
          )}
        </CollapsibleSection>
      )}

      {/* Turn Types */}
      {tm != null && (
        <CollapsibleSection icon={ArrowUpDown} label="Turn Types" open={openSections.has("turns")} onToggle={() => toggle("turns")}>
          {tm.straight != null && (
            <StatRow label="Straight" value={fmt(tm.straight)} />
          )}
          {tm.left != null && (
            <StatRow label="Left Turns" value={fmt(tm.left)} />
          )}
          {tm.right != null && (
            <StatRow label="Right Turns" value={fmt(tm.right)} />
          )}
          {uturnTotal > 0 && (
            <StatRow label="U-Turns" value={fmt(uturnTotal)} />
          )}
        </CollapsibleSection>
      )}

      {/* Third-party data (Overture). Counted from the enrichment snapshot's
          summary.feature_counts. We only render the section when a non-zero
          feature exists so untagged maps don't get an empty rollup. */}
      {(() => {
        const enrichmentSummary = enrichment?.summary;
        const counts = enrichmentSummary?.feature_counts;
        if (!enrichmentSummary || !counts) return null;
        const rows = THIRD_PARTY_FEATURE_LABELS.map(({ key, label }) => ({
          label,
          count: counts[key] ?? 0,
        })).filter((r) => r.count > 0);
        if (rows.length === 0) return null;
        const total = rows.reduce((sum, r) => sum + r.count, 0);
        const provider = enrichmentSummary.provider;
        const release = enrichmentSummary.provider_release;
        const attribution = enrichmentSummary.attribution;
        const providerLabel =
          provider === "overture" ? "Overture Maps" : provider;
        return (
          <CollapsibleSection
            icon={Database}
            label="Third-party data"
            open={openSections.has("third_party")}
            onToggle={() => toggle("third_party")}
          >
            <StatRow
              label={`${providerLabel} (${release})`}
              value={`${fmt(total)} feature${total === 1 ? "" : "s"}`}
            />
            {rows.map(({ label, count }) => (
              <StatRow key={label} label={label} value={fmt(count)} />
            ))}
            {attribution && (
              <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground/80">
                {attribution}
              </p>
            )}
          </CollapsibleSection>
        );
      })()}
    </div>
  );
}
