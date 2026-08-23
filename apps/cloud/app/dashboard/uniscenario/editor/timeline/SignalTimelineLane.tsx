"use client";

import { useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { cn } from "@/app/lib/utils";
import {
  clipBoundaries,
  snapTimelineSeconds,
  TIMELINE_MIN_BAND_S,
  type SignalTimelineBand,
  type SignalTimelineRow,
  type StageTimelineRow,
} from "@/app/lib/uniscenario/signals";

import {
  formatSeconds,
  indicationFlashes,
  indicationLabel,
  indicationSwatch,
} from "../signals/indication-style";

/**
 * One junction's row on the timeline. Manifest #114.
 *
 * Lives here, in `editor/timeline/`, because it is a
 * lane inside the dock's own lane stack, not an overlay on top of it, and the dock
 * lays it out through `createTimelineLaneRegistry` like every other lane.
 *
 * ## Two tiers, and the second one is new
 *
 * v1's lane had one tier — the junction's authored colour — because v1 had no
 * map-owned baseline to show. v2 draws both, and the distinction is load-bearing
 * rather than decorative:
 *
 * - **authored** spans come from the plan's clips and can be retimed;
 * - **baseline** spans are the map's own looping program showing through an
 *   interval no clip covers. Clicking one asks the editor to take control of
 *   that junction; boundary handles still appear only after it is authored.
 *
 * Flattening that distinction is the specific failure this component must avoid:
 * an author who grabs a baseline span expects to take control, so the whole span
 * stays selectable and says exactly what clicking it will do.
 *
 * ## Spans only, no marks
 *
 * What an author grabs is the boundary BETWEEN two clips, not a point event.
 * `retimeClipBoundary` moves both neighbours and refuses rather than collapsing
 * one, so the handle is drawn on the shared edge of two authored spans and there
 * is no such handle where a baseline span meets anything.
 */

export function SignalTimelineLane({
  row,
  stageRows,
  pxPerSecond,
  expanded,
  onToggleExpanded,
  onRetimeBoundary,
  onSelectBand,
}: {
  row: SignalTimelineRow;
  /** The per-stage expansion. Read-only — every stage state is derived. */
  stageRows?: readonly StageTimelineRow[];
  pxPerSecond: number;
  expanded: boolean;
  onToggleExpanded?: () => void;
  /**
   * A boundary move. Called with the boundary the author grabbed and where they
   * put it, both in seconds; the caller runs `retimeClipBoundary`.
   */
  onRetimeBoundary?: (boundaryS: number, nextS: number) => void;
  onSelectBand?: (band: SignalTimelineBand) => void;
}) {
  const clips = useMemo(
    () =>
      row.bands
        .filter((band) => band.source === "authored" && band.clipId != null)
        .map((band) => ({ startS: band.startS, endS: band.endS })),
    [row.bands],
  );
  const boundaries = useMemo(() => clipBoundaries(clips), [clips]);

  return (
    <div className="min-w-0" data-testid={`signal-lane-${row.junctionId}`}>
      <div className="flex min-w-0 items-center gap-1.5">
        {stageRows && stageRows.length > 0 && onToggleExpanded ? (
          <button
            aria-expanded={expanded}
            aria-label={
              expanded
                ? `Collapse junction ${row.junctionId} stages`
                : `Show junction ${row.junctionId} per stage`
            }
            className="editor-motion shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card"
            data-testid={`signal-lane-expand-${row.junctionId}`}
            type="button"
            onClick={onToggleExpanded}
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="size-3" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-3" />
            )}
          </button>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-micro text-foreground">
          Junction {row.junctionId}
          {!row.planned ? (
            <span className="ml-1 text-muted-foreground">· map timing</span>
          ) : null}
        </span>
      </div>

      <BandTrack
        bands={row.bands}
        boundaries={boundaries}
        pxPerSecond={pxPerSecond}
        label={`Junction ${row.junctionId}`}
        onRetimeBoundary={onRetimeBoundary}
        onSelectBand={onSelectBand}
      />

      {expanded && stageRows
        ? stageRows.map((stageRow) => (
            <div
              key={stageRow.controllerId}
              className="min-w-0 pl-4"
              data-testid={`signal-lane-stage-${stageRow.controllerId}`}
            >
              <span className="block truncate text-micro text-muted-foreground">
                Stage {stageRow.controllerId} · {stageRow.headIds.length} head
                {stageRow.headIds.length === 1 ? "" : "s"}
              </span>
              {/* No boundaries and no retime: a stage row shows what a stage WILL
                  show, including states the compiler derived for it, and a derived
                  state is not editable by definition. */}
              <BandTrack
                bands={stageRow.bands}
                boundaries={[]}
                pxPerSecond={pxPerSecond}
                label={`Stage ${stageRow.controllerId}`}
              />
            </div>
          ))
        : null}
    </div>
  );
}

function BandTrack({
  bands,
  boundaries,
  pxPerSecond,
  label,
  onRetimeBoundary,
  onSelectBand,
}: {
  bands: readonly SignalTimelineBand[];
  boundaries: readonly number[];
  pxPerSecond: number;
  label: string;
  onRetimeBoundary?: (boundaryS: number, nextS: number) => void;
  onSelectBand?: (band: SignalTimelineBand) => void;
}) {
  return (
    <div className="relative h-4 min-w-0 bg-muted" role="group" aria-label={`${label} timing`}>
      {bands.map((band) => {
        const swatch = indicationSwatch(band.indication);
        const authored = band.source === "authored";
        const selectable = Boolean(onSelectBand);
        const description = authored
          ? `${label} — ${indicationLabel(band.indication)} ${formatSeconds(band.startS)}s to ${formatSeconds(band.endS)}s. Authored.`
          : `${label} — ${indicationLabel(band.indication)} ${formatSeconds(band.startS)}s to ${formatSeconds(band.endS)}s. Map timing${selectable ? "; click to take control." : "."}`;
        return (
          <button
            key={`${band.startS}-${band.indication}-${band.source}`}
            aria-label={description}
            className={cn(
              "absolute top-0 flex h-4 items-center justify-center overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              authored ? swatch.fill : swatch.ghost,
              selectable ? "cursor-pointer" : "cursor-default",
              !authored && "border-y border-dashed border-border",
              indicationFlashes(band.indication) && "editor-pulse",
            )}
            data-source={band.source}
            data-testid={`signal-band-${band.source}-${band.startS}`}
            style={{
              left: `${band.startS * pxPerSecond}px`,
              width: `${Math.max(2, (band.endS - band.startS) * pxPerSecond)}px`,
            }}
            title={description}
            type="button"
            onClick={() => onSelectBand?.(band)}
            // The dock's own rail seeks the playhead on pointer-down. Picking a
            // band is a selection, not a seek.
            onPointerDown={(event) => event.stopPropagation()}
          />
        );
      })}

      {onRetimeBoundary
        ? boundaries.map((boundaryS) => (
            <BoundaryHandle
              key={boundaryS}
              boundaryS={boundaryS}
              label={label}
              pxPerSecond={pxPerSecond}
              onRetime={onRetimeBoundary}
            />
          ))
        : null}
    </div>
  );
}

/**
 * The grab handle on the shared edge of two authored clips.
 *
 * Keyboard-operable as well as draggable: a two-clip edit is a real authoring
 * action and cannot be pointer-only. Arrow keys step by the smallest band the
 * layout can emit, which is also the amount `retimeClipBoundary` will refuse to go
 * below.
 */
function BoundaryHandle({
  boundaryS,
  label,
  pxPerSecond,
  onRetime,
}: {
  boundaryS: number;
  label: string;
  pxPerSecond: number;
  onRetime: (boundaryS: number, nextS: number) => void;
}) {
  return (
    <button
      aria-label={`${label} — move the ${formatSeconds(boundaryS)} second boundary`}
      className="editor-motion absolute top-0 h-4 w-1.5 -translate-x-1/2 cursor-col-resize bg-foreground/40 hover:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      data-testid={`signal-boundary-${boundaryS}`}
      style={{ left: `${boundaryS * pxPerSecond}px` }}
      type="button"
      onKeyDown={(event) => {
        const step =
          event.key === "ArrowLeft"
            ? -TIMELINE_MIN_BAND_S
            : event.key === "ArrowRight"
              ? TIMELINE_MIN_BAND_S
              : 0;
        if (step === 0) return;
        event.preventDefault();
        onRetime(boundaryS, snapTimelineSeconds(boundaryS + step));
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        const handle = event.currentTarget;
        const originX = event.clientX;
        handle.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => {
          const deltaS = (moveEvent.clientX - originX) / Math.max(pxPerSecond, 1e-6);
          onRetime(boundaryS, snapTimelineSeconds(boundaryS + deltaS));
        };
        const stop = () => {
          handle.releasePointerCapture(event.pointerId);
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", stop);
          handle.removeEventListener("pointercancel", stop);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", stop);
        handle.addEventListener("pointercancel", stop);
      }}
    />
  );
}
