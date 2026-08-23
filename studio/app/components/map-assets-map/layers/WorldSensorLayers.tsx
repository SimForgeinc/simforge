import { Marker } from "react-map-gl/maplibre";
import {
  resolveMapMarkerScale,
  type MapMarkerSizingMode,
} from "@/app/lib/maps/frontend/map-marker-sizing";

type SensorFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    label: string;
    selected: boolean;
    camera_kind: "overhead" | "street";
    yaw: number;
  };
};

type SensorGeoJSON = {
  type: "FeatureCollection";
  features: SensorFeature[];
};

type WorldSensorLayersProps = {
  data: object;
  visible?: boolean;
  showLabels?: boolean;
  markerScale?: number;
  markerSizingMode?: MapMarkerSizingMode;
  mapZoom?: number | null;
  labelScale?: number;
  onClickSensor?: (sensorId: string) => void;
};

const COLOR_OVERHEAD = "#38bdf8";
const COLOR_STREET = "#facc15";
const MARKER_SIZE = 48;

/**
 * Camera marker SVG — a rectangular box with a vision cone in front.
 * 0° yaw = north (cone points up). The parent element rotates by yaw.
 *
 *      /  \      ← vision cone
 *     /    \
 *    /______\
 *    | body |    ← rectangular camera body
 *    |______|
 */
function CameraMarkerSvg({
  color,
  selected,
  showCone,
}: {
  color: string;
  selected: boolean;
  showCone: boolean;
}) {
  return (
    <svg
      viewBox="-12 -12 24 24"
      width={MARKER_SIZE}
      height={MARKER_SIZE}
      style={{ display: "block", overflow: "visible" }}
    >
      {/* Vision cone — fans outward from camera body */}
      {showCone && (
        <>
          <path
            data-testid="world-camera-direction-cone"
            d="M 0 -2 L -7 -11 L 7 -11 Z"
            fill={color}
            opacity={0.18}
          />
          <path
            d="M 0 -2 L -7 -11 L 7 -11"
            fill="none"
            stroke={color}
            strokeWidth={0.8}
            strokeLinejoin="round"
            opacity={0.5}
          />
        </>
      )}
      {/* Selection ring */}
      {selected && (
        <circle
          cx={0}
          cy={2}
          r={10}
          fill="none"
          stroke="#ffffff"
          strokeWidth={2}
          opacity={0.8}
        />
      )}
      {/* Camera body — simple rectangle */}
      <rect
        x={-4}
        y={-2}
        width={8}
        height={8}
        rx={1}
        fill={color}
        stroke="#0f172a"
        strokeWidth={1.2}
      />
    </svg>
  );
}

export function WorldSensorLayers({
  data,
  visible = true,
  showLabels = false,
  markerScale = 1,
  markerSizingMode = "map",
  mapZoom = null,
  labelScale = 1,
  onClickSensor,
}: WorldSensorLayersProps) {
  if (!visible) return null;

  const geojson = data as SensorGeoJSON;
  if (!geojson?.features?.length) return null;

  return (
    <>
      {geojson.features.map((feature) => {
        const { id, label, selected, camera_kind, yaw } = feature.properties;
        const [lng, lat] = feature.geometry.coordinates;
        const color = camera_kind === "overhead" ? COLOR_OVERHEAD : COLOR_STREET;
        const markerKey = `sensor:${id}:${lng.toFixed(7)}:${lat.toFixed(7)}`;
        const effectiveMarkerScale = resolveMapMarkerScale({
          mode: markerSizingMode,
          basePixelSize: MARKER_SIZE,
          worldSizeMeters: camera_kind === "overhead" ? 3 : 2.2,
          latitude: lat,
          zoom: mapZoom,
          userScale: markerScale,
          minPixelSize: 8,
          maxPixelSize: 72,
        });

        return (
          <Marker
            key={markerKey}
            anchor="center"
            longitude={lng}
            latitude={lat}
            pitchAlignment="map"
            rotationAlignment="map"
          >
            <div
              aria-label={label}
              style={{
                position: "relative",
                width: `${MARKER_SIZE}px`,
                height: `${MARKER_SIZE}px`,
                overflow: "visible",
                pointerEvents: "auto",
                cursor: onClickSensor ? "pointer" : "default",
                transform: `rotate(${-(yaw ?? 0)}deg) scale(${effectiveMarkerScale})`,
                transformOrigin: "center center",
              }}
              onClick={
                onClickSensor
                  ? () => onClickSensor(id)
                  : undefined
              }
            >
              <CameraMarkerSvg
                color={color}
                selected={selected}
                showCone
              />
            </div>
            {showLabels ? (
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  top: "100%",
                  transform: `translateX(-50%)${labelScale !== 1 ? ` scale(${labelScale})` : ""}`,
                  whiteSpace: "nowrap",
                  fontSize: "11px",
                  fontFamily: "'Open Sans', sans-serif",
                  fontWeight: 600,
                  color: "#ffffff",
                  textShadow:
                    "-1px -1px 0 #0f172a, 1px -1px 0 #0f172a, -1px 1px 0 #0f172a, 1px 1px 0 #0f172a",
                  pointerEvents: "none",
                  marginTop: "2px",
                }}
              >
                {label}
              </div>
            ) : null}
          </Marker>
        );
      })}
    </>
  );
}
