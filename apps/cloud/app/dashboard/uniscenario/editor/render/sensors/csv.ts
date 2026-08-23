import { formatArtifactFloat } from "./ply";

export type RadarDetection = Readonly<{
  altitude: number;
  azimuth: number;
  depth: number;
  velocity: number;
}>;

const encoder = new TextEncoder();

/** CARLA radar column order, lexically sorted by the same four numeric fields. */
export function encodeRadarCsv(detections: readonly RadarDetection[]): Uint8Array {
  const ordered = [...detections].map(assertDetection).sort((left, right) =>
    left.altitude - right.altitude
    || left.azimuth - right.azimuth
    || left.depth - right.depth
    || left.velocity - right.velocity,
  );
  const rows = ordered.map((item) => [item.altitude, item.azimuth, item.depth, item.velocity]
    .map(formatArtifactFloat)
    .join(","));
  return encoder.encode(`${["altitude,azimuth,depth,velocity", ...rows].join("\n")}\n`);
}

function assertDetection(detection: RadarDetection): RadarDetection {
  formatArtifactFloat(detection.altitude);
  formatArtifactFloat(detection.azimuth);
  formatArtifactFloat(detection.depth);
  formatArtifactFloat(detection.velocity);
  return detection;
}
