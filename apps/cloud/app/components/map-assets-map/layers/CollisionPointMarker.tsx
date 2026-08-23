import { Marker } from "react-map-gl/maplibre";
import { COLLISION_MARKER_COLOR_HEX } from "@/app/lib/scenario-editor/actor-color";

/**
 * Diagnostic red-X overlay marking where an AI-generated scenario's actor
 * pair comes closest in space along their planned polylines (see
 * `deriveCollisionPoint` in `scenario-collision-point.ts`). One marker per
 * draft, mounted alongside `RuntimeActorLayers` so it sits in the same
 * stacking context.
 *
 * Rendered as an SVG inside a react-map-gl `<Marker>` rather than a MapLibre
 * symbol layer because the X glyph (✕) is not reliably present in
 * self-hosted vector-font tile pipelines — SVG renders identically across
 * every basemap.
 */

export type CollisionPointOverlay = {
  lng: number;
  lat: number;
  /** Closest-approach distance, runtime meters. Drives the marker tooltip
   *  so a reviewer can tell "actors actually crossed (0m)" from "actors
   *  passed close (~3m)". */
  distanceM: number;
};

const SIZE = 28;
const STROKE_WIDTH = 3.5;
const HALO_WIDTH = 6;

type Props = {
  overlay: CollisionPointOverlay | null;
};

export function CollisionPointMarker({ overlay }: Props) {
  if (!overlay) return null;
  const label = overlay.distanceM <= 0.05
    ? "Planned conflict point (paths intersect)"
    : `Planned conflict point (closest approach ${overlay.distanceM.toFixed(1)} m)`;
  return (
    <Marker
      longitude={overlay.lng}
      latitude={overlay.lat}
      anchor="center"
      pitchAlignment="map"
      rotationAlignment="map"
    >
      <div
        aria-label={label}
        title={label}
        style={{
          width: SIZE,
          height: SIZE,
          pointerEvents: "auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          {/* Dark halo so the red reads against light AND dark basemaps. */}
          <line
            x1="5"
            y1="5"
            x2={SIZE - 5}
            y2={SIZE - 5}
            stroke="#0b1120"
            strokeWidth={HALO_WIDTH}
            strokeLinecap="round"
          />
          <line
            x1={SIZE - 5}
            y1="5"
            x2="5"
            y2={SIZE - 5}
            stroke="#0b1120"
            strokeWidth={HALO_WIDTH}
            strokeLinecap="round"
          />
          {/* The red X itself. */}
          <line
            x1="5"
            y1="5"
            x2={SIZE - 5}
            y2={SIZE - 5}
            stroke={COLLISION_MARKER_COLOR_HEX}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
          />
          <line
            x1={SIZE - 5}
            y1="5"
            x2="5"
            y2={SIZE - 5}
            stroke={COLLISION_MARKER_COLOR_HEX}
            strokeWidth={STROKE_WIDTH}
            strokeLinecap="round"
          />
        </svg>
      </div>
    </Marker>
  );
}
