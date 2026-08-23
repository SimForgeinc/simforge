"use client";

import { useState } from "react";
import { toast } from "sonner";
import type { MapAsset } from "@simcloud/shared";

interface UseMapAssetOperationsInput {
  currentAsset: MapAsset;
  onEnrichmentSucceeded: () => void;
  onRefreshMapAssets: () => void;
}

export function useMapAssetOperations({
  currentAsset,
  onEnrichmentSucceeded,
  onRefreshMapAssets,
}: UseMapAssetOperationsInput) {
  const [populatingMapId, setPopulatingMapId] = useState<string | null>(null);
  const [refreshingSearchIndexMapId, setRefreshingSearchIndexMapId] = useState<string | null>(null);
  const [populateErr, setPopulateErr] = useState<string | null>(null);
  const [enrichErr, setEnrichErr] = useState<string | null>(null);

  const populateBusy = populatingMapId === currentAsset.map_asset_id;
  const refreshSearchIndexBusy =
    refreshingSearchIndexMapId === currentAsset.map_asset_id;

  async function handlePopulateMetadata() {
    const targetId = currentAsset.map_asset_id;
    setPopulateErr(null);
    setPopulatingMapId(targetId);
    try {
      const res = await fetch(`/api/map-assets/${targetId}/populate-metadata`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        missing?: string[];
      };
      if (!res.ok) {
        const msg =
          body.detail ??
          body.error ??
          (body.missing?.length
            ? `Missing artifacts: ${body.missing.join(", ")}`
            : `Request failed (${res.status})`);
        setPopulateErr(msg);
        toast.error(msg);
        return;
      }

      toast.success(`Metadata populated for ${targetId}`);
      onEnrichmentSucceeded();
      onRefreshMapAssets();
    } catch {
      const msg = "Network error while populating metadata.";
      setPopulateErr(msg);
      toast.error(msg);
    } finally {
      setPopulatingMapId((prev) => (prev === targetId ? null : prev));
    }
  }

  function handleEnrich() {
    const msg = "Third-party map enrichment is unavailable in local mode.";
    setEnrichErr(msg);
    toast.info(msg);
  }

  async function handleRefreshSearchIndex() {
    const targetId = currentAsset.map_asset_id;
    setRefreshingSearchIndexMapId(targetId);
    try {
      const res = await fetch(
        `/api/map-assets/${targetId}/refresh-search-index`,
        { method: "POST" },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        object_count?: number;
        edge_count?: number;
      };
      if (!res.ok) {
        const msg =
          body.detail ?? body.error ?? `Refresh failed (${res.status})`;
        toast.error(msg);
        return;
      }
      const objectCount = body.object_count ?? 0;
      const edgeCount = body.edge_count ?? 0;
      toast.success(
        `Search index refreshed — ${objectCount} objects, ${edgeCount} edges.`,
      );
      onRefreshMapAssets();
    } catch {
      toast.error("Network error while refreshing the search index.");
    } finally {
      setRefreshingSearchIndexMapId((prev) =>
        prev === targetId ? null : prev,
      );
    }
  }

  return {
    populateBusy,
    enrichBusy: false,
    refreshSearchIndexBusy,
    populateErr,
    enrichErr,
    handlePopulateMetadata,
    handleEnrich,
    handleRefreshSearchIndex,
  };
}
