/**
 * Road-class admission gate for the ramp families (dib 2026-07-17).
 *
 * highway_entry / highway_exit are only meaningful where a REAL freeway exists:
 * the earlier geometric-only admission ("narrow lane merging onto a multi-lane
 * road") misfired on arterial maps — Page Mill's "entries" were parking-lot
 * aisles and side streets, so the subject drove through lots, stop signs and red
 * lights. The decisive signal is the OSM/Overture `road_class` enrichment in
 * each map's stored search-index: a candidate chain qualifies only when its
 * MAINLINE lane lies inside the footprint of a `motorway`-classified street
 * (the ramp itself is typically unclassified — the mainline is the anchor).
 * Today that admits San Ramon P1 (I-680, 88 motorway streets) and potentially
 * Richmond Field Station (I-580, 13); Page Mill has zero → zero candidates.
 *
 * FAIL-CLOSED by design: no stored search-index, no motorway streets, or no
 * footprint passed to the candidate filter → the ramp families admit NOTHING.
 * A super-low yield is acceptable for this niche category (dib 2026-07-17).
 *
 * Kept as a small parallel-path module: read-only reuse of shared pure loaders
 * (map-asset-store + MapProjection), no coupling into the editor flow.
 */
import { gunzipSync } from "node:zlib";
import { getS3ObjectBytes } from "@/app/lib/s3/s3-get-object";
import { MapProjection } from "@simforge-oss/studio-shared";
import {
  getMapArtifactLocation,
  getMapAssetByIdFromDb,
  getMapAssetByRuntimeNameFromDb,
} from "@/app/lib/db/map-asset-store";
import type { RuntimeRoadSegment } from "@/app/lib/runtime/runtime-types";
import { centerlinePointAtFraction } from "./routing";

/** Motorway street footprint in RUNTIME XY (projected at load time so the
 * candidate filter stays pure and synchronous). */
export interface MotorwayFootprint {
  /** [minX, minY, maxX, maxY] per motorway street, margin already applied. */
  boxes: Array<[number, number, number, number]>;
  /** Number of motorway-classified streets found (0 => gate admits nothing). */
  streetCount: number;
}

/** Margin around each street bbox (m): freeway corridors are wide and the
 * street bbox hugs the Overture centerline; the mainline lane midpoint must
 * land inside, so pad generously but not enough to leak onto frontage roads. */
const FOOTPRINT_MARGIN_M = 40;

/** Pure: is a runtime-XY point inside any motorway street box? */
export function footprintContains(
  footprint: MotorwayFootprint,
  x: number,
  y: number,
): boolean {
  for (const [minX, minY, maxX, maxY] of footprint.boxes) {
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) return true;
  }
  return false;
}

/** Pure: does the chain's MAINLINE segment (last hop for entry, the candidate
 * itself for exit) sit inside the motorway footprint? `null`/absent footprint
 * fails closed. */
export function chainMainlineInMotorway(
  footprint: MotorwayFootprint | null | undefined,
  mainline: RuntimeRoadSegment,
): boolean {
  if (!footprint || footprint.streetCount === 0) return false;
  const mid = centerlinePointAtFraction(mainline, 0.5);
  if (!mid || !Number.isFinite(mid.x) || !Number.isFinite(mid.y)) return false;
  return footprintContains(footprint, mid.x, mid.y);
}

/**
 * Load the motorway footprint for a runtime map name from its stored
 * search-index artifact. Returns null (fail-closed) when the asset, artifact,
 * coordinate ref, or any motorway street is missing. Never throws for absent
 * data — a map without a freeway is the common case, not an error.
 */
export async function loadMotorwayFootprintForMap(
  runtimeMapName: string,
): Promise<MotorwayFootprint | null> {
  const ident = await getMapAssetByRuntimeNameFromDb(
    runtimeMapName.replace(/_26$/, ""),
  );
  if (!ident) return null;
  const asset = await getMapAssetByIdFromDb(ident.map_asset_id);
  if (!asset) return null;
  const loc = await getMapArtifactLocation(ident.map_asset_id, "search_index");
  if (!loc) return null;
  let body: {
    objects?: Record<
      string,
      { kind?: string; bbox?: number[]; facts?: { road_class?: string } }
    >;
  };
  try {
    const raw = Buffer.from(await getS3ObjectBytes(loc.bucket, loc.key));
    const text =
      raw[0] === 0x1f && raw[1] === 0x8b
        ? gunzipSync(raw).toString("utf8")
        : raw.toString("utf8");
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const coordinateRef = (asset as { map_coordinate_ref?: unknown })
    .map_coordinate_ref;
  if (!coordinateRef) return null;
  const proj = MapProjection.fromCoordinateRef(
    coordinateRef as Parameters<typeof MapProjection.fromCoordinateRef>[0],
  );
  if (!proj) return null;
  const boxes: MotorwayFootprint["boxes"] = [];
  for (const obj of Object.values(body.objects ?? {})) {
    if (obj?.kind !== "street") continue;
    if (obj?.facts?.road_class !== "motorway") continue;
    const bbox = obj.bbox;
    if (!Array.isArray(bbox) || bbox.length < 4) continue;
    const minLon = Number(bbox[0]);
    const minLat = Number(bbox[1]);
    const maxLon = Number(bbox[2]);
    const maxLat = Number(bbox[3]);
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) continue;
    // Project all four corners (tmerc is near-conformal at map scale, so the
    // corner hull bounds the street) and pad with the margin.
    const corners = [
      proj.geoToLocal(minLon, minLat),
      proj.geoToLocal(minLon, maxLat),
      proj.geoToLocal(maxLon, minLat),
      proj.geoToLocal(maxLon, maxLat),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    boxes.push([
      Math.min(...xs) - FOOTPRINT_MARGIN_M,
      Math.min(...ys) - FOOTPRINT_MARGIN_M,
      Math.max(...xs) + FOOTPRINT_MARGIN_M,
      Math.max(...ys) + FOOTPRINT_MARGIN_M,
    ]);
  }
  return { boxes, streetCount: boxes.length };
}
