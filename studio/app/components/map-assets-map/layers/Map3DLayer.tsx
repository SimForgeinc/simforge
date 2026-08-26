"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Layer, Marker, Source, useMap } from "react-map-gl/maplibre";
import type { MapLayerMouseEvent } from "react-map-gl/maplibre";
import { MercatorCoordinate } from "maplibre-gl";
import type { MapAsset } from "@simforge-oss/studio-shared";
import {
  useActorsStore,
  useMapViewModeStore,
  useSelectionStore,
} from "@/app/lib/scenario-editor/stores";
import {
  lngLatToRuntimePoint,
  runtimePointToLngLat,
} from "@/app/lib/editor-map/coordinates";
import {
  markerRotationToRuntimeYawDegrees,
  mercatorToScenePosition,
  metersPerPixel,
  runtimeYawToSceneRotationY,
  type SceneAnchor,
} from "@/app/lib/scenario-editor/map-3d/coordinates";
import {
  actorFootprintRadiusMeters,
  buildMap3DActorModel,
  type Map3DActorModel,
} from "@/app/lib/scenario-editor/map-3d/car-model";
import { buildMap3DCameraModel } from "@/app/lib/scenario-editor/map-3d/camera-model";
import { locatorDiscRadiusMeters, locatorIsStandingIn } from "@/app/lib/scenario-editor/map-3d/locator-scale";
import {
  buildMap3DSignalHeads,
  MAP_3D_MAX_SIGNAL_HEADS,
  type Map3DSignalHead,
} from "@/app/lib/scenario-editor/map-3d/signal-head-model";
import {
  setSignalHeadPicker,
  setSignalHeadProjector,
} from "@/app/lib/scenario-editor/map-3d/signal-picking";
import {
  buildSignalHitFeatures,
  signalHitRadiusExpression,
  SIGNAL_HIT_LAYER_ID,
  SIGNAL_HIT_SOURCE_ID,
} from "@/app/lib/scenario-editor/map-3d/signal-hit-features";
import { buildCandidateGhostHeads } from "@/app/lib/scenario-editor/signals/intersection-candidate-ghosts";
import { useIntersectionCandidates } from "@/app/lib/scenario-editor/signals/use-intersection-candidates";
import { useSignalJunctionStore } from "@/app/lib/scenario-editor/signals/signal-junction-store";
import {
  actorHitRadiusExpression,
  buildActorHitFeatures,
  RUNTIME_ACTOR_HIT_LAYER_ID,
  RUNTIME_ACTOR_HIT_SOURCE_ID,
} from "@/app/lib/scenario-editor/map-3d/hit-features";
import type {
  Map3DActorInstance,
  Map3DLayerHandle,
  Map3DSignalHeadInstance,
} from "./map-3d-scene";
import {
  HoldProgressRing,
  HoverInfoCard,
  type RuntimeActorMarker,
} from "./RuntimeActorLayers";
import { actorTagText } from "./actor-tag-text";

/**
 * 3D mode's host: reads the same data the 2D renderer reads, converts it into
 * scene instances, and pushes them at the custom layer imperatively.
 *
 * Two deliberate choices worth their sentences:
 *
 * **Actors arrive as `RuntimeActorMarker[]` — the exact array the SVG markers
 * consume.** That is what makes the two renderers agree about where a car is by
 * construction rather than by inspection: both go through the same proj4-backed
 * `runtimePointToLngLat`, so a model cannot end up in a different lane from the
 * glyph it replaced. It also means playback, scrubbing, placement previews and
 * path-edit dimming all behave identically in both modes with no second code
 * path.
 *
 * **Signal heads and plans are read from the stores, not threaded as props**
 * — the `JunctionSignalGlyphLayer` idiom. Their data is editor state; the map
 * component is shared with the catalog and detail pages, where the stores are
 * empty and this renders nothing.
 *
 * three.js arrives through a DYNAMIC import on first entry into 3D mode. With
 * the default mode being 2D, a user who never presses the toggle never
 * downloads the renderer at all, and the editor route's first-load JS is
 * unchanged.
 */

const MAP_3D_LAYER_ID = "map-3d-actors";
/** Heads are drawn within this radius of the actors, plus slack for panning. */
const SIGNAL_RADIUS_M = 400;
const SIGNAL_FALLBACK_RADIUS_M = 900;
/** Chrome sizing matches the 2D vehicle marker so the card sits where it does there. */
const CHROME_SIZE_PX = 56;
/** Follow-camera recentre interval — see the note at its effect. */
const FOLLOW_THROTTLE_MS = 250;

export type Map3DLoadState = "idle" | "loading" | "ready" | "error";

/**
 * What the 3D layer needs from a world sensor: where it sits in RUNTIME metres
 * (`pose.x/y`, the frame the actors' projection already speaks), how high it is
 * mounted, and which way it looks.
 */
export type Map3DWorldSensor = {
  id: string;
  label?: string;
  pose: { x: number; y: number; z: number; yaw: number };
};

type Map3DLayerProps = {
  /** The same markers `RuntimeActorLayers` draws in 2D. */
  actors: readonly RuntimeActorMarker[];
  /**
   * World-placed sensors, drawn as camera models. They ride the actor path —
   * a parts-based model is a parts-based model — so the renderer needs no
   * sensor concept. Typed rather than the 2D layer's GeoJSON because the model
   * needs the mount height and yaw the feature properties flatten away.
   */
  worldSensors?: readonly Map3DWorldSensor[];
  /** Currently selected world sensor, highlighted the way a selected actor is. */
  selectedWorldSensorId?: string | null;
  /** The asset whose projection turns runtime metres into lng/lat. */
  asset: MapAsset | null;
  /** Current map zoom, for the ground-disc pixel floor. */
  mapZoom: number | null;
  onLoadStateChange?: (state: Map3DLoadState) => void;
};

interface PreparedActor {
  key: string;
  id: string;
  /** The floating tag's text, or null when this actor draws none. */
  tagText: string | null;
  longitude: number;
  latitude: number;
  yawDegrees: number;
  model: Map3DActorModel;
  colorHex: number;
  selected: boolean;
  dimmed: boolean;
  interactive: boolean;
  footprintRadiusM: number;
}

/** Drafts carry CARLA's `"r,g,b"`; the 2D card fakes colour with a CSS filter. */
function parseActorColor(color: string | null | undefined): number | null {
  if (!color) return null;
  const trimmed = color.trim();
  if (trimmed.startsWith("#")) {
    const parsed = Number.parseInt(trimmed.slice(1), 16);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parts = trimmed.split(",");
  if (parts.length !== 3) return null;
  const channels = parts.map((part) => Number(part.trim()));
  if (channels.some((value) => !Number.isFinite(value) || value < 0 || value > 255)) {
    return null;
  }
  const [r, g, b] = channels as [number, number, number];
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** Camera housings read as equipment: neutral, never an actor's palette. */
const CAMERA_COLOR = 0x9aa4b2;

const ROLE_COLORS: Record<string, number> = {
  subject: 0xf2c94c,
  traffic: 0xb9c0cc,
  pedestrian: 0x4ec9d4,
  prop: 0x8b8b8b,
};

export function Map3DLayer({
  actors,
  worldSensors,
  selectedWorldSensorId = null,
  asset,
  mapZoom,
  onLoadStateChange,
}: Map3DLayerProps) {
  const { current: mapRef } = useMap();
  const handleRef = useRef<Map3DLayerHandle | null>(null);
  const [handleReady, setHandleReady] = useState(false);

  // Hover and hold live up here because the actor instances read them; the
  // listeners that set them are further down, next to the hit layer they query.
  const [hoveredActorId, setHoveredActorId] = useState<string | null>(null);
  const [holdingActorId, setHoldingActorId] = useState<string | null>(null);

  const signalPlans = useActorsStore((state) => state.signalPlans);
  // The map's physical signal heads, from its traffic-light index rather than
  // from the scenario bundle — the bundle's `runtime` block has been null since
  // the bootstrap went semantic-first, which is what left this layer drawing no
  // heads at all on every map (audit 2026-07-27).
  const runtimeLights = useSignalJunctionStore((state) => state.trafficLights);
  const previewCurrentTimestamp = 0;
  // Armed placement draws translucent previews of the heads a junction WOULD
  // get. Read from the stores for the same reason the real heads are: this data
  // is editor state and the map component is shared with pages that have none.
  const intersectionControlArmed = useSelectionStore(
    (state) => state.intersectionControlPlacementActive,
  );
  const candidates = useIntersectionCandidates();
  const hoveredJunctionId = useSignalJunctionStore(
    (state) => state.hoveredJunctionId,
  );
  /** The head whose detail card is open — the one that glows. */
  const referenceSignalId = useSignalJunctionStore(
    (state) => state.referenceSignalId,
  );

  // -- the scene anchor -----------------------------------------------------
  // One fixed mercator origin per asset, taken at the runtime frame's own
  // origin. Object POSITIONS are still exact — each one is projected
  // individually and only the subtraction happens against this anchor — so the
  // anchor's only job is to keep scene coordinates small and to fix the metre
  // scale used for object SIZES.
  const anchor = useMemo<SceneAnchor | null>(() => {
    if (!asset) return null;
    const lngLat = runtimePointToLngLat({ x: 0, y: 0 }, asset);
    if (!lngLat) return null;
    const mercator = MercatorCoordinate.fromLngLat(
      { lng: lngLat[0], lat: lngLat[1] },
      0,
    );
    return {
      x: mercator.x,
      y: mercator.y,
      z: mercator.z ?? 0,
      metersToMercator: mercator.meterInMercatorCoordinateUnits(),
    };
  }, [asset]);

  const anchorLatitude = useMemo(() => {
    if (!asset) return 0;
    return runtimePointToLngLat({ x: 0, y: 0 }, asset)?.[1] ?? 0;
  }, [asset]);

  // -- actors ---------------------------------------------------------------
  const preparedActors = useMemo<PreparedActor[]>(() => {
    return actors.flatMap((actor) => {
      if (!Number.isFinite(actor.longitude) || !Number.isFinite(actor.latitude)) {
        return [];
      }
      const model = buildMap3DActorModel({
        kind: actor.kind,
        role: actor.role,
        blueprint: actor.blueprint,
      });
      return [
        {
          key: actor.id,
          id: actor.id,
          tagText: actorTagText(actor),
          longitude: actor.longitude,
          latitude: actor.latitude,
          yawDegrees: markerRotationToRuntimeYawDegrees(actor.kind, actor.rotationDeg),
          model,
          colorHex:
            parseActorColor(actor.color) ?? ROLE_COLORS[actor.role] ?? ROLE_COLORS.traffic!,
          selected: actor.selected,
          // The same two rules `ActorMarkerView` applies: live ambient traffic
          // reads back, and path editing dims everything but the actor being
          // edited. Deliberately NOT "every preview actor" — during playback
          // every actor is a preview actor, and ghosting the whole scene would
          // be a 3D-only behaviour change.
          dimmed:
            Boolean(actor.dimmed) ||
            (Boolean(actor.preview) && actor.role === "traffic"),
          // Preview markers are `pointerEvents: none` in 2D, so they must not
          // be clickable here either.
          interactive: !actor.preview,
          footprintRadiusM: actorFootprintRadiusMeters(model.extents),
        },
      ];
    });
  }, [actors]);

  const actorInstances = useMemo<Map3DActorInstance[]>(() => {
    if (!anchor) return [];
    const zoom = mapZoom ?? 16;
    return preparedActors.map((actor) => {
      const mercator = MercatorCoordinate.fromLngLat(
        { lng: actor.longitude, lat: actor.latitude },
        0,
      );
      const discRadiusM = locatorDiscRadiusMeters({
        footprintRadiusM: actor.footprintRadiusM,
        zoom,
        latitudeDegrees: actor.latitude,
      });
      return {
        key: actor.key,
        position: mercatorToScenePosition(anchor, {
          x: mercator.x,
          y: mercator.y,
          z: mercator.z ?? 0,
        }),
        rotationY: runtimeYawToSceneRotationY(actor.yawDegrees),
        model: actor.model,
        colorHex: actor.colorHex,
        selected: actor.selected,
        hovered: actor.id === hoveredActorId,
        dimmed: actor.dimmed,
        discRadiusM,
        discIsLocator: locatorIsStandingIn({
          footprintRadiusM: actor.footprintRadiusM,
          zoom,
          latitudeDegrees: actor.latitude,
        }),
        tagText: actor.tagText,
      };
    });
  }, [anchor, hoveredActorId, mapZoom, preparedActors]);

  // -- world cameras --------------------------------------------------------
  // Appended to the actor instances rather than given their own renderer path:
  // `setActors` builds meshes from a parts list, and a camera model is one.
  const cameraInstances = useMemo<Map3DActorInstance[]>(() => {
    if (!anchor || !asset || !worldSensors?.length) return [];
    const zoom = mapZoom ?? 16;
    return worldSensors.flatMap((sensor) => {
      const lngLat = runtimePointToLngLat(
        { x: sensor.pose.x, y: sensor.pose.y },
        asset,
      );
      if (!lngLat) return [];
      const mercator = MercatorCoordinate.fromLngLat(
        { lng: lngLat[0], lat: lngLat[1] },
        0,
      );
      const model = buildMap3DCameraModel({ mountHeightM: sensor.pose.z });
      const footprintRadiusM = actorFootprintRadiusMeters(model.extents);
      return [
        {
          key: `world-sensor:${sensor.id}`,
          position: mercatorToScenePosition(anchor, {
            x: mercator.x,
            y: mercator.y,
            z: mercator.z ?? 0,
          }),
          rotationY: runtimeYawToSceneRotationY(sensor.pose.yaw),
          model,
          colorHex: CAMERA_COLOR,
          selected: sensor.id === selectedWorldSensorId,
          hovered: false,
          dimmed: false,
          discRadiusM: locatorDiscRadiusMeters({
            footprintRadiusM,
            zoom,
            latitudeDegrees: lngLat[1],
          }),
          discIsLocator: locatorIsStandingIn({
            footprintRadiusM,
            zoom,
            latitudeDegrees: lngLat[1],
          }),
          // A world camera is equipment, not traffic: it has no speed, and its
          // name is already on its own card.
          tagText: null,
        },
      ];
    });
  }, [anchor, asset, mapZoom, selectedWorldSensorId, worldSensors]);

  const sceneActorInstances = useMemo(
    () => [...actorInstances, ...cameraInstances],
    [actorInstances, cameraInstances],
  );

  // -- signal heads ---------------------------------------------------------
  const signalCenter = useMemo(() => {
    if (!runtimeLights.length || !asset) return null;
    // Centre on the actors when there are any, so a dense city map draws the
    // heads around the scenario rather than around the map's origin. With no
    // actors yet, the map origin is the honest fallback and the wider radius
    // below covers it.
    if (preparedActors.length === 0) return { x: 0, y: 0 };
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const actor of preparedActors) {
      const runtime = lngLatToRuntimePoint(actor.longitude, actor.latitude, asset);
      if (!runtime) continue;
      sumX += runtime.x;
      sumY += runtime.y;
      count += 1;
    }
    return count > 0 ? { x: sumX / count, y: sumY / count } : null;
  }, [asset, preparedActors, runtimeLights.length]);

  /**
   * While armed the heads are ranked against the VIEWPORT, not the actors.
   *
   * A candidate 600 m from the scenario would otherwise show a 2D fan and no
   * ghost, which reads as a broken feature rather than as a budget.
   */
  const armedViewport = useMemo(() => {
    if (!intersectionControlArmed || !asset) return null;
    const map = mapRef?.getMap();
    const center = map?.getCenter();
    const canvas = map?.getCanvas();
    if (!map || !center || !canvas) return null;
    const middle = lngLatToRuntimePoint(center.lng, center.lat, asset);
    if (!middle) return null;
    const halfDiagonalPx =
      Math.hypot(canvas.clientWidth, canvas.clientHeight) / 2;
    return {
      center: middle,
      radiusM:
        halfDiagonalPx * metersPerPixel(mapZoom ?? map.getZoom(), center.lat),
    };
  }, [asset, intersectionControlArmed, mapRef, mapZoom]);

  const signalHeads = useMemo(() => {
    if (!runtimeLights.length || !asset || !anchor) return [];
    const center = armedViewport?.center ?? signalCenter;
    const radiusM =
      armedViewport?.radiusM ??
      (preparedActors.length > 0 ? SIGNAL_RADIUS_M : SIGNAL_FALLBACK_RADIUS_M);
    return buildMap3DSignalHeads({
      sources: runtimeLights,
      plans: signalPlans,
      timestampSeconds: previewCurrentTimestamp,
      center,
      radiusM,
    });
  }, [
    anchor,
    armedViewport,
    asset,
    preparedActors.length,
    previewCurrentTimestamp,
    runtimeLights,
    signalCenter,
    signalPlans,
  ]);

  /**
   * Real heads keep priority within the cap; ghosts fill the remainder, so the
   * worst case is a distant candidate showing a 2D fan and no ghost — degraded,
   * not broken.
   */
  const drawnSignalHeads = useMemo<Map3DSignalHead[]>(() => {
    if (!intersectionControlArmed || !asset || !anchor) return signalHeads;
    const budget = MAP_3D_MAX_SIGNAL_HEADS - signalHeads.length;
    const ghosts = buildCandidateGhostHeads({
      candidates,
      center: armedViewport?.center ?? signalCenter,
      hoveredJunctionId,
      maxHeads: budget,
      radiusM: armedViewport?.radiusM ?? SIGNAL_FALLBACK_RADIUS_M,
    });
    if (process.env.NODE_ENV !== "production") {
      const wanted = candidates
        .filter((candidate) => !candidate.controlled)
        .reduce((total, candidate) => total + candidate.lights.length, 0);
      if (wanted > ghosts.length) {
        console.debug(
          `[map-3d] signal head budget: ${signalHeads.length} real + ${ghosts.length}/${wanted} ghost of ${MAP_3D_MAX_SIGNAL_HEADS}`,
        );
      }
    }
    return [...signalHeads, ...ghosts];
  }, [
    anchor,
    armedViewport,
    asset,
    candidates,
    hoveredJunctionId,
    intersectionControlArmed,
    signalCenter,
    signalHeads,
  ]);

  const signalInstances = useMemo<Map3DSignalHeadInstance[]>(() => {
    if (!anchor || !asset) return [];
    return drawnSignalHeads.flatMap((head) => {
      const lngLat = runtimePointToLngLat({ x: head.runtimeX, y: head.runtimeY }, asset);
      if (!lngLat) return [];
      const mercator = MercatorCoordinate.fromLngLat(
        { lng: lngLat[0], lat: lngLat[1] },
        0,
      );
      return [
        {
          key: head.key,
          signalId: head.signalId,
          position: mercatorToScenePosition(anchor, {
            x: mercator.x,
            y: mercator.y,
            z: mercator.z ?? 0,
          }),
          rotationY: head.rotationY,
          lampCount: head.lampCount,
          headHeightM: head.headHeightM,
          housingHeightM: head.housingHeightM,
          housingWidthM: head.housingWidthM,
          lensKind: head.lensKind,
          lampForwardM: head.lampForwardM,
          lampRightM: head.lampRightM,
          assembly: head.assembly,
          litLampIndex: head.litLampIndex,
          state: head.state,
          authored: head.authored,
          ghost: head.ghost,
          hovered: head.hovered,
          selected:
            head.signalId != null &&
            referenceSignalId != null &&
            String(head.signalId) === String(referenceSignalId),
        },
      ];
    });
  }, [anchor, asset, drawnSignalHeads, referenceSignalId]);

  // -- the custom layer -----------------------------------------------------
  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;
    let cancelled = false;

    onLoadStateChange?.("loading");
    void (async () => {
      try {
        const { createMap3DLayer } = await import("./map-3d-scene");
        if (cancelled) return;
        // `addLayer` throws if the style is still in flight, and the renderer
        // chunk can easily land first on a warm cache.
        if (!map.isStyleLoaded()) {
          await new Promise<void>((resolve) => map.once("styledata", () => resolve()));
          if (cancelled) return;
        }
        const handle = createMap3DLayer(MAP_3D_LAYER_ID);
        handleRef.current = handle;
        if (!map.getLayer(MAP_3D_LAYER_ID)) map.addLayer(handle);
        setHandleReady(true);
        onLoadStateChange?.("ready");
      } catch (error) {
        // A machine with no WebGL2, or a chunk that failed to load. 2D mode is
        // unaffected and remains one click away, so this degrades rather than
        // breaks.
        if (!cancelled) {
          console.error("3D map layer failed to load", error);
          onLoadStateChange?.("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      const handle = handleRef.current;
      handleRef.current = null;
      setHandleReady(false);
      if (handle) {
        try {
          if (map.getLayer(MAP_3D_LAYER_ID)) {
            map.removeLayer(MAP_3D_LAYER_ID);
          }
        } catch {
          // Cache Components can preserve the editor until after its map style
          // has been destroyed. At that point even getLayer() throws because
          // MapLibre has already released the style; there is nothing left to
          // remove.
        }
      }
    };
  }, [mapRef, onLoadStateChange]);

  useEffect(() => {
    if (!handleReady) return;
    handleRef.current?.setAnchor(anchor);
    mapRef?.getMap()?.triggerRepaint();
  }, [anchor, handleReady, mapRef]);

  useEffect(() => {
    if (!handleReady) return;
    handleRef.current?.setActors(sceneActorInstances);
    mapRef?.getMap()?.triggerRepaint();
  }, [handleReady, mapRef, sceneActorInstances]);

  useEffect(() => {
    if (!handleReady) return;
    handleRef.current?.setSignalHeads(signalInstances);
    mapRef?.getMap()?.triggerRepaint();
  }, [handleReady, mapRef, signalInstances]);

  /**
   * Publish the lamp picker while 3D is mounted.
   *
   * The click chain lives in `MapAssetsMap`; the geometry that can say which
   * head's LIGHTS are under a pixel lives here. Retracted on unmount so 2D falls
   * back to the flat hit layers rather than calling into a dead renderer.
   */
  useEffect(() => {
    if (!handleReady) return;
    setSignalHeadPicker((point, viewport, radiusPx) =>
      handleRef.current?.pickSignalHeadAt(point, viewport, radiusPx) ?? null,
    );
    return () => setSignalHeadPicker(null);
  }, [handleReady]);

  /**
   * And the head PROJECTOR, on the same terms and for the same reason: the
   * detail card's anchor is a marker at the light's ground position, and only
   * the scene knows how far above that the fixture is actually drawn. Retracted
   * on unmount so 2D falls back to a flat anchor rather than a dead renderer.
   */
  useEffect(() => {
    if (!handleReady) return;
    setSignalHeadProjector(
      (signalId, viewport) =>
        handleRef.current?.projectSignalHeadBox(signalId, viewport) ?? null,
    );
    return () => setSignalHeadProjector(null);
  }, [handleReady]);

  // -- follow camera --------------------------------------------------------
  // Ported from the docked 3D panel, which is the only reason retiring that
  // panel did not cost a capability.
  //
  // Throttled rather than driven straight off the 20 Hz frame stream, for a
  // reason that is not about rendering: every programmatic recentre fires
  // `moveend`, and `MapAssetsMapView` turns `moveend` into
  // `onViewportBoundsChange`, which editor consumers use to FETCH per-viewport
  // data. Twenty of those a second would hammer them. Easing over the throttle
  // interval keeps the motion continuous anyway — consecutive `easeTo`s
  // interrupt each other into one smooth pan — so this reads as a follow
  // camera while firing bounds events at 4 Hz.
  const followSelectedActor = useMapViewModeStore(
    (state) => state.followSelectedActor,
  );
  const lastFollowAtRef = useRef(0);

  const followTarget = useMemo(() => {
    if (!followSelectedActor) return null;
    const target = preparedActors.find((actor) => actor.selected);
    return target ? { lng: target.longitude, lat: target.latitude } : null;
  }, [followSelectedActor, preparedActors]);

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map || !followTarget) return;
    const now = Date.now();
    const elapsed = now - lastFollowAtRef.current;
    if (elapsed < FOLLOW_THROTTLE_MS) return;
    lastFollowAtRef.current = now;
    map.easeTo({
      center: [followTarget.lng, followTarget.lat],
      duration: FOLLOW_THROTTLE_MS,
      // Zoom, pitch and bearing are the author's; follow only owns the centre.
    });
  }, [followTarget, mapRef]);

  // -- hover and hold chrome ------------------------------------------------
  // Selection and hold-to-drag themselves flow through the map's EXISTING
  // mouse-down chain — `useRuntimeActorMouseDown` queries the hit layer below
  // and hands the actor id to the same handler the DOM markers call, so the
  // document mutations in 3D are the ones 2D already makes. What that chain
  // cannot give us is feedback, because the ring and the card were drawn by the
  // DOM markers that 3D mode does not render. So this listens for the same two
  // events purely to place chrome, and collapses ~30 markers to at most 2.
  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;

    const actorIdAt = (point: MapLayerMouseEvent["point"]): string | null => {
      if (!map.getLayer(RUNTIME_ACTOR_HIT_LAYER_ID)) return null;
      try {
        const [feature] = map.queryRenderedFeatures(point, {
          layers: [RUNTIME_ACTOR_HIT_LAYER_ID],
        });
        const id = feature?.properties?.id;
        return typeof id === "string" && id.length > 0 ? id : null;
      } catch {
        return null;
      }
    };

    const onMouseMove = (event: MapLayerMouseEvent) => {
      setHoveredActorId(actorIdAt(event.point));
    };
    const onMouseDown = (event: MapLayerMouseEvent) => {
      setHoldingActorId(actorIdAt(event.point));
    };
    const onMouseUp = () => setHoldingActorId(null);
    const onMouseOut = () => setHoveredActorId(null);

    map.on("mousemove", onMouseMove);
    map.on("mousedown", onMouseDown);
    map.on("mouseout", onMouseOut);
    // On `window`, not the map: a hold that ends outside the canvas must still
    // clear the ring.
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      map.off("mousemove", onMouseMove);
      map.off("mousedown", onMouseDown);
      map.off("mouseout", onMouseOut);
      window.removeEventListener("mouseup", onMouseUp);
      setHoveredActorId(null);
      setHoldingActorId(null);
    };
  }, [mapRef]);

  // -- the selected actor's card anchor -------------------------------------
  // `FloatingDetailPanel` positions the actor card against
  // `[data-runtime-actor-id="…"]`, which in 2D is the SVG marker's own element.
  // 3D draws actors in GL and renders no such markers, so the card had no
  // anchor: it mounted, resolved no placement, and stayed at `opacity: 0` for
  // the rest of its life — an invisible card over the map that still swallowed
  // clicks. One zero-content marker for the selected actor gives the existing
  // anchor chain the same rect it measures in 2D, and only for the one actor
  // that can have a card open.
  const anchorActor = useMemo(
    () => preparedActors.find((actor) => actor.selected) ?? null,
    [preparedActors],
  );

  const chromeActors = useMemo(() => {
    const wanted = new Set(
      [hoveredActorId, holdingActorId].filter((id): id is string => id != null),
    );
    if (wanted.size === 0) return [];
    return actors.filter((actor) => wanted.has(actor.id));
  }, [actors, holdingActorId, hoveredActorId]);

  // -- hit testing ----------------------------------------------------------
  const hitFeatures = useMemo(
    () =>
      buildActorHitFeatures(
        preparedActors
          .filter((actor) => actor.interactive)
          .map((actor) => ({
            id: actor.id,
            longitude: actor.longitude,
            latitude: actor.latitude,
            footprintRadiusM: actor.footprintRadiusM,
          })),
      ),
    [preparedActors],
  );

  const hitRadius = useMemo(
    () => actorHitRadiusExpression(anchorLatitude),
    [anchorLatitude],
  );

  /**
   * Click targets for the heads that are actually DRAWN.
   *
   * Built from `drawnSignalHeads` rather than from the whole light index, so a
   * head culled by `MAP_3D_MAX_SIGNAL_HEADS` or by the radius filter is not
   * secretly clickable — an invisible target that opens a junction is worse
   * than no target at all.
   */
  const signalHitFeatures = useMemo(() => {
    if (!asset) return buildSignalHitFeatures([]);
    return buildSignalHitFeatures(
      drawnSignalHeads.flatMap((head) => {
        if (!head.signalId || head.ghost) return [];
        const pole = runtimePointToLngLat(
          { x: head.runtimeX, y: head.runtimeY },
          asset,
        );
        if (!pole) return [];
        const housing = runtimePointToLngLat(
          { x: head.housingRuntimeX, y: head.housingRuntimeY },
          asset,
        );
        return [
          {
            signalId: head.signalId,
            longitude: pole[0],
            latitude: pole[1],
            housingLongitude: housing?.[0] ?? null,
            housingLatitude: housing?.[1] ?? null,
          },
        ];
      }),
    );
  }, [asset, drawnSignalHeads]);

  const signalHitRadius = useMemo(
    () => signalHitRadiusExpression(anchorLatitude),
    [anchorLatitude],
  );

  return (
    <>
      {/* Signals FIRST so the actor layer is added after it and therefore sits
          above it: a car stopped at a light must still be the thing you grab. */}
      <Source id={SIGNAL_HIT_SOURCE_ID} type="geojson" data={signalHitFeatures as never}>
        <Layer
          id={SIGNAL_HIT_LAYER_ID}
          type="circle"
          paint={
            {
              "circle-radius": signalHitRadius,
              "circle-opacity": 0,
              "circle-stroke-width": 0,
            } as never
          }
        />
      </Source>

      <Source id={RUNTIME_ACTOR_HIT_SOURCE_ID} type="geojson" data={hitFeatures as never}>
        <Layer
          id={RUNTIME_ACTOR_HIT_LAYER_ID}
          type="circle"
          paint={
            {
              "circle-radius": hitRadius,
              // Invisible but hit-testable: `queryRenderedFeatures` ignores
              // `visibility: none` layers but not zero-opacity ones.
              "circle-opacity": 0,
              "circle-stroke-width": 0,
            } as never
          }
        />
      </Source>

      {anchorActor ? (
        <Marker
          key={`anchor:${anchorActor.id}`}
          anchor="center"
          longitude={anchorActor.longitude}
          latitude={anchorActor.latitude}
          pitchAlignment="viewport"
          rotationAlignment="viewport"
        >
          <div
            aria-hidden
            data-runtime-actor-id={anchorActor.id}
            style={{
              width: `${CHROME_SIZE_PX}px`,
              height: `${CHROME_SIZE_PX}px`,
              pointerEvents: "none",
            }}
          />
        </Marker>
      ) : null}

      {chromeActors.map((actor) => (
        <Marker
          key={actor.id}
          anchor="center"
          longitude={actor.longitude}
          latitude={actor.latitude}
          pitchAlignment="viewport"
          rotationAlignment="viewport"
        >
          <div
            data-runtime-actor-chrome-id={actor.id}
            style={{
              position: "relative",
              width: `${CHROME_SIZE_PX}px`,
              height: `${CHROME_SIZE_PX}px`,
              pointerEvents: "none",
            }}
          >
            {actor.id === holdingActorId ? (
              <HoldProgressRing size={CHROME_SIZE_PX} />
            ) : (
              <HoverInfoCard actor={actor} size={CHROME_SIZE_PX} />
            )}
          </div>
        </Marker>
      ))}
    </>
  );
}
