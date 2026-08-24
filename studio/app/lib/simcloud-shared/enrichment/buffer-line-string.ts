/**
 * Buffer an ordered polyline of [lng, lat] points into a closed polygon ring.
 *
 * Computes a unit normal at each vertex (averaged at bends), offsets the
 * polyline left and right by `bufferMeters`, and stitches the two offset
 * polylines into a single closed ring.
 *
 * Works in WGS-84 degrees with a flat-earth approximation; `refLat` is used
 * to convert metres → longitude degrees. Good enough for city-scale maps;
 * artifacts show up only at extreme latitudes or very long polylines.
 */
export function bufferLineString(
  pts: [number, number][],
  bufferMeters: number,
  refLat: number,
): [number, number][] {
  const dLat = bufferMeters / 111_320;
  const dLng = bufferMeters / (111_320 * Math.max(Math.cos((refLat * Math.PI) / 180), 0.2));

  if (pts.length < 2) {
    const [lng, lat] = pts[0] ?? [0, 0];
    return [
      [lng - dLng, lat - dLat],
      [lng + dLng, lat - dLat],
      [lng + dLng, lat + dLat],
      [lng - dLng, lat + dLat],
      [lng - dLng, lat - dLat],
    ];
  }

  // Per-vertex normals (perpendicular to line direction, averaged at bends).
  const normals: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    let nx = 0, ny = 0;
    if (i > 0) {
      const dx = pts[i]![0] - pts[i - 1]![0];
      const dy = pts[i]![1] - pts[i - 1]![1];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-12) {
        nx += -dy / len;
        ny += dx / len;
      }
    }
    if (i < pts.length - 1) {
      const dx = pts[i + 1]![0] - pts[i]![0];
      const dy = pts[i + 1]![1] - pts[i]![1];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 1e-12) {
        nx += -dy / len;
        ny += dx / len;
      }
    }
    const nLen = Math.sqrt(nx * nx + ny * ny);
    normals.push(nLen > 1e-12 ? [nx / nLen, ny / nLen] : [0, 1]);
  }

  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i]!;
    const [nx, ny] = normals[i]!;
    left.push([px + nx * dLng, py + ny * dLat]);
    right.push([px - nx * dLng, py - ny * dLat]);
  }

  const ring: [number, number][] = [...left, ...right.reverse()];
  ring.push(ring[0]!);
  return ring;
}
