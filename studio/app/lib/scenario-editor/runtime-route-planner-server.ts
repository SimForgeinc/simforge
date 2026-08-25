import "server-only";

import {
  routeThroughAnchors,
  type MapAsset,
  type ScenarioEditorRoadAnchor,
} from "@simforge/studio-shared";
import { runtimePointToLngLat } from "@/app/lib/editor-map/coordinates";
import { getSemanticMapGraph } from "@/app/lib/maps/topology/server/semantic-map-service";
import type { RouteOverlayResolution } from "./route-overlay-geometry";

export async function resolveRuntimeActorRoutes(input: {
  asset: MapAsset;
  routes: Array<{
    actorId: string;
    anchors: ScenarioEditorRoadAnchor[];
  }>;
}): Promise<Record<string, RouteOverlayResolution>> {
  const graph = await getSemanticMapGraph({
    mapAssetId: input.asset.map_asset_id,
    runtime: "carla_ue5",
  });
  return Object.fromEntries(
    input.routes.map(({ actorId, anchors }) => {
      const resolved = routeThroughAnchors(
        graph,
        anchors.map((anchor) => ({
          rsl:
            anchor.section_id == null || anchor.lane_id == null
              ? ""
              : `${anchor.road_id}:${anchor.section_id}:${anchor.lane_id}`,
          sFraction: anchor.s_fraction,
          ...(anchor.world_anchor
            ? {
                point: {
                  x: anchor.world_anchor.x,
                  y: anchor.world_anchor.y,
                  z: anchor.world_anchor.z,
                },
              }
            : {}),
        })),
      );
      return [
        actorId,
        {
          lines: resolved.lines.map((line) =>
            line
              .map((point) => runtimePointToLngLat(point, input.asset))
              .filter(
                (point): point is [number, number] => point !== null,
              ),
          ),
          unresolvedLegIndexes: resolved.unresolvedLegIndexes,
        },
      ];
    }),
  );
}
