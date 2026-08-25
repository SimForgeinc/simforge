"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CityViewer } from "@simforge/viewer";
import type { ActorRenderer } from "@simforge/viewer";
import {
  DISABLED_SUMO_STATUS,
  type SumoTrafficStatus,
} from "@simforge/playback/traffic";
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CarFront,
  Loader2,
  Map as MapIcon,
  MapPin,
  Plus,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import type { MapAsset } from "@simforge/studio-shared";
import type {
  ScenarioDocumentDto,
  ScenarioMapDescriptorDto,
} from "@/app/lib/scenario/contracts";
import { TopBarActionsPortal } from "@/app/components/TopBarSlot";
import { Button } from "@/app/components/ui/button";
import { EmptyState } from "@/app/components/ui/empty-state";
import { useExperimentalFeaturesEnabled } from "@/app/lib/experimental-features";
import { cn } from "@/app/lib/utils";
import type { ScenarioMapOption } from "@/app/dashboard/scenario/list/document-map-groups";
import { ScenarioMapPickerDialog } from "@/app/dashboard/scenario/list/ScenarioMapPickerDialog";
import {
  ScenarioWorldHost,
  type ScenarioWorldState,
  type ScenarioWorldTarget,
} from "@/app/dashboard/scenario/scene/ScenarioWorldHost";
import { useIdleStreetTour } from "@/app/dashboard/scenario/scene/useIdleStreetTour";
import { localSceneMinutes } from "@/app/dashboard/scenario/editor/scene-time";
import { getCardStats } from "./map-card-data";
import { MapGallerySumoTraffic } from "./MapGallerySumoTraffic";

const Map2DOverlay = dynamic(
  () => import("./Map2DOverlay").then((module) => module.Map2DOverlay),
  {
    ssr: false,
    loading: () => (
      <div className="fixed inset-0 z-40 grid place-items-center bg-black/65 backdrop-blur-sm" role="status">
        <div className="flex items-center gap-2 bg-black/75 px-4 py-3 text-sm text-white">
          <Loader2 className="size-4 animate-spin text-[#E8E044]" />
          Loading 2D map…
        </div>
      </div>
    ),
  },
);

type GalleryEntry = {
  map: ScenarioMapDescriptorDto;
  asset: MapAsset | null;
};

const EMPTY_WORLD_STATE: ScenarioWorldState = {
  target: null,
  loadedMapVersionId: null,
  streaming: false,
  error: null,
};

/** Reuses the persistent Datasets world and its topology-bound street tour. */
function MapGalleryWorldPreview({
  map,
  sumoEnabled,
  onSumoStatusChange,
}: {
  map: ScenarioMapDescriptorDto;
  sumoEnabled: boolean;
  onSumoStatusChange: (status: SumoTrafficStatus) => void;
}) {
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [actorRenderer, setActorRenderer] = useState<ActorRenderer | null>(null);
  const [worldState, setWorldState] = useState<ScenarioWorldState>(EMPTY_WORLD_STATE);
  const target = useMemo<ScenarioWorldTarget>(() => ({
    mapVersionId: map.mapVersionId,
    manifestUrl: map.browserManifestUrl,
    label: map.label,
    locality: map.locality,
  }), [map.browserManifestUrl, map.label, map.locality, map.mapVersionId]);
  const tourMap = useMemo<ScenarioMapOption>(() => ({
    mapVersionId: map.mapVersionId,
    sourceMapId: map.sourceMapId,
    label: map.label,
    locality: map.locality,
    browserManifestUrl: map.browserManifestUrl,
    topologyUrl: map.topologyArtifactUrl,
  }), [map]);

  useIdleStreetTour({
    enabled: true,
    interruptible: false,
    map: tourMap,
    viewer,
    loadedMapVersionId: worldState.loadedMapVersionId,
    cinematic: true,
    speedMultiplier: 1.5,
    allowLookAround: true,
  });

  return (
    <>
      <ScenarioWorldHost
        className="absolute inset-0 isolate"
        interactive
        onActorRendererChange={setActorRenderer}
        onStateChange={setWorldState}
        onViewerChange={setViewer}
        target={target}
      />
      <MapGallerySumoTraffic
        actorRenderer={actorRenderer}
        enabled={sumoEnabled}
        loadedMapVersionId={worldState.loadedMapVersionId}
        map={map}
        onStatusChange={onSumoStatusChange}
        viewer={viewer}
      />
    </>
  );
}

function AddMapTopBarAction() {
  return (
    <TopBarActionsPortal>
      <Button asChild size="sm">
        <Link href="/dashboard/map-assets/new">
          <Plus className="size-4" />
          Add map
        </Link>
      </Button>
    </TopBarActionsPortal>
  );
}

function mapLocation(entry: GalleryEntry) {
  const place = entry.asset?.place_context;
  const detailed = [place?.city, place?.state].filter(Boolean).join(", ");
  return detailed || entry.map.locality || place?.country || "Simulation-ready digital twin";
}

function MapArrow({
  direction,
  targetLabel,
  disabled,
  onClick,
}: {
  direction: "previous" | "next";
  targetLabel: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`${direction === "previous" ? "Previous" : "Next"} map: ${targetLabel}`}
      className="grid size-10 place-items-center border border-white/20 bg-black/25 text-white/85 backdrop-blur-md transition-colors hover:border-white/45 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon className="size-[18px]" />
    </button>
  );
}

export function MapGalleryPageClient({
  assets,
  maps,
}: {
  assets: MapAsset[];
  maps: ScenarioMapDescriptorDto[];
}) {
  const router = useRouter();
  const experimentalEnabled = useExperimentalFeaturesEnabled();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [map2DOpen, setMap2DOpen] = useState(false);
  const [mapPickerOpen, setMapPickerOpen] = useState(false);
  const [sumoEnabled, setSumoEnabled] = useState(false);
  const [sumoStatus, setSumoStatus] = useState<SumoTrafficStatus>(DISABLED_SUMO_STATUS);

  const entries = useMemo<GalleryEntry[]>(() => {
    const assetsById = new Map(assets.map((asset) => [asset.map_asset_id, asset]));
    return [...maps]
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((map) => ({ map, asset: assetsById.get(map.sourceMapId) ?? null }));
  }, [assets, maps]);

  const move = useCallback(
    (offset: number) => {
      if (entries.length < 2) return;
      setSelectedIndex((current) => (current + offset + entries.length) % entries.length);
    },
    [entries.length],
  );

  const switchOverlayMap = useCallback((mapAssetId: string) => {
    const nextIndex = entries.findIndex((candidate) => candidate.asset?.map_asset_id === mapAssetId);
    if (nextIndex >= 0) setSelectedIndex(nextIndex);
  }, [entries]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (map2DOpen || mapPickerOpen) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.matches("input, textarea, select") ||
        target?.isContentEditable
      ) {
        return;
      }
      if (event.key === "ArrowLeft") move(-1);
      if (event.key === "ArrowRight") move(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [map2DOpen, mapPickerOpen, move]);

  useEffect(() => {
    if (entries.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const adjacent = new Set([
        entries[(selectedIndex - 1 + entries.length) % entries.length]?.map.browserManifestUrl,
        entries[(selectedIndex + 1) % entries.length]?.map.browserManifestUrl,
      ]);
      for (const manifestUrl of adjacent) {
        if (!manifestUrl) continue;
        void fetch(manifestUrl, { cache: "force-cache", signal: controller.signal }).catch(() => undefined);
      }
    }, 1_200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [entries, selectedIndex]);

  if (entries.length === 0) {
    return (
      <>
        {experimentalEnabled ? <AddMapTopBarAction /> : null}
        <EmptyState
          icon={<MapPin className="size-7" />}
          title="No maps yet"
          description="Upload your first map to explore it in 3D and create simulation scenarios."
          action={experimentalEnabled ? (
            <Button asChild>
              <Link href="/dashboard/map-assets/new">
                <Plus className="mr-1.5 size-4" />
                Add map
              </Link>
            </Button>
          ) : undefined}
          className="h-full"
        />
      </>
    );
  }

  const entry = entries[Math.min(selectedIndex, entries.length - 1)]!;
  const previous = entries[(selectedIndex - 1 + entries.length) % entries.length]!;
  const next = entries[(selectedIndex + 1) % entries.length]!;
  const stats = entry.asset ? getCardStats(entry.asset).slice(0, 3) : [];
  const sumoAvailable = Boolean(entry.map.sumoNetworkSha256);
  const sumoLoading = sumoEnabled && sumoAvailable && sumoStatus.phase === "loading";
  const sumoFailed = sumoEnabled && sumoStatus.phase === "fallback";

  const createScenario = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const response = await fetch(
        `/api/uniscenario/maps/${encodeURIComponent(entry.map.mapVersionId)}/documents/default`,
        {
          method: "POST",
          headers: {
            "x-simforge-local-minutes": String(localSceneMinutes()),
          },
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { document?: ScenarioDocumentDto; error?: string }
        | null;
      if (!response.ok || !payload?.document) {
        throw new Error(payload?.error || "The scenario could not be created.");
      }
      router.push(
        `/dashboard/scenario?dataset=${encodeURIComponent(payload.document.datasetId)}&document=${encodeURIComponent(payload.document.id)}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The scenario could not be created.");
      setCreating(false);
    }
  };

  return (
    <>
      {experimentalEnabled ? <AddMapTopBarAction /> : null}
      <main className="relative h-full min-h-[32rem] overflow-hidden bg-[#07100d] text-white">
        <div className="absolute inset-0">
          <MapGalleryWorldPreview
            map={entry.map}
            onSumoStatusChange={setSumoStatus}
            sumoEnabled={sumoEnabled}
          />
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-1/2 bg-gradient-to-t from-black/45 via-black/10 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-black/25 to-transparent" />

        <div className="absolute right-5 top-5 z-30 flex items-center gap-2 sm:right-8 sm:top-8">
          <button
            type="button"
            aria-label={sumoAvailable ? `SUMO traffic ${sumoEnabled ? "on" : "off"}` : "SUMO traffic unavailable"}
            aria-pressed={sumoAvailable ? sumoEnabled : undefined}
            className={cn(
              "inline-flex h-10 items-center gap-2 border px-3.5 text-xs font-semibold backdrop-blur-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]",
              sumoEnabled && sumoAvailable
                ? "border-[#E8E044]/65 bg-[#E8E044]/14 text-[#E8E044] hover:bg-[#E8E044]/22"
                : "border-white/20 bg-black/45 text-white/70 hover:border-white/40 hover:text-white",
              !sumoAvailable && "cursor-not-allowed opacity-45",
            )}
            disabled={!sumoAvailable}
            onClick={() => setSumoEnabled((enabled) => !enabled)}
            title={
              !sumoAvailable
                ? "This map does not publish a SUMO traffic network."
                : sumoFailed
                  ? sumoStatus.reason ?? "SUMO traffic could not start."
                  : "Show continuously running browser SUMO traffic"
            }
          >
            {sumoLoading ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : sumoFailed ? (
              <AlertTriangle aria-hidden="true" className="size-4" />
            ) : (
              <CarFront aria-hidden="true" className="size-4" />
            )}
            <span>
              {!sumoAvailable
                ? "SUMO unavailable"
                : sumoFailed
                  ? "SUMO error"
                  : `SUMO ${sumoEnabled ? "on" : "off"}`}
            </span>
            {sumoEnabled && sumoStatus.actorCount > 0 ? (
              <span className="font-mono text-[9px] text-current/65">{sumoStatus.actorCount}</span>
            ) : null}
          </button>
          <button
            type="button"
            onClick={() => setMap2DOpen(true)}
            disabled={!entry.asset}
            className="inline-flex h-10 items-center gap-2 border border-white/20 bg-black/45 px-3.5 text-xs font-semibold text-white backdrop-blur-md transition-colors hover:border-[#E8E044]/70 hover:bg-black/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044] disabled:cursor-not-allowed disabled:opacity-40"
            title={entry.asset ? "Open the 2D map workspace" : "No 2D map is available for this digital twin"}
          >
            <MapIcon aria-hidden="true" className="size-4 text-[#E8E044]" />
            View 2D map
          </button>
        </div>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 z-10 h-[88%] w-[92%] bg-[radial-gradient(ellipse_at_bottom_left,rgba(2,8,6,0.76)_0%,rgba(2,8,6,0.58)_30%,rgba(2,8,6,0.2)_55%,transparent_76%)] backdrop-blur-[14px] sm:w-[78%] lg:w-[68%]"
          data-testid="map-gallery-diagonal-veil"
          style={{
            maskImage: "radial-gradient(ellipse 92% 105% at 0% 100%, black 0%, black 38%, rgba(0,0,0,0.76) 52%, transparent 78%)",
            WebkitMaskImage: "radial-gradient(ellipse 92% 105% at 0% 100%, black 0%, black 38%, rgba(0,0,0,0.76) 52%, transparent 78%)",
          }}
        />

        <section
          className="absolute inset-x-0 bottom-0 z-20"
          data-testid="map-gallery-editorial-overlay"
        >
          <div className="mx-auto w-full max-w-[1440px] px-5 pb-5 sm:px-8 sm:pb-8 lg:px-14 lg:pb-10">
            <div className="max-w-2xl">
              <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#E8E044] sm:text-[11px]">
                <Sparkles aria-hidden="true" className="size-3.5" />
                Simulation-ready digital twin
              </p>
              <h1
                className="mt-3 max-w-3xl text-balance text-[clamp(2.25rem,4.2vw,4.5rem)] font-semibold leading-[0.96] tracking-[-0.045em] text-white"
                style={{ textShadow: "0 4px 28px rgba(0,0,0,0.5)" }}
              >
                {entry.map.label}
              </h1>
              <p className="mt-3 flex items-center gap-1.5 text-sm text-white/[0.72] sm:text-base">
                <MapPin aria-hidden="true" className="size-3.5 text-[#E8E044]" />
                {mapLocation(entry)}
              </p>
              {entry.asset?.description ? (
                <p className="mt-2 line-clamp-2 max-w-xl text-sm leading-6 text-white/[0.62]">
                  {entry.asset.description}
                </p>
              ) : null}
              <div className="mt-3 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-white/50 sm:text-xs">
                {stats.map((stat) => (
                  <span className="font-mono" key={stat.key} title={stat.tooltip}>{stat.value}</span>
                ))}
                {entry.asset ? (
                  <Link
                    href={`/dashboard/map-assets/${encodeURIComponent(entry.asset.map_asset_id)}`}
                    className="pointer-events-auto inline-flex items-center gap-1 text-white/[0.58] transition-colors hover:text-white"
                  >
                    View map details
                    <ArrowUpRight aria-hidden="true" className="size-3.5" />
                  </Link>
                ) : null}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-between gap-4 border-t border-white/20 pt-4 sm:mt-7 sm:pt-5">
              <div className="flex items-center gap-2">
                <MapArrow
                  direction="previous"
                  targetLabel={previous.map.label}
                  disabled={entries.length < 2}
                  onClick={() => move(-1)}
                />
                <button
                  aria-label="Choose a map"
                  className="grid size-10 place-items-center border border-white/20 bg-black/25 text-white/85 backdrop-blur-md transition-colors hover:border-[#E8E044]/70 hover:bg-[#E8E044]/10 hover:text-[#E8E044] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
                  onClick={() => setMapPickerOpen(true)}
                  title="Open map gallery"
                  type="button"
                >
                  <MapIcon aria-hidden="true" className="size-[18px]" />
                </button>
                <MapArrow
                  direction="next"
                  targetLabel={next.map.label}
                  disabled={entries.length < 2}
                  onClick={() => move(1)}
                />
                <span className="ml-2 font-mono text-[11px] tracking-[0.16em] text-white/50">
                  {String(selectedIndex + 1).padStart(2, "0")} / {String(entries.length).padStart(2, "0")}
                </span>
              </div>

              <Button
                type="button"
                size="lg"
                onClick={createScenario}
                disabled={creating}
                className="h-11 rounded-none bg-[#E8E044] px-4 text-sm font-semibold text-black shadow-xl hover:bg-[#f0e84e] sm:px-5"
              >
                {creating ? <Loader2 className="size-4 animate-spin" /> : null}
                <span>{creating ? "Creating scenario…" : "Create scenario"}</span>
                {!creating ? <ArrowRight aria-hidden="true" className="size-4" /> : null}
              </Button>
            </div>
          </div>
        </section>
      </main>
      {map2DOpen && entry.asset ? (
        <Map2DOverlay
          asset={entry.asset}
          allAssets={entries.flatMap((candidate) => candidate.asset ? [candidate.asset] : [])}
          onClose={() => setMap2DOpen(false)}
          onSwitchMap={switchOverlayMap}
        />
      ) : null}
      <ScenarioMapPickerDialog
        currentMapVersionId={entry.map.mapVersionId}
        maps={entries.map((candidate) => candidate.map)}
        onOpenChange={setMapPickerOpen}
        onSelectMap={(selectedMap) => {
          const nextIndex = entries.findIndex(
            (candidate) => candidate.map.mapVersionId === selectedMap.mapVersionId,
          );
          if (nextIndex >= 0) setSelectedIndex(nextIndex);
        }}
        open={mapPickerOpen}
      />
    </>
  );
}
