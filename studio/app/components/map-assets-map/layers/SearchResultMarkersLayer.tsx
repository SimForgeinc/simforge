import { Marker } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";

export type SearchResultMarker = {
  id: string;
  lng: number;
  lat: number;
  /** Pre-computed scene-frame position (x, y, z) for the 3D viewer. */
  scenePosition?: { x: number; y: number; z: number } | null;
};

type SearchResultMarkersLayerProps = {
  markers: SearchResultMarker[];
  hoveredId?: string | null;
  /**
   * Id of the currently-selected search result (driven by either
   * panel-card click or pin click). The selected pin gets the same
   * emphasized look as a hovered one — selection has to look "selected"
   * regardless of which side initiated it, otherwise pin clicks feel
   * unresponsive on the map even though the panel reflects the change.
   */
  selectedId?: string | null;
  /**
   * Called when the user clicks a pin on the map. Reverse of the
   * panel-to-map flow — clicking a pin selects the result in the side
   * list (and the existing `selectedResultId` paths handle the visual
   * scroll-into-view + card emphasis from there). Omit to keep pins
   * purely decorative.
   */
  onSelect?: (id: string) => void;
};

type PinProps = {
  color: string;
  strokeColor: string;
  scale: number;
};

/** Classic teardrop map pin, anchored at the bottom tip (svg 24x32). */
function MapPinSvg({ color, strokeColor, scale }: PinProps) {
  const w = 24 * scale;
  const h = 32 * scale;
  return (
    <svg
      width={w}
      height={h}
      viewBox="0 0 24 32"
      aria-hidden="true"
      style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))" }}
    >
      <path
        d="M12 0C5.92 0 1 4.92 1 11c0 7.87 9.46 19.2 10.15 20.02.45.52 1.25.52 1.7 0C13.54 30.2 23 18.87 23 11 23 4.92 18.08 0 12 0z"
        fill={color}
        stroke={strokeColor}
        strokeWidth={1.5}
      />
      <circle cx="12" cy="11" r="4" fill={strokeColor} />
    </svg>
  );
}

/** Pin markers for each search result; the hovered one is visually emphasized.
 * When `onSelect` is wired, the pins also become clickable — click flows
 * back into the side panel as a result selection (reverse of list→map). */
export function SearchResultMarkersLayer({
  markers,
  hoveredId,
  selectedId,
  onSelect,
}: SearchResultMarkersLayerProps) {
  return (
    <>
      {markers.map((m) => {
        // "Emphasized" = either hovered (transient) or selected (persistent).
        // They share the same visual treatment so pin appearance is consistent
        // whether the user is previewing via hover or has committed to a pick
        // via click — either side initiating the selection.
        const emphasized =
          (!!hoveredId && m.id === hoveredId) ||
          (!!selectedId && m.id === selectedId);
        const hovered = emphasized;
        // pointerEvents is enabled only when a click handler is wired —
        // otherwise the pin stays a pure decoration and won't intercept
        // map drag/zoom from underlying layers. Inner SVG always opts in
        // so cursor + click semantics survive when onSelect is present.
        const interactive = onSelect != null;
        return (
          <Marker
            key={m.id}
            longitude={m.lng}
            latitude={m.lat}
            anchor="bottom"
            style={{
              pointerEvents: interactive ? "auto" : "none",
              cursor: interactive ? "pointer" : "default",
              zIndex: hovered ? 2 : 1,
            }}
            onClick={
              interactive
                ? (event) => {
                    // Stop the click from bubbling up to maplibre — without
                    // this, the underlying map-click handler (which clears
                    // GeoJSON feature selection) fires immediately after
                    // and the panel selection toggles itself off.
                    event.originalEvent.stopPropagation();
                    onSelect!(m.id);
                  }
                : undefined
            }
          >
            <div
              role={interactive ? "button" : undefined}
              tabIndex={interactive ? 0 : undefined}
              aria-label={interactive ? `Open search result ${m.id}` : undefined}
              onKeyDown={
                interactive
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect!(m.id);
                      }
                    }
                  : undefined
              }
              style={{ display: "block" }}
            >
              <MapPinSvg
                color={hovered ? C.selected : C.highlighted}
                strokeColor={C.bg}
                scale={hovered ? 1.25 : 0.85}
              />
            </div>
          </Marker>
        );
      })}
    </>
  );
}
