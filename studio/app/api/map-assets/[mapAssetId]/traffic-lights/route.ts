import { NextRequest, NextResponse } from "next/server";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import { RuntimeTopologyBundleError } from "@/app/lib/editor-map/runtime-topology-bundle";
import {
  EDITOR_TRAFFIC_LIGHTS_SCHEMA_VERSION,
  type EditorTrafficLightIndex,
} from "@/app/lib/scenario-editor/signals/editor-traffic-lights";
import { readEditorTrafficLights } from "@/app/lib/scenario-editor/signals/editor-traffic-lights.server";
import { ServerTimingRecorder } from "@/app/lib/http/server-timing";
import {
  isTransientInfrastructureError,
  transientFailureHeaders,
} from "@/app/lib/http/transient-errors";
import { MapAssetIdParams } from "@/app/lib/api-schemas";
void MapAssetIdParams;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * List a map's physical traffic-signal heads.
 * @description The editor's slim projection of the runtime map bundle's
 *   `traffic_lights` block — pose, OpenDRIVE id, lamp-box measurements and the
 *   stop lines each head governs, all in the runtime frame. Exists because the
 *   raw block is 113 KB–1.87 MB per map of CARLA bookkeeping the editor never
 *   reads, while this projection is 2–26 KB; and because the scenario-editor
 *   bootstrap stopped carrying `runtime` at all when it went semantic-first,
 *   which left every signal surface reading an empty list (audit 2026-07-27).
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
  const runtimeMapName = asset.ue5_carla_map_name?.trim();
  if (!runtimeMapName) {
    // A map with no CARLA runtime identity has no bundle to read heads from.
    // That is a lightless map for the editor's purposes, not a failure: the
    // signal surfaces stay empty and every junction keeps CARLA's own timers.
    return timing.finish(NextResponse.json(emptyIndex(mapAssetId), {
      status: 200,
      headers: { "cache-control": "private, max-age=300" },
    }));
  }

  try {
    // Cached per (runtime map, bundle version): reading the heads means reading
    // the whole multi-megabyte bundle, and the answer cannot change without a
    // new bundle. See `editor-traffic-lights.server.ts`.
    const read = await timing.measure("traffic_lights", () =>
      readEditorTrafficLights(runtimeMapName));
    const index: EditorTrafficLightIndex = {
      schema_version: EDITOR_TRAFFIC_LIGHTS_SCHEMA_VERSION,
      map_asset_id: mapAssetId,
      runtime_map_name: read.runtimeMapName,
      bundle_version: read.bundleVersion,
      traffic_lights: read.lights,
    };
    return timing.finish(NextResponse.json(index, {
      status: 200,
      // Same window as signal-junctions: both are properties of the MAP, so they
      // change only when the bundle is rebuilt.
      headers: { "cache-control": "private, max-age=300" },
    }));
  } catch (e) {
    // A network or S3 fault is not "this map has no lights". 503 and come back.
    //
    // Asked BEFORE the `RuntimeTopologyBundleError` branch: a timeout reaching
    // the manifest is reported as `manifest_missing`, exactly like a map that
    // was never cooked, and only the wrapped cause tells them apart.
    if (isTransientInfrastructureError(e)) {
      console.warn("traffic-lights: transient bundle read failure", e);
      return timing.finish(NextResponse.json(
        {
          error: "This map's traffic lights could not be read right now.",
          code: "bundle_read_unavailable",
        },
        { status: 503, headers: transientFailureHeaders() },
      ));
    }
    if (e instanceof RuntimeTopologyBundleError) {
      // No bundle for this map/version. Genuinely lightless maps and maps whose
      // bundle has not been cooked look the same here, and both leave the editor
      // usable, so this is a 404 rather than a 500.
      return timing.finish(NextResponse.json(
        { error: `No runtime map bundle for ${runtimeMapName}.`, code: e.code },
        { status: 404 },
      ));
    }
    console.error("traffic-lights error:", e);
    return timing.finish(NextResponse.json(
      { error: "Failed to read this map's traffic lights" },
      { status: 500 },
    ));
  }
}

function emptyIndex(mapAssetId: string): EditorTrafficLightIndex {
  return {
    schema_version: EDITOR_TRAFFIC_LIGHTS_SCHEMA_VERSION,
    map_asset_id: mapAssetId,
    runtime_map_name: "",
    bundle_version: "",
    traffic_lights: [],
  };
}
