"use client";

import { useMemo, useState } from "react";
import {
  ArrowRight,
  Bike,
  Bug,
  Bus,
  Check,
  ChevronRight,
  Cross,
  Footprints,
  Fuel,
  Gauge,
  GitFork,
  Hotel,
  Loader2,
  Map,
  MapPin,
  MoreHorizontal,
  Mountain,
  PersonStanding,
  Plane,
  Play,
  Route,
  School,
  ShoppingBag,
  SquareParking,
  Store,
  Target,
  Train,
  UtensilsCrossed,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/app/components/ui/tooltip";
import { cn } from "@/app/lib/utils";
import type { MapSearchResult, SearchFilterChip, SearchObjectFamily } from "@/app/lib/maps/search/map-search";
import { SearchExamplesPanel } from "./SearchExamplesPanel";
import { CopyJsonButton } from "./CopyJsonButton";
import { SearchInputBox } from "./SearchInputBox";

interface SearchResultsTabProps {
  draftQuery: string;
  query: string;
  chips: SearchFilterChip[];
  results: MapSearchResult[];
  /** Leftover tokens after family / semantic aliases consume their matches — surfaced in the debug panel. */
  freeText?: string[];
  selectedResultId: string | null;
  /**
   * Object id of the related ref or topology path step the user has pinned
   * for emphasized rendering on the map. Only one target is highlighted at
   * a time and it's scoped to `selectedResultId` — picking a new result
   * clears it. `null` means "no pinned target", which is the default.
   */
  highlightedRelatedObjectId?: string | null;
  /** True while the underlying corpus (candidates + road network + enrichment) is still loading. */
  loading?: boolean;
  onDraftQueryChange: (value: string) => void;
  onSubmitSearch: (nextQuery?: string) => void;
  onSelectResult: (id: string) => void;
  onZoomToResult: (id: string) => void;
  onUseInScenario: (id: string) => void;
  /** Fired when a result card is hovered (id) or unhovered (null). */
  onHoverResult?: (id: string | null) => void;
  /**
   * Toggle the on-map highlight for a related-ref or path-step. The first
   * arg is the parent result so the parent can promote it to selected when
   * the user picks a target on a card that wasn't already focused. Pass
   * `null` for `objectId` to clear (used by the toggle-off path).
   */
  onToggleHighlightRelated?: (resultId: string, objectId: string | null) => void;
  /** When true, the search input auto-focuses on mount. */
  autoFocus?: boolean;
}

export function formatFamilyLabel(family: SearchObjectFamily): string {
  switch (family) {
    case "junction":
      return "Junction";
    case "street":
      return "Street";
    case "poi":
      return "Point Of Interest";
    case "address":
      return "Address";
    default:
      return family;
  }
}

export function formatRelation(
  op:
    | "near"
    | "adjacent_to"
    | "within"
    | "leads_to"
    | "connected_to"
    | "upstream_of"
    | "downstream_of",
): string {
  switch (op) {
    case "near":
      return "Near";
    case "adjacent_to":
      return "Adjacent to";
    case "within":
      return "Within";
    case "leads_to":
      return "Leading to";
    case "connected_to":
      return "Connected to";
    case "upstream_of":
      return "Before";
    case "downstream_of":
      return "After";
    default:
      return op;
  }
}

/**
 * Compact debug rendering of a MapSearchDocumentGeometryRef so the debug row
 * can show *why* a result lands where it does on the map — the arrow
 * endpoint is a function of the ref's kind and the ids it carries.
 */
function formatGeometryRef(
  ref: MapSearchResult["geometryReference"] | undefined,
): string {
  if (!ref) return "none";
  switch (ref.kind) {
    case "candidate":
      return `candidate[${ref.candidateId ?? "?"}]`;
    case "geojson_feature":
      return `geojson_feature[${ref.geojsonFeatureId ?? "?"}]`;
    case "road_aggregate":
      return `road_aggregate[${ref.geojsonFeatureIds?.length ?? 0}]`;
    case "overlay_feature":
      return `overlay[${ref.overlayLayerId ?? "?"}:${ref.overlayFeatureId ?? "?"}]`;
    default:
      return ref.kind;
  }
}

function formatCentroid(centroid: [number, number] | undefined): string {
  if (!centroid) return "[?,?]";
  return `[${centroid[0].toFixed(5)}, ${centroid[1].toFixed(5)}]`;
}

export function iconForSubtype(subtype: string): LucideIcon {
  switch (subtype) {
    case "Road junction":
      return GitFork;
    case "Street segment":
      return Route;
    case "Steep road":
      return Mountain;
    case "Bike corridor":
    case "Shared bike corridor":
    case "Bike merge corridor":
    case "Protected bike corridor":
      return Bike;
    case "High-speed road":
      return Gauge;
    case "Pedestrian corridor":
      return PersonStanding;
    case "Crosswalk zone":
      return Footprints;
    case "Parking area":
      return SquareParking;
    case "Parking lot":
      return SquareParking;
    case "Bus stop":
      return Bus;
    case "School frontage":
      return School;
    case "Hospital approach":
      return Cross;
    case "Gas station approach":
      return Fuel;
    case "Retail frontage":
      return Store;
    case "Restaurant frontage":
      return UtensilsCrossed;
    case "Hotel approach":
      return Hotel;
    case "Airport approach":
      return Plane;
    case "Shopping mall approach":
      return ShoppingBag;
    case "Transit stop corridor":
      return Train;
    default:
      return MapPin;
  }
}

/**
 * Maps a sidecar object `kind` (junction/street/poi-subtype) to an icon for
 * the topology-path chain. We can't reuse `iconForSubtype` because the path
 * carries `kind` (lowercased, machine-readable), not the user-facing subtype
 * label, and we want the chain to render even for streets/junctions that
 * don't have a subtype mapping.
 */
function iconForPathKind(kind: string | undefined): LucideIcon {
  if (!kind) return MapPin;
  switch (kind) {
    case "junction":
      return GitFork;
    case "street":
    case "street_segment":
      return Route;
    case "bus_stop":
      return Bus;
    case "crosswalk_zone":
      return Footprints;
    case "parking_lot":
    case "parking_area":
      return SquareParking;
    case "school_frontage":
      return School;
    case "hospital_approach":
      return Cross;
    case "gas_station_approach":
      return Fuel;
    case "retail_frontage":
      return Store;
    case "restaurant_frontage":
      return UtensilsCrossed;
    case "hotel_approach":
      return Hotel;
    case "airport_approach":
      return Plane;
    case "shopping_mall_approach":
      return ShoppingBag;
    case "transit_stop_corridor":
      return Train;
    default:
      return MapPin;
  }
}

const TOPOLOGY_RELATIONS = new Set([
  "leads_to",
  "connected_to",
  "upstream_of",
  "downstream_of",
]);

interface TopologyPathChainProps {
  path: NonNullable<MapSearchResult["relatedObjectRefs"]>[number]["path"];
  truncated: boolean;
  /**
   * Object id currently pinned for on-map emphasis. When a path step's id
   * matches, its pill renders in the active style and the toggle button
   * shows the "remove highlight" affordance.
   */
  highlightedObjectId?: string | null;
  /** Toggle handler — pass `null` to clear, an objectId to set. Receives the path-step id. */
  onToggleHighlight?: (objectId: string | null) => void;
}

/**
 * Debug-mode rendering of the topology relation's reconstructed graph
 * route. Outside debug, the chain is hidden entirely — the on-map line
 * plus arrow markers tell the visual story. In debug we keep the chain so
 * each step's canonical object id is inspectable, plus a target button on
 * each step that spotlights it on the map (subject→step landing ring).
 *
 * The first pill is the subject (already named above as the result card)
 * but we keep it in the chain so the eye has a starting anchor. When the
 * executor truncated the path, we drop a `…` between the head and tail
 * slices so the gap is visible rather than silent.
 */
function TopologyPathChain({
  path,
  truncated,
  highlightedObjectId,
  onToggleHighlight,
}: TopologyPathChainProps) {
  if (!path || path.length === 0) return null;
  // Truncation in the executor keeps `floor(MAX/2)` head + `MAX - floor(MAX/2)`
  // tail nodes; the gap sits right after the head. We don't import the
  // constant to avoid coupling the UI to server-side numbers — the path
  // itself plus the `truncated` flag is enough to render it correctly.
  const headEnd = Math.floor(path.length / 2);
  return (
    <div className="flex flex-wrap items-center gap-1 pl-2 pt-0.5 text-[10px] text-muted-foreground">
      <span className="font-medium uppercase tracking-wide text-muted-foreground/80">
        Path
      </span>
      {path.map((step, idx) => {
        const StepIcon = iconForPathKind(step.kind);
        const isLast = idx === path.length - 1;
        const showEllipsisBefore = truncated && idx === headEnd;
        const stepHighlighted =
          !!highlightedObjectId && highlightedObjectId === step.objectId;
        return (
          <div
            key={`${step.objectId}-${idx}`}
            className="flex items-center gap-1"
          >
            {showEllipsisBefore ? (
              <>
                <MoreHorizontal
                  className="size-3 text-muted-foreground/60"
                  aria-label="path truncated"
                />
                <ChevronRight
                  className="size-2.5 text-muted-foreground/60"
                  aria-hidden="true"
                />
              </>
            ) : null}
            <div
              className={cn(
                "flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors",
                stepHighlighted
                  ? "border-primary/60 bg-primary/15"
                  : "border-border/40 bg-muted/40",
              )}
              title={`${step.title ?? step.objectId} (${step.cumulativeM} m from subject)`}
            >
              <StepIcon className="size-2.5 shrink-0" aria-hidden="true" />
              <span className="max-w-[200px] truncate font-mono text-muted-foreground/90">
                {step.objectId}
              </span>
              <span className="font-mono text-muted-foreground/80">
                {step.cumulativeM}m
              </span>
              {onToggleHighlight ? (
                <HighlightToggleButton
                  active={stepHighlighted}
                  size="xs"
                  label={
                    stepHighlighted
                      ? `Stop highlighting ${step.objectId} on the map`
                      : `Highlight ${step.objectId} on the map`
                  }
                  onClick={() =>
                    onToggleHighlight(stepHighlighted ? null : step.objectId)
                  }
                />
              ) : null}
            </div>
            {!isLast ? (
              <ChevronRight
                className="size-2.5 shrink-0 text-muted-foreground/60"
                aria-hidden="true"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface HighlightToggleButtonProps {
  active: boolean;
  label: string;
  onClick: () => void;
  /** `xs` is for the path-chain pills which run at text-[10px]; default for the larger related-ref pill. */
  size?: "default" | "xs";
}

/**
 * Small icon button on a related-ref or path-step pill that toggles whether
 * that target is the on-map highlight. Stops click propagation so clicking
 * the icon doesn't also fire the parent card's "select this result" handler
 * — only the highlight changes (the parent will promote the result to
 * selected if needed via its `onToggleHighlightRelated` handler).
 */
export function HighlightToggleButton({
  active,
  label,
  onClick,
  size = "default",
}: HighlightToggleButtonProps) {
  const dimensions = size === "xs" ? "size-4" : "size-5";
  const iconSize = size === "xs" ? "size-2.5" : "size-3";
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        "flex shrink-0 items-center justify-center rounded transition-colors",
        dimensions,
        active
          ? "bg-primary/30 text-primary hover:bg-primary/40"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Target className={cn(iconSize, "shrink-0")} aria-hidden="true" />
    </button>
  );
}

export function SearchResultsTab({
  draftQuery,
  query,
  chips,
  results,
  freeText = [],
  selectedResultId,
  highlightedRelatedObjectId = null,
  loading = false,
  onDraftQueryChange,
  onSubmitSearch,
  onSelectResult,
  onZoomToResult,
  onUseInScenario,
  onHoverResult,
  onToggleHighlightRelated,
  autoFocus = false,
}: SearchResultsTabProps) {
  const [showDebug, setShowDebug] = useState(false);

  // When a multi-facet query returns zero results, offer each facet as a
  // standalone sub-query the user can click to re-run. Helps the user
  // discover that their map has e.g. medium parking lots even though there
  // are no "large" ones matching "large parking lot".
  const alternativeQueries = useMemo(() => {
    if (!query.trim() || loading || results.length > 0) return [];
    const total = chips.length + freeText.length;
    if (total <= 1) return [];
    const alts: string[] = [];
    for (const chip of chips) alts.push(chip.label);
    for (const token of freeText) {
      alts.push(token.includes(" ") ? `"${token}"` : token);
    }
    const seen = new Set<string>();
    return alts.filter((alt) => {
      const key = alt.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [chips, freeText, query, loading, results.length]);

  if (!query.trim()) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 space-y-4 px-4 pt-4 pb-3">
          <SearchInputBox
            draftQuery={draftQuery}
            onDraftQueryChange={onDraftQueryChange}
            onSubmitSearch={onSubmitSearch}
            autoFocus={autoFocus}
          />

          <div className="space-y-1">
            <p className="text-sm font-semibold text-foreground">Try a spatial query</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Click a chip to run it, or build your own query — every junction,
              street, and feature on the map is indexed.
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <SearchExamplesPanel onRunExample={onSubmitSearch} />
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex h-full flex-col space-y-3 p-4">
        <div className="space-y-2.5">
          <SearchInputBox
            draftQuery={draftQuery}
            onDraftQueryChange={onDraftQueryChange}
            onSubmitSearch={onSubmitSearch}
            autoFocus={autoFocus}
          />
          {showDebug ? (
            <div className="space-y-2 rounded-md border border-dashed border-border/70 bg-secondary/20 p-2 text-[11px]">
              <p className="text-muted-foreground">
                <span className="font-semibold text-foreground">Parsed query</span>
                {" — "}
                chips: {chips.length}, free-text: {freeText.length}, results: {results.length}
              </p>
              {chips.length > 0 ? (
                <div>
                  <p className="text-muted-foreground">Chips</p>
                  <div className="flex flex-wrap gap-1">
                    {chips.map((chip) => (
                      <Badge
                        key={`debug-${chip.id}`}
                        variant="outline"
                        className="px-1.5 py-0 font-mono text-[10px]"
                      >
                        {chip.id}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
              {freeText.length > 0 ? (
                <div>
                  <p className="text-muted-foreground">Free-text tokens</p>
                  <div className="flex flex-wrap gap-1">
                    {freeText.map((token) => (
                      <Badge
                        key={`ft-${token}`}
                        variant="outline"
                        className="px-1.5 py-0 font-mono text-[10px]"
                      >
                        {token}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {chips.length > 0 || freeText.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 px-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setShowDebug((prev) => !prev)}
                    aria-label="Toggle search debug"
                    aria-pressed={showDebug}
                    className={cn(
                      "inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/40 hover:text-foreground",
                      showDebug && "bg-secondary/60 text-foreground",
                    )}
                  >
                    <Bug className="size-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {showDebug ? "Hide debug" : "Show debug"}
                </TooltipContent>
              </Tooltip>
              {chips.map((chip) =>
                chip.kind === "relation" && chip.operatorLabel && chip.objectLabel ? (
                  <span
                    key={chip.id}
                    className="inline-flex items-center overflow-hidden rounded-full border border-primary/40 bg-primary/10 text-[11px] font-normal"
                    title={`Spatial relation: ${chip.operatorLabel} ${chip.objectLabel}`}
                  >
                    <span className="px-1.5 py-0 text-primary">
                      {chip.operatorLabel}
                    </span>
                    <span className="px-1.5 py-0 text-foreground bg-primary/10">
                      {chip.objectLabel}
                    </span>
                  </span>
                ) : (
                  <Badge
                    key={chip.id}
                    variant="secondary"
                    className="border-transparent bg-secondary/50 px-1.5 py-0 text-[11px] font-normal text-foreground"
                  >
                    {chip.label}
                  </Badge>
                ),
              )}
              {freeText.map((token) => (
                <Badge
                  key={`free-${token}`}
                  variant="outline"
                  className="border-dashed bg-transparent px-1.5 py-0 text-[11px] font-normal text-muted-foreground"
                  title="Free-text token — not matched to a structured filter"
                >
                  {token}
                </Badge>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border pt-2">
          {loading ? (
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Loading map data…
            </p>
          ) : (
            <div className="mb-2 flex items-center justify-between text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <span>Results ({results.length})</span>
              <CopyJsonButton
                payload={{ query, chips, freeText: freeText ?? [], results }}
                disabled={results.length === 0}
                label="Copy results as JSON"
              />
            </div>
          )}
          <div className="flex-1 overflow-y-auto">
            <div className="space-y-2 pr-2">
              {results.map((result) => {
                const selected = result.id === selectedResultId;
                const ResultIcon = iconForSubtype(result.subtype);
                return (
                  <div
                    key={result.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selected}
                    onClick={() => onSelectResult(result.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectResult(result.id);
                      }
                    }}
                    onMouseEnter={() => onHoverResult?.(result.id)}
                    onMouseLeave={() => onHoverResult?.(null)}
                    onFocus={() => onHoverResult?.(result.id)}
                    onBlur={() => onHoverResult?.(null)}
                    className={cn(
                      "w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-all",
                      selected
                        ? "border-primary/50 bg-primary/10"
                        : "border-border bg-secondary/20 hover:bg-secondary/40",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <ResultIcon
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-label={`${result.subtype} icon`}
                      />
                      <p className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                        {result.title}
                      </p>
                      {selected ? <Check className="size-4 shrink-0 text-primary" /> : null}
                    </div>

                    <div className="mt-1.5 grid grid-cols-3 gap-2 text-[11px]">
                      <div className="min-w-0">
                        <p className="truncate text-muted-foreground">Type</p>
                        <p className="truncate font-medium text-foreground">
                          {formatFamilyLabel(result.objectFamily)}
                        </p>
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-muted-foreground">SubType</p>
                        <p className="truncate font-medium text-foreground">{result.subtype}</p>
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-muted-foreground">Confidence</p>
                        <p className="truncate font-medium text-emerald-400">
                          {Math.round(result.candidateConfidence * 100)}%
                        </p>
                      </div>
                    </div>

                    {result.exactMapAttributes.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {result.exactMapAttributes.map((fact) => (
                          <Badge
                            key={fact}
                            variant="secondary"
                            className="border-transparent bg-secondary/50 px-2 py-0.5 text-[9px] text-foreground"
                          >
                            {fact}
                          </Badge>
                        ))}
                      </div>
                    ) : null}

                    {result.relatedObjectRefs && result.relatedObjectRefs.length > 0 ? (
                      <div className="mt-1.5 space-y-1">
                        {result.relatedObjectRefs.slice(0, 2).map((ref) => {
                          const RefIcon = ref.subtype ? iconForSubtype(ref.subtype) : MapPin;
                          const refHighlighted =
                            highlightedRelatedObjectId === ref.objectId;
                          return (
                            <div
                              key={`${result.id}-rel-${ref.objectId}`}
                              className="space-y-0.5"
                            >
                              <div
                                className={cn(
                                  "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors",
                                  refHighlighted
                                    ? "border-primary/60 bg-primary/15"
                                    : "border-primary/20 bg-primary/5",
                                )}
                                title={`${formatRelation(ref.relation)} ${ref.title ?? ref.objectId}${ref.distance_m != null ? ` (${ref.distance_m} m)` : ""}`}
                              >
                                <span className="flex items-center gap-1 text-primary">
                                  <ArrowRight className="size-3" aria-hidden="true" />
                                  <span className="font-medium">{formatRelation(ref.relation)}</span>
                                </span>
                                <RefIcon
                                  className="size-3 shrink-0 text-muted-foreground"
                                  aria-hidden="true"
                                />
                                <span className="min-w-0 flex-1 truncate text-foreground">
                                  {ref.title ?? ref.objectId}
                                </span>
                                {ref.distance_m != null ? (
                                  <span className="shrink-0 text-muted-foreground">
                                    {ref.distance_m} m
                                  </span>
                                ) : null}
                                {onToggleHighlightRelated ? (
                                  <HighlightToggleButton
                                    active={refHighlighted}
                                    label={
                                      refHighlighted
                                        ? `Stop highlighting ${ref.title ?? ref.objectId} on the map`
                                        : `Highlight ${ref.title ?? ref.objectId} on the map`
                                    }
                                    onClick={() =>
                                      onToggleHighlightRelated(
                                        result.id,
                                        refHighlighted ? null : ref.objectId,
                                      )
                                    }
                                  />
                                ) : null}
                              </div>
                              {showDebug &&
                              TOPOLOGY_RELATIONS.has(ref.relation) &&
                              ref.path &&
                              ref.path.length > 2 ? (
                                <TopologyPathChain
                                  path={ref.path}
                                  truncated={ref.pathTruncated === true}
                                  highlightedObjectId={highlightedRelatedObjectId}
                                  onToggleHighlight={
                                    onToggleHighlightRelated
                                      ? (objectId) =>
                                          onToggleHighlightRelated(result.id, objectId)
                                      : undefined
                                  }
                                />
                              ) : null}
                              {showDebug ? (
                                <div className="flex flex-wrap items-center gap-1 pl-2 text-[10px] text-muted-foreground/80">
                                  <span className="font-mono">{ref.objectId}</span>
                                  <span>·</span>
                                  <span className="font-mono">
                                    {formatGeometryRef(ref.geometryReference)}
                                  </span>
                                  <span>·</span>
                                  <span className="font-mono">{formatCentroid(ref.centroid)}</span>
                                </div>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}

                    {showDebug ? (
                      <div className="mt-1.5 space-y-0.5 text-[10px] text-muted-foreground">
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="font-mono">{result.id}</span>
                          <span>·</span>
                          <span className="font-mono">
                            {formatGeometryRef(result.geometryReference)}
                          </span>
                          <span>·</span>
                          <span className="font-mono">{formatCentroid(result.centroid)}</span>
                        </div>
                        {result.matchReasons.length > 0 ? (
                          <div className="truncate">
                            match: {result.matchReasons.slice(0, 3).join(", ")}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="mt-2 flex items-center justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-7"
                            onClick={(event) => {
                              event.stopPropagation();
                              onZoomToResult(result.id);
                            }}
                            aria-label="Zoom on Map"
                          >
                            <Map className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs">
                          Zoom on Map
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-7"
                            onClick={(event) => {
                              event.stopPropagation();
                              onUseInScenario(result.id);
                            }}
                            aria-label="Use in Scenario"
                          >
                            <Play className="size-3.5" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" className="text-xs">
                          Use in Scenario
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
              {results.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
                  {loading ? (
                    <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" aria-hidden="true" /> Loading map data…
                    </p>
                  ) : (
                    <>
                      <p className="text-sm font-medium text-foreground">No matching locations</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Try broadening the query or removing a few constraints.
                      </p>
                      {alternativeQueries.length > 0 ? (
                        <div className="mt-3 flex flex-col items-center gap-1.5">
                          <p className="text-[11px] text-muted-foreground">Or try each term on its own:</p>
                          <div className="flex flex-wrap justify-center gap-1.5">
                            {alternativeQueries.map((alt) => (
                              <button
                                key={alt}
                                type="button"
                                onClick={() => {
                                  onDraftQueryChange(alt);
                                  onSubmitSearch(alt);
                                }}
                                className="rounded-md border border-border bg-secondary/30 px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10"
                              >
                                {alt}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
