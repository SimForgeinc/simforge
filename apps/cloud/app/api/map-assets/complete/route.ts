import { NextRequest, NextResponse } from "next/server";
import {
  MAP_ASSET_ARTIFACT_TYPE_VALUES,
  type MapAsset,
  type MapAssetArtifact,
  type MapPlaceContext,
} from "@simcloud/shared";
import { upsertMapAsset } from "@/app/lib/db/map-asset-store";
import { computeMapMetadataBundle, mergeMapTags } from "@/app/lib/maps/metadata/compute-map-metadata";
import { fetchRequiredMapArtifactTextsFromKeys } from "@/app/lib/maps/metadata/fetch-map-artifacts-by-keys";
import { uploadAndRegisterSignalOverlay } from "@/app/lib/maps/metadata/upload-signal-overlay";
import { uploadAndRegisterLanePolygonOverlay } from "@/app/lib/maps/metadata/upload-lane-polygon-overlay";
import { enqueueEnrichmentJob } from "@/app/lib/enrichment/enqueue-job";
import { putS3ObjectUtf8Gzipped } from "@/app/lib/s3/s3-put-object";

import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import { CompleteMapAssetBody, CreateMapAssetResponse } from "@/app/lib/api-schemas";
void CompleteMapAssetBody; void CreateMapAssetResponse;

const BUCKET = S3_BUCKET;
const MAPS_PREFIX = "maps/";

function hasRequiredArtifactTypes(
  list: Array<{ artifact_type: MapAssetArtifact["artifact_type"] }>,
): boolean {
  const types = new Set(list.map((a) => a.artifact_type));
  return types.has("geojson") && types.has("xodr") && types.has("rrdata_xml");
}

/**
 * Complete map asset creation after client uploads files to presigned URLs
 * @description Writes the new map asset metadata to Aurora. S3 remains the binary store.
 * @body CompleteMapAssetBody
 * @response 200:CreateMapAssetResponse
 * @responseSet common
 * @tag Map assets
 * @openapi
 */
export async function POST(request: NextRequest) {
  // Per-step timing. Logged incrementally (not as one summary line) so that
  // when Amplify's SSR proxy kills a slow request with
  // "Request timed out - your application took too long to respond", the LAST
  // [complete-timing] line in CloudWatch identifies the step it died in.
  const tStart = Date.now();
  let tLast = tStart;
  let timingMapId = "?";
  const lap = (step: string) => {
    const now = Date.now();
    console.log(
      `[complete-timing] mapAssetId=${timingMapId} step=${step} step_ms=${now - tLast} total_ms=${now - tStart}`,
    );
    tLast = now;
  };
  try {
    const body = await request.json();
    const mapAssetId = (body.mapAssetId as string)?.trim();
    timingMapId = mapAssetId || "?";
    const name = (body.name as string)?.trim();
    const description = (body.description as string)?.trim() || undefined;
    const carlaMapName = (body.carlaMapName as string | null | undefined)?.trim() || undefined;
    const crs = (body.crs as string)?.trim() || "EPSG:4326";
    const tagsRaw = body.tags;
    const mapCenter = body.mapCenter as { lat: number; lng: number } | undefined;
    const bbox = body.bbox as { min_lat: number; min_lng: number; max_lat: number; max_lng: number } | undefined;
    const artifactsInput = body.artifacts as Array<{ key: string; artifact_type: string; sha256: string; size_bytes?: number }> | undefined;
    const placeContextOverride = body.placeContextOverride as MapPlaceContext | null | undefined;

    if (!mapAssetId || !name) {
      return NextResponse.json({ error: "Missing required fields: mapAssetId, name" }, { status: 400 });
    }
    if (!mapCenter || typeof mapCenter.lat !== "number" || typeof mapCenter.lng !== "number") {
      return NextResponse.json({ error: "Invalid or missing mapCenter" }, { status: 400 });
    }
    if (
      !bbox ||
      typeof bbox.min_lat !== "number" ||
      typeof bbox.min_lng !== "number" ||
      typeof bbox.max_lat !== "number" ||
      typeof bbox.max_lng !== "number"
    ) {
      return NextResponse.json({ error: "Invalid or missing bbox" }, { status: 400 });
    }
    if (!Array.isArray(artifactsInput) || artifactsInput.length === 0) {
      return NextResponse.json({ error: "artifacts array is required and must not be empty" }, { status: 400 });
    }

    // Validate size_bytes if provided
    if (
      artifactsInput.some(
        (a) =>
          a.size_bytes != null &&
          (typeof a.size_bytes !== "number" || !Number.isSafeInteger(a.size_bytes) || a.size_bytes < 0),
      )
    ) {
      return NextResponse.json(
        { error: "Invalid artifact size_bytes (must be a non-negative integer)" },
        { status: 400 },
      );
    }

    let tags: string[] = [];
    if (Array.isArray(tagsRaw)) {
      tags = tagsRaw.filter((t): t is string => typeof t === "string");
    } else if (typeof tagsRaw === "string" && tagsRaw) {
      try {
        tags = JSON.parse(tagsRaw);
      } catch {
        tags = [];
      }
      if (!Array.isArray(tags)) tags = [];
    }
    const allowedTypes = new Set(MAP_ASSET_ARTIFACT_TYPE_VALUES);
    const artifacts: MapAssetArtifact[] = artifactsInput
      .filter((a: { key?: string; artifact_type?: string; sha256?: string }) => a?.key && a?.artifact_type && a?.sha256)
      .filter((a) => {
        if (a.key.includes("..")) return false;
        return a.key.startsWith(MAPS_PREFIX) && allowedTypes.has(a.artifact_type as MapAssetArtifact["artifact_type"]);
      })
      .map((a) => ({
        artifact_type: a.artifact_type as MapAssetArtifact["artifact_type"],
        uri: `s3://${BUCKET}/${a.key}`,
        sha256: a.sha256,
        ...(a.size_bytes != null ? { size_bytes: a.size_bytes } : {}),
      }));

    if (artifacts.length === 0) {
      return NextResponse.json({ error: "No valid artifacts (key must be under maps/)" }, { status: 400 });
    }

    if (!hasRequiredArtifactTypes(artifacts)) {
      return NextResponse.json(
        {
          error: "Missing required artifact types",
          detail: "Each map must include geojson, xodr, and rrdata_xml artifacts.",
        },
        { status: 400 },
      );
    }

    const keysPayload = artifacts.map((a) => ({
      artifact_type: a.artifact_type,
      key: a.uri.replace(`s3://${BUCKET}/`, ""),
    }));

    lap("validate");

    const fetched = await fetchRequiredMapArtifactTextsFromKeys(BUCKET, keysPayload);
    if (!fetched.ok) {
      return NextResponse.json(
        { error: "Could not resolve required artifact keys", missing: fetched.missing },
        { status: 400 },
      );
    }
    lap("fetch-artifacts");

    const bundle = computeMapMetadataBundle({
      mapAssetId,
      ...fetched.data,
    });
    lap("compute-metadata");

    const mergedTags = mergeMapTags(tags, bundle.ingest_tags);

    const newAsset: MapAsset = {
      map_asset_id: mapAssetId,
      name,
      description,
      carla_map_name: carlaMapName,
      crs,
      bbox,
      center: mapCenter,
      created_at: new Date().toISOString(),
      artifacts,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
      map_source: bundle.map_source,
      map_coordinate_ref: bundle.map_coordinate_ref,
      // User-provided override takes precedence over geocoded result; if override
      // has some fields set and others empty, merge with geocoded to fill gaps.
      place_context: placeContextOverride
        ? {
            city: placeContextOverride.city || bundle.place_context?.city,
            state: placeContextOverride.state || bundle.place_context?.state,
            country: placeContextOverride.country || bundle.place_context?.country,
            country_code: placeContextOverride.country_code || bundle.place_context?.country_code,
            geocoder: "manual" as const,
          }
        : bundle.place_context,
      metadata_last_populated_at: bundle.map_stats.computed_at,
      map_stats: bundle.map_stats,
    };

    await upsertMapAsset(newAsset);
    // Boundary: the map row is durably persisted from here. A 504 after this
    // line still leaves the map created — which is exactly the reported bug.
    lap("upsert");

    // Re-upload the main GeoJSON as gzip-encoded so subsequent downloads (browser
    // + enrichment Lambda) receive a compressed payload. Clients upload the raw
    // file via presigned PUT, which doesn't negotiate Content-Encoding; this
    // rewrites the same key with the body already in memory. Bytes-after-
    // decompression are identical to the upload — the GeoJSON is treated as
    // immutable from this point forward, no `__mapId` injection or other
    // mutation. The stored sha256 / size_bytes still reference the original
    // upload. Non-critical — if this fails the raw upload remains in place.
    try {
      const geojsonKeyEntry = keysPayload.find((k) => k.artifact_type === "geojson");
      if (geojsonKeyEntry) {
        await putS3ObjectUtf8Gzipped(
          BUCKET,
          geojsonKeyEntry.key,
          fetched.data.geojsonText,
          "application/geo+json",
        );
      }
    } catch (e) {
      console.warn("main geojson gzip re-upload failed (non-critical):", e);
    }
    lap("geojson-gzip");

    // Candidate-location extraction and the first search-index build used to
    // run synchronously here. They added ~19s to the request and pushed
    // `/complete` past Amplify's SSR response budget on the deployed env
    // (502/504, map created but no UI confirmation). Both now run inside the
    // async `third_party_enrichment` Lambda, which calls the internal
    // `candidate-locations/extract` then `search-index/rebuild` endpoints —
    // the same off-request pattern enrichment already used. The detail page
    // polls `/enrichment/status` and shows a "Finalizing" state until the
    // job is terminal. See AGENTS workflow_ids: frontend-release,
    // lambda-map-enrichment.

    // Upload signal overlay GeoJSON to S3 (non-critical)
    let signalFeatureCount = 0;
    try {
      const sigResult = await uploadAndRegisterSignalOverlay(mapAssetId, bundle.signal_features);
      signalFeatureCount = sigResult.featureCount;
    } catch (e) {
      console.warn("signal overlay upload failed (non-critical):", e);
    }
    lap("signal-overlay");

    // Upload lane-polygon overlay GeoJSON to S3 (non-critical)
    let lanePolygonFeatureCount = 0;
    try {
      const laneResult = await uploadAndRegisterLanePolygonOverlay(
        mapAssetId,
        bundle.lane_polygon_features,
      );
      lanePolygonFeatureCount = laneResult.featureCount;
    } catch (e) {
      console.warn("lane polygon overlay upload failed (non-critical):", e);
    }
    lap("lane-polygon-overlay");

    // Enqueue the post-ingest `third_party_enrichment` job unconditionally.
    // The Lambda now owns the full off-request finalize sequence: it calls
    // the internal `candidate-locations/extract` endpoint (detector pipeline),
    // pulls Overture themes (POIs, buildings, road names) for the bbox,
    // persists a snapshot + merged tags, then calls `search-index/rebuild`.
    // Non-blocking: the 200 response carries `enrichment_job_id` on success
    // or `enrichment_job_error` on failure (never both). The detail page
    // keys its "Finalizing" state off `enrichment_job_id`.
    let enrichmentJobId: string | null = null;
    let enrichmentJobError: string | null = null;
    try {
      const { job } = await enqueueEnrichmentJob({
        mapAssetId,
        jobType: "third_party_enrichment",
      });
      enrichmentJobId = job.id;
    } catch (e) {
      console.warn("Auto-enqueue of post-ingest enrichment job failed:", e);
      enrichmentJobError = e instanceof Error ? e.message : String(e);
    }
    lap("enqueue-enrichment");
    lap("total");

    return NextResponse.json({
      mapAssetId,
      map_source: bundle.map_source,
      map_coordinate_ref: bundle.map_coordinate_ref,
      map_stats: bundle.map_stats,
      warnings: bundle.warnings,
      ingest_tags: bundle.ingest_tags,
      // Candidate extraction + search-index now run in the async enrichment
      // Lambda; these counts are populated there, not in the create response.
      candidate_location_count: null,
      signal_feature_count: signalFeatureCount,
      lane_polygon_feature_count: lanePolygonFeatureCount,
      search_index_object_count: null,
      enrichment_job_id: enrichmentJobId,
      enrichment_job_type: enrichmentJobId ? "third_party_enrichment" : null,
      enrichment_job_error: enrichmentJobError,
    });
  } catch (e) {
    const err = e as { name?: string };
    if (err?.name === "CredentialsProviderError" || String(e).includes("Could not load credentials")) {
      return NextResponse.json(
        {
          error: "S3 credentials not configured",
          detail: "Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and optionally AWS_REGION) in your environment or .env.local.",
        },
        { status: 503 }
      );
    }
    console.error("map-assets complete error:", e);
    return NextResponse.json(
      { error: "Failed to complete map asset" },
      { status: 500 }
    );
  }
}
