import "server-only";

import type { JunctionMovementBinding, RuntimeTopologyFamily } from "@simforge/studio-shared";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  getRuntimeBoundMapTopology,
  getRuntimeLaneTravelDirections,
} from "@/app/lib/maps/topology/server/topology-index-service";
import { readCompatibleSemanticGraphPublication } from "@/app/lib/maps/topology/server/semantic-graph-publication-store";
import { deriveSignalJunctionIndex } from "@/app/lib/scenario-editor/signals/junction-index";
import { readJunctionSignalGroups } from "@/app/lib/scenario-editor/signals/xodr-signal-groups.server";

/**
 * Derived signal movement tables for specific junctions of a map — the exact
 * derivation the `signal-junctions` API route serves to the intersection
 * panel (gates → approach heads → movements + conflicts → per-movement head
 * narrowing), reduced to the junctions cross-map transfer is rebinding onto.
 *
 * Returns `null` when the derivation inputs cannot be read (topology bundle,
 * publication, signal groups): the caller must treat that as "signal
 * enforceability unknown" and fail its transfer explicitly rather than emit a
 * plan or trigger that might be unenforceable.
 */
export async function readSignalMovementTables(input: {
  mapAssetId: string;
  runtime: RuntimeTopologyFamily;
  junctionIds: readonly string[];
}): Promise<ReadonlyMap<string, JunctionMovementBinding[]> | null> {
  const wanted = new Set(input.junctionIds.map((id) => id.trim()).filter(Boolean));
  if (wanted.size === 0) return new Map();
  try {
    const asset = await getMapAssetByIdFromDb(input.mapAssetId);
    if (!asset) return null;
    const bound = await getRuntimeBoundMapTopology({
      mapAssetId: input.mapAssetId,
      runtime: input.runtime,
    });
    // Gate bearings must be read in the direction the lane is DRIVEN — see
    // the signal-junctions route for why the crawl's answer is asked for
    // explicitly (published indexes ship without it).
    const laneTravel = await getRuntimeLaneTravelDirections(bound);
    const topology = laneTravel.size > 0
      ? { ...bound.index, laneTravelIncreasesS: Object.fromEntries(laneTravel) }
      : bound.index;
    let controlBindings = null;
    try {
      const publication = await readCompatibleSemanticGraphPublication({
        mapAssetId: input.mapAssetId,
        runtime: input.runtime,
      });
      controlBindings = publication?.semanticExecutionIndex.controlBindings ?? null;
    } catch (error) {
      console.warn("signal-movement-tables: control bindings unavailable", error);
    }
    const signalGroups = await readJunctionSignalGroups({
      mapAssetId: input.mapAssetId,
      expectedXodrSha256: topology.source.xodrSha256,
      runtimeMapName: asset.ue5_carla_map_name ?? null,
    });
    const index = deriveSignalJunctionIndex({
      mapAssetId: input.mapAssetId,
      topology,
      controlBindings,
      signalGroups,
    });
    return new Map(
      index.junctions
        .filter((junction) => wanted.has(junction.junction_id))
        .map((junction) => [junction.junction_id, junction.movements]),
    );
  } catch (error) {
    console.warn("signal-movement-tables: derivation unavailable", {
      mapAssetId: input.mapAssetId,
      error,
    });
    return null;
  }
}
