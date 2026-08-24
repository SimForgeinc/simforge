import "server-only";

import {
  buildSemanticMapGraph,
  type RuntimeBoundLaneGeometry,
  type RuntimeTopologyFamily,
  type SemanticMapGraph,
} from "@simcloud/shared";
import { readRuntimeTopologyBundleInput } from "@/app/lib/editor-map/runtime-topology-bundle";
import { getRuntimeBoundMapTopologyIndex } from "./topology-index-service";
import { readCompatibleSemanticGraphPublication } from "./semantic-graph-publication-store";

/** The runtime bundle was republished between provenance read and bundle
 *  read; the request is retryable once the bundle settles. */
export class SemanticGraphBundleChangedError extends Error {
  constructor() {
    super("Runtime bundle changed while compiling the semantic map graph.");
    this.name = "SemanticGraphBundleChangedError";
  }
}

const MAX_ENTRIES = 8;
const cache = new Map<string, SemanticMapGraph>();
const inFlight = new Map<string, Promise<SemanticMapGraph>>();

function remember(key: string, graph: SemanticMapGraph): void {
  cache.delete(key);
  cache.set(key, graph);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function runtimeGeometry(
  segments: Awaited<ReturnType<typeof readRuntimeTopologyBundleInput>>["runtime"]["road_segments"],
): Record<string, RuntimeBoundLaneGeometry> {
  const result: Record<string, RuntimeBoundLaneGeometry> = {};
  for (const segment of segments ?? []) {
    if (!Array.isArray(segment.centerline) || segment.centerline.length < 2) continue;
    const rsl = `${segment.road_id}:${segment.section_id}:${segment.lane_id}`;
    result[rsl] = {
      rsl,
      storedOrder: "road_s",
      representativeWidthM:
        typeof segment.lane_width === "number" && segment.lane_width > 0
          ? segment.lane_width
          : null,
      polyline: segment.centerline.map((point) => ({
        x: point.x,
        y: point.y,
        z: Number.isFinite(point.z) ? point.z : null,
      })),
    };
  }
  return result;
}

async function compileSemanticMapGraph(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
}): Promise<SemanticMapGraph> {
  const topology = await getRuntimeBoundMapTopologyIndex(input);
  const provenance = topology.runtimeProvenance;
  const key = [
    provenance.mapAssetId,
    provenance.runtimeFamily,
    provenance.bundleVersion,
    provenance.xodrSha256,
    provenance.runtimeRoadGraphSha256,
  ].join(":");
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const published = await readCompatibleSemanticGraphPublication(input);
  if (
    published &&
    published.manifest.bundleVersion === provenance.bundleVersion &&
    published.manifest.xodrSha256 === provenance.xodrSha256 &&
    published.manifest.runtimeRoadGraphSha256 === provenance.runtimeRoadGraphSha256
  ) {
    remember(key, published.semanticMap);
    return published.semanticMap;
  }

  const bundle = await readRuntimeTopologyBundleInput(
    provenance.runtimeMapName,
    provenance.bundleVersion,
  );
  if (
    bundle.xodrSha256 !== provenance.xodrSha256 ||
    bundle.runtimeRoadGraphSha256 !== provenance.runtimeRoadGraphSha256 ||
    bundle.mapAssetId !== provenance.mapAssetId
  ) {
    throw new SemanticGraphBundleChangedError();
  }
  const graph = buildSemanticMapGraph({
    topology,
    runtimeLaneGeometry: runtimeGeometry(bundle.runtime.road_segments),
    generatedAt: topology.generatedAt,
  });
  remember(key, graph);
  return graph;
}

export async function getSemanticMapGraph(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
}): Promise<SemanticMapGraph> {
  const requestKey = `${input.mapAssetId.trim()}:${input.runtime}`;
  const existing = inFlight.get(requestKey);
  if (existing) return existing;
  const pending = compileSemanticMapGraph(input);
  inFlight.set(requestKey, pending);
  try {
    return await pending;
  } finally {
    if (inFlight.get(requestKey) === pending) inFlight.delete(requestKey);
  }
}

export function __clearSemanticMapCache(): void {
  evictSemanticMapCache();
  inFlight.clear();
}

/** Release completed graph objects after request-scoped bulk compilation. */
export function evictSemanticMapCache(): void {
  cache.clear();
}
