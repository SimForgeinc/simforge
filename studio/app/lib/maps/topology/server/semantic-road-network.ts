import "server-only";

import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import { resolveMapAssetReference } from "@/app/lib/scenario-editor/scenario-api-store";
import { semanticRoadSegments } from "../semantic-road-segments";
import { readCompatibleSemanticGraphPublication } from "./semantic-graph-publication-store";
import { getSemanticMapGraph } from "./semantic-map-service";
import {
  TopologyUnavailableError,
  getRuntimeBoundMapTopologyIndex,
} from "./topology-index-service";

export async function readSemanticRoadSegmentsByMapAssetId(
  mapAssetId: string,
): Promise<RuntimeRoadSegment[] | null> {
  // The error boundary here is NARROW (PR-538 review P1-1). `null` means one
  // thing only: this map genuinely has no runtime topology to compile from
  // (TopologyUnavailableError) — the pre-existing contract callers rely on
  // (emit/placement skip the map; the segments route answers 404).
  //
  // Everything else PROPAGATES. S3 timeouts, DB failures, accepted-artifact
  // checksum/size/key/identity failures, and programming errors in graph
  // compile/projection are outages, not "an unbackfilled map": swallowing
  // them made the segments route's 500 branch unreachable and let a
  // transient outage produce a successful zero-yield run. The earlier
  // "fail soft on everything" rationale (a stale publication once took an
  // emit from 118 render-jobs to 0) is already served one level down:
  //
  // COMPATIBLE, not the strict reader: a stored publication that fails this
  // checkout's schema (older manifest, other compiler —
  // `manifest_invalid` / `artifact_payload_invalid`) reads as "no
  // publication", and this function then ACTUALLY falls back to the live
  // compile (`getSemanticMapGraph` + `getRuntimeBoundMapTopologyIndex`,
  // which re-read the runtime bundle and rebuild when no compatible
  // publication matches current provenance). Every caller coalesces null
  // with `?? []`, so a bare null for that class would be the same total
  // outage made quiet (measured 2026-07-31: yale/pedavoid emitted 0 scenes
  // with segments.length === 0). Checksum/identity failures fail CLOSED in
  // the compatible reader — a poisoned artifact must never silently degrade
  // to "no topology".
  const input = { mapAssetId, runtime: "carla_ue5" } as const;
  try {
    const publication = await readCompatibleSemanticGraphPublication(input);
    if (publication) {
      return semanticRoadSegments(publication.semanticMap, publication.topology);
    }
    const [graph, topology] = await Promise.all([
      getSemanticMapGraph(input),
      getRuntimeBoundMapTopologyIndex(input),
    ]);
    return semanticRoadSegments(graph, topology);
  } catch (err) {
    if (err instanceof TopologyUnavailableError) {
      // Loud but soft: a real and expected state, not an error.
      console.warn(
        `[semantic-road-network] no runtime topology for ${mapAssetId}: ${err.message}`,
      );
      return null;
    }
    throw err;
  }
}

export async function readSemanticRoadSegmentsByMapName(
  mapName: string,
): Promise<RuntimeRoadSegment[] | null> {
  const reference = await resolveMapAssetReference(mapName, "carla_ue5");
  if (!reference.mapAssetId) return null;
  return readSemanticRoadSegmentsByMapAssetId(reference.mapAssetId);
}
