import "server-only";

import { cacheLife, cacheTag } from "next/cache";

import type { AppContext } from "@/app/lib/db/app-context";
import { queryRows } from "@/app/lib/db/data-api";
import { gunzipToUtf8 } from "@/app/lib/s3/gzip";
import { getS3ObjectBytes, getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";
import type { TopologyIndex } from "@simforge/engine";

import {
  readEditorSignalControlProjection,
  type DerivedTopologyConflicts,
} from "./control-plan.server";
import type { EditorSignalControlProjection } from "./types";

/**
 * The authorized, cached read that gives the signal panel real data.
 *
 * ## Why the bytes are fetched server-side rather than presigned to the client
 *
 * The panel needs {@link EditorSignalControlProjection}, which is tens of
 * kilobytes. Its inputs are a whole XODR and a whole topology index — tens of
 * megabytes. Handing the client presigned URLs for those and building the
 * projection in the browser would ship three orders of magnitude more bytes than
 * the answer, and it would put `parseMapSignalCatalog` (and therefore
 * `contentHash`, and therefore `controlDigest`) on two implementations' worth of
 * environment: a digest that differs between Node and a browser would invalidate
 * every plan authored on the other one.
 *
 * Reading the objects directly by `{bucket, key}` also sidesteps plan §2.5.3
 * structurally rather than by discipline: **no presigned URL exists on this
 * path at all**, so there is nothing to accidentally cache. `control-plan.server.ts`
 * is a pure function of bytes for exactly this reason.
 *
 * ## What is cached, and why that is safe
 *
 * The published artifact set of a map version is immutable: `map_versions` is
 * unique on `(workspace_id, xodr_sha256, coordinate_system_sha256)` and the
 * artifact rows it points at are content-addressed and `artifact_state =
 * 'available'`. Nothing advances a column here while a user watches, so this is
 * the `cacheLife('days')` class under the rule at the head of plan §2.5, keyed on
 * `mapVersionId` (§2.5.2). Published map versions are platform-global; the authenticated wrapper
 * remains outside the cache so session material never reaches cache storage.
 *
 * Authorization stays outside the cache (§2.5.1). The exported wrapper takes an
 * `AppContext` that `requireScenarioContext` already produced and passes only
 * primitives inward, so no verdict and no session material reaches cache storage.
 */

type SignalArtifactRow = {
  map_id: string | null;
  xodr_sha256: string;
  xodr_bucket: string | null;
  xodr_key: string | null;
  topology_bucket: string | null;
  topology_key: string | null;
  signals_bucket: string | null;
  signals_key: string | null;
  derived_bucket: string | null;
  derived_key: string | null;
};

/**
 * Why the derived-topology join is `LEFT` while the other three are not.
 *
 * The XODR, the topology index and `signals.geojson` are the projection's
 * inputs: without any one of them there is no projection to build, so their
 * absence is a missing map version rather than a degraded one. The derived
 * topology carries only gate conflicts, which
 * {@link EditorSignalControlProjection.conflictPairsByJunction} documents as
 * advisory — an unreachable one costs the pre-flight warning and nothing else,
 * and `conflictSource: "none"` says so rather than guessing.
 */
async function readSignalArtifactRow(mapVersionId: string) {
  return queryRows<SignalArtifactRow>(
    `SELECT mv.source_map_asset_id AS map_id, mv.xodr_sha256,
       xa.storage_bucket AS xodr_bucket, xa.storage_key AS xodr_key,
       ta.storage_bucket AS topology_bucket, ta.storage_key AS topology_key,
       sa.storage_bucket AS signals_bucket, sa.storage_key AS signals_key,
       da.storage_bucket AS derived_bucket, da.storage_key AS derived_key
     FROM simforge.map_versions mv
     JOIN simforge.artifacts xa ON xa.id = mv.xodr_artifact_id
       AND xa.workspace_id = mv.workspace_id AND xa.artifact_state = 'available'
     JOIN simforge.artifacts ta ON ta.id = mv.topology_artifact_id
       AND ta.workspace_id = mv.workspace_id AND ta.artifact_state = 'available'
     JOIN simforge.artifacts sa ON sa.id = mv.signals_artifact_id
       AND sa.workspace_id = mv.workspace_id AND sa.artifact_state = 'available'
     LEFT JOIN simforge.artifacts da ON da.id = mv.derived_topology_artifact_id
       AND da.workspace_id = mv.workspace_id AND da.artifact_state = 'available'
     WHERE mv.id = :map_version_id
       AND mv.retired_at IS NULL
       AND NULLIF(BTRIM(mv.source_map_asset_id), '') IS NOT NULL`,
    { map_version_id: mapVersionId },
  );
}

/**
 * `.json` or `.json.gz`, decided by the BYTES rather than by the key.
 *
 * The compiler writes the derived topology gzipped (`topology-derived.json.gz`)
 * and the topology index plain, so both conventions arrive here. Keying on the
 * extension is the obvious rule and it is wrong in one specific way:
 * `getS3ObjectBytes` already gunzips anything stored with
 * `Content-Encoding: gzip`, so a `.json.gz` object that also carries the header
 * would be decompressed twice and fail on the second pass. Testing for the gzip
 * magic handles either convention and cannot double-decompress.
 */
const GZIP_MAGIC = [0x1f, 0x8b] as const;

async function readJsonArtifact(bucket: string, key: string): Promise<unknown> {
  const bytes = await getS3ObjectBytes(bucket, key);
  const gzipped = bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1];
  const text = gzipped
    ? await gunzipToUtf8(bytes)
    : Buffer.from(bytes).toString("utf8");
  return JSON.parse(text) as unknown;
}

async function readProjection(
  mapVersionId: string,
): Promise<EditorSignalControlProjection | null> {
  "use cache";
  cacheLife("days");
  cacheTag(`scenario:map-version:${mapVersionId}`);

  const [row] = await readSignalArtifactRow(mapVersionId);
  if (
    !row?.map_id ||
    !row.xodr_bucket ||
    !row.xodr_key ||
    !row.topology_bucket ||
    !row.topology_key ||
    !row.signals_bucket ||
    !row.signals_key
  ) {
    return null;
  }

  const [xodr, topology, signalsGeoJson, derivedTopology] = await Promise.all([
    getS3ObjectUtf8(row.xodr_bucket, row.xodr_key),
    readJsonArtifact(row.topology_bucket, row.topology_key) as Promise<TopologyIndex>,
    readJsonArtifact(row.signals_bucket, row.signals_key),
    row.derived_bucket && row.derived_key
      ? (readJsonArtifact(row.derived_bucket, row.derived_key) as Promise<DerivedTopologyConflicts>)
      : Promise.resolve(null),
  ]);

  return readEditorSignalControlProjection({
    mapVersionId,
    mapId: row.map_id,
    xodrSha256: row.xodr_sha256,
    xodr,
    signalsGeoJson,
    topology,
    derivedTopology,
  });
}

/**
 * The projection for one map version, or `null` when the map publishes no
 * signal closure.
 *
 * `null` is a normal outcome — a map version whose `signals_artifact_id` is unset
 * has no authorable signals at all — and the panel renders it as "this map
 * carries no traffic-signal data" rather than as an error.
 */
export async function getScenarioSignalControlProjection(
  _context: AppContext,
  mapVersionId: string,
): Promise<EditorSignalControlProjection | null> {
  return readProjection(mapVersionId);
}
