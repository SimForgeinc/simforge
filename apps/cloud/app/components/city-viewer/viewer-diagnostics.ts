/**
 * Diagnostics for the 3D CityViewer. Mirrors map-diagnostics for mount-time
 * checks, plus a runtime watchdog for post-start observability.
 *
 * Mount: one structured `[viewer-diagnostics]` log with WebGL availability,
 * container size, viewport, and the GpuInfo already resolved by quality.ts
 * (no duplicate adapter request).
 *
 * Runtime: piggybacks on the existing `viewer.onStats` 4Hz stream — no
 * setInterval. Logs once when heap/GPU memory crosses 85% of budget,
 * captures `webglcontextlost`, and aggregates tile-load failures.
 *
 * On affected machines we've seen Chrome's GPU process disabled at the OS
 * level (`VENDOR = 0xffff, GL_VENDOR = Disabled, Sandboxed = yes`). On
 * underpowered ones we expect post-start GPU process crashes, surfaced as
 * `webglcontextlost` events.
 */

import { probeWebGL, type WebGLProbe } from "@/app/lib/diagnostics/gpu-probe";
import type { ViewerStats } from "./city-viewer-core";
import { computeMemoryGuardLimits } from "./memory-profiler";
import type { GpuInfo } from "./quality";

const LOG_PREFIX = "[viewer-diagnostics]";

const MEMORY_WARN_RATIO = 0.85;
const TILE_FAILURE_FLUSH_MS = 5000;

/* -------------------------------------------------------------------------- */
/*  Mount + start-time logs                                                   */
/* -------------------------------------------------------------------------- */

export type ViewerMountDiagnosticsContext = {
  containerRect: DOMRect | null;
  manifestUrl: string;
  baseAssetsUrl: string;
};

export function logViewerMountDiagnostics(ctx: ViewerMountDiagnosticsContext): void {
  const webgl: WebGLProbe = probeWebGL();
  const navigatorGpu = typeof navigator !== "undefined" && !!navigator.gpu;

  console.info(LOG_PREFIX, "mount", {
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    viewport:
      typeof window !== "undefined" ? { w: window.innerWidth, h: window.innerHeight } : null,
    container: ctx.containerRect
      ? { w: Math.round(ctx.containerRect.width), h: Math.round(ctx.containerRect.height) }
      : "unmeasured",
    manifestUrl: ctx.manifestUrl,
    baseAssetsUrl: ctx.baseAssetsUrl,
    navigatorGpu,
    webgl,
  });
}

export function logViewerStartSuccess(
  canvas: HTMLCanvasElement,
  gpuInfo: GpuInfo | null,
  backendHint: string | null,
): void {
  console.info(LOG_PREFIX, "started", {
    backendHint: backendHint ?? "see [CityViewer] Backend log",
    canvasSize: { w: canvas.width, h: canvas.height },
    canvasClientSize: { w: canvas.clientWidth, h: canvas.clientHeight },
    pixelRatio: typeof window !== "undefined" ? window.devicePixelRatio : 1,
    gpuInfo,
  });
}

export function logViewerStartTimeout(): void {
  console.warn(
    LOG_PREFIX,
    "viewer.start() neither resolved nor rejected within 15s — likely WebGPU/WebGL context creation hung. Check `mount` log above for navigator.gpu/false, webgl.webgl2/false, or contextCreationError.",
  );
}

export function logViewerStartError(err: unknown): void {
  console.error(LOG_PREFIX, "start-error", {
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : undefined,
    stack: err instanceof Error ? err.stack : undefined,
  });
}

/* -------------------------------------------------------------------------- */
/*  Tile-failure aggregation                                                  */
/*                                                                            */
/*  Module-level so streaming code can record without holding a watchdog      */
/*  reference. The watchdog resets the counters on construction and flushes   */
/*  on dispose + every 5s while the viewer is running.                        */
/* -------------------------------------------------------------------------- */

let tileFailureCount = 0;
const tileFailureByError = new Map<string, number>();

export function recordTileFailure(err: unknown): void {
  tileFailureCount += 1;
  let key: string;
  if (err instanceof Error) {
    const msg = err.message.length > 80 ? `${err.message.slice(0, 80)}…` : err.message;
    key = `${err.name}: ${msg}`;
  } else {
    key = "unknown";
  }
  tileFailureByError.set(key, (tileFailureByError.get(key) ?? 0) + 1);
}

function flushTileFailures(): void {
  if (tileFailureCount === 0) return;
  console.warn(LOG_PREFIX, "tile-failures", {
    count: tileFailureCount,
    byError: Object.fromEntries(tileFailureByError),
  });
  tileFailureCount = 0;
  tileFailureByError.clear();
}

function resetTileFailures(): void {
  tileFailureCount = 0;
  tileFailureByError.clear();
}

/* -------------------------------------------------------------------------- */
/*  Runtime watchdog                                                          */
/* -------------------------------------------------------------------------- */

export type ViewerRuntimeWatchdog = {
  observeStats: (stats: ViewerStats) => void;
  dispose: () => void;
};

/**
 * Installs lifetime-scoped listeners (webglcontext{lost,restored}, window
 * error / unhandledrejection) and returns an `observeStats` callback that
 * the host should call from its existing `onStats` consumer. The watchdog
 * does NOT add a setInterval — it piggybacks on the renderer's stats stream.
 */
export function createViewerRuntimeWatchdog(opts: {
  canvas: HTMLCanvasElement;
  memoryBudgetBytes: number;
}): ViewerRuntimeWatchdog {
  resetTileFailures();

  const limits = computeMemoryGuardLimits(opts.memoryBudgetBytes);
  let heapHighWaterMB = 0;
  let gpuHighWaterMB = 0;
  let heapWarned = false;
  let gpuWarned = false;
  let lastTileFlushMs =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  let lossLogged = false;

  const onContextLost = (event: Event) => {
    // Standard practice: preventDefault allows the browser to attempt a
    // restoration via the `webglcontextrestored` event.
    event.preventDefault();
    if (lossLogged) return;
    lossLogged = true;
    console.error(LOG_PREFIX, "webglcontextlost", {
      heapHighWaterMB,
      gpuHighWaterMB,
      tileFailureCount,
      timestamp: new Date().toISOString(),
    });
  };

  const onContextRestored = () => {
    console.info(LOG_PREFIX, "webglcontextrestored");
    lossLogged = false;
  };

  const onError = (event: ErrorEvent) => {
    console.error(LOG_PREFIX, "window-error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  };

  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    console.error(LOG_PREFIX, "unhandled-rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
      name: reason instanceof Error ? reason.name : undefined,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };

  opts.canvas.addEventListener("webglcontextlost", onContextLost);
  opts.canvas.addEventListener("webglcontextrestored", onContextRestored);
  if (typeof window !== "undefined") {
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
  }

  return {
    observeStats(stats: ViewerStats) {
      const heap = stats.jsHeapMB;
      const gpu = stats.memory.gpuTotalMB;
      if (heap > heapHighWaterMB) heapHighWaterMB = heap;
      if (gpu > gpuHighWaterMB) gpuHighWaterMB = gpu;

      // Heap: compare against Chrome's reported heap limit (the OOM ceiling).
      const heapLimit = stats.memory.jsHeapLimitMB;
      if (!heapWarned && heapLimit > 0 && heap > heapLimit * MEMORY_WARN_RATIO) {
        heapWarned = true;
        console.warn(LOG_PREFIX, "heap-threshold", {
          heapMB: heap,
          jsHeapLimitMB: heapLimit,
          ratio: heap / heapLimit,
          tileFailureCount,
        });
      }

      // GPU: compare against the configured budget (computed once from the
      // quality preset, which already accounts for low/high tier).
      if (!gpuWarned && gpu > limits.gpuTotalMB * MEMORY_WARN_RATIO) {
        gpuWarned = true;
        console.warn(LOG_PREFIX, "gpu-threshold", {
          gpuTotalMB: gpu,
          limitMB: limits.gpuTotalMB,
          ratio: gpu / limits.gpuTotalMB,
          memory: stats.memory,
        });
      }

      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      if (now - lastTileFlushMs > TILE_FAILURE_FLUSH_MS) {
        lastTileFlushMs = now;
        flushTileFailures();
      }
    },

    dispose() {
      opts.canvas.removeEventListener("webglcontextlost", onContextLost);
      opts.canvas.removeEventListener("webglcontextrestored", onContextRestored);
      if (typeof window !== "undefined") {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      }
      flushTileFailures();
    },
  };
}
