export type LidarPoint = Readonly<{ x: number; y: number; z: number; intensity: number }>;

const encoder = new TextEncoder();

/**
 * CARLA-compatible ASCII PLY: numeric tuple sort (x,y,z,intensity) and the
 * bridge's locale-independent Python `.9g` number representation.
 */
export function encodeLidarPly(points: readonly LidarPoint[]): Uint8Array {
  const ordered = [...points].map(assertPoint).sort(compareLidarPoints);
  const header = [
    "ply",
    "format ascii 1.0",
    `element vertex ${ordered.length}`,
    "property float x",
    "property float y",
    "property float z",
    "property float intensity",
    "end_header",
  ];
  const rows = ordered.map((point) => [point.x, point.y, point.z, point.intensity].map(formatArtifactFloat).join(" "));
  return encoder.encode(`${[...header, ...rows].join("\n")}\n`);
}

export function compareLidarPoints(left: LidarPoint, right: LidarPoint): number {
  return left.x - right.x
    || left.y - right.y
    || left.z - right.z
    || left.intensity - right.intensity;
}

export function formatArtifactFloat(value: number): string {
  if (!Number.isFinite(value)) throw new Error("Sensor artifacts cannot contain non-finite numbers.");
  if (value === 0) return "0";
  const rounded = Number(value.toPrecision(9));
  const exponent = Math.floor(Math.log10(Math.abs(rounded)));
  if (exponent < -4 || exponent >= 9) {
    const mantissa = trimDecimal((rounded / 10 ** exponent).toFixed(8));
    const sign = exponent < 0 ? "-" : "+";
    return `${mantissa}e${sign}${Math.abs(exponent).toString().padStart(2, "0")}`;
  }
  return trimDecimal(rounded.toFixed(Math.max(0, 8 - exponent)));
}

function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function assertPoint(point: LidarPoint): LidarPoint {
  formatArtifactFloat(point.x);
  formatArtifactFloat(point.y);
  formatArtifactFloat(point.z);
  formatArtifactFloat(point.intensity);
  return point;
}
