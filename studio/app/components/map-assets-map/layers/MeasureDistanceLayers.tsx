import { useCallback, useRef } from "react";
import { Layer, Marker, Source } from "react-map-gl/maplibre";
import { C } from "../map-layer-constants";
import {
  measureOverlayGeoJSON,
  measureReadout,
  type MeasurePoint,
} from "@/app/lib/maps/frontend/measure-distance";

type MeasureDistanceLayersProps = {
  points: MeasurePoint[];
  cursor: MeasurePoint | null;
  onClear: () => void;
};

/**
 * Overlay for the measure tool: endpoint dots, the measured segment (dashed
 * while rubber-banding to the cursor, solid once pinned), and a midpoint pill
 * with the great-circle distance. The pinned pill carries a ✕ to clear; the
 * live preview pill ignores the pointer so it can never swallow the second
 * click.
 */
export function MeasureDistanceLayers({
  points,
  cursor,
  onClear,
}: MeasureDistanceLayersProps) {
  const onClearRef = useRef(onClear);
  onClearRef.current = onClear;

  // MapLibre's click handler lives on the canvas container — an ancestor of
  // marker DOM — so a React-level stopPropagation fires too late to shield
  // it. Intercept natively on the pill itself, otherwise the ✕ click would
  // also register as a map click and start a new measurement under the pill.
  const attachPill = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const onPillClick = (event: MouseEvent) => {
      event.stopPropagation();
      const target = event.target as Element | null;
      if (target?.closest("[data-measure-clear]")) onClearRef.current();
    };
    el.addEventListener("click", onPillClick);
    return () => el.removeEventListener("click", onPillClick);
  }, []);

  const data = measureOverlayGeoJSON(points, cursor);
  const readout = measureReadout(points, cursor);
  if (!data) return null;

  return (
    <>
      <Source id="measure-distance" type="geojson" data={data as never}>
        <Layer
          id="measure-distance-line"
          type="line"
          filter={["==", ["get", "kind"], "fixed"] as never}
          layout={{ "line-cap": "round" }}
          paint={{
            "line-color": C.fg,
            "line-width": 2.5,
            "line-opacity": 0.9,
          }}
        />
        <Layer
          id="measure-distance-preview"
          type="line"
          filter={["==", ["get", "kind"], "preview"] as never}
          paint={{
            "line-color": C.fg,
            "line-width": 2,
            "line-opacity": 0.75,
            "line-dasharray": [1.5, 1.5] as never,
          }}
        />
        <Layer
          id="measure-distance-endpoint"
          type="circle"
          filter={["==", ["get", "kind"], "endpoint"] as never}
          paint={{
            "circle-radius": 4.5,
            "circle-color": C.fg,
            "circle-stroke-width": 2,
            "circle-stroke-color": C.bg,
          }}
        />
      </Source>
      {readout && (
        <Marker
          longitude={readout.position.lng}
          latitude={readout.position.lat}
          anchor="bottom"
          offset={[0, -10] as never}
          style={{ pointerEvents: readout.pinned ? "auto" : "none", zIndex: 5 }}
        >
          <div
            ref={attachPill}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.25rem 0.6rem",
              background: `${C.bg}f2`,
              color: C.fg,
              border: `1px solid ${C.border}`,
              borderRadius: "999px",
              fontSize: "0.75rem",
              fontFamily: C.font,
              whiteSpace: "nowrap",
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{readout.label}</span>
            {readout.pinned && (
              <button
                type="button"
                data-measure-clear
                aria-label="Clear measurement"
                title="Clear measurement"
                style={{
                  border: "none",
                  background: "transparent",
                  color: C.muted,
                  cursor: "pointer",
                  padding: 0,
                  fontSize: "0.8rem",
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            )}
          </div>
        </Marker>
      )}
    </>
  );
}
