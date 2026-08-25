/**
 * Derivative release ids for published map versions.
 *
 * A map version's id is `usmap_` + sha256(workspaceId, sourceMapId, releaseId),
 * and `simforge.map_versions` is unique on
 * `(workspace_id, source_map_asset_id, derivative_release_id)`. Binding the
 * release to nothing but the workspace's active editor asset release therefore
 * makes a map's *content* unable to change: republishing the same map with a
 * different closure resolves to the same version id, the insert is skipped by
 * `ON CONFLICT DO NOTHING`, and the identity re-select fails with
 * `map_version_identity_conflict` because the stored `browserClosureSha256` is
 * the old one. The only escape was deleting rows by hand.
 *
 * Folding a content discriminator into the release id makes both outcomes
 * correct without touching immutability:
 *
 *  - identical content resolves to the same release, so the same version id, so
 *    the publish is idempotent and returns the version that already exists;
 *  - changed content resolves to a different release, so a new version is
 *    published alongside the old one, and the editor's
 *    `ROW_NUMBER() OVER (PARTITION BY source_map_asset_id ORDER BY created_at DESC)`
 *    offers the newest while every already-authored scenario keeps the exact
 *    version it was bound to.
 *
 * The discriminator is computed from the member digests rather than from the
 * closure digest because the closure planner needs the release id as an input,
 * so the closure digest does not exist yet.
 */
import { createHash } from "node:crypto";

/** `[a-z0-9][a-z0-9.-]{0,38}`, matching what an optimize pass may request. */
export const RELEASE_SUFFIX_PATTERN = /^[a-z0-9][a-z0-9.-]{0,38}$/;

export type ReleaseContentMember = {
  relativePath: string;
  sha256: string;
};

/**
 * Stable 12-hex summary of exactly which bytes a closure contains.
 *
 * Paths are included, not just digests: moving the same bytes to a different
 * relative path is a different map, and a digest-only summary would call the two
 * closures identical.
 */
export function closureContentDiscriminator(members: readonly ReleaseContentMember[]): string {
  const hash = createHash("sha256");
  for (const member of [...members].sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update(member.relativePath).update("\0").update(member.sha256).update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * `<activeRelease>+<suffix?>+c<discriminator>`.
 *
 * The `c` prefix keeps the content segment recognisable in a database row, where
 * these ids are read by humans far more often than they are parsed.
 */
export function publishedMapReleaseId({
  activeReleaseId,
  members,
  releaseSuffix = null,
}: {
  activeReleaseId: string;
  members: readonly ReleaseContentMember[];
  releaseSuffix?: string | null;
}): string {
  if (!activeReleaseId.trim()) throw new Error("activeReleaseId is required");
  if (releaseSuffix !== null && !RELEASE_SUFFIX_PATTERN.test(releaseSuffix)) {
    throw new Error(`invalid release suffix: ${releaseSuffix}`);
  }
  const segments = [activeReleaseId, ...(releaseSuffix ? [releaseSuffix] : []), `c${closureContentDiscriminator(members)}`];
  return segments.join("+");
}
