"use client";

import { useMemo } from "react";
import { Marker } from "react-map-gl/maplibre";
import { metersPerPixel } from "@/app/lib/scenario-editor/map-3d/coordinates";
import {
  intersectionCandidateGlyph,
  type IntersectionCandidateGlyph,
} from "@/app/lib/scenario-editor/signals/intersection-candidate-glyph";
import { placeIntersectionControl } from "@/app/lib/scenario-editor/signals/intersection-control-placement";
import type { IntersectionCandidate } from "@/app/lib/scenario-editor/signals/intersection-candidates";
import { useActorsStore, useSelectionStore } from "@/app/lib/scenario-editor/stores";
import { useIntersectionCandidates } from "@/app/lib/scenario-editor/signals/use-intersection-candidates";
import {
  junctionSummary,
  useSignalJunctionStore,
} from "@/app/lib/scenario-editor/signals/signal-junction-store";

/**
 * Armed-mode intersection candidates (plan 2026-07-26, section 5).
 *
 * A dot says "something is here"; the junction's SHAPE says "this one". So a
 * candidate is drawn as its real approach fan at its real footprint — a ring
 * sized by `radius_m` through the current zoom's metres-per-pixel, one spoke per
 * leg at its true bearing, one pip per physical head. Four spokes at 90° IS a
 * four-way, and that is identity you get for free before you commit.
 *
 * Store-driven, like `JunctionSignalGlyphLayer` and for the same reason: this
 * lives inside the shared map component but every input is editor state, and
 * threading it down the prop chain would widen five signatures for one reader.
 * Outside the editor the stores are empty and nothing renders.
 *
 * A DOM `<Marker>` rather than a MapLibre symbol layer because the glyph IS the
 * click target: candidates have their own hit area, so there is no "miss" to be
 * silent about (the camera flow's C3).
 */

const ARM_COLOR = "#E8E044";

export function IntersectionCandidateLayer({
  markerScale = 1,
  mapZoom = null,
  compact = false,
  visible = true,
}: {
  markerScale?: number;
  /** Current map zoom, for the metre-accurate ring and the detail gate. */
  mapZoom?: number | null;
  /** 3D mode: the fan gives way to a badge and the ghost heads carry it. */
  compact?: boolean;
  visible?: boolean;
}) {
  const armed = useSelectionStore(
    (state) => state.intersectionControlPlacementActive,
  );
  const candidates = useIntersectionCandidates();
  const glyphs = useSignalJunctionStore((state) => state.glyphs);
  const hoveredJunctionId = useSignalJunctionStore(
    (state) => state.hoveredJunctionId,
  );

  const positions = useMemo(
    () => new Map(glyphs.map((glyph) => [glyph.junction_id, glyph])),
    [glyphs],
  );

  // Already-controlled junctions keep their placed marker; drawing a fan over
  // one would offer to create what already exists.
  const drawn = useMemo(
    () => candidates.filter((candidate) => !candidate.controlled),
    [candidates],
  );

  if (!visible || !armed || drawn.length === 0) return null;

  return (
    <>
      {drawn.map((candidate) => {
        const position = positions.get(candidate.junctionId);
        if (!position) return null;
        return (
          <CandidateMarker
            key={candidate.junctionId}
            candidate={candidate}
            compact={compact}
            hovered={candidate.junctionId === hoveredJunctionId}
            lat={position.lat}
            lng={position.lng}
            markerScale={markerScale}
            zoom={mapZoom ?? 15}
          />
        );
      })}
    </>
  );
}

function CandidateMarker({
  candidate,
  compact,
  hovered,
  lat,
  lng,
  markerScale,
  zoom,
}: {
  candidate: IntersectionCandidate;
  compact: boolean;
  hovered: boolean;
  lat: number;
  lng: number;
  markerScale: number;
  zoom: number;
}) {
  const glyph = intersectionCandidateGlyph({
    approachBearingsDeg: candidate.approachBearingsDeg,
    compact,
    lightBearingsDeg: candidate.lights.map((light) => light.bearingDeg),
    markerScale,
    metersPerPixel: metersPerPixel(zoom, lat),
    radiusM: candidate.radiusM,
    zoom,
  });

  const label = `${candidate.identity} — add intersection control (junction ${candidate.junctionId})`;

  return (
    <Marker
      anchor="center"
      latitude={lat}
      longitude={lng}
      pitchAlignment="map"
      rotationAlignment="map"
    >
      <div style={{ position: "relative" }}>
        <button
          aria-label={label}
          className="block"
          data-intersection-candidate-id={candidate.junctionId}
          data-testid={`intersection-candidate-${candidate.junctionId}`}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            display: "block",
            padding: 0,
            pointerEvents: "auto",
          }}
          title={label}
          type="button"
          onClick={(event) => {
            // The map's own click handler seeks and deselects; the candidate
            // owns this click entirely.
            event.stopPropagation();
            commitIntersectionControl(candidate.junctionId);
          }}
          onFocus={() => hoverJunction(candidate.junctionId)}
          onBlur={() => hoverJunction(null)}
          onPointerEnter={() => hoverJunction(candidate.junctionId)}
          onPointerLeave={() => hoverJunction(null)}
        >
          <CandidateFan glyph={glyph} hovered={hovered} />
        </button>
        {hovered ? <CandidateHoverCard candidate={candidate} /> : null}
      </div>
    </Marker>
  );
}

function CandidateFan({
  glyph,
  hovered,
}: {
  glyph: IntersectionCandidateGlyph;
  hovered: boolean;
}) {
  return (
    <svg
      aria-hidden
      height={glyph.sizePx}
      style={{
        display: "block",
        overflow: "visible",
        transform: hovered ? "scale(1.08)" : undefined,
        transformOrigin: "center",
        transition: "transform 120ms ease-out",
      }}
      viewBox={`0 0 ${glyph.sizePx} ${glyph.sizePx}`}
      width={glyph.sizePx}
    >
      <circle
        cx={glyph.center.x}
        cy={glyph.center.y}
        fill={ARM_COLOR}
        fillOpacity={hovered ? 0.32 : 0.18}
        r={glyph.ringRadiusPx}
        stroke={ARM_COLOR}
        strokeOpacity={hovered ? 1 : 0.85}
        strokeWidth={2}
      />
      {glyph.spokes.map((spoke, index) => (
        <line
          key={`spoke-${index}`}
          stroke={ARM_COLOR}
          strokeLinecap="round"
          strokeOpacity={hovered ? 1 : 0.8}
          strokeWidth={3}
          x1={spoke.from.x}
          x2={spoke.to.x}
          y1={spoke.from.y}
          y2={spoke.to.y}
        />
      ))}
      {glyph.pips.map((pip, index) => (
        <circle
          key={`pip-${index}`}
          cx={pip.x}
          cy={pip.y}
          fill="#0d0d0d"
          r={2.6}
          stroke={ARM_COLOR}
          strokeWidth={1.2}
        />
      ))}
    </svg>
  );
}

/**
 * Identity in place, before the commit.
 *
 * The raw junction id is demoted to a muted footnote — it is still there,
 * because it is what appears in exports and worker logs, but it stops being the
 * NAME. That demotion is the whole answer to "I don't even know which traffic
 * light stuff it is referring to".
 */
function CandidateHoverCard({ candidate }: { candidate: IntersectionCandidate }) {
  const heads = candidate.lights.length;
  return (
    <div
      className="pointer-events-none absolute left-1/2 z-10 w-[220px] -translate-x-1/2 rounded-lg border border-white/15 bg-black/90 px-2.5 py-2 shadow-lg backdrop-blur"
      data-testid={`intersection-candidate-card-${candidate.junctionId}`}
      role="tooltip"
      style={{ bottom: "calc(100% + 10px)" }}
    >
      <p className="text-[12px] font-semibold leading-tight text-white">
        {candidate.identity}
      </p>
      <p className="mt-0.5 text-[10px] text-white/55">
        {candidate.approachCount}{" "}
        {candidate.approachCount === 1 ? "approach" : "approaches"} ·{" "}
        {candidate.movementCount}{" "}
        {candidate.movementCount === 1 ? "movement" : "movements"}
      </p>
      <p className="text-[10px] text-white/55">
        {heads} {heads === 1 ? "signal head" : "signal heads"}
      </p>
      {candidate.overlapsJunctionIds.length > 0 ? (
        // Six physical intersections on our maps span two OpenDRIVE junction
        // ids. Merging them is a controller-level change out of scope here, so
        // the honest move is to say so rather than let the author wonder why
        // one intersection grew two candidates.
        <p
          className="mt-1 text-[10px] leading-snug text-[#F0B429]"
          data-testid={`intersection-candidate-split-${candidate.junctionId}`}
        >
          The map splits this intersection across{" "}
          {candidate.overlapsJunctionIds.length + 1} junction ids — control both
          halves to govern all of it.
        </p>
      ) : null}
      <div className="mt-1.5 border-t border-white/10 pt-1.5">
        <p className="text-[10px] font-semibold text-[#E8E044]">
          Click to add control
        </p>
        <p className="text-[9px] text-white/30">id {candidate.junctionId}</p>
      </div>
    </div>
  );
}

function hoverJunction(junctionId: string | null): void {
  useSignalJunctionStore.getState().hoverJunction(junctionId);
}

/**
 * Create the control, select it, and put the tool away — one gesture that ends
 * in the editing surface rather than one that leaves you hunting for what you
 * just made (the camera flow's C4).
 */
function commitIntersectionControl(junctionId: string): void {
  const junctionState = useSignalJunctionStore.getState();
  const summary = junctionSummary(junctionState.index, junctionId);
  useActorsStore.getState().applySignalPlansChange(
    (current) =>
      placeIntersectionControl({
        junctionId,
        movements: summary?.movements ?? [],
        plans: current,
      }).plans,
    { label: "Add intersection control", history: true },
  );
  junctionState.selectJunction(junctionId);
  junctionState.hoverJunction(null);
  useSelectionStore.getState().setIntersectionControlPlacement(false);
}
