export const ARCHIVE_CLIP_SECONDS = 300;
export const ARCHIVE_CLIP_MS = ARCHIVE_CLIP_SECONDS * 1_000;
export const VIDEO_DRIFT_LIMIT_SECONDS = 0.5;

export interface DetectionCoverageBucket {
  start: string;
  detections: number;
  objects: number;
}

export interface ArchiveClipWindow {
  startMs: number;
  endMs: number;
  startIso: string;
  durationSeconds: number;
}

/**
 * A clock sample that departs from the previous one by more than this (after
 * accounting for playback speed) is a seek, not playback.
 */
export const CLIP_SEEK_JUMP_MS = 2_000;

/**
 * Archive clips are anchored where playback (re)starts rather than on a fixed
 * grid: MediaMTX serves progressive MP4 without range support, so a clip can
 * only play from its beginning. Anchoring at the seek instant keeps the video
 * aligned with the replay clock from the first frame.
 */
export function archiveClipAt(clockMs: number): ArchiveClipWindow {
  const startMs = Math.floor(clockMs / 1_000) * 1_000;
  return {
    startMs,
    endMs: startMs + ARCHIVE_CLIP_MS,
    startIso: new Date(startMs).toISOString(),
    durationSeconds: ARCHIVE_CLIP_SECONDS,
  };
}

/**
 * Keep the current clip while the clock plays through it; start a new clip when
 * the clock leaves it or jumps (a seek), or when nothing is loaded yet.
 */
export function resolveArchiveClip(
  current: ArchiveClipWindow | null,
  previousClockMs: number,
  clockMs: number,
  speed: number,
): ArchiveClipWindow {
  if (!current || clockMs < current.startMs || clockMs >= current.endMs) return archiveClipAt(clockMs);
  if (Number.isFinite(previousClockMs)) {
    const expectedAdvanceMs = Math.max(0, speed) * 1_000;
    if (Math.abs(clockMs - previousClockMs) > CLIP_SEEK_JUMP_MS + expectedAdvanceMs) return archiveClipAt(clockMs);
  }
  return current;
}

export function archiveVideoUrl(
  template: string,
  channel: string,
  clip: ArchiveClipWindow,
  archiveOffsetSeconds = 0,
): string {
  const archiveStartIso = new Date(clip.startMs + archiveOffsetSeconds * 1_000).toISOString();
  return template
    .replaceAll('{channel}', encodeURIComponent(channel))
    .replaceAll('{start}', encodeURIComponent(archiveStartIso))
    .replaceAll('{duration}', String(clip.durationSeconds));
}

export function shouldCorrectVideoDrift(currentTime: number, targetTime: number): boolean {
  return !Number.isFinite(currentTime)
    || !Number.isFinite(targetTime)
    || Math.abs(currentTime - targetTime) > VIDEO_DRIFT_LIMIT_SECONDS;
}

export function coverageTrackBackground(
  buckets: readonly DetectionCoverageBucket[],
  startMs: number,
  endMs: number,
): string {
  const duration = endMs - startMs;
  if (duration <= 0 || buckets.length === 0) return 'hsl(var(--muted))';
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.detections));
  const stops = buckets.flatMap((bucket) => {
    const bucketStart = Date.parse(bucket.start);
    if (!Number.isFinite(bucketStart)) return [];
    const left = Math.max(0, Math.min(100, (bucketStart - startMs) / duration * 100));
    const right = Math.max(left, Math.min(100, (bucketStart + ARCHIVE_CLIP_MS - startMs) / duration * 100));
    const strength = bucket.detections === 0 ? 0 : 0.25 + 0.75 * bucket.detections / peak;
    const color = strength === 0 ? 'hsl(var(--muted))' : `hsl(var(--primary) / ${strength.toFixed(3)})`;
    return [`${color} ${left.toFixed(3)}%`, `${color} ${right.toFixed(3)}%`];
  });
  return stops.length === 0 ? 'hsl(var(--muted))' : `linear-gradient(to right, ${stops.join(', ')})`;
}

export function latestActivityMs(buckets: readonly DetectionCoverageBucket[]): number | null {
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    const bucket = buckets[index]!;
    const startMs = Date.parse(bucket.start);
    if (bucket.detections > 0 && Number.isFinite(startMs)) return startMs;
  }
  return null;
}

export function toLocalDateTimeInput(epochMs: number): string {
  const date = new Date(epochMs);
  const localMs = epochMs - date.getTimezoneOffset() * 60_000;
  return new Date(localMs).toISOString().slice(0, 16);
}

export function localDateTimeInputToIso(value: string): string | null {
  const epochMs = new Date(value).getTime();
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}
