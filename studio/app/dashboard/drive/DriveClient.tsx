"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Camera,
  CarFront,
  Gauge,
  LayoutGrid,
  LogIn,
  LogOut,
  PersonStanding,
  Video,
} from "lucide-react";
import { AUTHORING_CATALOG, type CatalogActorClass } from "@simforge/asset-catalog";
import type { SignalFeature } from "@simforge/maps";
import type { PoleCameraRig } from "@simforge/maps/camera-rig";
import { CityViewer, type CityViewerOptions } from "@simforge/viewer";
import { CityView } from "@simforge/viewer/react";
import { Raycaster, Vector2 } from "three";
import { toast } from "sonner";

import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import type { ScenarioAuthoringQuality, ScenarioMapDescriptorDto } from "@/app/lib/scenario/contracts";
import { AUTHORING_QUALITY, defaultAuthoringQuality } from "@/app/dashboard/scenario/editor/authoring-quality";
import { ScenarioEditorShell } from "@/app/dashboard/scenario/editor/shell";
import { createLocalWorldSource } from "@/app/lib/live-world/local-world-source";
import { createTruthViewerBridge, type TruthViewerBridge } from "@/app/lib/live-world/truth-viewer-bridge";
import type { WorldSource, WorldSourceStatus } from "@/app/lib/live-world/types";
import { useWorldSource } from "@/app/lib/live-world/use-world-source";
import { PoleCameraGrid } from "./cameras/PoleCameraGrid";

type DriveView = "world" | "cameras";
type FollowMode = "chase" | "dash";

type PlaceableActorKind = {
  actorClass: CatalogActorClass;
  blueprint: string;
  label: string;
  assetCount: number;
};

const EMPTY_RIGS: readonly PoleCameraRig[] = [];
const EMPTY_SIGNAL_FEATURES: readonly SignalFeature[] = [];
const CONTROLLED_KEY_CODES: Record<string, true> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  KeyW: true,
  KeyA: true,
  KeyS: true,
  KeyD: true,
  KeyR: true,
  Space: true,
};


export function DriveClient() {
  const [map, setMap] = useState<ScenarioMapDescriptorDto | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [source, setSource] = useState<WorldSource | null>(null);
  const [sourceCreationError, setSourceCreationError] = useState<string | null>(null);
  const [viewer, setViewer] = useState<CityViewer | null>(null);
  const [bridge, setBridge] = useState<TruthViewerBridge | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [quality, setQuality] = useState<ScenarioAuthoringQuality>("high");
  const [view, setView] = useState<DriveView>("world");
  const [followMode, setFollowMode] = useState<FollowMode>("chase");
  const [egoActorId, setEgoActorId] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const [enteringDrive, setEnteringDrive] = useState(false);
  const [selectedBlueprint, setSelectedBlueprint] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [spawning, setSpawning] = useState(false);
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  const world = useWorldSource(source);
  const placeableKinds = useMemo(() => buildPlaceableKinds(catalogQuery), [catalogQuery]);

  useEffect(() => {
    setQuality(defaultAuthoringQuality());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/simforge/maps", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Map catalog request failed (${response.status})`);
        const payload = await response.json() as { maps?: ScenarioMapDescriptorDto[] } | ScenarioMapDescriptorDto[];
        const maps = Array.isArray(payload) ? payload : payload.maps ?? [];
        if (maps.length === 0) throw new Error("No published maps are available for Drive");
        const preferred = maps.find((candidate) => /richmond/i.test(candidate.label)) ?? maps[0]!;
        setMap(preferred);
        setMapError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message = errorMessage(error);
        setMapError(message);
        toast.error("Drive could not load the map catalog", { description: message });
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!map) return;
    let nextSource: WorldSource;
    try {
      nextSource = createLocalWorldSource({
        mapManifestUrl: map.browserManifestUrl,
        laneGraphUrl: map.topologyArtifactUrl,
        tickHz: 20,
      });
      setSource(nextSource);
      setSourceCreationError(null);
    } catch (error) {
      const message = errorMessage(error);
      setSourceCreationError(message);
      toast.error("Drive world could not start", { description: message });
      return;
    }
    return () => nextSource.close();
  }, [map]);

  useEffect(() => {
    if (!bridge || !source) return;
    return source.subscribeFrames((frame) => bridge.apply(frame));
  }, [bridge, source]);

  useEffect(() => {
    if (!bridge) return;
    bridge.setFollow(driving ? egoActorId : null, followMode);
  }, [bridge, driving, egoActorId, followMode]);

  useEffect(() => () => bridge?.dispose(), [bridge]);

  useDriveControls(source, driving ? egoActorId : null);

  const onViewerReady = useCallback((readyViewer: CityViewer) => {
    setViewer(readyViewer);
    setBridge(createTruthViewerBridge(readyViewer, { layer: "drive-live", groundLift: true }));
    setViewerError(null);
  }, []);

  const spawnAtPoint = useCallback(async (
    blueprint: string,
    point: { x: number; y: number; z: number },
    controlled = false,
  ) => {
    if (!source) throw new Error("The world is not ready to accept actors");
    return source.spawn({
      blueprint,
      position: { x: point.x, y: point.z, z: point.y },
      controlled,
    });
  }, [source]);

  const onCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 0) pointerDownRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  const onCanvasPointerUp = useCallback(async (event: ReactPointerEvent<HTMLDivElement>) => {
    const down = pointerDownRef.current;
    pointerDownRef.current = null;
    if (!down || event.button !== 0 || !selectedBlueprint || !viewer || spawning) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
    const point = groundPointFromPointer(viewer, event.clientX, event.clientY);
    if (!point) {
      toast.error("Choose a visible ground point", {
        description: "The selected screen point does not intersect the loaded world.",
      });
      return;
    }
    setSpawning(true);
    try {
      await spawnAtPoint(selectedBlueprint, point);
    } catch (error) {
      toast.error("Actor could not be added", { description: errorMessage(error) });
    } finally {
      setSpawning(false);
    }
  }, [selectedBlueprint, spawnAtPoint, spawning, viewer]);

  const enterDrive = useCallback(async () => {
    if (!source || !viewer || enteringDrive) return;
    setEnteringDrive(true);
    try {
      let actorId = egoActorId;
      if (!actorId) {
        const target = viewer.captureView().target;
        const groundY = viewer.sampleGroundHeight(target[0], target[2]) ?? target[1];
        const spawned = await spawnAtPoint(
          "vehicle.car",
          { x: target[0], y: groundY, z: target[2] },
          true,
        );
        actorId = spawned.actorId;
        setEgoActorId(actorId);
      }
      bridge?.setFollow(actorId, followMode);
      setDriving(true);
    } catch (error) {
      toast.error("Drive mode could not start", { description: errorMessage(error) });
    } finally {
      setEnteringDrive(false);
    }
  }, [bridge, egoActorId, enteringDrive, followMode, source, spawnAtPoint, viewer]);

  const exitDrive = useCallback(() => {
    bridge?.setFollow(null);
    setDriving(false);
  }, [bridge]);

  const switchView = useCallback((next: DriveView) => {
    if (next === "cameras" && driving) exitDrive();
    setView(next);
  }, [driving, exitDrive]);

  const createCameraViewer = useCallback(async (canvas: HTMLCanvasElement) => {
    if (!map) throw new Error("No map is selected for the pole camera viewer");
    const cameraViewer = new CityViewer(canvas, viewerOptions(quality));
    try {
      await cameraViewer.loadMap(map.browserManifestUrl);
      return cameraViewer;
    } catch (error) {
      cameraViewer.dispose();
      throw error;
    }
  }, [map, quality]);

  const activeEgo = world.latestFrame?.scene.actors.find(
    (actor) => actor.id === egoActorId && actor.kind !== "despawn",
  );
  const speedKmh = activeEgo
    ? Math.hypot(...activeEgo.velocity) * 3.6
    : 0;
  const effectiveStatus: WorldSourceStatus = sourceCreationError || mapError
    ? "error"
    : world.status;
  const effectiveError = sourceCreationError ?? mapError ?? world.error;

  return (
    <ScenarioEditorShell
      className="h-full min-h-0 bg-background text-foreground"
      data-testid="drive-surface"
      canvasMode="interactive"
      header={(slotProps) => (
        <div
          {...slotProps}
          className={cn(
            slotProps.className,
            "flex items-center gap-3 border-b border-border bg-card/95 px-3 shadow-sm backdrop-blur",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <CarFront className="size-4 text-primary" aria-hidden="true" />
            <span className="truncate text-sm font-semibold">Continuous world</span>
            {map ? <span className="hidden truncate text-xs text-muted-foreground md:inline">{map.label}</span> : null}
          </div>
          <div className="ml-auto flex items-center gap-1 rounded-md border border-border bg-muted/40 p-1" aria-label="Drive view">
            <Button
              type="button"
              size="sm"
              variant={view === "world" ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              onClick={() => switchView("world")}
              aria-pressed={view === "world"}
            >
              <LayoutGrid /> World
            </Button>
            <Button
              type="button"
              size="sm"
              variant={view === "cameras" ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              onClick={() => switchView("cameras")}
              aria-pressed={view === "cameras"}
            >
              <Video /> Cameras
            </Button>
          </div>
          {view === "world" ? (
            <div className="flex items-center gap-1">
              {driving ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 px-2 text-xs"
                    onClick={() => setFollowMode((mode) => mode === "chase" ? "dash" : "chase")}
                  >
                    <Camera /> {followMode === "chase" ? "Chase" : "Dash"}
                  </Button>
                  <Button type="button" size="sm" variant="secondary" className="h-8 text-xs" onClick={exitDrive}>
                    <LogOut /> Exit drive
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={!source || !viewer || world.status !== "running" || enteringDrive}
                  onClick={() => void enterDrive()}
                >
                  <LogIn /> {enteringDrive ? "Entering…" : egoActorId ? "Resume drive" : "Enter drive"}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      )}
      leftSidebar={view === "world" ? (slotProps) => (
        <aside
          {...slotProps}
          className={cn(
            slotProps.className,
            "m-3 flex h-[calc(100%-1.5rem)] w-64 flex-col overflow-hidden rounded-lg border border-border bg-card/95 shadow-xl backdrop-blur",
          )}
          aria-label="Actor palette"
        >
          <div className="border-b border-border p-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CarFront className="size-4 text-primary" aria-hidden="true" />
              Add actors
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Choose a simulation kind, then click the ground. Placement stays available while driving.
            </p>
            <Input
              className="mt-3 h-8 text-xs"
              value={catalogQuery}
              onChange={(event) => setCatalogQuery(event.target.value)}
              placeholder="Search the asset catalog"
              aria-label="Search actor catalog"
            />
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {placeableKinds.map((kind) => {
              const selected = selectedBlueprint === kind.blueprint;
              const Icon = kind.actorClass === "pedestrian" ? PersonStanding : CarFront;
              return (
                <Button
                  key={kind.blueprint}
                  type="button"
                  variant={selected ? "secondary" : "ghost"}
                  className="h-auto w-full justify-start px-2 py-2 text-left"
                  onClick={() => setSelectedBlueprint(selected ? null : kind.blueprint)}
                  aria-pressed={selected}
                >
                  <Icon className="size-4" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{kind.label}</span>
                    <span className="block truncate text-[10px] font-normal text-muted-foreground">
                      {kind.assetCount} catalog {kind.assetCount === 1 ? "asset" : "assets"}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
          <div className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground" style={{ fontFamily: "var(--font-meta)" }}>
            {selectedBlueprint ? (spawning ? "ADDING ACTOR…" : "CLICK GROUND TO PLACE") : "SELECT AN ACTOR KIND"}
          </div>
        </aside>
      ) : null}
      canvas={(slotProps) => (
        <div {...slotProps} className={cn(slotProps.className, "relative bg-background")}>
          <div
            className={cn("absolute inset-0", view === "world" ? "visible" : "invisible pointer-events-none")}
            onPointerDown={onCanvasPointerDown}
            onPointerUp={(event) => void onCanvasPointerUp(event)}
          >
            {map ? (
              <CityView
                key={quality}
                manifestUrl={map.browserManifestUrl}
                options={viewerOptions(quality)}
                onReady={onViewerReady}
                onMapLoaded={() => {
                  setMapLoaded(true);
                  setViewerError(null);
                }}
                onError={(reason) => {
                  const message = errorMessage(reason);
                  setMapLoaded(false);
                  setViewerError(message);
                  toast.error("Drive map could not load", { description: message });
                }}
                className="h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                ariaLabel={`${map.label} continuous simulation. Choose an actor and click the ground to place it.`}
                role="application"
                tabIndex={0}
              />
            ) : null}
          </div>
          {view === "cameras" ? (
            <div className="absolute inset-0 overflow-auto bg-background p-4">
              <PoleCameraGrid
                rigs={EMPTY_RIGS}
                features={EMPTY_SIGNAL_FEATURES}
                viewerFactory={createCameraViewer}
              />
            </div>
          ) : null}
        </div>
      )}
      statusOverlay={(
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2" role={effectiveStatus === "error" || viewerError ? "alert" : "status"}>
          <div className={cn(
            "rounded-md border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur",
            effectiveStatus === "error" || viewerError ? "border-destructive/50 text-destructive" : "border-border text-muted-foreground",
          )}>
            <WorldStatus status={effectiveStatus} error={effectiveError ?? viewerError} mapLoaded={mapLoaded} />
          </div>
        </div>
      )}
      floatingOverlay={view === "world" ? (
        <div className="absolute right-4 top-4">
          <div className="min-w-44 rounded-lg border border-border bg-card/90 p-3 shadow-lg backdrop-blur" style={{ fontFamily: "var(--font-meta)" }}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground">
                <Gauge className="size-3.5" /> TELEMETRY
              </span>
              {driving ? <Badge variant="secondary" className="text-[9px]">DRIVING</Badge> : null}
            </div>
            <dl className="grid grid-cols-2 gap-x-5 gap-y-1 text-xs">
              <dt className="text-muted-foreground">Speed</dt>
              <dd className="text-right font-semibold tabular-nums">{speedKmh.toFixed(1)} km/h</dd>
              <dt className="text-muted-foreground">Actors</dt>
              <dd className="text-right tabular-nums">{world.latestFrame?.actors.length ?? 0}</dd>
              <dt className="text-muted-foreground">Tick</dt>
              <dd className="text-right tabular-nums">{world.latestFrame?.tick ?? 0}</dd>
              <dt className="text-muted-foreground">Clock</dt>
              <dd className="text-right tabular-nums">{(world.latestFrame?.timeSec ?? 0).toFixed(1)} s</dd>
            </dl>
          </div>
        </div>
      ) : null}
    />
  );
}

function WorldStatus({
  status,
  error,
  mapLoaded,
}: {
  status: WorldSourceStatus;
  error: string | null;
  mapLoaded: boolean;
}) {
  if (error) return <>{error}</>;
  if (status === "running") return <>{mapLoaded ? "World running" : "World running · loading map"}</>;
  if (status === "connecting") return <>Connecting continuous world…</>;
  if (status === "closed") return <>World closed</>;
  return <>Preparing continuous world…</>;
}

function buildPlaceableKinds(query: string): PlaceableActorKind[] {
  const byBlueprint = new Map<string, PlaceableActorKind>();
  for (const entry of AUTHORING_CATALOG) {
    if (!entry.actorClass) continue;
    const blueprint = localBlueprintFor(entry.actorClass);
    if (!blueprint) continue;
    const existing = byBlueprint.get(blueprint);
    if (existing) {
      existing.assetCount += 1;
      continue;
    }
    byBlueprint.set(blueprint, {
      actorClass: entry.actorClass,
      blueprint,
      label: actorClassLabel(entry.actorClass),
      assetCount: 1,
    });
  }
  const needle = query.trim().toLowerCase();
  return [...byBlueprint.values()]
    .filter((kind) => !needle || `${kind.label} ${kind.actorClass}`.toLowerCase().includes(needle))
    .sort((left, right) => left.label.localeCompare(right.label));
}

function localBlueprintFor(actorClass: CatalogActorClass): string | null {
  if (actorClass === "pedestrian") return "walker.pedestrian";
  if (
    actorClass === "car"
    || actorClass === "truck"
    || actorClass === "bus"
    || actorClass === "van"
    || actorClass === "motorcycle"
    || actorClass === "bicycle"
  ) {
    return `vehicle.${actorClass}`;
  }
  return null;
}

function actorClassLabel(actorClass: CatalogActorClass): string {
  return actorClass
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function viewerOptions(quality: ScenarioAuthoringQuality): CityViewerOptions {
  const preset = AUTHORING_QUALITY[quality];
  return {
    maxPixelRatio: preset.maxPixelRatio,
    antialias: preset.antialias,
    cinematicLighting: preset.cinematicLighting,
  };
}

function groundPointFromPointer(
  viewer: CityViewer,
  clientX: number,
  clientY: number,
): { x: number; y: number; z: number } | null {
  const canvas = viewer.renderer.domElement;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  const ndc = new Vector2(
    ((clientX - bounds.left) / bounds.width) * 2 - 1,
    -(((clientY - bounds.top) / bounds.height) * 2 - 1),
  );
  const ray = new Raycaster();
  ray.setFromCamera(ndc, viewer.camera);
  if (Math.abs(ray.ray.direction.y) < 1e-6) return null;

  const target = viewer.captureView().target;
  let groundY = viewer.sampleGroundHeight(target[0], target[2]) ?? target[1];
  let x = target[0];
  let z = target[2];
  for (let index = 0; index < 3; index += 1) {
    const distance = (groundY - ray.ray.origin.y) / ray.ray.direction.y;
    if (!Number.isFinite(distance) || distance <= 0) return null;
    x = ray.ray.origin.x + ray.ray.direction.x * distance;
    z = ray.ray.origin.z + ray.ray.direction.z * distance;
    groundY = viewer.sampleGroundHeight(x, z) ?? groundY;
  }
  return { x, y: groundY, z };
}

function useDriveControls(source: WorldSource | null, actorId: string | null) {
  useEffect(() => {
    if (!source || !actorId) return;
    const pressed = new Set<string>();
    const controlledCodes = CONTROLLED_KEY_CODES;
    const editableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return element?.isContentEditable || element?.tagName === "INPUT" || element?.tagName === "TEXTAREA";
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!controlledCodes[event.code] || editableTarget(event.target)) return;
      event.preventDefault();
      pressed.add(event.code);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (!controlledCodes[event.code]) return;
      event.preventDefault();
      pressed.delete(event.code);
    };
    const transmit = () => {
      const throttle = pressed.has("KeyW") || pressed.has("ArrowUp") ? 1 : 0;
      const brake = pressed.has("Space") || pressed.has("KeyS") || pressed.has("ArrowDown") ? 1 : 0;
      const steerLeft = pressed.has("KeyA") || pressed.has("ArrowLeft");
      const steerRight = pressed.has("KeyD") || pressed.has("ArrowRight");
      source.control({
        actorId,
        throttle,
        brake,
        steer: steerLeft === steerRight ? 0 : steerLeft ? -1 : 1,
        reverse: pressed.has("KeyR"),
      });
    };

    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    const interval = window.setInterval(transmit, 50);
    transmit();
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.clearInterval(interval);
      source.control({ actorId, steer: 0, throttle: 0, brake: 0 });
    };
  }, [actorId, source]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
