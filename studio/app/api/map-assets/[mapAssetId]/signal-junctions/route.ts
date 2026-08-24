import { NextRequest, NextResponse } from "next/server";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  getRuntimeBoundMapTopology,
  getRuntimeLaneTravelDirections,
  TopologyUnavailableError,
} from "@/app/lib/maps/topology/server/topology-index-service";
import { readCompatibleSemanticGraphPublication } from "@/app/lib/maps/topology/server/semantic-graph-publication-store";
import { deriveSignalJunctionIndex } from "@/app/lib/scenario-editor/signals/junction-index";
import { readJunctionSignalGroups } from "@/app/lib/scenario-editor/signals/xodr-signal-groups.server";
import { ServerTimingRecorder } from "@/app/lib/http/server-timing";
import {
  isTransientInfrastructureError,
  transientFailureHeaders,
} from "@/app/lib/http/transient-errors";
import { MapAssetIdParams } from "@/app/lib/api-schemas";
void MapAssetIdParams;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * List a map's authorable signal junctions.
 * @description Reduces the XODR-derived MapTopologyIndex to one entry per
 *   junction — centre, radius, and the derived movement table the intersection
 *   panel authors on — and marks the junctions a traffic-light control device
 *   governs. Exists because the topology index itself is far too large to ship
 *   to the editor: this is the few-hundred-kilobyte projection of it the signal
 *   UI actually needs.
 * @pathParams MapAssetIdParams
 * @responseSet common
 * @add 404
 * @tag Map assets
 * @openapi
 */
export async function GET(_req: NextRequest, { params }: RouteContext) {
  const timing = new ServerTimingRecorder();
  const { mapAssetId } = await params;
  if (!mapAssetId?.trim()) {
    return timing.finish(
      NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 }),
    );
  }
  const asset = await timing.measure("aurora_map_asset", () =>
    getMapAssetByIdFromDb(mapAssetId));
  if (!asset) {
    return timing.finish(
      NextResponse.json({ error: "Map asset not found" }, { status: 404 }),
    );
  }

  try {
    const bound = await timing.measure("topology", () =>
      getRuntimeBoundMapTopology({ mapAssetId, runtime: "carla_ue5" }));
    // Every gate bearing in the movement table is read in the direction the lane
    // is DRIVEN, and half a real map's lanes are driven against `+s`. The bound
    // index carries `laneTravelIncreasesS` only on the COMPILE path: an index
    // restored from an accepted semantic-graph publication ships without the
    // crawl it was compiled from, and every long-lived dev/prod map is served
    // from exactly such a publication. Asking for the directions explicitly is
    // what makes the route use CARLA's own per-waypoint answer there too rather
    // than silently falling back to the lane-sign convention.
    //
    // Fails soft by construction — `getRuntimeLaneTravelDirections` returns an
    // empty map when the bundle cannot be re-read, and the convention fallback
    // in `lane-travel.ts` takes over lane by lane.
    const laneTravel = await timing.measure("lane_travel", () =>
      getRuntimeLaneTravelDirections(bound));
    const topology = laneTravel.size > 0
      ? { ...bound.index, laneTravelIncreasesS: Object.fromEntries(laneTravel) }
      : bound.index;
    // Best-effort: a map with no compiled semantic graph still has junctions
    // and movements — it just cannot say which of them are signalized, which
    // the index reports as `signalization_source: "topology_only"` so the
    // client can fall back to its runtime traffic lights.
    let controlBindings = null;
    try {
      const publication = await timing.measure("control_bindings", () =>
        readCompatibleSemanticGraphPublication({
          mapAssetId,
          runtime: "carla_ue5",
        }));
      controlBindings = publication?.semanticExecutionIndex.controlBindings ?? null;
    } catch (error) {
      console.warn("signal-junctions: control bindings unavailable", error);
    }

    // Identity-gated against the topology's own XODR source, which is the
    // RUNTIME BUNDLE's xodr — hence the map name, so the groups come from the
    // same bytes the topology was compiled from rather than the uploaded
    // RoadRunner artifact, whose sha could never match.
    //
    // The bundle read this triggers is served from the runtime bundle cache —
    // `getMapTopologyIndex` above has almost always just populated it for the
    // same map — and the derived groups are themselves cached per map, so the
    // name is no longer the extra download it once was.
    const signalGroups = await timing.measure("signal_groups", () =>
      readJunctionSignalGroups({
        mapAssetId,
        expectedXodrSha256: topology.source.xodrSha256,
        runtimeMapName: asset.ue5_carla_map_name ?? null,
      }));

    const index = timing.measureSync("derive_index", () =>
      deriveSignalJunctionIndex({
        mapAssetId,
        topology,
        controlBindings,
        signalGroups,
      }));
    return timing.finish(NextResponse.json(index, {
      status: 200,
      headers: { "cache-control": "private, max-age=300" },
    }));
  } catch (e) {
    // An S3 or network blip is not "this map has no junctions" — say so, and
    // tell the client when to come back. Asked first, and through the cause
    // chain, because a timeout reaching the manifest surfaces as a
    // `runtime_bundle_missing` `TopologyUnavailableError`. See
    // `transient-errors.ts`.
    if (isTransientInfrastructureError(e)) {
      console.warn("signal-junctions: transient read failure", e);
      return timing.finish(NextResponse.json(
        {
          error: "The signal junction index could not be read right now.",
          code: "topology_read_unavailable",
        },
        { status: 503, headers: transientFailureHeaders() },
      ));
    }
    if (e instanceof TopologyUnavailableError) {
      return timing.finish(NextResponse.json({ error: e.message }, { status: 404 }));
    }
    console.error("signal-junctions error:", e);
    return timing.finish(NextResponse.json(
      { error: "Failed to build the signal junction index" },
      { status: 500 },
    ));
  }
}
