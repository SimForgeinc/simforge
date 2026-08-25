import { S3_BUCKET_PUBLIC } from "@/app/lib/s3/s3-config";
import type { MapAsset } from "@simforge/studio-shared";
import {
  formatTimestamp,
  generateMapAssetId,
} from "@/app/lib/maps/frontend/add-map-utils";
import type { FormState, ParsedMetaState } from "./AddMapForm";
import type { TrackedUpload } from "./UploadStatusBadge";

type DebugPreviewOpts = {
  form: FormState;
  parsedMeta: ParsedMetaState;
  autoTagSet: Set<string>;
  uploads: Record<string, TrackedUpload>;
};

/** Build the debug preview payload. Overture enrichment is async after submit. */
export function buildDebugPayload(opts: DebugPreviewOpts) {
  const { form, parsedMeta, autoTagSet, uploads } = opts;
  const now = new Date();
  const id = form.name.trim()
    ? generateMapAssetId(form.name, now)
    : "map-name-preview_" + formatTimestamp(now);

  const mapAsset: MapAsset = {
    map_asset_id: id,
    name: form.name.trim() || "(name not set)",
    description: form.description.trim() || undefined,
    carla_map_name: form.carlaMapName.trim() || undefined,
    crs: form.crs,
    bbox: form.computed?.bbox ?? { min_lat: 0, min_lng: 0, max_lat: 0, max_lng: 0 },
    center: form.computed?.center ?? { lat: 0, lng: 0 },
    created_at: now.toISOString(),
    artifacts: [
      ...(form.geojsonFile
        ? [
            {
              artifact_type: "geojson" as const,
              uri: `s3://${S3_BUCKET_PUBLIC}/maps/${id}/${id}.geojson`,
              sha256: uploads["geojson"]?.sha256 ?? "(pending)",
            },
          ]
        : []),
      ...(form.xodrFile
        ? [
            {
              artifact_type: "xodr" as const,
              uri: `s3://${S3_BUCKET_PUBLIC}/maps/${id}/${id}.xodr`,
              sha256: uploads["xodr"]?.sha256 ?? "(pending)",
            },
          ]
        : []),
      ...(form.rrdataXmlFile
        ? [
            {
              artifact_type: "rrdata_xml" as const,
              uri: `s3://${S3_BUCKET_PUBLIC}/maps/${id}/${id}_rrdata.xml`,
              sha256: uploads["rrdata_xml"]?.sha256 ?? "(pending)",
            },
          ]
        : []),
    ],
    tags: form.tags.length > 0 ? form.tags : undefined,
    ...(parsedMeta.xodr?.mapSource ? { map_source: parsedMeta.xodr.mapSource } : {}),
    ...(parsedMeta.xodr?.coordinateRef ? { map_coordinate_ref: parsedMeta.xodr.coordinateRef } : {}),
    ...(form.placeCity || form.placeState || form.placeCountry
      ? {
          place_context: {
            city: form.placeCity || undefined,
            state: form.placeState || undefined,
            country: form.placeCountry || undefined,
          },
        }
      : {}),
  };

  const xodrStats = parsedMeta.xodr?.roadStats;
  const geoStats = parsedMeta.geojson;
  const sigStats = parsedMeta.rrdata_xml?.signalization;
  const mapStats = xodrStats
    ? {
        road_network: {
          total_roads: xodrStats.total_roads || undefined,
          total_junctions: xodrStats.total_junctions || undefined,
          total_centerline_length_m: xodrStats.total_centerline_length_m > 0 ? xodrStats.total_centerline_length_m : undefined,
          lane_counts: xodrStats.lane_counts,
          roads_with_bike_lanes: xodrStats.roads_with_bike_lanes || undefined,
          roads_with_sidewalks: xodrStats.roads_with_sidewalks || undefined,
          signal_count: xodrStats.signal_count || undefined,
          crosswalk_count: xodrStats.crosswalk_count,
          parking_space_count: geoStats?.parking_space_count || undefined,
          speed_limits_mph: xodrStats.speed_limits_mph?.length > 0 ? xodrStats.speed_limits_mph : undefined,
          max_grade_pct: xodrStats.max_grade_pct > 0 ? xodrStats.max_grade_pct : undefined,
          segments_above_4pct_grade: xodrStats.segments_above_4pct_grade > 0 ? xodrStats.segments_above_4pct_grade : undefined,
          junction_road_degree_counts: xodrStats.junction_road_degree_counts,
        },
        signalization: sigStats || undefined,
        feature_inventory: {
          junctions: { total: xodrStats.total_junctions || undefined },
          crosswalks: { total: xodrStats.crosswalk_count, signalized: 0, unsignalized: xodrStats.crosswalk_count },
          signals: xodrStats.signal_count || undefined,
          parking_spaces: geoStats?.parking_space_count || undefined,
          turn_movements: geoStats
            ? {
                straight: geoStats.turn_straight,
                left: geoStats.turn_left,
                right: geoStats.turn_right,
                uturn_left: geoStats.turn_uturn_left,
                uturn_right: geoStats.turn_uturn_right,
              }
            : undefined,
        },
      }
    : undefined;

  const tagBreakdown = {
    auto_derived: form.tags.filter((t) => autoTagSet.has(t)),
    manually_added: form.tags.filter((t) => !autoTagSet.has(t)),
  };

  const uploadStatus = Object.fromEntries(
    Object.entries(uploads).map(([k, v]) => [k, v.status]),
  );

  return {
    map_asset: mapAsset,
    map_stats: mapStats,
    tag_breakdown: tagBreakdown,
    upload_status: Object.keys(uploadStatus).length > 0 ? uploadStatus : undefined,
  };
}
