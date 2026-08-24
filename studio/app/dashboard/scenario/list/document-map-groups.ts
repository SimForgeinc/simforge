import type { ScenarioDocumentSummaryDto } from "@/app/lib/scenario/contracts";
import type { ScenarioMapEntry } from "@simforge/editor";
import { documentEditedAtMs, documentMapLabel } from "./document-list-utils";

/**
 * A map descriptor as the list needs it: enough to title a group and paint its card.
 *
 * `thumbnailUrl` resolves `map_versions.thumbnail_artifact_id` through a stable Scenario route.
 * The browser never reads the source map-assets bucket or guesses a storage key.
 */
export type ScenarioMapOption = {
  mapVersionId: string;
  /** Canonical compiler-facing identity, distinct from the immutable version id. */
  sourceMapId: string;
  label: string;
  locality?: string | null;
  thumbnailUrl?: string | null;
  /**
   * The renderer entry point for this map, and the one URL here that is safe to hold.
   *
   * Unlike `thumbnailUrl` and the descriptor's manifest/topology URLs, this is not presigned — it is a
   * path on our own `browser-assets` proxy, so it has no expiry to outlive. That is exactly why the
   * scene preloader keys its cache on it (§2.5.3 forbids caching the presigned ones).
   */
  browserManifestUrl?: string | null;
  topologyUrl?: string | null;
  derivedTopologyUrl?: string | null;
  locationsUrl?: string | null;
  signalsUrl?: string | null;
  sumoNetworkUrl?: string | null;
} & Partial<
  Pick<
    ScenarioMapEntry,
    | "id"
    | "versionId"
    | "sourceMapId"
    | "browserAssetRootUrl"
    | "browserClosureSha256"
    | "artifacts"
    | "sumoNetworkSha256"
    | "manifestUrl"
  >
>;

export type ScenarioMapGroup = {
  /** The grouping key: the map version id, or `""` for documents with no map. */
  mapVersionId: string;
  /** Stable identity for view state and test hooks. Equals `mapVersionId` or `"no-map"`. */
  groupKey: string;
  displayLabel: string;
  latestEditedAtMs: number;
  documents: ScenarioDocumentSummaryDto[];
  thumbnailUrl: string | null;
};

/**
 * Group documents by map version, newest-edited group first.
 *
 * Grouping is on `mapVersionId` rather than on the label, unlike v1 which grouped on a
 * `backend_map_name || map_name || map_asset_id` string. In v2 the map version IS the identity — two
 * versions of the same town are different maps for authoring purposes, and collapsing them under one
 * label would put documents that cannot be compared into one group.
 */
export function groupDocumentsByMap(
  documents: ScenarioDocumentSummaryDto[],
  availableMaps: ReadonlyArray<ScenarioMapOption> = [],
): ScenarioMapGroup[] {
  const mapByVersionId = new Map(
    availableMaps.map((entry) => [entry.mapVersionId, entry]),
  );
  const mapBySourceMapId = new Map(
    availableMaps.map((entry) => [entry.sourceMapId, entry]),
  );
  const mapByLabel = new Map<string, ScenarioMapOption>();
  for (const entry of availableMaps) {
    const labelKey = entry.label.trim().toLocaleLowerCase();
    // This fallback is presentation-only for legacy map versions that predate source-map identity.
    // Prefer an entry that actually has a preview when duplicate catalog labels exist.
    if (!mapByLabel.has(labelKey) || entry.thumbnailUrl) mapByLabel.set(labelKey, entry);
  }
  const groups = new Map<string, ScenarioMapGroup>();

  for (const document of documents) {
    const mapVersionId = document.mapVersionId ?? "";
    const editedAtMs = documentEditedAtMs(document);
    const group = groups.get(mapVersionId);
    if (group) {
      group.latestEditedAtMs = Math.max(group.latestEditedAtMs, editedAtMs);
      group.documents.push(document);
      continue;
    }
    const descriptor = mapVersionId
      ? mapByVersionId.get(mapVersionId)
        ?? (document.mapSourceMapId
          ? mapBySourceMapId.get(document.mapSourceMapId)
          : undefined)
        ?? (document.mapLabel
          ? mapByLabel.get(document.mapLabel.trim().toLocaleLowerCase())
          : undefined)
      : undefined;
    groups.set(mapVersionId, {
      mapVersionId,
      groupKey: mapVersionId || "no-map",
      // The descriptor's label wins over the row's joined `mapLabel`: the descriptor is the map
      // catalog's own name for the map, and the row's copy can only ever agree or be staler.
      displayLabel: descriptor?.label?.trim() || documentMapLabel(document),
      latestEditedAtMs: editedAtMs,
      documents: [document],
      // A document may pin an older immutable map version that is no longer offered by the current
      // picker. Its summary carries the exact-version preview so historical scenario groups do not
      // lose their image when the catalog advances.
      // The stable first-party route is also a safe final fallback for cached summary objects from
      // before preview metadata was added. The endpoint owns the existence/auth check and a missing
      // preview simply leaves the card's gradient in place.
      thumbnailUrl: descriptor?.thumbnailUrl
        ?? document.mapThumbnailUrl
        ?? (mapVersionId && document.mapThumbnailUrl === undefined
          ? `/api/uniscenario/maps/${encodeURIComponent(mapVersionId)}/thumbnail`
          : null),
    });
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      documents: [...group.documents].sort(
        (a, b) => documentEditedAtMs(b) - documentEditedAtMs(a),
      ),
    }))
    .sort((a, b) => {
      const editedDelta = b.latestEditedAtMs - a.latestEditedAtMs;
      if (editedDelta !== 0) return editedDelta;
      return a.displayLabel.localeCompare(b.displayLabel);
    });
}

/**
 * Index variation sub-rows by the document they were derived from.
 *
 * Only lineage kinds that produce a genuinely different scenario count — a `copy` is an independent
 * document the user renamed and edited, so nesting it under its source would hide it from the list
 * it actually belongs to (§6.4).
 */
export function groupVariationsBySource(
  documents: ScenarioDocumentSummaryDto[],
) {
  const bySource = new Map<string, ScenarioDocumentSummaryDto[]>();
  for (const document of documents) {
    const sourceId = document.derivedFromDocumentId;
    if (!sourceId || sourceId === document.id) continue;
    if (
      document.derivationKind !== "variation" &&
      document.derivationKind !== "cross_map_variation"
    ) {
      continue;
    }
    const list = bySource.get(sourceId);
    if (list) list.push(document);
    else bySource.set(sourceId, [document]);
  }
  for (const list of bySource.values()) {
    list.sort(
      (a, b) =>
        documentMapLabel(a).localeCompare(documentMapLabel(b)) ||
        (a.createdAt ?? "").localeCompare(b.createdAt ?? "") ||
        a.id.localeCompare(b.id),
    );
  }
  return bySource;
}
