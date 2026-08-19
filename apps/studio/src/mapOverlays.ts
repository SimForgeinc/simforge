/**
 * Map overlays: the OpenDRIVE lane surfaces and signal furniture, draped on the
 * streamed 3D city.
 *
 * ## Ordering
 *
 * Overlay loading never competes with the map. {@link loadMapOverlays} waits for
 * `viewer.captureReady()` — the renderer's own report that every asset the
 * current viewpoint needs is resident and drawn — before it fetches anything, so
 * startup latency is untouched. If the renderer never gets there (slow link,
 * aborted stream) the wait rejects and the overlays load anyway — late overlays
 * beat no overlays.
 *
 * ## Heights
 *
 * Draping needs a ground height per vertex: 86,272 of them for Yale Street.
 * `viewer.sampleGroundHeight` is a live scene-graph raycast at ~9.5 ms a call —
 * roughly 14 minutes for that many. So we bake the road layer into a
 * {@link GroundIndex} (~30 ms, ~0.2 µs a query, identical answers) and sample
 * that instead.
 *
 * The fallback ladder for a vertex the index cannot cover, in order:
 *
 * 1. `index.sample(x, z)` — exact, the road surface covering the point. The
 *    index deliberately does *not* copy `sampleGroundHeight`'s ray-from-above
 *    rule: RoadRunner bakes lamp posts, signal masts and utility poles into the
 *    same glTF as the asphalt, and "topmost" drapes lane polygons onto them.
 * 2. `index.sampleNear(x, z, 8)` — nearest road triangle within 8 m. Lane rings
 *    overhang the paved surface at kerbs and driveway aprons; snapping keeps the
 *    overlay continuous instead of tearing it down to a constant.
 * 3. `datum` — one ground height sampled at the map centre, used for features
 *    genuinely off-map (e.g. the 4 corrupt stop-line rows, which are skipped
 *    anyway).
 *
 * Residency is not a failure mode here the way it is for `sampleGroundHeight`:
 * the road layer is pinned with a single LOD and is never evicted, so the index
 * is complete the moment it is built and stays valid for the session. The
 * counters in {@link MapOverlayStats.heights} report which rung each vertex used.
 *
 * ## Memory
 *
 * Overlays are added to the scene directly, in their own `map-overlays` group.
 * They are not tiles and are deliberately outside `TileStreamLayer`, so they do
 * not touch the streamer's byte ledger or its eviction scoring.
 */

import { Group, type Raycaster } from 'three';
import type { CityViewer, GroundIndex } from '@uniscenarios/city-renderer';
import {
  CoordinateFrame,
  buildLaneOverlay,
  buildSignalOverlay,
  buildTrafficLightOrbLayer,
  clearTrafficLightOrbStates,
  fetchXodrHeader,
  loadLanePolygons,
  loadSignals,
  setTrafficLightOrbDepthMode,
  setTrafficLightOrbStates,
  setTrafficLightOrbHighlights,
  trafficLightOrbIdForHit,
  type CalibrationReport,
  type LaneOverlayUserData,
  type SceneManifestLike,
  type SignalOverlayUserData,
  type TrafficLightVisualPhase,
  type TrafficLightOrbDepthMode,
  type TrafficLightOrbLayerUserData,
  type TrafficLightOrbHighlightSelection,
} from '@uniscenarios/xodr-tools';

/** Where a map's overlay sidecars live. */
export interface MapOverlayUrls {
  /** `.xodr` road network. Only the first 16 KB is fetched. */
  xodr: string;
  /** The 3D tile manifest (also used by the viewer). */
  manifest: string;
  /** `lane-polygons.geojson(.gz)`. */
  lanePolygons: string;
  /** `signals.geojson(.gz)`. */
  signals: string;
}

/** Which overlay layers exist, for toggling. */
export type MapOverlayLayer = 'lanes' | 'signals';

/** What the load produced, for the HUD and for verification. */
export interface MapOverlayStats {
  laneCount: number;
  laneTriangles: number;
  /** Earcut slivers dropped by the builder's area filter. */
  degenerateTriangles: number;
  signalCount: number;
  /** Signal features present in the source but skipped (bad rows). */
  signalsSkipped: number;
  /** Draw calls the signal layer costs — one per category plus poles and crosswalks. */
  signalDrawCalls: number;
  /** Physical traffic-light heads represented by editor state orbs. */
  signalOrbCount: number;
  /** Where each lane/signal vertex height came from. */
  heights: { direct: number; near: number; datum: number };
  /** Ground datum used for rung 3, in scene Y. */
  datum: number;
  ground: { triangles: number; buildMs: number; bytes: number };
  timings: { settleMs: number; fetchMs: number; indexMs: number; buildMs: number; totalMs: number };
  /** xodr extents vs manifest scene bounds — the georeferencing sanity check. */
  calibration: CalibrationReport;
}

/** A live overlay set attached to the viewer's scene. */
export interface MapOverlayHandle {
  /** Parent group added to `viewer.scene`. */
  readonly group: Group;
  readonly lanes: Group;
  readonly signals: Group;
  /** Editor-only signal state markers, independent from detailed furniture. */
  readonly signalOrbs: Group;
  readonly stats: MapOverlayStats;
  /** Height lookup used for draping — reusable for actor placement and picking. */
  readonly sampleHeight: (x: number, z: number) => number;
  /** Show/hide a layer. A visibility flip: nothing is rebuilt or re-sampled. */
  setVisible(layer: MapOverlayLayer, visible: boolean): void;
  isVisible(layer: MapOverlayLayer): boolean;
  /** Update physical signal heads from the concrete simulation trace. */
  setSignalStates(states: Readonly<Record<string, TrafficLightVisualPhase>>, timeSeconds?: number): number;
  clearSignalStates(): void;
  setSignalOrbsVisible(visible: boolean): void;
  setSignalOrbDepthMode(mode: TrafficLightOrbDepthMode): void;
  /** Hit-test the single batched orb draw and return a stable OpenDRIVE id. */
  pickSignalOrb(raycaster: Raycaster): string | null;
  /** Apply selected/movement/intersection emphasis without rebuilding geometry. */
  setSignalHighlight(selection: TrafficLightOrbHighlightSelection | null): number;
  /** Detach from the scene and release GPU resources. */
  dispose(): void;
}

/** Tuning for {@link loadMapOverlays}. */
export interface MapOverlayOptions {
  /** Which layers start visible. Default `{ lanes: true, signals: false }`. */
  initialVisibility?: Partial<Record<MapOverlayLayer, boolean>>;
  /** Initial editor signal-marker presentation. */
  initialSignalOrbs?: { visible?: boolean; depthMode?: TrafficLightOrbDepthMode };
  /** Abort the load (component unmount). */
  signal?: AbortSignal;
}

const DEFAULT_VISIBILITY: Record<MapOverlayLayer, boolean> = { lanes: true, signals: false };

function now(): number {
  return performance.now();
}

/**
 * Load the lane and signal overlays and attach them to the viewer's scene.
 *
 * Waits for the renderer to report a fully drawn map first. Every synchronous
 * chunk (index bake, triangulation) is separated by a frame yield so the viewer
 * keeps rendering.
 */
export async function loadMapOverlays(
  viewer: CityViewer,
  urls: MapOverlayUrls,
  options: MapOverlayOptions = {},
): Promise<MapOverlayHandle> {
  const { signal } = options;
  const t0 = now();

  // The renderer answers this itself; polling its counters and requiring three
  // quiet samples only estimated the same fact and could pass on stale residency.
  await viewer.captureReady().catch((error: unknown) => {
    console.warn(`[overlays] ${String(error)}; loading overlays anyway`);
  });
  const settleMs = now() - t0;

  // --- 1. sidecar fetches (a few hundred KB, all in parallel) -------------
  const tFetch = now();
  const fetchOpts = signal ? { signal } : {};
  const [header, manifest] = await Promise.all([
    fetchXodrHeader(urls.xodr),
    fetch(urls.manifest, fetchOpts).then((r) => {
      if (!r.ok) throw new Error(`overlay manifest ${r.status}`);
      return r.json() as Promise<SceneManifestLike>;
    }),
  ]);
  // `fetchXodrHeader` Range-requests 16 KB and returns a *parsed* header rather
  // than the 6 MB of text `fromMapAssets` wants, so this is the header-shaped
  // half of the same factory. It carries `sceneBounds` across, which is what
  // makes `calibrationReport()` available below.
  const frame = CoordinateFrame.fromHeader(header, manifest);
  const [lanes, signals] = await Promise.all([
    loadLanePolygons(urls.lanePolygons, frame),
    loadSignals(urls.signals, frame),
  ]);
  const fetchMs = now() - tFetch;
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  // --- 2. bake the ground index -----------------------------------------
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const tIndex = now();
  const index = viewer.buildGroundIndex();
  const indexMs = now() - tIndex;
  if (!index) throw new Error('[overlays] road layer has no geometry; cannot drape');

  const { datum, sampleHeight, heights } = makeSampler(viewer, index, manifest);

  // --- 3. build geometry -------------------------------------------------
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const tBuild = now();
  const laneGroup = buildLaneOverlay(lanes, { heightSampler: sampleHeight });
  const signalGroup = buildSignalOverlay(signals, { heightSampler: sampleHeight });
  const signalOrbGroup = buildTrafficLightOrbLayer(signalGroup, {
    depthMode: options.initialSignalOrbs?.depthMode ?? 'xray',
  });
  const buildMs = now() - tBuild;

  const group = new Group();
  group.name = 'map-overlays';
  // Overlays are decorations on a static map; skipping the per-frame matrix
  // recompute keeps them off the hot path entirely.
  group.matrixAutoUpdate = false;
  group.add(laneGroup, signalGroup, signalOrbGroup);
  group.updateMatrixWorld(true);

  const visibility: Record<MapOverlayLayer, boolean> = {
    ...DEFAULT_VISIBILITY,
    ...options.initialVisibility,
  };
  laneGroup.visible = visibility.lanes;
  signalGroup.visible = visibility.signals;
  signalOrbGroup.visible = options.initialSignalOrbs?.visible ?? true;

  if (signal?.aborted) {
    disposeGroup(group);
    throw new DOMException('aborted', 'AbortError');
  }
  viewer.scene.add(group);

  const laneData = laneGroup.userData as LaneOverlayUserData;
  const signalData = signalGroup.userData as SignalOverlayUserData;
  const stats: MapOverlayStats = {
    laneCount: laneData.laneCount,
    laneTriangles: laneData.triangleCount,
    degenerateTriangles: laneData.degenerateTriangles,
    signalCount: signalData.signalCount,
    signalsSkipped: signals.length - signalData.signalCount,
    signalDrawCalls: signalData.drawCalls,
    signalOrbCount: (signalOrbGroup.userData as TrafficLightOrbLayerUserData).count,
    heights: { ...heights },
    datum,
    ground: {
      triangles: index.stats.triangles,
      buildMs: index.stats.buildMs,
      bytes: index.stats.bytes,
    },
    timings: { settleMs, fetchMs, indexMs, buildMs, totalMs: now() - t0 },
    calibration: frame.calibrationReport(),
  };

  return {
    group,
    lanes: laneGroup,
    signals: signalGroup,
    signalOrbs: signalOrbGroup,
    stats,
    sampleHeight,
    setVisible(layer, visible) {
      visibility[layer] = visible;
      (layer === 'lanes' ? laneGroup : signalGroup).visible = visible;
    },
    isVisible(layer) {
      return visibility[layer];
    },
    setSignalStates(states, timeSeconds = 0) {
      // Flashing is deterministic under scrubbing and naturally animates while
      // playback samples advance; no timer or per-frame object allocation.
      const flashOn = Math.floor(Math.max(0, timeSeconds) * 2) % 2 === 0;
      return setTrafficLightOrbStates(signalOrbGroup, states, flashOn);
    },
    clearSignalStates() {
      clearTrafficLightOrbStates(signalOrbGroup);
    },
    setSignalOrbsVisible(visible) {
      signalOrbGroup.visible = visible;
    },
    setSignalOrbDepthMode(mode) {
      setTrafficLightOrbDepthMode(signalOrbGroup, mode);
    },
    pickSignalOrb(raycaster) {
      for (const hit of raycaster.intersectObject(signalOrbGroup, true)) {
        const id = trafficLightOrbIdForHit(hit);
        if (id) return id;
      }
      return null;
    },
    setSignalHighlight(selection) {
      return setTrafficLightOrbHighlights(signalOrbGroup, selection);
    },
    dispose() {
      viewer.scene.remove(group);
      disposeGroup(group);
    },
  };
}

/**
 * The three-rung height sampler described in the module docs, with counters.
 *
 * Returns a plain `(x, z) => number` (never null) so overlay builders always
 * get a usable height and no vertex silently collapses to y = 0.
 */
function makeSampler(
  viewer: CityViewer,
  index: GroundIndex,
  manifest: SceneManifestLike,
): {
  datum: number;
  sampleHeight: (x: number, z: number) => number;
  heights: { direct: number; near: number; datum: number };
} {
  const bounds = manifest.scene?.bounds;
  const cx = bounds ? (((bounds.min[0] as number) + (bounds.max[0] as number)) / 2) : 0;
  const cz = bounds ? (((bounds.min[2] as number) + (bounds.max[2] as number)) / 2) : 0;
  // One ground height for the whole map, resolved the expensive-but-accurate
  // way exactly once. Wide `sampleNear` radius because the map centre can land
  // on a rooftop or a park.
  const datum =
    index.sampleNear(cx, cz, 400) ??
    viewer.sampleGroundHeight(cx, cz) ??
    (bounds ? (bounds.min[1] as number) : 0);

  const heights = { direct: 0, near: 0, datum: 0 };
  const sampleHeight = (x: number, z: number): number => {
    const exact = index.sample(x, z);
    if (exact !== null) {
      heights.direct++;
      return exact;
    }
    const near = index.sampleNear(x, z, 8);
    if (near !== null) {
      heights.near++;
      return near;
    }
    heights.datum++;
    return datum;
  };
  return { datum, sampleHeight, heights };
}

function disposeGroup(group: Group): void {
  const seenGeometry = new Set<unknown>();
  const seenMaterial = new Set<unknown>();
  group.traverse((obj) => {
    const any = obj as unknown as {
      geometry?: { dispose(): void };
      material?: { dispose(): void } | Array<{ dispose(): void }>;
    };
    if (any.geometry && !seenGeometry.has(any.geometry)) {
      seenGeometry.add(any.geometry);
      any.geometry.dispose();
    }
    const materials = Array.isArray(any.material) ? any.material : any.material ? [any.material] : [];
    for (const material of materials) {
      if (seenMaterial.has(material)) continue;
      seenMaterial.add(material);
      material.dispose();
    }
  });
  group.clear();
}
