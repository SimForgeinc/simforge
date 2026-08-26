import { createHash } from "node:crypto";
import {
  deriveXodrSignalGroups,
  type XodrJunctionSignalGroup,
} from "@simforge-oss/studio-shared";
import { getMapArtifactLocation } from "@/app/lib/db/map-asset-store";
import { getRuntimeMapArtifactVersion } from "@/app/lib/editor-map/runtime-map-artifacts";
import { readRuntimeTopologyBundleInput } from "@/app/lib/editor-map/runtime-topology-bundle";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";

/**
 * A map's XODR-derived signal groups, keyed by junction id.
 *
 * These are what let the intersection panel offer per-movement colours on a
 * protected-left approach: `attachSignalIdsToGates` gives every turn off an
 * approach that approach's whole head set, and `refineMovementSignalIds`
 * narrows the ones that genuinely own a head. Without the second step, left and
 * through look like they share a head and the `shared_signal_heads` warning
 * fires on plans that are in fact perfectly runnable.
 *
 * ## Why the checksum gate, and why it must read the BUNDLE
 *
 * Both refinement steps key off road-derived ids (`<road>.<section>.<side>` and
 * the movement ids built from them), and OpenDRIVE road ids renumber across UE5
 * map rebuilds — the `world_anchor` doctrine. So groups may only be derived
 * from the exact XODR the topology index was compiled from, and
 * `expectedXodrSha256` (`topology.source.xodrSha256`) is that identity.
 *
 * This module used to derive from the map asset's registered `xodr` artifact —
 * the RoadRunner file an author uploaded — and gate it on that sha. That gate
 * could **never** pass: the topology index is compiled from the runtime
 * bundle's XODR, which CARLA regenerates with `to_opendrive()`. Same map,
 * different producer, different bytes, so per-movement head refinement was
 * dead on every map in the fleet.
 *
 * The fix is to read the bundle's own XODR (`readRuntimeTopologyBundleInput`
 * returns `xodr` alongside the `xodrSha256` the topology records), which makes
 * the identity check tautological by construction rather than unsatisfiable.
 * It is still *checked*, because `getMapTopologyIndex` can return an accepted
 * semantic publication compiled from an older bundle — that is the one case
 * where the two genuinely disagree, and attaching heads across that gap could
 * bind a movement to a light on a different road.
 *
 * A live box probe (2026-07-26, all 11 dev maps) settled the open question this
 * switch depended on: `to_opendrive()` PRESERVES `<signal>` elements — 100% of
 * traffic-light actors resolve to a signal id present in the regenerated XODR
 * on every map.
 *
 * The uploaded artifact survives as an explicit fallback for the case the
 * bundle cannot supply a XODR at all. When neither source matches, skipping is
 * the safe answer: signal ids fall back to the semantic execution index, and
 * the worker falls back to its `approach_lane_rsls` matching.
 */
export type JunctionSignalGroups = ReadonlyMap<string, XodrJunctionSignalGroup>;

const EMPTY: JunctionSignalGroups = new Map();

/**
 * Identity of the DERIVATION, not of its input.
 *
 * The cache key below is otherwise pure content — map asset plus the xodr sha
 * the topology was compiled from — so identical bytes hand back an identical
 * answer forever. That is exactly wrong when the answer changes because the
 * CODE changed: `deriveXodrSignalGroups` reading `<signalReference>` binds heads
 * the same bytes did not bind yesterday, and nothing about the bytes says so.
 *
 * Bump on any change to `deriveXodrSignalGroups` that can alter which heads an
 * approach or movement gets. The cache is per-process, so a restart clears it
 * anyway; this is what keeps a HOT process (and any future persisted layer that
 * reuses this key) from serving an answer its own code would no longer produce.
 */
export const SIGNAL_GROUP_DERIVATION_VERSION =
  "simforge.xodr-signal-groups.v2-signal-references";

/** Per-map cache. Deriving groups means parsing a whole XODR. */
const cache = new Map<string, JunctionSignalGroups>();

export type ReadJunctionSignalGroupsInput = {
  mapAssetId: string;
  /** `topology.source.xodrSha256` — the identity the source must match. */
  expectedXodrSha256: string | null;
  /**
   * The runtime bundle's XODR, when the caller already holds a bundle. Saves
   * this module a second read of a file the caller just fetched.
   */
  bundleXodr?: string | null;
  /**
   * The map's runtime map name (`map_assets.ue5_carla_map_name`), so this
   * module can read the bundle itself when the caller has no bundle in hand.
   */
  runtimeMapName?: string | null;
};

/**
 * The cache identity: WHAT was derived, and by WHICH derivation.
 *
 * Exported so the version component is pinned by a test rather than a comment.
 */
export function junctionSignalGroupCacheKey(
  input: Pick<ReadJunctionSignalGroupsInput, "mapAssetId" | "expectedXodrSha256">,
): string {
  return [
    SIGNAL_GROUP_DERIVATION_VERSION,
    input.mapAssetId,
    input.expectedXodrSha256 ?? "",
  ].join(":");
}

export async function readJunctionSignalGroups(
  input: ReadJunctionSignalGroupsInput,
): Promise<JunctionSignalGroups> {
  const cacheKey = junctionSignalGroupCacheKey(input);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const groups = await deriveGroups(input);
  cache.set(cacheKey, groups);
  return groups;
}

function sha256Of(xodr: string): string {
  return createHash("sha256").update(xodr, "utf8").digest("hex");
}

/**
 * The bundle XODR, when one is reachable and is the file the topology index was
 * compiled from. `null` means "fall back to the uploaded artifact".
 */
async function bundleXodrMatchingTopology(
  input: ReadJunctionSignalGroupsInput,
): Promise<string | null> {
  let xodr = input.bundleXodr?.trim() ? input.bundleXodr : null;
  if (!xodr && input.runtimeMapName?.trim()) {
    try {
      const bundle = await readRuntimeTopologyBundleInput(
        input.runtimeMapName.trim(),
        getRuntimeMapArtifactVersion(),
      );
      xodr = bundle.xodr.trim() ? bundle.xodr : null;
    } catch (error) {
      console.warn("signal groups: runtime bundle unreadable", error);
      return null;
    }
  }
  if (!xodr) return null;

  if (sha256Of(xodr) !== input.expectedXodrSha256) {
    // The topology index came from an accepted semantic publication compiled
    // against an older bundle. Road ids may have renumbered under it.
    console.warn(
      `signal groups: runtime bundle xodr for ${input.mapAssetId} does not match the topology source`,
    );
    return null;
  }
  return xodr;
}

/** The uploaded RoadRunner artifact, gated on the same identity. */
async function artifactXodrMatchingTopology(
  input: ReadJunctionSignalGroupsInput,
): Promise<string | null> {
  const location = await getMapArtifactLocation(input.mapAssetId, "xodr");
  if (!location) return null;

  let xodr: string;
  try {
    xodr = await getS3ObjectUtf8(location.bucket, location.key);
  } catch (error) {
    console.warn("signal groups: xodr artifact unreadable", error);
    return null;
  }
  if (!xodr.trim()) return null;

  if (sha256Of(xodr) !== input.expectedXodrSha256) {
    console.warn(
      `signal groups: xodr artifact for ${input.mapAssetId} does not match the topology source; skipping per-movement signal refinement`,
    );
    return null;
  }
  return xodr;
}

async function deriveGroups(
  input: ReadJunctionSignalGroupsInput,
): Promise<JunctionSignalGroups> {
  if (!input.expectedXodrSha256) return EMPTY;

  const xodr =
    (await bundleXodrMatchingTopology(input)) ??
    (await artifactXodrMatchingTopology(input));
  if (!xodr) return EMPTY;

  try {
    const result = deriveXodrSignalGroups(xodr);
    return new Map(
      result.junctions.map((junction) => [junction.junction_id, junction]),
    );
  } catch (error) {
    console.warn("signal groups: derivation failed", error);
    return EMPTY;
  }
}

export function __clearJunctionSignalGroupCacheForTests(): void {
  cache.clear();
}
