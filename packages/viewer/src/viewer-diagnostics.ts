/**
 * Lifetime-scoped diagnostics for the packaged 3D viewer.
 *
 * Logs one structured mount record, map-load stalls and failures, WebGL context
 * loss, unhandled browser errors, and memory-budget pressure. The watchdog is
 * installed by the shared React wrapper so Studio and every package consumer
 * receive the same observability without application-specific wiring.
 */

import type { CityViewer } from './viewer';

const LOG_PREFIX = '[viewer-diagnostics]';
const MAP_LOAD_STALL_MS = 15_000;
const MEMORY_WARN_RATIO = 0.85;
const STATS_SAMPLE_MS = 5_000;

type ChromiumPerformanceMemory = {
  readonly usedJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
};

export interface ViewerRuntimeDiagnostics {
  mapLoadStarted(manifestUrl: string): void;
  mapLoadSucceeded(manifestUrl: string): void;
  mapLoadFailed(manifestUrl: string, error: unknown): void;
  dispose(): void;
}

export function installViewerRuntimeDiagnostics(viewer: CityViewer): ViewerRuntimeDiagnostics {
  const canvas = viewer.renderer.domElement;
  const bounds = canvas.getBoundingClientRect();
  console.info(LOG_PREFIX, 'mount', {
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    viewport: typeof window === 'undefined' ? null : { width: window.innerWidth, height: window.innerHeight },
    container: { width: Math.round(bounds.width), height: Math.round(bounds.height) },
    canvas: { width: canvas.width, height: canvas.height },
    renderer: viewer.getRendererCapability(),
  });

  let mapLoadTimer: number | null = null;
  let activeManifestUrl: string | null = null;
  let memoryWarned = false;
  let contextLossLogged = false;

  const clearMapLoadTimer = () => {
    if (mapLoadTimer === null) return;
    window.clearTimeout(mapLoadTimer);
    mapLoadTimer = null;
  };
  const onContextLost = (event: Event) => {
    event.preventDefault();
    if (contextLossLogged) return;
    contextLossLogged = true;
    console.error(LOG_PREFIX, 'webglcontextlost', {
      manifestUrl: activeManifestUrl,
      stats: viewer.getStats(),
      timestamp: new Date().toISOString(),
    });
  };
  const onContextRestored = () => {
    contextLossLogged = false;
    console.info(LOG_PREFIX, 'webglcontextrestored');
  };
  const onError = (event: ErrorEvent) => {
    console.error(LOG_PREFIX, 'window-error', {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    console.error(LOG_PREFIX, 'unhandled-rejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      name: reason instanceof Error ? reason.name : undefined,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  };

  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  const statsTimer = window.setInterval(() => {
    if (memoryWarned) return;
    const stats = viewer.getStats();
    const residentRatio = stats.byteBudget > 0
      ? (stats.residentBytes + stats.pendingBytes) / stats.byteBudget
      : 0;
    const performanceMemory = (performance as Performance & {
      memory?: ChromiumPerformanceMemory;
    }).memory;
    const heapRatio = performanceMemory && performanceMemory.jsHeapSizeLimit > 0
      ? performanceMemory.usedJSHeapSize / performanceMemory.jsHeapSizeLimit
      : 0;
    if (residentRatio < MEMORY_WARN_RATIO && heapRatio < MEMORY_WARN_RATIO) return;
    memoryWarned = true;
    console.warn(LOG_PREFIX, 'memory-threshold', {
      residentBytes: stats.residentBytes,
      pendingBytes: stats.pendingBytes,
      byteBudget: stats.byteBudget,
      residentRatio,
      usedJSHeapSize: performanceMemory?.usedJSHeapSize ?? null,
      jsHeapSizeLimit: performanceMemory?.jsHeapSizeLimit ?? null,
      heapRatio,
    });
  }, STATS_SAMPLE_MS);

  return {
    mapLoadStarted(manifestUrl) {
      activeManifestUrl = manifestUrl;
      mapLoadTimer = window.setTimeout(() => {
        mapLoadTimer = null;
        console.warn(
          LOG_PREFIX,
          'map-load-stalled',
          { manifestUrl, timeoutMs: MAP_LOAD_STALL_MS, stats: viewer.getStats() },
        );
      }, MAP_LOAD_STALL_MS);
    },
    mapLoadSucceeded(manifestUrl) {
      clearMapLoadTimer();
      console.info(LOG_PREFIX, 'map-loaded', { manifestUrl, stats: viewer.getStats() });
    },
    mapLoadFailed(manifestUrl, error) {
      clearMapLoadTimer();
      console.error(LOG_PREFIX, 'map-load-error', {
        manifestUrl,
        message: error instanceof Error ? error.message : String(error),
        name: error instanceof Error ? error.name : undefined,
        stack: error instanceof Error ? error.stack : undefined,
      });
    },
    dispose() {
      clearMapLoadTimer();
      window.clearInterval(statsTimer);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    },
  };
}
