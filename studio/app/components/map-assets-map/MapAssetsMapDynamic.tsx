"use client";

import dynamic from "next/dynamic";
import type { MapAssetsMapProps } from "@/app/components/map-assets-map/MapAssetsMap";

const MAP_IMPORT_RETRIES = 3;
const MAP_IMPORT_RETRY_DELAY_MS = 750;

function wait(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function importMapAssetsMap() {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAP_IMPORT_RETRIES; attempt += 1) {
    try {
      return await import("@/app/components/map-assets-map/MapAssetsMap");
    } catch (error) {
      lastError = error;
      if (attempt === MAP_IMPORT_RETRIES) break;
      await wait(MAP_IMPORT_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
}

const MapAssetsMap = dynamic(importMapAssetsMap, {
  ssr: false,
  loading: () => (
    <div className="flex h-full min-h-[400px] items-center justify-center bg-background/50 text-sm text-muted-foreground">
      Loading map…
    </div>
  ),
});

const SilentMapAssetsMap = dynamic(importMapAssetsMap, {
  ssr: false,
  loading: () => (
    <div
      className="h-full min-h-[400px] bg-background/50"
      aria-hidden="true"
    />
  ),
});

type MapAssetsMapDynamicProps = MapAssetsMapProps;

/** Dynamically import and render the MapAssetsMap component without SSR. */
export default function MapAssetsMapDynamic(props: MapAssetsMapDynamicProps) {
  return <MapAssetsMap {...props} />;
}

/** Editor-only map loader; the shared editor status rail owns loading copy. */
export function MapAssetsMapDynamicSilent(props: MapAssetsMapDynamicProps) {
  return <SilentMapAssetsMap {...props} />;
}
