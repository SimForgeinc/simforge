import { laneTravelIncreasesSByConvention } from "@simforge/studio-shared";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import { buildRuntimeRoadCenterlineOnlyOverlay } from "@/app/lib/editor-map/runtime-road-overlay";
import { ServerTimingRecorder } from "@/app/lib/http/server-timing";
import {
  isTransientInfrastructureError,
  transientFailureHeaders,
} from "@/app/lib/http/transient-errors";
import { travelHeadingDegrees } from "@/app/lib/maps/topology/server/lane-travel-direction";
import {
  getRuntimeBoundMapTopology,
  getRuntimeLaneTravelDirections,
  TopologyUnavailableError,
} from "@/app/lib/maps/topology/server/topology-index-service";
import type { RuntimeMapResponse } from "@/app/lib/runtime/runtime-types";

type RouteContext = { params: Promise<{ mapAssetId: string }> };


const QuerySchema = z
  .object({
    runtime: z.literal("carla_ue5"),
    minX: z.coerce.number().finite(),
    minY: z.coerce.number().finite(),
    maxX: z.coerce.number().finite(),
    maxY: z.coerce.number().finite(),
  })
  .refine((value) => value.minX < value.maxX && value.minY < value.maxY);

/**
 * Does this lane's bounding box overlap the viewport?
 *
 * One pass, no allocation. The version this replaces built two throwaway
 * coordinate arrays per lane per request and then spread each of them into
 * `Math.max`/`Math.min` twice — and that spread is not just slow, it is a
 * cliff: a single lane with more vertices than the engine's argument limit
 * (~65k on V8) throws `RangeError: Maximum call stack size exceeded`, which
 * this route would have surfaced as a blanket 422 "CARLA runtime topology is
 * unavailable" on an otherwise perfectly good map.
 *
 * Non-finite vertices are skipped rather than poisoning the extent (a `NaN`
 * inside `Math.max` made every comparison false, i.e. "intersects"). A lane
 * with no finite vertex at all has no position to draw at and is excluded.
 */
function intersects(
  points: readonly { x: number; y: number }[],
  viewport: z.infer<typeof QuerySchema>,
) {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    const { x, y } = point;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX > maxX || minY > maxY) return false;
  return !(
    maxX < viewport.minX ||
    minX > viewport.maxX ||
    maxY < viewport.minY ||
    minY > viewport.maxY
  );
}

function waypointRef(rsl: string) {
  const [roadId, sectionId, laneId] = rsl.split(":");
  const parsedRoadId = Number(roadId);
  const parsedSectionId = Number(sectionId);
  const parsedLaneId = Number(laneId);
  if (
    !Number.isFinite(parsedRoadId) ||
    !Number.isFinite(parsedSectionId) ||
    !Number.isFinite(parsedLaneId)
  ) {
    return null;
  }
  return {
    rsl,
    road_id: parsedRoadId,
    section_id: parsedSectionId,
    lane_id: parsedLaneId,
  };
}

function allowedLaneChange(
  permissions: Array<{ side: "left" | "right"; allowed: boolean }> | undefined,
) {
  const sides = new Set(
    (permissions ?? [])
      .filter((permission) => permission.allowed)
      .map((permission) => permission.side),
  );
  if (sides.has("left") && sides.has("right")) return "Both";
  if (sides.has("left")) return "Left";
  if (sides.has("right")) return "Right";
  return "None";
}

/**
 * Exact CARLA runtime lane geometry for the visible editor viewport.
 *
 * This is deliberately separate from the semantic overlay: it preserves
 * junction connectors, lane widths, and runtime lane identities even when a
 * semantic feature is diagnostic-only. The route reads the runtime-bound
 * OpenDRIVE/CARLA topology service rather than the semantic overlay, so normal
 * actor placement does not depend on transfer data being published.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  const timing = new ServerTimingRecorder();
  const auth = await timing.measure("session", () => requireRouteSession(request));
  if (!auth.ok) return timing.finish(auth.response);
  const query = QuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries()),
  );
  if (!query.success) {
    return timing.finish(auth.apply(
      NextResponse.json(
        { error: "A bounded UE5 runtime viewport is required." },
        { status: 400 },
      ),
    ));
  }

  const { mapAssetId } = await context.params;
  const asset = await timing.measure("aurora_map_asset", () =>
    getMapAssetByIdFromDb(mapAssetId));
  if (!asset) {
    return timing.finish(auth.apply(
      NextResponse.json({ error: "Map asset not found." }, { status: 404 }),
    ));
  }
  let topology;
  let laneTravelFollowsPolyline: ReadonlyMap<string, boolean>;
  try {
    const bound = await timing.measure("topology", () =>
      getRuntimeBoundMapTopology({
        mapAssetId,
        runtime: query.data.runtime,
      }));
    topology = bound.index;
    laneTravelFollowsPolyline = await timing.measure("lane_travel", () =>
      getRuntimeLaneTravelDirections(bound));
  } catch (error) {
    // A map that is genuinely not bound to a CARLA runtime and an S3 timeout
    // used to produce the identical 422, so the editor said "this map has no
    // runtime topology" for a fault that would have cleared on a retry. A
    // transient fault is a 503 with `Retry-After`, and `no-store` so nothing
    // between here and the browser keeps the failure.
    //
    // Checked BEFORE the `TopologyUnavailableError` branch and through the
    // cause chain, because a timeout reaching the bundle manifest arrives here
    // wrapped as `runtime_bundle_missing` — indistinguishable from an uncooked
    // map except by what it wraps.
    if (isTransientInfrastructureError(error)) {
      console.warn("runtime-geometry: transient topology read failure", error);
      return timing.finish(auth.apply(
        NextResponse.json(
          {
            error: "CARLA runtime topology could not be read right now.",
            code: "topology_read_unavailable",
          },
          { status: 503, headers: transientFailureHeaders() },
        ),
      ));
    }
    const message =
      error instanceof TopologyUnavailableError
        ? error.message
        : "CARLA runtime topology is unavailable.";
    return timing.finish(auth.apply(
      NextResponse.json(
        { error: message },
        { status: 422 },
      ),
    ));
  }

  // The response is a pure function of the bundle identity and the viewport,
  // both of which are known before any projection work. An unchanged bundle
  // therefore answers 304 without building the overlay at all — and a
  // republished one changes the tag, so clients refetch without anyone having
  // to remember to bump a version by hand.
  const provenance = topology.runtimeProvenance ?? {};
  // Each part is optional on purpose: a bundle missing a provenance field
  // should still serve geometry with a weaker tag, not fail the request.
  const digest = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value.slice(0, 16) : "-";
  // The bundle version is NOT truncated. Versions are named like
  // `carla-0.10.0-22.06-v3-munich-20260715`, so the first 16 characters are a
  // constant prefix across every republish — truncating it made this component
  // contribute nothing. The content hashes below would still have caught a
  // republish, but a version identifier that cannot distinguish versions is a
  // trap for whoever reads this next.
  const version = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : "-";
  const etag = `"${[
    "rg1",
    version(provenance.bundleVersion),
    digest(provenance.xodrSha256),
    digest(provenance.runtimeRoadGraphSha256),
    digest(provenance.projectionIdentitySha256),
    digest(provenance.compilerVersion),
    query.data.runtime,
    [query.data.minX, query.data.minY, query.data.maxX, query.data.maxY]
      .map((bound) => Math.round(bound))
      .join(","),
  ].join(":")}"`;
  if (request.headers.get("if-none-match") === etag) {
    return timing.finish(auth.apply(
      new NextResponse(null, {
        status: 304,
        headers: { etag, "cache-control": "private, max-age=60, must-revalidate" },
      }),
    ));
  }

  // Runtime binding decides where an actor may be PLACED. It does not decide
  // what the road LOOKS like, and conflating the two is why a street renders as
  // two thin ribbons down the middle of nothing: CARLA's waypoint crawl is
  // driving-only, so no sidewalk, shoulder, parking or bike lane has ever been
  // runtime-bound on any map, and `bdb75546f` filtered all 512 of Di Rosa's
  // non-driving lanes out of the overlay along with the genuinely unusable ones.
  //
  // The OpenDRIVE index already carries every one of them with a polyline and a
  // representative width — no re-cook, no new artifact, no export change — and
  // the client has had lane-type colours and visibility toggles for
  // sidewalk/parking/shoulder/biking this whole time, defaulted on, waiting for
  // features that stopped arriving. So ship them, and stamp each feature with
  // whether it is runtime-bound so the PLACEMENT path can keep refusing them.
  const runtimeBoundLaneRsls = new Set(topology.runtimeParity.boundLaneRsls);
  //
  // A lane with fewer than two vertices is excluded outright. It has no ribbon
  // to draw and no centerline to snap to, and it used to be filtered out
  // incidentally, by never being runtime-bound — so dropping the binding filter
  // without this reaches `intersects` with geometry that isn't there.
  const matchingLanes = timing.measureSync("viewport_cull", () =>
    Object.values(topology.lanes).filter(
      (lane) =>
        Array.isArray(lane.polyline) &&
        lane.polyline.length >= 2 &&
        intersects(lane.polyline, query.data),
    ),
  );
  // Always ship the compact form: a width ribbon is two vertices per
  // centerline vertex and was being sent ALONGSIDE the centerline it is
  // derived from, so two thirds of the payload was reconstructible from the
  // other third (Munich, 389 lanes: 3.15 MB -> 1.03 MB). The browser rebuilds
  // the ribbons on arrival via `expandRuntimeRoadOverlayRibbons`, which is the
  // same offset math this used to run here.
  const lanes = matchingLanes;
  // Push into the bucket rather than rebuilding it with a spread on every
  // insert: the spread copied every gate already recorded for an approach, so
  // grouping was quadratic in the gates a single approach carries.
  const gatesByApproach = new Map<string, Array<(typeof topology.gates)[number]>>();
  for (const gate of topology.gates) {
    const bucket = gatesByApproach.get(gate.approachLaneRsl);
    if (bucket) bucket.push(gate);
    else gatesByApproach.set(gate.approachLaneRsl, [gate]);
  }
  const runtime: RuntimeMapResponse = timing.measureSync("project_lanes", () => ({
    schema_version: topology.schemaVersion,
    map_name: topology.runtimeProvenance.runtimeMapName,
    normalized_map_name: topology.runtimeProvenance.runtimeMapName,
    road_segments: lanes.map((lane) => {
      const sameDirectionLane = (side: "left" | "right") => {
        const adjacent = lane.adjacentLanes?.[side];
        return adjacent?.sameDirection && adjacent.laneRsl
          ? waypointRef(adjacent.laneRsl)
          : null;
      };
      let station = 0;
      // Which way this lane is DRIVEN, from CARLA's own waypoint yaw rather
      // than the lane-id sign convention — see `lane-travel-direction.ts`. The
      // polyline is sampled in s-increasing order, which says nothing about
      // travel; emitting a +s heading faces both sides of a two-way road the
      // same way and drives the against-+s side head-on into the ego. When the
      // crawl has no usable yaw for the lane, fall back to the convention,
      // which is what this route did for every lane before.
      const followsTravel =
        laneTravelFollowsPolyline.get(lane.rsl) ??
        laneTravelIncreasesSByConvention(lane.laneId);
      return {
        id: lane.rsl,
        road_id: lane.roadId,
        section_id: lane.section,
        lane_id: lane.laneId,
        lane_type: lane.laneType,
        runtime_bound: runtimeBoundLaneRsls.has(lane.rsl),
        is_junction: lane.isJunction,
        lane_change: allowedLaneChange(lane.laneChangePermissions),
        lane_width: lane.representativeWidthM ?? undefined,
        left_lane: sameDirectionLane("left"),
        right_lane: sameDirectionLane("right"),
        successors: lane.successors
          .map(waypointRef)
          .filter((item): item is NonNullable<typeof item> => item !== null),
        predecessors: lane.predecessors
          .map(waypointRef)
          .filter((item): item is NonNullable<typeof item> => item !== null),
        turn_options: (gatesByApproach.get(lane.rsl) ?? []).map((gate) => ({
          relation: gate.turnRelation,
          branch_waypoint: waypointRef(gate.connectingLaneRsl),
          entry_waypoint: waypointRef(gate.approachLaneRsl),
          junction_exit_waypoint: waypointRef(gate.exitLaneRsls[0] ?? ""),
          heading_delta_degrees: (gate.headingChangeRad * 180) / Math.PI,
          classification_source: "runtime_bound_opendrive_topology",
        })),
        centerline: lane.polyline.map((point, index) => {
          const previous = lane.polyline[Math.max(0, index - 1)] ?? point;
          const next =
            lane.polyline[Math.min(index + 1, lane.polyline.length - 1)] ?? point;
          if (index > 0) station += Math.hypot(point.x - previous.x, point.y - previous.y);
          // The last vertex has no `next` of its own; take its heading from the
          // edge behind it instead of from a zero-length one (which reads east).
          const isLast = index === lane.polyline.length - 1;
          return {
            x: point.x,
            y: point.y,
            z: 0,
            yaw: isLast
              ? travelHeadingDegrees(previous, point, followsTravel)
              : travelHeadingDegrees(point, next, followsTravel),
            s: station,
            lane_width: lane.representativeWidthM ?? undefined,
          };
        }),
      };
    }),
  }));
  const overlay = timing.measureSync(
    "overlay",
    () =>
      buildRuntimeRoadCenterlineOnlyOverlay(asset, runtime, null)?.data ?? {
        type: "FeatureCollection",
        features: [],
      },
  );
  return timing.finish(auth.apply(
    timing.measureSync("serialize", () => NextResponse.json(overlay, {
      headers: {
        etag,
        // `must-revalidate` so the browser asks after the window rather than
        // silently re-downloading 1.19 MB; the ETag turns that ask into a 304.
        "cache-control": "private, max-age=60, must-revalidate",
        "x-simforge-runtime-geometry-lanes": String(lanes.length),
        "x-simforge-runtime-geometry-matching-lanes": String(matchingLanes.length),
        "x-simforge-runtime-geometry-representation": "centerline",
        "x-simforge-runtime-geometry-truncated": "false",
        // How many lanes got their direction from CARLA's waypoint yaw rather
        // than the lane-id sign fallback. A zero here on a real map means the
        // crawl never reached us, and every heading is a guess again.
        "x-simforge-runtime-geometry-travel-resolved": String(
          laneTravelFollowsPolyline.size,
        ),
      },
    })),
  ));
}
