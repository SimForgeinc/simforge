import { type MapExtent, parseRenderExtentArtifact, pickRenderExtentArtifact } from "./extent";

// The DB / S3 / asset-ref helpers are `server-only`; importing them statically
// would poison the generator's module graph for standalone tsx tools (e.g.
// dump-scenario-candidates.ts). They're dynamically imported inside the guarded
// fetch below, so module-load stays safe everywhere and a non-server context
// simply degrades the fetch to null (fall back to the const / bundle bbox).

/**
 * Source of truth for a map's usable-extent guard: the per-map-asset
 * `render_extent` artifact (measured from the 0.10 render map by
 * `services/carla-worker/scripts/dump_map_extents.py`, stored in S3 +
 * `map_asset_artifacts`, keyed by CARLA version). This is the read side of the
 * map-edge placement guard — the generator calls it once per map, and passes the
 * result to `resolveMapExtent`.
 */

/** CARLA render runtime the autogen path targets (UE5.5 / 0.10). The
 * `render_extent` artifact key embeds the version (`render-extents/carla-0.10.…`),
 * so this prefix selects the right one when a map has extents for multiple
 * versions. Override via env if the target render runtime changes. */
const RENDER_RUNTIME_VERSION_PREFIX =
  process.env.SCENARIO_RENDER_RUNTIME_VERSION?.trim() || "carla-0.10";

function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  if (!uri.startsWith("s3://")) return null;
  const rest = uri.slice("s3://".length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { bucket: rest.slice(0, slash), key: rest.slice(slash + 1) };
}

/**
 * Fetch a map's measured 0.10 usable extent from its `render_extent` map-asset
 * artifact. Returns null on ANY miss — no asset reference, no mapAssetId, no
 * render_extent artifact, unreadable S3, or malformed JSON — so the caller falls
 * back to the interim const / bundle bbox. Never throws (the guard is optional).
 */
export async function fetchMapRenderExtent(mapName: string): Promise<MapExtent | null> {
  try {
    const [{ resolveMapAssetReference }, { getMapAssetByIdFromDb }, { getS3ObjectUtf8 }] =
      await Promise.all([
        import("@/app/lib/scenario-editor/scenario-api-store"),
        import("@/app/lib/db/map-asset-store"),
        import("@/app/lib/s3/s3-get-object"),
      ]);
    const ref = await resolveMapAssetReference(mapName);
    if (!ref?.mapAssetId) return null;
    const asset = await getMapAssetByIdFromDb(ref.mapAssetId);
    if (!asset) return null;
    const artifact = pickRenderExtentArtifact(asset.artifacts, RENDER_RUNTIME_VERSION_PREFIX);
    if (!artifact) return null;
    const loc = parseS3Uri(artifact.uri);
    if (!loc) return null;
    const text = await getS3ObjectUtf8(loc.bucket, loc.key);
    return parseRenderExtentArtifact(text);
  } catch {
    return null;
  }
}
