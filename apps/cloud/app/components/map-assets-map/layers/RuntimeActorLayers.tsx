import { useEffect, useState } from "react";
import { Marker } from "react-map-gl/maplibre";
import { ActorIcon } from "@/app/lib/scenario-editor/actor-svgs";
import {
  resolveMapMarkerScale,
  type MapMarkerSizingMode,
} from "@/app/lib/maps/frontend/map-marker-sizing";

const HOLD_TO_MOVE_MS = 500;
const HOLD_RING_INSET = 6;
const HOLD_RING_STROKE = 2.5;

export type RuntimeActorMarker = {
  id: string;
  label: string;
  longitude: number;
  latitude: number;
  kind: "vehicle" | "walker" | "prop";
  role: "subject" | "traffic" | "pedestrian" | "prop";
  blueprint?: string | null;
  selected: boolean;
  rotationDeg: number;
  color?: string | null;
  /**
   * Metres per second from the preview frame this marker was built from, or
   * null/absent for an authored actor that no run has driven yet. Present is
   * the signal that there IS a playback to report — see the 3D tag.
   */
  speedMps?: number | null;
  hideLabel?: boolean;
  preview?: boolean;
  dimmed?: boolean;
  comparisonRole?: "reference" | "candidate";
};

type RuntimeActorLayersProps = {
  actors: RuntimeActorMarker[];
  markerScale?: number;
  markerSizingMode?: MapMarkerSizingMode;
  mapZoom?: number | null;
  labelScale?: number;
  onMouseDownActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
  onContextMenuActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
  interactionMode?: "select" | "move";
};

function markerSize(actor: RuntimeActorMarker): number {
  if (actor.kind === "walker") return 18;
  if (actor.kind === "prop") return 20;
  return 56;
}

function actorWorldSizeMeters(actor: RuntimeActorMarker): number {
  if (actor.kind === "walker") return 0.75;
  if (actor.kind === "prop") return 1.2;

  const blueprint = actor.blueprint?.toLowerCase() ?? "";
  if (
    blueprint.includes("bicycle") ||
    blueprint.includes("bike") ||
    blueprint.includes("crossbike") ||
    blueprint.includes("gazelle")
  ) {
    return 1.8;
  }
  if (
    blueprint.includes("motorcycle") ||
    blueprint.includes("harley") ||
    blueprint.includes("yamaha") ||
    blueprint.includes("kawasaki") ||
    blueprint.includes("vespa")
  ) {
    return 2.3;
  }

  return 4.8;
}

function actorPixelBounds(actor: RuntimeActorMarker) {
  if (actor.kind === "walker") return { minPixelSize: 6, maxPixelSize: 30 };
  if (actor.kind === "prop") return { minPixelSize: 6, maxPixelSize: 40 };
  return { minPixelSize: 8, maxPixelSize: 96 };
}

/**
 * Exported so 3D mode can reuse it verbatim. 3D draws models in GL but keeps
 * the hover card and the hold ring as DOM — re-implementing text and an
 * animated ring in GL would be a rewrite of working chrome, and DOM-over-GL
 * stacking works in our favour here: chrome SHOULD float above the models.
 * The difference is the count: 3D renders one card and one ring at most,
 * instead of one marker per actor.
 */
export function HoverInfoCard({
  actor,
  size,
}: {
  actor: RuntimeActorMarker;
  size: number;
}) {
  return (
    <div
      role="tooltip"
      style={{
        position: "absolute",
        left: "50%",
        bottom: `${size + 8}px`,
        transform: "translateX(-50%)",
        width: "max-content",
        minWidth: 132,
        maxWidth: 200,
        pointerEvents: "none",
        zIndex: 20,
        animation: "hoverInfoFadeIn 120ms ease-out forwards",
        opacity: 0,
      }}
    >
        <div
          style={{
            overflow: "hidden",
            padding: "8px 10px 7px",
            background: "rgba(10, 10, 10, 0.94)",
            border: "1px solid rgba(232, 224, 68, 0.62)",
            boxShadow: "0 10px 28px rgba(0, 0, 0, 0.5)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            fontFamily:
              "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          }}
        >
          <div
            style={{
              overflow: "hidden",
              color: "#ffffff",
              fontSize: 12,
              fontWeight: 700,
              lineHeight: 1.2,
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {actor.label}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              marginTop: 4,
              color: "rgba(248, 250, 252, 0.55)",
              fontSize: 8,
              fontWeight: 650,
              whiteSpace: "nowrap",
            }}
          >
            <span><strong style={{ color: "#ffffff" }}>Right-click</strong> details</span>
            <span aria-hidden style={{ color: "rgba(255,255,255,0.22)" }}>·</span>
            <span><strong style={{ color: "#E8E044" }}>Hold</strong> move</span>
          </div>
        </div>
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          bottom: -5,
          transform: "translateX(-50%) rotate(45deg)",
          width: 8,
          height: 8,
          background: "rgba(10, 10, 10, 0.96)",
          borderRight: "1px solid rgba(232, 224, 68, 0.78)",
          borderBottom: "1px solid rgba(232, 224, 68, 0.78)",
        }}
      />
      <style>{`
        @keyframes hoverInfoFadeIn {
          from { opacity: 0; transform: translateX(-50%) translateY(2px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  );
}

/** Exported for 3D mode's chrome — see {@link HoverInfoCard}. */
export function HoldProgressRing({ size }: { size: number }) {
  const radius = size / 2 - HOLD_RING_INSET;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      className="hold-progress-ring"
      width={size}
      height={size}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        transform: "rotate(-90deg)",
        transformOrigin: "center",
      }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#ffffff"
        strokeWidth={HOLD_RING_STROKE}
        strokeLinecap="round"
        strokeDasharray={circumference}
        style={{
          strokeDashoffset: circumference,
          animation: `holdProgressFill ${HOLD_TO_MOVE_MS}ms linear forwards`,
        }}
      />
      <style>{`
        @keyframes holdProgressFill {
          to { stroke-dashoffset: 0; }
        }
      `}</style>
    </svg>
  );
}

/** Exported so the opacity and colour rules can be pinned without a map. */
export function ActorMarkerView({
  actor,
  markerScale,
  markerSizingMode,
  mapZoom,
  labelScale: _labelScale,
  onMouseDownActor,
  onContextMenuActor,
}: {
  actor: RuntimeActorMarker;
  markerScale: number;
  markerSizingMode: MapMarkerSizingMode;
  mapZoom: number | null;
  labelScale: number;
  onMouseDownActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
  onContextMenuActor?: (payload: {
    actorId: string;
    clientX: number;
    clientY: number;
  }) => void;
}) {
  const size = markerSize(actor);
  const effectiveMarkerScale = resolveMapMarkerScale({
    mode: markerSizingMode,
    basePixelSize: size,
    worldSizeMeters: actorWorldSizeMeters(actor),
    latitude: actor.latitude,
    zoom: mapZoom,
    userScale: markerScale,
    ...actorPixelBounds(actor),
  });
  const [isHolding, setIsHolding] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    if (!isHolding) return;
    const stopHolding = () => setIsHolding(false);
    window.addEventListener("mouseup", stopHolding);
    return () => window.removeEventListener("mouseup", stopHolding);
  }, [isHolding]);

  return (
    <div
      data-runtime-actor-id={actor.id}
      /**
       * WHERE the editor thinks this actor is, in world coordinates.
       *
       * A headless check can read a marker's screen position, and gate C did —
       * then asserted the subject "moved" by comparing screen pixels between
       * screenshots. The camera FOLLOWS the subject, so its screen position is
       * pinned to the centre of the map viewport while it drives: C1's subject, a
       * highway car at speed, reported the identical pixel (1114, 595) at 7.5 s,
       * 15 s and 22.5 s. The assertion was measuring camera lag.
       *
       * Six decimals is ~0.1 m, which is finer than anything the gate asserts
       * and coarse enough that a stationary actor's attribute stops changing.
       */
      data-runtime-actor-lng={actor.longitude.toFixed(6)}
      data-runtime-actor-lat={actor.latitude.toFixed(6)}
      onMouseEnter={() => {
        if (!actor.preview) setIsHovering(true);
      }}
      onMouseLeave={() => setIsHovering(false)}
      onPointerEnter={() => {
        if (!actor.preview) setIsHovering(true);
      }}
      onPointerLeave={() => setIsHovering(false)}
      // A DOM marker sits above the map canvas, so MapLibre never sees this
      // right-click and the map's own contextmenu handler cannot route it —
      // 2D has to claim the gesture here. 3D goes through the map handler,
      // where the cars are GL geometry rather than DOM.
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (actor.preview) return;
        setIsHovering(false);
        onContextMenuActor?.({
          actorId: actor.id,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }}
      style={{
        position: "relative",
        width: `${size}px`,
        height: `${size}px`,
        overflow: "visible",
        pointerEvents: actor.preview ? "none" : "auto",
        transform:
          effectiveMarkerScale !== 1
            ? `scale(${effectiveMarkerScale})`
            : undefined,
        transformOrigin: "center center",
        // A parity pair is the one place transparency MEANS something: the
        // candidate is drawn over the reference so the offset between them is
        // readable, and that only works if the top one is see-through.
        //
        // Every traffic actor in a preview used to be 0.3 as well, which is not
        // the same kind of claim — it said "this car is ambient", and it said it
        // by making the car nearly invisible. Ambient traffic is most of what
        // moves in a run; a scenario is judged on how the subject meets it, and you
        // cannot judge what you cannot see. Subordination is the colour's job
        // now — subject yellow is reserved, traffic is hashed — and colour costs no
        // legibility to read.
        opacity:
          actor.comparisonRole === "candidate"
            ? 0.5
            : actor.comparisonRole === "reference"
              ? 1
              : actor.dimmed
                ? 0.5
                : undefined,
        transition: "opacity 0.2s ease",
      }}
    >
      <button
        type="button"
        aria-label={actor.label}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (actor.preview) return;
          // Left button only: the right button opens details and must not also
          // arm hold-to-move, or a lingering right-click would pick the car up.
          if (event.button !== 0) return;
          setIsHolding(true);
          onMouseDownActor?.({
            actorId: actor.id,
            clientX: event.clientX,
            clientY: event.clientY,
          });
        }}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          padding: 0,
          margin: 0,
          background: "transparent",
          color: actor.color ?? "#f8fafc",
          cursor: "pointer",
          transform: `rotate(${actor.rotationDeg}deg)`,
        }}
      >
        <ActorIcon
          kind={actor.kind}
          blueprint={actor.blueprint ?? undefined}
          variant={actor.preview ? "live" : "draft"}
          style={{ width: `${size}px`, height: `${size}px` }}
        />
      </button>
      {isHolding ? <HoldProgressRing size={size} /> : null}
      {isHovering && !isHolding ? (
        <HoverInfoCard
          actor={actor}
          size={size}
        />
      ) : null}
    </div>
  );
}

export function RuntimeActorLayers({
  actors,
  markerScale = 1,
  markerSizingMode = "map",
  mapZoom = null,
  labelScale = 1,
  onMouseDownActor,
  onContextMenuActor,
}: RuntimeActorLayersProps) {
  return (
    <>
      {actors.map((actor) => {
        // Keyed by identity, NOT by pose.
        //
        // `Marker` is memoized and already repositions in place — it calls
        // `marker.setLngLat(...)` in an effect when longitude/latitude change.
        // Folding the pose into the React key defeated exactly that: every
        // frame produced a new key, so React unmounted the old marker (which
        // runs `marker.remove()`, tearing down the DOM node and its portal) and
        // mounted a fresh one, re-rendering each actor's inline SVG. During
        // playback that is every marker, ~20 times a second — the pathology
        // `map-3d-scene.ts` already documents as the reason the 3D path does
        // not reuse this one.
        //
        // It also fixes behaviour: `ActorMarkerView` keeps `isHolding` and
        // `isHovering` in component state, which a remount destroyed, so hover
        // cards and press-and-hold could not survive a moving playhead.
        return (
          <Marker
            key={actor.id}
            anchor="center"
            longitude={actor.longitude}
            latitude={actor.latitude}
            pitchAlignment="map"
            rotationAlignment="map"
          >
            <ActorMarkerView
              actor={actor}
              markerScale={markerScale}
              markerSizingMode={markerSizingMode}
              mapZoom={mapZoom}
              labelScale={labelScale}
              onMouseDownActor={onMouseDownActor}
              onContextMenuActor={onContextMenuActor}
            />
          </Marker>
        );
      })}
    </>
  );
}
