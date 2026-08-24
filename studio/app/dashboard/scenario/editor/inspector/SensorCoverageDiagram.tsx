"use client";

import { sensorAperture, type ActorSensor } from "@simforge/scenario";
import { modalityLabel, sensorName } from "./sensor-presentation";

/**
 * Top-down plan of the actor and what its sensors can see.
 *
 * The author's real question is "does anything look backwards, and do the
 * cameras overlap" — a question about angles, which eleven numeric fields
 * cannot answer and one plan view answers instantly.
 *
 * Canonical actor coordinates are +X forward, +Y up, +Z left, so the plan maps
 * x to screen-up and z to screen-left, putting the nose at the top exactly as
 * an author draws a car.
 *
 * Wedge radius is deliberately NOT the sensor's range. A 1000 m camera and a
 * 100 m radar drawn to scale would leave the vehicle a dot; the wedge shows
 * bearing and angular width, and the range is printed as text beside it.
 */
export function SensorCoverageDiagram({
  dims,
  onSelect,
  selectedId,
  sensors,
}: {
  dims: { length: number; width: number };
  onSelect: (sensorId: string) => void;
  selectedId: string | null;
  sensors: readonly ActorSensor[];
}) {
  // The plan is sized in metres and scaled by the viewBox, so a bus and a hatchback
  // both fill the frame instead of one of them rattling around inside it.
  const halfLength = dims.length / 2;
  const halfWidth = dims.width / 2;
  const reach = Math.max(dims.length, dims.width) * 0.95;
  const extentX = halfWidth + reach;
  const extentY = halfLength + reach;
  const enabled = sensors.filter((sensor) => sensor.enabled);

  return (
    <svg
      aria-label="Sensor coverage plan"
      className="h-full w-full"
      role="img"
      viewBox={`${-extentX} ${-extentY} ${extentX * 2} ${extentY * 2}`}
    >
      <defs>
        <radialGradient id="sensor-wedge-fade">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.5" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
        </radialGradient>
      </defs>

      {enabled.map((sensor) => (
        <Wedge
          key={sensor.id}
          radius={reach}
          selected={sensor.id === selectedId}
          sensor={sensor}
        />
      ))}

      <rect
        className="fill-muted/40 stroke-foreground/25"
        height={dims.length}
        rx={Math.min(0.35, dims.width / 6)}
        strokeWidth={0.04}
        width={dims.width}
        x={-halfWidth}
        y={-halfLength}
      />
      {/* Nose marker: without it a symmetric box gives no clue which way is forward. */}
      <path
        className="fill-none stroke-foreground/40"
        d={`M ${-halfWidth * 0.55} ${-halfLength * 0.72} L 0 ${-halfLength * 0.93} L ${halfWidth * 0.55} ${-halfLength * 0.72}`}
        strokeWidth={0.05}
      />

      {sensors.map((sensor) => {
        const selected = sensor.id === selectedId;
        return (
          <g key={sensor.id}>
            <circle
              className={
                selected
                  ? "fill-primary stroke-background"
                  : sensor.enabled
                    ? "fill-foreground/70 stroke-background"
                    : "fill-muted-foreground/40 stroke-background"
              }
              cx={-sensor.mount.position.z}
              cy={-sensor.mount.position.x}
              r={selected ? 0.19 : 0.14}
              strokeWidth={0.04}
            />
            {/* The whole marker is the hit target: at this scale a 0.19m circle is a few pixels. */}
            <circle
              aria-label={`Select ${sensorName(sensor)}`}
              className="cursor-pointer fill-transparent"
              cx={-sensor.mount.position.z}
              cy={-sensor.mount.position.x}
              onClick={() => onSelect(sensor.id)}
              r={0.42}
              role="button"
            >
              <title>{`${sensorName(sensor)} — ${modalityLabel(sensor.type)}`}</title>
            </circle>
          </g>
        );
      })}
    </svg>
  );
}

function Wedge({
  radius,
  selected,
  sensor,
}: {
  radius: number;
  selected: boolean;
  sensor: ActorSensor;
}) {
  const aperture = sensorAperture(sensor);
  const originX = -sensor.mount.position.z;
  const originY = -sensor.mount.position.x;
  const colour = selected
    ? "text-primary"
    : sensor.type === "dash_camera"
      ? "text-sky-300"
      : sensor.type === "lidar"
        ? "text-emerald-300"
        : "text-orange-300";

  if (aperture.horizontalFovDeg >= 359.5) {
    return (
      <circle
        className={`${colour} fill-[url(#sensor-wedge-fade)] stroke-current`}
        cx={originX}
        cy={originY}
        opacity={selected ? 0.9 : 0.45}
        r={radius}
        strokeOpacity={0.35}
        strokeWidth={0.03}
      />
    );
  }

  // Yaw is right-handed about +Y with +Z pointing left, so a positive yaw turns
  // the sensor toward the vehicle's right — which, once the plan mirrors z, is
  // clockwise from straight up.
  const half = (aperture.horizontalFovDeg / 2) * (Math.PI / 180);
  const centre = sensor.mount.rotation.yawRad;
  const from = polar(originX, originY, radius, centre - half);
  const to = polar(originX, originY, radius, centre + half);
  const largeArc = aperture.horizontalFovDeg > 180 ? 1 : 0;

  return (
    <path
      className={`${colour} fill-[url(#sensor-wedge-fade)] stroke-current`}
      d={`M ${originX} ${originY} L ${from.x} ${from.y} A ${radius} ${radius} 0 ${largeArc} 1 ${to.x} ${to.y} Z`}
      opacity={selected ? 0.95 : 0.4}
      strokeOpacity={0.3}
      strokeWidth={0.03}
    />
  );
}

/** Bearing to plan coordinates: screen-up is forward, screen-right is the vehicle's right. */
export function polar(originX: number, originY: number, radius: number, yawRad: number) {
  return {
    x: originX + Math.sin(yawRad) * radius,
    y: originY - Math.cos(yawRad) * radius,
  };
}
