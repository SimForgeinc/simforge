import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";

import { extractLanePolygonsFromXodr } from "@/app/lib/maps/metadata/lane-polygons";
import { extractSignalFeaturesFromXodr } from "@/app/lib/maps/metadata/xodr-signals";
import {
  buildMapTopologyIndex,
  TOPOLOGY_CONTENT_EPOCH,
} from "@simforge-oss/maps/topology";

import type { MapTopologyIndex } from "@simforge-oss/maps/topology";
import type { LanePolygonFeatureCollection } from "@/app/lib/maps/metadata/lane-polygons";
import type { SignalFeatureCollection } from "@/app/lib/maps/metadata/xodr-signals";

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Deterministic bytes: the closure digest binds these, so two publishes of one
 * map must produce identical sidecars. Node writes a zero MTIME field into the
 * gzip header unless a caller overrides it, which is what makes level-9 output
 * reproducible; `mtime` is deliberately not passed because it is absent from
 * `ZlibOptions` and would only restate the default.
 */
function gzipCanonicalJson(value: unknown): Buffer {
  return gzipSync(Buffer.from(`${canonicalJson(value)}\n`), { level: 9 });
}

export function buildRoadSidecars({
  xodrText,
  xodrSha256,
  mapName,
}: {
  xodrText: string;
  xodrSha256: string;
  mapName: string;
}): {
  topology: { index: MapTopologyIndex; bytes: Buffer };
  lanePolygons: { json: LanePolygonFeatureCollection; bytes: Buffer };
  signals: { json: SignalFeatureCollection; bytes: Buffer };
} {
  const topologyIndex = buildMapTopologyIndex({
    mapName,
    xodr: xodrText,
    xodrSha256,
    // generatedAt is part of the digest-bound index, so wall-clock time would
    // make identical uploads diverge. This is now also the builder's default;
    // it stays explicit here because these bytes are content-addressed.
    now: () => TOPOLOGY_CONTENT_EPOCH,
  });
  const lanePolygons = extractLanePolygonsFromXodr(xodrText);
  // An empty collection is a valid statement that the map authors supplied no signals.
  const signals = extractSignalFeaturesFromXodr(xodrText);

  return {
    topology: { index: topologyIndex, bytes: gzipCanonicalJson(topologyIndex) },
    lanePolygons: { json: lanePolygons, bytes: gzipCanonicalJson(lanePolygons) },
    signals: { json: signals, bytes: gzipCanonicalJson(signals) },
  };
}
