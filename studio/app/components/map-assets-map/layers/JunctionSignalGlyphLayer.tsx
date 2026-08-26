"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import { Marker, useMap } from "react-map-gl/maplibre";
import type { JunctionSignalPlan } from "@simforge-oss/studio-shared";
import {
  useActorsStore,
  useSelectionStore,
} from "@/app/lib/scenario-editor/stores";
import { isJunctionControlled } from "@/app/lib/scenario-editor/signals/intersection-candidates";
import { CANDIDATE_DETAIL_MIN_ZOOM } from "@/app/lib/scenario-editor/signals/intersection-candidate-glyph";
import {
  dominantPlanState,
  signalStateColor,
  SIGNAL_PLAN_MODE_LABELS,
  SIGNAL_UNKNOWN_COLOR,
} from "@/app/lib/scenario-editor/signals/signal-plan-model";
import {
  useSignalJunctionStore,
  type SignalJunctionGlyph,
} from "@/app/lib/scenario-editor/signals/signal-junction-store";
import { useJunctionIdentityLabels } from "@/app/lib/scenario-editor/signals/use-intersection-candidates";
import { projectSignalHead } from "@/app/lib/scenario-editor/map-3d/signal-picking";

/**
 * Junction markers on the map (plan 2026-07-24 §4.3, extended by the
 * intersection-control plan 2026-07-26 §7.1).
 *
 * Two states that must not look alike:
 *
 * - **Controlled** — an authored plan the author placed. A solid disc in the
 *   live dominant colour with a white ring and a mode chip. It never hides at
 *   any zoom, because it is authored content.
 * - **Uncontrolled but signalized** — a hollow ring at low opacity, hidden below
 *   zoom 13. Context, not content.
 *
 * They used to be the same disc with different fills, which is not enough
 * separation to answer "which of these did I author?".
 *
 * Store-driven rather than prop-driven: this layer lives inside the shared map
 * component but its data is editor state, and threading it down the editor's
 * prop chain would add an entry to five component signatures for a layer that
 * renders nothing outside the editor. Outside the editor the stores are empty
 * and the layer returns null.
 *
 * A `Marker` rather than a MapLibre symbol layer because the glyph is a small
 * interactive control (the `WorldSensorLayers` idiom): the disc IS the click
 * target, so it needs real DOM rather than a `queryRenderedFeatures` hit-test
 * added to the map's already long click chain. It is also what lets the editing
 * card anchor to it — `data-junction-marker-id` is a real node in 2D and in 3D.
 */

const BASE_SIZE_PX = 15;
const CONTROLLED_SIZE_PX = 19;
/** Mode chips are noise on a zoomed-out map. */
const CHIP_MIN_ZOOM = 14;

/**
 * The light anchor's height before the scene has been asked how tall the head
 * is drawn — and its permanent height in 2D, where the head IS its ground
 * point and there is nothing to clear.
 */
const SIGNAL_ANCHOR_BASE_HEIGHT_PX = 1;
/** How often to ask again for a head the 3D scene has not built yet. */
const SIGNAL_ANCHOR_RETRY_MS = 120;
/** ~2.5 s of retries. A head that has not appeared by then is not coming. */
const SIGNAL_ANCHOR_MAX_RETRIES = 20;

export function JunctionSignalGlyphLayer({
  markerScale = 1,
  mapZoom = null,
  visible = true,
}: {
  markerScale?: number;
  /** Current map zoom; uncontrolled rings and mode chips are zoom-gated. */
  mapZoom?: number | null;
  visible?: boolean;
}) {
  const glyphs = useSignalJunctionStore((state) => state.glyphs);
  const selectedJunctionId = useSignalJunctionStore(
    (state) => state.selectedJunctionId,
  );
  const hoveredJunctionId = useSignalJunctionStore(
    (state) => state.hoveredJunctionId,
  );
  const referenceAnchor = useSignalJunctionStore((state) => state.referenceAnchor);
  const referenceSignalId = useSignalJunctionStore((state) => state.referenceSignalId);
  const selectJunction = useSignalJunctionStore((state) => state.selectJunction);
  const hoverJunction = useSignalJunctionStore((state) => state.hoverJunction);
  const identities = useJunctionIdentityLabels();
  const signalPlans = useActorsStore((state) => state.signalPlans);
  const armed = useSelectionStore(
    (state) => state.intersectionControlPlacementActive,
  );
  // The glyph used to call `dominantPlanState(plan)` with `t` defaulting to 0,
  // so it showed the junction's state at the START of the scenario and never
  // moved, whatever the playhead was doing. Reading the playhead is the whole
  // fix, and it lands in 2D as well as 3D.
  const previewCurrentTimestamp = 0;

  const planByJunction = useMemo(
    () => new Map(signalPlans.map((plan) => [plan.junction_id, plan])),
    [signalPlans],
  );

  const zoom = mapZoom ?? 15;

  useRevealSelectedJunction(selectedJunctionId, glyphs);
  const lightAnchorRef = useRef<HTMLSpanElement>(null);
  useSignalHeadAnchorSpan(lightAnchorRef, referenceSignalId, referenceAnchor);

  // A junction earns a marker when it is signalized, when it already carries a
  // plan, or when it is the one currently selected: an author who opened a
  // junction the map could not confirm as signalized must still be able to find
  // their way back to it.
  //
  // Deliberately NOT "every junction with a derivable movement table" — that is
  // hundreds of discs on a city map, and the junction list in the dock is the
  // entry point for the unsignalized ones (plan §4.1/§4.2).
  const drawn = useMemo(
    () =>
      glyphs.filter((glyph) => {
        const controlled = isJunctionControlled(
          planByJunction.get(glyph.junction_id),
        );
        if (controlled) return true;
        if (glyph.junction_id === selectedJunctionId) return true;
        // While the candidate fan is up it owns the uncontrolled junctions;
        // two affordances for one click target is how a miss becomes possible.
        if (armed) return false;
        if (zoom < CANDIDATE_DETAIL_MIN_ZOOM) return false;
        return glyph.signalized || planByJunction.has(glyph.junction_id);
      }),
    [armed, glyphs, planByJunction, selectedJunctionId, zoom],
  );

  const lightAnchor =
    referenceAnchor && referenceSignalId ? (
      /* An invisible marker at the clicked light, purely so the floating card
         has something to sit above. The junction's own marker is at the centre
         of the intersection, which is the wrong place for a popup that
         configures one light on one corner of it.

         `anchor="bottom"`, because the span is not a point: it grows UPWARD
         from the road to the top of the fixture (see `useSignalHeadAnchorSpan`)
         so that "above the anchor" means above the head rather than over it. */
      <Marker
        key={`signal-anchor:${referenceSignalId}`}
        anchor="bottom"
        latitude={referenceAnchor.lat}
        longitude={referenceAnchor.lng}
        pitchAlignment="viewport"
        rotationAlignment="viewport"
      >
        <span
          ref={lightAnchorRef}
          aria-hidden
          data-signal-head-anchor={referenceSignalId}
          style={{
            display: "block",
            width: 1,
            height: SIGNAL_ANCHOR_BASE_HEIGHT_PX,
            pointerEvents: "none",
          }}
        />
      </Marker>
    ) : null;

  // The light anchor is NOT gated on `visible`. It draws nothing — it is a 1 px
  // hook the floating card measures itself against — and hiding it with the
  // glyphs left the card with no anchor at all, so it resolved no placement and
  // stayed invisible. The junction glyphs remain hidden as before.
  if (!visible) return lightAnchor;
  if (drawn.length === 0 && !lightAnchor) return null;

  return (
    <>
      {lightAnchor}
      {drawn.map((glyph) => (
        <JunctionMarker
          key={glyph.junction_id}
          glyph={glyph}
          hovered={glyph.junction_id === hoveredJunctionId}
          identity={identities.get(glyph.junction_id) ?? null}
          markerScale={markerScale}
          plan={planByJunction.get(glyph.junction_id) ?? null}
          previewCurrentTimestamp={previewCurrentTimestamp}
          selected={glyph.junction_id === selectedJunctionId}
          showChip={zoom >= CHIP_MIN_ZOOM}
          onHover={hoverJunction}
          onSelect={selectJunction}
        />
      ))}
    </>
  );
}

/**
 * Selecting a junction from the timeline eases the map to it — but ONLY when
 * its marker is off-screen or too far out to see.
 *
 * A camera that moves on every row click is disorienting; one that never moves
 * leaves the author selecting an invisible object. Off-screen-only is the rule
 * that is right in both cases, and `easeTo` rather than `flyTo` because the
 * distance is small and a zoom-out-and-back arc for 200 m is theatre.
 */
function useRevealSelectedJunction(
  selectedJunctionId: string | null,
  glyphs: readonly SignalJunctionGlyph[],
): void {
  const { current: mapRef } = useMap();
  const revealedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedJunctionId) {
      revealedRef.current = null;
      return;
    }
    if (revealedRef.current === selectedJunctionId) return;
    const map = mapRef?.getMap();
    const glyph = glyphs.find(
      (entry) => entry.junction_id === selectedJunctionId,
    );
    if (!map || !glyph) return;
    revealedRef.current = selectedJunctionId;

    const bounds = map.getBounds();
    const onScreen =
      glyph.lng >= bounds.getWest() &&
      glyph.lng <= bounds.getEast() &&
      glyph.lat >= bounds.getSouth() &&
      glyph.lat <= bounds.getNorth();
    const zoom = map.getZoom();
    if (onScreen && zoom >= CANDIDATE_DETAIL_MIN_ZOOM) return;

    map.easeTo({
      center: [glyph.lng, glyph.lat],
      duration: 450,
      zoom: Math.max(zoom, CANDIDATE_DETAIL_MIN_ZOOM + 2),
    });
  }, [glyphs, mapRef, selectedJunctionId]);
}

/**
 * How tall the light's card anchor has to be, in pixels.
 *
 * The anchor sits on the ROAD, under the light. A traffic head hangs five to
 * seven metres above that on a mast arm, so under any pitch the fixture is
 * drawn well above its own ground point — and a card placed "above the anchor"
 * lands on top of the very light it describes. Stretching the anchor up to the
 * top of the drawn head is what turns that back into "above the head".
 *
 * Pure, because jsdom projects nothing: this is the part worth asserting.
 *
 * Clamped at both ends. A floor of {@link SIGNAL_ANCHOR_BASE_HEIGHT_PX} for a
 * head somehow drawn below its own base (a camera under the road), and a
 * ceiling of the viewport because a head clipped by the near plane can project
 * to an enormous negative y, and an anchor taller than the screen would push
 * the card off the top of it.
 */
export function signalAnchorSpanHeight(input: {
  /** Screen y of the light's ground point — the marker's own position. */
  groundY: number;
  /** Screen y of the top of the drawn head, or null when 3D is not drawing. */
  headTopY: number | null;
  viewportHeight: number;
}): number {
  if (input.headTopY == null || !Number.isFinite(input.headTopY)) {
    return SIGNAL_ANCHOR_BASE_HEIGHT_PX;
  }
  if (!Number.isFinite(input.groundY)) return SIGNAL_ANCHOR_BASE_HEIGHT_PX;
  const ceiling = Math.max(
    SIGNAL_ANCHOR_BASE_HEIGHT_PX,
    input.viewportHeight || 0,
  );
  return Math.min(
    ceiling,
    Math.max(SIGNAL_ANCHOR_BASE_HEIGHT_PX, input.groundY - input.headTopY),
  );
}

/**
 * Grow the light's card anchor to cover the head as the scene draws it.
 *
 * Written straight to `style.height` rather than through React state: this
 * recomputes on every map move, and re-rendering the whole glyph layer at 60 fps
 * to move one invisible span is exactly the pathology the marker layers were
 * built to avoid. The card notices anyway — it observes this element's size
 * (`observe.resize` in `useAnchoredPopoverPosition`), so a height that arrives a
 * few frames late still re-places the card.
 *
 * Retries while the scene has no such head: the card can open on the same click
 * that first draws the head, and the 3D projection is only answerable once a
 * frame has been rendered with it.
 */
function useSignalHeadAnchorSpan(
  anchorRef: RefObject<HTMLSpanElement | null>,
  signalId: string | null,
  point: { lng: number; lat: number } | null,
): void {
  const { current: mapRef } = useMap();

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map || !signalId || !point) return;

    let frame = 0;
    let retryTimer = 0;
    let retries = 0;

    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        const element = anchorRef.current;
        if (!element) return;
        const canvas = map.getCanvas();
        const viewport = {
          width: canvas.clientWidth,
          height: canvas.clientHeight,
        };
        const box = projectSignalHead(signalId, viewport);
        if (!box) {
          element.style.height = `${SIGNAL_ANCHOR_BASE_HEIGHT_PX}px`;
          // 2D draws no head, so there is nothing to wait for and the poll
          // stops. In 3D the head can be a frame or two behind the click.
          if (retries < SIGNAL_ANCHOR_MAX_RETRIES) {
            retries += 1;
            window.clearTimeout(retryTimer);
            retryTimer = window.setTimeout(update, SIGNAL_ANCHOR_RETRY_MS);
          }
          return;
        }
        retries = 0;
        window.clearTimeout(retryTimer);
        const height = signalAnchorSpanHeight({
          groundY: map.project([point.lng, point.lat]).y,
          headTopY: box.top,
          viewportHeight: viewport.height,
        });
        element.style.height = `${height}px`;
      });
    };

    update();
    // Every camera change fires `move` — pan, zoom, rotate and pitch alike —
    // and the head's screen height changes with all four.
    map.on("move", update);
    map.on("resize", update);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.clearTimeout(retryTimer);
      map.off("move", update);
      map.off("resize", update);
    };
  }, [anchorRef, mapRef, point, signalId]);
}

function JunctionMarker({
  glyph,
  hovered,
  identity,
  markerScale,
  plan,
  previewCurrentTimestamp,
  selected,
  showChip,
  onHover,
  onSelect,
}: {
  glyph: SignalJunctionGlyph;
  hovered: boolean;
  identity: string | null;
  markerScale: number;
  plan: JunctionSignalPlan | null;
  previewCurrentTimestamp: number;
  selected: boolean;
  showChip: boolean;
  onHover: (junctionId: string | null) => void;
  onSelect: (junctionId: string | null) => void;
}) {
  const controlled = isJunctionControlled(plan);
  const state = plan ? dominantPlanState(plan, previewCurrentTimestamp) : null;
  const color = controlled ? signalStateColor(state) : SIGNAL_UNKNOWN_COLOR;
  const size = (controlled ? CONTROLLED_SIZE_PX : BASE_SIZE_PX) * markerScale;
  const name = identity ?? `Junction ${glyph.junction_id}`;
  const label = controlled
    ? `${name} — ${SIGNAL_PLAN_MODE_LABELS[plan!.mode]} intersection control (junction ${glyph.junction_id})`
    : `${name} — running the map's own signal timers (junction ${glyph.junction_id})`;

  return (
    <Marker
      anchor="center"
      latitude={glyph.lat}
      longitude={glyph.lng}
      pitchAlignment="map"
      rotationAlignment="map"
    >
      <div style={{ position: "relative" }}>
        <button
          aria-label={label}
          aria-pressed={selected}
          className="block rounded-full"
          data-junction-id={glyph.junction_id}
          // The anchor the editing card positions against. The camera flow's
          // equivalent (`data-camera-row-id`) is queried and never emitted, so
          // every camera card silently falls back to top-of-canvas; this one is
          // emitted here and asserted by test.
          data-junction-marker-id={glyph.junction_id}
          data-junction-controlled={controlled ? "true" : "false"}
          data-signal-state={state ?? (controlled ? "unset" : "map_default")}
          data-testid={`junction-signal-glyph-${glyph.junction_id}`}
          style={{
            width: `${size}px`,
            height: `${size}px`,
            backgroundColor: controlled ? color : "transparent",
            opacity: controlled ? 0.95 : hovered ? 0.7 : 0.4,
            border: controlled
              ? "2px solid rgba(255,255,255,0.92)"
              : `1.5px solid ${SIGNAL_UNKNOWN_COLOR}`,
            boxShadow: selected
              ? "0 0 0 3px rgba(232,224,68,0.35)"
              : hovered
                ? "0 0 0 2px rgba(232,224,68,0.22)"
                : undefined,
            outline: selected ? "2px solid #E8E044" : undefined,
            cursor: "pointer",
            pointerEvents: "auto",
            transform: hovered ? "scale(1.12)" : undefined,
            transition: "transform 120ms ease-out",
          }}
          title={label}
          type="button"
          onClick={(event) => {
            // The map's own click handler seeks/deselects; the glyph owns
            // this click entirely.
            event.stopPropagation();
            onSelect(selected ? null : glyph.junction_id);
          }}
          onFocus={() => onHover(glyph.junction_id)}
          onBlur={() => onHover(null)}
          onPointerEnter={() => onHover(glyph.junction_id)}
          onPointerLeave={() => onHover(null)}
        />
        {controlled && showChip && plan ? (
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1 py-px text-[8px] font-bold uppercase tracking-[0.06em] text-white/80"
            data-testid={`junction-mode-chip-${glyph.junction_id}`}
            style={{ top: "calc(100% + 3px)" }}
          >
            {SIGNAL_PLAN_MODE_LABELS[plan.mode]}
          </span>
        ) : null}
      </div>
    </Marker>
  );
}
