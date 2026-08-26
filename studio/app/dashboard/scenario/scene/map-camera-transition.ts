import type { AssetDownloadStats, CameraView } from "@simforge-oss/viewer";

export const MAP_ZOOM_OUT_MS = 1_400;
export const MAP_ZOOM_IN_MS = 1_800;
export const MAP_MODEL_STABLE_MS = 600;
export const MAP_MODEL_LOAD_TIMEOUT_MS = 90_000;

export type MapModelLoadSnapshot = {
  roadReady: boolean;
  roadVisible: boolean;
  /** At least one non-road scene tile is resident, or the active profile is Roads Only. */
  sceneAssetsReady?: boolean;
  loading: number;
  queued: number;
  uploading: number;
  downloads?: AssetDownloadStats;
  streamingError?: string | null;
};

export function mapModelsFullyLoaded(snapshot: MapModelLoadSnapshot): boolean {
  return Boolean(
    snapshot.roadReady &&
      snapshot.roadVisible &&
      snapshot.sceneAssetsReady !== false &&
      snapshot.loading === 0 &&
      snapshot.queued === 0 &&
      snapshot.uploading === 0 &&
      !snapshot.streamingError,
  );
}

/**
 * Require a quiet window rather than trusting one empty queue sample. Tile and
 * model decoders can briefly reach zero between batches, which used to start
 * the zoom-in while destination buildings were still appearing.
 */
export function waitForMapModelsFullyLoaded(
  readSnapshot: () => MapModelLoadSnapshot,
  onComplete: () => void,
  onFailure: (error: Error) => void,
  options: {
    stableMs?: number;
    timeoutMs?: number;
    pollMs?: number;
    onSnapshot?: (snapshot: MapModelLoadSnapshot) => void;
  } = {},
): () => void {
  const stableMs = options.stableMs ?? MAP_MODEL_STABLE_MS;
  const timeoutMs = options.timeoutMs ?? MAP_MODEL_LOAD_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 100;
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let previousActivityKey: string | null = null;
  let stableSince: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const finish = (callback: () => void) => {
    if (cancelled) return;
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
    callback();
  };

  const poll = () => {
    if (cancelled) return;
    const now = Date.now();
    let snapshot: MapModelLoadSnapshot;
    try {
      snapshot = readSnapshot();
      options.onSnapshot?.(snapshot);
      const activityKey = snapshotActivityKey(snapshot);
      if (previousActivityKey !== null && activityKey !== previousActivityKey) {
        lastActivityAt = now;
      }
      previousActivityKey = activityKey;
    } catch (reason) {
      finish(() =>
        onFailure(
          reason instanceof Error
            ? reason
            : new Error("Map model readiness could not be read."),
        ),
      );
      return;
    }

    if (snapshot.streamingError) {
      finish(() => onFailure(new Error(snapshot.streamingError!)));
      return;
    }
    if (mapModelsFullyLoaded(snapshot)) {
      stableSince ??= now;
      if (now - stableSince >= stableMs) {
        finish(onComplete);
        return;
      }
    } else {
      stableSince = null;
    }
    if (now - lastActivityAt >= timeoutMs) {
      finish(() =>
        onFailure(
          new Error(
            `Map models made no progress for ${timeoutMs} ms ` +
              `(loading ${snapshot.loading}, queued ${snapshot.queued}, uploading ${snapshot.uploading}).`,
          ),
        ),
      );
      return;
    }
    timer = setTimeout(poll, pollMs);
  };

  poll();
  return () => {
    cancelled = true;
    if (timer !== null) clearTimeout(timer);
  };
}

function snapshotActivityKey(snapshot: MapModelLoadSnapshot): string {
  return [
    snapshot.roadReady,
    snapshot.roadVisible,
    snapshot.sceneAssetsReady,
    snapshot.loading,
    snapshot.queued,
    snapshot.uploading,
    snapshot.downloads?.active ?? 0,
    snapshot.downloads?.transferredBytes ?? 0,
    snapshot.downloads?.totalBytes ?? "unknown",
  ].join(":");
}

/** Pull the eye away from its target without changing the view direction. */
export function pulledBackMapView(
  view: CameraView,
  factor = 1.65,
): CameraView {
  const [tx, ty, tz] = view.target;
  const [x, y, z] = view.position;
  return {
    ...view,
    position: [
      tx + (x - tx) * factor,
      ty + (y - ty) * factor,
      tz + (z - tz) * factor,
    ],
  };
}

export function interpolateMapView(
  from: CameraView,
  to: CameraView,
  progress: number,
): CameraView {
  const t = easeInOutCubic(Math.min(1, Math.max(0, progress)));
  const mix = (start: number, end: number) => start + (end - start) * t;
  return {
    position: [
      mix(from.position[0], to.position[0]),
      mix(from.position[1], to.position[1]),
      mix(from.position[2], to.position[2]),
    ],
    target: [
      mix(from.target[0], to.target[0]),
      mix(from.target[1], to.target[1]),
      mix(from.target[2], to.target[2]),
    ],
    fov: mix(from.fov, to.fov),
  };
}

export function animateMapCamera(
  apply: (view: CameraView) => void,
  from: CameraView,
  to: CameraView,
  durationMs: number,
  onComplete: () => void,
): () => void {
  if (durationMs <= 0 || typeof requestAnimationFrame === "undefined") {
    apply(to);
    onComplete();
    return () => undefined;
  }

  let cancelled = false;
  let frame = 0;
  let startedAt: number | null = null;
  const tick = (now: number) => {
    if (cancelled) return;
    startedAt ??= now;
    const progress = Math.min(1, (now - startedAt) / durationMs);
    apply(interpolateMapView(from, to, progress));
    if (progress >= 1) {
      onComplete();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}
