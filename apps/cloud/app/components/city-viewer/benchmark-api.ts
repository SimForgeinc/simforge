/**
 * Dev-only benchmark API exposed on `window.__benchmarkAPI`. Driven by the
 * Playwright runner in `scripts/benchmark-3d-viewer.ts` (PRD issue #12 /
 * ABH-56). Attached after the viewer's `start()` resolves and detached on
 * dispose. Also installs a hotkey (`[`) that logs the current pose so a human
 * can fly Belmont once and capture waypoints for the camera-path JSON.
 *
 * Kept separate from `CityViewer.tsx` so the React component stays free of
 * test-harness wiring and the global only exists when a viewer is mounted.
 */
import type { CityViewerCore } from "./city-viewer-core";
import { getTwinDetailMode } from "./twin-detail-mode";

export interface BenchmarkPose {
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * What the scene graph actually holds, independent of what the renderer
 * reports drawing.
 *
 * `renderer.info.render.triangles` counts triangles *submitted*, which with a
 * post chain accumulates across every pass that re-renders the scene (shadow
 * map, depth prepass, AO). Comparing it to the geometry actually resident in
 * the scene is the only way to tell a multi-pass accounting artefact from real
 * geometry — and the two imply completely different optimisations.
 */
export interface SceneAudit {
  /** Triangles resident in the scene graph, instancing expanded. */
  sceneTriangles: number;
  /** Same, before instance expansion — i.e. unique geometry. */
  sourceTriangles: number;
  /** Triangles the renderer reports submitting for the last frame. */
  reportedTriangles: number;
  reportedDrawCalls: number;
  /** reportedTriangles / sceneTriangles. ~1 means single-pass. */
  submitRatio: number;
  meshes: number;
  instancedMeshes: number;
  /** Total instances across all InstancedMeshes. */
  instances: number;
  visibleMeshes: number;
  /** Triangle totals split by what the object is, via name/userData tags. */
  byCategory: Record<string, number>;
  /** Vegetation triangles split by the LOD level the tile was streamed at. */
  vegetationByLod: Record<string, number>;
  /** three's info auto-reset state — false means info accumulates per frame. */
  infoAutoReset: boolean | null;
  /** Which renderer path is active — see `twin-detail-mode.ts`. */
  detailMode: string;
}

export interface BenchmarkApi {
  ready: true;
  getCameraPose(): BenchmarkPose | null;
  setCameraPose(pose: BenchmarkPose): void;
  /** Logs the current pose tagged with `[BENCHMARK_WAYPOINT]` for offline capture. */
  captureWaypoint(label?: string): BenchmarkPose | null;
  /** Walks the scene graph and reconciles it against the renderer's counters. */
  auditScene(): SceneAudit | null;
}

declare global {
  interface Window {
    __benchmarkAPI?: BenchmarkApi;
  }
}

const WAYPOINT_HOTKEY = "[";

/** Triangles in one geometry, ignoring instancing. */
function geometryTriangles(geometry: {
  index?: { count: number } | null;
  attributes?: { position?: { count: number } };
}): number {
  const indexed = geometry.index?.count;
  if (typeof indexed === "number") return Math.floor(indexed / 3);
  const positions = geometry.attributes?.position?.count;
  return typeof positions === "number" ? Math.floor(positions / 3) : 0;
}

/**
 * Bucket an object by what it is, so the audit says *where* the triangles are
 * rather than only how many. Tiles and vegetation are named by the loaders;
 * anything else falls through to `other`.
 */
function categoryOf(name: string, parentNames: string): string {
  const haystack = `${name} ${parentNames}`.toLowerCase();
  if (haystack.includes("veg")) return "vegetation";
  if (haystack.includes("road")) return "road";
  if (haystack.includes("tile")) return "tiles";
  if (haystack.includes("actor") || haystack.includes("spawn")) return "actors";
  return "other";
}

export function attachBenchmarkApi(viewer: CityViewerCore): () => void {
  if (typeof window === "undefined") return () => {};

  const api: BenchmarkApi = {
    ready: true,
    getCameraPose: () => viewer.getCameraPose(),
    setCameraPose: (pose) => viewer.setCameraPose(pose),
    auditScene: () => {
      // Reaching through to the renderer is deliberate and dev-only: the whole
      // point is to compare the scene graph against the renderer's own
      // counters, which no public accessor exposes together.
      const core = viewer as unknown as {
        renderer?: {
          scene?: unknown;
          renderer?: {
            info?: {
              render?: { triangles?: number; calls?: number };
              autoReset?: boolean;
            };
          };
        };
      };
      const scene = core.renderer?.scene as
        | { traverse(cb: (o: unknown) => void): void }
        | undefined;
      if (!scene) return null;

      let sceneTriangles = 0;
      let sourceTriangles = 0;
      let meshes = 0;
      let instancedMeshes = 0;
      let instances = 0;
      let visibleMeshes = 0;
      const byCategory: Record<string, number> = {};
      const vegetationByLod: Record<string, number> = {};

      scene.traverse((raw) => {
        const obj = raw as {
          isMesh?: boolean;
          isInstancedMesh?: boolean;
          visible?: boolean;
          name?: string;
          count?: number;
          parent?: {
            name?: string;
            userData?: { lodLevel?: number };
            parent?: { name?: string; userData?: { lodLevel?: number } };
          } | null;
          geometry?: Parameters<typeof geometryTriangles>[0];
        };
        if (!obj.isMesh || !obj.geometry) return;
        meshes++;
        if (obj.visible) visibleMeshes++;

        const tris = geometryTriangles(obj.geometry);
        sourceTriangles += tris;

        const count = obj.isInstancedMesh ? (obj.count ?? 0) : 1;
        if (obj.isInstancedMesh) {
          instancedMeshes++;
          instances += count;
        }
        const expanded = tris * count;
        sceneTriangles += expanded;

        const parents = `${obj.parent?.name ?? ""} ${obj.parent?.parent?.name ?? ""}`;
        const cat = categoryOf(obj.name ?? "", parents);
        byCategory[cat] = (byCategory[cat] ?? 0) + expanded;

        if (cat === "vegetation") {
          const lod =
            obj.parent?.userData?.lodLevel ??
            obj.parent?.parent?.userData?.lodLevel;
          const key = lod == null ? "unknown" : `lod${lod}`;
          vegetationByLod[key] = (vegetationByLod[key] ?? 0) + expanded;
        }
      });

      const info = core.renderer?.renderer?.info;
      const reportedTriangles = info?.render?.triangles ?? 0;
      return {
        sceneTriangles,
        sourceTriangles,
        reportedTriangles,
        reportedDrawCalls: info?.render?.calls ?? 0,
        submitRatio:
          sceneTriangles > 0
            ? Number((reportedTriangles / sceneTriangles).toFixed(2))
            : 0,
        meshes,
        instancedMeshes,
        instances,
        visibleMeshes,
        byCategory,
        vegetationByLod,
        infoAutoReset: info?.autoReset ?? null,
        detailMode: getTwinDetailMode(),
      };
    },
    captureWaypoint: (label?: string) => {
      const pose = viewer.getCameraPose();
      if (!pose) return null;
      const tag = label ? ` ${JSON.stringify(label)}` : "";
      console.log(`[BENCHMARK_WAYPOINT]${tag} ${JSON.stringify(pose)}`);
      return pose;
    },
  };

  window.__benchmarkAPI = api;

  const handleKey = (e: KeyboardEvent) => {
    if (e.key !== WAYPOINT_HOTKEY) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    api.captureWaypoint();
  };
  window.addEventListener("keydown", handleKey);

  return () => {
    window.removeEventListener("keydown", handleKey);
    if (window.__benchmarkAPI === api) delete window.__benchmarkAPI;
  };
}
